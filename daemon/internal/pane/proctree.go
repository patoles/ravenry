package pane

import (
	"os"
	"sync"
	"syscall"
	"time"
)

// proc is one process of this user, as the process table shows it. start
// is when it started, in the system's own unit: with the pid it names one
// process, since a pid is reused only by a process that starts later.
type proc struct {
	pid, ppid, sid, pgid int
	start                int64
}

// Which processes belong to a pane. Closing a pane ends them, and they
// are never the person (origin.go). A process belongs to the pane when
//
//   - it is the pane's first process, or a child of one that belongs;
//   - its session or its process group is led by one that belongs, or
//     did: a program that moves to a session of its own (setsid) is its
//     leader, and the processes it starts stay in that session after it
//     has gone, which is what a double fork leaves behind;
//   - the pane saw it while it lived (seen, below), even if it has since
//     left its parents for launchd or init;
//   - or it carries the pane's mark where the system shows it: its
//     environment still says RAVENRY_PANE=<id> (Linux, and macOS for
//     programs other than Apple's own: macOS 26 shows no environment of
//     an Apple binary, /bin/sh and curl among them), or, on Linux, its
//     real-time CPU limit is the pane's (mark_linux.go), which survives a
//     wiped environment.
//
// What a pane has seen is kept by tracking it while it lives
// (track_*.go): every second the daemon walks the process table, and on
// macOS it also hears every fork of a process it knows the moment it
// happens (kqueue NOTE_FORK), so a helper that forks, moves to a new
// session and forks again (a double fork) is seen before its middle
// process is gone. Never a process of another pane, nor one outside every
// pane: a process joins only through one that belongs.

// seen is what tracking saw of a pane: each pid with its start.
type seen struct {
	mu   sync.Mutex
	pids map[int]int64
}

func newSeen() *seen { return &seen{pids: map[int]int64{}} }

func (s *seen) add(pid int, start int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.pids[pid]; ok && old == start {
		return false
	}
	s.pids[pid] = start
	return true
}

func (s *seen) copy() map[int]int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[int]int64, len(s.pids))
	for k, v := range s.pids {
		out[k] = v
	}
	return out
}

// update adds members and forgets what can no longer matter: a pid that
// now names another process, and a gone one that leads no session or
// group any more (so its number can be reused without meaning the pane).
func (s *seen) update(members []proc, procs []proc) {
	now := make(map[int]proc, len(procs))
	leads := map[int]bool{}
	for _, p := range procs {
		now[p.pid] = p
		leads[p.sid] = true
		leads[p.pgid] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range members {
		s.pids[p.pid] = p.start
	}
	for pid, start := range s.pids {
		if p, ok := now[pid]; ok {
			if p.start != start {
				delete(s.pids, pid)
			}
		} else if !leads[pid] {
			delete(s.pids, pid)
		}
	}
}

// belongs returns the processes among procs that belong to the pane whose
// first process is root, with what it has seen (pid to start) and extra,
// a check of the pane's marks (nil for none). Never this process, pid 0
// or 1, the first process of another pane (others) or a process in that
// one's session.
func belongs(procs []proc, root int, rec map[int]int64, others map[int]bool, extra func(proc) bool) []proc {
	self := os.Getpid()
	alive := make(map[int]proc, len(procs))
	for _, p := range procs {
		alive[p.pid] = p
	}
	// leaders: the pids whose sessions and groups are the pane's. A seen
	// pid that now names another process is not one: that process took
	// the number after the old one, its session and its group were gone.
	// The first process is in what was seen, with its start, from the
	// moment the pane started; only when it is not is it taken by pid.
	leaders := map[int]bool{}
	in := map[int]bool{}
	if _, has := rec[root]; !has && root > 1 {
		leaders[root] = true
		if _, ok := alive[root]; ok {
			in[root] = true
		}
	}
	for pid, start := range rec {
		p, ok := alive[pid]
		switch {
		case !ok:
			leaders[pid] = true
		case p.start == start:
			leaders[pid] = true
			in[pid] = true
		}
	}
	allowed := func(p proc) bool {
		return p.pid > 1 && p.pid != self && !others[p.pid] && !others[p.sid]
	}
	for changed := true; changed; {
		changed = false
		for _, p := range procs {
			if in[p.pid] || !allowed(p) {
				continue
			}
			if in[p.ppid] || leaders[p.sid] || leaders[p.pgid] || (extra != nil && extra(p)) {
				in[p.pid] = true
				leaders[p.pid] = true
				changed = true
			}
		}
	}
	out := make([]proc, 0, len(in))
	for pid := range in {
		if p, ok := alive[pid]; ok && allowed(p) {
			out = append(out, p)
		}
	}
	return out
}

// treeOf returns the pids of every process that belongs to a pane now,
// its marks included (the environment, and on Linux the CPU limit),
// which are read for every other process of the user.
func treeOf(root int, paneID string, rec *seen, others map[int]bool) []int {
	var have map[int]int64
	if rec != nil {
		have = rec.copy()
	}
	marker := []byte("RAVENRY_PANE=" + paneID + "\x00")
	mark := paneMark(paneID)
	extra := func(p proc) bool { return envHas(p.pid, marker) || hasMark(p.pid, mark) }
	ps := belongs(listProcs(), root, have, others, extra)
	out := make([]int, 0, len(ps))
	for _, p := range ps {
		if alive(p.pid) {
			out = append(out, p.pid)
		}
	}
	return out
}

func alive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

// killTree ends a pane's processes: SIGHUP (what closing a terminal sends),
// then SIGTERM to what is left after half the grace period, then SIGKILL
// at the end of it. It looks for the pane's processes again before the
// SIGKILL, so a child started during the shutdown is caught too. It
// returns how many processes it signalled.
func killTree(root int, paneID string, rec *seen, others map[int]bool, grace time.Duration) int {
	pids := treeOf(root, paneID, rec, others)
	signalled := map[int]bool{}
	for _, pid := range pids {
		signalled[pid] = true
		syscall.Kill(pid, syscall.SIGHUP)
		syscall.Kill(pid, syscall.SIGCONT)
	}
	if waitGone(pids, grace/2) {
		return len(signalled)
	}
	for _, pid := range pids {
		syscall.Kill(pid, syscall.SIGTERM)
	}
	if waitGone(pids, grace/2) {
		return len(signalled)
	}
	for _, pid := range append(pids, treeOf(root, paneID, rec, others)...) {
		signalled[pid] = true
		syscall.Kill(pid, syscall.SIGKILL)
	}
	waitGone(pids, 500*time.Millisecond)
	return len(signalled)
}

// waitGone waits until none of pids is alive, or d has passed. A zombie
// still answers kill(0), so the pane's own first process is reaped by its
// waiter goroutine; the others belong to init or to their parents.
func waitGone(pids []int, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for {
		left := false
		for _, pid := range pids {
			if alive(pid) && !zombie(pid) {
				left = true
				break
			}
		}
		if !left {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(10 * time.Millisecond)
	}
}
