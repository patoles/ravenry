package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
)

// The commands of Phase 2: who typed what (inputs), one driver at a time
// (lease), what a pane touched (files), pictures (shot, frames),
// recordings (fixture, replay), test conditions (override), picks, and
// the decision ledger (decide, decisions).

// phonePreset is what --phone sets: the columns of a phone held upright,
// as the phone board draws a pane.
const phoneCols, phoneRows = 40, 30

func cmdInputs(in []string) error {
	a, err := parse(in, specOf("inputs"))
	if err != nil {
		return err
	}
	id, err := onePane(a, "inputs")
	if err != nil {
		return err
	}
	params := map[string]any{"pane": id}
	if v := a.values["since"]; v != "" {
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			return fmt.Errorf("--since %q is not a number", v)
		}
		params["since"] = n
	}
	if v := a.values["limit"]; v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return fmt.Errorf("--limit %q is not a number", v)
		}
		params["limit"] = n
	}
	ctx, cancel := callCtx(10 * time.Second)
	defer cancel()
	c, err := connectFor(ctx, a.g, id)
	if err != nil {
		return err
	}
	defer c.Close()
	var r proto.InputsResult
	if err := c.Call(ctx, "pane.inputs", params, &r); err != nil {
		return err
	}
	if a.g.json {
		return printJSON(r)
	}
	for _, x := range r.Inputs {
		text := x.Text
		switch {
		case x.Kind == "secret":
			text = "(a secret, never shown)"
		case x.Masked && text == "":
			text = fmt.Sprintf("(%d bytes at a password prompt, not shown)", x.Bytes)
		}
		who := sourceText(x.Source)
		if x.LeaseHolder != nil {
			who += " (while " + sourceText(*x.LeaseHolder) + " held the lease)"
		}
		fmt.Printf("%d  %s  %s  %s\n", x.Seq, x.At, who, text)
	}
	return nil
}

func sourceText(s proto.Source) string {
	out := s.Kind
	switch {
	case s.Kind == "agent" && s.Pane != "":
		out = "agent in " + s.Pane
	case s.Kind == "client" && s.Client != "":
		out = "program " + s.Client
	}
	if s.By != "" {
		out += " (" + s.By + ")"
	}
	return out
}

func cmdLease(in []string) error {
	a, err := parse(in, specOf("lease"))
	if err != nil {
		return err
	}
	id, err := onePane(a, "lease")
	if err != nil {
		return err
	}
	params := map[string]any{"pane": id}
	wait := time.Duration(0)
	if a.bools["release"] {
		params["release"] = true
	} else {
		if v := a.values["ttl"]; v != "" {
			d, err := duration(v)
			if err != nil {
				return err
			}
			params["ttl_ms"] = d.Milliseconds()
		}
		if v := a.values["wait"]; v != "" {
			d, err := duration(v)
			if err != nil {
				return err
			}
			params["wait_ms"] = d.Milliseconds()
			wait = d
		}
	}
	ctx, cancel := callCtx(wait + 24*time.Hour)
	defer cancel()
	c, err := connectFor(ctx, a.g, id)
	if err != nil {
		return err
	}
	defer c.Close()
	var r proto.LeaseResult
	if err := callAsking(ctx, c, "pane.lease", params, &r, a.bools["no-wait"]); err != nil {
		return err
	}
	if a.g.json {
		return printJSON(r)
	}
	if r.Lease == nil {
		fmt.Println("released")
		return nil
	}
	fmt.Println(r.Lease.ExpiresAt)
	return nil
}

// callAsking calls a method that may need the person to let this agent
// drive the pane: it tries without waiting, says on stderr that it asked
// and waits for the answer, unless noWait.
func callAsking(ctx context.Context, c *client.Client, method string, params map[string]any, out any, noWait bool) error {
	params["no_wait"] = true
	err := c.Call(ctx, method, params, out)
	var ce *client.Error
	if !errors.As(err, &ce) {
		return err
	}
	switch {
	case ce.Code == proto.CodeLeased:
		holder := "another driver"
		if ce.Lease != nil {
			holder = sourceText(ce.Lease.Holder)
		}
		fmt.Fprintf(os.Stderr, "%s\n", ce.Message)
		_ = holder
		return exitCode(exitLeased)
	case ce.Code == proto.CodeForbidden && ce.Checkpoint != "" && !noWait:
		fmt.Fprintf(os.Stderr, "you did not start pane %v, so the person must let you type into it: waiting for them to answer %s (in the Ravenry app or on the phone)...\n", params["pane"], ce.Checkpoint)
		delete(params, "no_wait")
		err = c.Call(ctx, method, params, out)
		if errors.As(err, &ce) && ce.Code == proto.CodeForbidden {
			fmt.Fprintf(os.Stderr, "%s\n", ce.Message)
			return exitCode(exitDeclined)
		}
		return err
	case ce.Code == proto.CodeForbidden && ce.Checkpoint != "":
		fmt.Fprintf(os.Stderr, "%s\n", ce.Message)
		if c := ce.Checkpoint; c != "" {
			fmt.Println(c)
		}
		return exitCode(exitDeclined)
	}
	return err
}

