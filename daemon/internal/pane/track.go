package pane

import (
	"sort"
	"time"
)

// Tracking a manager's panes while they live (proctree.go): what belongs
// to each is recorded, so closing it, and judging who is the person
// (origin.go), still finds a process that has left its parents.

// sweepEvery is how often the process table is walked while panes exist.
const sweepEvery = time.Second

type tracker struct {
	m    *Manager
	stop chan struct{}
	done chan struct{}
	w    *forkWatch // the fork watch where the system has one (macOS), else nil
}

func (m *Manager) startTracking() {
	t := &tracker{m: m, stop: make(chan struct{}), done: make(chan struct{}), w: newForkWatch()}
	m.track = t
	go t.run()
}

func (t *tracker) close() {
	close(t.stop)
	<-t.done
	t.w.close()
}

// follow starts tracking a pane, from its first process.
func (t *tracker) follow(p *Pane) {
	if pr, ok := procOf(p.pid); ok {
		p.seen.add(p.pid, pr.start)
	}
	t.w.add(p.pid, p)
}

// sweep walks the process table once and records what belongs to each
// pane that is not closed.
func (t *tracker) sweep() {
	panes := t.m.open()
	if len(panes) == 0 {
		return
	}
	procs := listProcs()
	roots := map[int]bool{}
	for _, p := range panes {
		if p.running() {
			roots[p.pid] = true
		}
	}
	for _, p := range panes {
		mem := belongs(procs, p.pid, p.seen.copy(), othersThan(roots, p.pid), nil)
		p.seen.update(mem, procs)
		for _, pr := range mem {
			t.w.add(pr.pid, p)
		}
	}
}

func othersThan(roots map[int]bool, pid int) map[int]bool {
	out := make(map[int]bool, len(roots))
	for r := range roots {
		if r != pid {
			out[r] = true
		}
	}
	return out
}

// open returns the panes that are not closed, running or exited.
func (m *Manager) open() []*Pane {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*Pane, 0, len(m.panes))
	for _, p := range m.panes {
		out = append(out, p)
	}
	return out
}

// PaneOf returns the pane a process belongs to by what tracking saw: the
// process itself, or the leader of its session or group, seen in a pane
// that is not closed. Its parents are for the caller to walk (OriginOf).
func (m *Manager) PaneOf(pid int) (string, bool) {
	pr, ok := procOf(pid)
	if !ok {
		return "", false
	}
	mark, marked := markOf(pid)
	for _, p := range m.open() {
		rec := p.seen.copy()
		if s, ok := rec[pid]; ok && s == pr.start {
			return p.id, true
		}
		for _, l := range []int{pr.sid, pr.pgid} {
			if s, ok := rec[l]; ok && l > 1 {
				if q, alive := procOf(l); !alive || q.start == s {
					return p.id, true
				}
			}
		}
		if marked && mark == paneMark(p.id) {
			return p.id, true
		}
	}
	return "", false
}

// Members returns the pids of the processes that belong to pane id now,
// by its parents, its sessions and what tracking saw (not its marks),
// sorted; nil for an unknown or closed pane.
func (m *Manager) Members(id string) []int {
	m.mu.Lock()
	p, ok := m.panes[id]
	m.mu.Unlock()
	if !ok {
		return nil
	}
	others := map[int]bool{}
	for _, o := range m.open() {
		if o != p && o.running() {
			others[o.pid] = true
		}
	}
	ps := belongs(listProcs(), p.pid, p.seen.copy(), others, nil)
	out := make([]int, 0, len(ps))
	for _, pr := range ps {
		out = append(out, pr.pid)
	}
	sort.Ints(out)
	return out
}
