package pane

import (
	"context"
	"errors"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// Rerun says how a command run by the pane's shell was started again.
type Rerun struct {
	// Command is the command line typed again, as the shell reported it
	// (OSC 133 C).
	Command string
	// Mark is the pane's output position just before it was typed.
	Mark uint64
	// StoppedBy is what ended the command: "interrupt" (Ctrl-C),
	// "SIGTERM" or "SIGKILL".
	StoppedBy string
}

// Errors of RerunCommand. They are the request's fault only in that the
// pane is not in a state to do it, so they are plain failures.
var (
	ErrNoShellMarks = errors.New("the pane's shell sent no OSC 133 marks (no shell integration): restart the pane instead")
	ErrAtPrompt     = errors.New("the pane's shell is at its prompt: no command runs")
	ErrNoCmdline    = errors.New("the pane's shell did not report the command line it runs (OSC 133 C without one)")
	ErrStillRunning = errors.New("the command did not end: the shell's prompt did not come back")
)

// afterKill is how long the shell gets to draw its prompt once the
// command was killed.
const afterKill = 3 * time.Second

// RerunCommand starts again, in the same pane, the command the pane's
// shell runs: it interrupts it as Ctrl-C does, then, when the shell's
// prompt has not come back after half of grace, sends SIGTERM to the
// terminal's foreground process group, and SIGKILL at the end of grace
// (never to the pane's first process's group); once the prompt is back
// it types the same command line and Enter.
func (p *Pane) RerunCommand(ctx context.Context, grace time.Duration) (Rerun, error) {
	p.mu.Lock()
	switch {
	case p.closed:
		p.mu.Unlock()
		return Rerun{}, ErrClosed
	case p.exit != nil:
		p.mu.Unlock()
		return Rerun{}, ErrExited
	case p.shell == nil:
		p.mu.Unlock()
		return Rerun{}, ErrNoShellMarks
	case p.shell.State != "running":
		p.mu.Unlock()
		return Rerun{}, ErrAtPrompt
	case p.shell.Command == "":
		p.mu.Unlock()
		return Rerun{}, ErrNoCmdline
	}
	line := p.shell.Command
	p.mu.Unlock()

	mark := p.Mark()
	if _, err := p.Send(ctx, []InputItem{{Key: "Ctrl+c"}}); err != nil {
		return Rerun{}, err
	}
	r := Rerun{Command: line, StoppedBy: "interrupt"}
	ok, err := p.promptBack(ctx, mark, grace/2)
	if err != nil {
		return r, err
	}
	for _, sig := range []syscall.Signal{syscall.SIGTERM, syscall.SIGKILL} {
		if ok {
			break
		}
		if pgrp := p.foregroundGroup(); pgrp > 0 {
			unix.Kill(-pgrp, sig)
		}
		r.StoppedBy = signalName(sig)
		wait := grace - grace/2
		if sig == syscall.SIGKILL {
			wait = afterKill
		}
		if ok, err = p.promptBack(ctx, mark, wait); err != nil {
			return r, err
		}
	}
	if !ok {
		return r, ErrStillRunning
	}
	sent, err := p.Send(ctx, []InputItem{{Text: line, Mode: ModePaste}, {Key: "Enter"}})
	r.Mark = sent.Mark
	return r, err
}

// promptBack waits up to d for the shell to be at a prompt drawn after
// mark.
func (p *Pane) promptBack(ctx context.Context, mark uint64, d time.Duration) (bool, error) {
	if d > 0 {
		if _, err := p.Wait(ctx, WaitSpec{Prompt: true, Since: &mark, Timeout: d}, nil); err != nil {
			return false, err
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return false, ErrClosed
	}
	return p.promptAfter(mark) && p.shell != nil && p.shell.State == "prompt", nil
}

// foregroundGroup is the terminal's foreground process group, or 0 when
// it is the pane's first process's own (the shell) or unknown.
func (p *Pane) foregroundGroup() int {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return 0
	}
	f, first := p.pty, p.pid
	p.mu.Unlock()
	sc, err := f.SyscallConn()
	if err != nil {
		return 0
	}
	pgrp := 0
	// Control, not Fd: Fd would put the pty in blocking mode under the
	// read loop.
	if cerr := sc.Control(func(fd uintptr) { pgrp, err = unix.IoctlGetInt(int(fd), unix.TIOCGPGRP) }); cerr != nil || err != nil {
		return 0
	}
	if own, err := unix.Getpgid(first); pgrp <= 0 || pgrp == first || (err == nil && pgrp == own) {
		return 0
	}
	return pgrp
}
