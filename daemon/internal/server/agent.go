package server

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"time"
	"unicode"

	"golang.org/x/sys/unix"

	"ravenryd/internal/agent"
	"ravenryd/internal/pane"
	"ravenryd/internal/proto"
)

// The agent status channel (agent.*), and the pane methods that describe
// and restart what runs in a pane, or show it to a person.

const (
	maxReportData       = 256 << 10
	maxReportText       = 1000
	defaultDecideWait   = 2 * time.Second
	maxDecideWait       = 60 * time.Second
	defaultEventsLimit  = 200
	maxEventsLimit      = 1000
	maxReplyOutput      = 1 << 20
	maxReportSessionLen = 200
)

var assistantName = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,31}$`)

// paneEvent follows what panes report, for the agent states: an OSC 7501
// status report becomes an agent report, and a pane whose process exited
// or whose shell drew its prompt again no longer runs the agent it ran.
func (s *Server) paneEvent(ev pane.Event) {
	switch ev.Type {
	case "status":
		st := ev.Status
		if st == nil || st.ID != "" {
			return // only the program's own record, not the ones it nests
		}
		r := agent.Report{Pane: ev.Pane.ID, Source: agent.SourceProgram, Event: "status", Assistant: "program"}
		if assistantName.MatchString(st.App) {
			r.Assistant = st.App
		}
		r.Message = clip(firstNonEmpty(st.Message, st.Title), maxReportText)
		switch st.State {
		case "working":
			r.State = agent.Working
		case "blocked":
			r.State = agent.NeedsYou
			kind := st.Kind
			if kind == "" {
				kind = "other"
			}
			r.Need = &agent.Need{Kind: kind, Message: r.Message}
		default: // idle, done, error, clear
			r.State = agent.Idle
		}
		s.report(r)
	case "exited":
		if r, _, ok := s.agents.Gone(ev.Pane.ID, "exit"); ok {
			s.publish(r)
		}
	case "prompt":
		if ev.Pane.Shell != nil && ev.Pane.Shell.State == "prompt" {
			if r, _, ok := s.agents.Gone(ev.Pane.ID, "prompt"); ok {
				s.publish(r)
			}
		}
	case "closed":
		s.agents.Forget(ev.Pane.ID)
	}
}

// processAlive reports whether a process runs (or is a zombie not yet
// reaped).
func processAlive(pid int) bool {
	err := unix.Kill(pid, 0)
	return err == nil || err == unix.EPERM
}

// report records a report and tells the subscribers.
func (s *Server) report(r agent.Report) agent.Report {
	r, _ = s.agents.Add(r)
	s.publish(r)
	return r
}

// publish sends agent.report to every connection that subscribed to
// events, with the pane as it is now when the report names one.
func (s *Server) publish(r agent.Report) {
	ev := proto.Event{V: proto.Version, Type: "event", Event: "agent.report", Report: reportInfo(r)}
	if r.Pane != "" {
		if p, err := s.o.Manager.Get(r.Pane); err == nil {
			pi := s.paneInfo(p.Info())
			ev.Pane = &pi
		}
	}
	for _, c := range s.connections(func(c *conn) bool { return c.unwatch != nil }) {
		c.event(ev)
	}
}

// connections lists the connections for which keep (called with the
// connection's lock held) is true.
func (s *Server) connections(keep func(*conn) bool) []*conn {
	s.mu.Lock()
	all := make([]*conn, 0, len(s.conns))
	for c := range s.conns {
		all = append(all, c)
	}
	s.mu.Unlock()
	out := all[:0]
	for _, c := range all {
		c.mu.Lock()
		ok := keep(c)
		c.mu.Unlock()
		if ok {
			out = append(out, c)
		}
	}
	return out
}

func statusInfo(st *agent.Status) *proto.AgentStatus {
	if st == nil {
		return nil
	}
	return &proto.AgentStatus{
		State: st.State, Since: stamp(st.Since), Assistant: st.Assistant, Session: st.Session,
		Need: needInfo(st.Need), Event: st.Event, At: stamp(st.At), Source: st.Source, Seq: st.Seq,
	}
}

func needInfo(n *agent.Need) *proto.Need {
	if n == nil {
		return nil
	}
	return &proto.Need{Kind: n.Kind, Message: n.Message}
}

func reportInfo(r agent.Report) *proto.AgentReport {
	return &proto.AgentReport{
		Seq: r.Seq, At: stamp(r.At), Pane: r.Pane, Assistant: r.Assistant, Source: r.Source, Event: r.Event,
		Session: r.Session, State: r.State, Need: needInfo(r.Need), Message: r.Message, Cwd: r.Cwd, PID: r.PID,
		Data: json.RawMessage(r.Data),
	}
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8Start(s[cut]) {
		cut--
	}
	return s[:cut]
}

func utf8Start(b byte) bool { return b&0xc0 != 0x80 }

func firstNonEmpty(a ...string) string {
	for _, s := range a {
		if s != "" {
			return s
		}
	}
	return ""
}

func plainText(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// ------------------------------------------------------------ agent.*

func (c *conn) agentReport(id uint64, data []byte) {
	var r proto.AgentReportRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	rep, timeout, err := c.checkReport(r)
	if err != nil {
		c.failErr(id, err)
		return
	}
	rep = c.s.report(rep)
	if !r.Decide {
		c.reply(id, "agent.report", proto.AgentReportResult{Seq: rep.Seq})
		return
	}
	c.track(id, func(ctx context.Context) {
		reply, asked := c.s.decide(ctx, rep, timeout)
		if ctx.Err() != nil && c.ctx.Err() == nil {
			c.failErr(id, ctx.Err())
			return
		}
		c.reply(id, "agent.report", proto.AgentReportResult{Seq: rep.Seq, Asked: asked, Reply: reply})
	})
}

// checkReport validates an agent.report request.
func (c *conn) checkReport(r proto.AgentReportRequest) (agent.Report, time.Duration, error) {
	var zero agent.Report
	if !assistantName.MatchString(r.Assistant) {
		return zero, 0, bad("assistant must be 1 to 32 characters of a-z, 0-9, '.', '_' or '-', starting with a letter or digit")
	}
	if r.Event == "" || len(r.Event) > 64 || !plainText(r.Event) {
		return zero, 0, bad("event must be 1 to 64 characters with no control characters")
	}
	if len(r.Session) > maxReportSessionLen || !plainText(r.Session) {
		return zero, 0, bad("session must be at most %d characters with no control characters", maxReportSessionLen)
	}
	switch r.State {
	case "", agent.Working, agent.NeedsYou, agent.Idle, agent.Ended:
	default:
		return zero, 0, bad("state must be working, needs_you, idle or ended, not %q", r.State)
	}
	if r.Need != nil {
		if r.State != agent.NeedsYou {
			return zero, 0, bad("need goes with the state needs_you")
		}
		switch r.Need.Kind {
		case "permission", "question", "auth", "other":
		default:
			return zero, 0, bad("need.kind must be permission, question, auth or other")
		}
		if len(r.Need.Message) > maxReportText {
			return zero, 0, bad("need.message must be at most %d bytes", maxReportText)
		}
	}
	if len(r.Message) > maxReportText || len(r.Cwd) > 4096 {
		return zero, 0, bad("message must be at most %d bytes and cwd at most 4096", maxReportText)
	}
	if r.PID < 0 {
		return zero, 0, bad("pid must be positive")
	}
	if len(r.Data) > 0 {
		if len(r.Data) > maxReportData {
			return zero, 0, bad("data must be at most %d bytes", maxReportData)
		}
		var obj map[string]json.RawMessage
		if json.Unmarshal(r.Data, &obj) != nil || obj == nil {
			return zero, 0, bad("data must be a JSON object")
		}
	}
	timeout := defaultDecideWait
	if r.TimeoutMs != nil {
		t := time.Duration(*r.TimeoutMs) * time.Millisecond
		if !r.Decide || t <= 0 || t > maxDecideWait {
			return zero, 0, bad("timeout_ms goes with decide, between 1 and %d", maxDecideWait.Milliseconds())
		}
		timeout = t
	}
	if r.Pane != "" {
		if _, err := c.s.o.Manager.Get(r.Pane); err != nil {
			return zero, 0, err
		}
	}
	rep := agent.Report{
		Pane: r.Pane, Assistant: r.Assistant, Source: agent.SourceHook, Event: r.Event, Session: r.Session,
		State: r.State, Message: r.Message, Cwd: r.Cwd, PID: r.PID,
	}
	if r.Need != nil {
		rep.Need = &agent.Need{Kind: r.Need.Kind, Message: r.Need.Message}
	}
	if len(r.Data) > 0 {
		// Whatever the reporter sent, only the fields the status and the
		// hand-off read are kept and passed on: no prompt text, tool
		// input or output.
		rep.Data = agent.HookData(r.Data)
	}
	return rep, timeout, nil
}

// decide asks every decider about a report and returns the first reply
// that decides, or nil when none did before the timeout (or no decider is
// connected). asked is how many deciders were asked.
func (s *Server) decide(ctx context.Context, r agent.Report, timeout time.Duration) (*proto.Reply, int) {
	s.mu.Lock()
	if len(s.deciders) == 0 {
		s.mu.Unlock()
		return nil, 0
	}
	s.nextDec++
	id := s.nextDec
	d := &decision{asked: map[*conn]bool{}, ch: make(chan *proto.Reply, len(s.deciders))}
	for c := range s.deciders {
		d.asked[c] = true
	}
	s.decisions[id] = d
	asked := make([]*conn, 0, len(d.asked))
	for c := range d.asked {
		asked = append(asked, c)
	}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.decisions, id)
		s.mu.Unlock()
	}()
	ms := timeout.Milliseconds()
	ev := proto.Event{V: proto.Version, Type: "event", Event: "agent.decision", Request: &id, Report: reportInfo(r), TimeoutMs: &ms}
	for _, c := range asked {
		c.event(ev)
	}
	t := time.NewTimer(timeout)
	defer t.Stop()
	for range asked {
		select {
		case rep := <-d.ch:
			if rep != nil {
				return rep, len(asked)
			}
		case <-t.C:
			return nil, len(asked)
		case <-ctx.Done():
			return nil, len(asked)
		}
	}
	return nil, len(asked)
}

// dropDecider forgets a connection that closed: the decisions it was
// asked count as answered without a decision.
func (s *Server) dropDecider(c *conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.deciders, c)
	for _, d := range s.decisions {
		if d.asked[c] {
			delete(d.asked, c)
			d.ch <- nil
		}
	}
}

func (c *conn) agentEvents(id uint64, data []byte) {
	var r proto.AgentEventsRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	limit := defaultEventsLimit
	if r.Limit != nil {
		if *r.Limit < 1 || *r.Limit > maxEventsLimit {
			c.failErr(id, bad("limit must be between 1 and %d", maxEventsLimit))
			return
		}
		limit = *r.Limit
	}
	var since uint64
	if r.Since != nil {
		since = *r.Since
	}
	reps, last, truncated := c.s.agents.Since(r.Pane, since, limit)
	res := proto.AgentEventsResult{Reports: make([]proto.AgentReport, 0, len(reps)), Seq: last, Truncated: truncated}
	for _, rp := range reps {
		res.Reports = append(res.Reports, *reportInfo(rp))
	}
	c.reply(id, "agent.events", res)
}

func (c *conn) agentDecisions(id uint64, data []byte) {
	var r proto.AgentDecisionsRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	// Reply first, so the result comes before any agent.decision.
	c.reply(id, "agent.decisions", proto.Empty{})
	c.s.mu.Lock()
	c.s.deciders[c] = struct{}{}
	c.s.mu.Unlock()
}

func (c *conn) agentDecide(id uint64, data []byte) {
	var r proto.AgentDecideRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	if r.Request == nil {
		c.failErr(id, bad("request is required"))
		return
	}
	if rp := r.Reply; rp != nil {
		if rp.ExitCode < 0 || rp.ExitCode > 255 {
			c.failErr(id, bad("reply.exit_code must be between 0 and 255"))
			return
		}
		if len(rp.Stdout) > maxReplyOutput || len(rp.Stderr) > maxReplyOutput {
			c.failErr(id, bad("reply.stdout and reply.stderr must be at most %d bytes each", maxReplyOutput))
			return
		}
	}
	c.s.mu.Lock()
	d := c.s.decisions[*r.Request]
	if d == nil || !d.asked[c] {
		c.s.mu.Unlock()
		c.failErr(id, fmt.Errorf("%w: decision %d is not waiting for this connection (it timed out, or was answered)", pane.ErrNotFound, *r.Request))
		return
	}
	delete(d.asked, c)
	d.ch <- r.Reply
	c.s.mu.Unlock()
	c.reply(id, "agent.decide", proto.Empty{})
}

// ------------------------------------------------------------ pane.*

func (c *conn) paneProcess(id uint64, data []byte) {
	var r proto.ProcessRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	p, err := c.pane(r.Pane)
	if err != nil {
		c.failErr(id, err)
		return
	}
	pr, err := p.Foreground()
	if err != nil {
		c.failErr(id, err)
		return
	}
	fg := proto.Process{PID: pr.PID, Argv: pr.Argv, Exe: pr.Exe, Cwd: pr.Cwd, StartedAt: stamp(pr.Started)}
	if fg.Argv == nil {
		fg.Argv = []string{}
	}
	c.reply(id, "pane.process", proto.ProcessResult{Pane: r.Pane, Foreground: fg})
}

func (c *conn) paneRestart(id uint64, data []byte) {
	var r proto.RestartRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	grace := time.Second
	if r.GraceMs != nil {
		if *r.GraceMs < 0 || *r.GraceMs > 60000 {
			c.failErr(id, bad("grace_ms must be between 0 and 60000"))
			return
		}
		grace = time.Duration(*r.GraceMs) * time.Millisecond
	}
	if _, err := c.pane(r.Pane); err != nil {
		c.failErr(id, err)
		return
	}
	c.track(id, func(context.Context) {
		np, old, err := c.s.o.Manager.Restart(r.Pane, grace)
		if err != nil {
			c.failErr(id, err)
			return
		}
		c.reply(id, "pane.restart", proto.RestartResult{Pane: c.s.paneInfo(np.Info()), Replaced: c.s.paneInfo(old)})
	})
}

func (c *conn) paneFocus(id uint64, data []byte) {
	var r proto.FocusRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	p, err := c.pane(r.Pane)
	if err != nil {
		c.failErr(id, err)
		return
	}
	pi := c.s.paneInfo(p.Info())
	displays := c.s.connections(func(x *conn) bool { return x.unwatch != nil && x.display })
	// Reply first, so the asking connection, when it displays panes too,
	// gets its result before the event.
	c.reply(id, "pane.focus", proto.FocusResult{Displays: len(displays)})
	for _, x := range displays {
		x.event(proto.Event{V: proto.Version, Type: "event", Event: "pane.focus", Pane: &pi})
	}
}
