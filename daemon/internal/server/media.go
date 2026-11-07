package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"ravenryd/internal/agent"
	"ravenryd/internal/pane"
	"ravenryd/internal/proto"
	"ravenryd/internal/render"
	"ravenryd/internal/vt"
)

// What a pane touched, what it looks like, what it printed and when, and
// how it behaves under test conditions (PROTOCOL.md section 4, Files
// touched, Pictures, Recordings and replay, Test conditions).

const (
	defaultFramesLast = 10 * time.Second
	defaultMaxFrames  = 100
	maxFrames         = 600
	maxShotCells      = 1000 * 400
	maxReplayEvents   = 1 << 20
	maxReplayBytes    = 8 << 20
	maxSpeed          = 1000
	replayFrameGap    = 50 * time.Millisecond
	maxReplayFrames   = 300
	maxToolFiles      = 64
	// mediaBudget keeps a result under the 16 MiB a message may be.
	mediaBudget = 12 << 20
)

// ------------------------------------------------------------ files touched

// noteFiles records the files an assistant's PostToolUse hook named
// (agent.HookData keeps only their paths) against the report's pane.
func (s *Server) noteFiles(r agent.Report) {
	if r.Pane == "" || len(r.Data) == 0 {
		return
	}
	var d struct {
		Files []string `json:"tool_files"`
		Tool  string   `json:"tool_name"`
		Cwd   string   `json:"cwd"`
	}
	if json.Unmarshal(r.Data, &d) != nil || len(d.Files) == 0 {
		return
	}
	base := firstNonEmpty(d.Cwd, r.Cwd)
	now := stamp(r.At)
	s.drive.mu.Lock()
	defer s.drive.mu.Unlock()
	m := s.drive.metaLocked(r.Pane)
	if m.files == nil {
		m.files = map[string]*proto.FileTouch{}
	}
	for _, f := range d.Files {
		if !filepath.IsAbs(f) && base != "" {
			f = filepath.Join(base, f)
		}
		f = filepath.Clean(f)
		ft := m.files[f]
		if ft == nil {
			if len(m.files) >= maxFilesPerPane {
				continue
			}
			ft = &proto.FileTouch{Path: f, Sources: []string{"hook"}}
			m.files[f] = ft
		}
		ft.Count++
		ft.At = now
		ft.Tool = d.Tool
	}
}

func (c *conn) paneFiles(id uint64, data []byte) {
	var r proto.FilesRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	p, err := c.pane(r.Pane)
	if err != nil {
		c.failErr(id, err)
		return
	}
	c.track(id, func(ctx context.Context) {
		byPath := map[string]*proto.FileTouch{}
		c.s.drive.mu.Lock()
		if m := c.s.drive.meta[r.Pane]; m != nil {
			for k, v := range m.files {
				cp := *v
				cp.Sources = append([]string(nil), v.Sources...)
				byPath[k] = &cp
			}
		}
		c.s.drive.mu.Unlock()
		res := proto.FilesResult{Pane: r.Pane, Files: []proto.FileTouch{}}
		if !r.NoGit {
			root, changes, partial, err := pane.GitChanges(ctx, p.Info().Cwd)
			if err == nil {
				res.GitRoot, res.Partial = root, partial
				for _, ch := range changes {
					ft := byPath[ch.Path]
					if ft == nil {
						ft = &proto.FileTouch{Path: ch.Path}
						byPath[ch.Path] = ft
					}
					ft.Sources = append(ft.Sources, "git")
					ft.Status = ch.Status
				}
			}
		}
		for _, ft := range byPath {
			res.Files = append(res.Files, *ft)
		}
		// The hook's first, newest first; then git's by path.
		sort.Slice(res.Files, func(i, j int) bool {
			a, b := res.Files[i], res.Files[j]
			if (a.At != "") != (b.At != "") {
				return a.At != ""
			}
			if a.At != b.At {
				return a.At > b.At
			}
			return a.Path < b.Path
		})
		c.reply(id, "pane.files", res)
	})
}

// ------------------------------------------------------------ pictures

