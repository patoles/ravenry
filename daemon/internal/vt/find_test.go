package vt

import (
	"errors"
	"fmt"
	"math/rand"
	"strings"
	"testing"
)

// found runs a search and returns its count and every match.
func found(t *testing.T, s Screen, f *Find, needle string, o FindOptions) (int, []Range) {
	t.Helper()
	if err := f.SetNeedle(needle, o); err != nil {
		t.Fatalf("%q: %v", needle, err)
	}
	if err := f.Update(); err != nil {
		t.Fatal(err)
	}
	_, rows := s.Size()
	g := s.(*ghostty)
	count, _, _, in, _ := f.Matches(0, g.history()+rows)
	return count, in
}

// TestFindCaseAndRegex: a literal in any case or in its case, a regular
// expression, a pattern that does not parse, and matches over a soft wrap
// and past wide characters.
func TestFindCaseAndRegex(t *testing.T) {
	s := newTestScreen(t, 20, 6)
	s.Write([]byte("Needle needle NEEDLE\r\n")) // row 0: exactly 20 columns, no wrap
	s.Write([]byte("ab 日本 needle\r\n"))         // row 1: wide characters before it
	s.Write([]byte("0123456789012345 needle tail\r\n"))
	s.Write([]byte("err42 err7 errx\r\n"))
	f, err := s.NewFind()
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	if n, _ := found(t, s, f, "needle", FindOptions{}); n != 5 {
		t.Errorf("any case: %d matches, want 5", n)
	}
	n, in := found(t, s, f, "needle", FindOptions{CaseSensitive: true})
	if n != 3 || in[0] != (Range{X0: 7, Y0: 0, X1: 12, Y1: 0}) {
		t.Errorf("this case: %d matches %+v", n, in)
	}
	// Past wide characters: columns, not bytes (日 and 本 take two each).
	if in[1] != (Range{X0: 8, Y0: 1, X1: 13, Y1: 1}) {
		t.Errorf("after wide characters: %+v", in[1])
	}
	// Over the soft wrap: row 2 runs on to row 3 at column 20.
	if in[2] != (Range{X0: 17, Y0: 2, X1: 2, Y1: 3}) {
		t.Errorf("over the wrap: %+v", in[2])
	}
	if n, _ := found(t, s, f, "NEEDLE", FindOptions{CaseSensitive: true}); n != 1 {
		t.Errorf("upper case only: %d", n)
	}
	n, in = found(t, s, f, `err[0-9]+`, FindOptions{Regex: true})
	if n != 2 || in[0] != (Range{X0: 0, Y0: 4, X1: 4, Y1: 4}) || in[1] != (Range{X0: 6, Y0: 4, X1: 9, Y1: 4}) {
		t.Errorf("regex: %d %+v", n, in)
	}
	// A regular expression over the wrap, in any case unless asked.
	if n, in := found(t, s, f, `5 NEE\w+ t`, FindOptions{Regex: true}); n != 1 || in[0] != (Range{X0: 15, Y0: 2, X1: 4, Y1: 3}) {
		t.Errorf("regex over the wrap: %d %+v", n, in)
	}
	if n, _ := found(t, s, f, `5 NEE\w+ t`, FindOptions{Regex: true, CaseSensitive: true}); n != 0 {
		t.Errorf("regex in its case: %d", n)
	}
	// Anchors hold to a line, soft-wrapped rows joined.
	if n, _ := found(t, s, f, `tail$`, FindOptions{Regex: true}); n != 1 {
		t.Errorf("tail$: %d", n)
	}
	if n, _ := found(t, s, f, `^needle|^dle`, FindOptions{Regex: true, CaseSensitive: true}); n != 0 {
		t.Errorf("^needle at a wrapped row's start: %d", n)
	}
	// Letters past ASCII in any case.
	s.Write([]byte("Café CAFÉ\r\n"))
	if n, _ := found(t, s, f, "café", FindOptions{}); n != 2 {
		t.Errorf("café in any case: %d", n)
	}
	// Empty matches are not matches.
	if n, _ := found(t, s, f, `x*`, FindOptions{Regex: true}); n != 1 {
		t.Errorf("x*: %d", n)
	}
	// A pattern that does not parse: why, and no matches.
	err = f.SetNeedle(`needle(`, FindOptions{Regex: true})
	var pe *PatternError
	if !errors.As(err, &pe) || pe.Reason != "missing closing )" {
		t.Errorf("bad pattern: %v", err)
	}
	f.Update()
	if n, _, _, _, _ := f.Matches(0, 50); n != 0 {
		t.Errorf("bad pattern: %d matches", n)
	}
	// The same needle as a literal is fine.
	if n, _ := found(t, s, f, `needle(`, FindOptions{}); n != 0 {
		t.Errorf("literal needle(: %d", n)
	}
}

