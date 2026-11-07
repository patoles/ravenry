package pane

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"testing"
	"time"

	"ravenryd/internal/testenv"
	"ravenryd/internal/testprog"
	"ravenryd/internal/vt"
)

func TestMain(m *testing.M) {
	testprog.Run()
	os.Exit(m.Run())
}

// newManager returns a Manager whose panes get a throwaway HOME and a
// fixed PATH, never the user's own shell setup.
func newManager(t *testing.T) *Manager {
	t.Helper()
	home := t.TempDir()
	logs := t.TempDir()
	env := []string{"PATH=/usr/bin:/bin", "HOME=" + home, "LANG=en_US.UTF-8"}
	testenv.Check(t, env)
	testenv.CheckDirs(t, logs)
	m := NewManager(ManagerOptions{LogDir: logs, Env: env})
	t.Cleanup(func() { m.Shutdown(time.Second) })
	return m
}

func newPane(t *testing.T, m *Manager, cfg Config) *Pane {
	t.Helper()
	p, err := m.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func waitText(t *testing.T, p *Pane, re string, since uint64) *WaitResult {
	t.Helper()
	r, err := p.Wait(context.Background(), WaitSpec{Text: regexp.MustCompile(re), Since: &since, Timeout: 10 * time.Second}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if r.Condition != "text" {
		t.Fatalf("waiting for %q: %s; output %q; screen %q", re, r.Condition, r.Output, r.Screen)
	}
	return r
}

func TestEnvAndCapture(t *testing.T) {
	m := newManager(t)
	cwd := t.TempDir()
	p := newPane(t, m, Config{
		Command: []string{"/bin/sh", "-c", `printf 'pane=%s term=%s dir=%s x=%s\n' "$RAVENRY_PANE" "$TERM" "$(pwd -P)" "$X"; exec sleep 60`},
		Cwd:     cwd, Env: map[string]string{"X": "y", "RAVENRY_PANE": "forged"}, Cols: 300, Rows: 10,
	})
	r := waitText(t, p, `pane=(\S+) term=(\S+) dir=(\S+) x=(\S+)`, 0)
	real, _ := filepath.EvalSymlinks(cwd)
	if r.Groups[0] != p.ID() || r.Groups[1] != "xterm-256color" || r.Groups[2] != real || r.Groups[3] != "y" {
		t.Fatalf("groups %q, want id %s dir %s", r.Groups, p.ID(), real)
	}
	c, mark, err := p.Capture(vt.CaptureOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(c.Lines[0].Text, "pane="+p.ID()) || c.Cols != 300 || c.Rows != 10 || mark == 0 {
		t.Fatalf("capture %+v mark %d", c, mark)
	}
	if c.Cursor.Y != 1 || c.Cursor.X != 0 {
		t.Fatalf("cursor %+v", c.Cursor)
	}
}

func TestDefaultShellIsLogin(t *testing.T) {
	m := newManager(t)
	m.o.Env = append(m.o.Env, "SHELL=/bin/sh")
	p := newPane(t, m, Config{})
	if p.cmd.Args[0] != "-sh" {
		t.Fatalf("argv0 %q", p.cmd.Args[0])
	}
}

func TestCloseKillsTheWholeTree(t *testing.T) {
	m := newManager(t)
	argv, env := testprog.Command("tree")
	p := newPane(t, m, Config{Command: argv, Env: env})
	r := waitText(t, p, `pids: (\d+) (\d+) (\d+)`, 0)
	var pids []int
	for _, g := range r.Groups {
		var n int
		fmt.Sscan(g, &n)
		pids = append(pids, n)
	}
	for _, pid := range pids {
		if !alive(pid) {
			t.Fatalf("pid %d not running before close", pid)
		}
	}
	start := time.Now()
	_, n, err := m.Close(p.ID(), 600*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if n < 4 {
		t.Errorf("signalled %d processes, want at least 4 (the root, a child, a stubborn child, a daemon)", n)
	}
	for _, pid := range pids {
		if alive(pid) && !zombie(pid) {
			t.Errorf("pid %d survived the close", pid)
			syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	t.Logf("closed a tree of %d processes in %v", n, time.Since(start).Round(time.Millisecond))
	if _, err := m.Get(p.ID()); err != ErrNotFound {
		t.Fatal("pane still listed after close")
	}
}

func TestTTL(t *testing.T) {
	m := newManager(t)
	if _, err := m.New(Config{Command: []string{"/bin/sleep", "60"}, TTL: time.Second}); err == nil {
		t.Fatal("a visible pane accepted a ttl")
	}
	p := newPane(t, m, Config{Command: []string{"/bin/sleep", "60"}, Hidden: true, TTL: 300 * time.Millisecond})
	if len(m.List(false)) != 0 || len(m.List(true)) != 1 {
		t.Fatal("hidden pane listed by default, or missing with hidden")
	}
	pid := p.pid
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := m.Get(p.ID()); err == ErrNotFound {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("hidden pane outlived its ttl")
		}
		time.Sleep(20 * time.Millisecond)
	}
	for alive(pid) && !zombie(pid) {
		if time.Now().After(deadline) {
			t.Fatal("process survived the ttl")
		}
		time.Sleep(20 * time.Millisecond)
	}
	for {
		if _, err := os.Stat(filepath.Join(m.o.LogDir, p.ID()+".log")); os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("a hidden pane's log was kept")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestWaitConditions(t *testing.T) {
	m := newManager(t)
	p := newPane(t, m, Config{Command: []string{"/bin/sh", "-c", "sleep 0.3; printf 'one\\n'; sleep 0.3; printf '\\033[1mtwo\\033[0m\\n'; sleep 0.6; exit 3"}})
	ctx := context.Background()

	r, err := p.Wait(ctx, WaitSpec{Text: regexp.MustCompile(`two`), Timeout: 5 * time.Second}, nil)
	if err != nil || r.Condition != "text" || !strings.Contains(r.Output, "two") || strings.Contains(r.Output, "\x1b") {
		t.Fatalf("text wait: %v %+v", err, r)
	}
	r, err = p.Wait(ctx, WaitSpec{Quiet: 200 * time.Millisecond, Timeout: 5 * time.Second}, nil)
	if err != nil || r.Condition != "quiet" {
		t.Fatalf("quiet wait: %v %+v", err, r)
	}
	r, err = p.Wait(ctx, WaitSpec{Exit: true, Timeout: 5 * time.Second}, nil)
	if err != nil || r.Condition != "exit" || r.Exit == nil || r.Exit.Code != 3 {
		t.Fatalf("exit wait: %v %+v", err, r)
	}
	// Already exited: returns at once.
	r, _ = p.Wait(ctx, WaitSpec{Exit: true, Timeout: time.Second}, nil)
	if r.Condition != "exit" {
		t.Fatalf("second exit wait: %+v", r)
	}
	// Text from a mark in the past, read back from the log.
	zero := uint64(0)
	r, _ = p.Wait(ctx, WaitSpec{Text: regexp.MustCompile(`one\ntwo`), Since: &zero, Timeout: time.Second}, nil)
	if r.Condition != "text" {
		t.Fatalf("since-zero wait: %+v", r)
	}
	r, _ = p.Wait(ctx, WaitSpec{Text: regexp.MustCompile(`never`), Timeout: 200 * time.Millisecond}, nil)
	if r.Condition != "timeout" {
		t.Fatalf("timeout wait: %+v", r)
	}
	if _, err := p.Wait(ctx, WaitSpec{}, nil); err != ErrBadSpec {
		t.Fatalf("empty wait: %v", err)
	}
	r, _ = p.Wait(ctx, WaitSpec{Text: regexp.MustCompile(`(?m)^two$`), Screen: true, Timeout: time.Second}, nil)
	if r.Condition != "text" {
		t.Fatalf("screen wait: %+v", r)
	}
}

func TestQuietCountsFromLastOutput(t *testing.T) {
	m := newManager(t)
	p := newPane(t, m, Config{Command: []string{"/bin/sh", "-c", "for i in 1 2 3 4 5; do echo $i; sleep 0.1; done; sleep 60"}})
	start := time.Now()
	r, err := p.Wait(context.Background(), WaitSpec{Quiet: 300 * time.Millisecond, Timeout: 5 * time.Second}, nil)
	if err != nil || r.Condition != "quiet" {
		t.Fatalf("%v %+v", err, r)
	}
	if el := time.Since(start); el < 700*time.Millisecond {
		t.Fatalf("quiet returned after %v, while output was still coming", el)
	}
	if !strings.Contains(r.Output, "5") {
		t.Fatalf("output %q", r.Output)
	}
}

func rawEcho(t *testing.T, m *Manager, init string) *Pane {
	t.Helper()
	argv, env := testprog.Command("rawecho")
	env["RAVENRY_TESTPROG_INIT"] = init
	p := newPane(t, m, Config{Command: argv, Env: env})
	waitText(t, p, `ready`, 0)
	return p
}

func send(t *testing.T, p *Pane, items ...InputItem) SendResult {
	t.Helper()
	r, err := p.Send(context.Background(), items)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestSendModes(t *testing.T) {
	m := newManager(t)
	p := rawEcho(t, m, "\x1b[?2004h")

	r := send(t, p, InputItem{Text: "hi\nthere", Mode: ModePaste})
	w := waitText(t, p, `read "(.*)"`, r.Mark)
	if w.Groups[0] != `\x1b[200~hi\rthere\x1b[201~` && w.Groups[0] != `\x1b[200~hi\nthere\x1b[201~` {
		t.Fatalf("paste arrived as %s", w.Groups[0])
	}

	r = send(t, p, InputItem{Text: "abc", Mode: ModeTyped})
	w, _ = p.Wait(context.Background(), WaitSpec{Text: regexp.MustCompile(`read "c"`), Since: &r.Mark, Timeout: 5 * time.Second}, nil)
	if !strings.Contains(w.Output, `read "a"`+"\n"+`read "b"`+"\n"+`read "c"`) {
		t.Fatalf("typed input was not one read per character: %q", w.Output)
	}

	r = send(t, p, InputItem{Text: "xyz", Mode: ModeRaw})
	waitText(t, p, `read "xyz"`, r.Mark)

	r = send(t, p, InputItem{Key: "Up"}, InputItem{Key: "Ctrl+C"}, InputItem{Key: "Enter"})
	w = waitText(t, p, `read "(.*)"`, r.Mark)
	if !strings.Contains(w.Output, `\x1b[A`) {
		t.Fatalf("keys arrived as %q", w.Output)
	}

	if _, err := p.Send(context.Background(), []InputItem{{Text: "a", Mode: "shout"}}); err == nil {
		t.Fatal("a bad mode was accepted")
	}
	if _, err := p.Send(context.Background(), []InputItem{{Key: "Hyper+Q"}}); err == nil {
		t.Fatal("a bad key was accepted")
	}
}

func TestKeysFollowTheProgramsModes(t *testing.T) {
	m := newManager(t)
	p := rawEcho(t, m, "\x1b[?1h")
	r := send(t, p, InputItem{Key: "Up"})
	w := waitText(t, p, `read "(.*)"`, r.Mark)
	if w.Groups[0] != `\x1bOA` {
		t.Fatalf("Up in application cursor mode arrived as %s", w.Groups[0])
	}
}

func TestPasteWithoutBracketedMode(t *testing.T) {
	m := newManager(t)
	p := rawEcho(t, m, "")
	r := send(t, p, InputItem{Text: "plain", Mode: ModePaste})
	w := waitText(t, p, `read "(.*)"`, r.Mark)
	if w.Groups[0] != "plain" {
		t.Fatalf("paste without mode 2004 arrived as %s", w.Groups[0])
	}
}

func TestSettle(t *testing.T) {
	m := newManager(t)
	p := newPane(t, m, Config{Command: []string{"/bin/sh"}, Env: map[string]string{"PS1": "$ "}, Rows: 6})
	waitText(t, p, `\$ `, 0)
	sent, w, err := p.Settle(context.Background(), SettleSpec{
		Input: []InputItem{{Text: "echo settled-$((40+2))", Mode: ModeRaw}, {Key: "Enter"}},
		Quiet: 200 * time.Millisecond, Timeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if w.Condition != "quiet" || sent.Bytes == 0 {
		t.Fatalf("settle: %+v %+v", sent, w)
	}
	found := false
	for _, c := range w.Changes {
		if c.After == "settled-42" {
			found = true
		}
	}
	if !found {
		t.Fatalf("diff has no settled-42 row: %+v", w.Changes)
	}
}

func TestResize(t *testing.T) {
	m := newManager(t)
	p := newPane(t, m, Config{Command: []string{"/bin/sh", "-c", "trap 'stty size' WINCH; stty size; while true; do sleep 0.05; done"}})
	waitText(t, p, `24 80`, 0)
	mark := p.Mark()
	if err := p.Resize(100, 30); err != nil {
		t.Fatal(err)
	}
	waitText(t, p, `30 100`, mark)
	if i := p.Info(); i.Cols != 100 || i.Rows != 30 {
		t.Fatalf("info size %dx%d", i.Cols, i.Rows)
	}
}

func TestSubscribeSnapshotThenLive(t *testing.T) {
	m := newManager(t)
	p := newPane(t, m, Config{Command: []string{"/bin/cat"}})
	send(t, p, InputItem{Text: "before\n", Mode: ModeRaw})
	waitText(t, p, `before\nbefore`, 0)
	s, err := p.Subscribe(SubOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	f, err := s.Next(ctx)
	if err != nil || !f.Snapshot || !strings.Contains(string(f.Data), "before") || f.Mark != p.Mark() {
		t.Fatalf("first frame %v %+v", err, f)
	}
	send(t, p, InputItem{Text: "x", Mode: ModeRaw})
	f, err = s.Next(ctx)
	if err != nil || f.Snapshot || string(f.Data) != "x" {
		t.Fatalf("live frame %v %+v", err, f)
	}

	// Since a mark: the raw bytes from the log, no snapshot.
	since := uint64(0)
	s2, _ := p.Subscribe(SubOptions{Since: &since})
	defer s2.Close()
	f, _ = s2.Next(ctx)
	if f.Snapshot || f.Mark != 0 || !strings.HasPrefix(string(f.Data), "before") {
		t.Fatalf("since-0 frame %+v", f)
	}
}

func TestSubscriberEndsWithThePane(t *testing.T) {
	m := newManager(t)
	p := newPane(t, m, Config{Command: []string{"/bin/sh", "-c", "echo bye"}})
	s, _ := p.Subscribe(SubOptions{})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var got strings.Builder
	for {
		f, err := s.Next(ctx)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		got.Write(f.Data)
	}
	if !strings.Contains(got.String(), "bye") {
		t.Fatalf("stream %q", got.String())
	}
}

func TestSlowSubscriberIsResynced(t *testing.T) {
	m := newManager(t)
	p := newPane(t, m, Config{Command: []string{"/bin/sh", "-c", "i=0; while [ $i -lt 4000 ]; do echo line-$i-padding-padding-padding; i=$((i+1)); done; echo END; sleep 60"}})
	s, _ := p.Subscribe(SubOptions{Ack: true, Window: MinWindow})
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	f, _ := s.Next(ctx) // the first snapshot; never acknowledged
	_ = f
	waitText(t, p, `END`, 0)
	// It fell behind: the next frame is a fresh snapshot showing the end.
	s.Ack(1 << 30)
	f, err := s.Next(ctx)
	if err != nil || !f.Snapshot || !strings.Contains(string(f.Data), "END") {
		t.Fatalf("after falling behind: %v snapshot=%v", err, f.Snapshot)
	}
	if st := s.Stats(); st.Resyncs == 0 {
		t.Fatalf("stats %+v", st)
	}
}

func TestLogCapAndRead(t *testing.T) {
	m := newManager(t)
	m.o.LogCap = 64 << 10
	p := newPane(t, m, Config{Command: []string{"/bin/sh", "-c", "i=0; while [ $i -lt 5000 ]; do echo log-line-$i; i=$((i+1)); done; echo DONE; sleep 60"}})
	waitText(t, p, `DONE`, 0)
	end := p.Mark()
	if end < 64<<10 {
		t.Fatalf("only %d bytes of output", end)
	}
	data, from, gotEnd, err := p.Read(0, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if from == 0 || gotEnd != end || from+uint64(len(data)) != end {
		t.Fatalf("read from 0: from %d len %d end %d (total %d)", from, len(data), gotEnd, end)
	}
	if kept := end - from; kept < 32<<10 || kept > 64<<10 {
		t.Fatalf("log keeps %d bytes, want between half the cap and the cap", kept)
	}
	if !strings.HasSuffix(string(data), "DONE\r\n") {
		t.Fatalf("log tail %q", data[max(0, len(data)-20):])
	}
	// A read inside the kept range returns exactly that range.
	mid := end - 1000
	data, from, _, _ = p.Read(mid, 100)
	if from != mid || len(data) != 100 {
		t.Fatalf("mid read from %d len %d", from, len(data))
	}
	fi, err := os.Stat(filepath.Join(m.o.LogDir, p.ID()+".log"))
	if err != nil || fi.Size() > 32<<10 {
		t.Fatalf("log file %v %v", err, fi)
	}
}

func TestStripper(t *testing.T) {
	var s stripper
	in := "a\x1b[1;31mb\x1b[0m\r\nc\x1b]0;title\x07d\x1b]8;;http://x\x1b\\e\x1bPdcs\x1b\\f\x1b(Bg\x1b"
	out := s.append(nil, []byte(in))
	out = s.append(out, []byte("[2Jh"))
	if string(out) != "ab\ncdefgh" {
		t.Fatalf("stripped %q", out)
	}
}

// A pane never carries another terminal's names for its own tab: a daemon
// started from a cmux tab handed CMUX_SURFACE_ID to its panes (2026-11-07).
func TestPaneEnvLeavesOuterTerminalsOut(t *testing.T) {
	base := []string{"HOME=/h", "PATH=/usr/bin", "CLAUDECODE=1", "CLAUDE_CODE_CHILD_SESSION=1", "LC_CTYPE=UTF-8", "CMUX_SURFACE_ID=E0F8", "CMUX_WORKSPACE_ID=187D", "ITERM_SESSION_ID=w0t0p0:x", "REX_BLOCK=block:y", "TMUX=/tmp/t,1,0", "TERM_PROGRAM=ghostty", "TERM_PROGRAM_VERSION=1.3", "RAVENRY_PANE=pold", "LANG=en_US.UTF-8"}
	env := paneEnv(base, map[string]string{"FOO": "bar"}, "pnew0001", "/run/x.sock")
	got := map[string]string{}
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		got[k] = v
	}
	for _, k := range []string{"CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CMUX_SURFACE_ID", "CMUX_WORKSPACE_ID", "ITERM_SESSION_ID", "REX_BLOCK", "TMUX", "TERM_PROGRAM_VERSION"} {
		if _, ok := got[k]; ok {
			t.Errorf("%s reached the pane", k)
		}
	}
	if got["TERM_PROGRAM"] != "ravenry" || got["RAVENRY_PANE"] != "pnew0001" || got["HOME"] != "/h" || got["LANG"] != "en_US.UTF-8" || got["LC_CTYPE"] != "UTF-8" || got["FOO"] != "bar" {
		t.Errorf("env %v", got)
	}
}

// With no $SHELL (launchd gives its agents none), a pane's shell is the
// account's login shell, not /bin/sh, so its shell integration draws the
// prompt a session waits for (2026-11-07: a 4 s wait at every start).
func TestLoginShellWithoutSHELL(t *testing.T) {
	sh := loginShell(nil, []string{"HOME=/h", "PATH=/usr/bin:/bin"})
	if !strings.HasPrefix(sh, "/") {
		t.Fatalf("login shell %q", sh)
	}
	if acct := accountShell(); acct != "" && sh != acct {
		t.Fatalf("login shell %q, account shell %q", sh, acct)
	}
	if got := loginShell(nil, []string{"SHELL=/bin/bash"}); got != "/bin/bash" {
		t.Fatalf("$SHELL first: %q", got)
	}
}
