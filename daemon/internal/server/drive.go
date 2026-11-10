package server

import (
	"context"
	"crypto/rand"
	"encoding/base32"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"ravenryd/internal/pane"
	"ravenryd/internal/proto"
)

// Who drives a pane (PROTOCOL.md section 4, Panes and who drives them).
//
// Every pane has a creator: the person (a person's connection started
// it: the app, the hub, a script outside every pane), an agent (a program
// inside pane P started it) or a client (a program outside every pane
// that may not act as the person, over ssh without the answer key). An
// agent drives the panes it created, and the panes those created, and
// asks for any other, another agent's session included: input it sends
// to a pane it may not drive opens a drive checkpoint that only a person
// answers, for this input once or for the agent's session (a grant, which
// a person can also revoke). The person is never restricted: their typing
// goes through a lease, and is only marked with the lease's holder.
//
// Every input is logged with its source in the pane's input log
// (pane.inputs), so the person always sees who typed what. A lease
// (pane.lease) keeps a pane to one driver at a time; the person's own
// input goes through any lease.

const (
	maxInputs        = 1000
	maxInputBytes    = 1 << 20
	maxInputText     = 4 << 10
	keysGather       = 2 * time.Second
	maxPreview       = 1000
	defaultLeaseTTL  = 60 * time.Second
	maxLeaseTTL      = time.Hour
	maxLeaseWait     = time.Hour
	maxCreatorChain  = 16
	maxFilesPerPane  = 2000
	driveCheckpointT = time.Hour
)

// Grant lifetimes, and the kinds of Source.
const (
	allowOnce    = "once"
	allowSession = "session"

	srcPerson = "person"
	srcAgent  = "agent"
	srcClient = "client"

	// What a drive asks to do to a pane.
	actInput    = "input"
	actClose    = "close"
	actRestart  = "restart"
	actOverride = "override"
)

// actionVerb says an action for people: "Let it <verb> <pane>?".
func actionVerb(action string) string {
	switch action {
	case actClose:
		return "close"
	case actRestart:
		return "restart"
	case actOverride:
		return "set test conditions on"
	}
	return "type into"
}

func actionOf(a string) string {
	if a == "" {
		return actInput
	}
	return a
}

type paneMeta struct {
	id         string
	creator    proto.Source
	creatorKey string

	inputs     []proto.InputRecord
	inputBytes int
	keysConn   *conn
	keysAt     time.Time
	// keysEdit replays the gathered keys record's keystrokes for its
	// Shown (shown.go).
	keysEdit *lineEditor
	// keysTell sends a gathered keys record again once it stops growing.
	keysTell *time.Timer

	lease *leaseState

	files map[string]*proto.FileTouch
}

type grant struct {
	g    proto.Grant
	key  string
	conn *conn // a client's grant lasts as long as its connection
}

type leaseState struct {
	l       proto.Lease
	key     string
	expires time.Time
	timer   *time.Timer
	waiters []*leaseWaiter
}

type leaseWaiter struct {
	w   who
	ttl time.Duration
	ch  chan struct{}
	// refused: the person took the pane back; it fails instead of
	// taking the lease.
	refused bool
}

type driveState struct {
	mu       sync.Mutex
	meta     map[string]*paneMeta
	grants   map[string]*grant
	asking   map[string]string // who's key + "|" + pane -> open drive checkpoint
	inputSeq uint64
	connSeq  uint64
}

func newDriveState() *driveState {
	return &driveState{meta: map[string]*paneMeta{}, grants: map[string]*grant{}, asking: map[string]string{}}
}

// metaLocked returns a pane's record, made on first use; d.mu is held.
func (d *driveState) metaLocked(id string) *paneMeta {
	m := d.meta[id]
	if m == nil {
		m = &paneMeta{id: id, creator: proto.Source{Kind: srcPerson}, creatorKey: keyPerson}
		d.meta[id] = m
	}
	return m
}

// ------------------------------------------------------------ who asks

const keyPerson = "person"

// who is a connection as a driver of panes.
type who struct {
	person bool
	key    string // "person", "pane:<id>" or "conn:<n>"
	src    proto.Source
	conn   *conn
	pane   string // the agent's own pane
	// reason: the agent's words on why, for the drive checkpoint this
	// request opens.
	reason string
}

// who says who this connection is when it sends input with by.
func (c *conn) who(by string) who {
	c.mu.Lock()
	defer c.mu.Unlock()
	w := who{conn: c, person: c.person}
	switch {
	case c.person:
		w.key = keyPerson
		w.src = proto.Source{Kind: srcClient, Client: c.client.Name}
		if by != "" {
			w.src = proto.Source{Kind: srcPerson, Client: c.client.Name, By: by}
		}
	case c.agentPane != "":
		w.key = "pane:" + c.agentPane
		w.pane = c.agentPane
		w.src = proto.Source{Kind: srcAgent, Pane: c.agentPane, Client: c.client.Name, By: by}
	default:
		w.key = fmt.Sprintf("conn:%d", c.serial)
		w.src = proto.Source{Kind: srcClient, Client: c.client.Name, By: by}
	}
	return w
}

