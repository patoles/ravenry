package pane

import (
	"os"
	"syscall"
	"time"
)

// proc is one process of this user, as the process table shows it.
type proc struct {
	pid, ppid, sid int
}

// treeOf returns every process that belongs to a pane: the descendants of
// its first process (by parent), every process in its session, and every
// process whose environment still says RAVENRY_PANE=<id>. The last one
// catches a program that daemonized itself (fork, setsid, parent exits),
// which is what leaves helpers running after a terminal closes.
func treeOf(root int, paneID string) []int {
	procs := listProcs()
	self := os.Getpid()
	in := map[int]bool{}
	children := map[int][]int{}
	for _, p := range procs {
		children[p.ppid] = append(children[p.ppid], p.pid)
		if p.sid == root && root > 0 {
			in[p.pid] = true
		}
	}
	walked := map[int]bool{}
	stack := []int{root}
	for len(stack) > 0 {
		pid := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if pid <= 1 || walked[pid] {
			continue
		}
		walked[pid] = true
		in[pid] = true
		stack = append(stack, children[pid]...)
	}
	marker := []byte("RAVENRY_PANE=" + paneID + "\x00")
	for _, p := range procs {
		if !in[p.pid] && p.pid != self && p.pid > 1 && envHas(p.pid, marker) {
			in[p.pid] = true
		}
	}
	delete(in, self)
	delete(in, 0)
	delete(in, 1)
	out := make([]int, 0, len(in))
	for pid := range in {
		if alive(pid) {
			out = append(out, pid)
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
func killTree(root int, paneID string, grace time.Duration) int {
	pids := treeOf(root, paneID)
	seen := map[int]bool{}
	for _, pid := range pids {
		seen[pid] = true
		syscall.Kill(pid, syscall.SIGHUP)
		syscall.Kill(pid, syscall.SIGCONT)
	}
	if waitGone(pids, grace/2) {
		return len(seen)
	}
	for _, pid := range pids {
		syscall.Kill(pid, syscall.SIGTERM)
	}
	if waitGone(pids, grace/2) {
		return len(seen)
	}
	for _, pid := range append(pids, treeOf(root, paneID)...) {
		seen[pid] = true
		syscall.Kill(pid, syscall.SIGKILL)
	}
	waitGone(pids, 500*time.Millisecond)
	return len(seen)
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
