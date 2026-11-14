package server

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/pane"
	"ravenryd/internal/proto"
)

// TestZshMoreMark checks zsh's ">...." row: zsh draws it on its first
// row when the command line is taller than the screen (its start is
// above the screen). In a fresh pane as short as the command line is
// tall, with no resize at all, the daemon's screen shows it: it is zsh's,
// as in any terminal. Once the pane is tall enough for the whole command
// line, it is gone from the screen and the scrollback, whether the pane
// was short from the start or made short by a resize.
func TestZshMoreMark(t *testing.T) {
	zsh, err := exec.LookPath("zsh")
	if err != nil {
		t.Skip("no zsh")
	}
	shells := filepath.Join(t.TempDir(), "shell")
	d := startDaemon(t, func(o *pane.ManagerOptions) {
		o.ShellDir = shells
		o.Env = append(o.Env, "SHELL="+zsh)
	})
	os.WriteFile(filepath.Join(d.home, ".zshenv"), []byte("skip_global_compinit=1\n"), 0o600)
	os.WriteFile(filepath.Join(d.home, ".zshrc"), []byte("PROMPT='~ > '\n"), 0o600)
	c := d.dial(client.Options{})
	// A pasted note like the one in the screenshot: 12 lines, two of
	// them wider than the screen.
	pasted := strings.Join([]string{
		" Next build of the native app.",
		" It draws the daemon's screen itself.",
		" Please compare it with the last one:",
		" 1. Resize the window by dragging its edge.",
		" 2. Type a little.",
		" 3. Run something with a lot of output, for example seq 1 200000.",
		"",
		" What it is: a plain Mac window with no web page inside. The app draws the terminal and handles resizing itself. Ravenry's background process still owns",
		" the session, through a new connector command that both sides use. That connector is shared code, so future Linux or Windows versions reuse it.",
		" One more line.",
		" And the last one.",
		" end of note",
	}, "\n")
	const cols, short, tall = 133, 10, 40
	type view struct {
		screen []string
		all    []string
	}
	read := func(id string) view {
		cap := call[proto.CaptureResult](t, c, "pane.capture", map[string]any{"pane": id, "history": 10000})
		var v view
		for i, l := range cap.Lines {
			v.all = append(v.all, strings.TrimRight(l.Text, " "))
			if i >= cap.History {
				v.screen = append(v.screen, strings.TrimRight(l.Text, " "))
			}
		}
		return v
	}
	count := func(rows []string) int {
		n := 0
		for _, r := range rows {
			n += strings.Count(r, ">....")
		}
		return n
	}
	start := func(rows int) (proto.Pane, *renderClient) {
		p := newPane(t, c, map[string]any{"cols": cols, "rows": rows, "cwd": d.home})
		st, err := c.Render(ctx(t), p.ID, client.RenderOptions{FPS: 120})
		if err != nil {
			t.Fatal(err)
		}
		r := &renderClient{t: t, st: st}
		r.until("~ >")
		time.Sleep(300 * time.Millisecond)
		if err := st.Events(ctx(t), []proto.RenderEvent{{Paste: &pasted}}); err != nil {
			t.Fatal(err)
		}
		r.until("end of note")
		time.Sleep(500 * time.Millisecond)
		for r.next(50*time.Millisecond) != nil {
		}
		return p, r
	}
	resize := func(p proto.Pane, r *renderClient, rows int) {
		call[map[string]any](t, c, "pane.resize", map[string]any{"pane": p.ID, "cols": cols, "rows": rows})
		time.Sleep(600 * time.Millisecond)
		for r.next(50*time.Millisecond) != nil {
		}
	}

	// 1. A fresh pane 10 rows high, never resized: zsh draws ">....".
	p, r := start(short)
	v := read(p.ID)
	t.Logf("fresh %dx%d:\n%s", cols, short, strings.Join(v.screen, "\n"))
	if !strings.HasPrefix(v.screen[0], "~ > >....") || count(v.all) != 1 {
		t.Errorf("a fresh short pane: want zsh's \"~ > >....\" on the first row, once; got %d:\n%s", count(v.all), strings.Join(v.all, "\n"))
	}
	if got := strings.Join(r.scr.Text(), "\n"); !strings.HasPrefix(got, "~ > >....") {
		t.Errorf("the render client's screen:\n%s", got)
	}
	// Made tall enough for the whole command line: gone.
	resize(p, r, tall)
	v = read(p.ID)
	t.Logf("then %dx%d:\n%s", cols, tall, strings.Join(v.all, "\n"))
	if n := count(v.all); n != 0 {
		t.Errorf("tall again: %d \">....\" rows left", n)
	}

	// 2. A tall pane made short, then tall again.
	p, r = start(tall)
	if n := count(read(p.ID).all); n != 0 {
		t.Errorf("a fresh tall pane: %d \">....\" rows", n)
	}
	resize(p, r, short)
	v = read(p.ID)
	t.Logf("tall made %dx%d:\n%s", cols, short, strings.Join(v.screen, "\n"))
	if !strings.HasPrefix(v.screen[0], "~ > >....") || count(v.all) != 1 {
		t.Errorf("made short: want \"~ > >....\" on the first row, once; got %d:\n%s", count(v.all), strings.Join(v.all, "\n"))
	}
	// Scrolled up from the prompt, the start of the command line is
	// there once: the scrollback and the screen read in order are the
	// prompt and the command line, with zsh's ">...." row only as the
	// screen's first.
	if err := oneCopy(v.all, len(v.all)-len(v.screen), "~ > ", pasted); err != nil {
		t.Errorf("made short: %v\n%s", err, strings.Join(v.all, "\n"))
	}
	resize(p, r, tall)
	v = read(p.ID)
	if n := count(v.all); n != 0 {
		t.Errorf("tall again after short: %d \">....\" rows left:\n%s", n, strings.Join(v.all, "\n"))
	}
	if err := oneCopy(v.all, len(v.all)-len(v.screen), "~ > ", pasted); err != nil {
		t.Errorf("tall again: %v\n%s", err, strings.Join(v.all, "\n"))
	}
	if got := strings.Join(r.scr.Text(), "\n"); strings.Contains(got, ">....") {
		t.Errorf("the render client's screen keeps \">....\":\n%s", got)
	}
}

// oneCopy checks a pane's rows, scrollback then screen (the screen from
// row history), against a prompt and its command line: read in order,
// they are the prompt and the command line once, whitespace aside, with
// nothing else; zsh's ">...." mark may be on the screen's first row
// only, where it stands for the rows above it.
func oneCopy(rows []string, history int, prompt, command string) error {
	flat := func(s string) string { return strings.Join(strings.Fields(s), "") }
	whole := flat(prompt + command)
	var got strings.Builder
	for i, row := range rows {
		f := flat(row)
		if strings.Contains(f, ">....") {
			if i != history || !strings.HasSuffix(f, ">....") {
				return fmt.Errorf("a \">....\" row at %d (the screen starts at %d): %q", i, history, row)
			}
			f = strings.TrimSuffix(f, ">....")
			if f != flat(prompt) {
				return fmt.Errorf("the \">....\" row is not the prompt's: %q", row)
			}
			continue
		}
		got.WriteString(f)
	}
	if g := got.String(); g != whole {
		i := 0
		for i < len(g) && i < len(whole) && g[i] == whole[i] {
			i++
		}
		return fmt.Errorf("not the command line once: they differ at %d of %d: %q, want %q", i, len(whole), g[i:min(len(g), i+60)], whole[i:min(len(whole), i+60)])
	}
	return nil
}
