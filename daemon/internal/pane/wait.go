package pane

import (
	"context"
	"errors"
	"regexp"
	"time"
)

// WaitSpec is a set of conditions; Wait returns when the first one holds.
type WaitSpec struct {
	// Text matches new output (escape sequences removed) from Since on,
	// or, with Screen, the visible screen.
	Text   *regexp.Regexp
	Screen bool
	// Quiet holds once the pane has printed nothing for this long, counted
	// from the later of the start of the wait and the last output.
	Quiet time.Duration
	// Exit holds once the pane's first process has exited.
	Exit bool
	// Since is the mark new output is counted from; nil means now.
	Since *uint64
	// Timeout ends the wait; zero means no limit (the context still can).
	Timeout time.Duration
}

// RowChange is one visible row that differs.
type RowChange struct {
	Row           int
	Before, After string
}

// WaitResult says which condition held and what changed.
type WaitResult struct {
	// Condition is "text", "quiet", "exit" or "timeout".
	Condition string
	Since     uint64
	Mark      uint64
	// Output is the new output since Since, escape sequences removed,
	// at most OutputLimit bytes (the end of it when Truncated).
	Output    string
	Truncated bool
	// Match and Groups are set for "text".
	Match  string
	Groups []string
	Exit   *Exit
	// Changes are the visible rows that differ from the start of the wait.
	Changes []RowChange
	Screen  []string
}

// OutputLimit caps WaitResult.Output; matching sees up to matchWindow.
const (
	OutputLimit = 64 << 10
	matchWindow = 1 << 20
)

// exitDrain is how long after its process exits a pane's output may
// still be read before an exit wait returns anyway.
const exitDrain = 250 * time.Millisecond

// ErrBadSpec is returned for a wait with no condition.
var ErrBadSpec = errors.New("wait needs at least one condition: text, quiet or exit")

