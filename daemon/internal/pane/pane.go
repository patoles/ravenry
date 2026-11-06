// Package pane holds ravenryd's terminals: a process on a pty, its screen
// (through package vt), a capped log of what it printed, the clients
// streaming its output, and the waits and input that agents use.
package pane

import (
	"crypto/rand"
	"encoding/base32"
	"errors"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"

	"ravenryd/internal/vt"
)

// ErrClosed is returned for a pane that has been closed.
var ErrClosed = errors.New("pane closed")

// Config describes a pane to start.
type Config struct {
	// Command is the program and its arguments. Empty starts the user's
	// login shell ($SHELL, or /bin/sh).
	Command []string
	// Cwd is the working directory; empty means the home directory.
	Cwd string
	// Env is added to the daemon's environment (and wins over it).
	Env map[string]string
	// Cols and Rows are the terminal size; zero means 80x24.
	Cols, Rows int
	// Name is a label for people; it has no meaning to the daemon.
	Name string
	// Hidden panes are left out of the default listing.
	Hidden bool
	// TTL closes a hidden pane this long after it started.
	TTL time.Duration
	// Scrollback is the number of history lines the screen keeps; zero
	// means 10000.
	Scrollback int
}

// Exit says how a pane's first process ended.
type Exit struct {
	// Code is the exit status, or -1 when a signal ended the process.
	Code int
	// Signal names the signal that ended it ("SIGKILL"), or is empty.
	Signal string
}

// Info describes a pane.
type Info struct {
	ID         string
	Name       string
	Command    []string
	Cwd        string
	PID        int
	Cols, Rows int
	Hidden     bool
	TTL        time.Duration
	Created    time.Time
	Title      string
	Mark       uint64
	LastOutput time.Time
	Exit       *Exit
	ExitedAt   time.Time
	// Shell is set once the program marked a prompt with OSC 133.
	Shell *Shell
}

// Shell is what OSC 133 marks say about the shell in a pane.
type Shell struct {
	// State is "running" from a command's start (OSC 133 C) to its end
	// (D), else "prompt".
	State string
	// Command is the running or last command, when the shell sent it.
	Command string
	// ExitCode is the last finished command's status, when the shell sent it.
	ExitCode *int
	// Mark and At say when the state last changed.
	Mark uint64
	At   time.Time
}

// maxPromptMarks is how many prompt marks a pane keeps for waits that
// start from a past mark.
const maxPromptMarks = 64

// Running reports whether the pane's first process is still running.
func (i Info) Running() bool { return i.Exit == nil }

// Pane is one terminal.
type Pane struct {
	id      string
	cfg     Config
	orig    Config // as asked for, to restart it
	created time.Time
	cmd     *exec.Cmd
	pty     *os.File
	pid     int
	keep    bool // keep the log when the pane closes

	// writeMu serializes input, so a typed or pasted sequence is never
	// interleaved with another one.
	writeMu sync.Mutex

	mu         sync.Mutex
	screen     vt.Screen
	log        *paneLog
	offset     uint64
	lastOutput time.Time
	reads      int64
	subs       map[*Sub]struct{}
	taps       map[*tap]struct{}
	changed    chan struct{}
	replies    []byte
	title      string
	ended      bool // output reached EOF
	exit       *Exit
	exitedAt   time.Time
	closed     bool

	// OSC 133 marks: the shell's state, the marks where a prompt started
	// (for waits), and the end of the chunk being written, which is the
	// mark a prompt seen in it gets.
	shell    *Shell
	prompts  []uint64
	writeEnd uint64
	// notes are what the program reported while a chunk was written, in
	// order, for after the lock is released.
	notes []note

	done   chan struct{} // closed when the output loop has ended
	exited chan struct{} // closed when the first process has exited

	onExit   func(*Pane)
	onTitle  func(*Pane)
	onPrompt func(*Pane, Shell)
	onStatus func(*Pane, vt.ProgramStatus)
}

// note is one thing the program reported: a new shell state (OSC 133) or
// a status report (OSC 7501).
type note struct {
	shell  *Shell
	status *vt.ProgramStatus
}

// tap receives every chunk of output, under the pane's lock.
type tap struct{ fn func([]byte) }

const (
	defaultCols       = 80
	defaultRows       = 24
	defaultScrollback = 10000
)

// newID returns a pane id: "p" and seven characters, unique across
// daemons in practice, so a client can tell panes of two daemons apart.
func newID() string {
	var b [5]byte
	rand.Read(b[:])
	return "p" + strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b[:]))[:7]
}

