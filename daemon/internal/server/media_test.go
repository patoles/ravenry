package server

import (
	"bytes"
	"encoding/base64"
	"image/gif"
	"image/png"
	"slices"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
	"ravenryd/internal/render"
	"ravenryd/internal/vt"
)

// Pictures, filmstrips, recordings, replay and test conditions of a pane.

func decodePNG(t *testing.T, s string) (w, h int) {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("not a PNG: %v", err)
	}
	return img.Bounds().Dx(), img.Bounds().Dy()
}

func TestShotAndFrames(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	// A spinner of three frames, in colour, then it stays.
	script := `printf '\033[1;32mok\033[0m box\n'; for s in '|' '/' '-'; do printf '\r%s' "$s"; sleep 0.25; done; printf '\rdone\n'; exec sleep 30`
	p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", script}, "cols": 40, "rows": 10})
	waitFor(t, c, p.ID, `done`, 0)
	shot := call[proto.ShotResult](t, c, "pane.shot", map[string]any{"pane": p.ID})
	if w, h := decodePNG(t, shot.PNG); w != shot.Width || h != shot.Height || shot.Cols != 40 || shot.Rows != 10 || w < 40*5 {
		t.Fatalf("shot %dx%d: %+v", w, h, shot)
	}
	// At another size: the screen reflowed, the program not told.
	small := call[proto.ShotResult](t, c, "pane.shot", map[string]any{"pane": p.ID, "cols": 20, "rows": 5, "font_size": 10})
	if w, _ := decodePNG(t, small.PNG); small.Cols != 20 || w >= shot.Width {
		t.Fatalf("shot at 20x5: %+v", small)
	}
	if info := call[proto.ListResult](t, c, "pane.list", map[string]any{}).Panes[0]; info.Cols != 40 {
		t.Fatalf("a shot at another size resized the pane: %+v", info)
	}
	// The filmstrip holds the spinner's steps.
	fr := call[proto.FramesResult](t, c, "pane.frames", map[string]any{"pane": p.ID, "last_ms": 10000, "format": "png"})
	if len(fr.Frames) < 4 {
		t.Fatalf("frames: %d", len(fr.Frames))
	}
	for _, f := range fr.Frames {
		decodePNG(t, f.PNG)
	}
	g := call[proto.FramesResult](t, c, "pane.frames", map[string]any{"pane": p.ID, "format": "gif", "max_frames": 3})
	b, _ := base64.StdEncoding.DecodeString(g.Data)
	an, err := gif.DecodeAll(bytes.NewReader(b))
	if err != nil || len(g.Frames) != 3 || g.Skipped == 0 || len(an.Image) < 2 {
		t.Fatalf("gif: %v frames %d skipped %d decoded %d", err, len(g.Frames), g.Skipped, len(an.Image))
	}
	ap := call[proto.FramesResult](t, c, "pane.frames", map[string]any{"pane": p.ID, "format": "apng"})
	if b, _ := base64.StdEncoding.DecodeString(ap.Data); !bytes.Contains(b, []byte("acTL")) {
		t.Fatal("apng has no animation chunk")
	}
}

