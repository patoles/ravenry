package server

import (
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
	"ravenryd/internal/rframe"
)

// renderClient keeps a client's copy of the screen from a render stream,
// as a client that draws would, acknowledging each frame.
type renderClient struct {
	t      *testing.T
	st     *client.Stream
	scr    rframe.Screen
	frames int
}

// next takes one frame, or fails after d.
func (r *renderClient) next(d time.Duration) *rframe.Frame {
	r.t.Helper()
	select {
	case f, ok := <-r.st.Frames:
		if !ok {
			r.t.Fatal("the render stream ended")
		}
		if !f.Render {
			r.t.Fatalf("a frame of another kind on a render stream")
		}
		fr, err := rframe.Decode(f.Data)
		if err != nil {
			r.t.Fatal(err)
		}
		if err := r.scr.Apply(fr); err != nil {
			r.t.Fatal(err)
		}
		r.frames++
		r.st.AckFrame(ctx(r.t), fr.Seq)
		return fr
	case <-time.After(d):
		return nil
	}
}

// until reads frames until the screen's text has want.
func (r *renderClient) until(want string) {
	r.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(strings.Join(r.scr.Text(), "\n"), want) {
		if time.Now().After(deadline) {
			r.t.Fatalf("the screen never showed %q:\n%s", want, strings.Join(r.scr.Text(), "\n"))
		}
		r.next(time.Until(deadline))
	}
}

func TestRenderStream(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c",
		`printf '\033[1;31mred\033[0m \344\270\226\347\225\214 \033]8;;http://example.com/a\033\\link\033]8;;\033\\\n'; exec cat`}})
	st, err := c.Render(ctx(t), p.ID, client.RenderOptions{Cols: 100, Rows: 10, FPS: 120})
	if err != nil {
		t.Fatal(err)
	}
	r := &renderClient{t: t, st: st}
	first := r.next(5 * time.Second)
	if first == nil || first.Flags&rframe.FlagFull == 0 || first.Cols != 100 || first.Rows != 10 {
		t.Fatalf("first frame %+v: want a full frame at 100x10", first)
	}
	r.until("link")
	row := r.scr.Lines[0]
	if row[0].Text != "r" || row[0].Style.Attrs&rframe.AttrBold == 0 || row[0].Style.Fg.Kind != 1 || row[0].Style.Fg.Index != 1 {
		t.Errorf("cell 0 %+v: want a bold r in palette colour 1", row[0])
	}
	if row[4].Text != "世" || !row[4].Wide || !row[5].Spacer || row[6].Text != "界" {
		t.Errorf("cells 4 to 6 %+v: want two wide characters", row[4:7])
	}
	if l := row[9].Style.Link; l == 0 || r.scr.Links[l] != "http://example.com/a" {
		t.Errorf("cell 9 link %d (%q): want the hyperlink", l, r.scr.Links[l])
	}

	// Typing: a key event, encoded by the daemon, echoed by cat. Each
	// keystroke's echo is timed from the request to its frame.
	var lat []time.Duration
	for i := range 60 {
		ch := string(rune('a' + i%26))
		start := time.Now()
		if err := st.Events(ctx(t), []proto.RenderEvent{{Key: &proto.RenderKey{Code: "Key" + strings.ToUpper(ch), Text: ch, Unshifted: int(ch[0])}}}); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(5 * time.Second)
		for {
			y, x := r.scr.Cursor.Y, r.scr.Cursor.X
			if x > 0 && r.scr.Lines[y][x-1].Text == ch {
				break
			}
			if r.next(time.Until(deadline)) == nil {
				t.Fatalf("no echo of %q; cursor %+v:\n%s", ch, r.scr.Cursor, strings.Join(r.scr.Text(), "\n"))
			}
		}
		lat = append(lat, time.Since(start))
		time.Sleep(10 * time.Millisecond) // a person types, the stream is idle between keys
	}
	sort.Slice(lat, func(i, j int) bool { return lat[i] < lat[j] })
	msg := fmt.Sprintf("render stream keystroke to frame (60 keys, cat echoing): median %v, p95 %v, max %v",
		lat[len(lat)/2].Round(time.Microsecond), lat[len(lat)*95/100].Round(time.Microsecond), lat[len(lat)-1].Round(time.Microsecond))
	t.Log(msg)
	fmt.Println("MEASURE " + msg)
	if lat[len(lat)/2] > 20*time.Millisecond {
		t.Errorf("median keystroke to frame %v", lat[len(lat)/2])
	}

	// Enter and a paste.
	if err := st.Events(ctx(t), []proto.RenderEvent{{Key: &proto.RenderKey{Code: "Enter"}}, {Paste: ptr("pasted")}, {Key: &proto.RenderKey{Code: "Enter"}}}); err != nil {
		t.Fatal(err)
	}
	r.until("pasted")

	// A resize: the next frame is full, at the new size.
	call[proto.PaneResult](t, c, "pane.resize", map[string]any{"pane": p.ID, "cols": 30, "rows": 8})
	for {
		f := r.next(5 * time.Second)
		if f == nil {
			t.Fatal("no frame after the resize")
		}
		if f.Cols == 30 && f.Rows == 8 {
			if f.Flags&rframe.FlagFull == 0 {
				t.Error("the first frame at a new size is not full")
			}
			break
		}
	}

	// Errors: two fields in one event, a channel of another kind.
	sendingInvalid.Store(true)
	if e := callErr(t, c, "render.input", map[string]any{"channel": st.Channel, "events": []any{map[string]any{"text": "a", "paste": "b"}}}); e.Code != proto.CodeBadRequest {
		t.Errorf("two fields: %s", e.Code)
	}
	sendingInvalid.Store(false)
	bs, err := c.Subscribe(ctx(t), p.ID, client.SubscribeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if e := callErr(t, c, "render.scroll", map[string]any{"channel": bs.Channel, "offset": 1}); e.Code != proto.CodeBadRequest {
		t.Errorf("scroll on a byte stream: %s", e.Code)
	}
	if err := st.Close(ctx(t)); err != nil {
		t.Fatal(err)
	}
}

