package testprog

import (
	"fmt"
	"math/rand"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/term"
)

// Claude Code's screen, as testprog's redraw draws it with
// RAVENRY_TESTPROG_REDRAW=claude (or claude-busy): what tests compare
// the frames with.

// SpinnerText is in the spinner's line (claude-busy), whose count
// changes.
const SpinnerText = "Working"

// spinner glyphs, one cell wide each.
var spinGlyphs = []string{"✢", "✶", "✻", "✽"}

// placed is a word at its column.
type placed struct {
	x    int
	text string
}

// footer is the rows under the transcript: a rule, the prompt, a rule,
// the status line. The cursor rests on the prompt's row, at column 3.
const footer = 4

// claudeRows lays out the screen at cols x rows: the last lines of the
// transcript word-wrapped at cols, the spinner's line when busy, and the
// footer.
func claudeRows(lines []string, cols, rows int, busy bool, spin string) [][]placed {
	var wrapped [][]placed
	for _, l := range lines {
		var row []placed
		x := 0
		for _, w := range strings.Fields(l) {
			for len(w) > cols {
				if x > 0 {
					wrapped, row, x = append(wrapped, row), nil, 0
				}
				wrapped = append(wrapped, []placed{{0, w[:cols]}})
				w = w[cols:]
			}
			if x > 0 && x+1+len(w) > cols {
				wrapped, row, x = append(wrapped, row), nil, 0
			}
			if x > 0 {
				x++
			}
			row = append(row, placed{x, w})
			x += len(w)
		}
		wrapped = append(wrapped, row)
	}
	body := rows - footer
	if busy {
		body--
	}
	body = max(body, 0)
	out := append([][]placed(nil), wrapped[max(0, len(wrapped)-body):]...)
	if busy {
		out = append(out, []placed{{0, spin}})
	}
	rule := []placed{{0, strings.Repeat("─", cols)}}
	out = append(out, rule, []placed{{0, "❯"}}, rule)
	var status []placed
	x := 2
	for _, w := range strings.Fields("⏵⏵ auto mode on (shift+tab to cycle) · ← for agents") {
		n := len([]rune(w))
		if x+n > cols {
			break
		}
		status = append(status, placed{x, w})
		x += n + 1
	}
	out = append(out, status)
	return out[max(0, len(out)-rows):]
}

// ClaudeScreen is the screen's text the program draws at cols x rows,
// one string per row, trailing spaces trimmed (rframe.RowText), the
// spinner's line as SpinnerText alone.
func ClaudeScreen(lines []string, cols, rows int, busy bool) []string {
	var out []string
	for _, r := range claudeRows(lines, cols, rows, busy, SpinnerText) {
		var b []rune
		for _, p := range r {
			for len(b) < p.x {
				b = append(b, ' ')
			}
			b = append(b, []rune(p.text)...)
		}
		out = append(out, strings.TrimRight(string(b), " "))
	}
	for len(out) < rows {
		out = append(out, "")
	}
	return out
}

// claudeFrame is what the program draws at cols x rows: the screen's
// last rows (claudeRows) or, with live > 0, its live part whole when
// that is taller than the screen: the last live lines of the transcript
// (all of them on the first draw) and the footer, the rows past the
// screen's height scrolling into the scrollback.
func claudeFrame(lines []string, cols, rows int, busy bool, spin string, live int, first bool) [][]placed {
	if live > 0 {
		from := max(0, len(lines)-live)
		if first {
			from = 0
		}
		if all := claudeRows(lines[from:], cols, 1<<20, busy, spin); len(all) > rows {
			return all
		}
	}
	return claudeRows(lines, cols, rows, busy, spin)
}

func claude(lines []string, busy bool, live int) {
	var mu sync.Mutex
	write := func(s string) { os.Stdout.WriteString(s) }
	n := 0
	spin := func() string {
		return fmt.Sprintf("%s %s… (%ds)", spinGlyphs[n%len(spinGlyphs)], SpinnerText, n/10)
	}
	size := func() (int, int) {
		cols, rows, err := term.GetSize(0)
		if err != nil {
			fmt.Println("error", err)
			os.Exit(1)
		}
		return cols, rows
	}
	drawn := false
	draw := func(cols, rows int) {
		laid := claudeFrame(lines, cols, rows, busy, spin(), live, !drawn)
		drawn = true
		rowsOut := make([]string, len(laid))
		for y, r := range laid {
			var b strings.Builder
			for _, p := range r {
				if p.x > 0 {
					fmt.Fprintf(&b, "\x1b[%dG", p.x+1)
				}
				b.WriteString(p.text)
			}
			rowsOut[y] = b.String()
		}
		write("\x1b[?2026h\x1b[?25l\x1b[H" + strings.Repeat("\x1b[2K\x1b[1B", rows) + "\x1b[H")
		per := (len(rowsOut) + 3) / 4
		for i := 0; i < len(rowsOut); i += per {
			time.Sleep(20 * time.Millisecond)
			end := min(i+per, len(rowsOut))
			s := strings.Join(rowsOut[i:end], "\r\r\n")
			if end < len(rowsOut) {
				s += "\r\r\n"
			}
			write(s)
		}
		// From the status row to the prompt's, column 3.
		write("\r\x1b[2A\x1b[2C\x1b[?25h\x1b[?2026l")
	}
	// Each size it is told, in order, drawn 120 to 200 ms after.
	type told struct {
		cols, rows int
		at         time.Time
	}
	queue := make(chan told, 1024)
	winch := make(chan os.Signal, 64)
	signal.Notify(winch, syscall.SIGWINCH)
	go func() {
		for range winch {
			c, r := size()
			queue <- told{c, r, time.Now()}
		}
	}()
	if busy {
		go func() {
			for {
				time.Sleep(100 * time.Millisecond)
				mu.Lock()
				n++
				// From the prompt's row up to the spinner's, and back.
				write("\x1b[?2026h\x1b[?25l\x1b[2A\r" + spin() + "\x1b[K\r\x1b[2B\x1b[2C\x1b[?25h\x1b[?2026l")
				mu.Unlock()
			}
		}()
	}
	rng := rand.New(rand.NewSource(int64(os.Getpid())))
	mu.Lock()
	draw(size())
	mu.Unlock()
	for t := range queue {
		time.Sleep(time.Until(t.at.Add(time.Duration(120+rng.Intn(81)) * time.Millisecond)))
		mu.Lock()
		draw(t.cols, t.rows)
		mu.Unlock()
	}
}
