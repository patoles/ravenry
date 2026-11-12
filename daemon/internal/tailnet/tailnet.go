// Package tailnet puts Ravenry on the person's Tailscale network as a
// device of its own, "ravenry", with Tailscale's tsnet: the Mac needs no
// VPN app and no network extension (docs/PHONE.md section 2, Away from
// home). `ravenryd tailnet` runs one; the hub starts it while phone access
// and Away from home are both on, and stops it otherwise, so nothing
// listens on the tailnet while either is off.
//
// On the tailnet it listens on one port, the phone port, and passes each
// connection to the hub's phone port on 127.0.0.1 unchanged (TLS end to
// end: the phone's pin and token checks are the hub's, as on the Wi-Fi).
// Before a byte is passed, the caller is looked up (WhoIs): only a device
// of the account that owns this node gets in. A tagged device, a device
// shared in from another account and another account's device are closed
// at once.
//
// Its keys live in Config.Dir (mode 0700). Log uploads to Tailscale are
// off: nothing leaves this Mac but the tailnet's own traffic.
package tailnet

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/envknob"
	"tailscale.com/health"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/logtail"
	"tailscale.com/net/netns"
	"tailscale.com/tailcfg"
	"tailscale.com/tsconst"
	"tailscale.com/tsnet"
)

// Config says where the node keeps its keys and what it serves.
type Config struct {
	// Dir holds the node's state (its keys), made with mode 0700.
	Dir string
	// Hostname is the name it asks for ("ravenry"); Tailscale adds a
	// number when another device has it.
	Hostname string
	// Forward is the hub's phone port on 127.0.0.1.
	Forward int
	// Port is the port it listens on, on the tailnet (default Forward;
	// below 0: it listens on nothing, as when it only signs out).
	Port int
	// ControlURL is Tailscale's when empty. Anything else must be http on
	// a loopback address: a test's control server on this Mac.
	ControlURL string
	// Events gets each change of state (never nil after Start).
	Events func(Event)
	// Logf is for what an operator reads (never the sign-in URL or a key).
	Logf func(string, ...any)
	// Debugf, when set, gets tsnet's own backend log (verbose).
	Debugf func(string, ...any)
}

// The states a node goes through, as Event.State.
const (
	StateStarting   = "starting"    // keys being read, or joining
	StateNeedsLogin = "needs-login" // waiting for the person to sign in (AuthURL)
	StateRunning    = "running"     // on the tailnet, listening
	StateOffline    = "offline"     // signed in, but neither Tailscale's servers nor its relays answer
	StateSignedOut  = "signed-out"  // logged out and its keys deleted
	StateError      = "error"
)

// Event is one change of state, printed as a JSON line by `ravenryd tailnet`.
type Event struct {
	State   string   `json:"state"`
	AuthURL string   `json:"authURL,omitempty"`
	Name    string   `json:"name,omitempty"`    // its name on the tailnet: "ravenry" (or "ravenry-1")
	Host    string   `json:"host,omitempty"`    // its MagicDNS name: ravenry.tail1234.ts.net
	IPs     []string `json:"ips,omitempty"`     // its addresses, IPv4 first
	Account string   `json:"account,omitempty"` // the owner's login name
	Port    int      `json:"port,omitempty"`    // the port it listens on, on the tailnet (running)
	Error   string   `json:"error,omitempty"`
	// Removed (signed-out): Tailscale took the log-out, so the device left
	// the tailnet; false when it could not be reached.
	Removed *bool    `json:"removed,omitempty"`
	Refused *Refusal `json:"refused,omitempty"`
}

// Refusal is a connection closed before a byte was passed on.
type Refusal struct {
	From string `json:"from"`
	Why  string `json:"why"`
}

// Node is a running tsnet server.
type Node struct {
	cfg    Config
	srv    *tsnet.Server
	lc     *local.Client
	ctx    context.Context
	cancel context.CancelFunc

	mu         sync.Mutex
	ln         net.Listener
	owner      tailcfg.UserID
	ownerKnown bool
	last       Event
	conns      map[net.Conn]bool
	closed     bool
}