// exitLeased: another driver holds the pane's lease.
const exitLeased = 75

func cmdGrants(in []string) error {
	a, err := parse(in, specOf("grants"))
	if err != nil {
		return err
	}
	params := map[string]any{}
	if len(a.pos) > 1 {
		return errors.New("usage: ravenry grants [PANE]")
	}
	if len(a.pos) == 1 {
		params["pane"] = a.pos[0]
	}
	ctx, cancel := callCtx(10 * time.Second)
	defer cancel()
	c, err := connectNewest(ctx, a.g)
	if err != nil {
		return err
	}
	defer c.Close()
	var r proto.GrantsResult
	if err := c.Call(ctx, "pane.grants", params, &r); err != nil {
		return err
	}
	if a.g.json {
		return printJSON(r)
	}
	for _, g := range r.Grants {
		fmt.Printf("%s  %s may type into %s for its %s (since %s)\n", g.ID, sourceText(g.Agent), g.Pane, g.Allow, g.CreatedAt)
	}
	return nil
}

func cmdRevoke(in []string) error {
	a, err := parse(in, specOf("revoke"))
	if err != nil {
		return err
	}
	if len(a.pos) != 1 {
		return errors.New("usage: ravenry revoke GRANT")
	}
	ctx, cancel := callCtx(10 * time.Second)
	defer cancel()
	c, err := connectNewest(ctx, a.g)
	if err != nil {
		return err
	}
	defer c.Close()
	var r proto.RevokeResult
	if err := c.Call(ctx, "pane.revoke", map[string]any{"grant": a.pos[0]}, &r); err != nil {
		var ce *client.Error
		if errors.As(err, &ce) && ce.Code == proto.CodeForbidden {
			return fmt.Errorf("only a person can end a grant, in the Ravenry app or at a terminal outside every pane (%s)", ce.Message)
		}
		return err
	}
	if a.g.json {
		return printJSON(r)
	}
	fmt.Println("revoked")
	return nil
}

func cmdFiles(in []string) error {
	a, err := parse(in, specOf("files"))
	if err != nil {
		return err
	}
	id, err := onePane(a, "files")
	if err != nil {
		return err
	}
	params := map[string]any{"pane": id}
	if a.bools["no-git"] {
		params["no_git"] = true
	}
	ctx, cancel := callCtx(15 * time.Second)
	defer cancel()
	c, err := connectFor(ctx, a.g, id)
	if err != nil {
		return err
	}
	defer c.Close()
	var r proto.FilesResult
	if err := c.Call(ctx, "pane.files", params, &r); err != nil {
		return err
	}
	if a.g.json {
		return printJSON(r)
	}
	for _, f := range r.Files {
		how := strings.Join(f.Sources, "+")
		if f.Tool != "" {
			how += " " + f.Tool
		}
		if f.Status != "" {
			how += " [" + strings.TrimSpace(f.Status) + "]"
		}
		fmt.Printf("%s  %s\n", f.Path, how)
	}
	return nil
}

// writeOut writes base64 data to --out (- or none: standard output).
func writeOut(a *args, data string, def string) (string, error) {
	b, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return "", err
	}
	out := a.values["out"]
	if out == "" {
		out = def
	}
	if out == "-" {
		_, err := os.Stdout.Write(b)
		return "-", err
	}
	return out, os.WriteFile(out, b, 0o644)
}

func fontSize(a *args, params map[string]any) error {
	if v := a.values["font-size"]; v != "" {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return fmt.Errorf("--font-size %q is not a number", v)
		}
		params["font_size"] = f
	}
	return nil
}

