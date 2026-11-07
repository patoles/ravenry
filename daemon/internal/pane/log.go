package pane

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
)

// paneLog keeps what a pane printed in a file, capped in size. It writes
// to <dir>/<id>.log; when that file reaches half the cap it becomes
// <id>.log.1 (replacing the older one) and a new <id>.log starts. So the
// log holds between half the cap and the whole cap of the latest output,
// and a byte's position in the pane's output (its mark) maps to a file
// and an offset.
//
// paneLog is not safe for concurrent use; the pane's lock guards it.
type paneLog struct {
	path      string
	cap       int64
	f         *os.File
	w         *bufio.Writer
	start     uint64 // mark of the first byte in <id>.log
	size      int64
	prevStart uint64 // mark of the first byte in <id>.log.1
	hasPrev   bool
	// onRotate is told where <id>.log starts after a rotation.
	onRotate func(start uint64)
}

func openLog(path string, capBytes int64) (*paneLog, error) {
	if capBytes < 2 {
		capBytes = 2
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("log: %w", err)
	}
	os.Remove(path + ".1")
	return &paneLog{path: path, cap: capBytes, f: f, w: bufio.NewWriterSize(f, 64<<10)}, nil
}

func (l *paneLog) write(p []byte) error {
	for len(p) > 0 {
		room := l.cap/2 - l.size
		if room <= 0 {
			if err := l.rotate(); err != nil {
				return err
			}
			continue
		}
		n := int64(len(p))
		if n > room {
			n = room
		}
		if _, err := l.w.Write(p[:n]); err != nil {
			return fmt.Errorf("log: %w", err)
		}
		l.size += n
		p = p[n:]
	}
	return nil
}

func (l *paneLog) rotate() error {
	if err := l.w.Flush(); err != nil {
		return fmt.Errorf("log: %w", err)
	}
	l.f.Close()
	if err := os.Rename(l.path, l.path+".1"); err != nil {
		return fmt.Errorf("log: %w", err)
	}
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_TRUNC|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("log: %w", err)
	}
	l.prevStart, l.hasPrev = l.start, true
	l.start += uint64(l.size)
	l.f, l.size = f, 0
	l.w.Reset(f)
	if l.onRotate != nil {
		l.onRotate(l.start)
	}
	return nil
}

func (l *paneLog) flush() error {
	if err := l.w.Flush(); err != nil {
		return fmt.Errorf("log: %w", err)
	}
	return nil
}

// oldest is the mark of the oldest byte the log still holds.
func (l *paneLog) oldest() uint64 {
	if l.hasPrev {
		return l.prevStart
	}
	return l.start
}

// end is the mark just after the newest byte.
func (l *paneLog) end() uint64 { return l.start + uint64(l.size) }

// read returns up to limit bytes from mark on. When mark is older than
// what the log keeps, it starts at the oldest byte it has and reports
// from > mark.
func (l *paneLog) read(mark uint64, limit int) (data []byte, from uint64, err error) {
	if err := l.flush(); err != nil {
		return nil, 0, err
	}
	from = max(mark, l.oldest())
	end := l.end()
	if from >= end || limit <= 0 {
		return nil, min(from, end), nil
	}
	n := min(end-from, uint64(limit))
	data = make([]byte, 0, n)
	pos := from
	if l.hasPrev && pos < l.start {
		take := min(l.start-pos, n)
		b, err := readAt(l.path+".1", int64(pos-l.prevStart), int(take))
		if err != nil {
			return nil, 0, err
		}
		data = append(data, b...)
		pos += take
	}
	if rest := int(n) - len(data); rest > 0 {
		b, err := readAtFile(l.f, int64(pos-l.start), rest)
		if err != nil {
			return nil, 0, err
		}
		data = append(data, b...)
	}
	return data, from, nil
}

func readAt(path string, off int64, n int) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("log: %w", err)
	}
	defer f.Close()
	return readAtFile(f, off, n)
}

func readAtFile(f *os.File, off int64, n int) ([]byte, error) {
	b := make([]byte, n)
	got, err := f.ReadAt(b, off)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("log: %w", err)
	}
	return b[:got], nil
}

func (l *paneLog) close(remove bool) {
	l.w.Flush()
	l.f.Close()
	if remove {
		os.Remove(l.path)
		os.Remove(l.path + ".1")
	}
}
