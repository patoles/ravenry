package attach

import (
	"testing"
	"time"
)

func TestFilterDropsAnswersKeepsKeys(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"text", "ls -la\r", "ls -la\r"},
		{"DA1 answer", "a\x1b[?62;22cb", "ab"},
		{"DA2 answer", "\x1b[>1;10;0c", ""},
		{"DECRPM", "\x1b[?2004;1$y", ""},
		{"DSR status", "\x1b[0n", ""},
		{"DA3", "\x1bP!|00000000\x1b\\", ""},
		{"kitty keyboard flags", "\x1b[?1u", ""},
		{"palette answer", "\x1b]4;1;rgb:cccc/6666/6666\x1b\\x", "x"},
		{"XTVERSION", "\x1bP>|ghostty 1.4\x1b\\", ""},
		{"DECRQSS", "\x1bP1$r0m\x1b\\", ""},
		{"kitty graphics answer", "\x1b_Gi=1;OK\x1b\\", ""},
		// The window's own: the daemon does not answer these.
		{"background colour", "\x1b]11;rgb:1e1e/1e1e/1e1e\x07", "\x1b]11;rgb:1e1e/1e1e/1e1e\x07"},
		{"foreground colour, ST", "\x1b]10;rgb:ffff/ffff/ffff\x1b\\", "\x1b]10;rgb:ffff/ffff/ffff\x1b\\"},
		{"colour scheme", "\x1b[?997;1n", "\x1b[?997;1n"},
		{"window size report", "\x1b[8;40;120t", "\x1b[8;40;120t"},
		{"XTGETTCAP", "\x1bP1+r544e=787465726d\x1b\\", "\x1bP1+r544e=787465726d\x1b\\"},
		{"arrow keys", "\x1b[A\x1bOB", "\x1b[A\x1bOB"},
		{"kitty key event", "\x1b[97;5u", "\x1b[97;5u"},
		{"alt+x", "\x1bx", "\x1bx"},
		{"lone escape", "\x1b", "\x1b"},
		{"alt+[ at the end", "\x1b[", "\x1b["},
		{"alt+] then a key", "\x1b]\x1b[A", "\x1b]\x1b[A"},
		{"sgr mouse", "\x1b[<0;10;5M\x1b[<0;10;5m", "\x1b[<0;10;5M\x1b[<0;10;5m"},
		{"focus", "\x1b[I\x1b[O", "\x1b[I\x1b[O"},
		{"ctrl+f3 with no query", "\x1b[1;5R", "\x1b[1;5R"},
		{"delete", "\x1b[3~", "\x1b[3~"},
	}
	for _, c := range cases {
		var f Filter
		if got := string(f.Write([]byte(c.in))); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestFilterPasteIsUntouched(t *testing.T) {
	var f Filter
	in := "\x1b[200~echo \x1b[?62;22c\x1b]4;1;x\x07"
	if got := string(f.Write([]byte(in))); got != in {
		t.Fatalf("first half: %q", got)
	}
	// The paste goes on in the next read, then ends; after it, answers drop.
	in2 := "more\x1b[201~\x1b[?62;22c"
	if got := string(f.Write([]byte(in2))); got != "more\x1b[201~" {
		t.Fatalf("second half: %q", got)
	}
}

func TestFilterCursorReportOnlyWhenAsked(t *testing.T) {
	q := &Queries{}
	f := Filter{Queries: q}
	q.Output([]byte("prompt\x1b[6n"))
	if got := string(f.Write([]byte("\x1b[1;5R"))); got != "" {
		t.Fatalf("an answer to a query went through: %q", got)
	}
	// The one query is answered: the next one is a key.
	if got := string(f.Write([]byte("\x1b[1;5R"))); got != "\x1b[1;5R" {
		t.Fatalf("Ctrl+F3 was dropped: %q", got)
	}
	q.Output([]byte("\x1b[6n"))
	q.mu.Lock()
	q.last = time.Now().Add(-3 * time.Second)
	q.mu.Unlock()
	if got := string(f.Write([]byte("\x1b[1;5R"))); got != "\x1b[1;5R" {
		t.Fatalf("a stale query still swallowed a key: %q", got)
	}
}