func cmdShot(in []string) error {
	a, err := parse(in, specOf("shot"))
	if err != nil {
		return err
	}
	id, err := onePane(a, "shot")
	if err != nil {
		return err
	}
	params := map[string]any{"pane": id}
	if v := a.values["size"]; v != "" {
		cols, rows, err := size(v)
		if err != nil {
			return err
		}
		params["cols"], params["rows"] = cols, rows
	}
	if a.bools["no-cursor"] {
		params["cursor"] = false
	}
	if err := fontSize(a, params); err != nil {
		return err
	}
	ctx, cancel := callCtx(30 * time.Second)
	defer cancel()
	c, err := connectFor(ctx, a.g, id)
	if err != nil {
		return err
	}
	defer c.Close()
	var r proto.ShotResult
	if err := c.Call(ctx, "pane.shot", params, &r); err != nil {
		return err
	}
	out, err := writeOut(a, r.PNG, id+".png")
	if err != nil {
		return err
	}
	if a.g.json {
		r.PNG = ""
		return printJSON(map[string]any{"file": out, "shot": r})
	}
	if out != "-" {
		fmt.Printf("%s  %dx%d px, %dx%d cells\n", out, r.Width, r.Height, r.Cols, r.Rows)
	}
	return nil
}

// formatOf is the format a file name asks for: .gif, .png (a folder of
// PNGs when it is a folder or ends in /), .apng.
func formatOf(out string) (format string, dir bool) {
	switch strings.ToLower(filepath.Ext(out)) {
	case ".gif":
		return "gif", false
	case ".apng":
		return "apng", false
	case ".png":
		return "apng", false
	}
	if fi, err := os.Stat(out); (err == nil && fi.IsDir()) || strings.HasSuffix(out, "/") {
		return "png", true
	}
	return "", false
}

func cmdFrames(in []string) error {
	a, err := parse(in, specOf("frames"))
	if err != nil {
		return err
	}
	id, err := onePane(a, "frames")
	if err != nil {
		return err
	}
	out := a.values["out"]
	if out == "" {
		out = id + ".gif"
	}
	format, dir := formatOf(out)
	if format == "" {
		return fmt.Errorf("--out %s: a .gif, an .apng (or .png) file, or a folder for one PNG a frame", out)
	}
	params := map[string]any{"pane": id, "format": format}
	if v := a.values["last"]; v != "" {
		d, err := duration(v)
		if err != nil {
			return err
		}
		params["last_ms"] = d.Milliseconds()
	}
	if v := a.values["max"]; v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return fmt.Errorf("--max %q is not a number", v)
		}
		params["max_frames"] = n
	}
	if err := fontSize(a, params); err != nil {
		return err
	}
	ctx, cancel := callCtx(2 * time.Minute)
	defer cancel()
	c, err := connectFor(ctx, a.g, id)
	if err != nil {
		return err
	}
	defer c.Close()
	var r proto.FramesResult
	if err := c.Call(ctx, "pane.frames", params, &r); err != nil {
		return err
	}
	return saveFrames(a, r, out, dir)
}

func saveFrames(a *args, r proto.FramesResult, out string, dir bool) error {
	var files []string
	if dir {
		if err := os.MkdirAll(out, 0o755); err != nil {
			return err
		}
		for i, f := range r.Frames {
			b, err := base64.StdEncoding.DecodeString(f.PNG)
			if err != nil {
				return err
			}
			name := filepath.Join(out, fmt.Sprintf("frame-%03d.png", i+1))
			if err := os.WriteFile(name, b, 0o644); err != nil {
				return err
			}
			files = append(files, name)
		}
	} else {
		b, err := base64.StdEncoding.DecodeString(r.Data)
		if err != nil {
			return err
		}
		if err := os.WriteFile(out, b, 0o644); err != nil {
			return err
		}
		files = []string{out}
	}
	if a.g.json {
		for i := range r.Frames {
			r.Frames[i].PNG = ""
		}
		r.Data = ""
		return printJSON(map[string]any{"files": files, "frames": r})
	}
	fmt.Printf("%s  %d frames from %s to %s", out, len(r.Frames), r.From, r.To)
	if r.Skipped > 0 {
		fmt.Printf(" (%d more left out)", r.Skipped)
	}
	fmt.Println()
	return nil
}

