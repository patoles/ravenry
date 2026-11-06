// Package proto holds the wire types of the Ravenry protocol, version 1.
// The spec is packages/protocol/PROTOCOL.md and its JSON Schema is
// packages/protocol/schema/v1.json; this package follows them exactly, and
// the server tests check every message against the schema.
package proto

import (
	"encoding/binary"
	"errors"
)

// Version is the protocol version this package speaks.
const Version = 1

// Subprotocol is the WebSocket subprotocol a v1 connection negotiates.
const Subprotocol = "ravenry.v1"

// Path is the HTTP path of the WebSocket upgrade.
const Path = "/v1"

// Error codes.
const (
	CodeBadRequest    = "bad_request"
	CodeHelloRequired = "hello_required"
	CodeUnknownMethod = "unknown_method"
	CodeNotFound      = "not_found"
	CodePaneClosed    = "pane_closed"
	CodeFailed        = "failed"
	CodeCancelled     = "cancelled"
	CodeShuttingDown  = "shutting_down"
	CodeInternal      = "internal"
)

// Methods, in the order the spec lists them.
var Methods = []string{
	"hello", "cancel", "events.subscribe",
	"pane.new", "pane.list", "pane.close", "pane.resize",
	"pane.capture", "pane.read",
	"pane.send", "pane.wait", "pane.settle",
	"pane.subscribe", "pane.unsubscribe",
}

// Envelope is what every JSON message starts with.
type Envelope struct {
	V    int     `json:"v"`
	Type string  `json:"type"`
	ID   *uint64 `json:"id,omitempty"`
}

// Result is the reply to a request.
type Result struct {
	V      int    `json:"v"`
	Type   string `json:"type"` // "result"
	ID     uint64 `json:"id"`
	Method string `json:"method"`
	Result any    `json:"result"`
}

// Error is a failed request, or a message the daemon could not read.
type Error struct {
	V     int       `json:"v"`
	Type  string    `json:"type"` // "error"
	ID    *uint64   `json:"id,omitempty"`
	Error ErrorBody `json:"error"`
}

// ErrorBody says what went wrong.
type ErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Event is something the daemon reports without being asked:
// pane.created, pane.title, pane.exited and pane.closed carry Pane;
// stream.end carries Channel and Mark; daemon.draining carries Newer.
type Event struct {
	V       int     `json:"v"`
	Type    string  `json:"type"` // "event"
	Event   string  `json:"event"`
	Pane    *Pane   `json:"pane,omitempty"`
	Channel *uint32 `json:"channel,omitempty"`
	Mark    *uint64 `json:"mark,omitempty"`
	Newer   string  `json:"newer,omitempty"`
}

// Ack acknowledges output a client has processed.
type Ack struct {
	V       int    `json:"v"`
	Type    string `json:"type"` // "ack"
	Channel uint32 `json:"channel"`
	Bytes   int64  `json:"bytes"`
}

// Requests. Each embeds Envelope, so a strict decoder accepts exactly the
// envelope and the method's own fields.

type HelloRequest struct {
	Envelope
	Client ClientInfo `json:"client"`
}

type ClientInfo struct {
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
}

type HelloResult struct {
	Protocol int        `json:"protocol"`
	Daemon   DaemonInfo `json:"daemon"`
	Methods  []string   `json:"methods"`
}

