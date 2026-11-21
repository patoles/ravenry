// Package proto holds the wire types of the Ravenry protocol, version 1.
// The spec is packages/protocol/PROTOCOL.md and its JSON Schema is
// packages/protocol/schema/v1.json; this package follows them exactly, and
// the server tests check every message against the schema.
package proto

import (
	"encoding/binary"
	"encoding/json"
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
	CodeForbidden     = "forbidden"
	// CodeLeased: another driver holds the pane's lease.
	CodeLeased = "leased"
)

// Methods, in the order the spec lists them.
var Methods = []string{
	"hello", "cancel", "events.subscribe",
	"pane.new", "pane.list", "pane.close", "pane.resize",
	"pane.capture", "pane.read",
	"pane.send", "pane.wait", "pane.settle",
	"pane.subscribe", "pane.unsubscribe",
	"pane.process", "pane.restart", "pane.focus", "pane.update",
	"agent.report", "agent.events", "agent.decisions", "agent.decide",
	"file.stat", "file.read",
	"checkpoint.new", "checkpoint.list", "checkpoint.wait", "checkpoint.answer", "checkpoint.cancel",
	// Added after the first draft of v1 (section 10): who drives a pane,
	// what it touched, its pictures, its recording and test conditions.
	"pane.inputs", "pane.grants", "pane.revoke", "pane.lease", "pane.files",
	"pane.shot", "pane.frames", "pane.recording", "pane.replay", "pane.override",
	// Cmd+K in a terminal window: clear a pane's screen and history.
	"pane.clear",
	// The render stream (docs/RENDERING.md): a pane's screen as frames,
	// for a client that draws it itself, and that client's input.
	"pane.render", "render.scroll", "render.input", "render.text",
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
	// Checkpoint is the drive checkpoint a refused input opened (forbidden).
	Checkpoint string `json:"checkpoint,omitempty"`
	// Lease is the lease that holds the pane (leased).
	Lease *Lease `json:"lease,omitempty"`
}

// Event is something the daemon reports without being asked:
// pane.created, pane.title, pane.exited, pane.closed, pane.prompt,
// pane.cwd, pane.updated, pane.activity and pane.focus carry Pane;
// stream.end carries Channel and Mark; daemon.draining carries Newer;
// agent.report carries Report (and Pane when the report names one);
// agent.decision carries Request, Report and TimeoutMs;
// checkpoint.opened, checkpoint.running and checkpoint.closed carry
// Checkpoint.
type Event struct {
	V          int          `json:"v"`
	Type       string       `json:"type"` // "event"
	Event      string       `json:"event"`
	Pane       *Pane        `json:"pane,omitempty"`
	Checkpoint *Checkpoint  `json:"checkpoint,omitempty"`
	Channel    *uint32      `json:"channel,omitempty"`
	Mark       *uint64      `json:"mark,omitempty"`
	Newer      string       `json:"newer,omitempty"`
	Report     *AgentReport `json:"report,omitempty"`
	Request    *uint64      `json:"request,omitempty"`
	TimeoutMs  *int64       `json:"timeout_ms,omitempty"`
	// Input: pane.input carries the input record (and Pane).
	Input *InputRecord `json:"input,omitempty"`
}

// Ack acknowledges output a client has processed.
type Ack struct {
	V       int    `json:"v"`
	Type    string `json:"type"` // "ack"
	Channel uint32 `json:"channel"`
	Bytes   int64  `json:"bytes"`
	// Frame: on a render stream, the newest frame the client has drawn.
	Frame *uint32 `json:"frame,omitempty"`
}

// Requests. Each embeds Envelope, so a strict decoder accepts exactly the
// envelope and the method's own fields.

type HelloRequest struct {
	Envelope
	Client ClientInfo `json:"client"`
	// AnswerKey is the hub's answer key, which a connection over ssh
	// gives so it may act as the person (section 4, Who acts as the
	// person).
	AnswerKey string `json:"answer_key,omitempty"`
}

type ClientInfo struct {
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
}

type HelloResult struct {
	Protocol int        `json:"protocol"`
	Daemon   DaemonInfo `json:"daemon"`
	Methods  []string   `json:"methods"`
	// Person: this connection may act as the person (answer checkpoints,
	// decide for hooks).
	Person bool `json:"person"`
}

