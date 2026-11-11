package server

import (
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/coder/websocket"

	"ravenryd/internal/pane"
	"ravenryd/internal/proto"
	"ravenryd/internal/rframe"
	"ravenryd/internal/vt"
)

// The render stream (docs/RENDERING.md): a pane's screen as frames of
// changed rows for a client that draws it itself, and that client's
// input as key and mouse events the daemon encodes.

func (c *conn) paneRender(id uint64, data []byte) {
	var r proto.RenderRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	p, err := c.pane(r.Pane)
	if err != nil {
		c.failErr(id, err)
		return
	}
	if (r.Cols == nil) != (r.Rows == nil) {
		c.failErr(id, bad("cols and rows go together"))
		return
	}
	if r.Cols != nil {
		if *r.Cols < 1 || *r.Rows < 1 || *r.Cols > 4096 || *r.Rows > 4096 {
			c.failErr(id, bad("cols and rows must be between 1 and 4096"))
			return
		}
		if err := p.Resize(*r.Cols, *r.Rows); err != nil {
			c.failErr(id, err)
			return
		}
	}
	o := pane.RenderOptions{}
	if r.FPS != nil {
		if *r.FPS < 1 || *r.FPS > 240 {
			c.failErr(id, bad("fps must be between 1 and 240"))
			return
		}
		o.FPS = *r.FPS
	}
	if r.Window != nil {
		if *r.Window < 1 || *r.Window > 64 {
			c.failErr(id, bad("window must be between 1 and 64 frames"))
			return
		}
		o.Window = *r.Window
	}
	var binds []vt.KeyBind
	if r.Keybinds != nil {
		if binds, err = vt.Keybinds(*r.Keybinds); err != nil {
			c.failErr(id, bad("%v", err))
			return
		}
	}
	rs, err := p.Render(o)
	if err != nil {
		c.failErr(id, err)
		return
	}
	c.mu.Lock()
	c.next++
	ch := c.next
	st := &stream{ch: ch, p: p, rsub: rs, binds: binds}
	c.streams[ch] = st
	c.mu.Unlock()
	c.reply(id, "pane.render", proto.RenderResult{Pane: r.Pane, Channel: ch, Format: rframe.Version})
	go c.renderStream(st)
}

func (c *conn) renderStream(st *stream) {
	var err error
	for {
		var b []byte
		b, err = st.rsub.Next(c.ctx)
		if err != nil {
			break
		}
		// The header's mark: the output position the frame shows.
		buf := proto.AppendFrame(make([]byte, 0, proto.FrameHeader+len(b)), proto.FrameRender, st.ch, st.rsub.FrameMark())
		buf = append(buf, b...)
		if c.write(websocket.MessageBinary, buf) != nil {
			c.cancel()
			return
		}
	}
	c.mu.Lock()
	_, mine := c.streams[st.ch]
	delete(c.streams, st.ch)
	c.mu.Unlock()
	st.rsub.Close()
	if errors.Is(err, io.EOF) && mine {
		ch, mark := st.ch, st.p.Mark()
		c.writeJSON(proto.Event{V: proto.Version, Type: "event", Event: "stream.end", Channel: &ch, Mark: &mark})
	}
}

// renderChannel finds a render stream of this connection.
func (c *conn) renderChannel(ch *uint32) (*stream, error) {
	if ch == nil {
		return nil, bad("channel is required")
	}
	c.mu.Lock()
	st := c.streams[*ch]
	c.mu.Unlock()
	if st == nil {
		return nil, fmt.Errorf("%w: %d", errNoChannel, *ch)
	}
	if st.rsub == nil {
		return nil, bad("channel %d is not a render stream", *ch)
	}
	return st, nil
}

func (c *conn) renderScroll(id uint64, data []byte) {
	var r proto.RenderScrollRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	st, err := c.renderChannel(r.Channel)
	if err != nil {
		c.failErr(id, err)
		return
	}
	if r.Offset == nil || *r.Offset < 0 {
		c.failErr(id, bad("offset must be 0 or more"))
		return
	}
	st.rsub.Scroll(*r.Offset)
	c.reply(id, "render.scroll", proto.Empty{})
}

