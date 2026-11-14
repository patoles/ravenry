package server

import (
	"bytes"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"ravenryd/internal/pane"
	"ravenryd/internal/vt"
)

// What "Typed here" shows of an input record (InputRecord.Shown): the
// lines a person or an agent entered, as a shell's line editing leaves
// them (2026-11-10: the panel showed "<Esc>", arrows and focus reports,
// nothing anyone could read). Backspace and Ctrl+H take back a character,
// Ctrl+U and Ctrl+C the line, Ctrl+W a word; Enter ends a line; a paste
// is its text. The cursor moves as a shell's emacs keys move it (Left,
// Right, Home, End, Ctrl+A, Ctrl+E, Ctrl+B, Ctrl+F, a word left or right
// with Alt or Ctrl), so a key typed after Left lands where the shell put
// it (2026-11-11: `echo one`, Left, Left, X, Enter ran `echo oXne` and
// showed `echo oneX`); Delete and Ctrl+D take the character under it,
// Ctrl+K the rest of the line, Alt+D and Alt+Backspace a word. Up, Down,
// Tab, Esc and other control keys show nothing. A record with no line
// left shows nothing (a menu answered with arrows and Enter, a lone Esc).
// Text keeps every key for the audit; only what is shown is edited.

// lineEditor replays typed bytes into lines. A gathered keys record keeps
// one while it grows, so a Backspace takes back what an earlier keystroke
// typed. It is only fed bytes already masked.
type lineEditor struct {
	lines []string
	cur   []rune
	pos   int // the cursor, in cur
	paste bool
}

// feed replays one input (one display frame, one item: an Esc at its end
// is the Esc key, not the start of a sequence).
func (e *lineEditor) feed(b []byte) {
	for len(b) > 0 {
		if n, _ := termReport(b); n > 0 {
			b = b[n:]
			continue
		}
		c := b[0]
		if c == 0x1b {
			b = e.escape(b)
			continue
		}
		if e.paste {
			switch {
			case c == '\r' || c == '\n':
				e.end()
			case c == '\t' || c >= 0x20 && c != 0x7f:
				r, n := utf8.DecodeRune(b)
				e.insert(r)
				b = b[n:]
				continue
			}
			b = b[1:]
			continue
		}
		switch {
		case c == '\r' || c == '\n':
			e.end()
		case c < 0x20 || c == 0x7f:
			e.control(c)
		default:
			r, n := utf8.DecodeRune(b)
			if r != utf8.RuneError || n > 1 {
				e.insert(r)
			}
			b = b[n:]
			continue
		}
		b = b[1:]
	}
}

// escape takes the sequence at b[0] (an Esc) and returns what follows it.
func (e *lineEditor) escape(b []byte) []byte {
	switch {
	case bytes.HasPrefix(b, []byte("\x1b[200~")):
		e.paste = true
		return b[6:]
	case bytes.HasPrefix(b, []byte("\x1b[201~")):
		e.paste = false
		return b[6:]
	case len(b) >= 2 && b[1] == '[':
		if n := csiLen(b); n > 0 {
			e.csi(b[:n])
			return b[n:]
		}
		return b[2:]
	case len(b) >= 3 && b[1] == 'O': // SS3: arrows, Home, End, F1 to F4
		e.move(b[2], 0)
		return b[3:]
	case len(b) >= 2 && b[1] == '\r': // Alt+Enter: a new line
		e.end()
		return b[2:]
	case len(b) >= 2 && b[1] >= 0x20 && b[1] <= 0x7f: // Alt and a key
		e.alt(rune(b[1]))
		return b[2:]
	}
	return b[1:] // the Esc key
}

// csiLen is the length of the CSI sequence at b, or 0.
func csiLen(b []byte) int {
	i := 2
	for i < len(b) && b[i] >= 0x20 && b[i] <= 0x3f {
		i++
	}
	if i >= len(b) || b[i] < 0x40 || b[i] > 0x7e {
		return 0
	}
	return i + 1
}

