// Package agent keeps what the agents in a daemon's panes report: every
// report in a capped ring, and the state of the agent in each pane
// (working, needs you, idle, ended).
//
// Reports come from three sources:
//
//   - "hook": an assistant's hook, through `ravenryd hook` and the
//     agent.report method.
//   - "program": an OSC 7501 program status report the program printed.
//   - "daemon": what the daemon infers: the pane's process exited, or the
//     shell showed a prompt again, so the agent that ran there is gone.
package agent

import (
	"sync"
	"time"
)

// States.
const (
	Working  = "working"
	NeedsYou = "needs_you"
	Idle     = "idle"
	Ended    = "ended"
)

// Sources.
const (
	SourceHook    = "hook"
	SourceProgram = "program"
	SourceDaemon  = "daemon"
)

// Program is what a program said of itself with OSC 7501, or what the
// daemon saw become of it: its state ("working", "blocked", "done",
// "error"; in a report also "idle" and "clear", which end it), the kind of
// a block, its progress (0 to 100, or -1 when it gave none), its message
// and its app name.
type Program struct {
	State    string
	Kind     string
	Progress int
	Message  string
	App      string
	// Since, in a status, is when it entered this state.
	Since time.Time
}

// Program states a status keeps; the others ("idle", "clear") end it.
func programKept(state string) bool {
	return state == "working" || state == "blocked" || state == "done" || state == "error"
}

// Need is what an agent waits for from a person.
type Need struct {
	// Kind is "permission", "question", "auth" or "other".
	Kind    string
	Message string
}

// Report is one agent event.
type Report struct {
	Seq       uint64
	At        time.Time
	Pane      string
	Assistant string
	Source    string
	Event     string
	Session   string
	// State is the state the report puts the agent in; empty changes none.
	State   string
	Need    *Need
	Message string
	Cwd     string
	PID     int
	// Data is what HookData keeps of the hook's input (a JSON object),
	// or nil.
	Data []byte
	// Program is set on a program's own report, and on the daemon's
	// report of what became of it (its outcome at the prompt, cleared
	// when a new command starts).
	Program *Program
}

// Status is the state of the agent in one pane.
type Status struct {
	State     string
	Since     time.Time
	Assistant string
	Session   string
	Need      *Need
	// Event, At, Source and Seq are the last report's.
	Event  string
	At     time.Time
	Source string
	Seq    uint64
	// PID is the agent's process, from the last hook report (0 when it
	// did not say).
	PID int
	// Program is the program's own record (OSC 7501) while it says
	// working, blocked, done or error; nil otherwise. Done and error
	// stay until the program says idle or clear, or a new command
	// starts in the pane's shell.
	Program *Program
}

// Limits of the ring of reports.
const (
	MaxReports   = 2048
	MaxRingBytes = 16 << 20
)

// Tracker holds the reports and the states. It is safe for concurrent use.
type Tracker struct {
	mu     sync.Mutex
	seq    uint64
	ring   []Report
	bytes  int
	status map[string]*Status
	now    func() time.Time
	// Alive, when set, reports whether a process still runs. An agent
	// whose process still runs is not gone at a prompt (see Gone).
	Alive func(pid int) bool
}

// New returns an empty Tracker.
func New() *Tracker {
	return &Tracker{status: map[string]*Status{}, now: time.Now}
}

func size(r *Report) int { return len(r.Data) + len(r.Message) + 256 }

// Add records a report: it gets the next sequence number and the time,
// and when it names a pane it updates that pane's agent. It returns the
// report as recorded and the pane's status after it (nil for a report
// without a pane).
func (t *Tracker) Add(r Report) (Report, *Status) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.seq++
	r.Seq = t.seq
	if r.At.IsZero() {
		r.At = t.now()
	}
	if r.State != NeedsYou {
		r.Need = nil
	}
	t.ring = append(t.ring, r)
	t.bytes += size(&r)
	for len(t.ring) > 1 && (len(t.ring) > MaxReports || t.bytes > MaxRingBytes) {
		t.bytes -= size(&t.ring[0])
		t.ring[0] = Report{}
		t.ring = t.ring[1:]
	}
	if r.Pane == "" {
		return r, nil
	}
	st := t.status[r.Pane]
	if st == nil {
		st = &Status{State: Idle, Since: r.At}
		t.status[r.Pane] = st
	}
	if r.Assistant != "" {
		st.Assistant = r.Assistant
	}
	if r.Session != "" {
		st.Session = r.Session
	}
	if r.State != "" && (r.State != st.State || r.State == NeedsYou) {
		if r.State != st.State {
			st.Since = r.At
		}
		st.State = r.State
	}
	if st.State == NeedsYou {
		if r.State == NeedsYou {
			st.Need = r.Need
		}
	} else {
		st.Need = nil
	}
	st.Event, st.At, st.Source, st.Seq = r.Event, r.At, r.Source, r.Seq
	if r.Source == SourceHook {
		st.PID = r.PID
	}
	if pr := r.Program; pr != nil {
		if programKept(pr.State) {
			np := *pr
			np.Since = r.At
			if st.Program != nil && st.Program.State == pr.State {
				np.Since = st.Program.Since
			}
			// Blocked with no progress of its own waits where its work
			// stood: it keeps the last progress.
			if pr.State == "blocked" && pr.Progress < 0 && st.Program != nil && (st.Program.State == "working" || st.Program.State == "blocked") {
				np.Progress = st.Program.Progress
			}
			st.Program = &np
		} else {
			st.Program = nil
		}
	}
	return r, st.copy()
}

