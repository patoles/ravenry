package server

import (
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
)

// The terminal basics of the render stream that the daemon decides for
// every client (RENDERING.md): the wheel, selection and copy, find,
// links, dropped files.

// lines100 prints line1 to line100, then echoes its input.
var lines100 = []string{"/bin/sh", "-c", `i=1; while [ $i -le 100 ]; do echo line$i; i=$((i+1)); done; exec cat`}

func basicsStream(t *testing.T, command []string) (*renderClient, *client.Stream) {
	t.Helper()
	d := startDaemon(t)
	c := d.dial(client.Options{})
	p := newPane(t, c, map[string]any{"command": command})
	st, err := c.Render(ctx(t), p.ID, client.RenderOptions{Cols: 40, Rows: 10})
	if err != nil {
		t.Fatal(err)
	}
	return &renderClient{t: t, st: st}, st
}

// settle reads frames until none comes for a while.
func (r *renderClient) settle() {
	for r.next(150*time.Millisecond) != nil {
	}
}

func wheelEv(rows float64) proto.RenderEvent {
	return proto.RenderEvent{Wheel: &proto.RenderWheel{Rows: rows, X: 50, Y: 30, CellWidth: 10, CellHeight: 20}}
}

// TestRenderWheel: the wheel scrolls the view by whole rows, a
// trackpad's fractions adding up; typing brings it back.
func TestRenderWheel(t *testing.T) {
	r, st := basicsStream(t, lines100)
	r.until("line100")
	r.settle()
	// Twelve trackpad steps of a quarter row: three rows.
	var evs []proto.RenderEvent
	for range 12 {
		evs = append(evs, wheelEv(0.25))
	}
	if err := st.Events(ctx(t), evs); err != nil {
		t.Fatal(err)
	}
	r.settle()
	if r.scr.Offset != 3 {
		t.Errorf("offset after 3 rows of trackpad: %d", r.scr.Offset)
	}
	st.Events(ctx(t), []proto.RenderEvent{wheelEv(40)})
	r.settle()
	if r.scr.Offset != 43 || !strings.Contains(strings.Join(r.scr.Text(), "\n"), "line50") {
		t.Errorf("offset %d after 40 more:\n%s", r.scr.Offset, strings.Join(r.scr.Text(), "\n"))
	}
	st.Events(ctx(t), []proto.RenderEvent{wheelEv(-1000)})
	r.settle()
	if r.scr.Offset != 0 {
		t.Errorf("offset %d after scrolling down past the end", r.scr.Offset)
	}
	st.Events(ctx(t), []proto.RenderEvent{wheelEv(5000)})
	r.settle()
	if r.scr.Offset != r.scr.History || r.scr.History == 0 {
		t.Errorf("offset %d of %d after scrolling up past the top", r.scr.Offset, r.scr.History)
	}
	// Typing goes back to the live screen.
	st.Events(ctx(t), []proto.RenderEvent{{Key: &proto.RenderKey{Code: "KeyX", Text: "x"}}})
	r.settle()
	if r.scr.Offset != 0 {
		t.Errorf("offset %d after a key", r.scr.Offset)
	}
}

// TestRenderWheelProgram: with mouse reporting on, the wheel goes to the
// program as wheel buttons; on the alternate screen without it, as arrow
// keys (mode 1007), and the view does not scroll.
func TestRenderWheelProgram(t *testing.T) {
	r, st := basicsStream(t, []string{"/bin/sh", "-c", `printf 'ready\033[?1000h\033[?1006h'; exec cat -v`})
	r.until("ready")
	r.settle()
	st.Events(ctx(t), []proto.RenderEvent{wheelEv(2)})
	r.until("[<64;6;2M")
	if r.scr.Offset != 0 {
		t.Errorf("the view scrolled: %d", r.scr.Offset)
	}

	r, st = basicsStream(t, []string{"/bin/sh", "-c", `printf '\033[?1049hready'; exec cat -v`})
	r.until("ready")
	r.settle()
	st.Events(ctx(t), []proto.RenderEvent{wheelEv(-1)})
	r.until("^[[B")
	if r.scr.Offset != 0 {
		t.Errorf("the alternate screen scrolled: %d", r.scr.Offset)
	}
}

func selectEv(action string, col, row int, extend bool) proto.RenderEvent {
	return proto.RenderEvent{Select: &proto.RenderSelect{Action: action, Col: col, Row: row,
		X: float64(col)*10 + 7, Y: float64(row)*20 + 5, CellWidth: 10, CellHeight: 20, Extend: extend}}
}

// TestRenderSelection: a drag from the scrollback to the screen, sent
// back in the frames, copied with its rows joined; a click clears it.
func TestRenderSelection(t *testing.T) {
	r, st := basicsStream(t, lines100)
	r.until("line100")
	r.settle()
	top := r.scr.History // the screen's first row
	press := selectEv("press", 0, 5, false)
	press.Select.X = 2
	if err := st.Events(ctx(t), []proto.RenderEvent{press, selectEv("drag", 3, top+1, false), selectEv("release", 3, top+1, false)}); err != nil {
		t.Fatal(err)
	}
	r.settle()
	sel := r.scr.Selection
	if !sel.Set || sel.Range.Y0 != 5 || sel.Range.Y1 != top+1 {
		t.Fatalf("the frames' selection: %+v (screen top %d)", sel, top)
	}
	text, err := st.Copy(ctx(t))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(text, "line6\nline7\n") || !strings.HasSuffix(text, "line92\nline") {
		t.Errorf("copy: %q", text)
	}
	// Shift extends to the end of the screen's row 2.
	st.Events(ctx(t), []proto.RenderEvent{selectEv("press", 6, top+2, true), selectEv("release", 6, top+2, true)})
	r.settle()
	if text, _ := st.Copy(ctx(t)); !strings.HasSuffix(text, "line93\nline94") {
		t.Errorf("shift click: %q", text)
	}
	// A click clears it.
	st.Events(ctx(t), []proto.RenderEvent{selectEv("press", 1, top+3, false), selectEv("release", 1, top+3, false)})
	r.settle()
	if r.scr.Selection.Set {
		t.Errorf("a click left the selection %+v", r.scr.Selection)
	}
	// Select all.
	st.Events(ctx(t), []proto.RenderEvent{{Select: &proto.RenderSelect{Action: "all"}}})
	r.settle()
	if text, _ := st.Copy(ctx(t)); !strings.HasPrefix(text, "line1\n") || !strings.Contains(text, "line100") {
		t.Errorf("select all: %q", text[:min(len(text), 40)])
	}
}

