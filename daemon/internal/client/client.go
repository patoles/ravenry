// Package client is a Go client of the Ravenry protocol. The ravenryd CLI
// and the tests use it.
package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"ravenryd/internal/proto"
)

// Error is an error the daemon returned.
type Error struct {
	Code    string
	Message string
	// Checkpoint: the drive checkpoint a refused input opened.
	Checkpoint string
	// Lease: the lease that holds the pane (leased).
	Lease *proto.Lease
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Options configures a connection.
type Options struct {
	// Name and Version identify the client in hello.
	Name, Version string
	// OnMessage, when set, sees every message in both directions: dir is
	// "send" or "recv", text says whether it is JSON.
	OnMessage func(dir string, text bool, data []byte)
	// SkipHello leaves out the hello request (tests of the protocol use it).
	SkipHello bool
	// AnswerKey goes in hello: over ssh, the key that lets a hub act as
	// the person (PROTOCOL.md section 4, Who acts as the person).
	AnswerKey string
}

// Frame is a binary frame of a stream.
type Frame struct {
	Snapshot bool
	// Render: a render stream's frame (docs/RENDERING.md); Data is its
	// payload, read with package rframe.
	Render bool
	Mark   uint64
	Data   []byte
}

// Stream is a subscription to a pane's output.
type Stream struct {
	c       *Client
	Channel uint32
	// Frames delivers the stream's frames; it is closed when the stream
	// ends (End is then set) or the connection drops.
	Frames chan Frame
	// End is the mark the stream ended at, after Frames is closed by a
	// stream.end event.
	End *uint64
}

// Client is one connection to a daemon.
type Client struct {
	o       Options
	ws      *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	next    uint64
	pending map[uint64]chan reply
	streams map[uint32]*Stream
	events  chan proto.Event
	err     error
	// Hello is the daemon's answer to hello.
	Hello  proto.HelloResult
	done   chan struct{}
	socket string
}

type reply struct {
	result json.RawMessage
	stream *Stream
	err    error
}

// Dial connects to a daemon's unix socket.
func Dial(ctx context.Context, socket string, o Options) (*Client, error) {
	c, err := DialWith(ctx, func(ctx context.Context) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", socket)
	}, o)
	if c != nil {
		c.socket = socket
	}
	return c, err
}

// Socket is the unix socket the client dialled, or empty.
func (c *Client) Socket() string { return c.socket }

