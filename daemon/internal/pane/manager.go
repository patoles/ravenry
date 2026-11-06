package pane

import (
	"errors"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"ravenryd/internal/vt"
)

// Event is a change in the set of panes, or something a pane's program
// reported.
type Event struct {
	// Type is "created", "exited", "closed", "title", "prompt" (the
	// shell's OSC 133 state changed) or "status" (an OSC 7501 report,
	// in Status).
	Type   string
	Pane   Info
	Status *vt.ProgramStatus
}

// ManagerOptions configures a Manager.
type ManagerOptions struct {
	// LogDir holds the pane logs.
	LogDir string
	// LogCap caps each pane's log; zero means 16 MiB.
	LogCap int64
	// Socket is the daemon's socket, given to panes as RAVENRY_SOCKET.
	Socket string
	// Env is the base environment for panes; nil means the daemon's.
	Env []string
	// KeepExited is how long a pane stays after its process exits, so its
	// screen can still be read; zero means one hour.
	KeepExited time.Duration
	// LogAge is how old a closed pane's log may get before it is removed;
	// zero means seven days.
	LogAge time.Duration
	// ShellDir is where the shell integration files are written (shell.go);
	// empty means panes get no shell integration.
	ShellDir string
}

// Manager holds a daemon's panes.
type Manager struct {
	o        ManagerOptions
	shell    string // the shell integration folder, or empty
	mu       sync.Mutex
	panes    map[string]*Pane
	watchers map[int]func(Event)
	nextW    int
	closing  bool
}

// DefaultLogCap is the default size cap of a pane's log.
const DefaultLogCap = 16 << 20

// ErrNotFound is returned for an unknown pane id.
var ErrNotFound = errors.New("no such pane")

// NewManager returns a Manager and removes old pane logs.
func NewManager(o ManagerOptions) *Manager {
	if o.LogCap == 0 {
		o.LogCap = DefaultLogCap
	}
	if o.Env == nil {
		o.Env = os.Environ()
	}
	if o.KeepExited == 0 {
		o.KeepExited = time.Hour
	}
	if o.LogAge == 0 {
		o.LogAge = 7 * 24 * time.Hour
	}
	m := &Manager{o: o, panes: map[string]*Pane{}, watchers: map[int]func(Event){}}
	m.pruneLogs()
	if o.ShellDir != "" {
		// Without the files, shells start as they are.
		m.shell, _ = installShell(o.ShellDir)
	}
	return m
}

func (m *Manager) pruneLogs() {
	ents, err := os.ReadDir(m.o.LogDir)
	if err != nil {
		return
	}
	for _, e := range ents {
		if !strings.Contains(e.Name(), ".log") {
			continue
		}
		if fi, err := e.Info(); err == nil && time.Since(fi.ModTime()) > m.o.LogAge {
			os.Remove(filepath.Join(m.o.LogDir, e.Name()))
		}
	}
}

// Watch calls fn for every event until cancel is called. fn must not
// block.
func (m *Manager) Watch(fn func(Event)) (cancel func()) {
	m.mu.Lock()
	id := m.nextW
	m.nextW++
	m.watchers[id] = fn
	m.mu.Unlock()
	return func() {
		m.mu.Lock()
		delete(m.watchers, id)
		m.mu.Unlock()
	}
}

func (m *Manager) emit(typ string, info Info) {
	m.emitEvent(Event{Type: typ, Pane: info})
}

func (m *Manager) emitEvent(ev Event) {
	m.mu.Lock()
	fns := make([]func(Event), 0, len(m.watchers))
	for _, fn := range m.watchers {
		fns = append(fns, fn)
	}
	m.mu.Unlock()
	for _, fn := range fns {
		fn(ev)
	}
}