var quietOnce sync.Once

// quiet turns off Tailscale's log uploads for this process, before any
// node starts.
func quiet() {
	quietOnce.Do(func() {
		envknob.SetNoLogsNoSupport()
		logtail.Disable()
	})
}

// LoopbackHTTP reports whether u is an http URL on a loopback address, the
// only control server other than Tailscale's a node takes.
func LoopbackHTTP(u string) bool {
	p, err := url.Parse(u)
	if err != nil || p.Scheme != "http" || p.User != nil {
		return false
	}
	h := p.Hostname()
	if h == "localhost" {
		return true
	}
	a, err := netip.ParseAddr(h)
	return err == nil && a.IsLoopback()
}

// Start starts the node from the keys in cfg.Dir (none yet: it asks the
// person to sign in, Event NeedsLogin with the AuthURL to open).
func Start(cfg Config) (*Node, error) {
	if cfg.Dir == "" || cfg.Forward <= 0 || cfg.Forward > 65535 {
		return nil, errors.New("tailnet: a state folder and the phone port are needed")
	}
	if cfg.Hostname == "" {
		cfg.Hostname = "ravenry"
	}
	if cfg.Port == 0 {
		cfg.Port = cfg.Forward
	}
	if cfg.Events == nil {
		cfg.Events = func(Event) {}
	}
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	control := ipn.DefaultControlURL
	if cfg.ControlURL != "" {
		if !LoopbackHTTP(cfg.ControlURL) {
			return nil, fmt.Errorf("tailnet: a control server other than Tailscale's must be http on this Mac (%q is not)", cfg.ControlURL)
		}
		control = cfg.ControlURL
		// A test's servers are on 127.0.0.1: no binding to the Wi-Fi's interface.
		netns.SetEnabled(false)
	}
	if err := os.MkdirAll(cfg.Dir, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(cfg.Dir, 0o700); err != nil {
		return nil, err
	}
	quiet()
	srv := &tsnet.Server{
		Dir:        cfg.Dir,
		Hostname:   cfg.Hostname,
		ControlURL: control,
		// tsnet's own lines carry the sign-in URL: never in a log.
		UserLogf: func(string, ...any) {},
		Logf:     cfg.Debugf,
	}
	if err := srv.Start(); err != nil {
		return nil, fmt.Errorf("tailnet: %w", err)
	}
	lc, err := srv.LocalClient()
	if err != nil {
		srv.Close()
		return nil, fmt.Errorf("tailnet: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	n := &Node{cfg: cfg, srv: srv, lc: lc, ctx: ctx, cancel: cancel, conns: map[net.Conn]bool{}}
	n.emit(Event{State: StateStarting})
	go n.watch()
	return n, nil
}

func (n *Node) emit(e Event) {
	n.mu.Lock()
	same := e.Refused == nil && sameEvent(n.last, e)
	if e.Refused == nil {
		n.last = e
	}
	n.mu.Unlock()
	if !same {
		n.cfg.Events(e)
	}
}

func sameEvent(a, b Event) bool {
	return a.State == b.State && a.AuthURL == b.AuthURL && a.Name == b.Name && a.Host == b.Host && slices.Equal(a.IPs, b.IPs) && a.Account == b.Account && a.Port == b.Port && a.Error == b.Error
}

// Last is the state last sent.
func (n *Node) Last() Event {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.last
}

// The health warnings that mean neither Tailscale's servers nor its
// relays can be reached: no network, or no relay (each shows only after
// it lasted its own few seconds).
var offlineWarnings = []health.WarnableCode{
	tsconst.HealthWarnableNetworkStatus,
	tsconst.HealthWarnableNoDERPHome,
	tsconst.HealthWarnableNoDERPConnection,
}

func offline(h *health.State) bool {
	if h == nil {
		return false
	}
	for _, c := range offlineWarnings {
		if _, ok := h.Warnings[c]; ok {
			return true
		}
	}
	return false
}

// watch follows the backend's state and health until the node closes.
func (n *Node) watch() {
	for n.ctx.Err() == nil {
		w, err := n.lc.WatchIPNBus(n.ctx, ipn.NotifyInitialState|ipn.NotifyInitialHealthState)
		if err != nil {
			if n.ctx.Err() != nil {
				return
			}
			time.Sleep(200 * time.Millisecond)
			continue
		}
		var st ipn.State
		var h *health.State
		var browse string
		tick := time.NewTicker(time.Second)
		next := make(chan *ipn.Notify)
		go func() {
			defer close(next)
			for {
				nt, err := w.Next()
				if err != nil {
					return
				}
				select {
				case next <- &nt:
				case <-n.ctx.Done():
					return
				}
			}
		}()
	loop:
		for {
			select {
			case <-n.ctx.Done():
				break loop
			case nt, ok := <-next:
				if !ok {
					break loop
				}
				if nt.State != nil {
					st = *nt.State
				}
				if nt.Health != nil {
					h = nt.Health
				}
				if nt.BrowseToURL != nil {
					browse = *nt.BrowseToURL
				}
				if nt.ErrMessage != nil {
					n.cfg.Logf("tailnet: the backend says: %s", *nt.ErrMessage)
					n.emit(Event{State: StateError, Error: *nt.ErrMessage})
					continue
				}
			case <-tick.C:
			}
			n.update(st, h, &browse)
		}
		tick.Stop()
		w.Close()
	}
}

// update says what the node is now.
func (n *Node) update(st ipn.State, h *health.State, browse *string) {
	switch st {
	case ipn.NeedsLogin:
		u := *browse
		if u == "" {
			if s, err := n.lc.StatusWithoutPeers(n.ctx); err == nil {
				u = s.AuthURL
			}
		}
		if u != "" {
			n.emit(Event{State: StateNeedsLogin, AuthURL: u})
		}
	case ipn.Running:
		*browse = ""
		s, err := n.lc.StatusWithoutPeers(n.ctx)
		if err != nil || s.Self == nil {
			return
		}
		e := describe(s)
		if err := n.listen(); err != nil {
			n.emit(Event{State: StateError, Error: err.Error()})
			return
		}
		n.mu.Lock()
		n.owner, n.ownerKnown = s.Self.UserID, s.Self.Tags == nil || s.Self.Tags.Len() == 0
		n.mu.Unlock()
		if n.cfg.Port > 0 {
			e.Port = n.cfg.Port
		}
		e.State = StateRunning
		if offline(h) {
			e.State = StateOffline
		}
		n.emit(e)
	default:
		// Starting (keys read, joining) or NeedsMachineAuth (an admin
		// approves new devices on this tailnet): offline when the network
		// says so, else still starting.
		if offline(h) {
			e := n.Last()
			e.State, e.AuthURL, e.Error = StateOffline, "", ""
			n.emit(e)
		}
	}
}

// describe is what a running node's status says about it.
func describe(s *ipnstate.Status) Event {
	var e Event
	host := strings.TrimSuffix(s.Self.DNSName, ".")
	e.Host = host
	e.Name, _, _ = strings.Cut(host, ".")
	if e.Name == "" {
		e.Name = s.Self.HostName
	}
	ips := slices.Clone(s.Self.TailscaleIPs)
	slices.SortStableFunc(ips, func(a, b netip.Addr) int {
		if a.Is4() == b.Is4() {
			return 0
		}
		if a.Is4() {
			return -1
		}
		return 1
	})
	for _, a := range ips {
		e.IPs = append(e.IPs, a.String())
	}
	if u, ok := s.User[s.Self.UserID]; ok {
		e.Account = u.LoginName
	}
	return e
}

// listen opens the tailnet's listener, once.
func (n *Node) listen() error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.ln != nil || n.closed || n.cfg.Port < 0 {
		return nil
	}
	ln, err := n.srv.Listen("tcp", fmt.Sprintf(":%d", n.cfg.Port))
	if err != nil {
		return fmt.Errorf("tailnet: listen on :%d: %w", n.cfg.Port, err)
	}
	n.ln = ln
	go n.serve(ln)
	n.cfg.Logf("tailnet: listening on the tailnet's port %d, passing the owner's devices to 127.0.0.1:%d", n.cfg.Port, n.cfg.Forward)
	return nil
}

func (n *Node) serve(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go n.handle(c)
	}
}

// Allowed says whether a caller looked up with WhoIs may reach the phone
// port: a device of the owner's own account, untagged and not shared in.
// owner is the account that owns this node; ownerKnown is false while it
// is not known, or when this node is tagged (owned by no one).
func Allowed(owner tailcfg.UserID, ownerKnown bool, who *apitype.WhoIsResponse) (bool, string) {
	switch {
	case !ownerKnown || owner == 0:
		return false, "this device's owner is not known yet"
	case who == nil || who.Node == nil:
		return false, "a device the tailnet does not know"
	case len(who.Node.Tags) > 0:
		return false, "a tagged device, owned by no one"
	case who.Node.Sharer != 0:
		return false, "a device shared in from another account"
	case who.Node.User != owner:
		return false, "a device of another account"
	}
	return true, ""
}

func (n *Node) handle(c net.Conn) {
	from := c.RemoteAddr().String()
	ctx, cancel := context.WithTimeout(n.ctx, 5*time.Second)
	who, err := n.lc.WhoIs(ctx, from)
	cancel()
	n.mu.Lock()
	owner, known := n.owner, n.ownerKnown
	n.mu.Unlock()
	if err != nil {
		who = nil
	}
	if ok, why := Allowed(owner, known, who); !ok {
		c.Close()
		host, _, _ := net.SplitHostPort(from)
		n.cfg.Logf("tailnet: refused %s: %s", host, why)
		n.emit(Event{State: n.Last().State, Refused: &Refusal{From: host, Why: why}})
		return
	}
	up, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", n.cfg.Forward), 5*time.Second)
	if err != nil {
		c.Close()
		n.cfg.Logf("tailnet: the phone port does not answer: %v", err)
		return
	}
	if !n.track(c, up) {
		return
	}
	defer n.untrack(c, up)
	done := make(chan struct{}, 2)
	go func() { io.Copy(up, c); closeWrite(up); done <- struct{}{} }()
	go func() { io.Copy(c, up); closeWrite(c); done <- struct{}{} }()
	<-done
	<-done
}

type writeCloser interface{ CloseWrite() error }

func closeWrite(c net.Conn) {
	if w, ok := c.(writeCloser); ok {
		w.CloseWrite()
	} else {
		c.Close()
	}
}

func (n *Node) track(cs ...net.Conn) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.closed {
		for _, c := range cs {
			c.Close()
		}
		return false
	}
	for _, c := range cs {
		n.conns[c] = true
	}
	return true
}