// checkReason checks an agent's reason for a drive: at most 1000 bytes of
// text (new lines allowed).
func checkReason(r string) error {
	if len(r) > maxDriveReason || !plainText(strings.ReplaceAll(r, "\n", " ")) {
		return bad("reason is at most %d bytes of text", maxDriveReason)
	}
	return nil
}

const maxDriveReason = 1000

// whoKeys is who sends a display's keystrokes (binary input frames): on
// a person's connection, the person.
func (c *conn) whoKeys() who {
	w := c.who("")
	if w.person {
		w.src.Kind = srcPerson
	}
	return w
}

// creatorOf is the Source a new pane records for the connection that
// starts it.
func (w who) creator() proto.Source {
	if w.person {
		return proto.Source{Kind: srcPerson, Client: w.src.Client}
	}
	s := w.src
	s.By = ""
	return s
}

// setCreator records who started a pane.
func (s *Server) setCreator(id string, src proto.Source, key string) {
	s.drive.mu.Lock()
	m := s.drive.metaLocked(id)
	m.creator, m.creatorKey = src, key
	s.drive.mu.Unlock()
}

// ------------------------------------------------------------ may it drive

// mayDrive reports whether w may send input to pane id now, and the lease
// that stops it when another driver holds one.
func (s *Server) mayDrive(w who, id string) (bool, *proto.Lease) {
	return s.mayDo(w, id, actInput)
}

// mayDo is mayDrive for any action: input, close, restart, override.
func (s *Server) mayDo(w who, id, action string) (bool, *proto.Lease) {
	if w.person {
		return true, nil
	}
	d := s.drive
	d.mu.Lock()
	defer d.mu.Unlock()
	m := d.meta[id]
	if m != nil && m.lease != nil && m.lease.key != w.key && time.Now().Before(m.lease.expires) {
		l := m.lease.l
		return false, &l
	}
	// Its own panes, and the panes those started.
	cur := m
	for i := 0; cur != nil && i < maxCreatorChain; i++ {
		if cur.creatorKey == w.key {
			return true, nil
		}
		if cur.creator.Kind != srcAgent || cur.creator.Pane == "" {
			break
		}
		cur = d.meta[cur.creator.Pane]
	}
	for _, g := range d.grants {
		if g.g.Pane == id && g.key == w.key && actionOf(g.g.Action) == action && s.grantValid(g) {
			return true, nil
		}
	}
	return false, nil
}

// grantValid: a session grant lasts while the agent's assistant session
// is the one it was given in (or, for a client, while its connection
// lasts); d.mu is held.
func (s *Server) grantValid(g *grant) bool {
	if g.conn != nil {
		return g.conn.ctx.Err() == nil
	}
	if g.g.Agent.Pane == "" {
		return true
	}
	cur := ""
	if st := s.agents.Status(g.g.Agent.Pane); st != nil {
		cur = st.Session
	}
	return g.g.Session == "" || g.g.Session == cur
}

// driveErr is input refused until a person lets it through: forbidden,
// with the drive checkpoint.
type driveErr struct {
	msg string
	cp  string
}

func (e driveErr) Error() string { return e.msg }

// leasedErr is input refused because another driver holds the lease.
type leasedErr struct {
	msg   string
	lease proto.Lease
}

func (e leasedErr) Error() string { return e.msg }

func leaseError(id string, l proto.Lease) error {
	return leasedErr{fmt.Sprintf("pane %s is leased to %s until %s: wait for it (ravenry lease %s --wait 5m) or ask the person", id, describe(l.Holder), l.ExpiresAt, id), l}
}

func describe(src proto.Source) string {
	switch {
	case src.Kind == srcAgent && src.Pane != "":
		return "the agent in pane " + src.Pane
	case src.Kind == srcPerson:
		return "the person"
	case src.Client != "":
		return "the program " + src.Client
	}
	return "another program"
}

// allowInput waits until w may send input to p, opening a drive
// checkpoint when it may not, or fails at once with noWait. A person
// always may.
func (c *conn) allowInput(ctx context.Context, p *pane.Pane, w who, preview string, noWait bool) error {
	return c.allowAction(ctx, p, w, preview, noWait, actInput)
}

