package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/paths"
	"ravenryd/internal/proto"
)

// `ravenry events`: one line per thing that happens, as it happens, for an
// agent that would otherwise poll. It follows, merged into one feed:
//
//   - every daemon on this machine (one per installed version), each on its
//     own connection (events.subscribe), found again every second, so a
//     daemon that starts later joins and one that goes says so;
//   - the board (the hub): its own events (a session needs you or stops
//     needing you, started or ended on the board, a hand-off ready) and the
//     daemons of the person's other machines, which the board follows over
//     ssh, from GET /api/feed on 127.0.0.1.
//
// A card (checkpoint) comes from the daemon that holds it, so each is said
// once. Its answer is given only to the card's own asker (this command run
// in the pane that asked, as `ravenry checkpoint` gives it); a secret's
// value is never anywhere: the daemon only ever holds `delivered`.
//
// The event names and their fields are API (PROTOCOL.md, "The feed for
// agents"): add to them, never rename.

// feedKinds is every event the feed says, in the order help lists them.
var feedKinds = []struct{ name, when string }{
	{"pane.created", "a pane started (name, command, cwd)"},
	{"pane.title", "its title changed (title)"},
	{"pane.cwd", "its working folder changed (cwd)"},
	{"pane.prompt", "its shell started or ended a command (shell: state, command, exit_code)"},
	{"pane.updated", "its name or labels changed (name, labels)"},
	{"pane.exited", "its program exited (exit: code, signal)"},
	{"pane.closed", "it was closed and removed"},
	{"agent.report", "an agent's hook or a program reported (report: assistant, event, state, need, message, session)"},
	{"checkpoint.opened", "a card waits for the person (checkpoint: id, kind, title, pane)"},
	{"checkpoint.running", "the person let an approved command run"},
	{"checkpoint.answered", "the person answered it (answer and run: only to its asker)"},
	{"checkpoint.declined", "the person declined it (answer: only to its asker)"},
	{"checkpoint.cancelled", "it was withdrawn (reason, answered_in)"},
	{"checkpoint.expired", "nobody answered it in time"},
	{"session.started", "a session came on the board (session, project, pane)"},
	{"session.ended", "a session left the board"},
	{"session.needs_you", "a session waits for the person (why, line)"},
	{"session.needs_you_cleared", "it no longer does"},
	{"handoff.ready", "a session wrote its hand-off (handoff.file)"},
	{"daemon.up", "a daemon came (back): on this machine, or another machine's connection"},
	{"daemon.down", "a daemon went away, or the connection to its machine dropped"},
	{"daemon.draining", "a newer daemon runs beside this one (newer)"},
	{"board.up", "the board answers again (url)"},
	{"board.down", "the board stopped answering (url)"},
}

// exitNoMatch: --timeout passed and no event matched.
const exitNoMatch = exitTimeout

// feedEvent is one event as the feed prints it.
type feedEvent map[string]any

// kindFilter says whether an event is one of the kinds asked for: a name
// ("pane.exited") or a group ("pane", "pane.*", "checkpoint").
func kindFilter(kinds []string) (func(string) bool, error) {
	if len(kinds) == 0 {
		return func(string) bool { return true }, nil
	}
	var exact, groups []string
	for _, k := range kinds {
		for _, k := range strings.Split(k, ",") {
			k = strings.TrimSpace(k)
			if k == "" {
				continue
			}
			g := strings.TrimSuffix(k, ".*")
			ok := false
			for _, f := range feedKinds {
				if f.name == k {
					exact, ok = append(exact, k), true
					break
				}
				if strings.HasPrefix(f.name, g+".") {
					ok = true
				}
			}
			if !ok {
				return nil, fmt.Errorf("--kind %q is no event; `ravenry events --help` lists them", k)
			}
			if !strings.Contains(k, ".") || strings.HasSuffix(k, ".*") {
				groups = append(groups, g+".")
			}
		}
	}
	return func(name string) bool {
		for _, k := range exact {
			if k == name {
				return true
			}
		}
		for _, g := range groups {
			if strings.HasPrefix(name, g) {
				return true
			}
		}
		return false
	}, nil
}

