package pane

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// The recording of a pane: its log (log.go) holds every byte it printed,
// already masked (redact.go), and the timeline below says when each part
// of it came and when the pane changed size. Together they replay the
// pane's output at its own pace into a fresh screen (pane.replay), and a
// span of them is a test fixture (pane.recording, `ravenry fixture`).
//
// The timeline is kept in memory and in <id>.log.time beside the log,
// so the recording of a pane that closed (its log is kept seven days)
// still has its timing. Each record is 24 bytes: kind, a pad byte, cols
// and rows (uint16), two pad bytes, the mark (uint64) and the time in
// unix milliseconds (int64), little-endian.

// Timeline record kinds.
const (
	recStart  = 'h' // the pane started: its size, at mark 0
	recOutput = 'o' // output from Mark on arrived at At
	recResize = 'r' // the pane's size became Cols x Rows at Mark
	recLog    = 'l' // the log rotated: <id>.log starts at Mark now
	recEnd    = 'e' // the pane closed with its output ending at Mark
)

const (
	recSize = 24
	// recGather: output within this long of the last output record
	// joins it, so a flood or a stream of keystrokes' echoes does not
	// make a record per read.
	recGather = 10 * time.Millisecond
	// maxRecords caps a timeline; past it the oldest half is dropped
	// (that span keeps its bytes but loses its timing).
	maxRecords = 32768
)

type timeRec struct {
	Kind       byte
	Cols, Rows int
	Mark       uint64
	At         time.Time
}

func (r timeRec) encode(b []byte) {
	clear(b[:recSize])
	b[0] = r.Kind
	binary.LittleEndian.PutUint16(b[2:], uint16(r.Cols))
	binary.LittleEndian.PutUint16(b[4:], uint16(r.Rows))
	binary.LittleEndian.PutUint64(b[8:], r.Mark)
	binary.LittleEndian.PutUint64(b[16:], uint64(r.At.UnixMilli()))
}

func decodeRec(b []byte) timeRec {
	return timeRec{
		Kind: b[0], Cols: int(binary.LittleEndian.Uint16(b[2:])), Rows: int(binary.LittleEndian.Uint16(b[4:])),
		Mark: binary.LittleEndian.Uint64(b[8:]), At: time.UnixMilli(int64(binary.LittleEndian.Uint64(b[16:]))),
	}
}

// timeline is not safe for concurrent use; the pane's lock guards it.
type timeline struct {
	path    string
	recs    []timeRec
	f       *os.File
	w       *bufio.Writer
	lastOut time.Time
	buf     [recSize]byte
}

func openTimeline(path string, cols, rows int, at time.Time) *timeline {
	t := &timeline{path: path}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err == nil {
		t.f, t.w = f, bufio.NewWriterSize(f, 4<<10)
	}
	t.add(timeRec{Kind: recStart, Cols: cols, Rows: rows, At: at})
	return t
}

func (t *timeline) add(r timeRec) {
	t.recs = append(t.recs, r)
	if len(t.recs) > maxRecords {
		keep := t.recs[:0:0]
		// The start record says the first size; keep it.
		keep = append(keep, t.recs[0])
		keep = append(keep, t.recs[len(t.recs)/2:]...)
		t.recs = keep
		t.rewrite()
		return
	}
	if t.w != nil {
		r.encode(t.buf[:])
		t.w.Write(t.buf[:])
	}
}

func (t *timeline) rewrite() {
	if t.f == nil {
		return
	}
	t.w.Flush()
	t.f.Truncate(0)
	t.f.Seek(0, io.SeekStart)
	t.w.Reset(t.f)
	for _, r := range t.recs {
		r.encode(t.buf[:])
		t.w.Write(t.buf[:])
	}
}

// output notes output starting at mark, now.
func (t *timeline) output(mark uint64, now time.Time) {
	if !t.lastOut.IsZero() && now.Sub(t.lastOut) < recGather {
		return
	}
	t.lastOut = now
	t.add(timeRec{Kind: recOutput, Mark: mark, At: now})
}

func (t *timeline) resize(mark uint64, cols, rows int, now time.Time) {
	t.add(timeRec{Kind: recResize, Mark: mark, Cols: cols, Rows: rows, At: now})
	t.lastOut = time.Time{}
}

