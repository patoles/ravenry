package tailnet

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"ravenryd/internal/tailnet/tailnettest"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/tailcfg"
)

// The phone port's stand-in: TLS, answers a pairing, and remembers who
// connected (always 127.0.0.1: the node passes connections on).
type phonePort struct {
	srv   *httptest.Server
	mu    sync.Mutex
	conns int
	from  []string
}

func newPhonePort(t *testing.T) *phonePort {
	p := &phonePort{}
	p.srv = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		p.from = append(p.from, r.RemoteAddr)
		p.mu.Unlock()
		if r.Method == "POST" && r.URL.Path == "/api/phone/pair" {
			var b struct{ Code string }
			json.NewDecoder(r.Body).Decode(&b)
			if b.Code != "ABCD-EFGH-JKMN-PQRS" {
				w.WriteHeader(401)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"ok":true,"token":"t0k3n","device":{"id":"d1","name":"Pixel 8"}}`))
			return
		}
		w.WriteHeader(404)
	}))
	p.srv.Config.ConnState = func(c net.Conn, s http.ConnState) {
		if s == http.StateNew {
			p.mu.Lock()
			p.conns++
			p.mu.Unlock()
		}
	}
	p.srv.StartTLS()
	t.Cleanup(p.srv.Close)
	return p
}

func (p *phonePort) port() int { return p.srv.Listener.Addr().(*net.TCPAddr).Port }
func (p *phonePort) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.conns
}

type events struct {
	mu  sync.Mutex
	all []Event
}

func (e *events) add(ev Event) { e.mu.Lock(); e.all = append(e.all, ev); e.mu.Unlock() }

// wait waits for an event that ok accepts.
func (e *events) wait(t *testing.T, d time.Duration, what string, ok func(Event) bool) Event {
	t.Helper()
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		e.mu.Lock()
		for _, ev := range e.all {
			if ok(ev) {
				e.mu.Unlock()
				return ev
			}
		}
		e.mu.Unlock()
		time.Sleep(50 * time.Millisecond)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	t.Fatalf("no %s in %v; events: %+v", what, d, e.all)
	return Event{}
}

func TestAllowed(t *testing.T) {
	who := func(user, sharer tailcfg.UserID, tags ...string) *apitype.WhoIsResponse {
		return &apitype.WhoIsResponse{Node: &tailcfg.Node{User: user, Sharer: sharer, Tags: tags}}
	}
	for _, c := range []struct {
		name  string
		owner tailcfg.UserID
		known bool
		who   *apitype.WhoIsResponse
		ok    bool
	}{
		{"the owner's device", 7, true, who(7, 0), true},
		{"another account's", 7, true, who(8, 0), false},
		{"tagged", 7, true, who(7, 0, "tag:phone"), false},
		{"shared in", 7, true, who(7, 9), false},
		{"unknown device", 7, true, nil, false},
		{"owner not known yet", 0, false, who(0, 0), false},
		{"this node tagged", 7, false, who(7, 0), false},
	} {
		ok, why := Allowed(c.owner, c.known, c.who)
		if ok != c.ok || (!ok && why == "") {
			t.Errorf("%s: allowed %v (%q), want %v", c.name, ok, why, c.ok)
		}
	}
}

func TestLoopbackHTTP(t *testing.T) {
	for u, want := range map[string]bool{
		"http://127.0.0.1:1234": true, "http://[::1]:80": true, "http://localhost:9": true,
		"https://127.0.0.1:1": false, "http://192.168.1.2:80": false, "http://controlplane.tailscale.com": false,
		"http://u:p@127.0.0.1:1": false, "": false,
	} {
		if got := LoopbackHTTP(u); got != want {
			t.Errorf("LoopbackHTTP(%q) = %v", u, got)
		}
	}
	if _, err := Start(Config{Dir: t.TempDir(), Forward: 1, ControlURL: "https://evil.example"}); err == nil {
		t.Fatal("a control server that is not on this Mac was taken")
	}
}

// The whole way, on a tailnet of this Mac: ravenry signs in (its sign-in
// page opened), gets its name and addresses, the owner's phone reaches the
// phone port and pairs, by address and by name; another account's device,
// a tagged one and a shared one are closed before a byte reaches it.
// Closed (the switch off): nothing listens. Started again from its keys:
// on without a sign-in. Signed out: Tailscale took the log-out, its keys
// are gone.
func TestTailnet(t *testing.T) {
	if testing.Short() {
		t.Skip("a tailnet on this Mac takes a few seconds")
	}
	lab, err := tailnettest.Start(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(lab.Close)
	pp := newPhonePort(t)
	dir := filepath.Join(t.TempDir(), "tailnet")
	ev := &events{}
	var logs []string
	var lmu sync.Mutex
	cfg := Config{Dir: dir, Forward: pp.port(), Port: 4601, ControlURL: lab.URL, Events: ev.add, Logf: func(f string, a ...any) {
		lmu.Lock()
		logs = append(logs, f)
		lmu.Unlock()
	}}
	t0 := time.Now()
	n, err := Start(cfg)
	if err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(dir)
	if err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatalf("state folder: %v %v", fi.Mode(), err)
	}
	need := ev.wait(t, 20*time.Second, "sign-in URL", func(e Event) bool { return e.State == StateNeedsLogin && e.AuthURL != "" })
	if !strings.HasPrefix(need.AuthURL, lab.URL+"/auth/") {
		t.Fatalf("sign-in URL %q", need.AuthURL)
	}
	// Nothing on the tailnet before the sign-in.
	if lab.Node("ravenry") != nil && n.ln != nil {
		t.Fatal("listening before the sign-in")
	}
	// The person's browser: the page opened.
	res, err := http.Get(need.AuthURL)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("sign-in page: %v %v", res, err)
	}
	res.Body.Close()
	on := ev.wait(t, 30*time.Second, "running", func(e Event) bool { return e.State == StateRunning })
	t.Logf("on the tailnet %v after start: %+v", time.Since(t0).Round(time.Millisecond), on)
	if on.Name != "ravenry" || on.Host != "ravenry."+tailnettest.Domain || len(on.IPs) == 0 || !strings.HasPrefix(on.IPs[0], "100.") || on.Port != 4601 || !strings.Contains(on.Account, "@") {
		t.Fatalf("running: %+v", on)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	peer := func(name, kind string) *tailnettest.Peer {
		t.Helper()
		p, err := lab.Peer(ctx, filepath.Join(t.TempDir(), name), name)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(p.Close)
		if err := lab.Make(p, kind); err != nil {
			t.Fatal(err)
		}
		// Until ravenry's own map says what the device now is.
		for i := 0; ; i++ {
			who, err := n.lc.WhoIs(ctx, p.IP.String()+":1")
			if err == nil && who.Node != nil && (kind != tailnettest.Owner || who.Node.User == lab.Node("ravenry").User) && (kind != tailnettest.Tagged || len(who.Node.Tags) > 0) && (kind != tailnettest.Shared || who.Node.Sharer != 0) {
				break
			}
			if i > 200 {
				t.Fatalf("ravenry never saw %s as %s: %+v %v", name, kind, who, err)
			}
			time.Sleep(50 * time.Millisecond)
		}
		return p
	}
	addr := on.IPs[0] + ":4601"
	pair := `{"code":"ABCD-EFGH-JKMN-PQRS","name":"Pixel 8","platform":"android"}`
	owner := peer("pixel", tailnettest.Owner)
	a := owner.Request(ctx, addr, "POST", "/api/phone/pair", pair)
	if a.Status != 200 || !strings.Contains(a.Body, `"token":"t0k3n"`) || a.Pin == "" {
		t.Fatalf("the owner's phone, by address: %+v", a)
	}
	b := owner.Request(ctx, on.Host+":4601", "POST", "/api/phone/pair", pair)
	if b.Status != 200 || b.Pin != a.Pin {
		t.Fatalf("the owner's phone, by name: %+v", b)
	}
	pp.mu.Lock()
	for _, f := range pp.from {
		if !strings.HasPrefix(f, "127.0.0.1:") {
			t.Errorf("the phone port saw %s, not 127.0.0.1", f)
		}
	}
	pp.mu.Unlock()

	for _, k := range []string{tailnettest.Stranger, tailnettest.Tagged, tailnettest.Shared} {
		p := peer(k, k)
		before := pp.count()
		got := p.Request(ctx, addr, "POST", "/api/phone/pair", pair)
		if got.Status != 0 || got.Error == "" || got.Pin != "" {
			t.Fatalf("%s got through: %+v", k, got)
		}
		r := ev.wait(t, 5*time.Second, k+" refused", func(e Event) bool { return e.Refused != nil && e.Refused.From == p.IP.String() })
		if pp.count() != before {
			t.Fatalf("%s reached the phone port", k)
		}
		t.Logf("%s refused at the connection: %s", k, r.Refused.Why)
	}

	// The switch off: nothing listens on the tailnet.
	n.Close()
	short, c2 := context.WithTimeout(ctx, 4*time.Second)
	off := owner.Request(short, addr, "GET", "/api/phone/hello", "")
	c2()
	if off.Status != 0 {
		t.Fatalf("closed, it still answered: %+v", off)
	}
	if _, err := os.Stat(filepath.Join(dir, "tailscaled.state")); err != nil {
		t.Fatalf("closed, its keys went: %v", err)
	}

	// On again from its keys: no sign-in.
	ev2 := &events{}
	cfg.Events = ev2.add
	signins := lab.SignIns()
	n2, err := Start(cfg)
	if err != nil {
		t.Fatal(err)
	}
	on2 := ev2.wait(t, 30*time.Second, "running again", func(e Event) bool { return e.State == StateRunning })
	if lab.SignIns() != signins || on2.Host != on.Host || on2.IPs[0] != on.IPs[0] {
		t.Fatalf("on again: %+v (sign-ins %d, were %d)", on2, lab.SignIns(), signins)
	}
	ev2.mu.Lock()
	for _, e := range ev2.all {
		if e.State == StateNeedsLogin {
			t.Fatal("asked to sign in again")
		}
	}
	ev2.mu.Unlock()
	if a := owner.Request(ctx, addr, "GET", "/api/phone/hello", ""); a.Status != 404 {
		t.Fatalf("on again, the owner's phone: %+v", a)
	}

	// No internet: offline, the name kept.
	if !testing.Short() && os.Getenv("TAILNET_OFFLINE") != "0" {
		t0 := time.Now()
		lab.Down()
		o := ev2.wait(t, 40*time.Second, "offline", func(e Event) bool { return e.State == StateOffline })
		t.Logf("offline %v after the servers went: %+v", time.Since(t0).Round(time.Millisecond), o)
		if o.Host != on.Host {
			t.Fatalf("offline: %+v", o)
		}
	}
	n2.Close()

	lmu.Lock()
	for _, l := range logs {
		if strings.Contains(l, "/auth/") {
			t.Errorf("a log line carries the sign-in URL: %q", l)
		}
	}
	lmu.Unlock()
}

// Sign out: Tailscale takes the log-out and the keys are deleted.
func TestSignOut(t *testing.T) {
	if testing.Short() {
		t.Skip("a tailnet on this Mac takes a few seconds")
	}
	lab, err := tailnettest.Start(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(lab.Close)
	pp := newPhonePort(t)
	dir := filepath.Join(t.TempDir(), "tailnet")
	ev := &events{}
	n, err := Start(Config{Dir: dir, Forward: pp.port(), ControlURL: lab.URL, Events: ev.add})
	if err != nil {
		t.Fatal(err)
	}
	need := ev.wait(t, 20*time.Second, "sign-in URL", func(e Event) bool { return e.State == StateNeedsLogin })
	if res, err := http.Get(need.AuthURL); err == nil {
		res.Body.Close()
	}
	on := ev.wait(t, 30*time.Second, "running", func(e Event) bool { return e.State == StateRunning })
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	owner, err := lab.Peer(ctx, filepath.Join(t.TempDir(), "pixel"), "pixel")
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	removed, err := n.Logout(ctx)
	if err != nil || !removed {
		t.Fatalf("logout: removed %v, %v", removed, err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("its keys are still there: %v", err)
	}
	short, c2 := context.WithTimeout(ctx, 4*time.Second)
	defer c2()
	if a := owner.Request(short, on.IPs[0]+":"+itoa(pp.port()), "GET", "/", ""); a.Status != 0 {
		t.Fatalf("signed out, it still answered: %+v", a)
	}
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}
