package server

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/pane"
	"ravenryd/internal/proto"
	"ravenryd/internal/testenv"
	"ravenryd/internal/vt"
)

// TestRenderKeybindsZsh: the "macos" key bindings (vt.MacOSKeybinds) at a
// zsh prompt, as a Mac client sends the keys: each combination puts the
// cursor, and leaves the command line, where a Mac person expects.
func TestRenderKeybindsZsh(t *testing.T) {
	zsh, err := exec.LookPath("zsh")
	if err != nil {
		t.Skip("no zsh")
	}
	shells := filepath.Join(t.TempDir(), "shell")
	testenv.CheckDirs(t, shells)
	d := startDaemon(t, func(o *pane.ManagerOptions) {
		o.ShellDir = shells
		o.Env = append(o.Env, "SHELL="+zsh)
	})
	os.WriteFile(filepath.Join(d.home, ".zshenv"), []byte("skip_global_compinit=1\n"), 0o600)
	os.WriteFile(filepath.Join(d.home, ".zshrc"), []byte("PROMPT='~ > '\n"), 0o600)
	c := d.dial(client.Options{})
	p := newPane(t, c, map[string]any{"cols": 80, "rows": 10, "cwd": d.home})
	st, err := c.Render(ctx(t), p.ID, client.RenderOptions{FPS: 120, Keybinds: "macos"})
	if err != nil {
		t.Fatal(err)
	}
	r := &renderClient{t: t, st: st}
	r.until("~ >")
	time.Sleep(300 * time.Millisecond)
	r.settle()

	key := func(code string, mods uint8) proto.RenderEvent {
		return proto.RenderEvent{Key: &proto.RenderKey{Code: code, Mods: int(mods)}}
	}
	const line = "echo one two three"
	// The prompt is "~ > ": column 4 is the command line's first. zsh's
	// forward-word (Esc f, what Option+Right sends) goes to the
	// start of the next word.
	cases := []struct {
		name string
		keys []proto.RenderEvent
		x    int
		text string
	}{
		{"cmd_left_line_start", []proto.RenderEvent{key("ArrowLeft", vt.ModSuper)}, 4, line},
		{"cmd_right_line_end", []proto.RenderEvent{key("ArrowLeft", vt.ModSuper), key("ArrowRight", vt.ModSuper)}, 22, line},
		{"option_left_word", []proto.RenderEvent{key("ArrowLeft", vt.ModAlt), key("ArrowLeft", vt.ModAlt)}, 13, line},
		{"option_right_word", []proto.RenderEvent{key("ArrowLeft", vt.ModSuper), key("ArrowRight", vt.ModAlt)}, 9, line},
		{"cmd_backspace_line", []proto.RenderEvent{key("Backspace", vt.ModSuper)}, 4, ""},
		{"option_backspace_word", []proto.RenderEvent{key("Backspace", vt.ModAlt)}, 17, "echo one two "},
		{"option_delete_word", []proto.RenderEvent{key("ArrowLeft", vt.ModSuper), key("Delete", vt.ModAlt)}, 4, " one two three"},
		{"cmd_delete_line_end", []proto.RenderEvent{key("ArrowLeft", vt.ModAlt), key("Delete", vt.ModSuper)}, 17, "echo one two "},
		{"ctrl_left_word", []proto.RenderEvent{key("ArrowLeft", vt.ModCtrl), key("ArrowLeft", vt.ModCtrl)}, 13, line},
		{"ctrl_right_word", []proto.RenderEvent{key("ArrowLeft", vt.ModSuper), key("ArrowRight", vt.ModCtrl)}, 9, line},
	}
	for _, tc := range cases {
		// A fresh command line: Ctrl+U clears what the last case left.
		clear := "\x15" + line
		if err := st.Events(ctx(t), []proto.RenderEvent{{Text: &clear}}); err != nil {
			t.Fatal(err)
		}
		r.until("~ > " + line)
		r.settle()
		if err := st.Events(ctx(t), tc.keys); err != nil {
			t.Fatal(err)
		}
		time.Sleep(100 * time.Millisecond)
		r.settle()
		got := ""
		for _, l := range r.scr.Text() {
			if strings.HasPrefix(l, "~ > ") {
				got = strings.TrimRight(strings.TrimPrefix(l, "~ > "), " ")
			}
		}
		x := r.scr.Cursor.X
		t.Logf("%s: cursor %d, line %q", tc.name, x, got)
		if x != tc.x || got != strings.TrimRight(tc.text, " ") {
			t.Errorf("%s: cursor at %d with %q, want %d with %q", tc.name, x, got, tc.x, strings.TrimRight(tc.text, " "))
		}
	}
}
