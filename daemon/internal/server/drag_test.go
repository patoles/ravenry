package server

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/pane"
	"ravenryd/internal/proto"
	"ravenryd/internal/testenv"
)

// TestRenderDragZsh drags a pane's width the way a person drags a
// window's edge, over a long multi-line command line at a zsh prompt,
// with a client that draws the render stream at 120 Hz. At each display
// tick it looks at the client's screen: a blank frame (the command line
// gone) or debris (a piece of an old prompt) fails, and so does a last
// screen that is not the daemon's. RAVENRY_DRAG_MIN sets the narrowest
// width in columns (default 38, a 300 pt window in the Mac app).
func TestRenderDragZsh(t *testing.T) {
	zsh, err := exec.LookPath("zsh")
	if err != nil {
		t.Skip("no zsh")
	}
	if testing.Short() {
		t.Skip("short")
	}
	shells := filepath.Join(t.TempDir(), "shell")
	testenv.CheckDirs(t, shells)
	d := startDaemon(t, func(o *pane.ManagerOptions) {
		o.ShellDir = shells
		o.Env = append(o.Env, "SHELL="+zsh)
	})
	rc := "skip_global_compinit=1\n"
	os.WriteFile(filepath.Join(d.home, ".zshenv"), []byte(rc), 0o600)
	os.WriteFile(filepath.Join(d.home, ".zshrc"), []byte("PROMPT='~ > '\n"+os.Getenv("RAVENRY_DRAG_ZSHRC")+"\n"), 0o600)
	c := d.dial(client.Options{})
	wide, rows, narrow := 150, 40, 38
	if v := os.Getenv("RAVENRY_DRAG_MIN"); v != "" {
		fmt.Sscan(v, &narrow)
	}
	if v := os.Getenv("RAVENRY_DRAG_ROWS"); v != "" {
		fmt.Sscan(v, &rows)
	}
	p := newPane(t, c, map[string]any{"cols": wide, "rows": rows, "cwd": d.home})
	st, err := c.Render(ctx(t), p.ID, client.RenderOptions{FPS: 120})
	if err != nil {
		t.Fatal(err)
	}
	r := &renderClient{t: t, st: st}
	r.until("~ >")
	time.Sleep(300 * time.Millisecond)
	for r.next(50*time.Millisecond) != nil {
	}
	promptScreen := strings.Join(r.scr.Text(), "\n")
	words := "the quick brown fox jumps over the lazy dog and keeps running past the river while the wind blows"
	var lines []string
	for i := range 10 {
		lines = append(lines, fmt.Sprintf("line %d: %s", i, strings.Repeat(words+" ", i%3+1)))
	}
	pasted := strings.Join(lines, "\n")
	if err := st.Events(ctx(t), []proto.RenderEvent{{Paste: &pasted}}); err != nil {
		t.Fatal(err)
	}
	r.until("line 9")
	time.Sleep(800 * time.Millisecond)
	for r.next(50*time.Millisecond) != nil {
	}
	flat := func(s string) string { return strings.Join(strings.Fields(s), "") }
	ink := func() int { return len(flat(strings.Join(r.scr.Text(), ""))) }
	whole := flat(promptScreen + pasted)
	fp := flat(promptScreen)
	debris := func(text string) bool {
		f := flat(text)
		switch {
		case strings.HasPrefix(f, fp+">...."):
			f = f[len(fp)+5:]
		case strings.HasPrefix(f, ">...."):
			f = f[5:]
		}
		return !strings.Contains(whole, f)
	}
	base := ink()
	if debris(strings.Join(r.scr.Text(), "\n")) {
		t.Fatalf("debris before the drag:\n%s", strings.Join(r.scr.Text(), "\n"))
	}

	// The drag: one column a step, a step a display tick (120 Hz), down
	// and back up. At each tick the client draws what it has.
	var widths []int
	for w := wide; w > narrow; w-- {
		widths = append(widths, w)
	}
	for w := narrow; w <= wide; w++ {
		widths = append(widths, w)
	}
	tick := time.Second / 120
	next := time.Now()
	blank, bad, ticks := 0, 0, 0
	var badShots []string
	var frameGaps []time.Duration
	lastFrame := time.Now()
	framesBefore := r.frames
	sample := func() {
		ticks++
		text := strings.Join(r.scr.Text(), "\n")
		if ink() < base*3/10 {
			blank++
		}
		if debris(text) {
			bad++
			if len(badShots) < 2 {
				badShots = append(badShots, fmt.Sprintf("at %d cols:\n%s", r.scr.Cols, text))
			}
		}
	}
	start := time.Now()
	for _, w := range widths {
		go c.Call(ctx(t), "pane.resize", map[string]any{"pane": p.ID, "cols": w, "rows": rows}, nil)
		next = next.Add(tick)
		for time.Now().Before(next) {
			if f := r.next(time.Until(next)); f != nil {
				frameGaps = append(frameGaps, time.Since(lastFrame))
				lastFrame = time.Now()
			}
		}
		sample()
	}
	dragTime := time.Since(start)
	// Settle, then the client's screen must be the daemon's.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		r.next(50 * time.Millisecond)
		sample()
	}
	cap := call[proto.CaptureResult](t, c, "pane.capture", map[string]any{"pane": p.ID})
	var daemonText []string
	for _, l := range cap.Lines {
		daemonText = append(daemonText, strings.TrimRight(l.Text, " "))
	}
	equal := strings.Join(daemonText, "\n") == strings.Join(r.scr.Text(), "\n")
	sort.Slice(frameGaps, func(i, j int) bool { return frameGaps[i] < frameGaps[j] })
	p95 := time.Duration(0)
	if len(frameGaps) > 0 {
		p95 = frameGaps[len(frameGaps)*95/100]
	}
	msg := fmt.Sprintf("zsh drag %d to %d cols and back, %d steps in %v: %d display ticks, %d frames (gap p95 %v), blank %d, debris %d, client ends on the daemon's screen: %v",
		wide, narrow, len(widths), dragTime.Round(time.Millisecond), ticks, r.frames-framesBefore, p95.Round(100*time.Microsecond), blank, bad, equal)
	t.Log(msg)
	fmt.Println("MEASURE " + msg)
	for _, s := range badShots {
		t.Log("debris " + s)
	}
	if blank > 0 {
		t.Errorf("%d blank frames", blank)
	}
	if bad > 0 {
		t.Errorf("%d frames with debris", bad)
	}
	if !equal {
		t.Errorf("the client's screen is not the daemon's:\nclient:\n%s\ndaemon:\n%s", strings.Join(r.scr.Text(), "\n"), strings.Join(daemonText, "\n"))
	}
}