// DialWith connects over any byte stream, such as the standard input and
// output of `ssh host ravenryd proxy`.
func DialWith(ctx context.Context, dial func(context.Context) (net.Conn, error), o Options) (*Client, error) {
	hc := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return dial(ctx) },
	}}
	ws, _, err := websocket.Dial(ctx, "ws://ravenryd"+proto.Path, &websocket.DialOptions{
		HTTPClient:      hc,
		Subprotocols:    []string{proto.Subprotocol},
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return nil, err
	}
	ws.SetReadLimit(64 << 20)
	cctx, cancel := context.WithCancel(context.Background())
	c := &Client{
		o: o, ws: ws, ctx: cctx, cancel: cancel,
		pending: map[uint64]chan reply{}, streams: map[uint32]*Stream{},
		events: make(chan proto.Event, 1024), done: make(chan struct{}),
	}
	go c.readLoop()
	if o.SkipHello {
		return c, nil
	}
	if o.Name == "" {
		o.Name = "ravenryd-client"
	}
	hello := map[string]any{"client": proto.ClientInfo{Name: o.Name, Version: o.Version}}
	if o.AnswerKey != "" {
		hello["answer_key"] = o.AnswerKey
	}
	err = c.Call(ctx, "hello", hello, &c.Hello)
	if err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

// Close closes the connection.
func (c *Client) Close() error {
	c.cancel()
	err := c.ws.Close(websocket.StatusNormalClosure, "")
	<-c.done
	return err
}

// Done is closed when the connection has ended.
func (c *Client) Done() <-chan struct{} { return c.done }

// Events delivers events after SubscribeEvents.
func (c *Client) Events() <-chan proto.Event { return c.events }

func (c *Client) readLoop() {
	defer close(c.done)
	var err error
	for {
		var typ websocket.MessageType
		var data []byte
		typ, data, err = c.ws.Read(c.ctx)
		if err != nil {
			break
		}
		if c.o.OnMessage != nil {
			c.o.OnMessage("recv", typ == websocket.MessageText, data)
		}
		if typ == websocket.MessageBinary {
			kind, ch, mark, payload, perr := proto.ParseFrame(data)
			if perr != nil {
				continue
			}
			c.mu.Lock()
			st := c.streams[ch]
			c.mu.Unlock()
			if st != nil {
				select {
				case st.Frames <- Frame{Snapshot: kind == proto.FrameSnapshot, Render: kind == proto.FrameRender, Mark: mark, Data: payload}:
				case <-c.ctx.Done():
				}
			}
			continue
		}
		c.text(data)
	}
	c.mu.Lock()
	c.err = err
	pending := c.pending
	c.pending = map[uint64]chan reply{}
	streams := c.streams
	c.streams = map[uint32]*Stream{}
	c.mu.Unlock()
	for _, ch := range pending {
		ch <- reply{err: fmt.Errorf("connection closed: %w", err)}
	}
	for _, st := range streams {
		close(st.Frames)
	}
	close(c.events)
}

func (c *Client) text(data []byte) {
	var m struct {
		Type   string           `json:"type"`
		ID     *uint64          `json:"id"`
		Method string           `json:"method"`
		Result json.RawMessage  `json:"result"`
		Error  *proto.ErrorBody `json:"error"`
	}
	if json.Unmarshal(data, &m) != nil {
		return
	}
	switch m.Type {
	case "result", "error":
		if m.ID == nil {
			return
		}
		var st *Stream
		c.mu.Lock()
		ch := c.pending[*m.ID]
		delete(c.pending, *m.ID)
		if m.Type == "result" && (m.Method == "pane.subscribe" || m.Method == "pane.render") {
			// Register the stream before reading on, so its first frame,
			// which follows this result, has somewhere to go.
			var r proto.SubscribeResult
			if json.Unmarshal(m.Result, &r) == nil {
				st = &Stream{c: c, Channel: r.Channel, Frames: make(chan Frame, 256)}
				c.streams[r.Channel] = st
			}
		}
		c.mu.Unlock()
		if ch == nil {
			return
		}
		if m.Type == "error" && m.Error != nil {
			ch <- reply{err: &Error{Code: m.Error.Code, Message: m.Error.Message, Checkpoint: m.Error.Checkpoint, Lease: m.Error.Lease}}
		} else {
			ch <- reply{result: m.Result, stream: st}
		}
	case "event":
		var ev proto.Event
		if json.Unmarshal(data, &ev) != nil {
			return
		}
		if ev.Event == "stream.end" && ev.Channel != nil {
			c.mu.Lock()
			st := c.streams[*ev.Channel]
			delete(c.streams, *ev.Channel)
			c.mu.Unlock()
			if st != nil {
				st.End = ev.Mark
				close(st.Frames)
			}
			return
		}
		select {
		case c.events <- ev:
		default:
		}
	}
}

// Call sends a request and waits for its result, decoded into out.
func (c *Client) Call(ctx context.Context, method string, params any, out any) error {
	r, err := c.call(ctx, method, params)
	if err != nil {
		return err
	}
	if out != nil {
		return json.Unmarshal(r.result, out)
	}
	return nil
}

func (c *Client) call(ctx context.Context, method string, params any) (reply, error) {
	id, ch, err := c.send(ctx, method, params)
	if err != nil {
		return reply{}, err
	}
	select {
	case r := <-ch:
		return r, r.err
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		// Tell the daemon to stop working on it; ignore the answer.
		cctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		c.send(cctx, "cancel", map[string]any{"request": id})
		return reply{}, ctx.Err()
	}
}

func (c *Client) send(ctx context.Context, method string, params any) (uint64, chan reply, error) {
	fields := map[string]json.RawMessage{}
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return 0, nil, err
		}
		if err := json.Unmarshal(b, &fields); err != nil {
			return 0, nil, fmt.Errorf("params must be a JSON object: %w", err)
		}
		if fields == nil {
			fields = map[string]json.RawMessage{}
		}
	}
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return 0, nil, c.err
	}
	c.next++
	id := c.next
	ch := make(chan reply, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	fields["v"], _ = json.Marshal(proto.Version)
	fields["type"], _ = json.Marshal(method)
	fields["id"], _ = json.Marshal(id)
	b, _ := json.Marshal(fields)
	if err := c.writeText(ctx, b); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return 0, nil, err
	}
	return id, ch, nil
}

func (c *Client) writeText(ctx context.Context, b []byte) error {
	if c.o.OnMessage != nil {
		c.o.OnMessage("send", true, b)
	}
	return c.ws.Write(ctx, websocket.MessageText, b)
}

// WriteRaw sends a text message as it is (tests use it for bad input).
func (c *Client) WriteRaw(ctx context.Context, b []byte) error { return c.writeText(ctx, b) }

// WriteBinary sends a binary frame as it is.
func (c *Client) WriteBinary(ctx context.Context, b []byte) error {
	if c.o.OnMessage != nil {
		c.o.OnMessage("send", false, b)
	}
	return c.ws.Write(ctx, websocket.MessageBinary, b)
}

// SubscribeEvents turns on pane events for this connection.
func (c *Client) SubscribeEvents(ctx context.Context) error {
	return c.Call(ctx, "events.subscribe", nil, nil)
}

// SubscribeOptions configures Subscribe.
type SubscribeOptions struct {
	Since  *uint64
	Ack    bool
	Window int
	// KittyKeyboard: this client sends keys in the Kitty keyboard
	// protocol's encodings when the program turns them on.
	KittyKeyboard bool
}

