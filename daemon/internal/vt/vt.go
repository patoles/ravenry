// Package vt is ravenryd's terminal state engine: it parses what a pane
// prints and keeps the pane's screen, so the daemon can answer "what is on
// screen", rebuild the screen for a client that attaches, and encode keys
// the way the running program expects.
//
// The rest of the daemon sees only the Screen interface below. The one
// implementation (ghostty.go) wraps libghostty-vt through
// go.mitchellh.com/libghostty, whose Go API is still in flux; keeping it
// behind this interface means an API change touches this package only.
//
// A Screen is not safe for concurrent use: the caller serializes access.
package vt

// Screen holds one pane's terminal state.
type Screen interface {
	// Write feeds output from the pane's program.
	Write(p []byte)
	// Resize changes the grid size.
	Resize(cols, rows int) error
	// Size returns the grid size.
	Size() (cols, rows int)
	// Capture reads the screen: text, cell styles, cursor.
	Capture(opts CaptureOptions) (*Capture, error)
	// Text returns the visible rows as plain text, one line per row, with
	// trailing spaces removed. It is cheaper than Capture.
	Text() ([]string, error)
	// Snapshot returns VT sequences that rebuild the current screen, its
	// scrollback, the cursor and the modes in a fresh terminal of the same
	// size (xterm.js, or another Screen).
	Snapshot() ([]byte, error)
	// EncodeKey turns a key press into the bytes the program expects, given
	// the modes it has set (application cursor keys, the Kitty keyboard
	// protocol, and so on).
	EncodeKey(k Key) ([]byte, error)
	// EncodePaste wraps text for a paste: bracketed when the program has
	// turned bracketed paste on (mode 2004), and with unsafe control
	// characters removed when it has not.
	EncodePaste(text []byte) ([]byte, error)
	// Title is the window title the program set (OSC 0 or 2).
	Title() string
	// SetScrollback changes how many history lines are kept; lines past a
	// smaller limit go.
	SetScrollback(lines int) error
	// AltScreen reports whether the alternate screen is active.
	AltScreen() bool
	// Grid reads the visible screen cell by cell, with resolved colours,
	// for a picture of it (package render).
	Grid() (*Grid, error)
	// Clear clears the screen and its history for Cmd+K: the prompt
	// stays and moves to the top, and everything above it goes. The
	// prompt is the cursor's row, or, when the shell marks its prompts
	// (OSC 133) and the cursor is at one, the whole prompt from its first
	// row. The program is not told. On the
	// alternate screen, which belongs to a full-screen program, it changes
	// nothing and returns false.
	Clear() (bool, error)
	// Render reads the live screen for a render stream (RENDERING.md):
	// row gets each row that may have changed since the last call, in
	// the stream's wire format (only valid during the call), and wrap
	// says the row continues on the next. During a program's render
	// hold (synchronized output, at most a second) the rows are those of
	// the last frame it finished, and held is true. all: every row.
	Render(all bool, row func(y int, wrap bool, data []byte)) (info RenderInfo, held bool, err error)
	// SetView sets the size Render and RenderAt read the screen at while
	// the grid keeps its own (0, 0: the grid's): the rows cut at a
	// narrower width and padded at a wider one, the last rows of a
	// shorter view shown (the cursor moved up with them), a taller one
	// padded below. A program told its new size only when a drag of a
	// window's edge pauses is drawn this way at each step (pane, Resize).
	SetView(cols, rows int)
	// Freeze keeps Render on the frame it would read now (or, during a
	// program's synchronized update, the last one the program finished)
	// until Thaw, or for renderHoldMax at most, as a render hold does:
	// a program resized (pane, Resize) is shown as it was until it has
	// drawn itself at its new size, not reflowed in between.
	Freeze()
	// Thaw ends Freeze.
	Thaw()
	// RenderAt reads every row of the screen scrolled offset rows up
	// into the scrollback (clamped to it).
	RenderAt(offset int, row func(y int, wrap bool, data []byte)) (RenderInfo, error)
	// LinkURI is the URI of a hyperlink id in a rendered row.
	LinkURI(id uint16) string
	// AtPrompt reports whether the cursor is at a shell prompt, which a
	// resize clears for the shell to draw again.
	AtPrompt() bool
	// TextRange is the text between two points, inclusive, in screen
	// coordinates (row 0 is the oldest scrollback row), as a copy:
	// wrapped rows joined, trailing spaces trimmed. rect: a block.
	TextRange(x0, y0, x1, y1 int, rect bool) (string, error)
	// EncodeKeyEvent, EncodeMouse and EncodeFocus encode a client's
	// input for the program's current modes (input.go).
	EncodeKeyEvent(k KeyEvent) ([]byte, error)
	EncodeMouse(m MouseEvent) ([]byte, error)
	EncodeFocus(focused bool) ([]byte, error)
	// Select applies a step of a selection gesture (select.go); Selection
	// is the selection, SelectionText its text as a copy reads it.
	Select(e SelectEvent) error
	Selection() (Range, bool)
	SelectionText() (string, error)
	// NewFind starts a search of the screen and its scrollback (find.go):
	// a literal in any case or in its case, or a regular expression.
	NewFind() (*Find, error)
	// LinkAt is the link on a cell in screen coordinates: a hyperlink
	// (OSC 8) or a URL in the text.
	LinkAt(x, y int) (Link, bool)
	// Close frees the screen.
	Close()
}

