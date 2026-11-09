package vt

import (
	"fmt"
	"strings"
	"unicode"

	gt "go.mitchellh.com/libghostty"
)

// Input events from a client that draws the screen itself (the render
// stream, RENDERING.md): physical keys and mouse events, encoded here
// for the program's current modes with libghostty's encoders, so every
// client shares one encoding.

// Modifier bits of a KeyEvent and a MouseEvent.
const (
	ModShift uint8 = 1 << iota
	ModCtrl
	ModAlt
	ModSuper
	ModCapsLock
	ModNumLock
)

// KeyEvent is a key as the keyboard reports it.
type KeyEvent struct {
	// Code is the physical key, as a W3C KeyboardEvent.code value
	// ("KeyA", "Digit1", "ArrowUp", "Enter", "F5", "NumpadEnter").
	Code string
	// Action is "press" (the default), "repeat" or "release".
	Action string
	// Mods are the modifiers held (Mod* bits); Consumed those the
	// keyboard layout used to produce Text (Shift for "A", Option for
	// "å" on a Mac).
	Mods, Consumed uint8
	// Text is what the key typed, with the layout and modifiers applied,
	// or empty (a control key, or Ctrl held).
	Text string
	// Unshifted is the character the key types with no modifier, or 0.
	Unshifted rune
	// Composing: an input method is composing; the key is part of it.
	Composing bool
	// OptionAsAlt: the Mac's Option key acts as Alt (Meta) rather than
	// typing characters: "left", "right", "both" or empty.
	OptionAsAlt string
}

// MouseEvent is a mouse button, wheel step or motion over the terminal.
type MouseEvent struct {
	// Action is "press", "release" or "motion".
	Action string
	// Button is "left", "right", "middle", "wheel_up", "wheel_down",
	// "wheel_left", "wheel_right", or empty for motion with no button.
	Button string
	Mods   uint8
	// X and Y are the position from the terminal's top left corner, in
	// the client's units; CellWidth and CellHeight are a cell's size in
	// the same units.
	X, Y                  float64
	CellWidth, CellHeight float64
	// Held: a button is down during a motion.
	Held bool
}

func gtMods(m uint8) gt.Mods {
	var g gt.Mods
	for _, b := range []struct {
		bit uint8
		mod gt.Mods
	}{{ModShift, gt.ModShift}, {ModCtrl, gt.ModCtrl}, {ModAlt, gt.ModAlt}, {ModSuper, gt.ModSuper}, {ModCapsLock, gt.ModCapsLock}, {ModNumLock, gt.ModNumLock}} {
		if m&b.bit != 0 {
			g |= b.mod
		}
	}
	return g
}

// codeKey turns a W3C code ("ArrowUp", "KeyA", "F12") into libghostty's
// key ("arrow_up", "key_a", "f12").
func codeKey(code string) (gt.Key, error) {
	if code == "" {
		return gt.KeyUnidentified, nil
	}
	var b strings.Builder
	fkey := len(code) > 1 && code[0] == 'F' && strings.Trim(code[1:], "0123456789") == ""
	for i, r := range code {
		switch {
		case fkey:
			b.WriteRune(unicode.ToLower(r))
			continue
		case unicode.IsUpper(r) && i > 0:
			b.WriteByte('_')
		case unicode.IsDigit(r) && i > 0 && !unicode.IsDigit(rune(code[i-1])):
			b.WriteByte('_')
		}
		b.WriteRune(unicode.ToLower(r))
	}
	name := b.String()
	switch name {
	case "control_left", "control_right", "alt_left", "alt_right", "meta_left", "meta_right":
	case "os_left":
		name = "meta_left"
	case "os_right":
		name = "meta_right"
	}
	k, err := gt.ParseKey(name)
	if err != nil {
		return gt.KeyUnidentified, fmt.Errorf("vt: unknown key code %q", code)
	}
	return k, nil
}