func (c *conn) renderText(id uint64, data []byte) {
	var r proto.RenderTextRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	st, err := c.renderChannel(r.Channel)
	if err != nil {
		c.failErr(id, err)
		return
	}
	if r.From.X < 0 || r.From.Y < 0 || r.To.X < 0 || r.To.Y < 0 {
		c.failErr(id, bad("points must not be negative"))
		return
	}
	text, err := st.p.TextRange(r.From.X, r.From.Y, r.To.X, r.To.Y, r.Rect)
	if err != nil {
		c.failErr(id, err)
		return
	}
	text, _ = inputText(st.p, text)
	c.reply(id, "render.text", proto.RenderTextResult{Text: text})
}

func (c *conn) renderInput(id uint64, data []byte) {
	var r proto.RenderInputRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	st, err := c.renderChannel(r.Channel)
	if err != nil {
		c.failErr(id, err)
		return
	}
	var out []byte
	for i, ev := range r.Events {
		n := 0
		for _, set := range []bool{ev.Key != nil, ev.Mouse != nil, ev.Text != nil, ev.Paste != nil, ev.Focus != nil,
			ev.Wheel != nil, ev.Select != nil, ev.Paths != nil} {
			if set {
				n++
			}
		}
		if n != 1 {
			c.failErr(id, bad("events[%d]: exactly one of key, mouse, text, paste, focus, wheel, select, paths", i))
			return
		}
		var b []byte
		var err error
		switch {
		case ev.Key != nil:
			k := ev.Key
			if k.Mods < 0 || k.Mods > 63 || k.Consumed < 0 || k.Consumed > 63 || k.Unshifted < 0 || k.Unshifted > 0x10ffff {
				c.failErr(id, bad("events[%d]: bad key fields", i))
				return
			}
			ke := vt.KeyEvent{Code: k.Code, Action: k.Action, Mods: uint8(k.Mods), Consumed: uint8(k.Consumed),
				Text: k.Text, Unshifted: rune(k.Unshifted), Composing: k.Composing, OptionAsAlt: k.OptionAsAlt}
			if bound, ok := vt.BoundKey(st.binds, ke); ok {
				b = bound
			} else {
				b, err = st.p.EncodeInput(func(s vt.Screen) ([]byte, error) { return s.EncodeKeyEvent(ke) })
			}
		case ev.Mouse != nil:
			m := ev.Mouse
			if m.Mods < 0 || m.Mods > 63 {
				c.failErr(id, bad("events[%d]: bad mouse mods", i))
				return
			}
			me := vt.MouseEvent{Action: m.Action, Button: m.Button, Mods: uint8(m.Mods), X: m.X, Y: m.Y,
				CellWidth: m.CellWidth, CellHeight: m.CellHeight, Held: m.Held}
			b, err = st.p.EncodeInput(func(s vt.Screen) ([]byte, error) { return s.EncodeMouse(me) })
		case ev.Text != nil:
			b = []byte(*ev.Text)
		case ev.Paste != nil:
			text := []byte(*ev.Paste)
			b, err = st.p.EncodeInput(func(s vt.Screen) ([]byte, error) { return s.EncodePaste(text) })
		case ev.Focus != nil:
			focused := *ev.Focus
			b, err = st.p.EncodeInput(func(s vt.Screen) ([]byte, error) { return s.EncodeFocus(focused) })
		case ev.Wheel != nil:
			b, err = wheel(st, ev.Wheel)
		case ev.Select != nil:
			sl := ev.Select
			switch sl.Action {
			case "press", "drag", "release", "all", "clear":
			default:
				c.failErr(id, bad("events[%d]: select action must be press, drag, release, all or clear", i))
				return
			}
			err = st.p.Select(vt.SelectEvent{Action: sl.Action, X: sl.Col, Y: sl.Row, PX: sl.X, PY: sl.Y,
				CellWidth: sl.CellWidth, CellHeight: sl.CellHeight, Extend: sl.Extend, Rect: sl.Rect})
		case ev.Paths != nil:
			text := []byte(quotePaths(ev.Paths))
			b, err = st.p.EncodeInput(func(s vt.Screen) ([]byte, error) { return s.EncodePaste(text) })
		}
		if err != nil {
			c.failErr(id, bad("events[%d]: %v", i, err))
			return
		}
		if len(b) > 0 && (ev.Key != nil || ev.Text != nil || ev.Paste != nil || ev.Paths != nil) && st.rsub.Scrolled() {
			// Typing or pasting brings the view back to the live screen.
			st.rsub.Scroll(0)
		}
		out = append(out, b...)
	}
	c.reply(id, "render.input", proto.Empty{})
	if len(out) > 0 {
		c.keys(st, out)
	}
}