func (t *timeline) rotated(start uint64, now time.Time) {
	t.add(timeRec{Kind: recLog, Mark: start, At: now})
}

func (t *timeline) flush() {
	if t.w != nil {
		t.w.Flush()
	}
}

func (t *timeline) close(end uint64, remove bool) {
	if t.w != nil {
		t.add(timeRec{Kind: recEnd, Mark: end, At: time.Now()})
		t.w.Flush()
		t.f.Close()
		t.w, t.f = nil, nil
	}
	if remove {
		os.Remove(t.path)
	}
}

// Recording is a span of a pane's output with its timing.
type Recording struct {
	Pane    string
	Command []string
	Started time.Time
	// Cols and Rows are the pane's size at From.
	Cols, Rows int
	From, To   uint64
	// Truncated: the log no longer held the start asked for.
	Truncated bool
	Events    []RecEvent
}

// RecEvent is output (Data) or a size change (Cols, Rows), At after the
// start of the span.
type RecEvent struct {
	At         time.Duration
	Data       []byte
	Cols, Rows int
}

// RecordingSpan says which part of the output a recording covers: from
// and to are marks (to 0: the end), or Last the latest stretch of time.
type RecordingSpan struct {
	From, To uint64
	HasFrom  bool
	Last     time.Duration
	// Limit caps the bytes; zero means 8 MiB.
	Limit int
}

const maxRecording = 8 << 20

// Recording returns a span of the pane's output and its timing.
func (p *Pane) Recording(sp RecordingSpan) (*Recording, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil, ErrClosed
	}
	if err := p.log.flush(); err != nil {
		return nil, err
	}
	recs := append([]timeRec(nil), p.times.recs...)
	rec := &Recording{Pane: p.id, Command: p.cfg.Command, Started: p.created}
	read := func(from uint64, n int) ([]byte, uint64, error) { return p.log.read(from, n) }
	return buildRecording(rec, recs, p.log.oldest(), p.offset, sp, read)
}

// ClosedRecording reads the recording of a pane that is gone but whose
// log is kept (a pane that was not hidden, for seven days).
func ClosedRecording(dir, id string, sp RecordingSpan) (*Recording, error) {
	if !validID(id) {
		return nil, ErrNotFound
	}
	base := filepath.Join(dir, id+".log")
	tb, err := os.ReadFile(base + ".time")
	if err != nil {
		return nil, ErrNotFound
	}
	var recs []timeRec
	for i := 0; i+recSize <= len(tb); i += recSize {
		recs = append(recs, decodeRec(tb[i:i+recSize]))
	}
	if len(recs) == 0 {
		return nil, ErrNotFound
	}
	// Where <id>.log and <id>.log.1 start, from the rotations.
	var starts []uint64
	end := uint64(0)
	for _, r := range recs {
		switch r.Kind {
		case recLog:
			starts = append(starts, r.Mark)
		case recEnd:
			end = r.Mark
		}
	}
	cur, prev, hasPrev := uint64(0), uint64(0), false
	if n := len(starts); n > 0 {
		cur = starts[n-1]
		hasPrev = true
		if n > 1 {
			prev = starts[n-2]
		}
	}
	curSize := int64(0)
	if fi, err := os.Stat(base); err == nil {
		curSize = fi.Size()
	}
	if end == 0 || end < cur+uint64(curSize) {
		end = cur + uint64(curSize)
	}
	oldest := cur
	if hasPrev {
		if _, err := os.Stat(base + ".1"); err == nil {
			oldest = prev
		}
	}
	read := func(from uint64, n int) ([]byte, uint64, error) {
		from = max(from, oldest)
		if from >= end || n <= 0 {
			return nil, min(from, end), nil
		}
		want := min(end-from, uint64(n))
		out := make([]byte, 0, want)
		pos := from
		if pos < cur {
			take := min(cur-pos, want)
			b, err := readAt(base+".1", int64(pos-oldest), int(take))
			if err != nil {
				return nil, 0, err
			}
			out = append(out, b...)
			pos += take
		}
		if rest := int(want) - len(out); rest > 0 {
			b, err := readAt(base, int64(pos-cur), rest)
			if err != nil {
				return nil, 0, err
			}
			out = append(out, b...)
		}
		return out, from, nil
	}
	rec := &Recording{Pane: id, Started: recs[0].At}
	return buildRecording(rec, recs, oldest, end, sp, read)
}