// csi takes a key the terminal sent as a CSI sequence: the cursor keys,
// Home, End and Delete (CSI 3~) by what they do at a prompt, a Kitty
// keyboard protocol key (CSI code;mods;text u) the same, the rest
// (function keys, Up, Down) as nothing shown.
func (e *lineEditor) csi(seq []byte) {
	final := seq[len(seq)-1]
	params := string(seq[2 : len(seq)-1])
	if final != 'u' {
		f := strings.Split(params, ";")
		mods := 0
		if len(f) > 1 {
			m, _ := splitColon(f[1])
			mods = max(m-1, 0)
		}
		switch {
		case final == '~' && len(f) > 0:
			switch n, _ := splitColon(f[0]); n {
			case 3:
				e.del()
			case 1, 7:
				e.pos = 0
			case 4, 8:
				e.pos = len(e.cur)
			}
		case final >= 'A' && final <= 'Z' && (params == "" || f[0] == "1"):
			e.move(final, mods)
		}
		return
	}
	if len(seq) < 4 || seq[2] < '0' || seq[2] > '9' {
		return
	}
	f := strings.Split(string(seq[2:len(seq)-1]), ";")
	code, alt := splitColon(f[0])
	mods, event := 1, 1
	if len(f) > 1 {
		m, ev := splitColon(f[1])
		mods = max(m, 1)
		event = max(ev, 1)
	}
	if event == 3 { // a release
		return
	}
	mods--
	ctrl, altKey, other := mods&4 != 0, mods&2 != 0, mods&(8|16|32) != 0
	switch {
	case code == 13:
		e.end()
		return
	case (code == 127 || code == 8) && altKey:
		e.word()
		return
	case code == 127 || code == 8:
		e.back()
		return
	case ctrl:
		if code >= 'a' && code <= 'z' {
			e.control(byte(code - 'a' + 1))
		}
		return
	case altKey && !other:
		e.alt(rune(code))
		return
	case other || code == 27 || code == 9:
		return
	}
	if len(f) > 2 && f[2] != "" {
		for _, cp := range strings.Split(f[2], ":") {
			if r, err := strconv.Atoi(cp); err == nil && r >= 0x20 {
				e.insert(rune(r))
			}
		}
		return
	}
	if mods&1 != 0 && alt > 0 {
		code = alt
	}
	if code >= 0x20 && code < 0xe000 { // above: the Kitty keyboard protocol's functional keys
		e.insert(rune(code))
	}
}

// splitColon reads "a:b" as two numbers (0 when absent).
func splitColon(s string) (int, int) {
	a, b, _ := strings.Cut(s, ":")
	x, _ := strconv.Atoi(a)
	y, _ := strconv.Atoi(strings.SplitN(b, ":", 2)[0])
	return x, y
}

// key replays a key item of pane.send (vt.ParseKey's names: "Left",
// "Ctrl+A", "Alt+B", "C-w").
func (e *lineEditor) key(name string) {
	k, err := vt.ParseKey(name)
	if err != nil {
		return
	}
	switch {
	case k.Name == "enter":
		e.end()
	case k.Name == "backspace" && k.Alt:
		e.word()
	case k.Name == "backspace":
		e.back()
	case k.Name == "delete":
		e.del()
	case k.Name == "home":
		e.pos = 0
	case k.Name == "end":
		e.pos = len(e.cur)
	case k.Name == "left" || k.Name == "right":
		mods := 0
		if k.Ctrl {
			mods |= 4
		}
		if k.Alt {
			mods |= 2
		}
		e.move(map[string]byte{"left": 'D', "right": 'C'}[k.Name], mods)
	case k.Name == "space":
		e.insert(' ')
	case k.Name != "":
		// Tab, Escape, Up, Down, function keys: nothing shown
	case k.Ctrl && k.Char >= 'a' && k.Char <= 'z':
		e.control(byte(k.Char - 'a' + 1))
	case k.Alt:
		e.alt(k.Char)
	case k.Char >= 0x20:
		e.insert(k.Char)
	}
}

// control replays a control character: the line editing keys of a
// shell's emacs mode; the others (Tab, Ctrl+L...) show nothing.
func (e *lineEditor) control(c byte) {
	switch c {
	case 0x7f, 0x08: // Backspace, Ctrl+H
		e.back()
	case 0x15, 0x03: // Ctrl+U, Ctrl+C: the line (zsh's kill-whole-line)
		e.cur, e.pos = nil, 0
	case 0x17: // Ctrl+W
		e.word()
	case 0x01: // Ctrl+A
		e.pos = 0
	case 0x05: // Ctrl+E
		e.pos = len(e.cur)
	case 0x02: // Ctrl+B
		e.pos = max(e.pos-1, 0)
	case 0x06: // Ctrl+F
		e.pos = min(e.pos+1, len(e.cur))
	case 0x04: // Ctrl+D: the character under the cursor
		e.del()
	case 0x0b: // Ctrl+K: the rest of the line
		e.cur = e.cur[:e.pos]
	}
}