// TestFindKeepsUp: after output, a prune of the oldest rows, an erased
// history, a Clear and a resize, the search's matches are a fresh
// search's, and the selected match stays selected while it is there.
func TestFindKeepsUp(t *testing.T) {
	s, err := New(Options{Cols: 30, Rows: 8, Scrollback: 300})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	g := s.(*ghostty)
	r := rand.New(rand.NewSource(7))
	line := func(i int) string {
		var b strings.Builder
		fmt.Fprintf(&b, "%d", i)
		for range r.Intn(12) {
			b.WriteString([]string{" key", " Key", " ké", " 日", " x", " keyword"}[r.Intn(6)])
		}
		return b.String() + "\r\n"
	}
	f, _ := s.NewFind()
	defer f.Close()
	o := FindOptions{Regex: true}
	f.SetNeedle(`k\w+`, o)
	f.Update()
	check := func(when string) {
		t.Helper()
		f.Update()
		fresh, _ := s.NewFind()
		defer fresh.Close()
		fresh.SetNeedle(`k\w+`, o)
		fresh.Update()
		all := g.history() + 8
		n1, _, _, in1, _ := f.Matches(0, all)
		n2, _, _, in2, _ := fresh.Matches(0, all)
		if n1 != n2 || fmt.Sprint(in1) != fmt.Sprint(in2) {
			t.Fatalf("%s: %d matches, a fresh search %d", when, n1, n2)
		}
	}
	// Up to a little before libghostty prunes the oldest page.
	for i := 0; g.history() < int(lineLimit(300, 30))-100; i++ {
		s.Write([]byte(line(i)))
		if i%137 == 0 {
			check(fmt.Sprint("output ", i))
		}
	}
	check("before the prune")
	// The newest match selected, then output until the prune, and a
	// little more.
	sel, _, _ := f.Step(1)
	h := g.history()
	pruned := 0
	for i := 400; pruned < 5; i++ {
		s.Write([]byte(line(i)))
		if g.history() < h || pruned > 0 {
			pruned++
		}
		h = g.history()
		if i%301 == 0 {
			check(fmt.Sprint("output ", i))
		}
	}
	check("after a prune")
	_, idx, cur, _, _ := f.Matches(0, 0)
	if cur == nil {
		t.Fatalf("the selected match went: %d (was %+v)", idx, sel)
	}
	if c, _ := s.TextRange(cur.X0, cur.Y0, cur.X1, cur.Y1, false); cur.Y0 >= sel.Y0 || !strings.HasPrefix(strings.ToLower(c), "k") || idx < 5 {
		t.Errorf("the selected match: %+v %q index %d, was %+v", cur, c, idx, sel)
	}
	for i := range 3000 {
		s.Write([]byte(line(i)))
		if i%301 == 0 {
			check(fmt.Sprint("more output ", i))
		}
	}
	// A long line that wraps, then output on the screen's rows.
	s.Write([]byte(strings.Repeat("keyword ", 12)))
	check("a wrapping line")
	s.Write([]byte("\r\nkey\x1b[2Akx\r\n\r\n"))
	check("a row written again")
	s.Write([]byte("\x1b[H\x1b[2J\x1b[3J"))
	check("history erased")
	for i := range 50 {
		s.Write([]byte(line(i)))
	}
	if err := s.Resize(17, 6); err != nil {
		t.Fatal(err)
	}
	check("resized")
	if _, err := s.Clear(); err != nil {
		t.Fatal(err)
	}
	check("cleared")
	s.Write([]byte("\x1b[?1049hkey on the alternate screen\r\n"))
	check("the alternate screen")
	s.Write([]byte("\x1b[?1049l"))
	check("back")
}

