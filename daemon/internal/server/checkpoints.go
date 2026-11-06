package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base32"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"ravenryd/internal/pane"
	"ravenryd/internal/proto"
)

// Checkpoints (PROTOCOL.md section 4): an agent waits for a person. It
// asks a question (ask), proposes a command that runs only once a person
// approves it (approve), or asks for a secret a person types (secret),
// which goes into a pane's input or into one command's environment and
// never to the agent, a log, a capture or a report.
//
// The daemon holds them, so an agent on any machine reaches a person
// through its own daemon: whoever shows them (the hub, the app) follows
// checkpoint.* events and answers with checkpoint.answer.

const (
	maxOpenCheckpoints   = 64
	keepClosed           = 64
	defaultCheckpointTTL = time.Hour
	maxCheckpointTTL     = 24 * time.Hour
	maxTitle             = 1000
	maxOptions           = 8
	maxOption            = 100
	maxCommand           = 8 << 10
	maxAnswerText        = 4 << 10
	maxSecret            = 4 << 10
	maxBy                = 64
	runOutput            = 64 << 10
	maxRun               = 7 * 24 * time.Hour
)

// Checkpoint kinds and states.
const (
	kindAsk     = "ask"
	kindApprove = "approve"
	kindSecret  = "secret"

	stOpen      = "open"
	stRunning   = "running"
	stAnswered  = "answered"
	stDeclined  = "declined"
	stCancelled = "cancelled"
	stExpired   = "expired"
)

type checkpoints struct {
	mu     sync.Mutex
	all    map[string]*cpoint // open and running ones, and the last closed
	closed []string           // ids of closed ones, oldest first
}

type cpoint struct {
	c     proto.Checkpoint
	done  chan struct{} // closed once the checkpoint is closed
	timer *time.Timer
}

func newCheckpoints() *checkpoints { return &checkpoints{all: map[string]*cpoint{}} }

func newCheckpointID() string {
	var b [5]byte
	rand.Read(b[:])
	return "c" + strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b[:]))[:7]
}

func final(state string) bool {
	return state == stAnswered || state == stDeclined || state == stCancelled || state == stExpired
}

var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)

// textOK allows a person's text: no control characters but newlines and
// tabs.
func textOK(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return false
		}
	}
	return true
}