func TestRecordingReplayAndSecrets(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	call[proto.Empty](t, c, "events.subscribe", map[string]any{})
	p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", `read line; printf 'one\n'; sleep 0.4; printf 'two %s\n' "$line"; printf '\033[31mred\033[0m\n'; exec sleep 30`}})
	pp, err := d.mgr.Get(p.ID)
	if err != nil {
		t.Fatal(err)
	}
	pp.AddSecret([]byte("hunter22"))
	call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"text": "hunter22\r", "mode": "raw"}}})
	waitFor(t, c, p.ID, `red`, 0)
	rec := call[proto.RecordingResult](t, c, "pane.recording", map[string]any{"pane": p.ID})
	f := rec.Fixture
	var all []byte
	var gap int64
	var last int64
	for _, e := range f.Events {
		b, _ := base64.StdEncoding.DecodeString(e.Data)
		all = append(all, b...)
		if bytes.Contains(b, []byte("two")) {
			gap = e.T - last
		}
		if len(b) > 0 {
			last = e.T
		}
	}
	if f.Format != "ravenry.fixture" || f.Cols != 80 || f.From != 0 || f.To != uint64(len(all)) {
		t.Fatalf("fixture: %+v", f)
	}
	if bytes.Contains(all, []byte("hunter22")) || !bytes.Contains(all, []byte("two ********")) {
		t.Fatalf("the secret in the recording: %q", all)
	}
	if gap < 300 {
		t.Fatalf("timing: two came %d ms after one", gap)
	}
	// The input log never holds it either.
	for _, in := range inputs(t, c, p.ID) {
		if strings.Contains(in.Text, "hunter22") || !in.Masked {
			t.Fatalf("the secret in the input log: %+v", in)
		}
	}
	// Headless, at any speed: the same screen.
	start := time.Now()
	h := call[proto.ReplayResult](t, c, "pane.replay", map[string]any{"fixture": f, "speed": 0, "headless": true, "shot": true, "frames": "gif"})
	if time.Since(start) > 2*time.Second {
		t.Fatalf("speed 0 took %s", time.Since(start))
	}
	cap := call[proto.CaptureResult](t, c, "pane.capture", map[string]any{"pane": p.ID})
	for i := range cap.Lines {
		if h.Capture.Lines[i].Text != cap.Lines[i].Text {
			t.Fatalf("row %d: replay %q, pane %q", i, h.Capture.Lines[i].Text, cap.Lines[i].Text)
		}
	}
	decodePNG(t, h.PNG)
	if h.Frames == nil || h.Frames.Data == "" {
		t.Fatalf("replay frames: %+v", h.Frames)
	}
	// Into a fresh pane, at twice the speed, at another size.
	r := call[proto.ReplayResult](t, c, "pane.replay", map[string]any{"fixture": f, "speed": 2, "cols": 60, "rows": 12})
	if r.Pane == nil || r.Pane.Cols != 60 || r.Pane.Labels["ravenry.replay"] != p.ID || r.Pane.Creator == nil {
		t.Fatalf("replay pane: %+v", r.Pane)
	}
	waitFor(t, c, r.Pane.ID, `red`, 0)
	// A closed pane's recording, from its kept log.
	call[proto.CloseResult](t, c, "pane.close", map[string]any{"pane": p.ID})
	again := call[proto.RecordingResult](t, c, "pane.recording", map[string]any{"pane": p.ID})
	var all2 []byte
	for _, e := range again.Fixture.Events {
		b, _ := base64.StdEncoding.DecodeString(e.Data)
		all2 = append(all2, b...)
	}
	if !bytes.Equal(all, all2) {
		t.Fatalf("closed pane's recording: %q, live %q", all2, all)
	}
	if e := callErr(t, c, "pane.recording", map[string]any{"pane": "pnothere"}); e.Code != "not_found" {
		t.Fatalf("no such recording: %+v", e)
	}
}