// Subscribe streams a pane's output: a snapshot first (or the output from
// Since), then live output.
func (c *Client) Subscribe(ctx context.Context, pane string, o SubscribeOptions) (*Stream, error) {
	params := map[string]any{"pane": pane}
	if o.Since != nil {
		params["since"] = *o.Since
	}
	if o.Ack {
		params["ack"] = true
	}
	if o.Window != 0 {
		params["window"] = o.Window
	}
	if o.KittyKeyboard {
		params["kitty_keyboard"] = true
	}
	r, err := c.call(ctx, "pane.subscribe", params)
	if err != nil {
		return nil, err
	}
	if r.stream == nil {
		return nil, errors.New("pane.subscribe answered without a channel")
	}
	return r.stream, nil
}

// Ack acknowledges n processed bytes of the stream.
func (s *Stream) Ack(ctx context.Context, n int) error {
	b, _ := json.Marshal(proto.Ack{V: proto.Version, Type: "ack", Channel: s.Channel, Bytes: int64(n)})
	return s.c.writeText(ctx, b)
}

// Input sends bytes to the pane as they are, in a binary frame.
func (s *Stream) Input(ctx context.Context, b []byte) error {
	buf := proto.AppendFrame(make([]byte, 0, proto.FrameHeader+len(b)), proto.FrameInput, s.Channel, 0)
	return s.c.WriteBinary(ctx, append(buf, b...))
}

// Close ends the stream.
func (s *Stream) Close(ctx context.Context) error {
	return s.c.Call(ctx, "pane.unsubscribe", map[string]any{"channel": s.Channel}, nil)
}

// RenderOptions configures a render stream (pane.render).
type RenderOptions struct {
	// Cols and Rows resize the pane first, when set.
	Cols, Rows int
	FPS        int
	Window     int
}

// Render streams a pane's screen as render frames (docs/RENDERING.md).
// The client acknowledges each frame it draws with AckFrame.
func (c *Client) Render(ctx context.Context, pane string, o RenderOptions) (*Stream, error) {
	params := map[string]any{"pane": pane}
	if o.Cols > 0 {
		params["cols"], params["rows"] = o.Cols, o.Rows
	}
	if o.FPS > 0 {
		params["fps"] = o.FPS
	}
	if o.Window > 0 {
		params["window"] = o.Window
	}
	r, err := c.call(ctx, "pane.render", params)
	if err != nil {
		return nil, err
	}
	if r.stream == nil {
		return nil, errors.New("pane.render answered without a channel")
	}
	return r.stream, nil
}

// AckFrame says the client drew the render stream's frames up to seq.
func (s *Stream) AckFrame(ctx context.Context, seq uint32) error {
	b, _ := json.Marshal(proto.Ack{V: proto.Version, Type: "ack", Channel: s.Channel, Frame: &seq})
	return s.c.writeText(ctx, b)
}

// Scroll shows the render stream's view offset rows up into the
// scrollback; 0 is the live screen.
func (s *Stream) Scroll(ctx context.Context, offset int) error {
	return s.c.Call(ctx, "render.scroll", map[string]any{"channel": s.Channel, "offset": offset}, nil)
}

// Events sends input events (key, mouse, text, paste, focus) on a render
// stream; the daemon encodes them for the program.
func (s *Stream) Events(ctx context.Context, events []proto.RenderEvent) error {
	return s.c.Call(ctx, "render.input", proto.RenderInputRequest{Channel: &s.Channel, Events: events}, nil)
}

// Text reads the text between two cells in screen coordinates.
func (s *Stream) Text(ctx context.Context, from, to proto.RenderPoint, rect bool) (string, error) {
	var r proto.RenderTextResult
	err := s.c.Call(ctx, "render.text", map[string]any{"channel": s.Channel, "from": from, "to": to, "rect": rect}, &r)
	return r.Text, err
}

// Copy reads the pane's selection as a copy reads it.
func (s *Stream) Copy(ctx context.Context) (string, error) {
	var r proto.RenderTextResult
	err := s.c.Call(ctx, "render.copy", map[string]any{"channel": s.Channel}, &r)
	return r.Text, err
}

// Find searches the pane for needle on this stream (render.find).
func (s *Stream) Find(ctx context.Context, needle string, step int) (proto.RenderFindResult, error) {
	var r proto.RenderFindResult
	err := s.c.Call(ctx, "render.find", map[string]any{"channel": s.Channel, "needle": needle, "step": step}, &r)
	return r, err
}

// Link reads the link on a cell in screen coordinates.
func (s *Stream) Link(ctx context.Context, at proto.RenderPoint) (proto.RenderLinkResult, error) {
	var r proto.RenderLinkResult
	err := s.c.Call(ctx, "render.link", map[string]any{"channel": s.Channel, "at": at}, &r)
	return r, err
}
