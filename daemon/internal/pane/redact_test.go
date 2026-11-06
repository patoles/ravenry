package pane

import (
	"strings"
	"testing"
)

func TestRedactorMasksAcrossChunks(t *testing.T) {
	secret := "hunter2-otp"
	for _, cut := range []int{1, 3, 5, 10} {
		r := newRedactor([][]byte{[]byte(secret)})
		in := "code: " + secret + "\r\nok"
		i := strings.Index(in, secret) + cut
		out := string(r.filter([]byte(in[:i]))) + string(r.filter([]byte(in[i:]))) + string(r.flush())
		if strings.Contains(out, "hunter") || out != "code: ***********\r\nok" {
			t.Fatalf("cut %d: %q", cut, out)
		}
	}
	// A start of the secret that never goes on: masked from 3 bytes, else let through.
	r := newRedactor([][]byte{[]byte(secret)})
	if out := string(r.filter([]byte("x hun"))) + string(r.flush()); out != "x ***" {
		t.Fatalf("held start %q", out)
	}
	if out := string(r.filter([]byte("x h"))) + string(r.flush()); out != "x h" {
		t.Fatalf("one byte %q", out)
	}
	if out := string(r.filter([]byte("nothing here"))); out != "nothing here" {
		t.Fatalf("plain %q", out)
	}
}

func TestLocalDir(t *testing.T) {
	for in, want := range map[string]string{
		"file:///tmp/a%20b":              "/tmp/a b",
		"file://localhost/x":             "/x",
		"file://" + hostname + "/y":      "/y",
		"kitty-shell-cwd:///z":           "/z",
		"file://elsewhere.example.org/w": "",
		"http:///v":                      "",
		"file://":                        "",
	} {
		got, ok := localDir(in)
		if (want == "") == ok || got != want {
			t.Errorf("%q: %q %v", in, got, ok)
		}
	}
}