// start starts a pane. env is the full base environment.
func start(cfg Config, env []string, logDir string, logCap int64, socket string) (*Pane, error) {
	if cfg.Cols == 0 {
		cfg.Cols = defaultCols
	}
	if cfg.Rows == 0 {
		cfg.Rows = defaultRows
	}
	if cfg.Cols < 1 || cfg.Rows < 1 || cfg.Cols > 4096 || cfg.Rows > 4096 {
		return nil, fmt.Errorf("bad size %dx%d", cfg.Cols, cfg.Rows)
	}
	if cfg.Scrollback == 0 {
		cfg.Scrollback = defaultScrollback
	}
	home, _ := os.UserHomeDir()
	if cfg.Cwd == "" {
		cfg.Cwd = home
	}
	if fi, err := os.Stat(cfg.Cwd); err != nil || !fi.IsDir() {
		return nil, fmt.Errorf("working directory %q does not exist", cfg.Cwd)
	}
	orig := cfg
	orig.Env = maps.Clone(cfg.Env)
	orig.Command = slices.Clone(cfg.Command)
	p := &Pane{
		id:      newID(),
		orig:    orig,
		created: time.Now(),
		subs:    map[*Sub]struct{}{},
		taps:    map[*tap]struct{}{},
		changed: make(chan struct{}),
		done:    make(chan struct{}),
		exited:  make(chan struct{}),
	}
	var cmd *exec.Cmd
	if len(cfg.Command) == 0 {
		sh := envValue("SHELL", cfg.Env, env)
		if sh == "" {
			sh = "/bin/sh"
		}
		cmd = exec.Command(sh)
		// A login shell, as a terminal starts one: argv[0] starts with "-".
		cmd.Args = []string{"-" + filepath.Base(sh)}
		cfg.Command = []string{sh}
	} else {
		path, err := lookPath(cfg.Command[0], cfg.Env, env)
		if err != nil {
			return nil, err
		}
		cmd = exec.Command(path, cfg.Command[1:]...)
		cmd.Args[0] = cfg.Command[0]
	}
	cmd.Dir = cfg.Cwd
	cmd.Env = paneEnv(env, cfg.Env, p.id, socket)
	p.cfg = cfg

	screen, err := vt.New(vt.Options{
		Cols: cfg.Cols, Rows: cfg.Rows, Scrollback: cfg.Scrollback,
		Reply:  func(b []byte) { p.replies = append(p.replies, b...) },
		Prompt: p.promptMark,
		Status: func(st vt.ProgramStatus) { p.notes = append(p.notes, note{status: &st}) },
	})
	if err != nil {
		return nil, err
	}
	p.screen = screen
	if p.log, err = openLog(filepath.Join(logDir, p.id+".log"), logCap); err != nil {
		screen.Close()
		return nil, err
	}
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cfg.Cols), Rows: uint16(cfg.Rows)})
	if err != nil {
		screen.Close()
		p.log.close(true)
		return nil, fmt.Errorf("start %q: %w", cfg.Command[0], err)
	}
	p.cmd, p.pty, p.pid = cmd, f, cmd.Process.Pid
	go p.readLoop()
	go p.waitLoop()
	return p, nil
}

// envValue returns a variable as the pane will see it.
func envValue(key string, extra map[string]string, env []string) string {
	if v, ok := extra[key]; ok {
		return v
	}
	val := ""
	for _, kv := range env {
		if k, v, ok := strings.Cut(kv, "="); ok && k == key {
			val = v
		}
	}
	return val
}

// lookPath finds the program with the PATH the pane will have.
func lookPath(name string, extra map[string]string, env []string) (string, error) {
	if strings.Contains(name, "/") {
		return name, nil
	}
	path := envValue("PATH", extra, env)
	for _, dir := range filepath.SplitList(path) {
		if dir == "" {
			dir = "."
		}
		f := filepath.Join(dir, name)
		if fi, err := os.Stat(f); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 {
			return f, nil
		}
	}
	return "", fmt.Errorf("%q not found in PATH", name)
}

// paneEnv builds a pane's environment: the base, the terminal's own
// variables, the pane's identity, then what the client asked for.
func paneEnv(base []string, extra map[string]string, id, socket string) []string {
	set := map[string]string{}
	var order []string
	put := func(k, v string) {
		if _, ok := set[k]; !ok {
			order = append(order, k)
		}
		set[k] = v
	}
	for _, kv := range base {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || strings.HasPrefix(k, "RAVENRY_") {
			continue
		}
		put(k, v)
	}
	put("TERM", "xterm-256color")
	put("COLORTERM", "truecolor")
	put("TERM_PROGRAM", "ravenry")
	put("RAVENRY_PANE", id)
	if socket != "" {
		put("RAVENRY_SOCKET", socket)
	}
	for k, v := range extra {
		if k == "RAVENRY_PANE" || k == "RAVENRY_SOCKET" {
			continue
		}
		put(k, v)
	}
	out := make([]string, 0, len(order))
	for _, k := range order {
		out = append(out, k+"="+set[k])
	}
	return out
}

