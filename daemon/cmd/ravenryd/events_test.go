package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
)

// `ravenry events`, run as a program against real daemons on the test's
// own sockets and a stand-in board on 127.0.0.1 (its /api/feed), read as
// an agent reads it: one JSON object per line.

// feedProc is a running `ravenry events --json`.
type feedProc struct {
	t     *testing.T
	cmd   *exec.Cmd
	mu    sync.Mutex
	raw   bytes.Buffer
	errb  bytes.Buffer
	evs   []map[string]any
	done  chan struct{}
	code  int
	ready chan string
}

func (e *env) feed(t *testing.T, extra []string, args ...string) *feedProc {
	t.Helper()
	c := e.ravenry("0.2.0", append([]string{"events", "--json"}, args...)...)
	c.Env = append(c.Env, extra...)
	out, err := c.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	errp, err := c.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	p := &feedProc{t: t, cmd: c, done: make(chan struct{}), ready: make(chan string, 1)}
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		sc := bufio.NewScanner(errp)
		for sc.Scan() {
			p.mu.Lock()
			p.errb.WriteString(sc.Text() + "\n")
			p.mu.Unlock()
			if strings.HasPrefix(sc.Text(), "ravenry events: following") {
				select {
				case p.ready <- sc.Text():
				default:
				}
			}
		}
	}()
	go func() {
		defer wg.Done()
		sc := bufio.NewScanner(out)
		sc.Buffer(make([]byte, 1<<16), 1<<22)
		for sc.Scan() {
			var ev map[string]any
			p.mu.Lock()
			p.raw.WriteString(sc.Text() + "\n")
			if json.Unmarshal(sc.Bytes(), &ev) != nil {
				t.Errorf("not one JSON object a line: %q", sc.Text())
			} else {
				p.evs = append(p.evs, ev)
			}
			p.mu.Unlock()
		}
	}()
	go func() {
		wg.Wait()
		err := c.Wait()
		if ee, ok := err.(*exec.ExitError); ok {
			p.code = ee.ExitCode()
		}
		close(p.done)
	}()
	t.Cleanup(func() {
		c.Process.Kill()
		<-p.done
	})
	return p
}

// waitReady waits for the line that says what it follows.
func (p *feedProc) waitReady() string {
	p.t.Helper()
	select {
	case s := <-p.ready:
		return s
	case <-p.done:
		p.t.Fatalf("ravenry events ended (exit %d) before it followed anything:\n%s", p.code, p.stderr())
	case <-time.After(10 * time.Second):
		p.t.Fatalf("ravenry events said nothing in 10 s:\n%s", p.stderr())
	}
	return ""
}

func (p *feedProc) stderr() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.errb.String()
}

func (p *feedProc) rawOut() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.raw.String()
}

func (p *feedProc) all() []map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]map[string]any(nil), p.evs...)
}

// find waits for an event that matches, and returns its index and itself.
func (p *feedProc) find(what string, match func(map[string]any) bool) (int, map[string]any) {
	p.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		for i, ev := range p.all() {
			if match(ev) {
				return i, ev
			}
		}
		if time.Now().After(deadline) {
			p.t.Fatalf("no %s in the feed; it has:\n%s\nstderr:\n%s", what, p.rawOut(), p.stderr())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// count is how many events match, after a moment for a second copy.
func (p *feedProc) count(match func(map[string]any) bool) int {
	time.Sleep(300 * time.Millisecond)
	n := 0
	for _, ev := range p.all() {
		if match(ev) {
			n++
		}
	}
	return n
}

func is(name, pane string) func(map[string]any) bool {
	return func(ev map[string]any) bool {
		return ev["event"] == name && (pane == "" || ev["pane"] == pane)
	}
}

func field(ev map[string]any, path ...string) any {
	var v any = ev
	for _, k := range path {
		m, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = m[k]
	}
	return v
}

// board is a stand-in board: GET /api/feed holds a stream to each reader
// and writes them what the test sends, until drop() ends them.
type board struct {
	url     string
	mu      sync.Mutex
	streams map[chan string]bool
}

func newBoard(t *testing.T) *board {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	b := &board{url: "http://" + ln.Addr().String(), streams: map[chan string]bool{}}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/feed" || r.Method != "GET" {
			http.NotFound(w, r)
			return
		}
		ch := make(chan string, 16)
		b.mu.Lock()
		b.streams[ch] = true
		b.mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fmt.Fprint(w, ": hello\n\n")
		w.(http.Flusher).Flush()
		for {
			select {
			case s, ok := <-ch:
				if !ok {
					return
				}
				fmt.Fprint(w, s)
				w.(http.Flusher).Flush()
			case <-r.Context().Done():
				return
			}
		}
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return b
}

func (b *board) send(t *testing.T, kind string, v any) {
	t.Helper()
	j, _ := json.Marshal(v)
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.streams) == 0 {
		t.Fatal("nobody reads the board's feed")
	}
	for ch := range b.streams {
		ch <- "event: " + kind + "\ndata: " + string(j) + "\n\n"
	}
}

