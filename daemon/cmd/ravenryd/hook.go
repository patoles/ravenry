package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"time"

	"ravenryd/internal/agent"
	"ravenryd/internal/client"
	"ravenryd/internal/pane"
	"ravenryd/internal/proto"
)

// ravenryd hook: the command an assistant's hooks run (Claude Code's
// settings.json, Codex's hooks.json, or any assistant that runs a command
// with a JSON object on its standard input). It reports the event to the
// daemon of the pane the assistant runs in, and for the events that may
// be held (the Stop of a turn, for the hand-off) it waits a short while
// for a decider, the hub, to say what the hook answers.
//
// It forwards only what the agent's status and the hub's hand-off need
// (agent.HookData): the prompt, tool inputs and outputs and the rest of
// the hook's input never leave it.
//
// It never holds a session: without a pane (RAVENRY_PANE, RAVENRY_SOCKET),
// without a daemon, without a decider, on any error, or when its time is
// up, it exits 0 and prints nothing, which every assistant takes as "go
// on". It writes to standard output and error, and exits with another
// status, only when a decider replied.

const hookUsage = `usage: ravenryd hook --assistant NAME [--state STATE [--need KIND]]
                     [--event NAME] [--decide] [--timeout 2s]

  --assistant  claude, codex, or any name (a-z, 0-9, ., _, -)
  --state      working, needs_you, idle or ended: the state this event
               puts the agent in, for assistants ravenryd has no table for
  --need       with --state needs_you: permission, question, auth or other
  --event      the event's name, when the input has no hook_event_name
  --decide     ask the decider (the hub) what to answer; Claude Code's
               and Codex's Stop always ask
  --timeout    how long to wait for the decider (default 2s, at most 60s)
`

// maxHookInput caps what the hook reads from its standard input.
const maxHookInput = 4 << 20

// hookSpec is what an event means for the agent's state.
type hookSpec struct {
	state  string
	need   string
	decide bool
}

