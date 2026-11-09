// Package server speaks the Ravenry protocol (packages/protocol) to
// clients: WebSocket over a unix socket or over `ravenryd proxy`, JSON
// for control and binary frames for terminal bytes.
package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"

	"ravenryd/internal/agent"
	"ravenryd/internal/pane"
	"ravenryd/internal/paths"
	"ravenryd/internal/proto"
	"ravenryd/internal/vt"
)

// Options configures a Server.
type Options struct {
	Version string
	Manager *pane.Manager
	// Socket is this daemon's own socket, left out when looking for newer
	// daemons.
	Socket string
	Log    *log.Logger
	// OnDrained is called once a newer daemon runs and this one has no
	// running panes left.
	OnDrained func()
	// AnswerKeyFile keeps the answer key this machine trusts over ssh
	// (peer.go). Empty: kept in memory.
	AnswerKeyFile string
	// StateDir holds the files a pick's shots and replays need. Empty:
	// beside the pane logs.
	StateDir string
}

// Server serves the protocol.
type Server struct {
	o        Options
	started  time.Time
	srv      *http.Server
	mu       sync.Mutex
	conns    map[*conn]struct{}
	draining string
	stop     chan struct{}
	stopOnce sync.Once

	agents    *agent.Tracker
	deciders  map[*conn]struct{}
	decisions map[uint64]*decision
	nextDec   uint64

	cps *checkpoints

	keys *answerKeys

	drive *driveState
}

// decision is a hook's report waiting for a decider's reply.
type decision struct {
	asked map[*conn]bool // deciders that have not answered yet
	ch    chan *proto.Reply
}

// New returns a Server.
func New(o Options) *Server {
	if o.Log == nil {
		o.Log = log.New(io.Discard, "", 0)
	}
	s := &Server{
		o: o, started: time.Now(), conns: map[*conn]struct{}{}, stop: make(chan struct{}),
		agents: agent.New(), deciders: map[*conn]struct{}{}, decisions: map[uint64]*decision{},
	}
	s.agents.Alive = processAlive
	s.cps = newCheckpoints()
	s.drive = newDriveState()
	s.keys = &answerKeys{path: o.AnswerKeyFile}
	o.Manager.WantActivity(func() bool {
		return len(s.connections(func(c *conn) bool { return c.unwatch != nil && c.activity })) > 0
	})
	s.srv = &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second, ErrorLog: o.Log, ConnContext: connContext}
	o.Manager.Watch(s.paneEvent)
	return s
}

// Serve accepts connections until Close.
func (s *Server) Serve(ln net.Listener) error {
	err := s.srv.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// Close stops accepting connections and closes the open ones.
func (s *Server) Close() {
	s.stopOnce.Do(func() { close(s.stop) })
	s.srv.Close()
	s.mu.Lock()
	conns := make([]*conn, 0, len(s.conns))
	for c := range s.conns {
		conns = append(conns, c)
	}
	s.mu.Unlock()
	for _, c := range conns {
		c.ws.Close(websocket.StatusGoingAway, "the daemon is stopping")
	}
}

// WatchForNewer looks for a newer daemon version beside this one every
// interval. When one answers, it tells every client (daemon.draining),
// and once no pane of this daemon is running it calls OnDrained.
func (s *Server) WatchForNewer(interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-t.C:
		}
		s.mu.Lock()
		draining := s.draining
		s.mu.Unlock()
		if draining == "" {
			if v := s.newerDaemon(); v != "" {
				s.mu.Lock()
				s.draining = v
				conns := make([]*conn, 0, len(s.conns))
				for c := range s.conns {
					conns = append(conns, c)
				}
				s.mu.Unlock()
				s.o.Log.Printf("a newer daemon (%s) runs beside this one: draining", v)
				for _, c := range conns {
					c.event(proto.Event{V: proto.Version, Type: "event", Event: "daemon.draining", Newer: v})
				}
				draining = v
			}
		}
		if draining != "" && s.o.Manager.Running() == 0 {
			s.o.Log.Printf("no running panes left: exiting for %s", draining)
			if s.o.OnDrained != nil {
				s.o.OnDrained()
			}
			return
		}
	}
}

func (s *Server) newerDaemon() string {
	socks, err := paths.Sockets()
	if err != nil {
		return ""
	}
	for _, sk := range socks {
		if sk.Path == s.o.Socket || paths.CompareVersions(sk.Version, s.o.Version) <= 0 {
			continue
		}
		c, err := net.DialTimeout("unix", sk.Path, time.Second)
		if err != nil {
			continue
		}
		c.Close()
		return sk.Version
	}
	return ""
}

func (s *Server) daemonInfo() proto.DaemonInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	return proto.DaemonInfo{
		Version: s.o.Version, PID: os.Getpid(), OS: runtime.GOOS, Arch: runtime.GOARCH,
		StartedAt: stamp(s.started), Home: home(), Draining: s.draining,
	}
}

// home is the folder clients say as ~ for this machine.
func home() string {
	h, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return h
}