// Wait waits for a condition. before, when not nil, is the screen to
// compare against instead of the screen at the start of the wait.
func (p *Pane) Wait(ctx context.Context, spec WaitSpec, before []string) (*WaitResult, error) {
	if spec.Text == nil && spec.Quiet <= 0 && !spec.Exit {
		return nil, ErrBadSpec
	}
	start := time.Now()
	var strip stripper
	var text []byte
	feed := func(b []byte) {
		text = strip.append(text, b)
		if len(text) > matchWindow {
			text = append(text[:0], text[len(text)-matchWindow/2:]...)
		}
	}
	t := &tap{fn: feed}

	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil, ErrClosed
	}
	since := p.offset
	if spec.Since != nil {
		if *spec.Since > p.offset {
			p.mu.Unlock()
			return nil, errors.New("since is ahead of the pane's output")
		}
		since = *spec.Since
		if since < p.offset {
			old, from, err := p.log.read(since, int(p.offset-since))
			if err != nil {
				p.mu.Unlock()
				return nil, err
			}
			since = from
			feed(old)
		}
	}
	if before == nil {
		before, _ = p.screen.Text()
	}
	p.taps[t] = struct{}{}
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		delete(p.taps, t)
		p.mu.Unlock()
	}()

	var deadline <-chan time.Time
	if spec.Timeout > 0 {
		tm := time.NewTimer(spec.Timeout)
		defer tm.Stop()
		deadline = tm.C
	}
	quietTimer := time.NewTimer(time.Hour)
	defer quietTimer.Stop()

	for {
		p.mu.Lock()
		if p.closed {
			p.mu.Unlock()
			return nil, ErrClosed
		}
		changed := p.changed
		var cond string
		var match []string
		// The exit holds once the output has drained too (the pty reached
		// its end), or a moment after the exit when a background process
		// still holds the pty open.
		var exitLeft time.Duration
		if spec.Exit && p.exit != nil {
			exitLeft = exitDrain - time.Since(p.exitedAt)
			if p.ended || exitLeft <= 0 {
				cond = "exit"
			}
		}
		if spec.Text != nil {
			if spec.Screen {
				lines, _ := p.screen.Text()
				match = spec.Text.FindStringSubmatch(joinLines(lines))
			} else {
				match = findBytes(spec.Text, text)
			}
			if match != nil {
				cond = "text"
			}
		}
		var quietLeft time.Duration
		if cond == "" && spec.Quiet > 0 {
			from := start
			if p.lastOutput.After(from) {
				from = p.lastOutput
			}
			quietLeft = spec.Quiet - time.Since(from)
			if quietLeft <= 0 {
				cond = "quiet"
			}
		}
		if cond != "" {
			r := p.result(cond, since, text, before)
			if match != nil {
				r.Match = match[0]
				r.Groups = match[1:]
			}
			p.mu.Unlock()
			return r, nil
		}
		p.mu.Unlock()

		next := time.Duration(0)
		if spec.Quiet > 0 {
			next = quietLeft
		}
		if exitLeft > 0 && (next == 0 || exitLeft < next) {
			next = exitLeft
		}
		if next > 0 {
			if !quietTimer.Stop() {
				select {
				case <-quietTimer.C:
				default:
				}
			}
			quietTimer.Reset(next)
		}
		select {
		case <-changed:
		case <-quietTimer.C:
		case <-deadline:
			p.mu.Lock()
			if p.closed {
				p.mu.Unlock()
				return nil, ErrClosed
			}
			r := p.result("timeout", since, text, before)
			p.mu.Unlock()
			return r, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// result builds a WaitResult; the pane's lock is held.
func (p *Pane) result(cond string, since uint64, text []byte, before []string) *WaitResult {
	r := &WaitResult{Condition: cond, Since: since, Mark: p.offset}
	if len(text) > OutputLimit {
		text = text[len(text)-OutputLimit:]
		r.Truncated = true
	}
	r.Output = string(text)
	if p.exit != nil {
		e := *p.exit
		r.Exit = &e
	}
	after, _ := p.screen.Text()
	r.Screen = after
	r.Changes = diffRows(before, after)
	return r
}

func diffRows(before, after []string) []RowChange {
	var out []RowChange
	for i := 0; i < max(len(before), len(after)); i++ {
		var b, a string
		if i < len(before) {
			b = before[i]
		}
		if i < len(after) {
			a = after[i]
		}
		if a != b {
			out = append(out, RowChange{Row: i, Before: b, After: a})
		}
	}
	return out
}

func findBytes(re *regexp.Regexp, b []byte) []string {
	m := re.FindSubmatch(b)
	if m == nil {
		return nil
	}
	out := make([]string, len(m))
	for i := range m {
		out[i] = string(m[i])
	}
	return out
}

func joinLines(lines []string) string {
	n := 0
	for _, l := range lines {
		n += len(l) + 1
	}
	b := make([]byte, 0, n)
	for i, l := range lines {
		if i > 0 {
			b = append(b, '\n')
		}
		b = append(b, l...)
	}
	return string(b)
}

// StripEscapes returns output with its escape sequences and control
// characters removed, keeping text, newlines and tabs.
func StripEscapes(b []byte) string {
	var s stripper
	return string(s.append(make([]byte, 0, len(b)), b))
}

// stripper removes terminal escape sequences from output, keeping the
// text and newlines. It keeps its state between chunks, so a sequence
// split across two reads is still removed.
type stripper struct{ state uint8 }

const (
	stGround uint8 = iota
	stEsc
	stCSI
	stOSC
	stOSCEsc
	stString
	stStringEsc
	stCharset
)

func (s *stripper) append(dst, src []byte) []byte {
	for _, c := range src {
		switch s.state {
		case stGround:
			switch {
			case c == 0x1b:
				s.state = stEsc
			case c == '\n' || c == '\t':
				dst = append(dst, c)
			case c < 0x20 || c == 0x7f:
				// Other controls (CR, BS, BEL) carry no text.
			default:
				dst = append(dst, c)
			}
		case stEsc:
			switch c {
			case '[':
				s.state = stCSI
			case ']':
				s.state = stOSC
			case 'P', 'X', '^', '_':
				s.state = stString
			case '(', ')', '*', '+', '-', '.', '/', '#', '%', ' ':
				s.state = stCharset
			default:
				s.state = stGround
			}
		case stCSI:
			if c >= 0x40 && c <= 0x7e {
				s.state = stGround
			}
		case stOSC:
			switch c {
			case 0x07:
				s.state = stGround
			case 0x1b:
				s.state = stOSCEsc
			}
		case stOSCEsc:
			s.state = stGround
			if c != '\\' {
				s.state = stOSC
			}
		case stString:
			if c == 0x1b {
				s.state = stStringEsc
			}
		case stStringEsc:
			s.state = stString
			if c == '\\' {
				s.state = stGround
			}
		case stCharset:
			s.state = stGround
		}
	}
	return dst
}
