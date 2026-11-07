package main

import (
	"bytes"
	"context"
	"encoding/json"
	"image/gif"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
)

// The Phase 2 commands from the command line, as an agent runs them.

func personConn(t *testing.T, e *env) *client.Client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	sock := filepath.Join(e.dir, "run", "ravenryd-0.2.0.sock")
	for {
		c, err := client.Dial(ctx, sock, client.Options{Name: "test-person"})
		if err == nil {
			t.Cleanup(func() { c.Close() })
			return c
		}
		if ctx.Err() != nil {
			t.Fatal(err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestPicturesAndRecordingsFromTheCommandLine(t *testing.T) {
	e := newEnv(t)
	e.serve("0.2.0")
	id := strings.TrimSpace(e.ok("0.2.0", "new", "--size", "40x8", "--", "/bin/sh", "-c", `printf '\033[1;33mhello\033[0m\n'; sleep 0.2; printf 'world\n'; exec sleep 60`))
	e.ok("0.2.0", "wait", id, "--text", "world")
	shot := filepath.Join(e.dir, "s.png")
	if out, errs, code := runCmd(t, e.ravenry("0.2.0", "shot", id, "-o", shot)); code != 0 || !strings.Contains(out, "40x8 cells") {
		t.Fatalf("shot: %d %q %q", code, out, errs)
	}
	f, _ := os.Open(shot)
	if _, err := png.Decode(f); err != nil {
		t.Fatalf("shot is not a PNG: %v", err)
	}
	f.Close()
	strip := filepath.Join(e.dir, "s.gif")
	if out, errs, code := runCmd(t, e.ravenry("0.2.0", "frames", id, "-o", strip, "--last", "5s")); code != 0 || !strings.Contains(out, "frames") {
		t.Fatalf("frames: %d %q %q", code, out, errs)
	}
	f, _ = os.Open(strip)
	if _, err := gif.DecodeAll(f); err != nil {
		t.Fatalf("not a GIF: %v", err)
	}
	f.Close()
	fix := filepath.Join(e.dir, "f.json")
	if _, errs, code := runCmd(t, e.ravenry("0.2.0", "fixture", id, "-o", fix)); code != 0 {
		t.Fatalf("fixture: %d %q", code, errs)
	}
	var fx proto.Fixture
	b, _ := os.ReadFile(fix)
	if err := json.Unmarshal(b, &fx); err != nil || fx.Format != "ravenry.fixture" || fx.Cols != 40 || len(fx.Events) < 2 {
		t.Fatalf("fixture file: %v %+v", err, fx)
	}
	end := filepath.Join(e.dir, "end.png")
	out, errs, code := runCmd(t, e.ravenry("0.2.0", "replay", fix, "--speed", "max", "-o", end))
	if code != 0 || !strings.HasPrefix(out, "hello\nworld\n") {
		t.Fatalf("headless replay: %d %q %q", code, out, errs)
	}
	if _, err := os.Stat(end); err != nil {
		t.Fatal("no picture of the replay")
	}
	rp, errs, code := runCmd(t, e.ravenry("0.2.0", "replay", id, "--speed", "4"))
	if code != 0 || !strings.HasPrefix(rp, "p") {
		t.Fatalf("replay into a pane: %d %q %q", code, rp, errs)
	}
	e.ok("0.2.0", "wait", strings.TrimSpace(rp), "--text", "world")
	if out := e.ok("0.2.0", "override", id, "--phone", "--slow", "5000"); !strings.Contains(out, "40x30") || !strings.Contains(out, "5000 bytes/s") {
		t.Fatalf("override: %q", out)
	}
	if out := e.ok("0.2.0", "override", id, "--clear"); !strings.Contains(out, "40x8  overrides: none") {
		t.Fatalf("override --clear: %q", out)
	}
	e.ok("0.2.0", "send", id, "--raw", "x")
	if out := e.ok("0.2.0", "inputs", id); !strings.Contains(out, "program ravenry") || !strings.Contains(out, "  x\n") {
		t.Fatalf("inputs: %q", out)
	}
	if out := e.ok("0.2.0", "files", id, "--no-git"); out != "" {
		t.Fatalf("files: %q", out)
	}
}

func TestDriveAndPickFromTheCommandLine(t *testing.T) {
	e := newEnv(t)
	e.serve("0.2.0")
	c := personConn(t, e)
	target := strings.TrimSpace(e.ok("0.2.0", "new", "--name", "server", "--", "/bin/cat"))
	// An agent in a pane types into a pane it did not start: it waits for
	// the person, and the person lets it once.
	link := filepath.Join(e.dir, "bin-0.2.0", "ravenry")
	runCmd(t, e.ravenry("0.2.0", "version"))
	agent := strings.TrimSpace(e.ok("0.2.0", "new", "--", "/bin/sh", "-c", "'"+link+"' send "+target+" --raw hi; echo exit=$?; '"+link+"' send "+target+" --raw no --no-wait; echo exit=$?; '"+link+"' close "+target+" --no-wait; echo close=$?; exec sleep 60"))
	var cp proto.Checkpoint
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	for cp.ID == "" {
		var l proto.CheckpointListResult
		if err := c.Call(ctx, "checkpoint.list", map[string]any{}, &l); err != nil {
			t.Fatal(err)
		}
		for _, x := range l.Checkpoints {
			if x.Kind == "drive" {
				cp = x
			}
		}
		if ctx.Err() != nil {
			t.Fatal("no drive checkpoint")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if cp.Drive.Pane != target || cp.Drive.Agent.Pane != agent || !strings.Contains(cp.Title, `"server"`) {
		t.Fatalf("drive: %+v", cp)
	}
	e.ok("0.2.0", "checkpoint", cp.ID, "--approve")
	w := e.ok("0.2.0", "wait", agent, "--text", `exit=125`, "--since", "0", "--timeout", "15s", "--json")
	if !strings.Contains(w, "exit=0") || !strings.Contains(w, "exit=125") || !strings.Contains(w, "the person must let you") {
		t.Fatalf("the agent's sends: %s", w)
	}
	// Closing it asks too; with --no-wait it fails at once and the pane stays.
	if w := e.ok("0.2.0", "wait", agent, "--text", `close=\d+`, "--since", "0", "--timeout", "15s", "--json"); !strings.Contains(w, "close=125") || !strings.Contains(w, "the person must let you close it") {
		t.Fatalf("the agent's close: %s", w)
	}
	if out := e.ok("0.2.0", "ls"); !strings.Contains(out, target) {
		t.Fatalf("the pane was closed: %s", out)
	}
	// A pick: a file and a shot of a pane; the person picks with a region
	// and a note.
	pic := filepath.Join(e.dir, "a.png")
	os.WriteFile(pic, []byte("\x89PNG\r\n\x1a\n"), 0o600)
	done := startCmd(t, e.ravenry("0.2.0", "pick", "Which one?", "--variant", "A="+pic, "--variant", "B=pane:"+target))
	var pk proto.Checkpoint
	for pk.ID == "" {
		var l proto.CheckpointListResult
		c.Call(ctx, "checkpoint.list", map[string]any{}, &l)
		for _, x := range l.Checkpoints {
			if x.Kind == "pick" {
				pk = x
			}
		}
		if ctx.Err() != nil {
			t.Fatal("no pick checkpoint")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(pk.Variants) != 2 || pk.Variants[0].Path != pic || pk.Variants[1].Type != "image" || pk.Variants[1].Pane != target {
		t.Fatalf("variants: %+v", pk.Variants)
	}
	if b, err := os.ReadFile(pk.Variants[1].Path); err != nil || !bytes.HasPrefix(b, []byte("\x89PNG")) {
		t.Fatalf("the shot variant: %v", err)
	}
	var r proto.CheckpointResult
	if err := c.Call(ctx, "checkpoint.answer", map[string]any{"checkpoint": pk.ID, "pick": map[string]any{"label": "B", "region": map[string]any{"x": 0.1, "y": 0.2, "w": 0.5, "h": 0.25}, "note": "this, but bigger"}}, &r); err != nil {
		t.Fatal(err)
	}
	if out, code := done(); code != 0 || !strings.HasSuffix(out, "B\nregion 0.1000 0.2000 0.5000 0.2500\nnote this, but bigger\n") {
		t.Fatalf("pick: %d %q", code, out)
	}
}

func TestDecisionsFromTheCommandLine(t *testing.T) {
	e := newEnv(t)
	var got []map[string]any
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/decisions/record":
			var b map[string]any
			raw, _ := io.ReadAll(r.Body)
			json.Unmarshal(raw, &b)
			got = append(got, b)
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "decision": map[string]any{"id": "dabcdefg", "quote": b["quote"], "at": "2026-11-07T10:00:00.000Z"}})
		case r.Method == "GET" && r.URL.Path == "/api/decisions":
			if r.URL.Query().Get("agent") != "1" {
				http.Error(w, "not an agent read", 400)
				return
			}
			if p := r.URL.Query().Get("project"); p != "" && p != "game" {
				w.WriteHeader(404)
				w.Write([]byte(`{"error":"No such project."}`))
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "decisions": []map[string]any{{"id": "dabcdefg", "quote": "Menus stay on the left.", "at": "2026-11-07T10:00:00.000Z", "project": "game", "reads_today": 5}}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer hub.Close()
	e.vars = append(e.vars, "RAVENRY_HUB_URL="+hub.URL)
	out, errs, code := runCmd(t, e.ravenry("0.2.0", "decide", "Menus stay on the left.", "--project", "game", "--replaces", "dold1234"))
	if code != 0 || out != "dabcdefg\n" || len(got) != 1 || got[0]["project"] != "game" || got[0]["replaces"] != "dold1234" {
		t.Fatalf("decide: %d %q %q %v", code, out, errs, got)
	}
	// The folder is not a project the hub knows: every project's.
	out, errs, code = runCmd(t, e.ravenry("0.2.0", "decisions", "--search", "menus"))
	if code != 0 || !strings.Contains(out, "read 5 times today") || !strings.Contains(out, "  > Menus stay on the left.") {
		t.Fatalf("decisions: %d %q %q", code, out, errs)
	}
}