// checkNew validates checkpoint.new and fills in what the daemon knows.
func (c *conn) checkNew(r proto.CheckpointNewRequest) (proto.Checkpoint, time.Duration, error) {
	var zero proto.Checkpoint
	if r.Title == "" || len(r.Title) > maxTitle || !textOK(r.Title) {
		return zero, 0, bad("title is 1 to %d bytes with no control characters but newlines", maxTitle)
	}
	cp := proto.Checkpoint{Kind: r.Kind, Title: r.Title, Pane: r.Pane}
	var asker *pane.Pane
	if r.Pane != "" {
		p, err := c.s.o.Manager.Get(r.Pane)
		if err != nil {
			return zero, 0, err
		}
		asker = p
		if st := c.s.agents.Status(r.Pane); st != nil && st.State != "ended" {
			cp.Assistant = st.Assistant
		}
	}
	noAsk := len(r.Options) > 0 || r.FreeText
	noRun := r.Command != "" || r.Cwd != "" || r.Why != ""
	switch r.Kind {
	case kindAsk:
		if noRun || r.Secret != nil {
			return zero, 0, bad("an ask takes options and free_text, not command, cwd, why or secret")
		}
		if len(r.Options) == 0 && !r.FreeText {
			return zero, 0, bad("an ask needs options, free_text or both")
		}
		if len(r.Options) > maxOptions {
			return zero, 0, bad("at most %d options", maxOptions)
		}
		for i, o := range r.Options {
			if o == "" || len(o) > maxOption || !plainText(o) {
				return zero, 0, bad("option %d is 1 to %d bytes with no control characters", i, maxOption)
			}
		}
		cp.Options, cp.FreeText = r.Options, r.FreeText
	case kindApprove:
		if noAsk || r.Secret != nil {
			return zero, 0, bad("an approve takes command, cwd and why, not options, free_text or secret")
		}
		if err := checkRun(r); err != nil {
			return zero, 0, err
		}
		cp.Command, cp.Why = r.Command, r.Why
	case kindSecret:
		if noAsk || r.Why != "" {
			return zero, 0, bad("a secret takes secret (and command and cwd with to: run or env), not options, free_text or why")
		}
		t := r.Secret
		if t == nil {
			return zero, 0, bad("a secret needs secret: {to: input, pane}, {to: run} with command, or {to: env, env} with command")
		}
		switch t.To {
		case "input":
			if t.Env != "" || r.Command != "" || r.Cwd != "" {
				return zero, 0, bad("a secret for a pane's input takes secret.pane, not env, command or cwd")
			}
			p, err := c.pane(t.Pane)
			if err != nil {
				if t.Pane == "" {
					return zero, 0, bad("secret.pane is required with to: input")
				}
				return zero, 0, err
			}
			if t.Pane == r.Pane {
				return zero, 0, bad("a secret never goes into the asking agent's own pane: name the pane of the program that asks for it")
			}
			if !p.Info().Running() {
				return zero, 0, fmt.Errorf("pane %s has exited", t.Pane)
			}
		case "run":
			if t.Pane != "" || t.Env != "" {
				return zero, 0, bad("a secret typed into a command takes command, not secret.pane or secret.env")
			}
			if err := checkRun(r); err != nil {
				return zero, 0, err
			}
			cp.Command = r.Command
		case "env":
			if t.Pane != "" || t.Enter != nil {
				return zero, 0, bad("a secret for a command's environment takes secret.env and command, not secret.pane or secret.enter")
			}
			if !envName.MatchString(t.Env) || strings.HasPrefix(t.Env, "RAVENRY_") {
				return zero, 0, bad("secret.env is a variable name (letters, digits, _), not RAVENRY_*")
			}
			if err := checkRun(r); err != nil {
				return zero, 0, err
			}
			cp.Command = r.Command
		default:
			return zero, 0, bad("secret.to is input, run or env")
		}
		st := *t
		cp.Secret = &st
	default:
		return zero, 0, bad("kind is ask, approve or secret")
	}
	if cp.Command != "" {
		cp.Cwd = r.Cwd
		if cp.Cwd == "" && asker != nil {
			cp.Cwd = asker.Info().Cwd
		}
		if cp.Cwd == "" {
			cp.Cwd, _ = os.UserHomeDir()
		}
	}
	ttl := defaultCheckpointTTL
	if r.TimeoutMs != nil {
		ttl = time.Duration(*r.TimeoutMs) * time.Millisecond
		if ttl <= 0 || ttl > maxCheckpointTTL {
			return zero, 0, bad("timeout_ms must be between 1 and %d", maxCheckpointTTL.Milliseconds())
		}
	}
	return cp, ttl, nil
}

func checkRun(r proto.CheckpointNewRequest) error {
	if r.Command == "" || len(r.Command) > maxCommand || !textOK(r.Command) {
		return bad("command is 1 to %d bytes with no control characters but newlines", maxCommand)
	}
	if len(r.Why) > maxTitle || !textOK(r.Why) {
		return bad("why is at most %d bytes", maxTitle)
	}
	if r.Cwd != "" {
		if !filepath.IsAbs(r.Cwd) {
			return bad("cwd is an absolute path")
		}
		if fi, err := os.Stat(r.Cwd); err != nil || !fi.IsDir() {
			return fmt.Errorf("working directory %q does not exist", r.Cwd)
		}
	}
	return nil
}

func (c *conn) checkpointNew(id uint64, data []byte) {
	var r proto.CheckpointNewRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	cp, ttl, err := c.checkNew(r)
	if err != nil {
		c.failErr(id, err)
		return
	}
	s := c.s
	now := time.Now()
	cp.State = stOpen
	cp.CreatedAt, cp.ExpiresAt = stamp(now), stamp(now.Add(ttl))
	s.cps.mu.Lock()
	open := 0
	for _, x := range s.cps.all {
		if !final(x.c.State) {
			open++
		}
	}
	if open >= maxOpenCheckpoints {
		s.cps.mu.Unlock()
		c.failErr(id, fmt.Errorf("%d checkpoints are open already", open))
		return
	}
	cp.ID = newCheckpointID()
	x := &cpoint{c: cp, done: make(chan struct{})}
	s.cps.all[cp.ID] = x
	x.timer = time.AfterFunc(ttl, func() { s.closeCheckpoint(cp.ID, stOpen, stExpired, nil, "") })
	out := x.c
	s.cps.mu.Unlock()
	c.reply(id, "checkpoint.new", proto.CheckpointResult{Checkpoint: out})
	s.checkpointEvent("checkpoint.opened", out)
}

