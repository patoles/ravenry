package server

import (
	"regexp"
	"strings"
	"testing"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
)

// A program that asks whether the terminal has the Kitty keyboard
// protocol (CSI ? u) hears yes only while every client streaming the pane
// says it sends keys that way; with none streaming, or one that does not,
// it hears nothing, as from xterm.js, and only the device attributes
// answer (CSI c) that programs send after the query comes back.
func TestKittyKeyboardFollowsTheClients(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	// Each line read asks both questions, then prints what came back,
	// ESC shown as E, and "end" with the line.
	p := newPane(t, c, map[string]any{"cols": 80, "rows": 10, "command": []string{"/bin/sh", "-c",
		`while read x; do stty -echo -icanon min 0 time 5; printf '\033[?u\033[c'; cat | tr '\033' E; echo " end$x"; stty sane; done`}})
	kitty := regexp.MustCompile(`E\[\?\d+u`)
	ask := func(n string) string {
		t.Helper()
		s := call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"text": n, "mode": "raw"}, {"key": "Enter"}}})
		w := waitFor(t, c, p.ID, `end`+n, s.Mark)
		t.Logf("round %s: %q", n, w.Output)
		if !strings.Contains(w.Output, "E[?") {
			t.Fatalf("round %s: no device attributes answer in %q", n, w.Output)
		}
		return w.Output
	}

	if out := ask("1"); kitty.MatchString(out) {
		t.Fatalf("no client streams the pane, yet the program heard of the Kitty protocol: %q", out)
	}

	st, err := c.Subscribe(ctx(t), p.ID, client.SubscribeOptions{KittyKeyboard: true})
	if err != nil {
		t.Fatal(err)
	}
	if out := ask("2"); !kitty.MatchString(out) {
		t.Fatalf("every client sends Kitty keys, yet the program did not hear so: %q", out)
	}

	plain, err := c.Subscribe(ctx(t), p.ID, client.SubscribeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if out := ask("3"); kitty.MatchString(out) {
		t.Fatalf("a client that cannot send Kitty keys streams the pane, yet the program heard of the protocol: %q", out)
	}

	if err := plain.Close(ctx(t)); err != nil {
		t.Fatal(err)
	}
	if out := ask("4"); !kitty.MatchString(out) {
		t.Fatalf("the plain client left, yet the program did not hear of the protocol: %q", out)
	}
	st.Close(ctx(t))
}