func renderOptions(fontSize *float64) (render.Options, error) {
	o := render.Options{Cursor: true}
	if fontSize != nil {
		if *fontSize < 6 || *fontSize > 48 {
			return o, bad("font_size must be between 6 and 48")
		}
		o.FontSize = *fontSize
	}
	return o, nil
}

func (c *conn) paneShot(id uint64, data []byte) {
	var r proto.ShotRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	p, err := c.pane(r.Pane)
	if err != nil {
		c.failErr(id, err)
		return
	}
	o, err := renderOptions(r.FontSize)
	if err != nil {
		c.failErr(id, err)
		return
	}
	if r.Cursor != nil {
		o.Cursor = *r.Cursor
	}
	var g *vt.Grid
	var mark uint64
	switch {
	case r.Cols != nil || r.Rows != nil:
		if r.Cols == nil || r.Rows == nil || *r.Cols < 1 || *r.Rows < 1 || *r.Cols > 4096 || *r.Rows > 4096 || *r.Cols**r.Rows > maxShotCells {
			c.failErr(id, bad("cols and rows go together, each between 1 and 4096, at most %d cells", maxShotCells))
			return
		}
		g, mark, err = p.GridAt(*r.Cols, *r.Rows)
	default:
		g, mark, err = p.Grid()
	}
	if err != nil {
		c.failErr(id, err)
		return
	}
	b, err := render.PNG(g, o)
	if err != nil {
		c.failErr(id, err)
		return
	}
	cw, ch := render.CellSize(o)
	img := render.Image(g, o).Bounds()
	_ = cw
	_ = ch
	c.reply(id, "pane.shot", proto.ShotResult{
		Pane: r.Pane, Mark: mark, Cols: g.Cols, Rows: g.Rows, Width: img.Dx(), Height: img.Dy(),
		PNG: base64.StdEncoding.EncodeToString(b),
	})
}

// strip turns frames into the format asked: each a PNG, or one animated
// GIF or APNG. Delays follow the frames' times divided by speed.
func strip(frames []render.Frame, at []time.Time, marks []uint64, format string, o render.Options) (proto.FramesResult, error) {
	res := proto.FramesResult{Format: format, Frames: []proto.FilmFrame{}}
	if len(frames) == 0 {
		return res, errors.New("no frames")
	}
	img := render.Image(frames[0].Grid, o).Bounds()
	res.Width, res.Height = img.Dx(), img.Dy()
	res.From, res.To = stamp(at[0]), stamp(at[len(at)-1])
	total := 0
	for i, f := range frames {
		fi := proto.FilmFrame{At: stamp(at[i]), Mark: marks[i]}
		if format == "png" {
			b, err := render.PNG(f.Grid, o)
			if err != nil {
				return res, err
			}
			total += len(b) * 4 / 3
			if total > mediaBudget {
				return res, fmt.Errorf("these frames are over %d MiB as PNGs: ask for fewer (max_frames) or a gif", mediaBudget>>20)
			}
			fi.PNG = base64.StdEncoding.EncodeToString(b)
		}
		res.Frames = append(res.Frames, fi)
	}
	var b []byte
	var err error
	switch format {
	case "gif":
		b, err = render.GIF(frames, o)
	case "apng":
		b, err = render.APNG(frames, o)
	default:
		return res, nil
	}
	if err != nil {
		return res, err
	}
	if len(b)*4/3 > mediaBudget {
		return res, fmt.Errorf("this filmstrip is over %d MiB: ask for fewer frames (max_frames) or a shorter stretch", mediaBudget>>20)
	}
	res.Data = base64.StdEncoding.EncodeToString(b)
	return res, nil
}

func checkFormat(f string) (string, error) {
	switch f {
	case "":
		return "gif", nil
	case "png", "gif", "apng":
		return f, nil
	}
	return "", bad("format is png, gif or apng")
}