func eventsHelp() string {
	var b strings.Builder
	b.WriteString("ravenry events [--pane P]... [--kind K]... [--once] [--timeout D] [--json]\n\n")
	b.WriteString("What happens, one line per event as it happens, until interrupted: every daemon on\n")
	b.WriteString("this machine, the board, and the person's other machines through the board, merged.\n")
	b.WriteString("Each event says its machine (\"local\" for this one). Follow events instead of polling.\n\n")
	c := cmdByName("events")
	for _, f := range c.flags {
		fmt.Fprintf(&b, "  %-22s %s\n", flagLine(f), f.help)
	}
	fmt.Fprintf(&b, "  %-22s %s\n", "--json", "one JSON object per line")
	b.WriteString("\nExit: 0 at the first match with --once, or after --timeout when something matched;\n")
	fmt.Fprintf(&b, "%d when --timeout passed and nothing matched; 1 on a bad flag.\n", exitNoMatch)
	b.WriteString("\nEvents (--kind takes a name, or a group: pane, agent, checkpoint, session, handoff, daemon, board):\n")
	for _, f := range feedKinds {
		fmt.Fprintf(&b, "  %-26s %s\n", f.name, f.when)
	}
	b.WriteString("\nEvery event has event, at, machine; one about a pane has pane (its id) and, when known, pane_name.\n")
	b.WriteString("\nWhen the build pane ends, run the tests:\n\n")
	b.WriteString("  ravenry events --once --kind pane.exited --pane build && npm test\n")
	return b.String()
}