func cmdFixture(in []string) error {
	a, err := parse(in, specOf("fixture"))
	if err != nil {
		return err
	}
	id, err := onePane(a, "fixture")
	if err != nil {
		return err
	}
	params := map[string]any{"pane": id}
	for _, k := range []string{"from", "to"} {
		if v := a.values[k]; v != "" {
			n, err := strconv.ParseUint(v, 10, 64)
			if err != nil {
				return fmt.Errorf("--%s %q is not a mark", k, v)
			}
			params[k] = n
		}
	}
	if v := a.values["last"]; v != "" {
		d, err := duration(v)
		if err != nil {
			return err
		}
		params["last_ms"] = d.Milliseconds()
	}
	ctx, cancel := callCtx(time.Minute)
	defer cancel()
	c, err := connectNewest(ctx, a.g)
	if err != nil {
		return err
	}
	defer c.Close()
	var r proto.RecordingResult
	if err := c.Call(ctx, "pane.recording", params, &r); err != nil {
		return err
	}
	b, err := json.MarshalIndent(r.Fixture, "", " ")
	if err != nil {
		return err
	}
	out := a.values["out"]
	if out == "" {
		out = id + ".fixture.json"
	}
	if out == "-" {
		_, err = os.Stdout.Write(append(b, '\n'))
		return err
	}
	if err := os.WriteFile(out, append(b, '\n'), 0o644); err != nil {
		return err
	}
	if a.g.json {
		return printJSON(map[string]any{"file": out, "from": r.Fixture.From, "to": r.Fixture.To, "events": len(r.Fixture.Events), "truncated": r.Truncated})
	}
	note := ""
	if r.Truncated {
		note = " (the log no longer held the start)"
	}
	fmt.Printf("%s  marks %d to %d, %d events%s\n", out, r.Fixture.From, r.Fixture.To, len(r.Fixture.Events), note)
	return nil
}

// loadFixture reads a fixture file, or records one from a pane.
func loadFixture(ctx context.Context, c *client.Client, src string) (*proto.Fixture, error) {
	if b, err := os.ReadFile(src); err == nil {
		var f proto.Fixture
		if err := json.Unmarshal(b, &f); err != nil {
			return nil, fmt.Errorf("%s is not a fixture: %v", src, err)
		}
		return &f, nil
	}
	var r proto.RecordingResult
	if err := c.Call(ctx, "pane.recording", map[string]any{"pane": src}, &r); err != nil {
		return nil, fmt.Errorf("%s is neither a fixture file nor a pane: %v", src, err)
	}
	return &r.Fixture, nil
}

func cmdReplay(in []string) error {
	a, err := parse(in, specOf("replay"))
	if err != nil {
		return err
	}
	if len(a.pos) != 1 {
		return errors.New("usage: ravenry replay PANE|FIXTURE.json [--speed N] [--headless]")
	}
	ctx, cancel := callCtx(time.Hour)
	defer cancel()
	c, err := connectNewest(ctx, a.g)
	if err != nil {
		return err
	}
	defer c.Close()
	f, err := loadFixture(ctx, c, a.pos[0])
	if err != nil {
		return err
	}
	params := map[string]any{"fixture": f}
	if v := a.values["speed"]; v != "" {
		s := 0.0
		if v != "max" {
			if s, err = strconv.ParseFloat(v, 64); err != nil {
				return fmt.Errorf("--speed %q is not a number (or max)", v)
			}
		}
		params["speed"] = s
	}
	if v := a.values["size"]; v != "" {
		cols, rows, err := size(v)
		if err != nil {
			return err
		}
		params["cols"], params["rows"] = cols, rows
	}
	if a.bools["phone"] {
		params["cols"], params["rows"] = phoneCols, phoneRows
	}
	if v := a.values["slow"]; v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return fmt.Errorf("--slow %q is not a number of bytes a second", v)
		}
		params["slow_bps"] = n
	}
	if v := a.values["term"]; v != "" {
		params["term"] = v
	}
	headless := a.bools["headless"] || a.values["out"] != "" || a.values["frames"] != ""
	if headless {
		params["headless"] = true
		if a.values["out"] != "" {
			params["shot"] = true
		}
		if v := a.values["frames"]; v != "" {
			format, dir := formatOf(v)
			if format == "" {
				return fmt.Errorf("--frames %s: a .gif, an .apng (or .png) file, or a folder", v)
			}
			_ = dir
			params["frames"] = format
		}
		if err := fontSize(a, params); err != nil {
			return err
		}
	}
	var r proto.ReplayResult
	if err := c.Call(ctx, "pane.replay", params, &r); err != nil {
		return err
	}
	if !headless {
		if a.g.json {
			return printJSON(r)
		}
		fmt.Println(r.Pane.ID)
		return nil
	}
	if r.PNG != "" {
		if _, err := writeOut(a, r.PNG, ""); err != nil {
			return err
		}
	}
	if v := a.values["frames"]; v != "" && r.Frames != nil {
		_, dir := formatOf(v)
		quiet := &args{g: global{json: true}}
		if err := saveFrames(quiet, *r.Frames, v, dir); err != nil {
			return err
		}
	}
	if a.g.json {
		r.PNG = ""
		r.Frames = nil
		return printJSON(r)
	}
	if r.Capture != nil {
		for _, l := range r.Capture.Lines {
			fmt.Println(l.Text)
		}
	}
	return nil
}