func TestOverrides(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", `trap 'stty size' WINCH; echo "term=$TERM"; while :; do sleep 0.05; done`}})
	waitFor(t, c, p.ID, `term=xterm-256color`, 0)
	o := call[proto.PaneResult](t, c, "pane.override", map[string]any{"pane": p.ID, "cols": 40, "rows": 30}).Pane
	if o.Cols != 40 || o.Overrides == nil || o.Overrides.Cols != 40 {
		t.Fatalf("size override: %+v", o)
	}
	waitFor(t, c, p.ID, `30 40`, 0)
	// The window asks for another size: kept for later, not applied.
	call[proto.PaneResult](t, c, "pane.resize", map[string]any{"pane": p.ID, "cols": 100, "rows": 20})
	if got := call[proto.ListResult](t, c, "pane.list", map[string]any{}).Panes[0]; got.Cols != 40 {
		t.Fatalf("a resize under an override: %+v", got)
	}
	// Slowed output: 200 bytes take about a second at 200 bytes a second,
	// even when the daemon was already waiting to read them before the
	// override (no echo wakes it first) and they come in one write.
	q := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", `stty -echo; echo ready; read x; s=; i=0; while [ $i -lt 20 ]; do s="${s}0123456789"; i=$((i+1)); done; printf '%s END\n' "$s"; exec sleep 30`}})
	// The daemon printed "ready" and waits to read again, unslowed.
	waitFor(t, c, q.ID, `ready`, 0)
	call[proto.PaneResult](t, c, "pane.override", map[string]any{"pane": q.ID, "slow_bps": 200})
	start := time.Now()
	call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": q.ID, "input": []map[string]any{{"key": "Enter"}}})
	waitFor(t, c, q.ID, `END`, 0)
	if el := time.Since(start); el < 700*time.Millisecond {
		t.Fatalf("200 bytes at 200 bytes a second took %s", el)
	}
	// Clearing gives the window's size back.
	cl := call[proto.PaneResult](t, c, "pane.override", map[string]any{"pane": p.ID, "clear": true}).Pane
	if cl.Cols != 100 || cl.Rows != 20 || cl.Overrides != nil {
		t.Fatalf("cleared: %+v", cl)
	}
	// TERM for the next restart, and the restart.
	np := call[proto.PaneResult](t, c, "pane.override", map[string]any{"pane": p.ID, "term": "vt100", "restart": true}).Pane
	if np.ID == p.ID || np.Overrides == nil || np.Overrides.Term != "vt100" {
		t.Fatalf("term and restart: %+v", np)
	}
	waitFor(t, c, np.ID, `term=vt100`, 0)
}

// A picture in the window's theme: its background where the program set
// none, its palette for the colours the program used by number.
func TestShotInATheme(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{Name: "app"})
	p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", `printf '\033[41m    \033[0m'; exec sleep 60`}, "cols": 20, "rows": 3})
	waitFor(t, c, p.ID, `^`, 0)
	time.Sleep(300 * time.Millisecond)
	pal := make([]string, 16)
	for i := range pal {
		pal[i] = "#000000"
	}
	pal[1] = "#ff6961"
	shot := call[proto.ShotResult](t, c, "pane.shot", map[string]any{"pane": p.ID, "cursor": false, "theme": map[string]any{"foreground": "#d1d1d6", "background": "#0b0b0c", "palette": pal}})
	b, _ := base64.StdEncoding.DecodeString(shot.PNG)
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	if r, g, bl, _ := img.At(1, 1).RGBA(); r>>8 != 0x0b || g>>8 != 0x0b || bl>>8 != 0x0c {
		t.Fatalf("the background is not the theme's: %x %x %x", r>>8, g>>8, bl>>8)
	}
	cw := shot.Width / 20
	if r, g, bl, _ := img.At(8+cw, 8+cw/2).RGBA(); r>>8 != 0xff || g>>8 != 0x69 || bl>>8 != 0x61 {
		t.Fatalf("palette red is not the theme's: %x %x %x", r>>8, g>>8, bl>>8)
	}
}

