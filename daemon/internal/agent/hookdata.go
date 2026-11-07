package agent

import (
	"encoding/json"
	"regexp"
	"strings"
)

// HookData keeps, of a hook's input (a JSON object), only what the agent
// status and the hub's hand-off read, so a report never carries what a
// person typed or what a tool saw: no prompt, no tool input or output, no
// assistant text beyond the question a turn ended on. It returns the kept
// fields as a JSON object, or nil when the input is not an object or
// nothing is kept.
//
// Kept, when present and of the right type:
//
//   - every event: hook_event_name, session_id, cwd, transcript_path,
//     agent_id, source, reason, notification_type, tool_name, model and
//     stop_hook_active
//   - Notification: message and title, one line each (what the
//     assistant asks of a person, such as a permission)
//   - Stop: last_assistant_message cut to the hand-off's marker line
//     ("Hand-off deferred: ...") or to its last paragraph when that
//     asks a question (at most 2000 bytes, its end), else empty;
//     background_tasks as id, type, status and agent_type; session_crons
//     as their ids
//   - PostToolUse: tool_files, the paths of the files the tool wrote
//     (Claude Code's file_path and notebook_path, the files a Codex
//     apply_patch names), at most 64, never their contents
//
// It is idempotent: HookData of its own output gives the same fields.
func HookData(raw []byte) []byte {
	var in map[string]any
	if json.Unmarshal(raw, &in) != nil || in == nil {
		return nil
	}
	out := map[string]any{}
	str := func(k string, max int) {
		if s, ok := in[k].(string); ok && s != "" {
			out[k] = clipEnd(s, max)
		}
	}
	str("hook_event_name", 64)
	str("session_id", 200)
	str("cwd", 4096)
	str("transcript_path", 4096)
	str("agent_id", 200)
	str("source", 64)
	str("reason", 64)
	str("notification_type", 64)
	str("tool_name", 100)
	switch m := in["model"].(type) {
	case string:
		str("model", 200)
	case map[string]any:
		mo := map[string]any{}
		for _, k := range []string{"id", "display_name"} {
			if s, ok := m[k].(string); ok && s != "" {
				mo[k] = clipEnd(s, 200)
			}
		}
		if len(mo) > 0 {
			out["model"] = mo
		}
	}
	if b, ok := in["stop_hook_active"].(bool); ok {
		out["stop_hook_active"] = b
	}
	event, _ := in["hook_event_name"].(string)
	switch event {
	case "PostToolUse":
		if fs := toolFiles(in); len(fs) > 0 {
			out["tool_files"] = fs
		}
	case "Notification":
		for k, max := range map[string]int{"message": 1000, "title": 200} {
			if s, ok := in[k].(string); ok && s != "" {
				out[k] = clipEnd(OneLine(s), max)
			}
		}
	case "Stop", "SubagentStop":
		if s, ok := in["last_assistant_message"].(string); ok {
			out["last_assistant_message"] = endOfTurn(s)
		}
		if ts, ok := in["background_tasks"].([]any); ok {
			kept := []any{}
			for _, t := range ts {
				m, ok := t.(map[string]any)
				if !ok {
					continue
				}
				e := map[string]any{}
				for _, k := range []string{"id", "type", "status", "agent_type"} {
					if s, ok := m[k].(string); ok {
						e[k] = clipEnd(s, 200)
					}
				}
				kept = append(kept, e)
				if len(kept) == 256 {
					break
				}
			}
			out["background_tasks"] = kept
		}
		if cs, ok := in["session_crons"].([]any); ok {
			kept := []any{}
			for _, c := range cs {
				e := map[string]any{}
				if m, ok := c.(map[string]any); ok {
					if s, ok := m["id"].(string); ok {
						e["id"] = clipEnd(s, 200)
					}
				}
				kept = append(kept, e)
				if len(kept) == 256 {
					break
				}
			}
			out["session_crons"] = kept
		}
	}
	if len(out) == 0 {
		return nil
	}
	b, err := json.Marshal(out)
	if err != nil {
		return nil
	}
	return b
}

// maxToolFiles caps the paths kept of one tool use.
const maxToolFiles = 64

// patchFile finds the file lines of an apply_patch patch (Codex).
var patchFile = regexp.MustCompile(`(?m)^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$`)

// toolFiles is the paths a tool use wrote: from tool_input's file_path,
// notebook_path or path, and the file lines of a patch in any of its
// strings. Only paths: the input's contents are dropped. Of HookData's
// own output, tool_files as it is.
func toolFiles(in map[string]any) []any {
	var out []any
	seen := map[string]bool{}
	add := func(p string) {
		p = strings.TrimSpace(p)
		if p == "" || len(p) > 4096 || seen[p] || len(out) == maxToolFiles || strings.ContainsAny(p, "\x00\n\r") {
			return
		}
		seen[p] = true
		out = append(out, p)
	}
	if fs, ok := in["tool_files"].([]any); ok {
		for _, f := range fs {
			if s, ok := f.(string); ok {
				add(s)
			}
		}
		return out
	}
	ti, ok := in["tool_input"].(map[string]any)
	if !ok {
		return nil
	}
	for _, k := range []string{"file_path", "notebook_path", "path"} {
		if s, ok := ti[k].(string); ok {
			add(s)
		}
	}
	var scan func(v any, depth int)
	scan = func(v any, depth int) {
		switch x := v.(type) {
		case string:
			if strings.Contains(x, "*** ") {
				for _, m := range patchFile.FindAllStringSubmatch(x, -1) {
					add(firstOf(m[1], m[2]))
				}
			}
		case []any:
			if depth < 2 {
				for _, e := range x {
					scan(e, depth+1)
				}
			}
		case map[string]any:
			if depth < 2 {
				for _, e := range x {
					scan(e, depth+1)
				}
			}
		}
	}
	scan(ti, 0)
	return out
}

func firstOf(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// handoffMarker starts the line an assistant answers a hand-off it
// defers with (the hub's DEFERRED, hub/server/handoff.mjs).
const handoffMarker = "Hand-off deferred:"

var paragraphBreak = regexp.MustCompile(`\n\s*\n`)

// endOfTurn is what the hub reads of the assistant's last message: the
// hand-off marker line, or the last paragraph when it asks a question
// (the board shows the question a turn ended on), else nothing.
func endOfTurn(s string) string {
	t := strings.TrimSpace(s)
	if strings.HasPrefix(t, handoffMarker) {
		line, _, _ := strings.Cut(t, "\n")
		return clipEnd(strings.TrimSpace(line), 200)
	}
	ps := paragraphBreak.Split(t, -1)
	last := strings.TrimSpace(ps[len(ps)-1])
	if !strings.Contains(last, "?") {
		return ""
	}
	return clipStart(last, 2000)
}

// OneLine folds runs of white space, newlines included, into one space.
func OneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

// clipEnd keeps at most n bytes of s, from its start, on a UTF-8
// boundary.
func clipEnd(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && s[n]&0xc0 == 0x80 {
		n--
	}
	return s[:n]
}

// clipStart keeps at most n bytes of s, from its end, on a UTF-8
// boundary.
func clipStart(s string, n int) string {
	if len(s) <= n {
		return s
	}
	i := len(s) - n
	for i < len(s) && s[i]&0xc0 == 0x80 {
		i++
	}
	return s[i:]
}
