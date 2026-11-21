package agent

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestHookData(t *testing.T) {
	keep := func(in string) map[string]any {
		t.Helper()
		b := HookData([]byte(in))
		if b == nil {
			return nil
		}
		if again := HookData(b); string(again) != string(b) {
			t.Fatalf("not idempotent:\n%s\n%s", b, again)
		}
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	m := keep(`{"session_id":"s","hook_event_name":"UserPromptSubmit","cwd":"/w","transcript_path":"/t","permission_mode":"default","prompt":"secret"}`)
	if len(m) != 4 || m["session_id"] != "s" || m["cwd"] != "/w" || m["transcript_path"] != "/t" || m["prompt"] != nil {
		t.Fatalf("UserPromptSubmit: %v", m)
	}
	m = keep(`{"session_id":"s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"x"},"tool_response":"y","tool_use_id":"u"}`)
	if len(m) != 3 || m["tool_name"] != "Bash" {
		t.Fatalf("PreToolUse: %v", m)
	}
	m = keep(`{"session_id":"s","hook_event_name":"Notification","notification_type":"permission_prompt","message":"Claude needs your\npermission to use Bash","title":"Claude Code"}`)
	if m["message"] != "Claude needs your permission to use Bash" || m["title"] != "Claude Code" || m["notification_type"] != "permission_prompt" {
		t.Fatalf("Notification: %v", m)
	}
	// Antigravity CLI's camelCase fields (1.5.14, measured), under the
	// board's names; its prompt and tool call never.
	m = keep(`{"hookEventName":"Stop","conversationId":"0f0f0f0f-0000-4000-8000-0000000000a1","cwd":"/w","transcriptPath":"/t/transcript_full.jsonl","modelName":"gemini-3.8-flash-high","lastUserInput":"secret","toolCall":{"name":"run_command"},"workspacePaths":["/w"],"terminationReason":"NO_TOOL_CALL"}`)
	if len(m) != 5 || m["hook_event_name"] != "Stop" || m["session_id"] != "0f0f0f0f-0000-4000-8000-0000000000a1" || m["transcript_path"] != "/t/transcript_full.jsonl" || m["model"] != "gemini-3.8-flash-high" || m["cwd"] != "/w" {
		t.Fatalf("camelCase: %v", m)
	}
	// A snake_case field already there wins.
	if m = keep(`{"session_id":"s","conversationId":"c","hook_event_name":"Stop"}`); m["session_id"] != "s" {
		t.Fatalf("snake_case first: %v", m)
	}
	// A message is kept only for a notification.
	if m = keep(`{"session_id":"s","hook_event_name":"SessionStart","source":"startup","model":"claude-opus-5-5","message":"x"}`); m["message"] != nil || m["source"] != "startup" || m["model"] != "claude-opus-5-5" {
		t.Fatalf("SessionStart: %v", m)
	}

	stop := func(last string) any {
		in, _ := json.Marshal(map[string]any{"session_id": "s", "hook_event_name": "Stop", "last_assistant_message": last})
		return keep(string(in))["last_assistant_message"]
	}
	for _, c := range []struct{ in, want string }{
		{"Done. Shall I push it?", "Done. Shall I push it?"},
		{"I read the key abc123.\n\nShall I push it?", "Shall I push it?"},
		{"Is it ok?\n\nDone, pushed.", ""},
		{"Done.", ""},
		{"Hand-off deferred: not at a clean point.\nThe tests still run.", "Hand-off deferred: not at a clean point."},
		{"", ""},
	} {
		if got := stop(c.in); got != c.want {
			t.Fatalf("last message %q: got %q, want %q", c.in, got, c.want)
		}
	}
	long := strings.Repeat("é", 3000) + " ok?"
	if got := stop(long).(string); len(got) > 2000 || !strings.HasSuffix(got, " ok?") || !strings.HasPrefix(got, "é") {
		t.Fatalf("a long paragraph keeps its end: %d bytes", len(got))
	}
	m = keep(`{"session_id":"s","hook_event_name":"Stop","stop_hook_active":true,"background_tasks":[{"id":"b1","type":"subagent","status":"running","agent_type":"Explore","description":"secret","prompt":"secret"},"x"],"session_crons":[{"id":"c1","prompt":"secret"},{}]}`)
	b, _ := json.Marshal(m)
	if strings.Contains(string(b), "secret") || m["stop_hook_active"] != true ||
		!strings.Contains(string(b), `"background_tasks":[{"agent_type":"Explore","id":"b1","status":"running","type":"subagent"}]`) ||
		!strings.Contains(string(b), `"session_crons":[{"id":"c1"},{}]`) {
		t.Fatalf("Stop: %s", b)
	}
	if HookData([]byte(`[1]`)) != nil || HookData([]byte(`{"prompt":"x"}`)) != nil {
		t.Fatal("nothing to keep: nil")
	}
}
