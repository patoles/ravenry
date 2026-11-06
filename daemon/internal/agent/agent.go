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
	return r, st.copy()
}

func (s *Status) copy() *Status {
	c := *s
	if s.Need != nil {
		n := *s.Need
		c.Need = &n
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
// blocked records at the next prompt). It returns the report it recorded,
// or false when nothing changed.
func (t *Tracker) Gone(pane, event string) (Report, *Status, bool) {
	t.mu.Lock()
	st := t.status[pane]
	if st == nil || st.State == Ended || (st.State == Idle && (event == "prompt" || st.Source == SourceProgram)) {
		t.mu.Unlock()
		return Report{}, nil, false
	}
	state := Ended
	if st.Source == SourceProgram {
		state = Idle
	}
	assistant, session := st.Assistant, st.Session
	t.mu.Unlock()
	r, s := t.Add(Report{Pane: pane, Assistant: assistant, Session: session, Source: SourceDaemon, Event: event, State: state})
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
