package pane

import (
	"errors"
	"time"

	"golang.org/x/sys/unix"
)

// Process describes a process: its id, its arguments, its executable, its
// working directory and when it started. Fields the system would not tell
// are left empty.
type Process struct {
	PID     int
	Argv    []string
	Exe     string
	Cwd     string
	Started time.Time

	// Filled by CheckSource: the executable file's modification time, the
	// git work tree of Cwd, and what changed since the start (Checked
	// once the start is known, so Changes empty means nothing did).
	ExeModified time.Time
	Git         *Git
	Checked     bool
	Changes     []string
}

// ErrExited is returned for what needs the pane's process running.
var ErrExited = errors.New("the pane's process has exited")

// Foreground describes what runs in the foreground of the pane: the
// leader of the terminal's foreground process group (the shell at its
// prompt, or the command it runs). When the leader has exited and others
// of its group run on, the oldest of them.
func (p *Pane) Foreground() (*Process, error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil, ErrClosed
	}
	if p.exit != nil {
		p.mu.Unlock()
		return nil, ErrExited
	}
	f, first := p.pty, p.pid
	p.mu.Unlock()
	pgrp := 0
	sc, err := f.SyscallConn()
	if err != nil {
		return nil, err
	}
	// Control, not Fd: Fd would put the pty in blocking mode under the
	// read loop.
	if cerr := sc.Control(func(fd uintptr) { pgrp, err = unix.IoctlGetInt(int(fd), unix.TIOCGPGRP) }); cerr != nil {
		return nil, cerr
	}
	pid := first
	if err == nil && pgrp > 0 {
		pid = pgrp
		if !alive(pgrp) || zombie(pgrp) {
			pid = 0
			for _, pr := range listProcs() {
				if pr.pgid == pgrp && (pid == 0 || pr.pid < pid) && !zombie(pr.pid) {
					pid = pr.pid
				}
			}
			if pid == 0 {
				pid = first
			}
		}
	}
	return ProcessInfo(pid)
}
