// Package tailnettest is a tailnet on this Mac for tests, never a real
// one: Tailscale's in-process control server (testcontrol) and a relay
// (DERP) on 127.0.0.1, and phone stand-ins that join it as devices of
// their own. The Go tests use it, and so does tools/tailnetlab, which the
// hub's and the Mac app's checks run.
//
// Sign-in: the control server asks every new device to sign in, and its
// sign-in URL completes the sign-in when it is opened (as the person's
// browser would), so a test opens it with a plain GET.
//
// Each device gets an account of its own; Make turns a phone stand-in into
// a device of the account that owns "ravenry" (owner), keeps it another
// account's (stranger), or makes it a tagged device or one shared in from
// another account.
package tailnettest

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"time"

	"tailscale.com/derp/derpserver"
	"tailscale.com/ipn"
	"tailscale.com/ipn/store/mem"
	"tailscale.com/net/netns"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

// The tailnet's MagicDNS suffix.
const Domain = "tail1234.ts.net"

// Lab is the control server and the relay.
type Lab struct {
	Control *testcontrol.Server
	// URL is the control server's (http://127.0.0.1:PORT).
	URL string

	logf    logger.Logf
	ctl     *httptest.Server
	derp    *httptest.Server
	mu      sync.Mutex
	signins []string
	down    bool
}

// Start starts the relay and the control server on 127.0.0.1.
func Start(logf logger.Logf) (*Lab, error) {
	if logf == nil {
		logf = logger.Discard
	}
	// Corp#4520 in tsnet's own tests: no binding to an interface for 127.0.0.1.
	netns.SetEnabled(false)
	d := derpserver.New(key.NewNode(), logger.Discard)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	ds := httptest.NewUnstartedServer(derpserver.Handler(d))
	ds.Listener.Close()
	ds.Listener = ln
	ds.Config.ErrorLog = logger.StdLogger(logger.Discard)
	ds.Config.TLSNextProto = map[string]func(*http.Server, *tls.Conn, http.Handler){}
	ds.StartTLS()
	dm := &tailcfg.DERPMap{Regions: map[int]*tailcfg.DERPRegion{1: {
		RegionID: 1, RegionCode: "test",
		Nodes: []*tailcfg.DERPNode{{
			Name: "t1", RegionID: 1, HostName: "127.0.0.1", IPv4: "127.0.0.1", IPv6: "none",
			STUNPort: -1, DERPPort: ln.Addr().(*net.TCPAddr).Port, InsecureForTests: true,
		}},
	}}}
	c := &testcontrol.Server{
		DERPMap:        dm,
		DNSConfig:      &tailcfg.DNSConfig{Proxied: true},
		MagicDNSDomain: Domain,
		RequireAuth:    true,
		AllOnline:      true,
		Logf:           logf,
	}
	l := &Lab{Control: c, logf: logf, derp: ds}
	cs := httptest.NewUnstartedServer(http.HandlerFunc(l.serve))
	cs.Config.ErrorLog = logger.StdLogger(logger.Discard)
	c.HTTPTestServer = cs
	cs.Start()
	l.ctl = cs
	l.URL = cs.URL
	return l, nil
}

// serve is the control server, with its sign-in pages.
func (l *Lab) serve(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/auth/") {
		ok := l.Control.CompleteAuth(r.URL.Path)
		l.mu.Lock()
		if ok {
			l.signins = append(l.signins, r.URL.Path)
		}
		l.mu.Unlock()
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			io.WriteString(w, "No such sign-in.\n")
			return
		}
		io.WriteString(w, "Signed in. You can close this page.\n")
		return
	}
	l.Control.ServeHTTP(w, r)
}

// SignIns is how many sign-in pages were opened and completed.
func (l *Lab) SignIns() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.signins)
}

// Down takes the control server and the relay away, as no internet does.
func (l *Lab) Down() {
	l.mu.Lock()
	if l.down {
		l.mu.Unlock()
		return
	}
	l.down = true
	l.mu.Unlock()
	l.derp.CloseClientConnections()
	l.derp.Listener.Close()
	l.ctl.CloseClientConnections()
	l.ctl.Listener.Close()
}

// Close ends both servers.
func (l *Lab) Close() {
	l.Down()
	done := make(chan struct{})
	go func() { l.ctl.Close(); l.derp.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
	}
}