// ServeHTTP upgrades a request on /v1 to a protocol connection.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != proto.Path {
		http.Error(w, "ravenryd speaks the Ravenry protocol on "+proto.Path, http.StatusNotFound)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols:    []string{proto.Subprotocol},
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	if ws.Subprotocol() != proto.Subprotocol {
		ws.Close(websocket.StatusPolicyViolation, "the "+proto.Subprotocol+" subprotocol is required")
		return
	}
	ws.SetReadLimit(16 << 20)
	c := newConn(s, ws)
	s.drive.mu.Lock()
	s.drive.connSeq++
	c.serial = s.drive.connSeq
	s.drive.mu.Unlock()
	if nc, ok := r.Context().Value(connKey{}).(net.Conn); ok {
		c.peer = peerPID(nc)
	}
	s.mu.Lock()
	s.conns[c] = struct{}{}
	s.mu.Unlock()
	c.run()
	s.mu.Lock()
	delete(s.conns, c)
	s.mu.Unlock()
}

func stamp(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// ------------------------------------------------------------ a connection

type conn struct {
	s      *Server
	ws     *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc

	mu       sync.Mutex
	hello    bool
	client   proto.ClientInfo
	streams  map[uint32]*stream
	next     uint32
	reqs     map[uint64]context.CancelFunc
	unwatch  func()
	display  bool
	activity bool

	events chan proto.Event
	input  chan func()

	// peer is the process at the other end of the socket; person says
	// whether it may act as the person, and notPerson why not (peer.go).
	peer      int
	person    bool
	notPerson string
	// agentPane is the pane this connection's program runs in, when it
	// runs in one; serial tells connections apart (drive.go).
	agentPane string
	serial    uint64
}

type stream struct {
	ch  uint32
	p   *pane.Pane
	sub *pane.Sub
	// rsub is set instead of sub for a render stream (render.go).
	rsub *pane.RenderSub
}

// closeSub ends the stream's subscription, of either kind.
func (st *stream) closeSub() {
	if st.rsub != nil {
		st.rsub.Close()
	} else {
		st.sub.Close()
	}
}

func newConn(s *Server, ws *websocket.Conn) *conn {
	ctx, cancel := context.WithCancel(context.Background())
	return &conn{
		s: s, ws: ws, ctx: ctx, cancel: cancel,
		streams: map[uint32]*stream{}, reqs: map[uint64]context.CancelFunc{},
		events: make(chan proto.Event, 1024), input: make(chan func(), 256),
	}
}

func (c *conn) run() {
	defer c.close()
	go c.eventLoop()
	go c.inputLoop()
	for {
		typ, data, err := c.ws.Read(c.ctx)
		if err != nil {
			return
		}
		if typ == websocket.MessageBinary {
			c.binary(data)
			continue
		}
		c.message(data)
	}
}

func (c *conn) close() {
	c.cancel()
	c.mu.Lock()
	streams := c.streams
	c.streams = map[uint32]*stream{}
	unwatch := c.unwatch
	c.unwatch = nil
	c.mu.Unlock()
	for _, st := range streams {
		st.closeSub()
	}
	if unwatch != nil {
		unwatch()
	}
	c.s.dropDecider(c)
	c.s.connGone(c)
	c.ws.CloseNow()
}

func (c *conn) eventLoop() {
	for {
		select {
		case <-c.ctx.Done():
			return
		case ev := <-c.events:
			if c.writeJSON(ev) != nil {
				return
			}
		}
	}
}

func (c *conn) inputLoop() {
	for {
		select {
		case <-c.ctx.Done():
			return
		case f := <-c.input:
			f()
		}
	}
}

// event queues an event. A client too slow to take its events is
// disconnected rather than allowed to hold up the panes.
func (c *conn) event(ev proto.Event) {
	select {
	case c.events <- ev:
	default:
		c.s.o.Log.Printf("client %q is not reading its events: disconnecting it", c.client.Name)
		c.cancel()
	}
}

func (c *conn) write(typ websocket.MessageType, b []byte) error {
	ctx, cancel := context.WithTimeout(c.ctx, 30*time.Second)
	defer cancel()
	return c.ws.Write(ctx, typ, b)
}

func (c *conn) writeJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.write(websocket.MessageText, b)
}

func (c *conn) reply(id uint64, method string, result any) {
	c.writeJSON(proto.Result{V: proto.Version, Type: "result", ID: id, Method: method, Result: result})
}

func (c *conn) fail(id *uint64, code, msg string) {
	c.writeJSON(proto.Error{V: proto.Version, Type: "error", ID: id, Error: proto.ErrorBody{Code: code, Message: msg}})
}

// failErr maps an error to its protocol code.
func (c *conn) failErr(id uint64, err error) {
	code := proto.CodeFailed
	var bad badRequest
	switch {
	case errors.As(err, &bad):
		code = proto.CodeBadRequest
	case errors.Is(err, pane.ErrNotFound), errors.Is(err, errNoChannel), errors.As(err, new(notFoundErr)):
		code = proto.CodeNotFound
	case errors.Is(err, pane.ErrClosed):
		code = proto.CodePaneClosed
	case errors.Is(err, context.Canceled):
		code = proto.CodeCancelled
	}
	var de driveErr
	var le leasedErr
	switch {
	case errors.As(err, &de):
		c.writeJSON(proto.Error{V: proto.Version, Type: "error", ID: &id, Error: proto.ErrorBody{Code: proto.CodeForbidden, Message: de.msg, Checkpoint: de.cp}})
		return
	case errors.As(err, &le):
		l := le.lease
		c.writeJSON(proto.Error{V: proto.Version, Type: "error", ID: &id, Error: proto.ErrorBody{Code: proto.CodeLeased, Message: le.msg, Lease: &l}})
		return
	}
	c.fail(&id, code, err.Error())
}

// notFound is an error with the code not_found.
func notFound(format string, a ...any) error { return notFoundErr{fmt.Sprintf(format, a...)} }

