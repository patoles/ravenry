package vt

import (
	"fmt"
	"strings"
	"unicode/utf8"

	gt "go.mitchellh.com/libghostty"
)

type keyName struct {
	ghostty string
	cp      rune
}

// keyNames maps the protocol's key names (lower case) to libghostty's.
var keyNames = map[string]keyName{
	"enter":     {"enter", 0},
	"tab":       {"tab", 0},
	"escape":    {"escape", 0},
	"backspace": {"backspace", 0},
	"delete":    {"delete", 0},
	"insert":    {"insert", 0},
	"home":      {"home", 0},
	"end":       {"end", 0},
	"pageup":    {"page_up", 0},
	"pagedown":  {"page_down", 0},
	"up":        {"arrow_up", 0},
	"down":      {"arrow_down", 0},
	"left":      {"arrow_left", 0},
	"right":     {"arrow_right", 0},
	"space":     {"space", ' '},
	"f1":        {"f1", 0},
	"f2":        {"f2", 0},
	"f3":        {"f3", 0},
	"f4":        {"f4", 0},
	"f5":        {"f5", 0},
	"f6":        {"f6", 0},
	"f7":        {"f7", 0},
	"f8":        {"f8", 0},
	"f9":        {"f9", 0},
	"f10":       {"f10", 0},
	"f11":       {"f11", 0},
	"f12":       {"f12", 0},
}

var keyAliases = map[string]string{
	"return": "enter",
	"esc":    "escape",
	"del":    "delete",
	"bs":     "backspace",
	"pgup":   "pageup",
	"pgdn":   "pagedown",
}

// KeyNames lists the named keys, in the protocol's spelling.
var KeyNames = []string{
	"Enter", "Tab", "Escape", "Backspace", "Delete", "Insert", "Home", "End",
	"PageUp", "PageDown", "Up", "Down", "Left", "Right", "Space",
	"F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
}

// ParseKey reads a key in the protocol's notation: modifiers joined with
// "+" before the key ("Ctrl+C", "Shift+Tab", "Alt+Enter"), or the short
// forms "C-c", "M-x", "S-Tab". The key is a name from KeyNames (any case)
// or one character. Ctrl+<letter> ignores the letter's case.
func ParseKey(s string) (Key, error) {
	var k Key
	rest := s
	for {
		i := strings.IndexAny(rest, "+-")
		if i <= 0 || i == len(rest)-1 {
			break
		}
		mod := strings.ToLower(rest[:i])
		sep := rest[i]
		ok := true
		switch {
		case sep == '+' && (mod == "ctrl" || mod == "control"):
			k.Ctrl = true
		case sep == '+' && (mod == "alt" || mod == "option" || mod == "meta"):
			k.Alt = true
		case sep == '+' && mod == "shift":
			k.Shift = true
		case sep == '+' && (mod == "super" || mod == "cmd"):
			k.Super = true
		case sep == '-' && mod == "c":
			k.Ctrl = true
		case sep == '-' && mod == "m":
			k.Alt = true
		case sep == '-' && mod == "s":
			k.Shift = true
		default:
			ok = false
		}
		if !ok {
			break
		}
		rest = rest[i+1:]
	}
	if rest == "" {
		return Key{}, fmt.Errorf("key %q: no key after the modifiers", s)
	}
	lower := strings.ToLower(rest)
	if a, ok := keyAliases[lower]; ok {
		lower = a
	}
	if _, ok := keyNames[lower]; ok {
		k.Name = lower
		return k, nil
	}
	r, size := utf8.DecodeRuneInString(rest)
	if r == utf8.RuneError || size != len(rest) {
		return Key{}, fmt.Errorf("key %q: not a key name or a single character", s)
	}
	if k.Ctrl && r >= 'A' && r <= 'Z' {
		r += 'a' - 'A'
	}
	k.Char = r
	return k, nil
}

// String writes a key back in the protocol's long notation.
func (k Key) String() string {
	var b strings.Builder
	if k.Ctrl {
		b.WriteString("Ctrl+")
	}
	if k.Alt {
		b.WriteString("Alt+")
	}
	if k.Shift {
		b.WriteString("Shift+")
	}
	if k.Super {
		b.WriteString("Super+")
	}
	if k.Name != "" {
		for _, n := range KeyNames {
			if strings.ToLower(n) == k.Name {
				b.WriteString(n)
				return b.String()
			}
		}
		b.WriteString(k.Name)
		return b.String()
	}
	b.WriteRune(k.Char)
	return b.String()
}

var shifted = map[rune]rune{
	'~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6',
	'&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[',
	'}': ']', '|': '\\', ':': ';', '"': '\'', '<': ',', '>': '.', '?': '/',
}

var punct = map[rune]string{
	'`': "backquote", '\\': "backslash", '[': "bracket_left", ']': "bracket_right",
	',': "comma", '=': "equal", '-': "minus", '.': "period", '\'': "quote",
	';': "semicolon", '/': "slash", ' ': "space",
}

// unshift returns the character on the same key without Shift, on a US
// layout.
func unshift(r rune) rune {
	if r >= 'A' && r <= 'Z' {
		return r + ('a' - 'A')
	}
	if u, ok := shifted[r]; ok {
		return u
	}
	return r
}

// charKey returns the physical key for a character on a US layout, and
// whether the character needs Shift.
func charKey(r rune) (gt.Key, bool) {
	sh := false
	if (r >= 'A' && r <= 'Z') || shifted[r] != 0 {
		sh = true
		r = unshift(r)
	}
	var name string
	switch {
	case r >= 'a' && r <= 'z':
		name = "key_" + string(r)
	case r >= '0' && r <= '9':
		name = "digit_" + string(r)
	default:
		name = punct[r]
	}
	if name == "" {
		return gt.KeyUnidentified, false
	}
	k, err := gt.ParseKey(name)
	if err != nil {
		return gt.KeyUnidentified, false
	}
	return k, sh
}