func validID(id string) bool {
	if len(id) != 8 || id[0] != 'p' {
		return false
	}
	for _, c := range id[1:] {
		if !(c >= 'a' && c <= 'z' || c >= '2' && c <= '7') {
			return false
		}
	}
	return true
}

// buildRecording cuts the span out of the log and pairs its bytes with
// the timeline: each output record's bytes run to the next record.
func buildRecording(rec *Recording, recs []timeRec, oldest, end uint64, sp RecordingSpan, read func(uint64, int) ([]byte, uint64, error)) (*Recording, error) {
	limit := sp.Limit
	if limit <= 0 || limit > maxRecording {
		limit = maxRecording
	}
	from, to := uint64(0), end
	if sp.HasFrom {
		from = sp.From
	}
	if sp.To > 0 {
		to = min(sp.To, end)
	}
	if sp.Last > 0 && len(recs) > 0 {
		// The latest stretch before now, or before the pane closed.
		ref := time.Now()
		if last := recs[len(recs)-1]; last.Kind == recEnd {
			ref = last.At
		}
		cutoff := ref.Add(-sp.Last)
		from = end
		for _, r := range recs {
			if r.Kind == recOutput && !r.At.Before(cutoff) {
				from = r.Mark
				break
			}
		}
	}
	if from > to {
		return nil, errors.New("from is after to")
	}
	if from < oldest {
		rec.Truncated = true
		from = oldest
	}
	if to-from > uint64(limit) {
		// Keep the end: the latest output is what a fixture is cut for.
		from = to - uint64(limit)
		rec.Truncated = true
	}
	data, got, err := read(from, int(to-from))
	if err != nil {
		return nil, fmt.Errorf("log: %w", err)
	}
	if got > from {
		rec.Truncated = true
		from = got
	}
	to = from + uint64(len(data))
	rec.From, rec.To = from, to
	// The size at from, and the time the span starts.
	for _, r := range recs {
		if (r.Kind == recStart || r.Kind == recResize) && r.Mark <= from {
			rec.Cols, rec.Rows = r.Cols, r.Rows
		}
	}
	if rec.Cols == 0 {
		rec.Cols, rec.Rows = defaultCols, defaultRows
	}
	var t0 time.Time
	type point struct {
		mark uint64
		at   time.Time
		cols int
		rows int
	}
	var pts []point
	for _, r := range recs {
		switch r.Kind {
		case recOutput:
			pts = append(pts, point{mark: r.Mark, at: r.At})
		case recResize:
			if r.Mark > from && r.Mark <= to {
				pts = append(pts, point{mark: r.Mark, at: r.At, cols: r.Cols, rows: r.Rows})
			}
		}
	}
	// The time of from: the last output record at or before it.
	for _, pt := range pts {
		if pt.cols == 0 && pt.mark <= from {
			t0 = pt.at
		}
	}
	if t0.IsZero() && len(pts) > 0 {
		t0 = pts[0].at
	}
	pos := from
	at := func(t time.Time) time.Duration {
		if t.Before(t0) || t0.IsZero() {
			return 0
		}
		return t.Sub(t0)
	}
	emit := func(upto uint64, when time.Time) {
		if upto > to {
			upto = to
		}
		if upto <= pos {
			return
		}
		rec.Events = append(rec.Events, RecEvent{At: at(when), Data: data[pos-from : upto-from]})
		pos = upto
	}
	cur := t0
	for _, pt := range pts {
		if pt.mark < from {
			continue
		}
		if pt.mark > to {
			break
		}
		emit(pt.mark, cur)
		if pt.cols > 0 {
			rec.Events = append(rec.Events, RecEvent{At: at(pt.at), Cols: pt.cols, Rows: pt.rows})
			continue
		}
		cur = pt.at
	}
	emit(to, cur)
	return rec, nil
}