// EncodeKeyEvent encodes a key for the program's modes (application
// cursor keys, the Kitty keyboard protocol, and the rest the terminal
// tracks). A release encodes to nothing unless the program asked for
// releases.
func (s *ghostty) EncodeKeyEvent(k KeyEvent) ([]byte, error) {
	key, err := codeKey(k.Code)
	if err != nil {
		return nil, err
	}
	if err := s.keys.SetFromTerminal(s.t); err != nil {
		return nil, fmt.Errorf("vt: key encoder: %w", err)
	}
	opt := gt.OptionAsAltFalse
	switch k.OptionAsAlt {
	case "both", "true":
		opt = gt.OptionAsAltTrue
	case "left":
		opt = gt.OptionAsAltLeft
	case "right":
		opt = gt.OptionAsAltRight
	}
	s.keys.SetOptionAsAlt(opt)
	ev := s.ev
	switch k.Action {
	case "release":
		ev.SetAction(gt.KeyActionRelease)
	case "repeat":
		ev.SetAction(gt.KeyActionRepeat)
	default:
		ev.SetAction(gt.KeyActionPress)
	}
	ev.SetKey(key)
	ev.SetMods(gtMods(k.Mods))
	ev.SetConsumedMods(gtMods(k.Consumed))
	ev.SetComposing(k.Composing)
	text := k.Text
	// Control characters are the encoder's to produce, not the text's.
	if len(text) == 1 && (text[0] < 0x20 || text[0] == 0x7f) {
		text = ""
	}
	ev.SetUTF8(text)
	ev.SetUnshiftedCodepoint(k.Unshifted)
	b, err := s.keys.Encode(ev)
	if err != nil {
		return nil, fmt.Errorf("vt: encode key: %w", err)
	}
	return b, nil
}

// EncodeText is text an input method committed, or a key the encoder has
// no physical key for: sent as typed.
func (s *ghostty) EncodeText(text string) []byte { return []byte(text) }

// EncodeMouse encodes a mouse event for the program's mouse modes;
// nothing when the program does not report the mouse.
func (s *ghostty) EncodeMouse(m MouseEvent) ([]byte, error) {
	if s.mouse == nil {
		enc, err := gt.NewMouseEncoder()
		if err != nil {
			return nil, fmt.Errorf("vt: mouse encoder: %w", err)
		}
		ev, err := gt.NewMouseEvent()
		if err != nil {
			enc.Close()
			return nil, fmt.Errorf("vt: mouse event: %w", err)
		}
		s.mouse, s.mev = enc, ev
	}
	if err := s.mouse.SetFromTerminal(s.t); err != nil {
		return nil, fmt.Errorf("vt: mouse encoder: %w", err)
	}
	// Positions go to the encoder in pixels of a virtual grid: the
	// client's cell size when it gave one (pixel reports, mode 1016).
	cw, ch := m.CellWidth, m.CellHeight
	if cw <= 0 || ch <= 0 {
		cw, ch = 1, 1
	}
	scale := 1.0
	if cw < 8 {
		scale = 8 / cw
	}
	cwp, chp := uint32(cw*scale+0.5), uint32(ch*scale+0.5)
	if err := s.mouse.SetSize(gt.MouseEncoderSize{
		ScreenWidth: cwp * uint32(s.cols), ScreenHeight: chp * uint32(s.rows),
		CellWidth: cwp, CellHeight: chp,
	}); err != nil {
		return nil, fmt.Errorf("vt: mouse size: %w", err)
	}
	s.mouse.SetAnyButtonPressed(m.Held)
	ev := s.mev
	switch m.Action {
	case "press":
		ev.SetAction(gt.MouseActionPress)
	case "release":
		ev.SetAction(gt.MouseActionRelease)
	case "motion":
		ev.SetAction(gt.MouseActionMotion)
	default:
		return nil, fmt.Errorf("vt: unknown mouse action %q", m.Action)
	}
	switch m.Button {
	case "":
		ev.ClearButton()
	case "left":
		ev.SetButton(gt.MouseButtonLeft)
	case "right":
		ev.SetButton(gt.MouseButtonRight)
	case "middle":
		ev.SetButton(gt.MouseButtonMiddle)
	case "wheel_up":
		ev.SetButton(gt.MouseButtonFour)
	case "wheel_down":
		ev.SetButton(gt.MouseButtonFive)
	case "wheel_left":
		ev.SetButton(gt.MouseButtonSix)
	case "wheel_right":
		ev.SetButton(gt.MouseButtonSeven)
	default:
		return nil, fmt.Errorf("vt: unknown mouse button %q", m.Button)
	}
	ev.SetMods(gtMods(m.Mods))
	ev.SetPosition(gt.MousePosition{X: float32(m.X * scale), Y: float32(m.Y * scale)})
	b, err := s.mouse.Encode(ev)
	if err != nil {
		return nil, fmt.Errorf("vt: encode mouse: %w", err)
	}
	return b, nil
}

// EncodeFocus is the report of the terminal gaining or losing focus, when
// the program asked for them (mode 1004); otherwise nothing.
func (s *ghostty) EncodeFocus(focused bool) ([]byte, error) {
	if on, err := s.t.Mode(modeFocus); err != nil || !on {
		return nil, err
	}
	ev := gt.FocusLost
	if focused {
		ev = gt.FocusGained
	}
	return gt.FocusEncode(ev)
}