// allowAction is allowInput for any action on the pane: closing,
// restarting or setting test conditions on a pane outside the caller's
// own asks the person as typing into it does.
func (c *conn) allowAction(ctx context.Context, p *pane.Pane, w who, preview string, noWait bool, action string) error {
	s := c.s
	verb := actionVerb(action)
	for {
		ok, lease := s.mayDo(w, p.ID(), action)
		if lease != nil {
			return leaseError(p.ID(), *lease)
		}
		if ok {
			return nil
		}
		x, err := s.askToDrive(w, p, preview, action)
		if err != nil {
			return err
		}
		if noWait {
			return driveErr{fmt.Sprintf("you did not start pane %s, so the person must let you %s it: checkpoint %s waits for them (ravenry checkpoint %s --wait)", p.ID(), verb, x.c.ID, x.c.ID), x.c.ID}
		}
		select {
		case <-x.done:
		case <-ctx.Done():
			return ctx.Err()
		}
		s.cps.mu.Lock()
		cp := x.c
		s.cps.mu.Unlock()
		switch {
		case cp.State == stAnswered && cp.Answer != nil && cp.Answer.Approved != nil && *cp.Answer.Approved:
			if cp.Answer.Allow == "" || cp.Answer.Allow == allowOnce {
				return nil // this input, once
			}
			// A grant now holds: check again.
		case cp.State == stDeclined:
			why := "the person said no"
			if cp.Answer != nil && cp.Answer.Reason != "" {
				why += ": " + cp.Answer.Reason
			}
			return driveErr{fmt.Sprintf("you may not %s pane %s: %s (checkpoint %s)", verb, p.ID(), why, cp.ID), cp.ID}
		default:
			return driveErr{fmt.Sprintf("you may not %s pane %s: checkpoint %s %s without an answer", verb, p.ID(), cp.ID, cp.State), cp.ID}
		}
	}
}

// askToDrive opens the drive checkpoint for w and pane p, or returns the
// one already open.
func (s *Server) askToDrive(w who, p *pane.Pane, preview, action string) (*cpoint, error) {
	d := s.drive
	k := w.key + "|" + p.ID() + "|" + action
	d.mu.Lock()
	if id := d.asking[k]; id != "" {
		s.cps.mu.Lock()
		x := s.cps.all[id]
		open := x != nil && x.c.State == stOpen
		if open && w.reason != "" && x.c.Drive != nil && x.c.Drive.Reason == "" {
			x.c.Drive.Reason = w.reason
		}
		s.cps.mu.Unlock()
		if open {
			d.mu.Unlock()
			return x, nil
		}
		delete(d.asking, k)
	}
	d.mu.Unlock()
	info := p.Info()
	target := paneLabel(info)
	asker := describe(w.src)
	cp := proto.Checkpoint{
		Kind:  kindDrive,
		Title: clip(fmt.Sprintf("Let %s %s %s?", asker, actionVerb(action), target), maxTitle),
		Drive: &proto.Drive{Pane: p.ID(), Agent: w.src, Input: clip(preview, maxPreview), Reason: w.reason, Action: action},
	}
	if w.pane != "" {
		cp.Pane = w.pane
		if st := s.agents.Status(w.pane); st != nil && st.State != "ended" {
			cp.Assistant = st.Assistant
		}
	}
	x, err := s.openCheckpoint(cp, driveCheckpointT)
	if err != nil {
		return nil, err
	}
	d.mu.Lock()
	d.asking[k] = x.c.ID
	d.mu.Unlock()
	return x, nil
}

// paneLabel names a pane for people: its name, else its title, else its
// command, with its id.
func paneLabel(i pane.Info) string {
	n := firstNonEmpty(i.Name, i.Title)
	if n == "" && len(i.Command) > 0 {
		n = strings.Join(i.Command, " ")
	}
	if n == "" {
		return "pane " + i.ID
	}
	return fmt.Sprintf("%q (pane %s)", clip(n, 80), i.ID)
}

// grantDrive records the person's yes to a drive checkpoint, for its
// session or until revoked.
func (s *Server) grantDrive(cp proto.Checkpoint, allow string) {
	if cp.Drive == nil || allow != allowSession {
		return
	}
	src := cp.Drive.Agent
	g := &grant{g: proto.Grant{ID: newGrantID(), Pane: cp.Drive.Pane, Agent: src, Action: actionOf(cp.Drive.Action), Allow: allow, Checkpoint: cp.ID, CreatedAt: stamp(time.Now())}}
	switch {
	case src.Kind == srcAgent && src.Pane != "":
		g.key = "pane:" + src.Pane
		if st := s.agents.Status(src.Pane); st != nil && allow == allowSession {
			g.g.Session = st.Session
		}
	default:
		// A client outside every pane: the connection that asked.
		s.drive.mu.Lock()
		for k, id := range s.drive.asking {
			if id == cp.ID {
				g.key, _, _ = strings.Cut(k, "|")
			}
		}
		s.drive.mu.Unlock()
		for _, c := range s.connections(func(*conn) bool { return true }) {
			if fmt.Sprintf("conn:%d", c.serial) == g.key {
				g.conn = c
			}
		}
		if g.conn == nil {
			return // it is gone: nothing to grant
		}
	}
	s.drive.mu.Lock()
	s.drive.grants[g.g.ID] = g
	s.drive.mu.Unlock()
}

func newGrantID() string {
	var b [5]byte
	rand.Read(b[:])
	return "g" + strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b[:]))[:7]
}

// ------------------------------------------------------------ the input log