type DaemonInfo struct {
	Version   string `json:"version"`
	PID       int    `json:"pid"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	StartedAt string `json:"started_at"`
	// Home is the home folder of the user the daemon runs as, so a client
	// says a folder on this machine with ~ (empty when the system does not
	// say).
	Home string `json:"home,omitempty"`
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
	// Display says this connection shows panes to a person, so it gets
	// pane.focus.
	Display bool `json:"display,omitempty"`
	// Activity asks for pane.activity about the panes this connection
	// does not stream.
	Activity bool `json:"activity,omitempty"`
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
	Labels     map[string]string `json:"labels,omitempty"`
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
	// Labels keeps the panes that have every one of these labels.
	Labels map[string]string `json:"labels,omitempty"`
	// Processes adds each running pane's processes (Pane.PIDs).
	Processes bool `json:"processes,omitempty"`
}

// UpdateRequest changes a pane's name and labels. A label set to null is
// removed.
type UpdateRequest struct {
	Envelope
	Pane       string             `json:"pane"`
	Name       *string            `json:"name,omitempty"`
	Labels     map[string]*string `json:"labels,omitempty"`
	Scrollback *int               `json:"scrollback,omitempty"`
}

type ListResult struct {
	Panes []Pane `json:"panes"`
}

type CloseRequest struct {
	Envelope
	Pane    string `json:"pane"`
	GraceMs *int64 `json:"grace_ms,omitempty"`
	// NoWait: as in pane.send, for a pane this connection did not start.
	NoWait bool `json:"no_wait,omitempty"`
	// Reason: the agent's own words on why, shown on the drive checkpoint
	// this opens (at most 1000 bytes).
	Reason string `json:"reason,omitempty"`
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

type ClearRequest struct {
	Envelope
	Pane string `json:"pane"`
}

type ClearResult struct {
	Pane    Pane `json:"pane"`
	Cleared bool `json:"cleared"`
}

type CaptureRequest struct {
	Envelope
	Pane    string `json:"pane"`
	Styles  bool   `json:"styles,omitempty"`
	History int    `json:"history,omitempty"`
	VT      bool   `json:"vt,omitempty"`
	Links   bool   `json:"links,omitempty"`
}

type CaptureResult struct {
	// Pane: absent in a headless replay's capture.
	Pane      string `json:"pane,omitempty"`
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
	// Wrapped: the row runs on into the next (a soft wrap).
	Wrapped bool `json:"wrapped,omitempty"`
	// Links: the row's hyperlinks (OSC 8), with `links`.
	Links []LineLink `json:"links,omitempty"`
}

// LineLink is a run of cells that carry one hyperlink (OSC 8).
type LineLink struct {
	Col   int    `json:"col"`
	Width int    `json:"width"`
	Text  string `json:"text"`
	URI   string `json:"uri"`
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
	// By says who typed it, for a client that passes on a person's own
	// typing (the composer, the phone): on a person's connection it makes
	// the input the person's.
	By string `json:"by,omitempty"`
	// NoWait: when this connection may not drive the pane yet, fail at
	// once (forbidden, with the checkpoint) instead of waiting for the
	// person.
	NoWait bool `json:"no_wait,omitempty"`
	// Reason: the agent's own words on why, shown on the drive checkpoint
	// this opens (at most 1000 bytes).
	Reason string `json:"reason,omitempty"`
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
	Prompt    bool    `json:"prompt,omitempty"`
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
	Shell     *Shell      `json:"shell,omitempty"`
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
	By        string  `json:"by,omitempty"`
	NoWait    bool    `json:"no_wait,omitempty"`
	// Reason: the agent's own words on why, shown on the drive checkpoint
	// this opens (at most 1000 bytes).
	Reason string `json:"reason,omitempty"`
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
	// KittyKeyboard: the client sends keys in the Kitty keyboard
	// protocol's encodings when the program turns them on.
	KittyKeyboard bool `json:"kitty_keyboard,omitempty"`
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
	ID           string            `json:"id"`
	Name         string            `json:"name,omitempty"`
	Labels       map[string]string `json:"labels,omitempty"`
	Command      []string          `json:"command"`
	Cwd          string            `json:"cwd"`
	PID          int               `json:"pid"`
	Cols         int               `json:"cols"`
	Rows         int               `json:"rows"`
	Scrollback   int               `json:"scrollback,omitempty"`
	Hidden       bool              `json:"hidden"`
	TTLMs        int64             `json:"ttl_ms,omitempty"`
	CreatedAt    string            `json:"created_at"`
	Title        string            `json:"title"`
	Mark         uint64            `json:"mark"`
	LastOutputAt string            `json:"last_output_at,omitempty"`
	State        string            `json:"state"`
	Exit         *Exit             `json:"exit,omitempty"`
	ExitedAt     string            `json:"exited_at,omitempty"`
	// Shell is set once the program marked a prompt with OSC 133.
	Shell *Shell `json:"shell,omitempty"`
	// Agent is set once an agent reported on this pane.
	Agent *AgentStatus `json:"agent,omitempty"`
	// PIDs are the processes that belong to the pane now (section 3),
	// when pane.list asked for them.
	PIDs []int `json:"pids,omitempty"`
	// Creator is who started the pane: an agent drives the panes it
	// created and asks for any other.
	Creator *Source `json:"creator,omitempty"`
	// Lease is the driver that holds the pane now, when one does.
	Lease *Lease `json:"lease,omitempty"`
	// Overrides are the test conditions set on the pane (pane.override).
	Overrides *Overrides `json:"overrides,omitempty"`
}

// Shell is what OSC 133 marks say about the shell in a pane.
type Shell struct {
	// State is "running" from a command's start to its end, else "prompt".
	State string `json:"state"`
	// Command is the running command, or the last one, when the shell
	// sent it.
	Command string `json:"command,omitempty"`
	// ExitCode is the last finished command's status, when the shell sent it.
	ExitCode *int `json:"exit_code,omitempty"`
	// Mark and At say when the state last changed.
	Mark uint64 `json:"mark"`
	At   string `json:"at"`
}

// Need is what an agent waits for from a person.
type Need struct {
	// Kind is "permission", "question", "auth" or "other".
	Kind    string `json:"kind"`
	Message string `json:"message,omitempty"`
}

// AgentStatus is the state of the agent in a pane.
type AgentStatus struct {
	// State is "working", "needs_you", "idle" or "ended".
	State     string `json:"state"`
	Since     string `json:"since"`
	Assistant string `json:"assistant"`
	Session   string `json:"session,omitempty"`
	Need      *Need  `json:"need,omitempty"`
	// Event, At and Source describe the last report.
	Event  string `json:"event"`
	At     string `json:"at"`
	Source string `json:"source"`
	Seq    uint64 `json:"seq"`
}

// AgentReport is one recorded agent event.
type AgentReport struct {
	Seq       uint64          `json:"seq"`
	At        string          `json:"at"`
	Pane      string          `json:"pane,omitempty"`
	Assistant string          `json:"assistant"`
	Source    string          `json:"source"`
	Event     string          `json:"event"`
	Session   string          `json:"session,omitempty"`
	State     string          `json:"state,omitempty"`
	Need      *Need           `json:"need,omitempty"`
	Message   string          `json:"message,omitempty"`
	Cwd       string          `json:"cwd,omitempty"`
	PID       int             `json:"pid,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
}

