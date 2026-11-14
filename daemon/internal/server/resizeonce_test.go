package server

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
	"ravenryd/internal/testprog"
)

// TestResizeTranscriptOnce resizes a pane whose program draws as Claude
// Code does (testprog's redraw, claude, with a live part taller than the
// screen: RAVENRY_TESTPROG_LIVE), at the sizes of phonefix7's recorded
// resize of a real Claude Code pane (14 Nov: the phone's Flip fold and
// the Mac window both resize), waiting for each redraw. What pane.capture
// reads with its history, which the hub's Live screen and the phone's
// feed are made from, must be the transcript once, in order: before, each
// redraw left a copy of the rows it drew again in the scrollback (a
// taller screen pulls no rows back while the cursor is not on the last
// row; the rows of a frame taller than the screen scroll up once more),
// and the feed showed earlier messages twice.
func TestResizeTranscriptOnce(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	var content strings.Builder
	for i := range 40 {
		fmt.Fprintf(&content, "> message %d sent from the phone\n", i)
		fmt.Fprintf(&content, "* reply %d:", i)
		for j := range 3 + i%6*7 {
			fmt.Fprintf(&content, " r%dw%d", i, j)
		}
		content.WriteString("\n")
	}
	lines := strings.Split(strings.TrimRight(content.String(), "\n"), "\n")
	file := filepath.Join(d.home, "transcript.txt")
	if err := os.WriteFile(file, []byte(content.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	argv, env := testprog.Command("redraw")
	env["RAVENRY_TESTPROG_FILE"] = file
	env["RAVENRY_TESTPROG_REDRAW"] = "claude"
	env["RAVENRY_TESTPROG_LIVE"] = "24"
	p := newPane(t, c, map[string]any{"command": argv, "env": env, "cols": 100, "rows": 30})
	squeeze := func(s string) string { return strings.Join(strings.Fields(s), "") }
	want := squeeze(content.String())
	// read is the capture's text, scrollback and screen, without white
	// space and without the program's footer (its rules, prompt and
	// status line).
	read := func() string {
		cp := call[proto.CaptureResult](t, c, "pane.capture", map[string]any{"pane": p.ID, "history": 100000})
		var b strings.Builder
		for _, l := range cp.Lines {
			x := strings.TrimSpace(l.Text)
			if strings.HasPrefix(x, "─") || x == "❯" || strings.HasPrefix(x, "⏵⏵") {
				continue
			}
			b.WriteString(squeeze(l.Text))
		}
		return b.String()
	}
	settle := func(what string) string {
		deadline := time.Now().Add(5 * time.Second)
		last, since := "", time.Now()
		for time.Now().Before(deadline) {
			got := read()
			if got != last {
				last, since = got, time.Now()
			} else if time.Since(since) > 600*time.Millisecond && strings.HasSuffix(got, squeeze(lines[len(lines)-1])) {
				return got
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("%s: the program did not draw", what)
		return ""
	}
	if got := settle("first draw"); got != want {
		t.Fatalf("first draw: not the transcript")
	}
	for _, sz := range [][2]int{{100, 45}, {80, 45}, {120, 45}, {120, 25}, {100, 40}, {60, 50}, {100, 30}} {
		call[proto.PaneResult](t, c, "pane.resize", map[string]any{"pane": p.ID, "cols": sz[0], "rows": sz[1]})
		got := settle(fmt.Sprintf("%dx%d", sz[0], sz[1]))
		if got != want {
			n := 0
			for _, l := range lines {
				if strings.HasPrefix(l, "> ") {
					n += strings.Count(got, squeeze(l))
				}
			}
			t.Fatalf("after %dx%d the pane's text is not the transcript once: %d characters for %d, the person's 40 messages read %d times", sz[0], sz[1], len(got), len(want), n)
		}
	}
}