func cmdOverride(in []string) error {
	a, err := parse(in, specOf("override"))
	if err != nil {
		return err
	}
	id, err := onePane(a, "override")
	if err != nil {
		return err
	}
	params := map[string]any{"pane": id}
	if v := a.values["size"]; v != "" {
		cols, rows, err := size(v)
		if err != nil {
			return err
		}
		params["cols"], params["rows"] = cols, rows
	}
	if a.bools["phone"] {
		params["cols"], params["rows"] = phoneCols, phoneRows
	}
	if v, ok := a.values["slow"]; ok {
		n, err := strconv.Atoi(v)
		if err != nil {
			return fmt.Errorf("--slow %q is not a number of bytes a second (0: not slowed)", v)
		}
		params["slow_bps"] = n
	}
	if v, ok := a.values["term"]; ok {
		params["term"] = v
	}
	if a.bools["clear"] {
		params["clear"] = true
	}
	if a.bools["restart"] {
		params["restart"] = true
	}
	ctx, cancel := callCtx(24 * time.Hour)
	defer cancel()
	c, err := connectFor(ctx, a.g, id)
	if err != nil {
		return err
	}
	defer c.Close()
	var r proto.PaneResult
	if err := callAsking(ctx, c, "pane.override", params, &r, false); err != nil {
		return err
	}
	if a.g.json {
		return printJSON(r)
	}
	if r.Pane.ID != id {
		fmt.Println(r.Pane.ID)
		return nil
	}
	o := "none"
	if r.Pane.Overrides != nil {
		x := r.Pane.Overrides
		var parts []string
		if x.Cols > 0 {
			parts = append(parts, fmt.Sprintf("%dx%d", x.Cols, x.Rows))
		}
		if x.SlowBps > 0 {
			parts = append(parts, fmt.Sprintf("%d bytes/s", x.SlowBps))
		}
		if x.Term != "" {
			parts = append(parts, "TERM="+x.Term+" at the next restart")
		}
		o = strings.Join(parts, ", ")
	}
	fmt.Printf("%s  %dx%d  overrides: %s\n", r.Pane.ID, r.Pane.Cols, r.Pane.Rows, o)
	return nil
}

func cmdPick(in []string) error {
	a, err := parse(in, specOf("pick"))
	if err != nil {
		return err
	}
	title, err := oneTitle(a, "pick")
	if err != nil {
		return err
	}
	p, err := checkpointParams(a, "pick", title)
	if err != nil {
		return err
	}
	var vs []map[string]any
	for _, v := range a.lists["variant"] {
		label, src, ok := strings.Cut(v, "=")
		if !ok || label == "" || src == "" {
			return fmt.Errorf("--variant %q: LABEL=FILE, or LABEL=pane:PANE for a shot of a pane now", v)
		}
		if pane, ok := strings.CutPrefix(src, "pane:"); ok {
			vs = append(vs, map[string]any{"label": label, "pane": pane})
			continue
		}
		abs, err := filepath.Abs(src)
		if err != nil {
			return err
		}
		vs = append(vs, map[string]any{"label": label, "path": abs})
	}
	if len(vs) < 2 || len(vs) > 4 {
		return errors.New("a pick shows 2 to 4 variants: --variant LABEL=FILE (an image or an .html page) or LABEL=pane:PANE")
	}
	p["variants"] = vs
	return openCheckpoint(a, p)
}

