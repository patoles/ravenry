package server

import (
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
)

// TestRenderDragBusy drags the size of a pane the way a person drags a
// window's edge (a step every 8 ms, as a 120 Hz display gives them), over
// a pane like a working Claude tab: 8000 rows of coloured scrollback that
// reflow at each width, and a line redrawn 10 times a second. Each step
// must be drawn: most steps get a frame at their size, the median well
// within a frame (16 ms), and frames keep coming through the drag. The
// resize hold used to start again at every step for a program that is
// not a shell at a prompt, and such a pane got a frame only when the
// hold's 500 ms cap ran out (2 to 6 frames a second through a drag,
// 2026-11-10).
func TestRenderDragBusy(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	d := startDaemon(t)
	c := d.dial(client.Options{Name: "ravenry-desktop"})
	var hist strings.Builder
	words := strings.Fields("the quick brown fox jumps over the lazy dog while the build runs and the tests pass one by one")
	for i := 0; i < 8000; i++ {
		fmt.Fprintf(&hist, "\x1b[38;5;%dm%5d\x1b[0m ", 1+i%200, i)
		for j := 0; j < 8+i%24; j++ {
			hist.WriteString(words[(i+j)%len(words)] + " ")
		}
		hist.WriteString("\r\n")
	}
	file := filepath.Join(d.home, "history.ans")
	if err := os.WriteFile(file, []byte(hist.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c",
		`cat "$1"; i=0; while :; do printf '\r\033[J\033[38;2;215;119;87m* Working (%d)\033[0m\r' $i; i=$((i+1)); sleep 0.1; done`,
		"sh", file}})
	wide, high := 150, 40
	st, err := c.Render(ctx(t), p.ID, client.RenderOptions{Cols: wide, Rows: high, FPS: 120, Window: 2})
	if err != nil {
		t.Fatal(err)
	}
	type rec struct {
		at         time.Time
		cols, rows int
		history    int
	}
	frames := make(chan rec, 4096)
	go func() {
		for f := range st.Frames {
			if len(f.Data) < 30 {
				continue
			}
			b := f.Data
			frames <- rec{time.Now(), int(binary.BigEndian.Uint16(b[6:])), int(binary.BigEndian.Uint16(b[8:])), int(binary.BigEndian.Uint32(b[10:]))}
			st.AckFrame(ctx(t), binary.BigEndian.Uint32(b[2:]))
		}
	}()
	// The scrollback is in, and the line is redrawn.
	deadline := time.Now().Add(15 * time.Second)
	for loaded := false; !loaded; {
		select {
		case f := <-frames:
			loaded = f.history >= 7500
		case <-time.After(time.Until(deadline)):
			t.Fatal("the scrollback never came in")
		}
	}
	time.Sleep(300 * time.Millisecond)
	for len(frames) > 0 {
		<-frames
	}

	// 120 steps at 120 Hz: 38 columns and 12 rows narrower, and back.
	type step struct {
		at         time.Time
		cols, rows int
	}
	var steps []step
	t0 := time.Now()
	for i := 0; i < 120; i++ {
		time.Sleep(time.Until(t0.Add(time.Duration(i) * time.Second / 120)))
		k := i + 1
		if i >= 60 {
			k = 119 - i
		}
		cols, rows := wide-38*k/60, high-12*k/60
		if n := len(steps); n > 0 && steps[n-1].cols == cols && steps[n-1].rows == rows {
			continue
		}
		b := fmt.Sprintf(`{"v":%d,"type":"pane.resize","id":%d,"pane":%q,"cols":%d,"rows":%d}`, proto.Version, 1_000_000+i, p.ID, cols, rows)
		at := time.Now()
		if err := c.WriteRaw(ctx(t), []byte(b)); err != nil {
			t.Fatal(err)
		}
		steps = append(steps, step{at, cols, rows})
	}
	end := time.Now()
	time.Sleep(500 * time.Millisecond)
	var got []rec
	for len(frames) > 0 {
		got = append(got, <-frames)
	}

	// Each step's first frame at its size, before the next step's frame.
	var lat []time.Duration
	for i, s := range steps {
		for _, f := range got {
			if f.at.Before(s.at) {
				continue
			}
			if i+1 < len(steps) && f.at.After(steps[i+1].at.Add(50*time.Millisecond)) {
				break
			}
			if f.cols == s.cols && f.rows == s.rows {
				lat = append(lat, f.at.Sub(s.at))
				break
			}
		}
	}
	var gap time.Duration
	prev := steps[0].at
	for _, f := range got {
		if f.at.After(end) {
			break
		}
		if f.at.After(prev) {
			gap = max(gap, f.at.Sub(prev))
			prev = f.at
		}
	}
	gap = max(gap, end.Sub(prev))
	sort.Slice(lat, func(i, j int) bool { return lat[i] < lat[j] })
	med := time.Duration(-1)
	if len(lat) > 0 {
		med = lat[len(lat)/2]
	}
	t.Logf("%d steps in %v, %d drawn at their size, median %v, longest without a frame %v, %d frames",
		len(steps), end.Sub(steps[0].at).Round(time.Millisecond), len(lat), med, gap.Round(time.Millisecond), len(got))
	if len(lat) < len(steps)*3/4 {
		t.Errorf("%d of %d steps drawn at their size, want at least 3 in 4", len(lat), len(steps))
	}
	if med > 16*time.Millisecond {
		t.Errorf("a step drawn at its size %v after it (median), want within a frame (16 ms)", med)
	}
	if gap > 100*time.Millisecond {
		t.Errorf("%v without a frame during the drag, want under 100 ms", gap)
	}
	// The last size is shown.
	if last := steps[len(steps)-1]; len(got) == 0 || got[len(got)-1].cols != last.cols || got[len(got)-1].rows != last.rows {
		t.Errorf("the last frame is not at the last size %dx%d", last.cols, last.rows)
	}
}