// checkpointEvent tells every connection that subscribed to events.
func (s *Server) checkpointEvent(name string, cp proto.Checkpoint) {
	ev := proto.Event{V: proto.Version, Type: "event", Event: name, Checkpoint: &cp}
	for _, c := range s.connections(func(c *conn) bool { return c.unwatch != nil }) {
		c.event(ev)
	}
}

// closeCheckpoint moves a checkpoint from one of the states in from (open
// or running) to a final state, and tells the subscribers. It reports
// whether it did.
func (s *Server) closeCheckpoint(id, from, to string, answer *proto.CheckpointAnswer, reason string) (proto.Checkpoint, bool) {
	s.cps.mu.Lock()
	x := s.cps.all[id]
	if x == nil || x.c.State != from {
		s.cps.mu.Unlock()
		return proto.Checkpoint{}, false
	}
	x.c.State = to
	x.c.ClosedAt = stamp(time.Now())
	if answer != nil {
		x.c.Answer = answer
	}
	if reason != "" {
		x.c.Reason = reason
	}
	if x.timer != nil {
		x.timer.Stop()
	}
	close(x.done)
	s.cps.closed = append(s.cps.closed, id)
	if len(s.cps.closed) > keepClosed {
		delete(s.cps.all, s.cps.closed[0])
		s.cps.closed = s.cps.closed[1:]
	}
	out := x.c
	s.cps.mu.Unlock()
	s.checkpointEvent("checkpoint.closed", out)
	return out, true
}

func (s *Server) checkpoint(id string) (*cpoint, error) {
	if id == "" {
		return nil, bad("checkpoint is required")
	}
	s.cps.mu.Lock()
	defer s.cps.mu.Unlock()
	x := s.cps.all[id]
	if x == nil {
		return nil, notFound("no checkpoint %s (it closed long ago, or never was)", id)
	}
	return x, nil
}

func (c *conn) checkpointList(id uint64, data []byte) {
	var r proto.CheckpointListRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	s := c.s
	s.cps.mu.Lock()
	out := []proto.Checkpoint{}
	for _, x := range s.cps.all {
		if r.All || !final(x.c.State) {
			out = append(out, x.c)
		}
	}
	s.cps.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	c.reply(id, "checkpoint.list", proto.CheckpointListResult{Checkpoints: out})
}

func (c *conn) checkpointWait(id uint64, data []byte) {
	var r proto.CheckpointWaitRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	x, err := c.s.checkpoint(r.Checkpoint)
	if err != nil {
		c.failErr(id, err)
		return
	}
	timeout := maxWaitTimeout
	if r.TimeoutMs != nil {
		timeout = time.Duration(*r.TimeoutMs) * time.Millisecond
		if timeout <= 0 || timeout > maxWaitTimeout {
			c.failErr(id, bad("timeout_ms must be between 1 and %d", maxWaitTimeout.Milliseconds()))
			return
		}
	}
	c.track(id, func(ctx context.Context) {
		t := time.NewTimer(timeout)
		defer t.Stop()
		select {
		case <-x.done:
		case <-t.C:
		case <-ctx.Done():
			if c.ctx.Err() == nil {
				c.failErr(id, ctx.Err())
			}
			return
		}
		c.s.cps.mu.Lock()
		out := x.c
		c.s.cps.mu.Unlock()
		c.reply(id, "checkpoint.wait", proto.CheckpointResult{Checkpoint: out})
	})
}

func (c *conn) checkpointCancel(id uint64, data []byte) {
	var r proto.CheckpointCancelRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	if len(r.Reason) > maxTitle || !textOK(r.Reason) {
		c.failErr(id, bad("reason is at most %d bytes", maxTitle))
		return
	}
	if _, err := c.s.checkpoint(r.Checkpoint); err != nil {
		c.failErr(id, err)
		return
	}
	out, ok := c.s.closeCheckpoint(r.Checkpoint, stOpen, stCancelled, nil, r.Reason)
	if !ok {
		c.failErr(id, notFound("checkpoint %s is not open: it was answered, is running, or closed", r.Checkpoint))
		return
	}
	c.reply(id, "checkpoint.cancel", proto.CheckpointResult{Checkpoint: out})
}