func (p *Pane) readLoop() {
	defer close(p.done)
	buf := make([]byte, 64<<10)
	for {
		n, err := p.pty.Read(buf)
		if n > 0 {
			p.output(buf[:n])
		}
		if err != nil {
			break
		}
	}
	p.mu.Lock()
	p.ended = true
	p.log.flush()
	for s := range p.subs {
		s.end()
	}
	p.broadcast()
	p.mu.Unlock()
}

func (p *Pane) output(b []byte) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	mark := p.offset
	for s := range p.subs {
		s.push(b, mark)
	}
	p.writeEnd = mark + uint64(len(b))
	p.screen.Write(b)
	for t := range p.taps {
		t.fn(b)
	}
	p.log.write(b)
	p.offset += uint64(len(b))
	p.reads++
	p.lastOutput = time.Now()
	replies := p.replies
	p.replies = nil
	titleChanged := false
	if t := p.screen.Title(); t != p.title {
		p.title, titleChanged = t, true
	}
	notes := p.notes
	p.notes = nil
	p.broadcast()
	p.mu.Unlock()
	if len(replies) > 0 {
		p.writeMu.Lock()
		p.pty.Write(replies)
		p.writeMu.Unlock()
	}
	if titleChanged && p.onTitle != nil {
		p.onTitle(p)
	}
	for _, n := range notes {
		switch {
		case n.shell != nil && p.onPrompt != nil:
			p.onPrompt(p, *n.shell)
		case n.status != nil && p.onStatus != nil:
			p.onStatus(p, *n.status)
		}
	}
}

// promptMark follows the shell through its OSC 133 marks. It runs inside
// screen.Write, with the pane's lock held. A change of state, command or
// exit code is reported (onPrompt) once the chunk is written; a prompt
// redrawn in the same state is not.
func (p *Pane) promptMark(m vt.PromptMark) {
	before := Shell{}
	if p.shell != nil {
		before = *p.shell
	} else {
		p.shell = &Shell{}
	}
	sh := p.shell
	switch m.Kind {
	case vt.PromptStart, vt.InputStart:
		sh.State = "prompt"
		p.prompts = append(p.prompts, p.writeEnd)
		if len(p.prompts) > maxPromptMarks {
			p.prompts = p.prompts[len(p.prompts)-maxPromptMarks:]
		}
	case vt.OutputStart:
		sh.State = "running"
		sh.Command = m.Command
		sh.ExitCode = nil
	case vt.CommandEnd:
		sh.State = "prompt"
		if m.HasExitCode {
			c := m.ExitCode
			sh.ExitCode = &c
		}
	}
	same := before.State == sh.State && before.Command == sh.Command &&
		(before.ExitCode == nil) == (sh.ExitCode == nil) &&
		(before.ExitCode == nil || *before.ExitCode == *sh.ExitCode)
	if !same {
		sh.Mark, sh.At = p.writeEnd, time.Now()
		p.notes = append(p.notes, note{shell: p.shellCopy()})
	}
}

// promptAfter reports whether a prompt started after mark. The pane's
// lock is held.
func (p *Pane) promptAfter(mark uint64) bool {
	for i := len(p.prompts) - 1; i >= 0; i-- {
		if p.prompts[i] > mark {
			return true
		}
	}
	return false
}

// broadcast wakes every wait. The pane's lock is held.
func (p *Pane) broadcast() {
	close(p.changed)
	p.changed = make(chan struct{})
}

func (p *Pane) waitLoop() {
	err := p.cmd.Wait()
	ex := &Exit{Code: 0}
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
				ex = &Exit{Code: -1, Signal: signalName(ws.Signal())}
			} else {
				ex = &Exit{Code: ee.ExitCode()}
			}
		} else {
			ex = &Exit{Code: -1}
		}
	}
	p.mu.Lock()
	p.exit = ex
	p.exitedAt = time.Now()
	p.broadcast()
	p.mu.Unlock()
	close(p.exited)
	if p.onExit != nil {
		p.onExit(p)
	}
}