func (c *conn) paneFrames(id uint64, data []byte) {
	var r proto.FramesRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	p, err := c.pane(r.Pane)
	if err != nil {
		c.failErr(id, err)
		return
	}
	format, err := checkFormat(r.Format)
	if err != nil {
		c.failErr(id, err)
		return
	}
	last := defaultFramesLast
	if r.LastMs != nil {
		if *r.LastMs < 1 || *r.LastMs > 3600000 {
			c.failErr(id, bad("last_ms must be between 1 and 3600000"))
			return
		}
		last = time.Duration(*r.LastMs) * time.Millisecond
	}
	limit := defaultMaxFrames
	if r.MaxFrames != nil {
		if *r.MaxFrames < 1 || *r.MaxFrames > maxFrames {
			c.failErr(id, bad("max_frames must be between 1 and %d", maxFrames))
			return
		}
		limit = *r.MaxFrames
	}
	o, err := renderOptions(r.FontSize)
	if err != nil {
		c.failErr(id, err)
		return
	}
	c.track(id, func(context.Context) {
		fs, err := p.Frames(last)
		if err != nil {
			c.failErr(id, err)
			return
		}
		skipped := 0
		if len(fs) > limit {
			// Evenly through the stretch, the last one kept.
			keep := make([]pane.ScreenFrame, 0, limit)
			for i := 0; i < limit; i++ {
				keep = append(keep, fs[i*(len(fs)-1)/max(limit-1, 1)])
			}
			skipped = len(fs) - len(keep)
			fs = keep
		}
		frames := make([]render.Frame, len(fs))
		at := make([]time.Time, len(fs))
		marks := make([]uint64, len(fs))
		for i, f := range fs {
			frames[i] = render.Frame{Grid: f.Grid, Delay: time.Second}
			if i+1 < len(fs) {
				frames[i].Delay = fs[i+1].At.Sub(f.At)
			}
			at[i], marks[i] = f.At, f.Mark
		}
		res, err := strip(frames, at, marks, format, o)
		if err != nil {
			c.failErr(id, err)
			return
		}
		res.Pane, res.Skipped = r.Pane, skipped
		c.reply(id, "pane.frames", res)
	})
}

// ------------------------------------------------------------ recordings

func fixtureOf(rec *pane.Recording) proto.Fixture {
	f := proto.Fixture{
		Format: "ravenry.fixture", Version: 1, Pane: rec.Pane, Command: rec.Command,
		Cols: rec.Cols, Rows: rec.Rows, StartedAt: stamp(rec.Started), From: rec.From, To: rec.To,
		Events: make([]proto.FixtureEvent, 0, len(rec.Events)),
	}
	for _, e := range rec.Events {
		fe := proto.FixtureEvent{T: e.At.Milliseconds(), Cols: e.Cols, Rows: e.Rows}
		if len(e.Data) > 0 {
			fe.Data = base64.StdEncoding.EncodeToString(e.Data)
		}
		f.Events = append(f.Events, fe)
	}
	return f
}

func (c *conn) paneRecording(id uint64, data []byte) {
	var r proto.RecordingRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	if r.Pane == "" {
		c.failErr(id, bad("pane is required"))
		return
	}
	sp := pane.RecordingSpan{}
	if r.From != nil {
		sp.From, sp.HasFrom = *r.From, true
	}
	if r.To != nil {
		sp.To = *r.To
	}
	if r.LastMs != nil {
		if *r.LastMs < 1 || r.From != nil || r.To != nil {
			c.failErr(id, bad("last_ms is at least 1, and goes without from and to"))
			return
		}
		sp.Last = time.Duration(*r.LastMs) * time.Millisecond
	}
	if r.Limit != nil {
		if *r.Limit < 1 || *r.Limit > maxReplayBytes {
			c.failErr(id, bad("limit must be between 1 and %d", maxReplayBytes))
			return
		}
		sp.Limit = *r.Limit
	}
	var rec *pane.Recording
	p, err := c.s.o.Manager.Get(r.Pane)
	switch {
	case err == nil:
		rec, err = p.Recording(sp)
	case errors.Is(err, pane.ErrNotFound):
		rec, err = c.s.o.Manager.ClosedRecording(r.Pane, sp)
	}
	if err != nil {
		if errors.Is(err, pane.ErrNotFound) {
			err = notFound("no pane %s, and no kept log of one", r.Pane)
		}
		c.failErr(id, err)
		return
	}
	f := fixtureOf(rec)
	if p != nil {
		if info := p.Info(); info.Overrides == nil || info.Overrides.Term == "" {
			f.Term = "xterm-256color"
		} else {
			f.Term = info.Overrides.Term
		}
	}
	c.reply(id, "pane.recording", proto.RecordingResult{Fixture: f, Truncated: rec.Truncated})
}