func (b *board) drop() {
	b.mu.Lock()
	for ch := range b.streams {
		close(ch)
	}
	b.streams = map[chan string]bool{}
	b.mu.Unlock()
}

func dialDaemon(t *testing.T, e *env, version string) *client.Client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := client.Dial(ctx, filepath.Join(e.dir, "run", "ravenryd-"+version+".sock"), client.Options{Name: "events-test"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func TestEventsFeed(t *testing.T) {
	e := newEnv(t)
	b := newBoard(t)
	e.vars = append(e.vars, "RAVENRY_HUB_URL="+b.url)
	// The older daemon keeps a pane, so it stays beside the newer one
	// (it drains: it ends with its last pane).
	e.serve("0.1.0")
	sock1 := filepath.Join(e.dir, "run", "ravenryd-0.1.0.sock")
	keep := strings.TrimSpace(e.ok("0.1.0", "new", "--socket", sock1, "--name", "keep", "--", "/bin/sh", "-c", "exec cat"))
	newer := e.serve("0.2.0")
	sock2 := filepath.Join(e.dir, "run", "ravenryd-0.2.0.sock")

	// The main feed, and a second one run as if in the asking pane (below).
	f := e.feed(t, nil)
	if s := f.waitReady(); !strings.Contains(s, "2 daemons on this machine (0.1.0, 0.2.0)") || !strings.Contains(s, "the board at "+b.url) {
		t.Fatalf("it follows: %q", s)
	}

	// ---- a pane's life, in order, on the newest daemon
	id := strings.TrimSpace(e.ok("0.2.0", "new", "--socket", sock2, "--name", "build", "--", "/bin/sh", "-c", `printf '\033]0;Building\007'; sleep 0.5; exit 3`))
	iCreated, created := f.find("pane.created", is("pane.created", id))
	if created["machine"] != "local" || created["daemon"] != "0.2.0" || created["name"] != "build" || created["pane_name"] != "build" {
		t.Errorf("pane.created %v", created)
	}
	iTitle, title := f.find("pane.title", func(ev map[string]any) bool { return is("pane.title", id)(ev) && ev["title"] == "Building" })
	iExited, exited := f.find("pane.exited", is("pane.exited", id))
	if field(exited, "exit", "code") != float64(3) {
		t.Errorf("pane.exited %v", exited)
	}
	cli := dialDaemon(t, e, "0.2.0")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var rr proto.AgentReportResult
	if err := cli.Call(ctx, "agent.report", map[string]any{"pane": id, "assistant": "claude", "event": "Stop", "state": "idle", "message": "Tests pass."}, &rr); err != nil {
		t.Fatal(err)
	}
	iReport, report := f.find("agent.report", is("agent.report", id))
	if field(report, "report", "event") != "Stop" || field(report, "report", "assistant") != "claude" || field(report, "report", "state") != "idle" {
		t.Errorf("agent.report %v", report)
	}
	e.ok("0.2.0", "close", id)
	iClosed, _ := f.find("pane.closed", is("pane.closed", id))
	if !(iCreated < iTitle && iTitle < iExited && iExited < iReport && iReport < iClosed) {
		t.Errorf("out of order: created %d, title %d, exited %d, report %d, closed %d\n%s", iCreated, iTitle, iExited, iReport, iClosed, f.rawOut())
	}
	_ = title
	for _, name := range []string{"pane.created", "pane.title", "pane.exited", "agent.report", "pane.closed"} {
		if n := f.count(is(name, id)); n != 1 && name != "pane.title" {
			t.Errorf("%s %d times", name, n)
		}
	}

	// ---- the older daemon's panes are in the same feed
	e.ok("0.1.0", "update", "--socket", sock1, keep, "--name", "kept")
	_, ou := f.find("pane.updated on 0.1.0", is("pane.updated", keep))
	if ou["daemon"] != "0.1.0" || ou["name"] != "kept" {
		t.Errorf("merged: %v", ou)
	}

	// ---- cards: the answer to the asker only, a secret's value nowhere
	asker := strings.TrimSpace(e.ok("0.2.0", "new", "--socket", sock2, "--name", "agent", "--", "/bin/sh", "-c", "exec cat"))
	mine := e.feed(t, []string{"RAVENRY_PANE=" + asker})
	mine.waitReady()
	askCmd := e.ravenry("0.2.0", "ask", "--no-wait", "Ship it?", "--option", "Yes", "--option", "No")
	askCmd.Env = append(askCmd.Env, "RAVENRY_PANE="+asker, "RAVENRY_SOCKET="+sock2)
	out, errs, code := runCmd(t, askCmd)
	cpID := strings.TrimSpace(out)
	if code != 0 || cpID == "" {
		t.Fatalf("ask: %d %s %s", code, out, errs)
	}
	_, opened := f.find("checkpoint.opened", func(ev map[string]any) bool {
		return ev["event"] == "checkpoint.opened" && field(ev, "checkpoint", "id") == cpID
	})
	if opened["pane"] != asker || field(opened, "checkpoint", "kind") != "ask" || field(opened, "checkpoint", "title") != "Ship it?" {
		t.Errorf("checkpoint.opened %v", opened)
	}
	var ar proto.CheckpointResult
	if err := cli.Call(ctx, "checkpoint.answer", map[string]any{"checkpoint": cpID, "choice": 0}, &ar); err != nil {
		t.Fatal(err)
	}
	isCp := func(name, cp string) func(map[string]any) bool {
		return func(ev map[string]any) bool { return ev["event"] == name && field(ev, "checkpoint", "id") == cp }
	}
	_, answered := f.find("checkpoint.answered", isCp("checkpoint.answered", cpID))
	if answered["answer"] != nil {
		t.Errorf("another agent's feed has the answer: %v", answered)
	}
	_, mineAnswered := mine.find("checkpoint.answered (asker)", isCp("checkpoint.answered", cpID))
	if field(mineAnswered, "answer", "option") != "Yes" {
		t.Errorf("the asker's feed has no answer: %v", mineAnswered)
	}
	if n := f.count(isCp("checkpoint.opened", cpID)); n != 1 {
		t.Errorf("checkpoint.opened %d times", n)
	}
	if n := f.count(isCp("checkpoint.answered", cpID)); n != 1 {
		t.Errorf("checkpoint.answered %d times", n)
	}

	secret := "s3cret-" + strings.Repeat("v", 6) + "-" + fmt.Sprint(time.Now().UnixNano()%100000)
	secCmd := e.ravenry("0.2.0", "secret", "--no-wait", "Deploy token", "--", "/bin/sh", "-c", "printf 'Token: '; read v; echo got it")
	secCmd.Env = append(secCmd.Env, "RAVENRY_PANE="+asker, "RAVENRY_SOCKET="+sock2)
	out, errs, code = runCmd(t, secCmd)
	secID := strings.TrimSpace(out)
	if code != 0 {
		t.Fatalf("secret: %d %s %s", code, out, errs)
	}
	f.find("checkpoint.opened (secret)", isCp("checkpoint.opened", secID))
	if err := cli.Call(ctx, "checkpoint.answer", map[string]any{"checkpoint": secID, "secret": secret}, &ar); err != nil {
		t.Fatal(err)
	}
	f.find("checkpoint.running (secret)", isCp("checkpoint.running", secID))
	_, secDone := mine.find("checkpoint.answered (secret, asker)", isCp("checkpoint.answered", secID))
	if field(secDone, "answer", "delivered") != true {
		t.Errorf("the asker's secret: %v", secDone)
	}
	if field(secDone, "run", "output") != nil {
		t.Errorf("a secret's run output in the feed: %v", secDone)
	}
	f.find("checkpoint.answered (secret)", isCp("checkpoint.answered", secID))

	cancelCmd := e.ravenry("0.2.0", "ask", "--no-wait", "Tag it?", "--option", "Yes")
	cancelCmd.Env = append(cancelCmd.Env, "RAVENRY_PANE="+asker, "RAVENRY_SOCKET="+sock2)
	out, _, _ = runCmd(t, cancelCmd)
	canID := strings.TrimSpace(out)
	f.find("checkpoint.opened (to cancel)", isCp("checkpoint.opened", canID))
	if err := cli.Call(ctx, "checkpoint.cancel", map[string]any{"checkpoint": canID, "reason": "not needed"}, nil); err != nil {
		t.Fatal(err)
	}
	_, cancelled := f.find("checkpoint.cancelled", isCp("checkpoint.cancelled", canID))
	if field(cancelled, "checkpoint", "reason") != "not needed" {
		t.Errorf("checkpoint.cancelled %v", cancelled)
	}

	// ---- the board: its own events, another machine's daemon, its going and coming back
	b.send(t, "board", map[string]any{"event": "session.needs_you", "at": "2026-11-16T10:00:00.000Z", "pane": asker, "session": "s1", "project": "kite", "project_name": "kite", "why": "asked", "line": "Which one?"})
	_, needs := f.find("session.needs_you", is("session.needs_you", asker))
	if needs["machine"] != "local" || needs["pane_name"] != "agent" || needs["why"] != "asked" {
		t.Errorf("session.needs_you %v", needs)
	}
	b.send(t, "board", map[string]any{"event": "something.new", "at": "2026-11-16T10:00:00.000Z"})
	remotePane := proto.Pane{ID: "pzzzzzz2", Name: "devbuild", Command: []string{"make"}, State: "running"}
	b.send(t, "daemon", map[string]any{"machine": "devbox", "daemon": "0.1.37", "event": proto.Event{V: 1, Type: "event", Event: "pane.created", Pane: &remotePane}})
	yes := "kept"
	b.send(t, "daemon", map[string]any{"machine": "devbox", "daemon": "0.1.37", "event": proto.Event{V: 1, Type: "event", Event: "checkpoint.closed", Checkpoint: &proto.Checkpoint{ID: "cremote1", Kind: "ask", State: "answered", Title: "Remote?", Pane: asker, Answer: &proto.CheckpointAnswer{Text: &yes}}}})
	_, rp := f.find("another machine's pane.created", is("pane.created", "pzzzzzz2"))
	if rp["machine"] != "devbox" || rp["daemon"] != "0.1.37" || rp["name"] != "devbuild" {
		t.Errorf("remote pane.created %v", rp)
	}
	_, rc := mine.find("another machine's checkpoint.answered", isCp("checkpoint.answered", "cremote1"))
	if rc["machine"] != "devbox" || rc["answer"] != nil {
		t.Errorf("a card of another machine with the same pane id is not this asker's: %v", rc)
	}
	if strings.Contains(f.rawOut(), "something.new") {
		t.Error("an event the CLI does not know passed through")
	}
	b.drop()
	f.find("board.down", is("board.down", ""))
	_, up := f.find("board.up", is("board.up", ""))
	if up["url"] != b.url {
		t.Errorf("board.up %v", up)
	}

	// ---- daemons that go, and one that comes back
	// The older one ends with its last pane.
	// It may stop before it answers the close, or before it says
	// pane.closed (it drains: its last pane ends it); daemon.down it says.
	e.run("0.1.0", "close", "--socket", sock1, keep)
	_, down := f.find("daemon.down (0.1.0)", func(ev map[string]any) bool { return is("daemon.down", "")(ev) && ev["daemon"] == "0.1.0" })
	if down["machine"] != "local" || down["socket"] != sock1 {
		t.Errorf("daemon.down %v", down)
	}
	newer.Process.Signal(syscall.SIGTERM)
	newer.Wait()
	f.find("daemon.down (0.2.0)", func(ev map[string]any) bool { return is("daemon.down", "")(ev) && ev["daemon"] == "0.2.0" })
	e.serve("0.2.0")
	_, back := f.find("daemon.up", is("daemon.up", ""))
	if back["daemon"] != "0.2.0" || back["socket"] != sock2 {
		t.Errorf("daemon.up %v", back)
	}
	if n := f.count(is("daemon.up", "")); n != 1 {
		t.Errorf("daemon.up %d times", n)
	}

	// ---- nothing of the secret anywhere, in either feed
	for name, s := range map[string]string{"feed": f.rawOut(), "asker's feed": mine.rawOut(), "stderr": f.stderr() + mine.stderr()} {
		if strings.Contains(s, secret) {
			t.Errorf("the secret's value is in the %s", name)
		}
	}
	if strings.ContainsRune(f.rawOut(), '\u2014') {
		t.Error("an em dash in the feed")
	}
}

func TestEventsFiltersOnceTimeout(t *testing.T) {
	e := newEnv(t)
	e.vars = append(e.vars, "RAVENRY_HUB_URL=http://127.0.0.1:9")
	e.serve("0.2.0")
	sock := filepath.Join(e.dir, "run", "ravenryd-0.2.0.sock")

	// A bad kind is refused at once.
	_, errs, code := runCmd(t, e.ravenry("0.2.0", "events", "--kind", "pane.exploded"))
	if code != 1 || !strings.Contains(errs, "pane.exploded") {
		t.Errorf("a bad kind: exit %d, %s", code, errs)
	}
	help, _, code := runCmd(t, e.ravenry("0.2.0", "events", "--help"))
	if code != 0 || !strings.Contains(help, "pane.exited") || !strings.Contains(help, "--once --kind pane.exited --pane build") {
		t.Errorf("events --help: exit %d\n%s", code, help)
	}

	// --once: the first match only, an exit of another pane before it ignored.
	once := e.feed(t, nil, "--once", "--kind", "pane.exited", "--pane", "build")
	if s := once.waitReady(); !strings.Contains(s, "not the board") {
		t.Errorf("no board: %q", s)
	}
	groups := e.feed(t, nil, "--kind", "checkpoint", "--kind", "pane.closed")
	groups.waitReady()
	e.ok("0.2.0", "new", "--socket", sock, "--name", "other", "--", "/bin/sh", "-c", "exit 1")
	time.Sleep(500 * time.Millisecond)
	select {
	case <-once.done:
		t.Fatalf("--once ended on another pane's exit:\n%s", once.rawOut())
	default:
	}
	bid := strings.TrimSpace(e.ok("0.2.0", "new", "--socket", sock, "--name", "build", "--", "/bin/sh", "-c", "sleep 0.2; exit 0"))
	select {
	case <-once.done:
	case <-time.After(10 * time.Second):
		t.Fatalf("--once did not end at the build pane's exit:\n%s", once.rawOut())
	}
	evs := once.all()
	if once.code != 0 || len(evs) != 1 || evs[0]["event"] != "pane.exited" || evs[0]["pane"] != bid {
		t.Errorf("--once: exit %d, %v", once.code, evs)
	}

	// --timeout with nothing matched: its own exit code, nothing printed.
	start := time.Now()
	out, errs, code := runCmd(t, e.ravenry("0.2.0", "events", "--kind", "pane.exited", "--pane", "never", "--timeout", "1500ms"))
	if code != 124 || out != "" || !strings.Contains(errs, "nothing matched") || time.Since(start) > 6*time.Second {
		t.Errorf("--timeout: exit %d after %v, out %q, err %q", code, time.Since(start), out, errs)
	}
	// --timeout after a match: 0.
	tm := e.feed(t, nil, "--kind", "pane.created", "--timeout", "2s")
	tm.waitReady()
	e.ok("0.2.0", "new", "--socket", sock, "--", "/bin/sh", "-c", "exit 0")
	select {
	case <-tm.done:
	case <-time.After(10 * time.Second):
		t.Fatal("--timeout 2s did not end")
	}
	if tm.code != 0 || len(tm.all()) != 1 {
		t.Errorf("--timeout after a match: exit %d, %v", tm.code, tm.all())
	}

	// Groups: only what was asked for.
	e.ok("0.2.0", "close", "--socket", sock, bid)
	groups.find("pane.closed", is("pane.closed", bid))
	for _, ev := range groups.all() {
		n, _ := ev["event"].(string)
		if !strings.HasPrefix(n, "checkpoint.") && n != "pane.closed" {
			t.Errorf("--kind checkpoint --kind pane.closed let %s through", n)
		}
	}

	// A human line, by default.
	h := e.ravenry("0.2.0", "events", "--once", "--kind", "pane.created")
	var hb bytes.Buffer
	h.Stdout = &hb
	he, _ := h.StderrPipe()
	if err := h.Start(); err != nil {
		t.Fatal(err)
	}
	sc := bufio.NewScanner(he)
	for sc.Scan() && !strings.HasPrefix(sc.Text(), "ravenry events: following") {
	}
	hid := strings.TrimSpace(e.ok("0.2.0", "new", "--socket", sock, "--name", "web", "--", "/bin/sh", "-c", "exit 0"))
	h.Wait()
	line := hb.String()
	if !strings.Contains(line, "pane.created") || !strings.Contains(line, "local") || !strings.Contains(line, hid+" (web)") || strings.Count(line, "\n") != 1 {
		t.Errorf("human line: %q", line)
	}
}
