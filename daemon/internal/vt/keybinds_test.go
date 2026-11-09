package vt

import "testing"

// TestMacOSKeybinds: each row of the "macos" table sends its bytes on a
// press and a repeat, with exactly its modifiers (Caps Lock aside), and
// never on a release, while composing, or with another modifier.
func TestMacOSKeybinds(t *testing.T) {
	binds, err := Keybinds("macos")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"ArrowLeft/8": "\x01", "ArrowRight/8": "\x05", "Backspace/8": "\x15",
		"ArrowLeft/4": "\x1bb", "ArrowRight/4": "\x1bf",
		"Delete/8": "\x0b", "Delete/4": "\x1bd", "Enter/1": "\n",
	}
	if len(binds) != len(want) {
		t.Fatalf("%d bindings, want %d", len(binds), len(want))
	}
	for _, b := range binds {
		key := b.Code + "/" + string(rune('0'+b.Mods))
		if want[key] != b.Send {
			t.Errorf("%s sends %q, want %q", key, b.Send, want[key])
		}
		for _, action := range []string{"", "press", "repeat"} {
			if got, ok := BoundKey(binds, KeyEvent{Code: b.Code, Mods: b.Mods | ModCapsLock, Action: action}); !ok || string(got) != b.Send {
				t.Errorf("%s %q: %q %v", key, action, got, ok)
			}
		}
		if _, ok := BoundKey(binds, KeyEvent{Code: b.Code, Mods: b.Mods, Action: "release"}); ok {
			t.Errorf("%s: bound on a release", key)
		}
		if _, ok := BoundKey(binds, KeyEvent{Code: b.Code, Mods: b.Mods, Composing: true}); ok {
			t.Errorf("%s: bound while composing", key)
		}
		if _, ok := BoundKey(binds, KeyEvent{Code: b.Code, Mods: b.Mods | ModCtrl}); ok {
			t.Errorf("%s: bound with Ctrl too", key)
		}
	}
	if none, _ := Keybinds("none"); len(none) != 0 {
		t.Error("none has bindings")
	}
	if _, err := Keybinds("emacs"); err == nil {
		t.Error("an unknown table is accepted")
	}
}
