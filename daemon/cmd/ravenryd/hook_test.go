package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
)

// hook runs `ravenryd hook` as an assistant does: the event's JSON on its
// standard input, in the pane's environment.
func (e *env) hook(pane, socket, input string, args ...string) (string, string, int, time.Duration) {
	e.t.Helper()
	c := e.cmd("0.1.0", append([]string{"hook"}, args...)...)
	if pane != "" {
		c.Env = append(c.Env, "RAVENRY_PANE="+pane)
	}
	if socket != "" {
		c.Env = append(c.Env, "RAVENRY_SOCKET="+socket)
	}
	c.Stdin = strings.NewReader(input)
	var out, errb bytes.Buffer
	c.Stdout, c.Stderr = &out, &errb
	start := time.Now()
	err := c.Run()
	took := time.Since(start)
	code := 0
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code = ee.ExitCode()
	} else if err != nil {
		e.t.Fatalf("hook: %v", err)
	}
	return out.String(), errb.String(), code, took
}

func agentOf(t *testing.T, e *env, id string) *proto.AgentStatus {
	t.Helper()
	rows := jsonOut[[]struct {
		Pane  string             `json:"pane"`
		Agent *proto.AgentStatus `json:"agent"`
	}](t, e.ok("0.1.0", "agents", "--json"))
	for _, r := range rows {
		if r.Pane == id {
			return r.Agent
		}
	}
	t.Fatalf("pane %s not listed", id)
	return nil
}