func (c *conn) checkpointAnswer(id uint64, data []byte) {
	var r proto.CheckpointAnswerRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	n := 0
	for _, set := range []bool{r.Choice != nil, r.Text != nil, r.Approve, r.Secret != nil, r.Decline} {
		if set {
			n++
		}
	}
	if n != 1 {
		c.failErr(id, bad("an answer is exactly one of choice, text, approve, secret or decline"))
		return
	}
	if len(r.By) > maxBy || !plainText(r.By) {
		c.failErr(id, bad("by is at most %d bytes", maxBy))
		return
	}
	s := c.s
	x, err := s.checkpoint(r.Checkpoint)
	if err != nil {
		c.failErr(id, err)
		return
	}
	s.cps.mu.Lock()
	cp := x.c
	s.cps.mu.Unlock()
	if cp.State != stOpen {
		c.failErr(id, notFound("checkpoint %s is not open: it was answered, is running, or closed", r.Checkpoint))
		return
	}
	ans := &proto.CheckpointAnswer{By: r.By, At: stamp(time.Now())}
	reply := func(out proto.Checkpoint, ok bool) {
		if !ok {
			c.failErr(id, notFound("checkpoint %s was answered or closed meanwhile", r.Checkpoint))
			return
		}
		c.reply(id, "checkpoint.answer", proto.CheckpointResult{Checkpoint: out})
	}
	if r.Decline {
		ans.Declined = true
		reply(s.closeCheckpoint(cp.ID, stOpen, stDeclined, ans, ""))
		return
	}
	switch cp.Kind {
	case kindAsk:
		switch {
		case r.Choice != nil:
			if *r.Choice < 0 || *r.Choice >= len(cp.Options) {
				c.failErr(id, bad("choice is an index into options, 0 to %d", len(cp.Options)-1))
				return
			}
			ch := *r.Choice
			ans.Choice, ans.Option = &ch, cp.Options[ch]
		case r.Text != nil:
			if !cp.FreeText {
				c.failErr(id, bad("this ask takes one of its options, not text"))
				return
			}
			if len(*r.Text) > maxAnswerText || !textOK(*r.Text) {
				c.failErr(id, bad("text is at most %d bytes", maxAnswerText))
				return
			}
			t := *r.Text
			ans.Text = &t
		default:
			c.failErr(id, bad("an ask is answered with choice, text or decline"))
			return
		}
		reply(s.closeCheckpoint(cp.ID, stOpen, stAnswered, ans, ""))
	case kindApprove:
		if !r.Approve {
			c.failErr(id, bad("an approve is answered with approve or decline"))
			return
		}
		yes := true
		ans.Approved = &yes
		reply(s.startRun(cp, ans, nil, nil))
	case kindSecret:
		if r.Secret == nil {
			c.failErr(id, bad("a secret is answered with secret or decline"))
			return
		}
		sec := *r.Secret
		if len(sec) < pane.MinSecret || len(sec) > maxSecret || strings.ContainsAny(sec, "\r\n\x00") {
			c.failErr(id, bad("a secret is %d to %d bytes on one line", pane.MinSecret, maxSecret))
			return
		}
		ans.Delivered = true
		switch cp.Secret.To {
		case "env":
			reply(s.startRun(cp, ans, map[string]string{cp.Secret.Env: sec}, nil))
			return
		case "run":
			in := []byte(sec)
			if cp.Secret.Enter == nil || *cp.Secret.Enter {
				in = append(in, '\r')
			}
			reply(s.startRun(cp, ans, nil, in))
			return
		}
		p, err := s.o.Manager.Get(cp.Secret.Pane)
		if err != nil {
			c.failErr(id, fmt.Errorf("its pane %s is gone", cp.Secret.Pane))
			return
		}
		// Masked from now on, before the program can echo it; then typed.
		if err := p.AddSecret([]byte(sec)); err != nil {
			c.failErr(id, err)
			return
		}
		in := []byte(sec)
		if cp.Secret.Enter == nil || *cp.Secret.Enter {
			in = append(in, '\r')
		}
		if _, ok := s.claim(cp.ID, stAnswered); !ok {
			reply(proto.Checkpoint{}, false)
			return
		}
		err = p.Input(in)
		clear(in)
		if err != nil {
			s.closeCheckpoint(cp.ID, stAnswered, stAnswered, nil, "the pane closed before the secret was typed")
			c.failErr(id, fmt.Errorf("its pane %s closed", cp.Secret.Pane))
			return
		}
		ans.Delivered = true
		reply(s.closeCheckpoint(cp.ID, stAnswered, stAnswered, ans, ""))
	}
}