func ptr[T any](v T) *T { return &v }

// TestRenderScrollback scrolls a render stream into the scrollback and
// reads text beyond the view.
// TestRenderFrameMark: a render frame's header carries the pane's output
// position the frame shows (a client places an input's echo by it).
func TestRenderFrameMark(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", `printf 'hello\n'; exec cat`}})
	waitFor(t, c, p.ID, `hello`, 0)
	st, err := c.Render(ctx(t), p.ID, client.RenderOptions{Cols: 40, Rows: 5})
	if err != nil {
		t.Fatal(err)
	}
	var scr rframe.Screen
	// frameUntil reads frames until the screen shows want: the mark of that frame.
	frameUntil := func(want string) uint64 {
		t.Helper()
		deadline := time.After(5 * time.Second)
		for {
			select {
			case f := <-st.Frames:
				fr, err := rframe.Decode(f.Data)
				if err != nil {
					t.Fatal(err)
				}
				if err := scr.Apply(fr); err != nil {
					t.Fatal(err)
				}
				st.AckFrame(ctx(t), fr.Seq)
				if strings.Contains(strings.Join(scr.Text(), "\n"), want) {
					return f.Mark
				}
			case <-deadline:
				t.Fatalf("no frame showed %q", want)
			}
		}
	}
	// "hello" and the pty's CR LF: 7 bytes.
	if m := frameUntil("hello"); m != 7 {
		t.Fatalf("the first frame's mark %d, want 7", m)
	}
	s := call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"text": "abc", "mode": "raw"}}})
	if m := frameUntil("abc"); m < s.Mark+3 {
		t.Fatalf("the echo's frame mark %d, want at least %d (the mark before the input and its 3 bytes)", m, s.Mark+3)
	}
}

func TestRenderScrollback(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", `i=1; while [ $i -le 100 ]; do echo line$i; i=$((i+1)); done; exec cat`}})
	st, err := c.Render(ctx(t), p.ID, client.RenderOptions{Cols: 40, Rows: 10})
	if err != nil {
		t.Fatal(err)
	}
	r := &renderClient{t: t, st: st}
	r.until("line100")
	if err := st.Scroll(ctx(t), 50); err != nil {
		t.Fatal(err)
	}
	for r.scr.Offset != 50 {
		if r.next(5*time.Second) == nil {
			t.Fatalf("no scrolled frame; offset %d", r.scr.Offset)
		}
	}
	text := strings.Join(r.scr.Text(), "\n")
	if !strings.Contains(text, "line50") || strings.Contains(text, "line100") {
		t.Errorf("scrolled 50 up:\n%s", text)
	}
	// Output while scrolled does not move the view (input sent by
	// another client than this stream's, which would bring it back).
	top := r.scr.History - r.scr.Offset
	call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"text": "more\r", "mode": "raw"}}})
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && r.scr.History-r.scr.Offset == top && r.scr.Offset == 50 {
		r.next(100 * time.Millisecond)
	}
	if got := r.scr.History - r.scr.Offset; got != top {
		t.Errorf("the view's top moved from %d to %d", top, got)
	}
	// Text from the scrollback, beyond the view: lines 1 to 3.
	got, err := st.Text(ctx(t), proto.RenderPoint{X: 0, Y: 0}, proto.RenderPoint{X: 39, Y: 2}, false)
	if err != nil {
		t.Fatal(err)
	}
	if got != "line1\nline2\nline3" {
		t.Errorf("text of rows 0 to 2: %q", got)
	}
	// Back to the live screen.
	if err := st.Scroll(ctx(t), 0); err != nil {
		t.Fatal(err)
	}
	r.until("more")
	if r.scr.Offset != 0 {
		t.Errorf("offset %d after scrolling back", r.scr.Offset)
	}
}

// TestRenderMouse sends mouse events to a program that asked for them.
func TestRenderMouse(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", `printf '\033[?1000h\033[?1006h\033[?1004hready\n'; stty -echo raw; od -c`}})
	st, err := c.Render(ctx(t), p.ID, client.RenderOptions{Cols: 40, Rows: 10})
	if err != nil {
		t.Fatal(err)
	}
	r := &renderClient{t: t, st: st}
	r.until("ready")
	if r.scr.Modes&0x1 == 0 {
		t.Fatalf("modes %b: want mouse reporting", r.scr.Modes)
	}
	if err := st.Events(ctx(t), []proto.RenderEvent{
		{Mouse: &proto.RenderMouse{Action: "press", Button: "left", X: 25, Y: 45, CellWidth: 10, CellHeight: 20}},
		{Mouse: &proto.RenderMouse{Action: "release", Button: "left", X: 25, Y: 45, CellWidth: 10, CellHeight: 20}},
		{Focus: ptr(true)},
	}); err != nil {
		t.Fatal(err)
	}
	// od prints the bytes: ESC [ < 0 ; 3 ; 3 M (column 3, row 3).
	r.until("033   [   <   0   ;   3   ;   3")
}
