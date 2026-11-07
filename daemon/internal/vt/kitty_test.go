package vt

import "testing"

// The Kitty keyboard query is answered only while KittyKeyboard says
// the keys can come that way; the other replies are not touched.
func TestKittyKeyboardQuery(t *testing.T) {
	kitty := false
	var replies []byte
	s, err := New(Options{Cols: 20, Rows: 4, Scrollback: 100,
		Reply:         func(p []byte) { replies = append(replies, p...) },
		KittyKeyboard: func() bool { return kitty },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.Write([]byte("\x1b[?u\x1b[6n"))
	if string(replies) != "\x1b[1;1R" {
		t.Fatalf("without kitty clients: replies %q, want only the cursor report", replies)
	}
	replies = nil
	kitty = true
	s.Write([]byte("\x1b[>1u\x1b[?u"))
	if string(replies) != "\x1b[?1u" {
		t.Fatalf("with kitty clients: replies %q, want ESC[?1u", replies)
	}
	// Without the option the screen answers as libghostty does.
	plain, plainReplies := newScreen(t, 20, 4)
	plain.Write([]byte("\x1b[?u"))
	if string(*plainReplies) != "\x1b[?0u" {
		t.Fatalf("without KittyKeyboard: reply %q, want ESC[?0u", *plainReplies)
	}
}

func TestIsKittyKeyboardReply(t *testing.T) {
	for in, want := range map[string]bool{
		"\x1b[?0u": true, "\x1b[?31u": true, "\x1b[?u": false, "\x1b[?1;2u": false,
		"\x1b[1;1R": false, "\x1b[?1u\x1b[c": false, "\x1b[?62;22c": false,
	} {
		if got := isKittyKeyboardReply([]byte(in)); got != want {
			t.Errorf("%q: %v, want %v", in, got, want)
		}
	}
}
