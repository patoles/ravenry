package server

import (
	"errors"
	"fmt"
	"io"

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
	rs, err := p.Render(o)
	if err != nil {
		c.failErr(id, err)
		return
	}
	c.mu.Lock()
	c.next++
	ch := c.next
	st := &stream{ch: ch, p: p, rsub: rs}
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
		buf := proto.AppendFrame(make([]byte, 0, proto.FrameHeader+len(b)), proto.FrameRender, st.ch, 0)
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
		for _, set := range []bool{ev.Key != nil, ev.Mouse != nil, ev.Text != nil, ev.Paste != nil, ev.Focus != nil} {
			if set {
				n++
			}
		}
		if n != 1 {
			c.failErr(id, bad("events[%d]: exactly one of key, mouse, text, paste, focus", i))
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
			b, err = st.p.EncodeInput(func(s vt.Screen) ([]byte, error) { return s.EncodeKeyEvent(ke) })
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
		}
		if err != nil {
			c.failErr(id, bad("events[%d]: %v", i, err))
			return
		}
		out = append(out, b...)
	}
	c.reply(id, "render.input", proto.Empty{})
	if len(out) > 0 {
		c.keys(st, out)
	}
}