func cmdEvents(in []string) error {
	for _, s := range in {
		if s == "--help" || s == "-h" {
			fmt.Print(eventsHelp())
			return nil
		}
		if s == "--" {
			break
		}
	}
	a, err := parse(in, specOf("events"))
	if err != nil {
		return err
	}
	if len(a.pos) > 0 {
		return fmt.Errorf("usage: ravenry events [--pane P] [--kind K] [--once] [--timeout D] [--json]")
	}
	kindOK, err := kindFilter(a.lists["kind"])
	if err != nil {
		return err
	}
	var timeout time.Duration
	if v := a.values["timeout"]; v != "" {
		if timeout, err = duration(v); err != nil {
			return err
		}
		if timeout <= 0 {
			return fmt.Errorf("--timeout must be more than 0")
		}
	}
	f := &feed{
		out:   make(chan feedEvent, 1024),
		names: map[string]string{},
		self:  os.Getenv("RAVENRY_PANE"),
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// --socket pins one daemon; RAVENRY_SOCKET (set in every pane) does
	// not: the feed is every daemon's.
	ready := make(chan string, 2)
	go f.followDaemons(ctx, a.values["socket"], ready)
	go f.followBoard(ctx, hubURL(), ready)
	var deadline <-chan time.Time
	if timeout > 0 {
		t := time.NewTimer(timeout)
		defer t.Stop()
		deadline = t.C
	}
	said := []string{}
	matched := 0
	for {
		select {
		case s := <-ready:
			said = append(said, s)
			if len(said) == 2 {
				fmt.Fprintf(os.Stderr, "ravenry events: following %s, and %s\n", said[0], said[1])
			}
		case <-deadline:
			if matched > 0 {
				return nil
			}
			fmt.Fprintf(os.Stderr, "ravenry events: nothing matched in %s\n", timeout)
			return exitCode(exitNoMatch)
		case ev := <-f.out:
			name, _ := ev["event"].(string)
			if !kindOK(name) || !f.paneOK(ev, a.lists["pane"]) {
				continue
			}
			if p, _ := ev["pane"].(string); p != "" {
				if n := f.nameOf(ev); n != "" {
					ev["pane_name"] = n
				}
			}
			if a.g.json {
				if _, err := os.Stdout.Write(append(encodeEvent(ev), '\n')); err != nil {
					return nil // the reader went away
				}
			} else if _, err := fmt.Println(humanEvent(ev)); err != nil {
				return nil
			}
			matched++
			if a.bools["once"] {
				return nil
			}
		}
	}
}

// feed merges the sources into out.
type feed struct {
	out   chan feedEvent
	mu    sync.Mutex
	names map[string]string // machine + "/" + pane id -> its name
	self  string            // RAVENRY_PANE: the asker this command answers for
}

func (f *feed) emit(ctx context.Context, ev feedEvent) {
	select {
	case f.out <- ev:
	case <-ctx.Done():
	}
}

func (f *feed) setName(machine, id, name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if name == "" {
		delete(f.names, machine+"/"+id)
	} else {
		f.names[machine+"/"+id] = name
	}
}

func (f *feed) nameOf(ev feedEvent) string {
	m, _ := ev["machine"].(string)
	p, _ := ev["pane"].(string)
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.names[m+"/"+p]
}

// paneOK: no --pane, or the event is about one of them (its id or name).
func (f *feed) paneOK(ev feedEvent, panes []string) bool {
	if len(panes) == 0 {
		return true
	}
	p, _ := ev["pane"].(string)
	if p == "" {
		return false
	}
	n := f.nameOf(ev)
	if n == "" {
		n, _ = ev["name"].(string)
	}
	for _, want := range panes {
		if want == p || (n != "" && want == n) {
			return true
		}
	}
	return false
}

func stamp() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

// ------------------------------------------------------------ daemons

type followed struct {
	c       *client.Client
	version string
	pid     int
}

func daemonEvent(name, socket string, d *followed) feedEvent {
	return feedEvent{"event": name, "at": stamp(), "machine": "local", "daemon": d.version, "pid": d.pid, "socket": socket}
}

// followDaemons follows every daemon in the runtime folder (or the one
// --socket names) until ctx ends. The first look is silent; after it, a
// daemon that comes is daemon.up and one that goes is daemon.down.
func (f *feed) followDaemons(ctx context.Context, pinned string, ready chan<- string) {
	conns := map[string]*followed{}
	gone := make(chan string, 16)
	first := true
	for {
		var socks []string
		if pinned != "" {
			socks = []string{pinned}
		} else {
			ss, _ := paths.Sockets()
			for _, s := range ss {
				socks = append(socks, s.Path)
			}
		}
		for _, s := range socks {
			if conns[s] != nil {
				continue
			}
			d := f.subscribe(ctx, s)
			if d == nil {
				continue
			}
			conns[s] = d
			if !first {
				f.emit(ctx, daemonEvent("daemon.up", s, d))
			}
			go func(s string, d *followed) {
				for ev := range d.c.Events() {
					if fe := f.fromDaemon(ev, "local", d.version); fe != nil {
						f.emit(ctx, fe)
					}
				}
				gone <- s
			}(s, d)
		}
		if first {
			first = false
			vs := []string{}
			for _, d := range conns {
				vs = append(vs, d.version)
			}
			sort.Strings(vs)
			switch len(vs) {
			case 0:
				ready <- "no daemon on this machine yet (one that starts joins)"
			case 1:
				ready <- "1 daemon on this machine (" + vs[0] + ")"
			default:
				ready <- fmt.Sprintf("%d daemons on this machine (%s)", len(vs), strings.Join(vs, ", "))
			}
		}
		select {
		case <-ctx.Done():
			for _, d := range conns {
				d.c.Close()
			}
			return
		case s := <-gone:
			d := conns[s]
			delete(conns, s)
			d.c.Close()
			f.emit(ctx, daemonEvent("daemon.down", s, d))
		case <-time.After(time.Second):
		}
	}
}

// subscribe connects to one daemon, subscribes to its events and learns
// its panes' names; nil when it does not answer.
func (f *feed) subscribe(ctx context.Context, socket string) *followed {
	cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	c, err := dial(cctx, socket)
	if err != nil {
		return nil
	}
	if err := c.SubscribeEvents(cctx); err != nil {
		c.Close()
		return nil
	}
	var l proto.ListResult
	if c.Call(cctx, "pane.list", map[string]any{"hidden": true}, &l) == nil {
		for _, p := range l.Panes {
			f.setName("local", p.ID, p.Name)
		}
	}
	return &followed{c: c, version: c.Hello.Daemon.Version, pid: c.Hello.Daemon.PID}
}

// fromDaemon is a daemon's event as the feed says it, or nil for one the
// feed leaves out (pane.input, pane.lease, agent.decision, ...). A card's
// answer and run are kept only for its asker: this command run in the pane
// that asked, on this machine.
func (f *feed) fromDaemon(ev proto.Event, machine, version string) feedEvent {
	e := feedEvent{"event": ev.Event, "at": stamp(), "machine": machine, "daemon": version}
	switch ev.Event {
	case "pane.created", "pane.title", "pane.cwd", "pane.prompt", "pane.updated", "pane.exited", "pane.closed":
		p := ev.Pane
		if p == nil {
			return nil
		}
		e["pane"] = p.ID
		if p.Name != "" {
			e["name"] = p.Name
		}
		switch ev.Event {
		case "pane.created":
			f.setName(machine, p.ID, p.Name)
			e["command"], e["cwd"] = p.Command, p.Cwd
			if p.Hidden {
				e["hidden"] = true
			}
		case "pane.title":
			e["title"] = p.Title
		case "pane.cwd":
			e["cwd"] = p.Cwd
		case "pane.prompt":
			if p.Shell != nil {
				e["shell"] = p.Shell
			}
		case "pane.updated":
			f.setName(machine, p.ID, p.Name)
			if p.Labels != nil {
				e["labels"] = p.Labels
			} else {
				e["labels"] = map[string]string{}
			}
		case "pane.exited", "pane.closed":
			if p.Exit != nil {
				e["exit"] = p.Exit
			}
		}
	case "agent.report":
		r := ev.Report
		if r == nil {
			return nil
		}
		if r.Pane != "" {
			e["pane"] = r.Pane
		}
		rep := map[string]any{"assistant": r.Assistant, "event": r.Event, "source": r.Source}
		for k, v := range map[string]string{"state": r.State, "message": r.Message, "session": r.Session} {
			if v != "" {
				rep[k] = v
			}
		}
		if r.Need != nil {
			rep["need"] = r.Need
		}
		e["report"] = rep
	case "checkpoint.opened", "checkpoint.running", "checkpoint.closed":
		cp := ev.Checkpoint
		if cp == nil {
			return nil
		}
		if ev.Event == "checkpoint.closed" {
			switch cp.State {
			case "answered", "declined", "cancelled", "expired":
				e["event"] = "checkpoint." + cp.State
			default:
				return nil
			}
		}
		if cp.Pane != "" {
			e["pane"] = cp.Pane
		}
		c := map[string]any{"id": cp.ID, "kind": cp.Kind, "state": cp.State, "title": cp.Title}
		for k, v := range map[string]string{"pane": cp.Pane, "assistant": cp.Assistant, "reason": cp.Reason, "answered_in": cp.AnsweredIn, "expires_at": cp.ExpiresAt, "closed_at": cp.ClosedAt} {
			if v != "" {
				c[k] = v
			}
		}
		e["checkpoint"] = c
		if machine == "local" && f.self != "" && cp.Pane == f.self {
			if cp.Answer != nil {
				ans := *cp.Answer
				if cp.Kind == "secret" {
					// Only ever "delivered": the value never reaches a daemon's
					// record. Said here too, so no field can carry one.
					ans = proto.CheckpointAnswer{Delivered: ans.Delivered, Declined: ans.Declined, Reason: ans.Reason, By: ans.By, At: ans.At}
				}
				e["answer"] = ans
			}
			if cp.Run != nil && cp.Kind != "secret" {
				e["run"] = cp.Run
			} else if cp.Run != nil && cp.Run.Exit != nil {
				e["run"] = map[string]any{"pane": cp.Run.Pane, "exit": cp.Run.Exit}
			}
		}
	case "daemon.draining":
		e["newer"] = ev.Newer
	default:
		return nil
	}
	return e
}

// ------------------------------------------------------------ the board

// followBoard reads the board's feed (GET /api/feed: server-sent events)
// until ctx ends, connecting again every 2 s while it does not answer. The
// first try is silent; after it, board.up and board.down say each change.
func (f *feed) followBoard(ctx context.Context, url string, ready chan<- string) {
	up, first := false, true
	for {
		why := f.readBoard(ctx, url, func() {
			if first {
				first = false
				up = true
				ready <- "the board at " + url
				return
			}
			if !up {
				up = true
				f.emit(ctx, feedEvent{"event": "board.up", "at": stamp(), "machine": "local", "url": url})
			}
		})
		if ctx.Err() != nil {
			return
		}
		if first {
			first = false
			ready <- "not the board at " + url + " (" + why + "; it joins when it answers)"
		} else if up {
			up = false
			f.emit(ctx, feedEvent{"event": "board.down", "at": stamp(), "machine": "local", "url": url})
		}
		// A board from before the feed is asked again now and then (it may
		// be updated meanwhile); one that is down, every 2 s.
		wait := 2 * time.Second
		if why == "it is older than events" {
			wait = 30 * time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

// boardMessage is one message of the board's feed: a raw event of another
// machine's daemon (type daemon), or one of the board's own (type board).
type boardMessage struct {
	Machine string          `json:"machine"`
	Daemon  string          `json:"daemon"`
	Event   json.RawMessage `json:"event"`
}

// readBoard reads one connection to the board's feed until it ends. It
// calls connected once the board answered 200, and returns why it ended
// (or did not start).
func (f *feed) readBoard(ctx context.Context, url string, connected func()) string {
	req, err := http.NewRequestWithContext(ctx, "GET", url+"/api/feed", nil)
	if err != nil {
		return err.Error()
	}
	req.Header.Set("Accept", "text/event-stream")
	// No overall timeout: the stream is long; the dial and the first
	// answer are bounded instead.
	tr := &http.Transport{ResponseHeaderTimeout: 5 * time.Second, DisableCompression: true}
	defer tr.CloseIdleConnections()
	res, err := (&http.Client{Transport: tr}).Do(req)
	if err != nil {
		return "it does not answer"
	}
	defer res.Body.Close()
	if res.StatusCode == 404 {
		io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
		return "it is older than events"
	}
	if res.StatusCode != 200 {
		return "it answered " + res.Status
	}
	connected()
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 64<<10), 8<<20)
	kind, data := "", ""
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			if data != "" {
				f.boardEvent(ctx, kind, data)
			}
			kind, data = "", ""
		case strings.HasPrefix(line, "event:"):
			kind = strings.TrimSpace(line[6:])
		case strings.HasPrefix(line, "data:"):
			data += strings.TrimPrefix(line[5:], " ")
		}
	}
	return "it closed the stream"
}