var termName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`)

// replayEvent is a fixture event decoded.
type replayEvent struct {
	at         time.Duration
	data       []byte
	cols, rows int
}

func checkFixture(f *proto.Fixture) ([]replayEvent, error) {
	if f == nil {
		return nil, bad("fixture is required")
	}
	if f.Format != "ravenry.fixture" || f.Version != 1 {
		return nil, bad("fixture is a ravenry.fixture of version 1")
	}
	if f.Cols < 1 || f.Rows < 1 || f.Cols > 4096 || f.Rows > 4096 {
		return nil, bad("fixture cols and rows must be between 1 and 4096")
	}
	if len(f.Events) > maxReplayEvents {
		return nil, bad("a fixture has at most %d events", maxReplayEvents)
	}
	out := make([]replayEvent, 0, len(f.Events))
	total := 0
	var last int64
	for i, e := range f.Events {
		if e.T < last || e.T < 0 {
			return nil, bad("fixture event %d: t goes forward, in milliseconds", i)
		}
		last = e.T
		ev := replayEvent{at: time.Duration(e.T) * time.Millisecond}
		switch {
		case e.Data != "" && (e.Cols != 0 || e.Rows != 0):
			return nil, bad("fixture event %d: data or a size, not both", i)
		case e.Data != "":
			b, err := base64.StdEncoding.DecodeString(e.Data)
			if err != nil {
				return nil, bad("fixture event %d: data is base64: %v", i, err)
			}
			total += len(b)
			ev.data = b
		case e.Cols >= 1 && e.Rows >= 1 && e.Cols <= 4096 && e.Rows <= 4096:
			ev.cols, ev.rows = e.Cols, e.Rows
		default:
			return nil, bad("fixture event %d: data, or cols and rows between 1 and 4096", i)
		}
		out = append(out, ev)
	}
	if total > maxReplayBytes {
		return nil, bad("a fixture holds at most %d bytes", maxReplayBytes)
	}
	return out, nil
}

func (c *conn) paneReplay(id uint64, data []byte) {
	var r proto.ReplayRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	evs, err := checkFixture(r.Fixture)
	if err != nil {
		c.failErr(id, err)
		return
	}
	speed := 1.0
	if r.Speed != nil {
		if *r.Speed < 0 || *r.Speed > maxSpeed {
			c.failErr(id, bad("speed is 0 (as fast as it goes) to %d", maxSpeed))
			return
		}
		speed = *r.Speed
	}
	cols, rows := r.Fixture.Cols, r.Fixture.Rows
	fixed := false
	if r.Cols != nil || r.Rows != nil {
		if r.Cols == nil || r.Rows == nil || *r.Cols < 1 || *r.Rows < 1 || *r.Cols > 4096 || *r.Rows > 4096 {
			c.failErr(id, bad("cols and rows go together, each between 1 and 4096"))
			return
		}
		cols, rows, fixed = *r.Cols, *r.Rows, true
	}
	slow := 0
	if r.SlowBps != nil {
		if *r.SlowBps < 1 || *r.SlowBps > 1<<30 {
			c.failErr(id, bad("slow_bps must be between 1 and %d", 1<<30))
			return
		}
		slow = *r.SlowBps
	}
	if r.Term != "" && !termName.MatchString(r.Term) {
		c.failErr(id, bad("term is a terminal name such as xterm-256color or dumb"))
		return
	}
	if err := checkName(r.Name); err != nil {
		c.failErr(id, err)
		return
	}
	if !r.Headless && (r.Shot || r.Frames != "" || r.FontSize != nil) {
		c.failErr(id, bad("shot, frames and font_size are for a headless replay"))
		return
	}
	o, err := renderOptions(r.FontSize)
	if err != nil {
		c.failErr(id, err)
		return
	}
	format := ""
	if r.Frames != "" {
		if format, err = checkFormat(r.Frames); err != nil {
			c.failErr(id, err)
			return
		}
	}
	if r.Headless {
		c.track(id, func(context.Context) {
			res, err := headlessReplay(evs, cols, rows, fixed, speed, slow, r.Shot, format, o)
			if err != nil {
				c.failErr(id, err)
				return
			}
			c.reply(id, "pane.replay", res)
		})
		return
	}
	// Into a fresh pane: a placeholder program holds its terminal, and
	// the recording is played into the pane as its output.
	name := r.Name
	if name == "" {
		name = "Replay"
		if r.Fixture.Pane != "" {
			name = "Replay of " + r.Fixture.Pane
		}
	}
	src := r.Fixture.Pane
	if src == "" {
		src = "fixture"
	}
	env := map[string]string{"RAVENRY_SHELL_INTEGRATION": "0"}
	if r.Term != "" {
		env["TERM"] = r.Term
	}
	w := c.who("")
	p, err := c.s.o.Manager.New(pane.Config{
		Command: []string{"/bin/sh", "-c", "stty -echo 2>/dev/null; exec sleep 2147483647"},
		Cwd:     "", Env: env, Cols: cols, Rows: rows, Name: name,
		Labels: map[string]string{"ravenry.replay": src},
	})
	if err != nil {
		c.failErr(id, err)
		return
	}
	c.s.setCreator(p.ID(), w.creator(), w.key)
	go playInto(p, evs, fixed, speed, slow)
	pi := c.s.paneInfo(p.Info())
	c.reply(id, "pane.replay", proto.ReplayResult{Pane: &pi})
}

// pace sleeps until the event's time at this speed (none at speed 0).
func pace(start time.Time, at time.Duration, speed float64) {
	if speed <= 0 {
		return
	}
	due := start.Add(time.Duration(float64(at) / speed))
	if d := time.Until(due); d > 0 {
		time.Sleep(d)
	}
}

// slowly hands data to put at bps bytes a second.
func slowly(data []byte, bps int, put func([]byte)) {
	if bps <= 0 {
		put(data)
		return
	}
	step := max(1, bps/20)
	for len(data) > 0 {
		n := min(step, len(data))
		put(data[:n])
		data = data[n:]
		time.Sleep(time.Duration(n) * time.Second / time.Duration(bps))
	}
}

func playInto(p *pane.Pane, evs []replayEvent, fixed bool, speed float64, slow int) {
	start := time.Now()
	for _, e := range evs {
		pace(start, e.at, speed)
		if e.cols > 0 {
			if !fixed {
				if p.Resize(e.cols, e.rows) != nil {
					return
				}
			}
			continue
		}
		slowly(e.data, slow, p.Inject)
	}
}

// headlessReplay plays a recording into a fresh screen of the daemon's,
// and says what it ended on: its text, and a picture or a filmstrip.
func headlessReplay(evs []replayEvent, cols, rows int, fixed bool, speed float64, slow int, shot bool, format string, o render.Options) (proto.ReplayResult, error) {
	s, err := vt.New(vt.Options{Cols: cols, Rows: rows, Scrollback: 2000})
	if err != nil {
		return proto.ReplayResult{}, err
	}
	defer s.Close()
	var frames []render.Frame
	var ats []time.Time
	var marks []uint64
	var mark uint64
	t0 := time.Unix(0, 0).UTC()
	timeScale := speed
	if timeScale <= 0 {
		timeScale = 1
	}
	lastFrame := time.Duration(-1)
	grab := func(at time.Duration, force bool) {
		if format == "" {
			return
		}
		at = time.Duration(float64(at) / timeScale)
		if !force && lastFrame >= 0 && at-lastFrame < replayFrameGap {
			return
		}
		g, err := s.Grid()
		if err != nil {
			return
		}
		if n := len(frames); n > 0 && lastFrame >= 0 && at-lastFrame < replayFrameGap {
			frames[n-1].Grid, marks[n-1] = g, mark // the later screen of the same instant
			return
		}
		frames = append(frames, render.Frame{Grid: g})
		ats = append(ats, t0.Add(at))
		marks = append(marks, mark)
		lastFrame = at
	}
	start := time.Now()
	for _, e := range evs {
		if speed > 0 && slow == 0 && format == "" {
			// Nothing watches a headless replay's pace: only frames and
			// a slow link change what it shows, so it runs at once.
		} else if speed > 0 && format == "" {
			pace(start, e.at, speed)
		}
		if e.cols > 0 {
			if !fixed {
				s.Resize(e.cols, e.rows)
			}
			grab(e.at, false)
			continue
		}
		if slow > 0 && format != "" {
			// A slow link draws the screen in steps: one frame a step.
			step := max(1, slow/20)
			at := e.at
			for b := e.data; len(b) > 0; {
				n := min(step, len(b))
				s.Write(b[:n])
				mark += uint64(n)
				b = b[n:]
				at += time.Duration(n) * time.Second / time.Duration(slow)
				grab(at, false)
			}
			continue
		}
		s.Write(e.data)
		mark += uint64(len(e.data))
		grab(e.at, false)
	}
	res := proto.ReplayResult{}
	cp, err := s.Capture(vt.CaptureOptions{Styles: true})
	if err != nil {
		return res, err
	}
	cr := proto.CaptureResult{
		Mark: mark, Cols: cp.Cols, Rows: cp.Rows,
		Cursor:    proto.Cursor{X: cp.Cursor.X, Y: cp.Cursor.Y, Visible: cp.Cursor.Visible},
		AltScreen: cp.Alt, Title: cp.Title, Lines: make([]proto.Line, len(cp.Lines)),
	}
	for i, l := range cp.Lines {
		cr.Lines[i].Text = l.Text
		cr.Lines[i].Spans = []proto.Span{}
		for _, sp := range l.Spans {
			cr.Lines[i].Spans = append(cr.Lines[i].Spans, span(sp))
		}
	}
	res.Capture = &cr
	if shot {
		g, err := s.Grid()
		if err != nil {
			return res, err
		}
		b, err := render.PNG(g, o)
		if err != nil {
			return res, err
		}
		res.PNG = base64.StdEncoding.EncodeToString(b)
	}
	if format != "" {
		g, err := s.Grid()
		if err == nil {
			end := time.Duration(0)
			if len(evs) > 0 {
				end = time.Duration(float64(evs[len(evs)-1].at) / timeScale)
			}
			if len(frames) == 0 || ats[len(ats)-1].Sub(t0) < end {
				frames = append(frames, render.Frame{Grid: g})
				ats = append(ats, t0.Add(end))
				marks = append(marks, mark)
			}
		}
		skipped := 0
		if len(frames) > maxReplayFrames {
			keep := maxReplayFrames
			kf, ka, km := make([]render.Frame, 0, keep), make([]time.Time, 0, keep), make([]uint64, 0, keep)
			for i := 0; i < keep; i++ {
				j := i * (len(frames) - 1) / (keep - 1)
				kf, ka, km = append(kf, frames[j]), append(ka, ats[j]), append(km, marks[j])
			}
			skipped = len(frames) - keep
			frames, ats, marks = kf, ka, km
		}
		for i := range frames {
			frames[i].Delay = time.Second
			if i+1 < len(frames) {
				frames[i].Delay = ats[i+1].Sub(ats[i])
			}
		}
		fr, err := strip(frames, ats, marks, format, o)
		if err != nil {
			return res, err
		}
		fr.Skipped = skipped
		res.Frames = &fr
	}
	return res, nil
}

// ------------------------------------------------------------ test conditions

func (c *conn) paneOverride(id uint64, data []byte) {
	var r proto.OverrideRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	p, err := c.pane(r.Pane)
	if err != nil {
		c.failErr(id, err)
		return
	}
	if r.Clear && (r.Cols != nil || r.Rows != nil || r.SlowBps != nil || r.Term != nil) {
		c.failErr(id, bad("clear takes nothing else (but restart)"))
		return
	}
	if !r.Clear && !r.Restart && r.Cols == nil && r.Rows == nil && r.SlowBps == nil && r.Term == nil {
		c.failErr(id, bad("give cols and rows, slow_bps, term, clear or restart"))
		return
	}
	o := pane.Overrides{}
	if cur := p.Info().Overrides; cur != nil && !r.Clear {
		o = *cur
	}
	if r.Cols != nil || r.Rows != nil {
		if r.Cols == nil || r.Rows == nil || *r.Cols < 0 || *r.Rows < 0 || *r.Cols > 4096 || *r.Rows > 4096 || (*r.Cols == 0) != (*r.Rows == 0) {
			c.failErr(id, bad("cols and rows go together, each between 1 and 4096 (both 0: the window's size again)"))
			return
		}
		o.Cols, o.Rows = *r.Cols, *r.Rows
	}
	if r.SlowBps != nil {
		if *r.SlowBps < 0 || *r.SlowBps > 1<<30 {
			c.failErr(id, bad("slow_bps must be between 0 (not slowed) and %d", 1<<30))
			return
		}
		o.SlowBps = *r.SlowBps
	}
	if r.Term != nil {
		if *r.Term != "" && !termName.MatchString(*r.Term) {
			c.failErr(id, bad("term is a terminal name such as xterm-256color, dumb or vt100 (empty: as it was)"))
			return
		}
		o.Term = *r.Term
	}
	if err := checkReason(r.Reason); err != nil {
		c.failErr(id, err)
		return
	}
	w := c.who("")
	w.reason = r.Reason
	c.track(id, func(ctx context.Context) {
		// Test conditions change what a program sees: whoever may drive
		// the pane may set them.
		preview := describeOverrides(o)
		if r.Restart {
			preview += ", then restart it"
		}
		if err := c.allowAction(ctx, p, w, preview, r.NoWait, actOverride); err != nil {
			c.failErr(id, err)
			return
		}
		if err := p.Override(o); err != nil {
			c.failErr(id, err)
			return
		}
		if !r.Restart {
			pi := c.s.paneInfo(p.Info())
			c.s.updatedEvent(pi)
			c.reply(id, "pane.override", proto.PaneResult{Pane: pi})
			return
		}
		np, err := c.s.restart(p.ID(), time.Second)
		if err != nil {
			c.failErr(id, err)
			return
		}
		c.reply(id, "pane.override", proto.PaneResult{Pane: c.s.paneInfo(np.Info())})
	})
}

func describeOverrides(o pane.Overrides) string {
	var parts []string
	if o.Cols > 0 {
		parts = append(parts, fmt.Sprintf("%dx%d", o.Cols, o.Rows))
	}
	if o.SlowBps > 0 {
		parts = append(parts, fmt.Sprintf("%d bytes a second", o.SlowBps))
	}
	if o.Term != "" {
		parts = append(parts, "TERM="+o.Term)
	}
	if len(parts) == 0 {
		return "none"
	}
	return strings.Join(parts, ", ")
}

// updatedEvent tells the subscribers a pane changed (pane.updated).
func (s *Server) updatedEvent(pi proto.Pane) {
	ev := proto.Event{V: proto.Version, Type: "event", Event: "pane.updated", Pane: &pi}
	for _, c := range s.connections(func(c *conn) bool { return c.unwatch != nil }) {
		c.event(ev)
	}
}

// restart restarts a pane and carries over who started it.
func (s *Server) restart(id string, grace time.Duration) (*pane.Pane, error) {
	s.drive.mu.Lock()
	m := s.drive.metaLocked(id)
	cr, key := m.creator, m.creatorKey
	s.drive.mu.Unlock()
	np, _, err := s.o.Manager.Restart(id, grace)
	if err != nil {
		return nil, err
	}
	s.setCreator(np.ID(), cr, key)
	return np, nil
}