type notFoundErr struct{ msg string }

func (e notFoundErr) Error() string { return e.msg }

type badRequest struct{ msg string }

func (b badRequest) Error() string { return b.msg }

func bad(format string, a ...any) error { return badRequest{fmt.Sprintf(format, a...)} }

var errNoChannel = errors.New("no such channel")

// decode reads a request strictly: unknown fields are an error.
func decode(data []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return bad("%v", err)
	}
	return nil
}

func (c *conn) message(data []byte) {
	var env proto.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		c.fail(nil, proto.CodeBadRequest, "not a JSON object: "+err.Error())
		return
	}
	if env.V != proto.Version {
		c.fail(env.ID, proto.CodeBadRequest, fmt.Sprintf("this connection speaks protocol version %d, not %d", proto.Version, env.V))
		return
	}
	if env.Type == "ack" {
		var a proto.Ack
		if err := decode(data, &a); err != nil {
			c.fail(nil, proto.CodeBadRequest, err.Error())
			return
		}
		c.ack(a)
		return
	}
	if env.ID == nil {
		c.fail(nil, proto.CodeBadRequest, "a request needs an id")
		return
	}
	id := *env.ID
	c.mu.Lock()
	hello := c.hello
	c.mu.Unlock()
	if !hello && env.Type != "hello" {
		c.fail(&id, proto.CodeHelloRequired, "the first request must be hello")
		return
	}
	h, ok := handlers[env.Type]
	if !ok {
		c.fail(&id, proto.CodeUnknownMethod, fmt.Sprintf("no method %q", env.Type))
		return
	}
	if personOnly[env.Type] && !c.asPerson(id, env.Type) {
		return
	}
	h(c, id, data)
}

func (c *conn) binary(data []byte) {
	kind, ch, _, payload, err := proto.ParseFrame(data)
	if err != nil {
		c.fail(nil, proto.CodeBadRequest, err.Error())
		return
	}
	if kind != proto.FrameInput {
		c.fail(nil, proto.CodeBadRequest, fmt.Sprintf("a client sends input frames (kind %d), not kind %d", proto.FrameInput, kind))
		return
	}
	c.mu.Lock()
	st := c.streams[ch]
	c.mu.Unlock()
	if st == nil {
		c.fail(nil, proto.CodeNotFound, fmt.Sprintf("input for channel %d, which this connection has not subscribed", ch))
		return
	}
	c.keys(st, append([]byte(nil), payload...))
}

// keys writes a person's keystrokes (already encoded) to a stream's
// pane, after the drive check, in order with the connection's other
// input.
func (c *conn) keys(st *stream, b []byte) {
	w := c.whoKeys()
	if ok, lease := c.s.mayDrive(w, st.p.ID()); !ok {
		// Keystrokes cannot wait: refused, and the person is asked.
		var err error
		if lease != nil {
			err = leaseError(st.p.ID(), *lease)
		} else {
			err = c.allowInput(c.ctx, st.p, w, visible(b), true)
		}
		var de driveErr
		var le leasedErr
		switch {
		case errors.As(err, &de):
			c.writeJSON(proto.Error{V: proto.Version, Type: "error", Error: proto.ErrorBody{Code: proto.CodeForbidden, Message: de.msg, Checkpoint: de.cp}})
		case errors.As(err, &le):
			l := le.lease
			c.writeJSON(proto.Error{V: proto.Version, Type: "error", Error: proto.ErrorBody{Code: proto.CodeLeased, Message: le.msg, Lease: &l}})
		case err != nil:
			c.fail(nil, proto.CodeForbidden, err.Error())
		}
		if err != nil {
			return
		}
	}
	c.queueInput(func() {
		text, masked := inputText(st.p, visible(b))
		mark := st.p.Mark()
		if st.p.Input(b) == nil {
			c.s.logInput(st.p, w, "keys", mark, len(b), text, masked)
		}
	})
}

func (c *conn) queueInput(f func()) {
	select {
	case c.input <- f:
	case <-c.ctx.Done():
	}
}

func (c *conn) ack(a proto.Ack) {
	c.mu.Lock()
	st := c.streams[a.Channel]
	c.mu.Unlock()
	if st == nil {
		return // the stream may have just ended
	}
	if a.Bytes < 0 {
		c.fail(nil, proto.CodeBadRequest, "ack bytes must not be negative")
		return
	}
	if st.rsub != nil {
		if a.Frame != nil {
			st.rsub.Ack(*a.Frame)
		}
		return
	}
	st.sub.Ack(int(min(a.Bytes, 1<<40)))
}

// track runs a request that may take time in its own goroutine, so it can
// be cancelled and other requests go on meanwhile.
func (c *conn) track(id uint64, f func(ctx context.Context)) {
	ctx, cancel := context.WithCancel(c.ctx)
	c.mu.Lock()
	c.reqs[id] = cancel
	c.mu.Unlock()
	go func() {
		defer func() {
			c.mu.Lock()
			delete(c.reqs, id)
			c.mu.Unlock()
			cancel()
		}()
		f(ctx)
	}()
}

func (c *conn) pane(id string) (*pane.Pane, error) {
	if id == "" {
		return nil, bad("pane is required")
	}
	return c.s.o.Manager.Get(id)
}

// ------------------------------------------------------------ methods

var handlers map[string]func(c *conn, id uint64, data []byte)

