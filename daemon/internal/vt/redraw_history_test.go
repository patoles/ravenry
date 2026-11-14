package vt

import (
	"fmt"
	"strings"
	"testing"
)

// ccLayout lays transcript lines out at cols the way Claude Code does:
// words wrapped, the rows after a line's first indented by two spaces.
func ccLayout(lines []string, cols int) []string {
	var out []string
	for _, l := range lines {
		if l == "" {
			out = append(out, "")
			continue
		}
		row, ind := "", ""
		for _, w := range strings.Fields(l) {
			if row != "" && len(row)+1+len(w) > cols {
				out = append(out, row)
				row, ind = "", "  "
			}
			if row == "" {
				row = ind + w
			} else {
				row += " " + w
			}
		}
		out = append(out, row)
	}
	return out
}

// ccFooter is Claude Code's prompt box and status line under the
// transcript.
func ccFooter(cols int) []string {
	rule := strings.Repeat("-", cols)
	return []string{rule, "> ", rule, "  auto mode on"}
}

// ccRedraw is what Claude Code writes for a full redraw at cols x rows, as
// recorded from the maintainer's panes: in a synchronized update, the
// cursor home, every row erased, then its frame from the top, line after
// line: the transcript from line from on (or its last rows, when those
// are more), then the prompt box. Rows past the screen's height scroll
// into the scrollback.
func ccRedraw(lines []string, from, cols, rows int) []byte {
	all := ccLayout(lines, cols)
	start := len(ccLayout(lines[:from], cols))
	start = min(start, max(0, len(all)+4-rows))
	frame := append(append([]string(nil), all[start:]...), ccFooter(cols)...)
	var b strings.Builder
	b.WriteString("\x1b[?2026h\x1b[H")
	for range rows {
		b.WriteString("\x1b[2K\x1b[1B")
	}
	b.WriteString("\x1b[H")
	b.WriteString(strings.Join(frame, "\r\n"))
	b.WriteString("\x1b[2A\x1b[3G\x1b[?2026l")
	return []byte(b.String())
}

// ccTranscript is a session: the person's messages (sent while Claude
// worked too) and replies, some longer than any width.
func ccTranscript(n int) []string {
	var t []string
	for i := range n {
		t = append(t, fmt.Sprintf("> message %d from the person, sent from the phone", i), "")
		var words []string
		for j := range 4 + i%5*9 {
			words = append(words, fmt.Sprintf("r%dw%d", i, j))
		}
		t = append(t, fmt.Sprintf("* reply %d: %s", i, strings.Join(words, " ")), "")
		if i%3 == 0 {
			t = append(t, fmt.Sprintf("* Bash(make test %d)", i), fmt.Sprintf("  L ok %d", i), "")
		}
	}
	return t
}

// textOnce is the screen's text, scrollback and screen, without white
// space and without the prompt box, and the transcript's, to compare.
func textOnce(t *testing.T, s Screen, lines []string) (got, want string) {
	t.Helper()
	c, err := s.Capture(CaptureOptions{History: 100000})
	if err != nil {
		t.Fatal(err)
	}
	var g strings.Builder
	for _, l := range c.Lines {
		if strings.HasPrefix(l.Text, "---") || strings.TrimSpace(l.Text) == ">" || strings.Contains(l.Text, "auto mode on") {
			continue
		}
		g.WriteString(squeeze(l.Text))
	}
	return g.String(), squeeze(strings.Join(lines, ""))
}

// A pane running Claude Code, resized as the phone's Flip fold and the
// Mac window do (the sizes of phonefix7's recorded resize, 14 Nov), and
// redrawn by the program at each size: the scrollback and screen hold
// each message once, in order. Before, a taller screen (no rows pulled
// back: the cursor is not on the last row) left the rows the program drew
// again at the top in the scrollback too, and each redraw taller than the
// screen left another copy of its top rows there; the Live screen and the
// phone feed, which read the scrollback, showed earlier messages twice.
func TestRedrawLeavesNoStaleCopy(t *testing.T) {
	lines := ccTranscript(24)
	// The frame from the 17th message on: Claude Code's live part, kept
	// while a background agent runs.
	from := 0
	for i, l := range lines {
		if strings.HasPrefix(l, "> message 17 ") {
			from = i
		}
	}
	for _, tc := range []struct {
		name  string
		sizes [][2]int
	}{
		{"taller", [][2]int{{100, 45}}},
		{"narrower", [][2]int{{80, 30}}},
		{"wider", [][2]int{{120, 30}}},
		{"same size twice", [][2]int{{100, 30}, {100, 30}}},
		{"fold and drag", [][2]int{{100, 45}, {80, 45}, {120, 45}, {120, 25}, {100, 40}, {60, 50}, {100, 30}}},
	} {
		// Claude Code draws its live part whole when it is taller than the
		// screen, else the last rows: both.
		for _, fr := range []struct {
			name string
			from int
		}{{"live part", from}, {"last rows", len(lines)}} {
			t.Run(tc.name+", "+fr.name, func(t *testing.T) {
				from := fr.from
				s, _ := newScreen(t, 100, 30)
				s.SetScrollback(100000)
				// The session so far, drawn once at 100 x 30.
				s.Write(ccRedraw(lines, 0, 100, 30))
				got, want := textOnce(t, s, lines)
				if got != want {
					t.Fatalf("first draw: text differs")
				}
				for _, sz := range tc.sizes {
					if err := s.Resize(sz[0], sz[1]); err != nil {
						t.Fatal(err)
					}
					s.Write(ccRedraw(lines, from, sz[0], sz[1]))
					got, want := textOnce(t, s, lines)
					if got != want {
						c, _ := s.Capture(CaptureOptions{History: 100000})
						var rows []string
						for _, l := range c.Lines {
							rows = append(rows, l.Text)
						}
						t.Fatalf("after %dx%d: the text is not the transcript once (%d chars, want %d):\n%s", sz[0], sz[1], len(got), len(want), strings.Join(rows, "\n"))
					}
				}
			})
		}
	}
}

