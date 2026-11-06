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
	// AltScreen reports whether the alternate screen is active.
	AltScreen() bool
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
	// Bell is called on BEL.
	Bell func()
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