// A big pane that draws a new screen of dense text ten times a second:
// all its frames as PNGs are far over the answer's 12 MiB. pane.frames
// still answers, every frame listed with its time, the pictures that fit
// (the screen now and the first among them, the rest spread between)
// under the budget, the others counted as unpictured.
func TestFramesFitTheAnswer(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	// A screen of dense text, then a line rewritten 20 times a second
	// at a row that moves, as a working Claude's tab does.
	script := `od -An -tx1 -N3300 /dev/urandom | tr -d '\n' | fold -w 140; i=0; while [ $i -lt 60 ]; do printf '\033[%d;1H%s %d' $((i % 45 + 1)) "work line $i" $i; i=$((i+1)); sleep 0.05; done; printf '\033[50;1Hdone'; exec sleep 30`
	p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", script}, "cols": 140, "rows": 50})
	waitFor(t, c, p.ID, `done`, 0)
	start := time.Now()
	fr := call[proto.FramesResult](t, c, "pane.frames", map[string]any{"pane": p.ID, "last_ms": 20000, "format": "png", "max_frames": 600, "font_size": 40})
	took := time.Since(start)
	pictured, size := 0, 0
	for i, f := range fr.Frames {
		if f.At == "" {
			t.Fatalf("frame %d has no time", i)
		}
		if f.PNG == "" {
			continue
		}
		pictured++
		size += len(f.PNG)
		if w, h := decodePNG(t, f.PNG); w != fr.Width || h != fr.Height {
			t.Fatalf("frame %d is %dx%d, the answer says %dx%d", i, w, h, fr.Width, fr.Height)
		}
	}
	n := len(fr.Frames)
	t.Logf("%d frames, %d pictured, %.1f MiB of pictures, in %v", n, pictured, float64(size)/(1<<20), took)
	if n < 15 || fr.Unpictured == 0 || pictured+fr.Unpictured != n || pictured < 2 {
		t.Fatalf("frames %d pictured %d unpictured %d: the pictures should not all fit", n, pictured, fr.Unpictured)
	}
	if size > mediaBudget {
		t.Fatalf("pictures are %d bytes, over the budget %d", size, mediaBudget)
	}
	if fr.Frames[0].PNG == "" || fr.Frames[n-1].PNG == "" {
		t.Fatal("the first frame and the screen now should have their pictures")
	}
	// Spread through the stretch: no run of frames without a picture
	// longer than twice the even spacing.
	run, longest := 0, 0
	for _, f := range fr.Frames {
		if f.PNG == "" {
			run++
			longest = max(longest, run)
		} else {
			run = 0
		}
	}
	if even := n / pictured; longest > 2*even+1 {
		t.Fatalf("a run of %d frames without a picture; evenly it would be about %d", longest, even)
	}
}

