package vt

import "fmt"

// Key bindings that send fixed bytes instead of the encoder's: the keys a
// platform's people expect a terminal to give the shell's line editor
// (to the start of the line, a word left), which a terminal emulator
// binds rather than encodes. A render stream's client picks a table by
// name (pane.render `keybinds`), so every client of one platform shares
// it and none types it again; a setting can later replace single rows.

// KeyBind is one binding: a physical key (a W3C code) with exactly these
// modifiers (Shift, Ctrl, Alt, Super; Caps Lock and Num Lock ignored)
// sends Send on a press or a repeat, whatever the program's key modes.
type KeyBind struct {
	Code string
	Mods uint8
	Send string
	// What it does at a shell prompt (zsh's and readline's emacs keys).
	Does string
}

// MacOSKeybinds is the "macos" table. The first five are Ghostty's own
// macOS defaults (src/config/Config.zig, "Natural text editing", at the
// libghostty pin daemon/scripts/libghostty.sh builds), which Rex, built
// on Ghostty, has too; the Electron app sends the same
// (apps/desktop/src/renderer/terminal.ts MAC_CMD_SEND, MAC_OPT_SEND,
// SHIFT_SEND). Like Ghostty's, they go out as these bytes even when the
// program asked for the Kitty keyboard protocol.
//
// Not in the table, because the encoder already gives what a Mac person
// expects: Option+Backspace is ESC DEL (backward-kill-word), Ctrl+Left
// and Ctrl+Right are CSI 1;5D and CSI 1;5C, as in Ghostty (zsh's shell
// integration binds them to a word left and right).
var MacOSKeybinds = []KeyBind{
	{Code: "ArrowLeft", Mods: ModSuper, Send: "\x01", Does: "beginning-of-line (Ctrl+A)"},
	{Code: "ArrowRight", Mods: ModSuper, Send: "\x05", Does: "end-of-line (Ctrl+E)"},
	{Code: "Backspace", Mods: ModSuper, Send: "\x15", Does: "kill to the start of the line (Ctrl+U)"},
	{Code: "ArrowLeft", Mods: ModAlt, Send: "\x1bb", Does: "backward-word (Esc b)"},
	{Code: "ArrowRight", Mods: ModAlt, Send: "\x1bf", Does: "forward-word (Esc f)"},
	// Ravenry's, beside Ghostty's: the forward Delete key as a Mac's
	// text fields have it, and Shift+Enter as the Electron app sends it.
	{Code: "Delete", Mods: ModSuper, Send: "\x0b", Does: "kill to the end of the line (Ctrl+K)"},
	{Code: "Delete", Mods: ModAlt, Send: "\x1bd", Does: "kill-word (Esc d)"},
	{Code: "Enter", Mods: ModShift, Send: "\n", Does: "a newline (LF): a new line in Claude Code and Codex, Enter in a shell"},
}

// Keybinds is a table by name: "macos", or "" and "none" for no table.
func Keybinds(name string) ([]KeyBind, error) {
	switch name {
	case "", "none":
		return nil, nil
	case "macos":
		return MacOSKeybinds, nil
	}
	return nil, fmt.Errorf("no key bindings named %q (macos or none)", name)
}

// BoundKey is what a bound key sends, if the event is one of binds.
func BoundKey(binds []KeyBind, k KeyEvent) ([]byte, bool) {
	if k.Action == "release" || k.Composing {
		return nil, false
	}
	mods := k.Mods & (ModShift | ModCtrl | ModAlt | ModSuper)
	for _, b := range binds {
		if b.Code == k.Code && b.Mods == mods {
			return []byte(b.Send), true
		}
	}
	return nil, false
}