// visible writes typed bytes for people: text as it is, newlines and
// tabs kept, control keys as <Name>. A display's reports to the program
// (focus, cursor position, mouse, answers to its queries) are not typing
// and are left out.
func visible(b []byte) string {
	var o strings.Builder
	for len(b) > 0 {
		if n, _ := termReport(b); n > 0 {
			b = b[n:]
			continue
		}
		if b[0] == 0x1b {
			matched := false
			for _, k := range escNames {
				if strings.HasPrefix(string(b), k.seq) {
					o.WriteString("<" + k.name + ">")
					b = b[len(k.seq):]
					matched = true
					break
				}
			}
			if matched {
				continue
			}
		}
		c := b[0]
		switch {
		case c == '\r':
			o.WriteString("<Enter>")
		case c == '\n' || c == '\t':
			o.WriteByte(c)
		case c == 0x1b:
			o.WriteString("<Esc>")
		case c == 0x7f:
			o.WriteString("<Backspace>")
		case c < 0x20:
			o.WriteString("<Ctrl+" + string(rune(c+'@')) + ">")
		default:
			r, n := utf8.DecodeRune(b)
			if r == utf8.RuneError && n <= 1 {
				o.WriteString("�")
				b = b[1:]
				continue
			}
			o.WriteString(string(b[:n]))
			b = b[n:]
			continue
		}
		b = b[1:]
	}
	return o.String()
}

var escNames = []struct{ seq, name string }{
	{"\x1b[200~", "Paste"}, {"\x1b[201~", "/Paste"},
	{"\x1b[A", "Up"}, {"\x1b[B", "Down"}, {"\x1b[C", "Right"}, {"\x1b[D", "Left"},
	{"\x1bOA", "Up"}, {"\x1bOB", "Down"}, {"\x1bOC", "Right"}, {"\x1bOD", "Left"},
	{"\x1b[H", "Home"}, {"\x1b[F", "End"}, {"\x1b[3~", "Delete"}, {"\x1b[5~", "PageUp"}, {"\x1b[6~", "PageDown"},
	{"\x1b[Z", "Shift+Tab"},
}

// termReport reports whether b starts with what a terminal sends back to
// the program rather than what a person types: focus in and out (CSI I,
// CSI O, mode 1004), a cursor position (CSI row;col R), device attributes
// (CSI ? ... c, CSI > ... c, CSI = ... c), a status or colour scheme
// (CSI ... n), window reports (CSI ... t), mode reports (CSI ... $ y),
// Kitty keyboard flags (CSI ? flags u), mouse reports (SGR CSI < ... M or
// m, urxvt CSI b;x;y M, X10 CSI M and 3 bytes), and the OSC (colours,
// clipboard), DCS (XTVERSION, DECRQSS, XTGETTCAP) and APC (Kitty graphics)
// answers, each with its terminator in b. It returns its length (0: not
// one) and whether it is a mouse report, which is the person acting (a
// click) where the others only answer.
// An OSC, DCS or APC needs its terminator in the same input and starts as
// an answer does, so Alt+], Alt+Shift+P or Alt+_ typed alone stay keys.
func termReport(b []byte) (n int, mouse bool) {
	if len(b) < 3 || b[0] != 0x1b {
		return 0, false
	}
	switch b[1] {
	case '[':
		return csiReport(b)
	case ']':
		if isDigit(b[2]) {
			return stringReport(b)
		}
	case 'P':
		if isDigit(b[2]) || strings.IndexByte(">!=$+", b[2]) >= 0 {
			return stringReport(b)
		}
	case '_':
		if b[2] == 'G' {
			return stringReport(b)
		}
	}
	return 0, false
}

func csiReport(b []byte) (int, bool) {
	i := 2
	for i < len(b) && b[i] >= 0x30 && b[i] <= 0x3f {
		i++
	}
	params := string(b[2:i])
	j := i
	for j < len(b) && b[j] >= 0x20 && b[j] <= 0x2f {
		j++
	}
	inter := string(b[i:j])
	if j >= len(b) || b[j] < 0x40 || b[j] > 0x7e {
		return 0, false
	}
	final, n := b[j], j+1
	lead := byte(0)
	if params != "" && strings.IndexByte("<=>?", params[0]) >= 0 {
		lead = params[0]
	}
	switch {
	case inter == "$" && final == 'y':
		return n, false
	case inter != "":
		return 0, false
	case params == "" && (final == 'I' || final == 'O'):
		return n, false
	case params == "" && final == 'M':
		if len(b) >= n+3 && b[n] >= 0x20 && b[n+1] >= 0x20 && b[n+2] >= 0x20 {
			return n + 3, true
		}
		return 0, false
	case lead == '<' && (final == 'M' || final == 'm'):
		return n, true
	case lead == 0 && final == 'M' && strings.Count(params, ";") == 2:
		return n, true
	case final == 'R' && (lead == 0 || lead == '?') && strings.Contains(params, ";"):
		return n, false
	case final == 'c' && (lead == '?' || lead == '>' || lead == '='):
		return n, false
	case final == 'u' && lead == '?':
		return n, false
	case final == 'n' || final == 't':
		return n, false
	}
	return 0, false
}