func TestHook(t *testing.T) {
	e := newEnv(t)
	e.serve("0.1.0")
	sock := filepath.Join(e.dir, "run", "ravenryd-0.1.0.sock")
	id := jsonOut[proto.PaneResult](t, e.ok("0.1.0", "new", "--json", "--", "/bin/sh", "-c", "exec cat")).Pane.ID

	quiet := func(what, out, errs string, code int) {
		t.Helper()
		if out != "" || code != 0 {
			t.Fatalf("%s: the hook must print nothing and exit 0, got %d %q %q", what, code, out, errs)
		}
	}

	// Claude Code's events set the pane's agent state.
	out, errs, code, _ := e.hook(id, sock, `{"session_id":"s-claude-1","hook_event_name":"SessionStart","source":"startup","cwd":"/tmp"}`, "--assistant", "claude")
	quiet("SessionStart", out, errs, code)
	if a := agentOf(t, e, id); a == nil || a.State != "idle" || a.Assistant != "claude" || a.Session != "s-claude-1" {
		t.Fatalf("after SessionStart: %+v", a)
	}
	out, errs, code, _ = e.hook(id, sock, `{"session_id":"s-claude-1","hook_event_name":"UserPromptSubmit","prompt":"hi"}`, "--assistant", "claude")
	quiet("UserPromptSubmit", out, errs, code)
	if a := agentOf(t, e, id); a.State != "working" {
		t.Fatalf("after UserPromptSubmit: %+v", a)
	}
	out, errs, code, _ = e.hook(id, sock, `{"session_id":"s-claude-1","hook_event_name":"Notification","notification_type":"permission_prompt","message":"Claude needs your\npermission to use Bash"}`, "--assistant", "claude")
	quiet("Notification", out, errs, code)
	if a := agentOf(t, e, id); a.State != "needs_you" || a.Need == nil || a.Need.Kind != "permission" || a.Need.Message != "Claude needs your permission to use Bash" {
		t.Fatalf("after a permission prompt: %+v", a)
	}

	// Stop with no decider connected (the hub is down): go on at once.
	stop := `{"session_id":"s-claude-1","hook_event_name":"Stop","last_assistant_message":"Done.","stop_hook_active":false}`
	out, errs, code, took := e.hook(id, sock, stop, "--assistant", "claude")
	quiet("Stop without a decider", out, errs, code)
	if took > time.Second {
		t.Fatalf("Stop without a decider took %v", took)
	}
	if a := agentOf(t, e, id); a.State != "idle" || a.Event != "Stop" {
		t.Fatalf("after Stop: %+v", a)
	}

	// A decider (the hub) that holds the session.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	hub, err := client.Dial(ctx, sock, client.Options{Name: "test-hub"})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	if err := hub.Call(ctx, "agent.decisions", nil, nil); err != nil {
		t.Fatal(err)
	}
	mode := make(chan string, 1)
	mode <- "block"
	asked := make(chan proto.AgentReport, 100)
	go func() {
		m := "block"
		for ev := range hub.Events() {
			select {
			case m = <-mode:
			default:
			}
			if ev.Event != "agent.decision" {
				continue
			}
			asked <- *ev.Report
			params := map[string]any{"request": *ev.Request}
			switch m {
			case "block":
				params["reply"] = map[string]any{"stdout": `{"decision":"block","reason":"Hand off now."}` + "\n"}
			case "exit2":
				params["reply"] = map[string]any{"stderr": "held", "exit_code": 2}
			case "silent":
				continue
			}
			hub.Call(ctx, "agent.decide", params, nil)
		}
	}()

	out, errs, code, _ = e.hook(id, sock, stop, "--assistant", "claude")
	if code != 0 || out != `{"decision":"block","reason":"Hand off now."}`+"\n" {
		t.Fatalf("held Stop: %d %q %q", code, out, errs)
	}
	got := <-asked
	if got.Event != "Stop" || got.Pane != id || !bytes.Contains(got.Data, []byte(`"last_assistant_message":"Done."`)) {
		t.Fatalf("the decider was asked about %+v", got)
	}

	// The round trip of a decision: the hook process, the daemon, the
	// decider and back.
	var times []time.Duration
	for i := 0; i < 20; i++ {
		_, _, _, took := e.hook(id, sock, stop, "--assistant", "claude")
		<-asked
		times = append(times, took)
	}
	sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
	fmt.Printf("MEASURE hook decision round trip (ravenryd hook process start to exit, through the daemon and a decider): median %v, p95 %v, max %v over %d runs\n",
		times[len(times)/2].Round(10*time.Microsecond), times[len(times)*95/100].Round(10*time.Microsecond), times[len(times)-1].Round(10*time.Microsecond), len(times))
	// The same over the protocol alone, without starting a process.
	cli, err := client.Dial(ctx, sock, client.Options{Name: "test-hook"})
	if err != nil {
		t.Fatal(err)
	}
	defer cli.Close()
	times = times[:0]
	for i := 0; i < 50; i++ {
		start := time.Now()
		var r proto.AgentReportResult
		if err := cli.Call(ctx, "agent.report", map[string]any{"pane": id, "assistant": "claude", "event": "Stop", "state": "idle", "decide": true}, &r); err != nil || r.Reply == nil {
			t.Fatalf("decide: %v %+v", err, r)
		}
		times = append(times, time.Since(start))
		<-asked
	}
	sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
	fmt.Printf("MEASURE agent.report decision round trip over the socket (client, daemon, decider, back): median %v, p95 %v over %d\n",
		times[len(times)/2].Round(time.Microsecond), times[len(times)*95/100].Round(time.Microsecond), len(times))

	// A decider that answers with an exit status and standard error.
	mode <- "exit2"
	out, errs, code, _ = e.hook(id, sock, stop, "--assistant", "claude")
	<-asked
	if code != 2 || errs != "held" || out != "" {
		t.Fatalf("exit 2 reply: %d %q %q", code, out, errs)
	}
	// A decider that never answers: the hook goes on when its time is up.
	mode <- "silent"
	out, errs, code, took = e.hook(id, sock, stop, "--assistant", "claude", "--timeout", "300ms")
	<-asked
	quiet("Stop with a silent decider", out, errs, code)
	if took < 300*time.Millisecond || took > 2*time.Second {
		t.Fatalf("a silent decider held the hook %v", took)
	}
	// Other events do not ask the decider.
	out, errs, code, _ = e.hook(id, sock, `{"session_id":"s-claude-1","hook_event_name":"UserPromptSubmit","prompt":"go on"}`, "--assistant", "claude")
	quiet("UserPromptSubmit with a decider", out, errs, code)
	select {
	case r := <-asked:
		t.Fatalf("UserPromptSubmit asked the decider: %+v", r)
	case <-time.After(100 * time.Millisecond):
	}
	hub.Close()

	// Codex's approval.
	out, errs, code, _ = e.hook(id, sock, `{"session_id":"s-codex-1","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"ls -la"}}`, "--assistant", "codex")
	quiet("Codex PermissionRequest", out, errs, code)
	if a := agentOf(t, e, id); a.State != "needs_you" || a.Assistant != "codex" || a.Need.Message != "Run ls -la" {
		t.Fatalf("after Codex's PermissionRequest: %+v", a)
	}
	// Any other assistant names its states itself.
	out, errs, code, _ = e.hook(id, sock, `{"session_id":"g1","hook_event_name":"BeforeAgent"}`, "--assistant", "gemini", "--state", "working")
	quiet("generic assistant", out, errs, code)
	if a := agentOf(t, e, id); a.State != "working" || a.Assistant != "gemini" {
		t.Fatalf("generic: %+v", a)
	}

	// Outside a pane, without a daemon, or with input that is not JSON:
	// nothing to do, and the session goes on.
	out, errs, code, _ = e.hook("", "", stop, "--assistant", "claude")
	quiet("outside a pane", out, errs, code)
	out, errs, code, took = e.hook(id, filepath.Join(e.dir, "run", "nobody.sock"), stop, "--assistant", "claude")
	quiet("no daemon", out, errs, code)
	if took > time.Second {
		t.Fatalf("no daemon took %v", took)
	}
	out, errs, code, _ = e.hook(id, sock, "not json", "--assistant", "claude")
	quiet("not JSON", out, errs, code)
	out, errs, code, _ = e.hook(id, sock, stop, "--assistant", "Bad Name")
	if out != "" || code != 0 || !strings.Contains(errs, "--assistant") {
		t.Fatalf("bad assistant: %d %q %q", code, out, errs)
	}

	// reports lists what was recorded, and agents shows the pane.
	lines := strings.Split(strings.TrimSpace(e.ok("0.1.0", "reports", id)), "\n")
	if len(lines) < 10 || !strings.Contains(lines[0], "SessionStart") {
		t.Fatalf("reports:\n%s", strings.Join(lines, "\n"))
	}
	if out := e.ok("0.1.0", "agents"); !strings.Contains(out, id) || !strings.Contains(out, "gemini") {
		t.Fatalf("agents:\n%s", out)
	}
}