func init() {
	handlers = map[string]func(c *conn, id uint64, data []byte){
		"hello":             (*conn).hello_,
		"cancel":            (*conn).cancel_,
		"events.subscribe":  (*conn).eventsSubscribe,
		"pane.new":          (*conn).paneNew,
		"pane.list":         (*conn).paneList,
		"pane.close":        (*conn).paneClose,
		"pane.resize":       (*conn).paneResize,
		"pane.capture":      (*conn).paneCapture,
		"pane.read":         (*conn).paneRead,
		"pane.send":         (*conn).paneSend,
		"pane.wait":         (*conn).paneWait,
		"pane.settle":       (*conn).paneSettle,
		"pane.subscribe":    (*conn).paneSubscribe,
		"pane.unsubscribe":  (*conn).paneUnsubscribe,
		"pane.process":      (*conn).paneProcess,
		"pane.restart":      (*conn).paneRestart,
		"pane.focus":        (*conn).paneFocus,
		"pane.update":       (*conn).paneUpdate,
		"file.stat":         (*conn).fileStat,
		"file.read":         (*conn).fileRead,
		"checkpoint.new":    (*conn).checkpointNew,
		"checkpoint.list":   (*conn).checkpointList,
		"checkpoint.wait":   (*conn).checkpointWait,
		"checkpoint.answer": (*conn).checkpointAnswer,
		"checkpoint.cancel": (*conn).checkpointCancel,
		"agent.report":      (*conn).agentReport,
		"agent.events":      (*conn).agentEvents,
		"agent.decisions":   (*conn).agentDecisions,
		"agent.decide":      (*conn).agentDecide,
		"pane.inputs":       (*conn).paneInputs,
		"pane.grants":       (*conn).paneGrants,
		"pane.revoke":       (*conn).paneRevoke,
		"pane.lease":        (*conn).paneLease,
		"pane.files":        (*conn).paneFiles,
		"pane.shot":         (*conn).paneShot,
		"pane.frames":       (*conn).paneFrames,
		"pane.recording":    (*conn).paneRecording,
		"pane.replay":       (*conn).paneReplay,
		"pane.override":     (*conn).paneOverride,
		"pane.clear":        (*conn).paneClear,
		"pane.render":       (*conn).paneRender,
		"render.scroll":     (*conn).renderScroll,
		"render.input":      (*conn).renderInput,
		"render.text":       (*conn).renderText,
	}
}

func (c *conn) hello_(id uint64, data []byte) {
	var r proto.HelloRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	if r.Client.Name == "" {
		c.failErr(id, bad("client.name is required"))
		return
	}
	if len(r.AnswerKey) > 256 {
		c.failErr(id, bad("answer_key is at most 256 bytes"))
		return
	}
	c.mu.Lock()
	again := c.hello
	c.hello = true
	c.client = r.Client
	c.mu.Unlock()
	if again {
		c.failErr(id, bad("hello was already sent on this connection"))
		return
	}
	c.judge(r.AnswerKey)
	c.mu.Lock()
	person := c.person
	c.mu.Unlock()
	c.reply(id, "hello", proto.HelloResult{Protocol: proto.Version, Daemon: c.s.daemonInfo(), Methods: proto.Methods, Person: person})
}

func (c *conn) cancel_(id uint64, data []byte) {
	var r proto.CancelRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	if r.Request == nil {
		c.failErr(id, bad("request is required"))
		return
	}
	c.mu.Lock()
	cancel := c.reqs[*r.Request]
	c.mu.Unlock()
	if cancel == nil {
		c.failErr(id, fmt.Errorf("%w: request %d is not running", pane.ErrNotFound, *r.Request))
		return
	}
	cancel()
	c.reply(id, "cancel", proto.Empty{})
}

func (c *conn) eventsSubscribe(id uint64, data []byte) {
	var r proto.EventsSubscribeRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	c.mu.Lock()
	already := c.unwatch != nil
	c.display = r.Display
	c.activity = r.Activity
	c.mu.Unlock()
	if !already {
		// Reply first, so the result comes before any event.
		c.reply(id, "events.subscribe", proto.Empty{})
		unwatch := c.s.o.Manager.Watch(func(ev pane.Event) {
			switch ev.Type {
			case "status":
				return // reported as agent.report
			case "activity", "bell":
				// Only to a connection that asked, about a pane it does
				// not stream (it sees that pane's output already, and its
				// own terminal rings).
				c.mu.Lock()
				want := c.activity
				for _, st := range c.streams {
					if st.p.ID() == ev.Pane.ID {
						want = false
					}
				}
				c.mu.Unlock()
				if !want {
					return
				}
			}
			p := c.s.paneInfo(ev.Pane)
			c.event(proto.Event{V: proto.Version, Type: "event", Event: "pane." + ev.Type, Pane: &p})
		})
		c.mu.Lock()
		c.unwatch = unwatch
		c.mu.Unlock()
		return
	}
	c.reply(id, "events.subscribe", proto.Empty{})
}