func cmdHook(in []string) error {
	a, err := parse(in, specOf("hook"))
	if err != nil {
		return hookGiveUp(err)
	}
	assistant := a.values["assistant"]
	if !regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,31}$`).MatchString(assistant) {
		return hookGiveUp(fmt.Errorf("--assistant is required: claude, codex or another name\n%s", hookUsage))
	}
	timeout := 2 * time.Second
	if v := a.values["timeout"]; v != "" {
		d, err := duration(v)
		if err != nil || d <= 0 || d > 60*time.Second {
			return hookGiveUp(fmt.Errorf("--timeout must be between 1ms and 60s"))
		}
		timeout = d
	}
	// Whatever happens, the session goes on in time.
	hard := time.AfterFunc(timeout+3*time.Second, func() { os.Exit(0) })
	defer hard.Stop()

	raw, _ := io.ReadAll(io.LimitReader(os.Stdin, maxHookInput))
	var input map[string]any
	if json.Unmarshal(bytes.TrimSpace(raw), &input) != nil || input == nil {
		return nil // not a hook's input: nothing to report
	}
	agent.CamelAliases(input)
	event := a.values["event"]
	if event == "" {
		event, _ = input["hook_event_name"].(string)
	}
	paneID, socket := os.Getenv("RAVENRY_PANE"), a.g.socket
	if socket == "" {
		socket = os.Getenv("RAVENRY_SOCKET")
	}
	if event == "" || socket == "" || (paneID == "" && a.g.socket == "") {
		return nil // not in a ravenryd pane
	}
	spec := hookSpecFor(assistant, event, input)
	if v := a.values["state"]; v != "" {
		spec.state, spec.need = v, a.values["need"]
	}
	if a.bools["decide"] {
		spec.decide = true
	}

	params := map[string]any{"assistant": assistant, "event": clipString(event, 64)}
	if paneID != "" && !(assistant == "codex" && codexAppServer(os.Getppid())) {
		// Codex's shared app-server runs many sessions with the
		// environment of the pane that started it: its pane is unknown.
		params["pane"] = paneID
	}
	if s, ok := input["session_id"].(string); ok && s != "" { // also Antigravity CLI's conversationId
		params["session"] = clipString(s, 200)
	}
	if s, ok := input["cwd"].(string); ok && s != "" && len(s) <= 4096 {
		params["cwd"] = s
	}
	if ppid := os.Getppid(); ppid > 1 {
		params["pid"] = ppid
	}
	if spec.state != "" {
		params["state"] = spec.state
	}
	msg := hookMessage(assistant, event, input)
	if msg != "" {
		params["message"] = clipString(msg, 1000)
	}
	if spec.state == "needs_you" {
		kind := spec.need
		if kind == "" {
			kind = "other"
		}
		need := map[string]any{"kind": kind}
		if msg != "" {
			need["message"] = clipString(msg, 1000)
		}
		params["need"] = need
	}
	// Only the fields the status and the hand-off read: never the
	// prompt, a tool's input or output, or what the assistant wrote
	// beyond the question its turn ended on.
	if data := agent.HookData(raw); data != nil {
		params["data"] = json.RawMessage(data)
	}
	if spec.decide {
		params["decide"] = true
		params["timeout_ms"] = timeout.Milliseconds()
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout+2*time.Second)
	defer cancel()
	c, err := client.Dial(ctx, socket, client.Options{Name: "ravenryd-hook", Version: version})
	if err != nil {
		return nil // no daemon: go on
	}
	defer c.Close()
	var res proto.AgentReportResult
	if err := c.Call(ctx, "agent.report", params, &res); err != nil {
		return nil
	}
	if res.Reply == nil {
		return nil
	}
	os.Stdout.WriteString(res.Reply.Stdout)
	os.Stderr.WriteString(res.Reply.Stderr)
	if res.Reply.ExitCode != 0 {
		return exitCode(res.Reply.ExitCode)
	}
	return nil
}

// hookGiveUp says what is wrong on standard error and lets the session go
// on: a broken hook command must not stop an assistant.
func hookGiveUp(err error) error {
	fmt.Fprintf(os.Stderr, "ravenryd hook: %v\n", err)
	return exitCode(0)
}

// hookSpecFor is what each event of Claude Code and Codex means. Events
// not listed are recorded without changing the state. Every other
// assistant (the hub's registry, hub/server/assistants.mjs, `hooks:
// 'state'`) says its state in its hook command with --state and --need,
// and needs no table here.
func hookSpecFor(assistant, event string, in map[string]any) hookSpec {
	str := func(k string) string { s, _ := in[k].(string); return s }
	switch assistant {
	case "claude":
		switch event {
		case "SessionStart":
			if str("source") == "compact" {
				return hookSpec{} // compaction can happen mid-turn
			}
			return hookSpec{state: "idle"}
		case "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure":
			return hookSpec{state: "working"}
		case "Notification":
			switch str("notification_type") {
			case "permission_prompt":
				return hookSpec{state: "needs_you", need: "permission"}
			case "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input":
				return hookSpec{state: "needs_you", need: "question"}
			case "idle_prompt":
				return hookSpec{state: "idle"}
			}
		case "Stop":
			return hookSpec{state: "idle", decide: true}
		case "SessionEnd":
			return hookSpec{state: "ended"}
		}
	case "codex":
		switch event {
		case "SessionStart":
			if str("source") == "compact" {
				return hookSpec{}
			}
			return hookSpec{state: "idle"}
		case "UserPromptSubmit", "PreToolUse", "PostToolUse":
			return hookSpec{state: "working"}
		case "PermissionRequest":
			return hookSpec{state: "needs_you", need: "permission"}
		case "Stop":
			return hookSpec{state: "idle", decide: true}
		case "Interrupt":
			return hookSpec{state: "idle"}
		case "SessionEnd":
			return hookSpec{state: "ended"}
		}
	}
	return hookSpec{}
}

// hookMessage is one line for people: what a notification says, or what
// a Codex approval is about.
func hookMessage(assistant, event string, in map[string]any) string {
	if event == "Notification" {
		s, _ := in["message"].(string)
		return agent.OneLine(s)
	}
	if assistant == "codex" && event == "PermissionRequest" {
		ti, _ := in["tool_input"].(map[string]any)
		if s, _ := ti["description"].(string); s != "" {
			return agent.OneLine(s)
		}
		if s, _ := ti["command"].(string); s != "" {
			return agent.OneLine("Run " + s)
		}
		if s, _ := in["tool_name"].(string); s != "" {
			return "Codex asks to use " + agent.OneLine(s)
		}
		return "Codex asks to use a tool"
	}
	return ""
}

func clipString(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && s[n]&0xc0 == 0x80 {
		n--
	}
	return s[:n]
}

// codexAppServer reports whether pid is Codex's shared app-server.
func codexAppServer(pid int) bool {
	pr, err := pane.ProcessInfo(pid)
	if err != nil {
		return false
	}
	for _, a := range pr.Argv[min(1, len(pr.Argv)):] {
		if a == "app-server" {
			return true
		}
	}
	return false
}
