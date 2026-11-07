package proto

// Wire types added to v1 after its first draft (PROTOCOL.md section 10):
// who drives a pane and who typed what, leases, the files an agent
// touched, pictures and filmstrips of a pane, recordings and replay, and
// test conditions.

// Source says where input, a pane or a lease comes from. Kind is
// "person" (a person typed it: a display's keystrokes, or a person's
// client that says so with `by`), "agent" (a program inside a pane: Pane
// is that pane) or "client" (any other program: Client is its
// client.name).
type Source struct {
	Kind   string `json:"kind"`
	Pane   string `json:"pane,omitempty"`
	Client string `json:"client,omitempty"`
	By     string `json:"by,omitempty"`
}

// InputRecord is one entry of a pane's input log.
type InputRecord struct {
	Seq    uint64 `json:"seq"`
	At     string `json:"at"`
	Source Source `json:"source"`
	// Kind is "send" (pane.send, pane.settle), "keys" (a display's
	// keystrokes, gathered), "secret" (a secret a person gave through a
	// checkpoint: never its text) or "restart" (pane.restart with
	// shell_command typed the command again).
	Kind string `json:"kind"`
	// Mark is the pane's output position just before the input.
	Mark  uint64 `json:"mark"`
	Bytes int    `json:"bytes"`
	// Text is what was typed, for people: text as it was, keys as
	// <Name>. Left out for a secret, and masked (Masked) where the
	// terminal did not echo (a password prompt) or a secret of the pane
	// appears.
	Text      string `json:"text,omitempty"`
	Masked    bool   `json:"masked,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
	// LeaseHolder: the person typed while this other driver held the
	// pane's lease (a person is never held back by a lease; it is
	// marked).
	LeaseHolder *Source `json:"lease_holder,omitempty"`
	// Until is when the last keystroke of a gathered "keys" entry came.
	Until string `json:"until,omitempty"`
}

type InputsRequest struct {
	Envelope
	Pane  string  `json:"pane"`
	Since *uint64 `json:"since,omitempty"`
	Limit *int    `json:"limit,omitempty"`
}

type InputsResult struct {
	Pane      string        `json:"pane"`
	Inputs    []InputRecord `json:"inputs"`
	Seq       uint64        `json:"seq"`
	Truncated bool          `json:"truncated"`
}

// Grant lets an agent (or a client) drive a pane it did not create for
// its session: while the agent's assistant session lasts (or, for a
// client outside every pane, its connection), until a person revokes it
// or either pane closes. Allow is "session".
type Grant struct {
	ID    string `json:"id"`
	Pane  string `json:"pane"`
	Agent Source `json:"agent"`
	// Action is what it allows (as Drive.Action); a grant allows one.
	Action     string `json:"action,omitempty"`
	Allow      string `json:"allow"`
	Session    string `json:"session,omitempty"`
	Checkpoint string `json:"checkpoint,omitempty"`
	CreatedAt  string `json:"created_at"`
}

type GrantsRequest struct {
	Envelope
	Pane string `json:"pane,omitempty"`
}

type GrantsResult struct {
	Grants []Grant `json:"grants"`
}

type RevokeRequest struct {
	Envelope
	Grant string `json:"grant"`
}

type RevokeResult struct {
	Grant Grant `json:"grant"`
}

// Lease is one driver's hold on a pane.
type Lease struct {
	Holder     Source `json:"holder"`
	AcquiredAt string `json:"acquired_at"`
	ExpiresAt  string `json:"expires_at"`
	// Waiting is who waits for it, in turn: the first is handed the lease
	// when it ends.
	Waiting []Source `json:"waiting,omitempty"`
}

type LeaseRequest struct {
	Envelope
	Pane    string `json:"pane"`
	TTLMs   *int64 `json:"ttl_ms,omitempty"`
	WaitMs  *int64 `json:"wait_ms,omitempty"`
	Release bool   `json:"release,omitempty"`
	// RefuseWaiting, with a person's release: the drivers waiting for the
	// lease fail with leased instead of being handed it.
	RefuseWaiting bool `json:"refuse_waiting,omitempty"`
	NoWait        bool `json:"no_wait,omitempty"`
}

type LeaseResult struct {
	Pane  string `json:"pane"`
	Lease *Lease `json:"lease,omitempty"`
}

// FileTouch is a file an agent in a pane changed: Sources says how it is
// known ("hook": the assistant's PostToolUse named it; "git": git status
// in the pane's folder shows it changed).
type FileTouch struct {
	Path    string   `json:"path"`
	Sources []string `json:"sources"`
	Tool    string   `json:"tool,omitempty"`
	Count   int      `json:"count,omitempty"`
	At      string   `json:"at,omitempty"`
	Status  string   `json:"status,omitempty"`
}

type FilesRequest struct {
	Envelope
	Pane  string `json:"pane"`
	NoGit bool   `json:"no_git,omitempty"`
}

type FilesResult struct {
	Pane    string      `json:"pane"`
	Files   []FileTouch `json:"files"`
	GitRoot string      `json:"git_root,omitempty"`
	Partial bool        `json:"partial,omitempty"`
}

type ShotRequest struct {
	Envelope
	Pane     string   `json:"pane"`
	Cols     *int     `json:"cols,omitempty"`
	Rows     *int     `json:"rows,omitempty"`
	FontSize *float64 `json:"font_size,omitempty"`
	Cursor   *bool    `json:"cursor,omitempty"`
}

type ShotResult struct {
	Pane   string `json:"pane"`
	Mark   uint64 `json:"mark"`
	Cols   int    `json:"cols"`
	Rows   int    `json:"rows"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	PNG    string `json:"png"`
}