func (c *conn) paneNew(id uint64, data []byte) {
	var r proto.NewRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	if err := checkName(r.Name); err != nil {
		c.failErr(id, err)
		return
	}
	if err := checkLabels(r.Labels); err != nil {
		c.failErr(id, err)
		return
	}
	cfg := pane.Config{Command: r.Command, Cwd: r.Cwd, Env: r.Env, Name: r.Name, Labels: r.Labels, Hidden: r.Hidden}
	if r.Cols != nil || r.Rows != nil {
		if r.Cols == nil || r.Rows == nil || *r.Cols < 1 || *r.Rows < 1 || *r.Cols > 4096 || *r.Rows > 4096 {
			c.failErr(id, bad("cols and rows go together, each between 1 and 4096"))
			return
		}
		cfg.Cols, cfg.Rows = *r.Cols, *r.Rows
	}
	if r.TTLMs != nil {
		if *r.TTLMs < 1 || !r.Hidden {
			c.failErr(id, bad("ttl_ms is for a hidden pane, and at least 1"))
			return
		}
		cfg.TTL = time.Duration(*r.TTLMs) * time.Millisecond
	}
	if r.Scrollback != nil {
		if *r.Scrollback < 0 || *r.Scrollback > maxScrollback {
			c.failErr(id, bad("scrollback must be between 0 and %d", maxScrollback))
			return
		}
		cfg.Scrollback = max(*r.Scrollback, 1)
	}
	if r.Command != nil && (len(r.Command) == 0 || r.Command[0] == "") {
		c.failErr(id, bad("command needs at least a program, and command[0] must not be empty"))
		return
	}
	for k := range r.Env {
		if k == "" || strings.ContainsAny(k, "=\x00") {
			c.failErr(id, bad("env name %q is not valid", k))
			return
		}
	}
	w := c.who("")
	p, err := c.s.o.Manager.New(cfg)
	if err != nil {
		c.failErr(id, err)
		return
	}
	c.s.setCreator(p.ID(), w.creator(), w.key)
	c.reply(id, "pane.new", proto.PaneResult{Pane: c.s.paneInfo(p.Info())})
}

func (c *conn) paneList(id uint64, data []byte) {
	var r proto.ListRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	if err := checkLabels(r.Labels); err != nil {
		c.failErr(id, err)
		return
	}
	infos := c.s.o.Manager.List(r.Hidden)
	out := make([]proto.Pane, 0, len(infos))
next:
	for _, i := range infos {
		for k, v := range r.Labels {
			if have, ok := i.Labels[k]; !ok || have != v {
				continue next
			}
		}
		pi := c.s.paneInfo(i)
		if r.Processes && i.Running() {
			pi.PIDs = c.s.o.Manager.Members(i.ID)
		}
		out = append(out, pi)
	}
	c.reply(id, "pane.list", proto.ListResult{Panes: out})
}

func (c *conn) paneClose(id uint64, data []byte) {
	var r proto.CloseRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	grace := time.Second
	if r.GraceMs != nil {
		if *r.GraceMs < 0 || *r.GraceMs > 60000 {
			c.failErr(id, bad("grace_ms must be between 0 and 60000"))
			return
		}
		grace = time.Duration(*r.GraceMs) * time.Millisecond
	}
	p, err := c.pane(r.Pane)
	if err != nil {
		c.failErr(id, err)
		return
	}
	if err := checkReason(r.Reason); err != nil {
		c.failErr(id, err)
		return
	}
	w := c.who("")
	w.reason = r.Reason
	c.track(id, func(ctx context.Context) {
		// Closing a pane outside its own ends another's work: the person
		// says yes first, as for input.
		if err := c.allowAction(ctx, p, w, "", r.NoWait, actClose); err != nil {
			c.failErr(id, err)
			return
		}
		info, n, err := c.s.o.Manager.Close(r.Pane, grace)
		if err != nil {
			c.failErr(id, err)
			return
		}
		c.reply(id, "pane.close", proto.CloseResult{Pane: c.s.paneInfo(info), Signalled: n})
	})
}

func (c *conn) paneResize(id uint64, data []byte) {
	var r proto.ResizeRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	p, err := c.pane(r.Pane)
	if err != nil {
		c.failErr(id, err)
		return
	}
	if r.Cols < 1 || r.Rows < 1 || r.Cols > 4096 || r.Rows > 4096 {
		c.failErr(id, bad("cols and rows must be between 1 and 4096"))
		return
	}
	if err := p.Resize(r.Cols, r.Rows); err != nil {
		c.failErr(id, err)
		return
	}
	c.reply(id, "pane.resize", proto.PaneResult{Pane: c.s.paneInfo(p.Info())})
}

func (c *conn) paneClear(id uint64, data []byte) {
	var r proto.ClearRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	p, err := c.pane(r.Pane)
	if err != nil {
		c.failErr(id, err)
		return
	}
	cleared, err := p.Clear()
	if err != nil {
		c.failErr(id, err)
		return
	}
	c.reply(id, "pane.clear", proto.ClearResult{Pane: c.s.paneInfo(p.Info()), Cleared: cleared})
}

func (c *conn) paneCapture(id uint64, data []byte) {
	var r proto.CaptureRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	p, err := c.pane(r.Pane)
	if err != nil {
		c.failErr(id, err)
		return
	}
	if r.History < 0 {
		c.failErr(id, bad("history must not be negative"))
		return
	}
	opts := vt.CaptureOptions{Styles: r.Styles, History: r.History}
	var cp *vt.Capture
	var snap []byte
	var mark uint64
	if r.VT {
		cp, snap, mark, err = p.CaptureWithVT(opts)
	} else {
		cp, mark, err = p.Capture(opts)
	}
	if err != nil {
		c.failErr(id, err)
		return
	}
	res := proto.CaptureResult{
		Pane: r.Pane, Mark: mark, Cols: cp.Cols, Rows: cp.Rows,
		Cursor:    proto.Cursor{X: cp.Cursor.X, Y: cp.Cursor.Y, Visible: cp.Cursor.Visible},
		AltScreen: cp.Alt, Title: cp.Title, History: cp.History, Lines: make([]proto.Line, len(cp.Lines)),
	}
	for i, l := range cp.Lines {
		res.Lines[i].Text = l.Text
		for _, sp := range l.Spans {
			res.Lines[i].Spans = append(res.Lines[i].Spans, span(sp))
		}
		if r.Styles && res.Lines[i].Spans == nil {
			res.Lines[i].Spans = []proto.Span{}
		}
	}
	if r.VT {
		res.VT = strings.ToValidUTF8(string(snap), "\uFFFD")
	}
	c.reply(id, "pane.capture", res)
}