func signalName(s syscall.Signal) string {
	names := map[syscall.Signal]string{
		syscall.SIGHUP: "SIGHUP", syscall.SIGINT: "SIGINT", syscall.SIGQUIT: "SIGQUIT",
		syscall.SIGKILL: "SIGKILL", syscall.SIGTERM: "SIGTERM", syscall.SIGSEGV: "SIGSEGV",
		syscall.SIGABRT: "SIGABRT", syscall.SIGPIPE: "SIGPIPE", syscall.SIGBUS: "SIGBUS",
		syscall.SIGUSR1: "SIGUSR1", syscall.SIGUSR2: "SIGUSR2", syscall.SIGALRM: "SIGALRM",
	}
	if n, ok := names[s]; ok {
		return n
	}
	return fmt.Sprintf("SIG%d", int(s))
}

// ID returns the pane's id.
func (p *Pane) ID() string { return p.id }

// Info describes the pane now.
func (p *Pane) Info() Info {
	p.mu.Lock()
	defer p.mu.Unlock()
	cols, rows := p.screen.Size()
	i := Info{
		ID: p.id, Name: p.cfg.Name, Command: p.cfg.Command, Cwd: p.cfg.Cwd, PID: p.pid,
		Cols: cols, Rows: rows, Hidden: p.cfg.Hidden, TTL: p.cfg.TTL, Created: p.created,
		Title: p.title, Mark: p.offset, LastOutput: p.lastOutput, ExitedAt: p.exitedAt,
	}
	if p.exit != nil {
		e := *p.exit
		i.Exit = &e
	}
	i.Shell = p.shellCopy()
	return i
}

// shellCopy copies the shell state; the pane's lock is held.
func (p *Pane) shellCopy() *Shell {
	if p.shell == nil {
		return nil
	}
	sh := *p.shell
	if sh.ExitCode != nil {
		c := *sh.ExitCode
		sh.ExitCode = &c
	}
	return &sh
}

// Mark returns the position just after the pane's latest output.
func (p *Pane) Mark() uint64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.offset
}

// Reads returns how many reads from the pty produced output.
func (p *Pane) Reads() int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.reads
}

// Resize changes the pane's size.
func (p *Pane) Resize(cols, rows int) error {
	if cols < 1 || rows < 1 || cols > 4096 || rows > 4096 {
		return fmt.Errorf("bad size %dx%d", cols, rows)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return ErrClosed
	}
	if err := p.screen.Resize(cols, rows); err != nil {
		return err
	}
	return pty.Setsize(p.pty, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

// Capture reads the pane's screen, and the mark it shows.
func (p *Pane) Capture(o vt.CaptureOptions) (*vt.Capture, uint64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil, 0, ErrClosed
	}
	c, err := p.screen.Capture(o)
	return c, p.offset, err
}

// CaptureWithVT reads the screen and, with the same mark, the VT that
// rebuilds it.
func (p *Pane) CaptureWithVT(o vt.CaptureOptions) (*vt.Capture, []byte, uint64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil, nil, 0, ErrClosed
	}
	c, err := p.screen.Capture(o)
	if err != nil {
		return nil, nil, 0, err
	}
	b, err := p.screen.Snapshot()
	return c, b, p.offset, err
}

// Text returns the visible rows as plain text.
func (p *Pane) Text() ([]string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil, ErrClosed
	}
	return p.screen.Text()
}

// Snapshot returns VT that rebuilds the screen, and the mark it shows.
func (p *Pane) Snapshot() ([]byte, uint64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil, 0, ErrClosed
	}
	b, err := p.screen.Snapshot()
	return b, p.offset, err
}

// Read returns up to limit bytes of output from mark on, from the log.
// from is where the data starts: later than mark when the log no longer
// holds that far back. end is the mark after the pane's latest output.
func (p *Pane) Read(mark uint64, limit int) (data []byte, from, end uint64, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if mark > p.offset {
		return nil, 0, 0, errors.New("mark is ahead of the pane's output")
	}
	data, from, err = p.log.read(mark, limit)
	return data, from, p.offset, err
}

// Input writes bytes to the pane as they are.
func (p *Pane) Input(b []byte) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	return p.write(b)
}

// write writes to the pty; writeMu is held.
func (p *Pane) write(b []byte) error {
	p.mu.Lock()
	closed := p.closed
	p.mu.Unlock()
	if closed {
		return ErrClosed
	}
	_, err := p.pty.Write(b)
	return err
}

// close ends the pane's processes and frees it. It returns the number of
// processes it signalled.
func (p *Pane) close(grace time.Duration) int {
	n := killTree(p.pid, p.id, grace)
	select {
	case <-p.exited:
	case <-time.After(grace + time.Second):
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return n
	}
	p.closed = true
	p.pty.Close()
	for s := range p.subs {
		s.end()
	}
	p.broadcast()
	p.mu.Unlock()
	select {
	case <-p.done:
	case <-time.After(time.Second):
	}
	p.mu.Lock()
	p.log.close(!p.keep)
	p.screen.Close()
	p.mu.Unlock()
	return n
}