// Process describes a process.
type Process struct {
	PID       int      `json:"pid"`
	Argv      []string `json:"argv"`
	Exe       string   `json:"exe,omitempty"`
	Cwd       string   `json:"cwd,omitempty"`
	StartedAt string   `json:"started_at,omitempty"`
	// What changed since it started (pane.process).
	ExeModifiedAt string    `json:"exe_modified_at,omitempty"`
	Git           *GitState `json:"git,omitempty"`
	Changed       *bool     `json:"changed,omitempty"`
	Changes       []string  `json:"changes,omitempty"`
}

// GitState is the git work tree a process works in.
type GitState struct {
	Root      string   `json:"root"`
	Head      string   `json:"head,omitempty"`
	Branch    string   `json:"branch,omitempty"`
	StartedOn string   `json:"started_on,omitempty"`
	Edited    []string `json:"edited,omitempty"`
	Partial   bool     `json:"partial,omitempty"`
}

type ProcessRequest struct {
	Envelope
	Pane string `json:"pane"`
}

type ProcessResult struct {
	Pane       string  `json:"pane"`
	Foreground Process `json:"foreground"`
	// Busy: the foreground is not the pane's first process (a command runs
	// in the shell, or the program it started is still going), which is
	// when a window asks before closing it.
	Busy bool `json:"busy"`
}