func (f *feed) boardEvent(ctx context.Context, kind, data string) {
	switch kind {
	case "daemon":
		var m boardMessage
		if json.Unmarshal([]byte(data), &m) != nil || m.Machine == "" || m.Machine == "local" {
			return
		}
		var ev proto.Event
		if json.Unmarshal(m.Event, &ev) != nil {
			return
		}
		if fe := f.fromDaemon(ev, m.Machine, m.Daemon); fe != nil {
			f.emit(ctx, fe)
		}
	case "board":
		var e feedEvent
		if json.Unmarshal([]byte(data), &e) != nil {
			return
		}
		name, _ := e["event"].(string)
		known := false
		for _, k := range feedKinds {
			known = known || k.name == name
		}
		if !known {
			return
		}
		if m, _ := e["machine"].(string); m == "" {
			e["machine"] = "local"
		}
		if _, ok := e["at"].(string); !ok {
			e["at"] = stamp()
		}
		f.emit(ctx, e)
	}
}

// ------------------------------------------------------------ printing

// encodeEvent is one line of JSON: event, at and machine first, then the
// rest by name, so a line reads the same every time.
func encodeEvent(ev feedEvent) []byte {
	var b strings.Builder
	b.WriteByte('{')
	keys := make([]string, 0, len(ev))
	for k := range ev {
		if k != "event" && k != "at" && k != "machine" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	keys = append([]string{"event", "at", "machine"}, keys...)
	n := 0
	for _, k := range keys {
		v, ok := ev[k]
		if !ok {
			continue
		}
		val, err := marshalPlain(v)
		if err != nil {
			continue
		}
		if n > 0 {
			b.WriteByte(',')
		}
		kj, _ := marshalPlain(k)
		b.Write(kj)
		b.WriteByte(':')
		b.Write(val)
		n++
	}
	b.WriteByte('}')
	return []byte(b.String())
}

// marshalPlain is json.Marshal without HTML escaping.
func marshalPlain(v any) ([]byte, error) {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return []byte(strings.TrimRight(b.String(), "\n")), nil
}

// humanEvent is one line for a person: the time, the event, the machine,
// then what it is about.
func humanEvent(ev feedEvent) string {
	str := func(k string) string { s, _ := ev[k].(string); return s }
	sub := func(k, f string) string {
		if m, ok := ev[k].(map[string]any); ok {
			s, _ := m[f].(string)
			return s
		}
		return ""
	}
	at := str("at")
	if t, err := time.Parse(time.RFC3339Nano, at); err == nil {
		at = t.Local().Format("15:04:05")
	}
	pane := str("pane")
	if n := str("pane_name"); n != "" {
		pane += " (" + n + ")"
	}
	var what []string
	add := func(s ...string) {
		for _, x := range s {
			if x != "" {
				what = append(what, x)
			}
		}
	}
	quote := func(s string) string {
		if s == "" {
			return ""
		}
		return fmt.Sprintf("%q", clipString(strings.Join(strings.Fields(s), " "), 120))
	}
	name := str("event")
	switch {
	case strings.HasPrefix(name, "pane."):
		add(pane)
		switch name {
		case "pane.created":
			if c, ok := ev["command"].([]string); ok && len(c) > 0 {
				add(strings.Join(c, " "))
			}
			add(str("cwd"))
		case "pane.title":
			add(quote(str("title")))
		case "pane.cwd":
			add(str("cwd"))
		case "pane.prompt":
			if s, ok := ev["shell"].(*proto.Shell); ok && s != nil {
				line := s.State
				if s.Command != "" {
					line += ": " + clipString(s.Command, 80)
				}
				if s.ExitCode != nil && s.State == "prompt" {
					line += fmt.Sprintf(" (exit %d)", *s.ExitCode)
				}
				add(line)
			} else if m, ok := ev["shell"].(map[string]any); ok {
				st, _ := m["state"].(string)
				add(st)
			}
		case "pane.exited", "pane.closed":
			switch x := ev["exit"].(type) {
			case *proto.Exit:
				if x.Signal != "" {
					add("signal " + x.Signal)
				} else {
					add(fmt.Sprintf("exit %d", x.Code))
				}
			case map[string]any:
				if s, _ := x["signal"].(string); s != "" {
					add("signal " + s)
				} else if c, ok := x["code"].(float64); ok {
					add(fmt.Sprintf("exit %d", int(c)))
				}
			}
		}
	case name == "agent.report":
		add(pane)
		if r, ok := ev["report"].(map[string]any); ok {
			a, _ := r["assistant"].(string)
			e, _ := r["event"].(string)
			s, _ := r["state"].(string)
			m, _ := r["message"].(string)
			line := a + " " + e
			if s != "" {
				line += ": " + s
			}
			add(line, quote(m))
		}
	case strings.HasPrefix(name, "checkpoint."):
		add(pane, sub("checkpoint", "kind"), sub("checkpoint", "id"), quote(sub("checkpoint", "title")))
		if r := sub("checkpoint", "reason"); r != "" {
			add("(" + r + ")")
		}
		if ans, ok := ev["answer"].(proto.CheckpointAnswer); ok {
			switch {
			case ans.Pick != nil:
				add("-> " + ans.Pick.Label)
			case ans.Text != nil:
				add("-> " + quote(*ans.Text))
			case ans.Option != "":
				add("-> " + ans.Option)
			case ans.Delivered:
				add("-> delivered")
			}
		}
	case strings.HasPrefix(name, "session.") || name == "handoff.ready":
		s := str("project_name")
		if n := str("name"); n != "" {
			s += ": " + n
		}
		add(quote(s))
		if pane != "" {
			add("pane " + pane)
		}
		if w := str("why"); w != "" {
			add("(" + w + ")")
		}
		add(quote(str("line")), sub("handoff", "file"))
	case strings.HasPrefix(name, "daemon."):
		add("ravenryd "+str("daemon"), str("socket"))
		if n := str("newer"); n != "" {
			add("newer: " + n)
		}
	case strings.HasPrefix(name, "board."):
		add(str("url"))
	}
	return fmt.Sprintf("%s  %-25s %-8s %s", at, name, str("machine"), strings.Join(what, "  "))
}