func span(s vt.Span) proto.Span {
	return proto.Span{
		Col: s.Col, Width: s.Width, Text: s.Text,
		Bold: s.Style.Bold, Dim: s.Style.Dim, Italic: s.Style.Italic, Underline: s.Style.Underline,
		Blink: s.Style.Blink, Inverse: s.Style.Inverse, Invisible: s.Style.Invisible, Strike: s.Style.Strike,
		Fg: color(s.Style.Fg), Bg: color(s.Style.Bg),
	}
}

func color(c vt.Color) any {
	switch c.Kind {
	case vt.ColorPalette:
		return int(c.Index)
	case vt.ColorRGB:
		return fmt.Sprintf("#%02x%02x%02x", c.R, c.G, c.B)
	}
	return nil
}

const (
	defaultReadLimit = 1 << 20
	maxReadLimit     = 8 << 20
	maxScrollback    = 1000000
	maxWindow        = 256 << 20
)

func (c *conn) paneRead(id uint64, data []byte) {
	var r proto.ReadRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	p, err := c.pane(r.Pane)
	if err != nil {
		c.failErr(id, err)
		return
	}
	if r.Since == nil {
		c.failErr(id, bad("since is required"))
		return
	}
	limit := defaultReadLimit
	if r.Limit != nil {
		limit = *r.Limit
		if limit < 1 || limit > maxReadLimit {
			c.failErr(id, bad("limit must be between 1 and %d", maxReadLimit))
			return
		}
	}
	format := r.Format
	if format == "" {
		format = "text"
	}
	if format != "text" && format != "raw" {
		c.failErr(id, bad("format must be text or raw"))
		return
	}
	b, from, end, err := p.Read(*r.Since, limit)
	if err != nil {
		c.failErr(id, bad("%v", err))
		return
	}
	res := proto.ReadResult{Pane: r.Pane, From: from, To: from + uint64(len(b)), End: end, Truncated: from > *r.Since}
	if format == "raw" {
		s := base64.StdEncoding.EncodeToString(b)
		res.Data = &s
	} else {
		t := pane.StripEscapes(b)
		if !utf8.ValidString(t) {
			t = strings.ToValidUTF8(t, "�")
		}
		res.Text = &t
	}
	c.reply(id, "pane.read", res)
}

func inputItems(in []proto.Input) ([]pane.InputItem, error) {
	if len(in) == 0 {
		return nil, bad("input is required")
	}
	out := make([]pane.InputItem, len(in))
	for i, it := range in {
		switch {
		case it.Key != "" && it.Text != nil:
			return nil, bad("input %d has both text and key", i)
		case it.Key != "":
			if it.Mode != "" || it.DelayMs != nil {
				return nil, bad("input %d: a key takes no mode or delay_ms", i)
			}
			if _, err := vt.ParseKey(it.Key); err != nil {
				return nil, bad("input %d: %v", i, err)
			}
			out[i] = pane.InputItem{Key: it.Key}
		case it.Text != nil:
			switch it.Mode {
			case pane.ModeRaw, pane.ModePaste, pane.ModeTyped:
			case "":
				return nil, bad("input %d: text needs a mode (raw, paste or typed)", i)
			default:
				return nil, bad("input %d: mode must be raw, paste or typed, not %q", i, it.Mode)
			}
			var delay time.Duration
			if it.DelayMs != nil {
				if *it.DelayMs < 0 || *it.DelayMs > 10000 || it.Mode != pane.ModeTyped {
					return nil, bad("input %d: delay_ms is for typed text, between 0 and 10000", i)
				}
				delay = time.Duration(*it.DelayMs) * time.Millisecond
				if delay == 0 {
					delay = time.Nanosecond // zero means no pause, not the default pause
				}
			}
			out[i] = pane.InputItem{Text: *it.Text, Mode: it.Mode, Delay: delay}
		default:
			return nil, bad("input %d needs text or key", i)
		}
	}
	return out, nil
}

func (c *conn) paneSend(id uint64, data []byte) {
	var r proto.SendRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	p, err := c.pane(r.Pane)
	if err != nil {
		c.failErr(id, err)
		return
	}
	items, err := inputItems(r.Input)
	if err != nil {
		c.failErr(id, err)
		return
	}
	if err := checkBy(r.By); err != nil {
		c.failErr(id, err)
		return
	}
	if err := checkReason(r.Reason); err != nil {
		c.failErr(id, err)
		return
	}
	w := c.who(r.By)
	w.reason = r.Reason
	ctx, cancel := context.WithCancel(c.ctx)
	c.mu.Lock()
	c.reqs[id] = cancel
	c.mu.Unlock()
	c.queueInput(func() {
		defer func() {
			c.mu.Lock()
			delete(c.reqs, id)
			c.mu.Unlock()
			cancel()
		}()
		res, err := c.sendLogged(ctx, p, w, items, r.NoWait, false)
		if err != nil {
			c.failErr(id, err)
			return
		}
		c.reply(id, "pane.send", proto.SendResult{Pane: r.Pane, Bytes: res.Bytes, Mark: res.Mark})
	})
}

