package attach

import "bytes"

// NoPromptClear marks every prompt the pane prints (OSC 133;A, from the
// shell integration) with redraw=0, the Kitty extension that tells the
// window's terminal not to clear the prompt itself when it is resized.
//
// A terminal that knows the cursor is at a shell prompt clears the prompt's
// rows on a resize, because the shell redraws them at once (Ghostty and
// Kitty do). On a local pty that redraw follows within microseconds. Here
// it takes a round trip through the daemon, and the window draws the
// cleared rows in between: the command line vanishes on every step of a
// drag. The daemon's own screen still clears and redraws as before, and
// the shell's redraw reaches the window all the same.
func NoPromptClear(b []byte) []byte {
	if !bytes.Contains(b, promptStart) {
		return b
	}
	out := make([]byte, 0, len(b)+16)
	for {
		i := bytes.Index(b, promptStart)
		if i < 0 {
			return append(out, b...)
		}
		end := i + len(promptStart)
		out = append(out, b[:end]...)
		b = b[end:]
		// Only a whole A command: BEL, ST, or options after ';'.
		if len(b) > 0 && (b[0] == 0x07 || b[0] == 0x1b || b[0] == ';') && !bytes.HasPrefix(b, []byte(";redraw=")) {
			out = append(out, ";redraw=0"...)
		}
	}
}

var promptStart = []byte("\x1b]133;A")