// TestRenderFind: matches counted in the scrollback, the view brought to
// the selected one, the frames carrying the matches on their rows.
func TestRenderFind(t *testing.T) {
	r, st := basicsStream(t, lines100)
	r.until("line100")
	r.settle()
	res, err := st.Find(ctx(t), "LINE5", 0)
	if err != nil {
		t.Fatal(err)
	}
	// line5, line50 to line59.
	if res.Count != 11 || res.Selected != -1 {
		t.Errorf("find: %+v", res)
	}
	res, _ = st.Find(ctx(t), "LINE5", 1)
	r.settle()
	if res.Selected != 0 || r.scr.Find.Current == nil || !r.scr.Find.Active || r.scr.Find.Count != 11 {
		t.Fatalf("next: %+v, frames %+v", res, r.scr.Find)
	}
	cur := *r.scr.Find.Current
	if text := r.scr.Text()[cur.Y0-(r.scr.History-r.scr.Offset)]; text != "line59" || r.scr.Offset == 0 {
		t.Errorf("the view's row of the match: %q, offset %d", text, r.scr.Offset)
	}
	if len(r.scr.Find.Matches) == 0 {
		t.Errorf("no other match on the rows: %+v", r.scr.Find)
	}
	for range 10 {
		res, _ = st.Find(ctx(t), "LINE5", 1)
	}
	r.settle()
	if res.Selected != 10 || r.scr.Offset == 0 || r.scr.Find.Current == nil {
		t.Errorf("the oldest match: %+v offset %d", res, r.scr.Offset)
	}
	st.Find(ctx(t), "", 0)
	r.settle()
	if r.scr.Find.Active {
		t.Errorf("the search did not end: %+v", r.scr.Find)
	}
}

// TestRenderFindOptions: match case and a regular expression on
// render.find, a pattern that does not parse answered with why (not an
// error), and a match over a soft wrap.
func TestRenderFindOptions(t *testing.T) {
	r, st := basicsStream(t, []string{"/bin/sh", "-c", `printf 'Alpha alpha ALPHA\nid=12 id=7 id=x\n%040dbeta\n' 0; exec cat`})
	r.until("beta")
	r.settle()
	for _, c := range []struct {
		needle       string
		caseSens, re bool
		count        int
	}{
		{"alpha", false, false, 3},
		{"alpha", true, false, 1},
		{"ALPHA", true, false, 1},
		{`id=[0-9]+`, false, true, 2},
		{`^a\w+`, false, true, 1},
		{`^a\w+`, true, true, 0},
		{`0beta`, false, false, 1}, // the 41st column runs on to the next row
	} {
		res, err := st.FindWith(ctx(t), c.needle, c.caseSens, c.re, 0)
		if err != nil || res.Count != c.count || res.PatternError != "" {
			t.Errorf("%q case %v regex %v: %+v %v, want %d", c.needle, c.caseSens, c.re, res, err, c.count)
		}
	}
	res, err := st.FindWith(ctx(t), `0beta`, false, false, 1)
	r.settle()
	if err != nil || r.scr.Find.Current == nil || r.scr.Find.Current.Y1 != r.scr.Find.Current.Y0+1 {
		t.Errorf("over the wrap: %+v %v, frames %+v", res, err, r.scr.Find)
	}
	res, err = st.FindWith(ctx(t), `id=(`, false, true, 1)
	r.settle()
	if err != nil || res.PatternError != "missing closing )" || res.Count != 0 || res.Selected != -1 {
		t.Errorf("bad pattern: %+v %v", res, err)
	}
	if !r.scr.Find.Active || r.scr.Find.Count != 0 || r.scr.Find.Current != nil {
		t.Errorf("bad pattern: frames %+v", r.scr.Find)
	}
}

// TestRenderLinkAndPaths: the link on a cell, and dropped files pasted
// as quoted paths.
func TestRenderLinkAndPaths(t *testing.T) {
	r, st := basicsStream(t, []string{"/bin/sh", "-c", `printf 'go to https://ravenry.dev/docs.\n'; exec cat`})
	r.until("ravenry.dev")
	r.settle()
	y := r.scr.History
	l, err := st.Link(ctx(t), proto.RenderPoint{X: 10, Y: y})
	if err != nil {
		t.Fatal(err)
	}
	if l.URI != "https://ravenry.dev/docs" || l.From == nil || l.From.X != 6 || l.To.X != 29 {
		t.Errorf("link: %+v", l)
	}
	if l, _ := st.Link(ctx(t), proto.RenderPoint{X: 1, Y: y}); l.URI != "" {
		t.Errorf("a link on \"go\": %+v", l)
	}
	st.Events(ctx(t), []proto.RenderEvent{{Paths: []string{"/tmp/a b.txt", "/tmp/it's"}}})
	r.until(`/tmp/a\ b.txt /tmp/it\'s`)
}