func (s *Status) copy() *Status {
	c := *s
	if s.Need != nil {
		n := *s.Need
		c.Need = &n
	}
	if s.Program != nil {
		p := *s.Program
		c.Program = &p
	}
	return &c
}

// Status returns the agent state of a pane, or nil when no agent reported
// there.
func (t *Tracker) Status(pane string) *Status {
	t.mu.Lock()
	defer t.mu.Unlock()
	if st := t.status[pane]; st != nil {
		return st.copy()
	}
	return nil
}

// Gone ends the agent of a pane whose program is gone: the pane's
// process exited (event "exit"), or the shell drew a prompt again after a
// command ended (event "prompt"). An agent that is working or needs you
// then ended. After a hook report it counts as ended; a program's own
// status report counts as idle (OSC 7501 asks to drop working and
// blocked records at the next prompt). At a prompt, an agent whose hook
// named a process that still runs (Alive) is not gone: its hook ran from
// the shell itself, not from a program that has now ended. It returns the
// report it recorded, or false when nothing changed.
func (t *Tracker) Gone(pane, event string) (Report, *Status, bool) {
	return t.GoneExit(pane, event, 0, false)
}

// GoneExit is Gone with the exit status of the command or process that
// ended, when known. A program whose own record still said working or
// blocked ends as done (status 0) or error (any other status but 130, an
// interrupt the person typed); with no status, or after an interrupt,
// its record is cleared.
func (t *Tracker) GoneExit(pane, event string, code int, known bool) (Report, *Status, bool) {
	t.mu.Lock()
	st := t.status[pane]
	if st == nil || st.State == Ended || (st.State == Idle && (event == "prompt" || st.Source == SourceProgram)) ||
		(event == "prompt" && st.Source == SourceHook && st.PID > 0 && t.Alive != nil && t.Alive(st.PID)) {
		t.mu.Unlock()
		return Report{}, nil, false
	}
	state := Ended
	var prog *Program
	if st.Source == SourceProgram {
		state = Idle
		if st.Program != nil && (st.Program.State == "working" || st.Program.State == "blocked") {
			out := "clear"
			if known && code == 0 {
				out = "done"
			} else if known && code != 130 {
				out = "error"
			}
			prog = &Program{State: out, Progress: -1, App: st.Program.App}
		}
	}
	assistant, session := st.Assistant, st.Session
	t.mu.Unlock()
	r, s := t.Add(Report{Pane: pane, Assistant: assistant, Session: session, Source: SourceDaemon, Event: event, State: state, Program: prog})
	return r, s, true
}

// NewCommand clears a program's done or error record when a new command
// starts in the pane's shell (OSC 133 C): what it said is about a command
// that is over. It returns the report it recorded, or false when there
// was nothing to clear.
func (t *Tracker) NewCommand(pane string) (Report, *Status, bool) {
	t.mu.Lock()
	st := t.status[pane]
	if st == nil || st.Program == nil || (st.Program.State != "done" && st.Program.State != "error") {
		t.mu.Unlock()
		return Report{}, nil, false
	}
	assistant, session, app := st.Assistant, st.Session, st.Program.App
	t.mu.Unlock()
	r, s := t.Add(Report{Pane: pane, Assistant: assistant, Session: session, Source: SourceDaemon, Event: "command", Program: &Program{State: "clear", Progress: -1, App: app}})
	return r, s, true
}

// Forget drops a closed pane's state. Its reports stay in the ring.
func (t *Tracker) Forget(pane string) {
	t.mu.Lock()
	delete(t.status, pane)
	t.mu.Unlock()
}

// Since returns up to limit reports after seq, oldest first, of one pane
// when pane is not empty. truncated is true when the ring no longer holds
// every report after seq. last is the newest sequence number.
func (t *Tracker) Since(pane string, seq uint64, limit int) (out []Report, last uint64, truncated bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.ring) > 0 && t.ring[0].Seq > seq+1 {
		truncated = true
	}
	for _, r := range t.ring {
		if r.Seq <= seq || (pane != "" && r.Pane != pane) {
			continue
		}
		if len(out) == limit {
			break
		}
		out = append(out, r)
	}
	return out, t.seq, truncated
}