// wheel takes a wheel movement as Ghostty does: to the program when it
// asked for the mouse, as arrow keys on the alternate screen (mode 1007),
// otherwise it scrolls the stream's view. It returns the bytes for the
// program.
func wheel(st *stream, w *proto.RenderWheel) ([]byte, error) {
	rows := st.rsub.Wheel(w.Rows)
	if rows == 0 {
		return nil, nil
	}
	n := min(abs(rows), 20)
	modes := st.rsub.Modes()
	var out []byte
	switch {
	case modes&vt.ModeMouse != 0:
		button := "wheel_up"
		if rows < 0 {
			button = "wheel_down"
		}
		me := vt.MouseEvent{Action: "press", Button: button, Mods: uint8(w.Mods & 15), X: w.X, Y: w.Y,
			CellWidth: w.CellWidth, CellHeight: w.CellHeight}
		for range n {
			b, err := st.p.EncodeInput(func(s vt.Screen) ([]byte, error) { return s.EncodeMouse(me) })
			if err != nil {
				return nil, err
			}
			out = append(out, b...)
		}
	case modes&vt.ModeAltScreen != 0:
		if modes&vt.ModeAltScroll == 0 {
			return nil, nil
		}
		code := "ArrowUp"
		if rows < 0 {
			code = "ArrowDown"
		}
		for range n {
			b, err := st.p.EncodeInput(func(s vt.Screen) ([]byte, error) {
				return s.EncodeKeyEvent(vt.KeyEvent{Code: code, Action: "press"})
			})
			if err != nil {
				return nil, err
			}
			out = append(out, b...)
		}
	default:
		st.rsub.ScrollBy(rows)
	}
	return out, nil
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// quotePaths joins file paths for a shell, each quoted: characters a
// shell reads specially get a backslash, as Ghostty and Terminal do.
func quotePaths(paths []string) string {
	var b strings.Builder
	for i, p := range paths {
		if i > 0 {
			b.WriteByte(' ')
		}
		for _, r := range p {
			if r < 0x80 && strings.ContainsRune(" \t\\'\"`$&|;<>()[]{}*?!#~", r) {
				b.WriteByte('\\')
			}
			b.WriteRune(r)
		}
	}
	return b.String()
}

func (c *conn) renderCopy(id uint64, data []byte) {
	var r proto.RenderChannelRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	st, err := c.renderChannel(r.Channel)
	if err != nil {
		c.failErr(id, err)
		return
	}
	text, err := st.p.SelectionText()
	if err != nil {
		c.failErr(id, err)
		return
	}
	text, _ = inputText(st.p, text)
	c.reply(id, "render.copy", proto.RenderTextResult{Text: text})
}

func (c *conn) renderFind(id uint64, data []byte) {
	var r proto.RenderFindRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	st, err := c.renderChannel(r.Channel)
	if err != nil {
		c.failErr(id, err)
		return
	}
	if r.Step < -1 || r.Step > 1 {
		c.failErr(id, bad("step must be -1, 0 or 1"))
		return
	}
	count, sel, err := st.rsub.Find(r.Needle, vt.FindOptions{CaseSensitive: r.CaseSensitive, Regex: r.Regex}, r.Step)
	var pe *vt.PatternError
	if errors.As(err, &pe) {
		// Typing a pattern passes through ones that do not parse yet: an
		// answer, not an error.
		c.reply(id, "render.find", proto.RenderFindResult{Count: 0, Selected: -1, PatternError: pe.Reason})
		return
	}
	if err != nil {
		c.failErr(id, err)
		return
	}
	marks, lines := st.rsub.FindMarks(proto.FindMarksMax)
	c.reply(id, "render.find", proto.RenderFindResult{Count: count, Selected: sel, Rows: marks, Lines: lines})
}

func (c *conn) renderLink(id uint64, data []byte) {
	var r proto.RenderLinkRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	st, err := c.renderChannel(r.Channel)
	if err != nil {
		c.failErr(id, err)
		return
	}
	l, ok := st.p.LinkAt(r.At.X, r.At.Y)
	if !ok {
		c.reply(id, "render.link", proto.RenderLinkResult{})
		return
	}
	c.reply(id, "render.link", proto.RenderLinkResult{URI: l.URI,
		From: &proto.RenderPoint{X: l.Span.X0, Y: l.Span.Y0}, To: &proto.RenderPoint{X: l.Span.X1, Y: l.Span.Y1}})
}