// claim moves an open checkpoint to an in-between state (running, or
// answered while its secret is typed) so no second answer is taken.
// closeCheckpoint then finishes it from that state.
func (s *Server) claim(id, to string) (proto.Checkpoint, bool) {
	s.cps.mu.Lock()
	defer s.cps.mu.Unlock()
	x := s.cps.all[id]
	if x == nil || x.c.State != stOpen {
		return proto.Checkpoint{}, false
	}
	x.c.State = to
	if x.timer != nil {
		x.timer.Stop()
	}
	return x.c, true
}

// startRun runs an approved command in a new pane, in the checkpoint's
// folder, with the secret in its environment (secretEnv, for to: env) or
// typed once it waits for input (typed, for to: run), and closes the
// checkpoint with its exit and the end of its output once it ended.
func (s *Server) startRun(cp proto.Checkpoint, ans *proto.CheckpointAnswer, secretEnv map[string]string, typed []byte) (proto.Checkpoint, bool) {
	if _, ok := s.claim(cp.ID, stRunning); !ok {
		return proto.Checkpoint{}, false
	}
	name := "Approved: " + clip(strings.Join(strings.Fields(cp.Command), " "), 60)
	p, err := s.o.Manager.New(pane.Config{
		Command:   []string{s.o.Manager.LoginShell(), "-c", cp.Command},
		Cwd:       cp.Cwd,
		Name:      name,
		Labels:    map[string]string{"ravenry.checkpoint": cp.ID},
		SecretEnv: secretEnv,
	})
	clear(secretEnv)
	if err != nil {
		clear(typed)
		return s.closeCheckpoint(cp.ID, stRunning, stAnswered, ans, "the command did not start: "+err.Error())
	}
	if typed != nil {
		// Masked before the program can echo it, then typed once the
		// program has printed its prompt and gone quiet.
		p.AddSecret(bytes.TrimRight(typed, "\r"))
		go typeWhenWaiting(p, typed)
	}
	s.cps.mu.Lock()
	x := s.cps.all[cp.ID]
	x.c.Answer = ans
	x.c.Run = &proto.CheckpointRun{Pane: p.ID()}
	out := x.c
	s.cps.mu.Unlock()
	s.checkpointEvent("checkpoint.running", out)
	go s.finishRun(cp.ID, p)
	return out, true
}

// typeWhenWaiting types a secret into a program that just started, once it
// printed something and then went quiet for a moment (its prompt), or
// after 15 s whatever it does. A program that reads before it prints gets
// it after the first quiet moment.
func typeWhenWaiting(p *pane.Pane, in []byte) {
	defer clear(in)
	var zero uint64
	ctx := context.Background()
	if w, err := p.Wait(ctx, pane.WaitSpec{Text: anyText, Since: &zero, Exit: true, Timeout: 15 * time.Second}, nil); err != nil || w.Condition == "exit" {
		return
	}
	if w, err := p.Wait(ctx, pane.WaitSpec{Quiet: 300 * time.Millisecond, Exit: true, Timeout: 15 * time.Second}, nil); err != nil || w.Condition == "exit" {
		return
	}
	p.Input(in)
}

var anyText = regexp.MustCompile(`[^\s]`)

func (s *Server) finishRun(id string, p *pane.Pane) {
	var zero uint64
	w, err := p.Wait(context.Background(), pane.WaitSpec{Exit: true, Since: &zero, Timeout: maxRun}, nil)
	run := &proto.CheckpointRun{Pane: p.ID()}
	reason := ""
	switch {
	case errors.Is(err, pane.ErrClosed):
		reason = "its pane was closed before the command ended"
	case err != nil:
		reason = err.Error()
	case w.Exit == nil:
		reason = "the command was still running after a week"
	default:
		run.Exit = &proto.Exit{Code: w.Exit.Code, Signal: w.Exit.Signal}
		end := p.Mark()
		from := uint64(0)
		if end > runOutput {
			from = end - runOutput
		}
		if b, got, _, err := p.Read(from, runOutput); err == nil {
			run.Output = strings.ToValidUTF8(pane.StripEscapes(b), "�")
			run.Truncated = got > 0
		}
	}
	s.cps.mu.Lock()
	if x := s.cps.all[id]; x != nil {
		x.c.Run = run
	}
	s.cps.mu.Unlock()
	s.closeCheckpoint(id, stRunning, stAnswered, nil, reason)
}
