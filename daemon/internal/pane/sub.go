package pane

import (
	"context"
	"errors"
	"io"
	"sync"
)

// Output to a client is bundled by backlog, not by time:
//
//   - A subscriber with nothing in flight gets new output at once, so a
//     keystroke's echo is never held back.
//   - While a frame is on its way (the socket is busy, or, for a client
//     that acknowledges, its bytes are not acknowledged yet), new output
//     gathers into the next frame. A flood of 1 KiB pty reads becomes a few
//     large frames, paced by how fast the client takes them.
//   - A client that falls more than its window behind does not slow the
//     pane: its queued output is dropped, and once it has caught up it gets
//     a snapshot of the screen instead, then live output again.

const (
	// DefaultWindow is how far behind a subscriber may fall before it is
	// resynchronised with a snapshot.
	DefaultWindow = 4 << 20
	// MinWindow is the smallest window a subscriber may ask for.
	MinWindow = 64 << 10
	// MaxFrame is the largest output frame.
	MaxFrame = 1 << 20
	// batch is how much output an acknowledging subscriber gathers before
	// it sends without waiting for an acknowledgement.
	batch = 256 << 10
)

// ErrSubClosed is returned by Next after Close.
var ErrSubClosed = errors.New("subscription closed")

// Frame is the next thing to send to a subscriber.
type Frame struct {
	// Snapshot is true when Data rebuilds the screen (the client resets
	// its terminal and writes Data) rather than continuing it.
	Snapshot bool
	// Mark is the position in the pane's output of Data's first byte, or,
	// for a snapshot, the position the snapshot shows the screen at.
	Mark uint64
	Data []byte
}

// SubOptions configures a subscription.
type SubOptions struct {
	// Since starts the stream at this mark with the raw output from the
	// log instead of a snapshot, when the log still has it and it fits in
	// the window. Otherwise the stream starts with a snapshot.
	Since *uint64
	// Ack says the client acknowledges the bytes it has processed (Ack).
	Ack bool
	// Window is how many bytes may be queued and unacknowledged before
	// the subscriber is resynchronised. Zero means DefaultWindow.
	Window int
}

// Sub is one client's stream of a pane's output.
type Sub struct {
	p       *Pane
	mu      sync.Mutex
	pending []byte
	start   uint64
	resync  bool
	ack     bool
	unacked int
	window  int
	ended   bool
	closed  bool
	wake    chan struct{}
	stats   SubStats
}

// SubStats counts what a subscription sent.
type SubStats struct {
	Frames, Snapshots, Resyncs int
	Bytes                      int64
}

// Subscribe starts a stream of the pane's output.
func (p *Pane) Subscribe(o SubOptions) (*Sub, error) {
	w := o.Window
	if w == 0 {
		w = DefaultWindow
	}
	w = max(w, MinWindow)
	s := &Sub{p: p, ack: o.Ack, window: w, wake: make(chan struct{}, 1), resync: true}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil, ErrClosed
	}
	if o.Since != nil {
		if *o.Since > p.offset {
			return nil, errors.New("since is ahead of the pane's output")
		}
		if p.offset-*o.Since <= uint64(w) {
			data, from, err := p.log.read(*o.Since, int(p.offset-*o.Since))
			if err == nil && from == *o.Since {
				s.resync = false
				s.start = from
				s.pending = data
			}
		}
	}
	s.ended = p.ended
	p.subs[s] = struct{}{}
	s.signal()
	return s, nil
}

func (s *Sub) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// push queues output. The pane's lock is held.
func (s *Sub) push(b []byte, mark uint64) {
	s.mu.Lock()
	if !s.resync && !s.closed {
		if len(s.pending) == 0 {
			s.start = mark
		}
		backlog := len(s.pending) + len(b)
		if s.ack {
			backlog += s.unacked
		}
		if backlog > s.window {
			s.resync = true
			s.pending = nil
			s.stats.Resyncs++
		} else {
			s.pending = append(s.pending, b...)
		}
	}
	s.mu.Unlock()
	s.signal()
}

// end marks the end of the pane's output. The pane's lock is held.
func (s *Sub) end() {
	s.mu.Lock()
	s.ended = true
	s.mu.Unlock()
	s.signal()
}

// Ack records that the client processed n more bytes.
func (s *Sub) Ack(n int) {
	s.mu.Lock()
	s.unacked = max(s.unacked-n, 0)
	s.mu.Unlock()
	s.signal()
}

// Next waits for the next frame. It returns io.EOF after the pane's output
// has ended and everything has been sent.
func (s *Sub) Next(ctx context.Context) (Frame, error) {
	for {
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			return Frame{}, ErrSubClosed
		}
		idle := !s.ack || s.unacked == 0
		if s.resync && (idle || s.unacked <= batch) {
			s.mu.Unlock()
			if f, ok := s.snapshot(); ok {
				return f, nil
			}
			continue
		}
		if !s.resync && len(s.pending) > 0 && (idle || (len(s.pending) >= batch && s.unacked+batch <= s.window)) {
			n := min(len(s.pending), MaxFrame)
			data := make([]byte, n)
			copy(data, s.pending)
			s.pending = s.pending[n:]
			if len(s.pending) == 0 {
				s.pending = nil
			}
			f := Frame{Mark: s.start, Data: data}
			s.start += uint64(n)
			if s.ack {
				s.unacked += n
			}
			s.stats.Frames++
			s.stats.Bytes += int64(n)
			s.mu.Unlock()
			return f, nil
		}
		if s.ended && !s.resync && len(s.pending) == 0 {
			s.mu.Unlock()
			return Frame{}, io.EOF
		}
		s.mu.Unlock()
		select {
		case <-s.wake:
		case <-ctx.Done():
			return Frame{}, ctx.Err()
		}
	}
}

// snapshot takes the screen and the mark it stands for, atomically with
// the output stream.
func (s *Sub) snapshot() (Frame, bool) {
	p := s.p
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		// The screen is gone: end the stream instead.
		s.mu.Lock()
		s.resync = false
		s.pending = nil
		s.ended = true
		s.mu.Unlock()
		return Frame{}, false
	}
	data, err := p.screen.Snapshot()
	if err != nil {
		data = []byte("\x1bc")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.resync {
		return Frame{}, false
	}
	s.resync = false
	s.pending = nil
	s.start = p.offset
	if s.ack {
		s.unacked += len(data)
	}
	s.stats.Frames++
	s.stats.Snapshots++
	s.stats.Bytes += int64(len(data))
	return Frame{Snapshot: true, Mark: p.offset, Data: data}, true
}

// Stats returns what the subscription has sent so far.
func (s *Sub) Stats() SubStats {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stats
}

// Close ends the subscription.
func (s *Sub) Close() {
	s.p.mu.Lock()
	delete(s.p.subs, s)
	s.p.mu.Unlock()
	s.mu.Lock()
	s.closed = true
	s.pending = nil
	s.mu.Unlock()
	s.signal()
}