type FramesRequest struct {
	Envelope
	Pane      string   `json:"pane"`
	LastMs    *int64   `json:"last_ms,omitempty"`
	Format    string   `json:"format,omitempty"`
	MaxFrames *int     `json:"max_frames,omitempty"`
	FontSize  *float64 `json:"font_size,omitempty"`
}

// FilmFrame is one frame of a filmstrip.
type FilmFrame struct {
	At   string `json:"at"`
	Mark uint64 `json:"mark"`
	PNG  string `json:"png,omitempty"`
}

type FramesResult struct {
	Pane   string      `json:"pane,omitempty"`
	Format string      `json:"format"`
	Frames []FilmFrame `json:"frames"`
	From   string      `json:"from,omitempty"`
	To     string      `json:"to,omitempty"`
	// Skipped: frames of the span left out to keep to max_frames.
	Skipped int    `json:"skipped,omitempty"`
	Data    string `json:"data,omitempty"`
	Width   int    `json:"width,omitempty"`
	Height  int    `json:"height,omitempty"`
}

// Fixture is a recording of a pane's output with its timing: what
// pane.recording returns, ravenry fixture writes and pane.replay plays.
type Fixture struct {
	Format    string         `json:"format"` // "ravenry.fixture"
	Version   int            `json:"version"`
	Pane      string         `json:"pane,omitempty"`
	Command   []string       `json:"command,omitempty"`
	Term      string         `json:"term,omitempty"`
	Cols      int            `json:"cols"`
	Rows      int            `json:"rows"`
	StartedAt string         `json:"started_at,omitempty"`
	From      uint64         `json:"from"`
	To        uint64         `json:"to"`
	Events    []FixtureEvent `json:"events"`
}

// FixtureEvent is output (Data, base64) or a resize (Cols and Rows), T
// milliseconds after the fixture's start.
type FixtureEvent struct {
	T    int64  `json:"t"`
	Data string `json:"data,omitempty"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
}

type RecordingRequest struct {
	Envelope
	Pane   string  `json:"pane"`
	From   *uint64 `json:"from,omitempty"`
	To     *uint64 `json:"to,omitempty"`
	LastMs *int64  `json:"last_ms,omitempty"`
	Limit  *int    `json:"limit,omitempty"`
}

type RecordingResult struct {
	Fixture   Fixture `json:"fixture"`
	Truncated bool    `json:"truncated"`
}

type ReplayRequest struct {
	Envelope
	Fixture  *Fixture `json:"fixture"`
	Speed    *float64 `json:"speed,omitempty"`
	Cols     *int     `json:"cols,omitempty"`
	Rows     *int     `json:"rows,omitempty"`
	SlowBps  *int     `json:"slow_bps,omitempty"`
	Term     string   `json:"term,omitempty"`
	Headless bool     `json:"headless,omitempty"`
	Shot     bool     `json:"shot,omitempty"`
	Frames   string   `json:"frames,omitempty"`
	FontSize *float64 `json:"font_size,omitempty"`
	Name     string   `json:"name,omitempty"`
}

type ReplayResult struct {
	Pane    *Pane          `json:"pane,omitempty"`
	Capture *CaptureResult `json:"capture,omitempty"`
	PNG     string         `json:"png,omitempty"`
	Frames  *FramesResult  `json:"frames,omitempty"`
}

// Overrides are test conditions on a pane: its size (the program sees
// it and redraws), output slowed to SlowBps bytes a second, and the TERM
// its next restart gets.
type Overrides struct {
	Cols    int    `json:"cols,omitempty"`
	Rows    int    `json:"rows,omitempty"`
	SlowBps int    `json:"slow_bps,omitempty"`
	Term    string `json:"term,omitempty"`
}

type OverrideRequest struct {
	Envelope
	Pane    string  `json:"pane"`
	Cols    *int    `json:"cols,omitempty"`
	Rows    *int    `json:"rows,omitempty"`
	SlowBps *int    `json:"slow_bps,omitempty"`
	Term    *string `json:"term,omitempty"`
	Clear   bool    `json:"clear,omitempty"`
	Restart bool    `json:"restart,omitempty"`
	NoWait  bool    `json:"no_wait,omitempty"`
}

// ------------------------------------------------------------ checkpoints

// Drive is a drive checkpoint: Agent asks to type into Pane, which it did
// not create. Input is a preview of what it wants to type.
type Drive struct {
	Pane  string `json:"pane"`
	Agent Source `json:"agent"`
	Input string `json:"input,omitempty"`
	// Action is what the agent asks to do to the pane: "input" (type into
	// it), "close", "restart" or "override" (set its test conditions).
	// Absent means input.
	Action string `json:"action,omitempty"`
}

// DriveRequest is checkpoint.new's drive: the pane to drive. Who asks is
// the daemon's judgement of the connection, never the request's.
type DriveRequest struct {
	Pane   string `json:"pane"`
	Action string `json:"action,omitempty"`
}

// Variant is one choice of a pick.
type Variant struct {
	Label string `json:"label"`
	Path  string `json:"path"`
	Type  string `json:"type"` // "image" or "html"
	Size  int64  `json:"size"`
	Pane  string `json:"pane,omitempty"`
}

// VariantRequest is a variant as checkpoint.new takes it: a file, or Pane
// for a shot of that pane taken now.
type VariantRequest struct {
	Label string `json:"label"`
	Path  string `json:"path,omitempty"`
	Pane  string `json:"pane,omitempty"`
}

// Pick is a person's pick: the variant's label, optionally a region of it
// (fractions of its width and height) and a note ("this, but...").
type Pick struct {
	Label  string  `json:"label"`
	Region *Region `json:"region,omitempty"`
	Note   string  `json:"note,omitempty"`
}

type Region struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}
