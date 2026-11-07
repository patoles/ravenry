package pane

import (
	"bytes"

	"golang.org/x/sys/unix"
)

// What the input log (the server's pane.inputs) needs from a pane: to
// know when the terminal does not echo (a password prompt), and to mask
// the pane's secrets in what was typed.

// PasswordPrompt reports whether the program reads a line without echo
// (ECHO off, ICANON on): a password prompt, whose typing is never logged.
// A full-screen program that turns echo off and reads keys one by one
// (ICANON off) is not one.
func (p *Pane) PasswordPrompt() bool {
	p.mu.Lock()
	closed := p.closed
	p.mu.Unlock()
	if closed {
		return false
	}
	t, err := unix.IoctlGetTermios(int(p.pty.Fd()), ioctlGetTermios)
	if err != nil {
		return false
	}
	return t.Lflag&unix.ECHO == 0 && t.Lflag&unix.ICANON != 0
}

// MaskSecrets masks the pane's secrets in b, as its output masks them,
// and reports whether it masked any.
func (p *Pane) MaskSecrets(b []byte) ([]byte, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.redact == nil {
		return b, false
	}
	masked := false
	out := b
	for _, s := range p.redact.secrets {
		if bytes.Contains(out, s) {
			if !masked {
				out = bytes.Clone(out)
			}
			masked = true
			out = bytes.ReplaceAll(out, s, bytes.Repeat([]byte{'*'}, len(s)))
		}
	}
	return out, masked
}