const (
	defaultWaitTimeout = 30 * time.Second
	maxWaitTimeout     = 24 * time.Hour
)

func (c *conn) paneWait(id uint64, data []byte) {
	var r proto.WaitRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	p, err := c.pane(r.Pane)
	if err != nil {
		c.failErr(id, err)
		return
	}
	spec := pane.WaitSpec{Screen: r.Screen, Exit: r.Exit, Since: r.Since, Timeout: defaultWaitTimeout}
	if r.Text != "" {
		re, err := regexp.Compile(r.Text)
		if err != nil {
			c.failErr(id, bad("text is not a valid regular expression: %v", err))
			return
		}
		spec.Text = re
	} else if r.Screen {
		c.failErr(id, bad("screen applies to text, which is missing"))
		return
	}
	if r.QuietMs != nil {
		if *r.QuietMs < 1 || *r.QuietMs > maxWaitTimeout.Milliseconds() {
			c.failErr(id, bad("quiet_ms must be between 1 and %d", maxWaitTimeout.Milliseconds()))
			return
		}
		spec.Quiet = time.Duration(*r.QuietMs) * time.Millisecond
	}
	if r.TimeoutMs != nil {
		t := time.Duration(*r.TimeoutMs) * time.Millisecond
		if t <= 0 || t > maxWaitTimeout {
			c.failErr(id, bad("timeout_ms must be between 1 and %d", maxWaitTimeout.Milliseconds()))
			return
		}
		spec.Timeout = t
	}
	spec.Prompt = r.Prompt
	if spec.Text == nil && spec.Quiet == 0 && !spec.Exit && !spec.Prompt {
		c.failErr(id, bad("%v", pane.ErrBadSpec))
		return
	}
	c.track(id, func(ctx context.Context) {
		w, err := p.Wait(ctx, spec, nil)
		if err != nil {
			c.failErr(id, err)
			return
		}
		c.reply(id, "pane.wait", waitResult(r.Pane, w))
	})
}

func waitResult(id string, w *pane.WaitResult) proto.WaitResult {
	res := proto.WaitResult{
		Pane: id, Condition: w.Condition, Since: w.Since, Mark: w.Mark,
		Output: strings.ToValidUTF8(w.Output, "�"), Truncated: w.Truncated,
		Changes: []proto.RowChange{}, Screen: w.Screen,
	}
	if w.Condition == "text" {
		m := w.Match
		res.Match = &m
		res.Groups = w.Groups
		if res.Groups == nil {
			res.Groups = []string{}
		}
	}
	if w.Exit != nil {
		res.Exit = &proto.Exit{Code: w.Exit.Code, Signal: w.Exit.Signal}
	}
	for _, ch := range w.Changes {
		res.Changes = append(res.Changes, proto.RowChange{Row: ch.Row, Before: ch.Before, After: ch.After})
	}
	if res.Screen == nil {
		res.Screen = []string{}
	}
	res.Shell = shellInfo(w.Shell)
	return res
}

func (c *conn) paneSettle(id uint64, data []byte) {
	var r proto.SettleRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	p, err := c.pane(r.Pane)
	if err != nil {
		c.failErr(id, err)
		return
	}
	items, err := inputItems(r.Input)
	if err != nil {
		c.failErr(id, err)
		return
	}
	if err := checkBy(r.By); err != nil {
		c.failErr(id, err)
		return
	}
	if err := checkReason(r.Reason); err != nil {
		c.failErr(id, err)
		return
	}
	w := c.who(r.By)
	w.reason = r.Reason
	quiet, timeout := 300*time.Millisecond, 10*time.Second
	for _, v := range []*int64{r.QuietMs, r.TimeoutMs} {
		if v != nil && (*v < 1 || *v > maxWaitTimeout.Milliseconds()) {
			c.failErr(id, bad("quiet_ms and timeout_ms must be between 1 and %d", maxWaitTimeout.Milliseconds()))
			return
		}
	}
	if r.QuietMs != nil {
		quiet = time.Duration(*r.QuietMs) * time.Millisecond
	}
	if r.TimeoutMs != nil {
		timeout = time.Duration(*r.TimeoutMs) * time.Millisecond
	}
	ctx, cancel := context.WithCancel(c.ctx)
	c.mu.Lock()
	c.reqs[id] = cancel
	c.mu.Unlock()
	done := func() {
		c.mu.Lock()
		delete(c.reqs, id)
		c.mu.Unlock()
		cancel()
	}
	// The input goes through the connection's input queue, in order with
	// its other input; the wait runs on its own.
	c.queueInput(func() {
		if err := c.allowInput(ctx, p, w, itemsText(items), r.NoWait); err != nil {
			done()
			c.failErr(id, err)
			return
		}
		before, err := p.Text()
		if err != nil {
			done()
			c.failErr(id, err)
			return
		}
		sent, err := c.sendLogged(ctx, p, w, items, true, true)
		if err != nil {
			done()
			c.failErr(id, err)
			return
		}
		go func() {
			defer done()
			w, err := p.Wait(ctx, pane.WaitSpec{Quiet: quiet, Since: &sent.Mark, Timeout: timeout}, before)
			if err != nil {
				c.failErr(id, err)
				return
			}
			c.reply(id, "pane.settle", proto.SettleResult{
				Sent: proto.SendResult{Pane: r.Pane, Bytes: sent.Bytes, Mark: sent.Mark},
				Wait: waitResult(r.Pane, w),
			})
		}()
	})
}