// strip under a small budget: PNGs listed with the pictures that fit in
// pictureOrder, a stall's frame among them; an animation thinned until it
// fits.
func TestStripBudget(t *testing.T) {
	grid := func(k int) *vt.Grid {
		g := &vt.Grid{Cols: 60, Rows: 20, Fg: vt.RGB{R: 220, G: 220, B: 220}}
		for y := 0; y < g.Rows; y++ {
			row := make([]vt.Cell, g.Cols)
			for x := range row {
				row[x] = vt.Cell{Text: string(rune('a' + (x*7+y*13+k*31)%26)), FgIndex: -1, BgIndex: -1}
			}
			g.Cells = append(g.Cells, row)
		}
		return g
	}
	t0 := time.Unix(1000, 0)
	var frames []render.Frame
	var at []time.Time
	var marks []uint64
	for k := 0; k < 30; k++ {
		at = append(at, t0.Add(time.Duration(k)*100*time.Millisecond))
		if k >= 12 {
			at[k] = at[k].Add(3 * time.Second) // frame 11 stayed 3.1 s
		}
		frames = append(frames, render.Frame{Grid: grid(k)})
		marks = append(marks, uint64(k))
	}
	for i := range frames {
		frames[i].Delay = time.Second
		if i+1 < len(frames) {
			frames[i].Delay = at[i+1].Sub(at[i])
		}
	}
	o := render.Options{FontSize: 14}
	one, err := render.PNG(frames[0].Grid, o)
	if err != nil {
		t.Fatal(err)
	}
	budget := (len(one) + 2) / 3 * 4 * 6
	res, err := strip(frames, at, marks, nil, "png", o, budget)
	if err != nil {
		t.Fatal(err)
	}
	var got []int
	size := 0
	for i, f := range res.Frames {
		if f.PNG != "" {
			got = append(got, i)
			size += len(f.PNG)
		}
	}
	if len(res.Frames) != 30 || len(got) < 4 || len(got) > 6 || res.Unpictured != 30-len(got) || size > budget {
		t.Fatalf("png: %d frames, pictured %v, unpictured %d, %d bytes of %d", len(res.Frames), got, res.Unpictured, size, budget)
	}
	if got[0] != 0 || got[len(got)-1] != 29 || !slices.Contains(got, 11) {
		t.Fatalf("pictured %v: the first, the last and the stall's frame (11) first", got)
	}
	whole, err := strip(frames, at, marks, nil, "gif", o, 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	small := len(whole.Data) * 2 / 3
	g, err := strip(frames, at, marks, nil, "gif", o, small)
	if err != nil {
		t.Fatal(err)
	}
	if g.Skipped == 0 || len(g.Frames)+g.Skipped != 30 || len(g.Data) > small || g.Frames[0].Mark != 0 || g.Frames[len(g.Frames)-1].Mark != 29 {
		t.Fatalf("gif under %d: %d frames, skipped %d, %d bytes", small, len(g.Frames), g.Skipped, len(g.Data))
	}
	b, _ := base64.StdEncoding.DecodeString(g.Data)
	if an, err := gif.DecodeAll(bytes.NewReader(b)); err != nil || len(an.Image) < 2 {
		t.Fatalf("thinned gif: %v", err)
	}
}

// A redraw seen half done: rows erased and drawn again 300 ms later.
// Without synchronized output the strip holds the screen with the rows
// missing, and missing_rows counts them; inside a synchronized update
// (2026) the screen is the last frame the program finished until it
// ends, as a terminal shows it, so no frame has rows missing. A
// line rewritten ten times a second misses no row.
func TestFramesHalfDrawn(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	text := `i=1; while [ $i -le 8 ]; do printf 'line %d of the transcript, words words words\n' $i; i=$((i+1)); done`
	erase := `printf '\033[H'; i=0; while [ $i -lt 8 ]; do printf '\033[2K\033[1B'; i=$((i+1)); done`
	redraw := `printf '\033[H'; ` + text
	run := func(begin, end string) []proto.FilmFrame {
		script := text + `; sleep 0.3; printf '` + begin + `'; ` + erase + `; sleep 0.3; ` + redraw + `; printf '` + end + `'; sleep 0.3; printf 'done'; exec sleep 30`
		p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", script}, "cols": 60, "rows": 10})
		waitFor(t, c, p.ID, `done`, 0)
		return call[proto.FramesResult](t, c, "pane.frames", map[string]any{"pane": p.ID, "format": "png", "font_size": 6}).Frames
	}
	count := func(fs []proto.FilmFrame) (n int) {
		for _, f := range fs {
			if f.MissingRows == nil {
				t.Fatal("a frame without missing_rows")
			}
			if *f.MissingRows > 0 {
				n++
			}
		}
		return n
	}
	if n := count(run(``, ``)); n == 0 {
		t.Fatal("the redraw without synchronized output: no frame with rows missing")
	}
	if fs := run(`\033[?2026h`, `\033[?2026l`); count(fs) != 0 {
		t.Fatalf("the redraw in a synchronized update: %d frames with rows missing", count(fs))
	}
	p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", text + `; i=0; while [ $i -lt 15 ]; do printf '\r* Working (%d)' $i; i=$((i+1)); sleep 0.1; done; printf ' done'; exec sleep 30`}, "cols": 60, "rows": 10})
	waitFor(t, c, p.ID, ` done`, 0)
	fs := call[proto.FramesResult](t, c, "pane.frames", map[string]any{"pane": p.ID, "format": "png", "font_size": 6}).Frames
	if len(fs) < 10 || count(fs) != 0 {
		t.Fatalf("the spinner: %d frames, %d with rows missing", len(fs), count(fs))
	}
}