// Node is a device the control server knows, by its name ("ravenry").
func (l *Lab) Node(name string) *tailcfg.Node {
	for _, n := range l.Control.AllNodes() {
		if n.Hostinfo.Valid() && n.Hostinfo.Hostname() == name {
			return n
		}
	}
	return nil
}

// Peer is a phone stand-in on the tailnet.
type Peer struct {
	Name string
	Srv  *tsnet.Server
	IP   netip.Addr
	Key  key.NodePublic
}

// Peer starts a phone stand-in called name (its own account), signs it in
// and waits until it is on the tailnet.
func (l *Lab) Peer(ctx context.Context, dir, name string) (*Peer, error) {
	s := &tsnet.Server{Dir: dir, Hostname: name, ControlURL: l.URL, Ephemeral: true, Store: new(mem.Store), UserLogf: logger.Discard}
	if err := s.Start(); err != nil {
		return nil, err
	}
	lc, err := s.LocalClient()
	if err != nil {
		s.Close()
		return nil, err
	}
	for {
		st, err := lc.StatusWithoutPeers(ctx)
		if err == nil && st.BackendState == ipn.Running.String() && len(st.TailscaleIPs) > 0 {
			p := &Peer{Name: name, Srv: s, Key: st.Self.PublicKey}
			for _, a := range st.TailscaleIPs {
				if a.Is4() {
					p.IP = a
				}
			}
			return p, nil
		}
		if err == nil && st.AuthURL != "" {
			l.Control.CompleteAuth(st.AuthURL)
		}
		select {
		case <-ctx.Done():
			s.Close()
			return nil, fmt.Errorf("%s did not join the tailnet: %w", name, ctx.Err())
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// The kinds of device Make makes a peer.
const (
	Owner    = "owner"    // a device of the account that owns ravenry
	Stranger = "stranger" // another account's (as it joined)
	Tagged   = "tagged"   // a tagged device (owned by no one)
	Shared   = "shared"   // shared in from another account
)

// Make makes p a device of that kind, as ravenry's account sees it.
func (l *Lab) Make(p *Peer, kind string) error {
	r := l.Node("ravenry")
	if r == nil {
		return errors.New("ravenry is not on the tailnet")
	}
	n := l.Control.Node(p.Key)
	if n == nil {
		return fmt.Errorf("%s is not on the tailnet", p.Name)
	}
	own := n.User
	switch kind {
	case Owner:
		n.User = r.User
	case Stranger:
		if n.User == r.User {
			return errors.New("the stranger has ravenry's account")
		}
	case Tagged:
		n.User = r.User
		n.Tags = []string{"tag:phone"}
	case Shared:
		n.User = r.User
		n.Sharer = own
	default:
		return fmt.Errorf("no kind %q (owner, stranger, tagged, shared)", kind)
	}
	l.Control.UpdateNode(n)
	return nil
}

// Answer is what a phone stand-in got from the phone port.
type Answer struct {
	Status int    `json:"status"`
	Body   string `json:"body,omitempty"`
	// Pin is the base64url SHA-256 of the certificate's key, as the
	// phone app pins it (docs/PHONE.md section 2).
	Pin string `json:"pin,omitempty"`
	// Error: no answer (the connection was closed, or nothing listens).
	Error string `json:"error,omitempty"`
}

// Request sends one HTTPS request over the tailnet to addr (host:port, a
// tailnet address or MagicDNS name), taking any certificate and saying
// its pin, as the phone app does before it checks the pin.
func (p *Peer) Request(ctx context.Context, addr, method, path, body string) Answer {
	var pin string
	tr := &http.Transport{
		DialContext: func(ctx context.Context, network, a string) (net.Conn, error) { return p.Srv.Dial(ctx, "tcp", a) },
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true, VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) > 0 {
				h := sha256.Sum256(cs.PeerCertificates[0].RawSubjectPublicKeyInfo)
				pin = base64.RawURLEncoding.EncodeToString(h[:])
			}
			return nil
		}},
		DisableKeepAlives: true,
	}
	defer tr.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, method, "https://"+addr+path, strings.NewReader(body))
	if err != nil {
		return Answer{Error: err.Error()}
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if method != "GET" {
		req.Header.Set("X-Ravenry", "1")
	}
	res, err := (&http.Client{Transport: tr}).Do(req)
	if err != nil {
		return Answer{Error: err.Error(), Pin: pin}
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<16))
	return Answer{Status: res.StatusCode, Body: string(b), Pin: pin}
}

// Close takes the stand-in off the tailnet.
func (p *Peer) Close() { p.Srv.Close() }