// alt replays Alt and a key (Esc and the key): a word left or right, a
// word forward taken, Alt+Backspace a word back taken (either case, as
// zsh and readline bind them).
func (e *lineEditor) alt(r rune) {
	switch unicode.ToLower(r) {
	case 'b':
		e.pos = e.wordLeft()
	case 'f':
		e.pos = e.wordRight()
	case 'd':
		e.cur = append(e.cur[:e.pos], e.cur[e.wordRight():]...)
	case 0x7f, 0x08:
		e.word()
	}
}

// move replays a cursor key by its final byte (CSI or SS3): D left, C
// right, H Home, F End; with Ctrl or Alt (mods 4 or 2) Left and Right go
// a word. A, B (Up, Down: history) and the rest show nothing.
func (e *lineEditor) move(final byte, mods int) {
	word := mods&(2|4) != 0
	switch final {
	case 'D':
		if word {
			e.pos = e.wordLeft()
		} else {
			e.pos = max(e.pos-1, 0)
		}
	case 'C':
		if word {
			e.pos = e.wordRight()
		} else {
			e.pos = min(e.pos+1, len(e.cur))
		}
	case 'H':
		e.pos = 0
	case 'F':
		e.pos = len(e.cur)
	}
}

// wordLeft is where a word left lands: past the spaces before the cursor,
// then to the start of the word.
func (e *lineEditor) wordLeft() int {
	i := e.pos
	for i > 0 && !wordRune(e.cur[i-1]) {
		i--
	}
	for i > 0 && wordRune(e.cur[i-1]) {
		i--
	}
	return i
}

// wordRight is where a word right lands: the end of the next word.
func (e *lineEditor) wordRight() int {
	i := e.pos
	for i < len(e.cur) && !wordRune(e.cur[i]) {
		i++
	}
	for i < len(e.cur) && wordRune(e.cur[i]) {
		i++
	}
	return i
}

// wordRune: a letter or digit, what Alt+B and Alt+F treat as a word.
func wordRune(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }

// insert types r at the cursor.
func (e *lineEditor) insert(r rune) {
	e.cur = append(e.cur, 0)
	copy(e.cur[e.pos+1:], e.cur[e.pos:])
	e.cur[e.pos] = r
	e.pos++
}

// del takes the character under the cursor.
func (e *lineEditor) del() {
	if e.pos < len(e.cur) {
		e.cur = append(e.cur[:e.pos], e.cur[e.pos+1:]...)
	}
}

// back takes the character before the cursor.
func (e *lineEditor) back() {
	if e.pos > 0 {
		e.cur = append(e.cur[:e.pos-1], e.cur[e.pos:]...)
		e.pos--
	}
}

// word takes back a word as a shell's Ctrl+W does: the spaces before the
// cursor, then the word.
func (e *lineEditor) word() {
	i := e.pos
	for i > 0 && unicode.IsSpace(e.cur[i-1]) {
		i--
	}
	for i > 0 && !unicode.IsSpace(e.cur[i-1]) {
		i--
	}
	e.cur = append(e.cur[:i], e.cur[e.pos:]...)
	e.pos = i
}

// end ends the line: kept when it has something to show.
func (e *lineEditor) end() {
	if l := strings.TrimRightFunc(string(e.cur), unicode.IsSpace); strings.TrimSpace(l) != "" {
		e.lines = append(e.lines, l)
	}
	e.cur, e.pos = nil, 0
}

// String is what is shown: the lines entered, then the one being typed.
func (e *lineEditor) String() string {
	out := e.lines
	if l := strings.TrimRightFunc(string(e.cur), unicode.IsSpace); strings.TrimSpace(l) != "" {
		out = append(out[:len(out):len(out)], l)
	}
	return clip(strings.Join(out, "\n"), maxInputText)
}

// feedBytes feeds b, masked as the pane masks its secrets, unless nothing
// of it may be shown (typed at a password prompt).
func feedBytes(p *pane.Pane, b []byte) func(*lineEditor) {
	if p.PasswordPrompt() {
		return nil
	}
	m, _ := p.MaskSecrets(b)
	return func(e *lineEditor) { e.feed(m) }
}

// feedItems feeds pane.send's items, masked as feedBytes does.
func feedItems(p *pane.Pane, items []pane.InputItem) func(*lineEditor) {
	if p.PasswordPrompt() {
		return nil
	}
	type item struct {
		key  string
		text []byte
	}
	its := make([]item, len(items))
	for i, it := range items {
		its[i].key = it.Key
		if it.Key == "" {
			its[i].text, _ = p.MaskSecrets([]byte(it.Text))
		}
	}
	return func(e *lineEditor) {
		for _, it := range its {
			if it.key != "" {
				e.key(it.key)
			} else {
				e.feed(it.text)
			}
		}
	}
}