func (c *conn) paneSubscribe(id uint64, data []byte) {
	var r proto.SubscribeRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	p, err := c.pane(r.Pane)
	if err != nil {
		c.failErr(id, err)
		return
	}
	window := 0
	if r.Window != nil {
		window = *r.Window
		if window < pane.MinWindow || window > maxWindow {
			c.failErr(id, bad("window must be between %d and %d", pane.MinWindow, maxWindow))
			return
		}
	}
	sub, err := p.Subscribe(pane.SubOptions{Since: r.Since, Ack: r.Ack, Window: window, KittyKeyboard: r.KittyKeyboard})
	if err != nil {
		if errors.Is(err, pane.ErrClosed) {
			c.failErr(id, err)
		} else {
			c.failErr(id, bad("%v", err))
		}
		return
	}
	c.mu.Lock()
	c.next++
	ch := c.next
	st := &stream{ch: ch, p: p, sub: sub}
	c.streams[ch] = st
	c.mu.Unlock()
	// The result goes out before the stream's first frame.
	c.reply(id, "pane.subscribe", proto.SubscribeResult{Pane: r.Pane, Channel: ch})
	go c.stream(st)
}

func (c *conn) stream(st *stream) {
	var err error
	for {
		var f pane.Frame
		f, err = st.sub.Next(c.ctx)
		if err != nil {
			break
		}
		kind := proto.FrameOutput
		if f.Snapshot {
			kind = proto.FrameSnapshot
		}
		buf := proto.AppendFrame(make([]byte, 0, proto.FrameHeader+len(f.Data)), kind, st.ch, f.Mark)
		buf = append(buf, f.Data...)
		if c.write(websocket.MessageBinary, buf) != nil {
			c.cancel()
			return
		}
	}
	c.mu.Lock()
	_, mine := c.streams[st.ch]
	delete(c.streams, st.ch)
	c.mu.Unlock()
	st.sub.Close()
	if errors.Is(err, io.EOF) && mine {
		ch, mark := st.ch, st.p.Mark()
		c.writeJSON(proto.Event{V: proto.Version, Type: "event", Event: "stream.end", Channel: &ch, Mark: &mark})
	}
}

func (c *conn) paneUnsubscribe(id uint64, data []byte) {
	var r proto.UnsubscribeRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	if r.Channel == nil {
		c.failErr(id, bad("channel is required"))
		return
	}
	c.mu.Lock()
	st := c.streams[*r.Channel]
	delete(c.streams, *r.Channel)
	c.mu.Unlock()
	if st == nil {
		c.failErr(id, fmt.Errorf("%w: %d", errNoChannel, *r.Channel))
		return
	}
	st.closeSub()
	c.reply(id, "pane.unsubscribe", proto.Empty{})
}

func (s *Server) paneInfo(i pane.Info) proto.Pane {
	p := proto.Pane{
		ID: i.ID, Name: i.Name, Labels: i.Labels, Command: i.Command, Cwd: i.Cwd, PID: i.PID, Cols: i.Cols, Rows: i.Rows, Scrollback: i.Scrollback,
		Hidden: i.Hidden, TTLMs: i.TTL.Milliseconds(), CreatedAt: stamp(i.Created), Title: i.Title,
		Mark: i.Mark, LastOutputAt: stamp(i.LastOutput), State: "running", ExitedAt: stamp(i.ExitedAt),
	}
	if p.Command == nil {
		p.Command = []string{}
	}
	if i.Exit != nil {
		p.State = "exited"
		p.Exit = &proto.Exit{Code: i.Exit.Code, Signal: i.Exit.Signal}
	}
	p.Shell = shellInfo(i.Shell)
	p.Agent = statusInfo(s.agents.Status(i.ID))
	s.driveInfo(&p)
	if o := i.Overrides; o != nil {
		p.Overrides = &proto.Overrides{Cols: o.Cols, Rows: o.Rows, SlowBps: o.SlowBps, Term: o.Term}
	}
	return p
}

// checkBy: who typed it, at most 64 bytes of plain text.
func checkBy(by string) error {
	if len(by) > maxBy || !plainText(by) {
		return bad("by is at most %d bytes with no control characters", maxBy)
	}
	return nil
}

// sendLogged sends input once this connection may drive the pane, and
// logs it with its source.
// checked: the caller made sure already (allowInput).
func (c *conn) sendLogged(ctx context.Context, p *pane.Pane, w who, items []pane.InputItem, noWait, checked bool) (pane.SendResult, error) {
	text := itemsText(items)
	if !checked {
		if err := c.allowInput(ctx, p, w, text, noWait); err != nil {
			return pane.SendResult{}, err
		}
	}
	logged, masked := inputText(p, text)
	res, err := p.Send(ctx, items)
	if res.Bytes > 0 {
		c.s.logInput(p, w, "send", res.Mark, res.Bytes, logged, masked)
	}
	return res, err
}

func shellInfo(sh *pane.Shell) *proto.Shell {
	if sh == nil {
		return nil
	}
	return &proto.Shell{State: sh.State, Command: sh.Command, ExitCode: sh.ExitCode, Mark: sh.Mark, At: stamp(sh.At)}
}