type RestartRequest struct {
	Envelope
	Pane         string `json:"pane"`
	GraceMs      *int64 `json:"grace_ms,omitempty"`
	ShellCommand bool   `json:"shell_command,omitempty"`
	NoWait       bool   `json:"no_wait,omitempty"`
	// Reason: the agent's own words on why, shown on the drive checkpoint
	// this opens (at most 1000 bytes).
	Reason string `json:"reason,omitempty"`
}

type RestartResult struct {
	Pane     Pane `json:"pane"`
	Replaced Pane `json:"replaced"`
	// With shell_command: the command line typed again, the mark just
	// before it, and what ended the command.
	Command   string  `json:"command,omitempty"`
	Mark      *uint64 `json:"mark,omitempty"`
	StoppedBy string  `json:"stopped_by,omitempty"`
}

type FocusRequest struct {
	Envelope
	Pane string `json:"pane"`
}

type FocusResult struct {
	Displays int `json:"displays"`
}

type AgentReportRequest struct {
	Envelope
	Pane      string          `json:"pane,omitempty"`
	Assistant string          `json:"assistant"`
	Event     string          `json:"event"`
	Session   string          `json:"session,omitempty"`
	State     string          `json:"state,omitempty"`
	Need      *Need           `json:"need,omitempty"`
	Message   string          `json:"message,omitempty"`
	Cwd       string          `json:"cwd,omitempty"`
	PID       int             `json:"pid,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
	Decide    bool            `json:"decide,omitempty"`
	TimeoutMs *int64          `json:"timeout_ms,omitempty"`
}

// Reply is what a decider tells a hook to answer its assistant with.
type Reply struct {
	Stdout   string `json:"stdout,omitempty"`
	Stderr   string `json:"stderr,omitempty"`
	ExitCode int    `json:"exit_code,omitempty"`
}

type AgentReportResult struct {
	Seq   uint64 `json:"seq"`
	Asked int    `json:"asked"`
	Reply *Reply `json:"reply,omitempty"`
}

type AgentEventsRequest struct {
	Envelope
	Pane  string  `json:"pane,omitempty"`
	Since *uint64 `json:"since,omitempty"`
	Limit *int    `json:"limit,omitempty"`
}

type AgentEventsResult struct {
	Reports   []AgentReport `json:"reports"`
	Seq       uint64        `json:"seq"`
	Truncated bool          `json:"truncated"`
}

type AgentDecisionsRequest struct {
	Envelope
}

type AgentDecideRequest struct {
	Envelope
	Request *uint64 `json:"request"`
	Reply   *Reply  `json:"reply,omitempty"`
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
	// FrameRender is a render stream's frame (docs/RENDERING.md); its
	// mark is 0.
	FrameRender byte = 4
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

// ------------------------------------------------------------ files

type FileStatRequest struct {
	Envelope
	Paths []string `json:"paths"`
}

// FileInfo describes one path. Type is "file", "dir", "other", or "none"
// when nothing is there (or it cannot be reached); then only Path is set
// besides it.
type FileInfo struct {
	Path       string `json:"path"`
	Type       string `json:"type"`
	Size       *int64 `json:"size,omitempty"`
	ModifiedAt string `json:"modified_at,omitempty"`
}

type FileStatResult struct {
	Files []FileInfo `json:"files"`
}

type FileReadRequest struct {
	Envelope
	Path   string `json:"path"`
	Offset *int64 `json:"offset,omitempty"`
	Tail   *int64 `json:"tail,omitempty"`
	Limit  *int   `json:"limit,omitempty"`
	Format string `json:"format,omitempty"`
}

type FileReadResult struct {
	Path       string  `json:"path"`
	Size       int64   `json:"size"`
	ModifiedAt string  `json:"modified_at"`
	From       int64   `json:"from"`
	To         int64   `json:"to"`
	Text       *string `json:"text,omitempty"`
	Data       *string `json:"data,omitempty"`
}

// ------------------------------------------------------------ checkpoints

// SecretTarget says where a secret a person types goes: "input", typed
// into a pane that runs already (Pane); "run", typed into the checkpoint's
// Command, which starts in a new pane, once it waits for input; or "env",
// the environment variable Env of the Command. Enter (default true) ends
// typed input with Enter.
type SecretTarget struct {
	To    string `json:"to"`
	Pane  string `json:"pane,omitempty"`
	Enter *bool  `json:"enter,omitempty"`
	Env   string `json:"env,omitempty"`
}

// CheckpointAnswer is what a person answered. It never holds a secret:
// a delivered secret is only Delivered. Command is the command as the
// person edited it before approving (it ran instead of the proposed one),
// set only when it differs; Reason is why they declined, when they said.
type CheckpointAnswer struct {
	Choice    *int    `json:"choice,omitempty"`
	Option    string  `json:"option,omitempty"`
	Text      *string `json:"text,omitempty"`
	Approved  *bool   `json:"approved,omitempty"`
	Command   string  `json:"command,omitempty"`
	Delivered bool    `json:"delivered,omitempty"`
	// Allow: how long an approved drive lasts (once, session).
	Allow string `json:"allow,omitempty"`
	// Pick: the variant a person chose, and where and what they said.
	Pick     *Pick  `json:"pick,omitempty"`
	Declined bool   `json:"declined,omitempty"`
	Reason   string `json:"reason,omitempty"`
	By       string `json:"by,omitempty"`
	At       string `json:"at"`
}

// CheckpointRun is a command a person let run: the pane it ran in, and
// once it ended, its exit and the end of its output.
type CheckpointRun struct {
	Pane      string `json:"pane"`
	Exit      *Exit  `json:"exit,omitempty"`
	Output    string `json:"output,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

// Checkpoint is a point where an agent waits for a person: a question
// (ask), a command to approve (approve), or a secret to type (secret).
type Checkpoint struct {
	ID        string   `json:"id"`
	Kind      string   `json:"kind"`
	State     string   `json:"state"`
	Title     string   `json:"title"`
	Pane      string   `json:"pane,omitempty"`
	Assistant string   `json:"assistant,omitempty"`
	Options   []string `json:"options,omitempty"`
	FreeText  bool     `json:"free_text,omitempty"`
	Command   string   `json:"command,omitempty"`
	Cwd       string   `json:"cwd,omitempty"`
	Why       string   `json:"why,omitempty"`
	Warning   string   `json:"warning,omitempty"`
	// Env: approve, variables the command runs with (a page's button
	// passes an item's values this way, never inside the command line).
	Env    map[string]string `json:"env,omitempty"`
	Secret *SecretTarget     `json:"secret,omitempty"`
	// Drive: an agent asks to type into a pane it did not create.
	Drive *Drive `json:"drive,omitempty"`
	// Variants: a pick's pictures or pages.
	Variants  []Variant `json:"variants,omitempty"`
	CreatedAt string    `json:"created_at"`
	ExpiresAt string    `json:"expires_at"`
	ClosedAt  string    `json:"closed_at,omitempty"`
	Reason    string    `json:"reason,omitempty"`
	// AnsweredIn: a cancelled one the person answered another way
	// instead (terminal: they wrote to the agent in its own terminal).
	AnsweredIn string            `json:"answered_in,omitempty"`
	Answer     *CheckpointAnswer `json:"answer,omitempty"`
	Run        *CheckpointRun    `json:"run,omitempty"`
	// NobodyWaiting: a closed one no client was waiting on as it closed
	// (no checkpoint.wait, as after ask --no-wait): the hub then types the
	// answer into the asking session.
	NobodyWaiting bool `json:"nobody_waiting,omitempty"`
}

type CheckpointNewRequest struct {
	Envelope
	Kind      string            `json:"kind"`
	Title     string            `json:"title"`
	Pane      string            `json:"pane,omitempty"`
	Options   []string          `json:"options,omitempty"`
	FreeText  bool              `json:"free_text,omitempty"`
	Command   string            `json:"command,omitempty"`
	Cwd       string            `json:"cwd,omitempty"`
	Why       string            `json:"why,omitempty"`
	Warning   string            `json:"warning,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	Secret    *SecretTarget     `json:"secret,omitempty"`
	Drive     *DriveRequest     `json:"drive,omitempty"`
	Variants  []VariantRequest  `json:"variants,omitempty"`
	TimeoutMs *int64            `json:"timeout_ms,omitempty"`
}

type CheckpointResult struct {
	Checkpoint Checkpoint `json:"checkpoint"`
}

type CheckpointListRequest struct {
	Envelope
	All bool `json:"all,omitempty"`
}

type CheckpointListResult struct {
	Checkpoints []Checkpoint `json:"checkpoints"`
}

type CheckpointWaitRequest struct {
	Envelope
	Checkpoint string `json:"checkpoint"`
	TimeoutMs  *int64 `json:"timeout_ms,omitempty"`
}

type CheckpointAnswerRequest struct {
	Envelope
	Checkpoint string  `json:"checkpoint"`
	Choice     *int    `json:"choice,omitempty"`
	Text       *string `json:"text,omitempty"`
	Approve    bool    `json:"approve,omitempty"`
	Secret     *string `json:"secret,omitempty"`
	Decline    bool    `json:"decline,omitempty"`
	// Command, with Approve: the command as the person edited it, which
	// runs instead of the proposed one.
	Command *string `json:"command,omitempty"`
	// Reason, with Decline: why, for the agent.
	Reason *string `json:"reason,omitempty"`
	By     string  `json:"by,omitempty"`
	// Allow, with Approve on a drive: once (default) or session.
	Allow string `json:"allow,omitempty"`
	// Pick answers a pick.
	Pick *Pick `json:"pick,omitempty"`
}

type CheckpointCancelRequest struct {
	Envelope
	Checkpoint string `json:"checkpoint"`
	Reason     string `json:"reason,omitempty"`
	// AnsweredIn: why it is withdrawn, when the person answered the agent
	// another way (terminal). The waiting agent is told to read it there.
	AnsweredIn string `json:"answered_in,omitempty"`
}

// ------------------------------------------------------------ render stream

// RenderRequest starts a render stream (docs/RENDERING.md).
type RenderRequest struct {
	Envelope
	Pane string `json:"pane"`
	// Cols and Rows resize the pane before the first frame.
	Cols *int `json:"cols,omitempty"`
	Rows *int `json:"rows,omitempty"`
	// FPS is the client's display rate: at most this many frames a
	// second. Window: frames sent and not yet acknowledged, at most.
	FPS    *int `json:"fps,omitempty"`
	Window *int `json:"window,omitempty"`
	// Keybinds names the key bindings the daemon applies to this
	// stream's keys before encoding them: "macos" or "none" (default).
	Keybinds *string `json:"keybinds,omitempty"`
}

type RenderResult struct {
	Pane    string `json:"pane"`
	Channel uint32 `json:"channel"`
	// Format is the frame format's version.
	Format int `json:"format"`
}

type RenderScrollRequest struct {
	Envelope
	Channel *uint32 `json:"channel"`
	// Offset: rows up from the bottom; 0 is the live screen.
	Offset *int `json:"offset"`
}

type RenderInputRequest struct {
	Envelope
	Channel *uint32       `json:"channel"`
	Events  []RenderEvent `json:"events"`
}

// RenderEvent is one input event: exactly one field is set.
type RenderEvent struct {
	Key   *RenderKey   `json:"key,omitempty"`
	Mouse *RenderMouse `json:"mouse,omitempty"`
	// Text an input method committed, sent as typed.
	Text *string `json:"text,omitempty"`
	// Paste is pasted text (bracketed when the program asked).
	Paste *string `json:"paste,omitempty"`
	// Focus: the client's view gained (true) or lost focus.
	Focus *bool `json:"focus,omitempty"`
	// Wheel: a wheel or trackpad movement.
	Wheel *RenderWheel `json:"wheel,omitempty"`
	// Select: a step of a selection gesture.
	Select *RenderSelect `json:"select,omitempty"`
	// Paths: files dropped on the view, pasted as their paths, quoted.
	Paths []string `json:"paths,omitempty"`
}

// RenderWheel is a wheel or trackpad movement: Rows up (positive) or
// down, a fraction of a row on a trackpad; the pointer as for a mouse
// event.
type RenderWheel struct {
	Rows       float64 `json:"rows"`
	Mods       int     `json:"mods,omitempty"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	CellWidth  float64 `json:"cell_width"`
	CellHeight float64 `json:"cell_height"`
}

// RenderSelect is a step of a selection gesture: the cell under the
// pointer in screen coordinates (Col, Row), the pointer from the grid's
// corner and the cell's size in the client's units.
type RenderSelect struct {
	Action     string  `json:"action"`
	Col        int     `json:"col,omitempty"`
	Row        int     `json:"row,omitempty"`
	X          float64 `json:"x,omitempty"`
	Y          float64 `json:"y,omitempty"`
	CellWidth  float64 `json:"cell_width,omitempty"`
	CellHeight float64 `json:"cell_height,omitempty"`
	Extend     bool    `json:"extend,omitempty"`
	Rect       bool    `json:"rect,omitempty"`
}

type RenderKey struct {
	Code        string `json:"code"`
	Action      string `json:"action,omitempty"`
	Mods        int    `json:"mods,omitempty"`
	Consumed    int    `json:"consumed,omitempty"`
	Text        string `json:"text,omitempty"`
	Unshifted   int    `json:"unshifted,omitempty"`
	Composing   bool   `json:"composing,omitempty"`
	OptionAsAlt string `json:"option_as_alt,omitempty"`
}

type RenderMouse struct {
	Action     string  `json:"action"`
	Button     string  `json:"button,omitempty"`
	Mods       int     `json:"mods,omitempty"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	CellWidth  float64 `json:"cell_width"`
	CellHeight float64 `json:"cell_height"`
	Held       bool    `json:"held,omitempty"`
}

type RenderTextRequest struct {
	Envelope
	Channel *uint32     `json:"channel"`
	From    RenderPoint `json:"from"`
	To      RenderPoint `json:"to"`
	Rect    bool        `json:"rect,omitempty"`
}

// RenderPoint is a cell in screen coordinates: row 0 is the oldest row
// of the scrollback.
type RenderPoint struct {
	X int `json:"x"`
	Y int `json:"y"`
}

type RenderTextResult struct {
	Text string `json:"text"`
}

type RenderChannelRequest struct {
	Envelope
	Channel *uint32 `json:"channel"`
}

type RenderFindRequest struct {
	Envelope
	Channel *uint32 `json:"channel"`
	Needle  string  `json:"needle"`
	// Step: 1 the next match toward older output, -1 toward newer, 0
	// keeps the selected one.
	Step int `json:"step,omitempty"`
	// CaseSensitive: letters match only in the needle's case (else any
	// case). Regex: the needle is a regular expression (RE2).
	CaseSensitive bool `json:"case_sensitive,omitempty"`
	Regex         bool `json:"regex,omitempty"`
}

type RenderFindResult struct {
	Count    int `json:"count"`
	Selected int `json:"selected"`
	// PatternError: the regular expression does not parse, and why
	// ("missing closing )"); there are then no matches.
	PatternError string `json:"pattern_error,omitempty"`
	// Rows: the rows the matches start on, from the top of the
	// scrollback, each once (at most FindMarksMax, spread over them all),
	// and Lines the rows in all (scrollback and screen): where a
	// scrollbar marks the matches.
	Rows  []int `json:"rows,omitempty"`
	Lines int   `json:"lines,omitempty"`
}

// FindMarksMax is the most rows render.find lists for the scrollbar's marks.
const FindMarksMax = 1000

type RenderLinkRequest struct {
	Envelope
	Channel *uint32     `json:"channel"`
	At      RenderPoint `json:"at"`
}

// RenderLinkResult: no uri when there is no link on the cell.
type RenderLinkResult struct {
	URI  string       `json:"uri,omitempty"`
	From *RenderPoint `json:"from,omitempty"`
	To   *RenderPoint `json:"to,omitempty"`
}