// longHistory is a pane of n lines of build-log text at 120 columns, a
// tenth of them long enough to wrap, some with wide characters.
func longHistory(tb testing.TB, n int) Screen {
	tb.Helper()
	s, err := New(Options{Cols: 120, Rows: 40, Scrollback: n})
	if err != nil {
		tb.Fatal(err)
	}
	r := rand.New(rand.NewSource(1))
	words := []string{"build", "error", "Error", "warning", "ok", "compiling", "module", "café", "→", "日本", "test", "passed", "failed", "src/main.go:42", "0x1f3a", "fetching", "deps"}
	var b strings.Builder
	for i := range n {
		k := 5 + r.Intn(15)
		if r.Intn(10) == 0 {
			k = 40 + r.Intn(30)
		}
		fmt.Fprintf(&b, "%6d ", i)
		for j := range k {
			if j > 0 {
				b.WriteByte(' ')
			}
			b.WriteString(words[r.Intn(len(words))])
		}
		b.WriteString("\r\n")
		if b.Len() > 1<<16 {
			s.Write([]byte(b.String()))
			b.Reset()
		}
	}
	s.Write([]byte(b.String()))
	return s
}

// BenchmarkFind: 50,000 lines of history at 120 columns. first: a new
// search reads every row and matches; needle: another needle on the rows
// read; output: a line of output, then the matches on the screen (a
// frame's work while a search is open).
func BenchmarkFind(b *testing.B) {
	s := longHistory(b, 50000)
	defer s.Close()
	g := s.(*ghostty)
	for _, c := range []struct {
		name   string
		needle string
		o      FindOptions
	}{
		{"literal", "error", FindOptions{}},
		{"case", "Error", FindOptions{CaseSensitive: true}},
		{"regex", `err(or)?\b`, FindOptions{Regex: true}},
	} {
		b.Run(c.name+"/first", func(b *testing.B) {
			for range b.N {
				f, _ := s.NewFind()
				f.SetNeedle(c.needle, c.o)
				f.Update()
				f.Close()
			}
		})
		b.Run(c.name+"/needle", func(b *testing.B) {
			f, _ := s.NewFind()
			defer f.Close()
			f.SetNeedle("x", FindOptions{})
			f.Update()
			for i := range b.N {
				f.SetNeedle(c.needle+[]string{"", " "}[i%2], c.o)
				f.Update()
			}
		})
		b.Run(c.name+"/output", func(b *testing.B) {
			f, _ := s.NewFind()
			defer f.Close()
			f.SetNeedle(c.needle, c.o)
			f.Update()
			for range b.N {
				s.Write([]byte("one more error line\r\n"))
				f.Update()
				f.Matches(g.history(), 40)
			}
		})
	}
}

// TestFindRows: the rows the matches start on, each once and in order,
// for a scrollbar's marks; spread over all of them past the limit.
func TestFindRows(t *testing.T) {
	s := newTestScreen(t, 30, 5)
	for i := 0; i < 40; i++ {
		if i%4 == 0 {
			s.Write([]byte(fmt.Sprintf("line %d mark mark\r\n", i)))
		} else {
			s.Write([]byte(fmt.Sprintf("line %d\r\n", i)))
		}
	}
	f, err := s.NewFind()
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if n, _ := found(t, s, f, "mark", FindOptions{}); n != 20 {
		t.Fatalf("count %d, want 20", n)
	}
	rows := f.Rows(0)
	if len(rows) != 10 {
		t.Fatalf("rows %v, want 10 (one a line)", rows)
	}
	for i, y := range rows {
		if y != 4*i {
			t.Fatalf("rows %v: row %d is %d, want %d", rows, i, y, 4*i)
		}
	}
	if r := f.Rows(4); len(r) != 4 || r[0] != 0 || r[3] != 28 {
		t.Fatalf("rows at most 4: %v", r)
	}
}