// Options configures a new Screen.
type Options struct {
	Cols, Rows int
	// Scrollback is the number of history lines kept above the screen.
	Scrollback int
	// Reply receives bytes the terminal answers with (device attributes,
	// cursor position reports and other query replies). The caller writes
	// them to the pane's pty. The slice is only valid during the call.
	Reply func(p []byte)
	// KittyKeyboard says whether the keys reaching the program can come
	// in the Kitty keyboard protocol's encodings. When it is set and
	// returns false, the screen does not answer the protocol's query
	// (CSI ? u), as a terminal without the protocol, so the program keeps
	// to the legacy encodings. It runs while Write processes the output.
	KittyKeyboard func() bool
	// Bell is called on BEL.
	Bell func()
	// Prompt is called when the shell marks a step of a command with OSC
	// 133 (shell integration): a prompt starts, input starts, a command
	// starts running, a command ends. It runs while Write processes the
	// output, after the screen has been updated.
	Prompt func(PromptMark)
	// Status is called for an OSC 7501 program status report (a program
	// saying it is working, blocked on the user, idle, done or failed).
	// When it is set, the terminal also answers a program that asks
	// whether reports are supported. It runs while Write processes the
	// output.
	Status func(ProgramStatus)
	// Pwd is called when the program reports its working directory with
	// OSC 7, with the URL as sent (file://host/path, percent-encoded). It
	// runs while Write processes the output.
	Pwd func(url string)
}

// PromptKind is the step of a shell command an OSC 133 mark reports.
type PromptKind uint8

const (
	// PromptStart: the shell starts drawing a prompt (OSC 133 A).
	PromptStart PromptKind = iota + 1
	// InputStart: the prompt is drawn and the user can type (OSC 133 B).
	InputStart
	// OutputStart: a command was submitted and runs (OSC 133 C).
	OutputStart
	// CommandEnd: the command finished (OSC 133 D).
	CommandEnd
)

// PromptMark is one OSC 133 mark.
type PromptMark struct {
	Kind PromptKind
	// Command is the command line, for OutputStart, when the shell sent it.
	Command string
	// ExitCode is the command's status, for CommandEnd, when HasExitCode.
	ExitCode    int
	HasExitCode bool
}

// ProgramStatus is an OSC 7501 report. State is "idle", "working",
// "done", "blocked", "error" or "clear"; Kind, for "blocked", is
// "permission", "question", "auth" or empty. Progress is 0 to 100, or -1.
type ProgramStatus struct {
	State, Kind             string
	Progress                int
	ID, App, Title, Message string
}

// CaptureOptions selects what Capture returns.
type CaptureOptions struct {
	// Styles adds the styled runs of each line.
	Styles bool
	// History adds up to this many scrollback lines above the screen.
	History int
}

// Capture is a read of the screen.
type Capture struct {
	Cols, Rows int
	// Lines holds History lines first (oldest first), then one per row.
	Lines []Line
	// History is how many entries at the start of Lines are scrollback.
	History int
	Cursor  Cursor
	Alt     bool
	Title   string
}

// Line is one row of text and, when asked for, its styled runs.
type Line struct {
	Text  string
	Spans []Span
	// Wrapped: the row runs on into the next one (a soft wrap), so the two
	// are one line of text that the terminal's width cut.
	Wrapped bool
}

// Span is a run of cells with one style that is not the default style.
type Span struct {
	Col, Width int
	Text       string
	Style      Style
}

// Style is a cell's look.
type Style struct {
	Bold, Dim, Italic, Underline, Blink, Inverse, Invisible, Strike bool
	Fg, Bg                                                          Color
}

// Color is a cell color: none (the default), a palette index, or RGB.
type Color struct {
	Kind    ColorKind
	Index   uint8
	R, G, B uint8
}

// ColorKind tells which fields of a Color are set.
type ColorKind uint8

const (
	ColorDefault ColorKind = iota
	ColorPalette
	ColorRGB
)

// Cursor is the cursor position, 0-based, on the visible screen.
type Cursor struct {
	X, Y    int
	Visible bool
}

// Key is a key press: a named key or a character, plus modifiers.
type Key struct {
	// Name is a key name from KeyNames, or empty when Char is set.
	Name string
	// Char is the character a printable key produces, without modifiers.
	Char                    rune
	Ctrl, Alt, Shift, Super bool
}

// RGB is a resolved colour.
type RGB struct{ R, G, B uint8 }

// Grid is the visible screen cell by cell, with every colour resolved
// through the terminal's palette, for drawing a picture of it.
type Grid struct {
	Cols, Rows int
	// Cells holds Rows rows of Cols cells.
	Cells  [][]Cell
	Cursor Cursor
	// CursorStyle is "block", "bar", "underline" or "block_hollow".
	CursorStyle string
	// Fg and Bg are the default colours: the ones the program set with
	// OSC 10 and 11, else the screen's defaults.
	Fg, Bg RGB
	// CursorColor is the cursor's colour when the program set one (OSC
	// 12); nil means Fg.
	CursorColor *RGB
	// FgSet and BgSet: the program set the default colours (OSC 10, 11).
	FgSet, BgSet bool
	// PaletteSet[i]: the program changed palette entry i (OSC 4).
	PaletteSet [16]bool
}

// Cell is one cell of a Grid.
type Cell struct {
	// Text is the grapheme cluster, or "" for an empty cell.
	Text string
	// Wide: a wide character, which covers this cell and the next.
	Wide bool
	// Spacer: the second half of a wide character, drawn by the first.
	Spacer bool
	Fg, Bg RGB
	// HasFg and HasBg are false when the cell uses the default colour.
	HasFg, HasBg bool
	// FgIndex and BgIndex are the palette entry a colour came from (Fg and
	// Bg hold it resolved), or -1 for a direct colour or the default: a
	// picture drawn in a window's theme maps entries 0 to 15 to its own.
	FgIndex, BgIndex                                           int16
	Bold, Faint, Italic, Underline, Strike, Inverse, Invisible bool
}
