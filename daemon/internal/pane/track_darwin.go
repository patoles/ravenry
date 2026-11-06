package pane

/*
#include <libproc.h>

static int ravenry_children(int pid, int *out, int max) {
	return proc_listchildpids(pid, out, max * (int)sizeof(int));
}
*/
import "C"

import (
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// The fork watch: kqueue tells the moment a process the daemon knows
// forks (EVFILT_PROC, NOTE_FORK), and its children are read at once
// (proc_listchildpids) and watched in turn. A helper that forks, moves
// to a session of its own and forks again (a double fork) is seen before
// the middle process exits and is reaped, so what it leaves is still the
// pane's (proctree.go): in a 200-run loop of a C double fork whose middle
// process exits at once, the middle one was seen every time.
type forkWatch struct {
	kq int
	mu sync.Mutex
	of map[int]*Pane
}

func newForkWatch() *forkWatch {
	kq, err := unix.Kqueue()
	if err != nil {
		return nil
	}
	unix.CloseOnExec(kq)
	return &forkWatch{kq: kq, of: map[int]*Pane{}}
}

func (w *forkWatch) close() {
	if w != nil {
		unix.Close(w.kq)
	}
}

// add watches process pid of pane p, and takes the children it already
// has.
func (w *forkWatch) add(pid int, p *Pane) {
	if w == nil || pid <= 1 {
		return
	}
	w.mu.Lock()
	if w.of[pid] == p {
		w.mu.Unlock()
		return
	}
	w.of[pid] = p
	w.mu.Unlock()
	var ev unix.Kevent_t
	unix.SetKevent(&ev, pid, unix.EVFILT_PROC, unix.EV_ADD|unix.EV_CLEAR)
	ev.Fflags = unix.NOTE_FORK | unix.NOTE_EXIT
	if _, err := unix.Kevent(w.kq, []unix.Kevent_t{ev}, nil, nil); err != nil {
		w.drop(pid)
		return
	}
	w.children(pid, p)
}

func (w *forkWatch) drop(pid int) {
	w.mu.Lock()
	delete(w.of, pid)
	w.mu.Unlock()
}

func (w *forkWatch) paneOf(pid int) *Pane {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.of[pid]
}

// children records and watches pid's children (a child that has already
// exited, a zombie its parent has not reaped, is recorded too: it may
// lead the session its own child is in).
func (w *forkWatch) children(pid int, p *Pane) {
	var buf [512]C.int
	n := int(C.ravenry_children(C.int(pid), (*C.int)(unsafe.Pointer(&buf[0])), C.int(len(buf))))
	for i := 0; i < n && i < len(buf); i++ {
		c := int(buf[i])
		if pr, ok := procOf(c); ok && c > 1 {
			p.seen.add(c, pr.start)
			w.add(c, p)
		}
	}
}

func (t *tracker) run() {
	defer close(t.done)
	if t.w == nil {
		tick := time.NewTicker(sweepEvery)
		defer tick.Stop()
		for {
			select {
			case <-t.stop:
				return
			case <-tick.C:
				t.sweep()
			}
		}
	}
	evs := make([]unix.Kevent_t, 64)
	wait := unix.NsecToTimespec(int64(250 * time.Millisecond))
	var last time.Time
	for {
		select {
		case <-t.stop:
			return
		default:
		}
		n, err := unix.Kevent(t.w.kq, nil, evs, &wait)
		if err != nil && err != unix.EINTR {
			time.Sleep(100 * time.Millisecond)
		}
		for i := 0; i < n; i++ {
			pid := int(evs[i].Ident)
			if evs[i].Fflags&unix.NOTE_FORK != 0 {
				if p := t.w.paneOf(pid); p != nil {
					t.w.children(pid, p)
				}
			}
			if evs[i].Fflags&unix.NOTE_EXIT != 0 {
				t.w.drop(pid)
			}
		}
		if time.Since(last) >= sweepEvery {
			t.sweep()
			last = time.Now()
		}
	}
}