// histText is the scrollback's text without white space.
func histText(t *testing.T, s Screen) string {
	t.Helper()
	c, err := s.Capture(CaptureOptions{History: 100000})
	if err != nil {
		t.Fatal(err)
	}
	var g strings.Builder
	for _, l := range c.Lines[:c.History] {
		g.WriteString(squeeze(l.Text))
	}
	return g.String()
}

// Real scrollback stays: a message the person sent twice, with the same
// reply, through redraws and resizes; the scrollback above a redraw that
// draws something else; and a program that only appends.
func TestRedrawKeepsRealScrollback(t *testing.T) {
	t.Run("sent twice", func(t *testing.T) {
		lines := ccTranscript(6)
		for range 2 {
			lines = append(lines, "> yes, go on", "", "* ok", "")
		}
		lines = append(lines, ccTranscript(10)...)
		from := len(lines) - 20
		s, _ := newScreen(t, 100, 30)
		s.SetScrollback(100000)
		s.Write(ccRedraw(lines, 0, 100, 30))
		for _, sz := range [][2]int{{100, 30}, {100, 45}, {70, 45}, {120, 20}, {100, 30}} {
			if err := s.Resize(sz[0], sz[1]); err != nil {
				t.Fatal(err)
			}
			s.Write(ccRedraw(lines, from, sz[0], sz[1]))
			if got, want := textOnce(t, s, lines); got != want {
				t.Fatalf("at %dx%d the text is not the transcript:\n got %q\nwant %q", sz[0], sz[1], got, want)
			}
		}
	})
	t.Run("another frame", func(t *testing.T) {
		lines := ccTranscript(12)
		s, _ := newScreen(t, 100, 30)
		s.SetScrollback(100000)
		s.Write(ccRedraw(lines, 0, 100, 30))
		s.Write(ccRedraw(lines, 0, 100, 30))
		if err := s.Resize(90, 30); err != nil {
			t.Fatal(err)
		}
		before := histText(t, s)
		s.Write(ccRedraw([]string{"something else entirely", "", "and more"}, 0, 90, 30))
		if got := histText(t, s); got != before {
			t.Fatalf("the scrollback changed:\n got %q\nwant %q", got, before)
		}
	})
	t.Run("the same word over and over", func(t *testing.T) {
		// A paragraph of one word across the frame's top after a resize:
		// its rows above the screen are not a copy of those on it.
		lines := append(ccTranscript(8), "* "+strings.Repeat("go ", 400), "")
		lines = append(lines, ccTranscript(2)...)
		s, _ := newScreen(t, 100, 30)
		s.SetScrollback(100000)
		s.Write(ccRedraw(lines, 0, 100, 30))
		for _, sz := range [][2]int{{100, 20}, {100, 12}} {
			if err := s.Resize(sz[0], sz[1]); err != nil {
				t.Fatal(err)
			}
			s.Write(ccRedraw(lines, len(lines), sz[0], sz[1]))
			if got, want := textOnce(t, s, lines); got != want {
				t.Fatalf("at %dx%d the text is not the transcript:\n got %q\nwant %q", sz[0], sz[1], got, want)
			}
		}
	})
	t.Run("appends only", func(t *testing.T) {
		s, _ := newScreen(t, 80, 10)
		s.SetScrollback(100000)
		var want strings.Builder
		for i := range 60 {
			l := fmt.Sprintf("line %d same text", i%3)
			s.Write([]byte(l + "\r\n"))
			want.WriteString(squeeze(l))
			if i == 30 {
				s.Resize(60, 14)
			}
		}
		if got, _ := textOnce(t, s, nil); got != want.String() {
			t.Fatalf("got %q\nwant %q", got, want.String())
		}
	})
}
