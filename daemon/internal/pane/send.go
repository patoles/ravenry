package pane

import (
	"context"
	"fmt"
	"time"

	"ravenryd/internal/vt"
)

// Input modes for text.
const (
	// ModeRaw writes the text as it is, in one write.
	ModeRaw = "raw"
	// ModePaste sends the text as one paste: bracketed (ESC [200~ ...
	// ESC [201~) when the program turned bracketed paste on, and with
	// unsafe control characters removed when it did not.
	ModePaste = "paste"
	// ModeTyped sends the text one character at a time, as typing does,
	// with a pause between characters. Some programs treat input that
	// arrives in one read as a paste; typed input is never one read.
	ModeTyped = "typed"
)

// DefaultTypedDelay is the pause between typed characters.
const DefaultTypedDelay = 10 * time.Millisecond

// InputItem is one piece of input: text in a mode, or a named key.
type InputItem struct {
	Text  string
	Mode  string
	Key   string
	Delay time.Duration // typed mode: the pause between characters
}

// SendResult says what was written.
type SendResult struct {
	// Bytes is how many bytes went to the pty.
	Bytes int
	// Mark is the pane's output position just before the input was
	// written: wait with since=Mark to see what the input caused.
	Mark uint64
}

// Send writes input items in order. It checks every item before writing
// any of them.
func (p *Pane) Send(ctx context.Context, items []InputItem) (SendResult, error) {
	keys := make([]vt.Key, len(items))
	for i, it := range items {
		switch {
		case it.Key != "" && it.Text != "":
			return SendResult{}, fmt.Errorf("input %d: has both text and a key", i)
		case it.Key != "":
			k, err := vt.ParseKey(it.Key)
			if err != nil {
				return SendResult{}, fmt.Errorf("input %d: %w", i, err)
			}
			keys[i] = k
		default:
			switch it.Mode {
			case ModeRaw, ModePaste, ModeTyped:
			default:
				return SendResult{}, fmt.Errorf("input %d: mode must be raw, paste or typed, not %q", i, it.Mode)
			}
		}
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	res := SendResult{Mark: p.Mark()}
	for i, it := range items {
		if it.Key != "" {
			b, err := p.encode(func(s vt.Screen) ([]byte, error) { return s.EncodeKey(keys[i]) })
			if err != nil {
				return res, err
			}
			if err := p.write(b); err != nil {
				return res, err
			}
			res.Bytes += len(b)
			continue
		}
		switch it.Mode {
		case ModeRaw:
			if err := p.write([]byte(it.Text)); err != nil {
				return res, err
			}
			res.Bytes += len(it.Text)
		case ModePaste:
			b, err := p.encode(func(s vt.Screen) ([]byte, error) { return s.EncodePaste([]byte(it.Text)) })
			if err != nil {
				return res, err
			}
			if err := p.write(b); err != nil {
				return res, err
			}
			res.Bytes += len(b)
		case ModeTyped:
			delay := it.Delay
			if delay <= 0 {
				delay = DefaultTypedDelay
			}
			first := true
			for _, r := range it.Text {
				if !first {
					select {
					case <-time.After(delay):
					case <-ctx.Done():
						return res, ctx.Err()
					}
				}
				first = false
				b := []byte(string(r))
				if r == '\n' {
					b = []byte{'\r'}
				}
				if err := p.write(b); err != nil {
					return res, err
				}
				res.Bytes += len(b)
			}
		}
	}
	return res, nil
}

func (p *Pane) encode(f func(vt.Screen) ([]byte, error)) ([]byte, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil, ErrClosed
	}
	return f(p.screen)
}

// SettleSpec is input to send and how to tell that the screen settled.
type SettleSpec struct {
	Input []InputItem
	// Quiet is how long the pane must print nothing; zero means 300 ms.
	Quiet time.Duration
	// Timeout ends the wait; zero means 10 s.
	Timeout time.Duration
}

// Settle sends input, waits until the pane has been quiet for a while, and
// returns what changed on the screen.
func (p *Pane) Settle(ctx context.Context, spec SettleSpec) (SendResult, *WaitResult, error) {
	if spec.Quiet <= 0 {
		spec.Quiet = 300 * time.Millisecond
	}
	if spec.Timeout <= 0 {
		spec.Timeout = 10 * time.Second
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return SendResult{}, nil, ErrClosed
	}
	before, err := p.screen.Text()
	p.mu.Unlock()
	if err != nil {
		return SendResult{}, nil, err
	}
	sent, err := p.Send(ctx, spec.Input)
	if err != nil {
		return sent, nil, err
	}
	w, err := p.Wait(ctx, WaitSpec{Quiet: spec.Quiet, Since: &sent.Mark, Timeout: spec.Timeout}, before)
	return sent, w, err
}