// stringReport is an OSC, DCS or APC up to its terminator (BEL, or ESC \),
// all printable between.
func stringReport(b []byte) (int, bool) {
	for i := 2; i < len(b); i++ {
		switch c := b[i]; {
		case c == 0x07 && b[1] == ']':
			return i + 1, false
		case c == 0x1b:
			if i+1 < len(b) && b[i+1] == '\\' {
				return i + 2, false
			}
			return 0, false
		case c < 0x20 || c == 0x7f:
			return 0, false
		}
	}
	return 0, false
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// onlyAnswers reports whether b is nothing but a display's answers to the
// program (reports other than the mouse's).
func onlyAnswers(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	for len(b) > 0 {
		n, mouse := termReport(b)
		if n == 0 || mouse {
			return false
		}
		b = b[n:]
	}
	return true
}

// itemsText is what a list of input items types, for people.
func itemsText(items []pane.InputItem) string {
	var o strings.Builder
	for _, it := range items {
		if it.Key != "" {
			o.WriteString("<" + it.Key + ">")
			continue
		}
		o.WriteString(visible([]byte(it.Text)))
	}
	return o.String()
}

// inputText masks what was typed for the log: the pane's secrets, and
// everything typed at a password prompt.
func inputText(p *pane.Pane, text string) (string, bool) {
	if p.PasswordPrompt() {
		return "", true
	}
	b, masked := p.MaskSecrets([]byte(text))
	return string(b), masked
}

// logInput adds a record to a pane's input log and tells the event
// subscribers. Keystrokes from one display within keysGather of each
// other gather into one record. feed gives what is shown (Shown) its
// input, already masked; nil: nothing of it is shown.
func (s *Server) logInput(p *pane.Pane, w who, kind string, mark uint64, n int, text string, masked bool, feed func(*lineEditor)) {
	d := s.drive
	now := time.Now()
	d.mu.Lock()
	m := d.metaLocked(p.ID())
	if kind == "keys" && m.keysConn == w.conn && w.conn != nil && now.Sub(m.keysAt) < keysGather && len(m.inputs) > 0 {
		last := &m.inputs[len(m.inputs)-1]
		if last.Kind == "keys" && len(last.Text)+len(text) <= maxInputText {
			last.Bytes += n
			last.Text += text
			last.Masked = last.Masked || masked
			last.Until = stamp(now)
			if m.keysEdit == nil {
				m.keysEdit = &lineEditor{}
			}
			if feed != nil {
				feed(m.keysEdit)
			}
			last.Shown = m.keysEdit.String()
			m.keysAt = now
			m.inputBytes += len(text)
			// The record grew: sent again (same seq) once the keys pause,
			// so a window shows the whole line, not its first key.
			seq := last.Seq
			if m.keysTell != nil {
				m.keysTell.Stop()
			}
			m.keysTell = time.AfterFunc(keysTell, func() { s.tellInput(p, seq) })
			d.mu.Unlock()
			return
		}
	}
	d.inputSeq++
	rec := proto.InputRecord{Seq: d.inputSeq, At: stamp(now), Source: w.src, Kind: kind, Mark: mark, Bytes: n, Text: text, Masked: masked}
	edit := &lineEditor{}
	if feed != nil {
		feed(edit)
	}
	rec.Shown = edit.String()
	if m.lease != nil && m.lease.key != w.key && now.Before(m.lease.expires) {
		h := m.lease.l.Holder
		rec.LeaseHolder = &h
	}
	if len(rec.Text) > maxInputText {
		rec.Text = clip(rec.Text, maxInputText)
		rec.Truncated = true
	}
	if kind == "keys" {
		m.keysConn, m.keysAt, m.keysEdit = w.conn, now, edit
	} else {
		m.keysConn, m.keysEdit = nil, nil
	}
	m.inputs = append(m.inputs, rec)
	m.inputBytes += len(rec.Text) + 128
	for len(m.inputs) > maxInputs || m.inputBytes > maxInputBytes {
		m.inputBytes -= len(m.inputs[0].Text) + 128
		m.inputs = m.inputs[1:]
	}
	d.mu.Unlock()
	pi := s.paneInfo(p.Info())
	ev := proto.Event{V: proto.Version, Type: "event", Event: "pane.input", Pane: &pi, Input: &rec}
	for _, c := range s.connections(func(c *conn) bool { return c.unwatch != nil }) {
		c.event(ev)
	}
}

// keysTell is how long after a gathered record's last keystroke it is sent
// again, grown.
const keysTell = 300 * time.Millisecond

// tellInput sends a pane's input record as it is now (a gathered keys
// record that grew since its pane.input).
func (s *Server) tellInput(p *pane.Pane, seq uint64) {
	d := s.drive
	d.mu.Lock()
	m := d.meta[p.ID()]
	var rec *proto.InputRecord
	if m != nil {
		for i := len(m.inputs) - 1; i >= 0; i-- {
			if m.inputs[i].Seq == seq {
				r := m.inputs[i]
				rec = &r
				break
			}
		}
	}
	d.mu.Unlock()
	if rec == nil {
		return
	}
	pi := s.paneInfo(p.Info())
	ev := proto.Event{V: proto.Version, Type: "event", Event: "pane.input", Pane: &pi, Input: rec}
	for _, c := range s.connections(func(c *conn) bool { return c.unwatch != nil }) {
		c.event(ev)
	}
}

func (c *conn) paneInputs(id uint64, data []byte) {
	var r proto.InputsRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	if _, err := c.pane(r.Pane); err != nil {
		c.failErr(id, err)
		return
	}
	limit := 200
	if r.Limit != nil {
		if *r.Limit < 1 || *r.Limit > maxInputs {
			c.failErr(id, bad("limit must be between 1 and %d", maxInputs))
			return
		}
		limit = *r.Limit
	}
	since := uint64(0)
	if r.Since != nil {
		since = *r.Since
	}
	d := c.s.drive
	d.mu.Lock()
	res := proto.InputsResult{Pane: r.Pane, Inputs: []proto.InputRecord{}, Seq: d.inputSeq}
	if m := d.meta[r.Pane]; m != nil {
		if len(m.inputs) > 0 && m.inputs[0].Seq > since+1 && since > 0 {
			res.Truncated = true
		}
		for _, in := range m.inputs {
			if in.Seq > since {
				res.Inputs = append(res.Inputs, in)
			}
		}
	}
	d.mu.Unlock()
	if len(res.Inputs) > limit {
		res.Inputs = res.Inputs[len(res.Inputs)-limit:]
		res.Truncated = true
	}
	c.reply(id, "pane.inputs", res)
}

// ------------------------------------------------------------ grants

func (c *conn) paneGrants(id uint64, data []byte) {
	var r proto.GrantsRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	s := c.s
	s.drive.mu.Lock()
	out := []proto.Grant{}
	for _, g := range s.drive.grants {
		if (r.Pane == "" || g.g.Pane == r.Pane) && s.grantValid(g) {
			out = append(out, g.g)
		}
	}
	s.drive.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	c.reply(id, "pane.grants", proto.GrantsResult{Grants: out})
}

func (c *conn) paneRevoke(id uint64, data []byte) {
	var r proto.RevokeRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	if r.Grant == "" {
		c.failErr(id, bad("grant is required"))
		return
	}
	s := c.s
	s.drive.mu.Lock()
	g := s.drive.grants[r.Grant]
	delete(s.drive.grants, r.Grant)
	s.drive.mu.Unlock()
	if g == nil {
		c.failErr(id, notFound("no grant %s", r.Grant))
		return
	}
	c.reply(id, "pane.revoke", proto.RevokeResult{Grant: g.g})
}

// ------------------------------------------------------------ leases

func (c *conn) paneLease(id uint64, data []byte) {
	var r proto.LeaseRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	p, err := c.pane(r.Pane)
	if err != nil {
		c.failErr(id, err)
		return
	}
	ttl := defaultLeaseTTL
	if r.TTLMs != nil {
		ttl = time.Duration(*r.TTLMs) * time.Millisecond
		if ttl <= 0 || ttl > maxLeaseTTL {
			c.failErr(id, bad("ttl_ms must be between 1 and %d", maxLeaseTTL.Milliseconds()))
			return
		}
	}
	var wait time.Duration
	if r.WaitMs != nil {
		wait = time.Duration(*r.WaitMs) * time.Millisecond
		if wait < 0 || wait > maxLeaseWait {
			c.failErr(id, bad("wait_ms must be between 0 and %d", maxLeaseWait.Milliseconds()))
			return
		}
	}
	if r.Release && (r.TTLMs != nil || r.WaitMs != nil) {
		c.failErr(id, bad("release takes no ttl_ms or wait_ms"))
		return
	}
	if r.RefuseWaiting && !r.Release {
		c.failErr(id, bad("refuse_waiting goes with release"))
		return
	}
	w := c.who("")
	if err := checkReason(r.Reason); err != nil {
		c.failErr(id, err)
		return
	}
	w.reason = r.Reason
	if r.RefuseWaiting && !c.asPerson(id, "pane.lease with refuse_waiting") {
		return
	}
	if r.Release {
		if err := c.s.release(p, w, r.RefuseWaiting); err != nil {
			c.failErr(id, err)
			return
		}
		c.reply(id, "pane.lease", proto.LeaseResult{Pane: r.Pane})
		return
	}
	c.track(id, func(ctx context.Context) {
		// Only a driver may hold the lease: ask the person first when
		// this connection may not drive the pane.
		if err := c.allowLease(ctx, p, w, r.NoWait); err != nil {
			c.failErr(id, err)
			return
		}
		l, err := c.s.acquire(ctx, p, w, ttl, wait)
		if err != nil {
			c.failErr(id, err)
			return
		}
		c.reply(id, "pane.lease", proto.LeaseResult{Pane: r.Pane, Lease: &l})
	})
}

// allowLease is allowInput without the lease: holding the lease is what
// is being asked for.
func (c *conn) allowLease(ctx context.Context, p *pane.Pane, w who, noWait bool) error {
	if w.person {
		return nil
	}
	if ok, _ := c.s.mayDriveIgnoringLease(w, p.ID(), actInput); ok {
		return nil
	}
	return c.allowInputIgnoringLease(ctx, p, w, noWait)
}

func (s *Server) mayDriveIgnoringLease(w who, id, action string) (bool, *proto.Lease) {
	s.drive.mu.Lock()
	m := s.drive.meta[id]
	var held *leaseState
	if m != nil {
		held, m.lease = m.lease, nil
	}
	s.drive.mu.Unlock()
	ok, _ := s.mayDo(w, id, action)
	s.drive.mu.Lock()
	if m != nil && m.lease == nil {
		m.lease = held
	}
	s.drive.mu.Unlock()
	return ok, nil
}

func (c *conn) allowInputIgnoringLease(ctx context.Context, p *pane.Pane, w who, noWait bool) error {
	for {
		if ok, _ := c.s.mayDriveIgnoringLease(w, p.ID(), actInput); ok {
			return nil
		}
		err := c.allowInput(ctx, p, w, "(a lease: to be the one driver of this pane)", noWait)
		var le leasedErr
		if errors.As(err, &le) {
			// The lease is what it waits for next; the drive is allowed
			// when mayDriveIgnoringLease says so.
			if ok, _ := c.s.mayDriveIgnoringLease(w, p.ID(), actInput); ok {
				return nil
			}
			return err
		}
		return err
	}
}

// acquire takes or renews the lease, waiting up to wait for the holder to
// let it go (in turn with other waiters).
func (s *Server) acquire(ctx context.Context, p *pane.Pane, w who, ttl, wait time.Duration) (proto.Lease, error) {
	d := s.drive
	deadline := time.Now().Add(wait)
	for {
		d.mu.Lock()
		m := d.metaLocked(p.ID())
		now := time.Now()
		cur := m.lease
		if cur != nil && !now.Before(cur.expires) {
			s.dropLeaseLocked(m)
			cur = nil
		}
		if cur == nil || cur.key == w.key {
			if cur == nil {
				cur = &leaseState{l: proto.Lease{Holder: w.src, AcquiredAt: stamp(now)}, key: w.key}
				m.lease = cur
			}
			cur.l.Holder.By = ""
			cur.expires = now.Add(ttl)
			cur.l.ExpiresAt = stamp(cur.expires)
			if cur.timer != nil {
				cur.timer.Stop()
			}
			id := p.ID()
			ls := cur
			cur.timer = time.AfterFunc(ttl, func() { s.expireLease(id, ls) })
			out := cur.view()
			d.mu.Unlock()
			s.leaseEvent(p)
			return out, nil
		}
		held := cur.l
		if wait <= 0 || !time.Now().Before(deadline) {
			d.mu.Unlock()
			return proto.Lease{}, leaseError(p.ID(), held)
		}
		lw := &leaseWaiter{w: w, ttl: ttl, ch: make(chan struct{})}
		cur.waiters = append(cur.waiters, lw)
		d.mu.Unlock()
		s.leaseEvent(p)
		t := time.NewTimer(time.Until(deadline))
		select {
		case <-lw.ch:
			t.Stop()
			d.mu.Lock()
			refused := lw.refused
			d.mu.Unlock()
			if refused {
				return proto.Lease{}, leaseError(p.ID(), held)
			}
		case <-t.C:
			s.unwait(p, lw)
		case <-ctx.Done():
			t.Stop()
			s.unwait(p, lw)
			return proto.Lease{}, ctx.Err()
		}
	}
}

// unwait takes a waiter that gave up out of the queue.
func (s *Server) unwait(p *pane.Pane, lw *leaseWaiter) {
	d := s.drive
	d.mu.Lock()
	m := d.meta[p.ID()]
	gone := false
	if m != nil && m.lease != nil {
		for i, x := range m.lease.waiters {
			if x == lw {
				m.lease.waiters = append(m.lease.waiters[:i:i], m.lease.waiters[i+1:]...)
				gone = true
				break
			}
		}
	}
	d.mu.Unlock()
	if gone {
		s.leaseEvent(p)
	}
}

// dropLeaseLocked ends a pane's lease and wakes its first waiter; d.mu
// is held.
func (s *Server) dropLeaseLocked(m *paneMeta) {
	l := m.lease
	if l == nil {
		return
	}
	if l.timer != nil {
		l.timer.Stop()
	}
	m.lease = nil
	if len(l.waiters) == 0 {
		return
	}
	// The first in line is handed the lease, with the time it asked for;
	// the others wait on, in turn, for it.
	next := l.waiters[0]
	now := time.Now()
	nl := &leaseState{l: proto.Lease{Holder: next.w.src, AcquiredAt: stamp(now)}, key: next.w.key, waiters: l.waiters[1:]}
	nl.l.Holder.By = ""
	nl.expires = now.Add(next.ttl)
	nl.l.ExpiresAt = stamp(nl.expires)
	m.lease = nl
	if id := m.id; id != "" {
		nl.timer = time.AfterFunc(next.ttl, func() { s.expireLease(id, nl) })
	}
	close(next.ch)
}

// refuseWaitersLocked fails every driver waiting for a pane's lease: the
// person took the pane back. d.mu is held.
func (s *Server) refuseWaitersLocked(m *paneMeta) {
	if m.lease == nil {
		return
	}
	for _, w := range m.lease.waiters {
		w.refused = true
		close(w.ch)
	}
	m.lease.waiters = nil
}

func (s *Server) expireLease(id string, ls *leaseState) {
	s.drive.mu.Lock()
	m := s.drive.meta[id]
	if m == nil || m.lease != ls {
		s.drive.mu.Unlock()
		return
	}
	s.dropLeaseLocked(m)
	s.drive.mu.Unlock()
	if p, err := s.o.Manager.Get(id); err == nil {
		s.leaseEvent(p)
	}
}

// release lets go of the lease: its holder may, and the person may end
// anyone's.
func (s *Server) release(p *pane.Pane, w who, refuseWaiting bool) error {
	s.drive.mu.Lock()
	m := s.drive.meta[p.ID()]
	if m == nil || m.lease == nil {
		s.drive.mu.Unlock()
		return notFound("pane %s has no lease", p.ID())
	}
	if m.lease.key != w.key && !w.person {
		h := m.lease.l
		s.drive.mu.Unlock()
		return leaseError(p.ID(), h)
	}
	if refuseWaiting && w.person {
		s.refuseWaitersLocked(m)
	}
	s.dropLeaseLocked(m)
	s.drive.mu.Unlock()
	s.leaseEvent(p)
	return nil
}

func (s *Server) leaseEvent(p *pane.Pane) {
	pi := s.paneInfo(p.Info())
	ev := proto.Event{V: proto.Version, Type: "event", Event: "pane.lease", Pane: &pi}
	for _, c := range s.connections(func(c *conn) bool { return c.unwatch != nil }) {
		c.event(ev)
	}
}

// ------------------------------------------------------------ pane life

// paneGone forgets what a closed pane held: its record, its leases and
// the grants on it or to it. A lease its agent held elsewhere ends too.
func (s *Server) paneGone(id string) {
	d := s.drive
	var freed []string
	d.mu.Lock()
	if m := d.meta[id]; m != nil {
		s.refuseWaitersLocked(m)
		s.dropLeaseLocked(m)
	}
	for pid, m := range d.meta {
		if m.lease != nil && m.lease.key == "pane:"+id {
			s.dropLeaseLocked(m)
			freed = append(freed, pid)
		}
	}
	// The creator chain stays readable for panes the closed one started:
	// keep its creator, drop the rest.
	if m := d.meta[id]; m != nil {
		d.meta[id] = &paneMeta{id: id, creator: m.creator, creatorKey: m.creatorKey}
	}
	for gid, g := range d.grants {
		if g.g.Pane == id || g.key == "pane:"+id {
			delete(d.grants, gid)
		}
	}
	for k := range d.asking {
		if strings.Contains(k, "|"+id+"|") || strings.HasPrefix(k, "pane:"+id+"|") {
			delete(d.asking, k)
		}
	}
	d.mu.Unlock()
	for _, pid := range freed {
		if p, err := s.o.Manager.Get(pid); err == nil {
			s.leaseEvent(p)
		}
	}
}

// connGone ends what a client's connection held: its grants and leases.
func (s *Server) connGone(c *conn) {
	key := fmt.Sprintf("conn:%d", c.serial)
	var freed []string
	d := s.drive
	d.mu.Lock()
	for gid, g := range d.grants {
		if g.conn == c {
			delete(d.grants, gid)
		}
	}
	for pid, m := range d.meta {
		if m.lease != nil && m.lease.key == key {
			s.dropLeaseLocked(m)
			freed = append(freed, pid)
		}
		if m.keysConn == c {
			m.keysConn = nil
		}
	}
	d.mu.Unlock()
	for _, pid := range freed {
		if p, err := s.o.Manager.Get(pid); err == nil {
			s.leaseEvent(p)
		}
	}
}

// driveInfo adds who started a pane and its lease to its Pane object.
func (s *Server) driveInfo(p *proto.Pane) {
	s.drive.mu.Lock()
	defer s.drive.mu.Unlock()
	m := s.drive.meta[p.ID]
	if m == nil {
		return
	}
	cr := m.creator
	p.Creator = &cr
	if m.lease != nil && time.Now().Before(m.lease.expires) {
		l := m.lease.view()
		p.Lease = &l
	}
}

// view is the lease as clients see it, with who waits for it in turn.
func (l *leaseState) view() proto.Lease {
	out := l.l
	out.Waiting = nil
	for _, w := range l.waiters {
		out.Waiting = append(out.Waiting, w.w.src)
	}
	return out
}