// ------------------------------------------------------------ decisions

// hubCall sends a request to the hub's HTTP API and decodes its JSON.
func hubCall(method, path string, body any, out any) error {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	u := hubURL()
	req, _ := http.NewRequest(method, u+path, rd)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Ravenry", "1")
	res, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return errHubDown{u}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	var e struct {
		Error string `json:"error"`
	}
	if res.StatusCode != 200 {
		msg := "the hub answered " + res.Status
		if json.Unmarshal(raw, &e) == nil && e.Error != "" {
			msg = e.Error
		}
		return hubError{res.StatusCode, msg}
	}
	return json.Unmarshal(raw, out)
}

type hubError struct {
	status int
	msg    string
}

func (e hubError) Error() string { return e.msg }

type errHubDown struct{ url string }

func (e errHubDown) Error() string {
	return fmt.Sprintf("Ravenry's hub is not running at %s: open the Ravenry app, then try again", e.url)
}

// Decision is a ledger entry as the hub gives it.
type Decision struct {
	ID           string `json:"id"`
	Quote        string `json:"quote"`
	At           string `json:"at"`
	Project      string `json:"project,omitempty"`
	Scope        string `json:"scope,omitempty"`
	By           string `json:"by,omitempty"`
	OverriddenBy string `json:"overridden_by,omitempty"`
	ReadsToday   int    `json:"reads_today"`
	ReadsTotal   int    `json:"reads_total"`
}

func projectArg(a *args) string {
	if p := a.values["project"]; p != "" {
		return p
	}
	return ""
}

func cmdDecide(in []string) error {
	a, err := parse(in, specOf("decide"))
	if err != nil {
		return err
	}
	if len(a.pos) != 1 || strings.TrimSpace(a.pos[0]) == "" {
		return errors.New("usage: ravenry decide \"THE PERSON'S WORDS, VERBATIM\" [--project P] [--replaces ID]")
	}
	// Without --project, the hub takes the project of this agent's
	// session.
	body := map[string]any{"quote": a.pos[0]}
	if p := projectArg(a); p != "" {
		body["project"] = p
	}
	if v := a.values["replaces"]; v != "" {
		body["replaces"] = v
	}
	if v := a.values["scope"]; v != "" {
		body["scope"] = v
	}
	var r struct {
		Decision Decision `json:"decision"`
	}
	if err := hubCall("POST", "/api/decisions/record", body, &r); err != nil {
		return err
	}
	if a.g.json {
		return printJSON(r)
	}
	fmt.Println(r.Decision.ID)
	return nil
}

func cmdDecisions(in []string) error {
	a, err := parse(in, specOf("decisions"))
	if err != nil {
		return err
	}
	// Without --project: the project of this folder, else every project.
	q := url.Values{}
	guessed := false
	if p := projectArg(a); p != "" {
		q.Set("project", p)
	} else if wd, err := os.Getwd(); err == nil && !a.bools["all-projects"] {
		q.Set("project", wd)
		guessed = true
	}
	if v := a.values["search"]; v != "" {
		q.Set("search", v)
	}
	if a.bools["all"] {
		q.Set("all", "1")
	}
	q.Set("agent", "1")
	var r struct {
		Decisions []Decision `json:"decisions"`
	}
	err = hubCall("GET", "/api/decisions?"+q.Encode(), nil, &r)
	var he hubError
	if guessed && errors.As(err, &he) && he.status == 404 {
		q.Del("project")
		err = hubCall("GET", "/api/decisions?"+q.Encode(), nil, &r)
	}
	if err != nil {
		return err
	}
	if a.g.json {
		return printJSON(r)
	}
	if len(r.Decisions) == 0 {
		fmt.Fprintln(os.Stderr, "no decisions on record for this")
		return nil
	}
	for _, d := range r.Decisions {
		head := d.ID + "  " + d.At
		if d.Project != "" {
			head += "  " + d.Project
		}
		if d.Scope != "" {
			head += " (" + d.Scope + ")"
		}
		if d.OverriddenBy != "" {
			head += "  replaced by " + d.OverriddenBy
		}
		head += fmt.Sprintf("  read %d times today", d.ReadsToday)
		fmt.Println(head)
		for _, l := range strings.Split(d.Quote, "\n") {
			fmt.Println("  > " + l)
		}
	}
	return nil
}