func (n *Node) untrack(cs ...net.Conn) {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, c := range cs {
		c.Close()
		delete(n.conns, c)
	}
}

// Close takes the node off the tailnet for now (its keys kept): the
// listener and every connection through it close.
func (n *Node) Close() error {
	n.mu.Lock()
	if n.closed {
		n.mu.Unlock()
		return nil
	}
	n.closed = true
	if n.ln != nil {
		n.ln.Close()
	}
	for c := range n.conns {
		c.Close()
	}
	n.mu.Unlock()
	n.cancel()
	return n.srv.Close()
}

// WaitReady waits until the backend has read its keys: running, offline
// or asking to sign in.
func (n *Node) WaitReady(ctx context.Context) Event {
	for {
		e := n.Last()
		if e.State != StateStarting && e.State != StateError {
			return e
		}
		select {
		case <-ctx.Done():
			return n.Last()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// Logout logs the node out (Tailscale takes the device off the tailnet),
// closes it and deletes its keys. removed is false when Tailscale could
// not be reached: the keys are deleted all the same, and the device stays
// listed in the tailnet until someone removes it there.
func (n *Node) Logout(ctx context.Context) (removed bool, err error) {
	lerr := n.lc.Logout(ctx)
	n.Close()
	rerr := os.RemoveAll(n.cfg.Dir)
	return lerr == nil, rerr
}