type DaemonInfo struct {
	Version   string `json:"version"`
	PID       int    `json:"pid"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	StartedAt string `json:"started_at"`
	// Draining names a newer daemon version running beside this one: new
	// panes belong there, and this daemon exits when its panes have ended.
	Draining string `json:"draining,omitempty"`
}

type CancelRequest struct {
	Envelope
	Request *uint64 `json:"request"`
}

type EventsSubscribeRequest struct {
	Envelope
}

type Empty struct{}

type NewRequest struct {
	Envelope
	Command    []string          `json:"command,omitempty"`
	Cwd        string            `json:"cwd,omitempty"`
	Env        map[string]string `json:"env,omitempty"`
	Cols       *int              `json:"cols,omitempty"`
	Rows       *int              `json:"rows,omitempty"`
	Name       string            `json:"name,omitempty"`
	Hidden     bool              `json:"hidden,omitempty"`
	TTLMs      *int64            `json:"ttl_ms,omitempty"`
	Scrollback *int              `json:"scrollback,omitempty"`
}

type PaneResult struct {
	Pane Pane `json:"pane"`
}

type ListRequest struct {
	Envelope
	Hidden bool `json:"hidden,omitempty"`
}

type ListResult struct {
	Panes []Pane `json:"panes"`
}

type CloseRequest struct {
	Envelope
	Pane    string `json:"pane"`
	GraceMs *int64 `json:"grace_ms,omitempty"`
}

type CloseResult struct {
	Pane      Pane `json:"pane"`
	Signalled int  `json:"signalled"`
}

type ResizeRequest struct {
	Envelope
	Pane string `json:"pane"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

type CaptureRequest struct {
	Envelope
	Pane    string `json:"pane"`
	Styles  bool   `json:"styles,omitempty"`
	History int    `json:"history,omitempty"`
	VT      bool   `json:"vt,omitempty"`
}

type CaptureResult struct {
	Pane      string `json:"pane"`
	Mark      uint64 `json:"mark"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
	Cursor    Cursor `json:"cursor"`
	AltScreen bool   `json:"alt_screen"`
	Title     string `json:"title"`
	History   int    `json:"history"`
	Lines     []Line `json:"lines"`
	VT        string `json:"vt,omitempty"`
}

type Cursor struct {
	X       int  `json:"x"`
	Y       int  `json:"y"`
	Visible bool `json:"visible"`
}

type Line struct {
	Text  string `json:"text"`
	Spans []Span `json:"spans,omitempty"`
}

// Span is a run of cells with a style that is not the default. Fg and Bg
// are a palette index (a number) or "#rrggbb"; absent means the default.
type Span struct {
	Col       int    `json:"col"`
	Width     int    `json:"width"`
	Text      string `json:"text"`
	Bold      bool   `json:"bold,omitempty"`
	Dim       bool   `json:"dim,omitempty"`
	Italic    bool   `json:"italic,omitempty"`
	Underline bool   `json:"underline,omitempty"`
	Blink     bool   `json:"blink,omitempty"`
	Inverse   bool   `json:"inverse,omitempty"`
	Invisible bool   `json:"invisible,omitempty"`
	Strike    bool   `json:"strike,omitempty"`
	Fg        any    `json:"fg,omitempty"`
	Bg        any    `json:"bg,omitempty"`
}

type ReadRequest struct {
	Envelope
	Pane   string  `json:"pane"`
	Since  *uint64 `json:"since"`
	Limit  *int    `json:"limit,omitempty"`
	Format string  `json:"format,omitempty"`
}

type ReadResult struct {
	Pane      string  `json:"pane"`
	From      uint64  `json:"from"`
	To        uint64  `json:"to"`
	End       uint64  `json:"end"`
	Truncated bool    `json:"truncated"`
	Text      *string `json:"text,omitempty"`
	Data      *string `json:"data,omitempty"`
}

type Input struct {
	Text    *string `json:"text,omitempty"`
	Mode    string  `json:"mode,omitempty"`
	DelayMs *int    `json:"delay_ms,omitempty"`
	Key     string  `json:"key,omitempty"`
}

type SendRequest struct {
	Envelope
	Pane  string  `json:"pane"`
	Input []Input `json:"input"`
}

type SendResult struct {
	Pane  string `json:"pane"`
	Bytes int    `json:"bytes"`
	Mark  uint64 `json:"mark"`
}

type WaitRequest struct {
	Envelope
	Pane      string  `json:"pane"`
	Text      string  `json:"text,omitempty"`
	Screen    bool    `json:"screen,omitempty"`
	QuietMs   *int64  `json:"quiet_ms,omitempty"`
	Exit      bool    `json:"exit,omitempty"`
	Since     *uint64 `json:"since,omitempty"`
	TimeoutMs *int64  `json:"timeout_ms,omitempty"`
}

type WaitResult struct {
	Pane      string      `json:"pane"`
	Condition string      `json:"condition"`
	Since     uint64      `json:"since"`
	Mark      uint64      `json:"mark"`
	Output    string      `json:"output"`
	Truncated bool        `json:"truncated"`
	Match     *string     `json:"match,omitempty"`
	Groups    []string    `json:"groups,omitzero"`
	Exit      *Exit       `json:"exit,omitempty"`
	Changes   []RowChange `json:"changes"`
	Screen    []string    `json:"screen"`
}

type RowChange struct {
	Row    int    `json:"row"`
	Before string `json:"before"`
	After  string `json:"after"`
}

type SettleRequest struct {
	Envelope
	Pane      string  `json:"pane"`
	Input     []Input `json:"input"`
	QuietMs   *int64  `json:"quiet_ms,omitempty"`
	TimeoutMs *int64  `json:"timeout_ms,omitempty"`
}

type SettleResult struct {
	Sent SendResult `json:"sent"`
	Wait WaitResult `json:"wait"`
}

type SubscribeRequest struct {
	Envelope
	Pane   string  `json:"pane"`
	Since  *uint64 `json:"since,omitempty"`
	Ack    bool    `json:"ack,omitempty"`
	Window *int    `json:"window,omitempty"`
}

type SubscribeResult struct {
	Pane    string `json:"pane"`
	Channel uint32 `json:"channel"`
}

type UnsubscribeRequest struct {
	Envelope
	Channel *uint32 `json:"channel"`
}

// Pane describes a pane.
type Pane struct {
	ID           string   `json:"id"`
	Name         string   `json:"name,omitempty"`
	Command      []string `json:"command"`
	Cwd          string   `json:"cwd"`
	PID          int      `json:"pid"`
	Cols         int      `json:"cols"`
	Rows         int      `json:"rows"`
	Hidden       bool     `json:"hidden"`
	TTLMs        int64    `json:"ttl_ms,omitempty"`
	CreatedAt    string   `json:"created_at"`
	Title        string   `json:"title"`
	Mark         uint64   `json:"mark"`
	LastOutputAt string   `json:"last_output_at,omitempty"`
	State        string   `json:"state"`
	Exit         *Exit    `json:"exit,omitempty"`
	ExitedAt     string   `json:"exited_at,omitempty"`
}

type Exit struct {
	Code   int    `json:"code"`
	Signal string `json:"signal,omitempty"`
}

// Binary frames.

// Frame kinds.
const (
	FrameOutput   byte = 1
	FrameSnapshot byte = 2
	FrameInput    byte = 3
)

// FrameHeader is the size of a binary frame's header: version (1 byte),
// kind (1), channel (4, big-endian), mark (8, big-endian).
const FrameHeader = 14

// AppendFrame appends a frame's header to dst; the payload follows.
func AppendFrame(dst []byte, kind byte, channel uint32, mark uint64) []byte {
	dst = append(dst, Version, kind)
	dst = binary.BigEndian.AppendUint32(dst, channel)
	return binary.BigEndian.AppendUint64(dst, mark)
}

// ParseFrame reads a binary frame.
func ParseFrame(b []byte) (kind byte, channel uint32, mark uint64, payload []byte, err error) {
	if len(b) < FrameHeader {
		return 0, 0, 0, nil, errors.New("binary frame shorter than its header")
	}
	if b[0] != Version {
		return 0, 0, 0, nil, errors.New("binary frame of another protocol version")
	}
	return b[1], binary.BigEndian.Uint32(b[2:6]), binary.BigEndian.Uint64(b[6:14]), b[FrameHeader:], nil
}