// New starts a pane.
func (m *Manager) New(cfg Config) (*Pane, error) {
	if cfg.TTL < 0 {
		return nil, errors.New("ttl must not be negative")
	}
	if cfg.TTL > 0 && !cfg.Hidden {
		return nil, errors.New("only a hidden pane can have a ttl")
	}
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return nil, errors.New("the daemon is shutting down")
	}
	m.mu.Unlock()
	p, err := start(cfg, m.o.Env, m.o.LogDir, m.o.LogCap, m.o.Socket, m.shell)
	if err != nil {
		return nil, err
	}
	p.keep = !cfg.Hidden
	p.onTitle = func(p *Pane) { m.emit("title", p.Info()) }
	p.onPrompt = func(p *Pane, sh Shell) {
		// The shell as it was at this mark, which a later mark in the
		// same chunk may have moved on from.
		i := p.Info()
		i.Shell = &sh
		m.emit("prompt", i)
	}
	p.onStatus = func(p *Pane, st vt.ProgramStatus) {
		m.emitEvent(Event{Type: "status", Pane: p.Info(), Status: &st})
	}
	p.onExit = func(p *Pane) {
		m.emit("exited", p.Info())
		time.AfterFunc(m.o.KeepExited, func() { m.Close(p.id, time.Second) })
	}
	m.mu.Lock()
	m.panes[p.id] = p
	m.mu.Unlock()
	if cfg.TTL > 0 {
		time.AfterFunc(cfg.TTL, func() { m.Close(p.id, time.Second) })
	}
	m.emit("created", p.Info())
	return p, nil
}

// Get returns a pane by id.
func (m *Manager) Get(id string) (*Pane, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.panes[id]
	if !ok {
		return nil, ErrNotFound
	}
	return p, nil
}

// List describes the panes, oldest first.
func (m *Manager) List(hidden bool) []Info {
	m.mu.Lock()
	ps := make([]*Pane, 0, len(m.panes))
	for _, p := range m.panes {
		ps = append(ps, p)
	}
	m.mu.Unlock()
	out := make([]Info, 0, len(ps))
	for _, p := range ps {
		if i := p.Info(); hidden || !i.Hidden {
			out = append(out, i)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created.Before(out[j].Created) })
	return out
}

// Running counts the panes whose first process is still running.
func (m *Manager) Running() int {
	n := 0
	for _, i := range m.List(true) {
		if i.Running() {
			n++
		}
	}
	return n
}

// Count counts the panes, running or not.
func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.panes)
}

// Close ends a pane's processes and removes it. grace is how long its
// processes get to end after SIGHUP before SIGKILL. It returns how many
// processes were signalled.
func (m *Manager) Close(id string, grace time.Duration) (Info, int, error) {
	m.mu.Lock()
	p, ok := m.panes[id]
	if ok {
		delete(m.panes, id)
	}
	m.mu.Unlock()
	if !ok {
		return Info{}, 0, ErrNotFound
	}
	info := p.Info()
	n := p.close(grace)
	select {
	case <-p.exited:
	case <-time.After(time.Second):
	}
	info = withExit(info, p)
	m.emit("closed", info)
	return info, n, nil
}

func withExit(i Info, p *Pane) Info {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.exit != nil {
		e := *p.exit
		i.Exit = &e
		i.ExitedAt = p.exitedAt
	}
	i.Mark = p.offset
	return i
}

// Restart closes a pane (as Close does) and starts its command again: the
// same command, working directory, environment, name, hidden and TTL
// settings and scrollback, at the pane's current size. The new pane has a
// new id. It returns the new pane and the old one as it ended.
func (m *Manager) Restart(id string, grace time.Duration) (*Pane, Info, error) {
	m.mu.Lock()
	p, ok := m.panes[id]
	m.mu.Unlock()
	if !ok {
		return nil, Info{}, ErrNotFound
	}
	cfg := p.orig
	cfg.Env = maps.Clone(p.orig.Env)
	cfg.Command = slices.Clone(p.orig.Command)
	if info := p.Info(); info.Cols > 0 {
		cfg.Cols, cfg.Rows = info.Cols, info.Rows
	}
	old, _, err := m.Close(id, grace)
	if err != nil {
		return nil, Info{}, err
	}
	np, err := m.New(cfg)
	if err != nil {
		return nil, old, err
	}
	return np, old, nil
}

// Shutdown closes every pane.
func (m *Manager) Shutdown(grace time.Duration) {
	m.mu.Lock()
	m.closing = true
	ids := make([]string, 0, len(m.panes))
	for id := range m.panes {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m.Close(id, grace)
		}()
	}
	wg.Wait()
}
