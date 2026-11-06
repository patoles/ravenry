package pane

import (
	"bytes"
	"errors"
	"maps"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Secrets in a pane's output. A secret a person typed for a program in a
// pane (checkpoints, PROTOCOL.md section 4), or gave a command in its
// environment, is masked in everything the pane prints from then on,
// before the screen, the log, streams and waits see it: a program that
// echoes it shows asterisks instead. The secret stays in the daemon's
// memory for the pane's life, and nowhere else.

// maxSecrets is how many secrets a pane masks; the oldest goes first.
const maxSecrets = 16

// MinSecret is the shortest secret: shorter ones would mask ordinary
// output.
const MinSecret = 4

// redactFlush is how long a possible start of a secret at the end of a
// chunk is held back, waiting for the rest.
const redactFlush = 30 * time.Millisecond

// redactor masks secrets in a byte stream that arrives in chunks: a
// secret split across two chunks is still masked, because the end of a
// chunk that could start a secret is held back until the next chunk, or
// until redactFlush passes.
type redactor struct {
	secrets [][]byte
	held    []byte
}

func newRedactor(secrets [][]byte) *redactor {
	r := &redactor{}
	for _, s := range secrets {
		r.add(s)
	}
	return r
}

func (r *redactor) add(s []byte) {
	if len(s) == 0 {
		return
	}
	for _, x := range r.secrets {
		if bytes.Equal(x, s) {
			return
		}
	}
	r.secrets = append(r.secrets, bytes.Clone(s))
	if len(r.secrets) > maxSecrets {
		r.secrets = r.secrets[len(r.secrets)-maxSecrets:]
	}
}

// filter returns the part of the output that can go on now, masked; it
// may keep the end back.
func (r *redactor) filter(in []byte) []byte {
	buf := make([]byte, 0, len(r.held)+len(in))
	buf = append(buf, r.held...)
	buf = append(buf, in...)
	r.held = nil
	for _, s := range r.secrets {
		for i := 0; ; {
			j := bytes.Index(buf[i:], s)
			if j < 0 {
				break
			}
			for k := i + j; k < i+j+len(s); k++ {
				buf[k] = '*'
			}
			i += j + len(s)
		}
	}
	keep := 0
	for _, s := range r.secrets {
		for n := min(len(s)-1, len(buf)); n > keep; n-- {
			if bytes.HasPrefix(s, buf[len(buf)-n:]) {
				keep = n
				break
			}
		}
	}
	if keep > 0 {
		r.held = bytes.Clone(buf[len(buf)-keep:])
		buf = buf[:len(buf)-keep]
	}
	return buf
}

// flush returns what was held back. Nothing more came: a start of a
// secret of MinSecret bytes or more is masked anyway, a shorter one goes
// as it is.
func (r *redactor) flush() []byte {
	h := r.held
	r.held = nil
	if len(h) >= MinSecret-1 {
		for i := range h {
			h[i] = '*'
		}
	}
	return h
}

// armRedactFlush lets held-back output go once nothing more came. The
// pane's lock is held.
func (p *Pane) armRedactFlush() {
	if len(p.redact.held) == 0 || p.redactT != nil {
		return
	}
	p.redactT = time.AfterFunc(redactFlush, func() {
		p.mu.Lock()
		p.redactT = nil
		if p.closed || p.redact == nil {
			p.mu.Unlock()
			return
		}
		b := p.redact.flush()
		if len(b) == 0 {
			p.mu.Unlock()
			return
		}
		p.outputLocked(b)
	})
}

// AddSecret masks a secret in what the pane prints from now on.
func (p *Pane) AddSecret(s []byte) error {
	if len(s) < MinSecret {
		return errors.New("a secret is at least 4 bytes")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return ErrClosed
	}
	if p.redact == nil {
		p.redact = newRedactor(nil)
	}
	p.redact.add(s)
	return nil
}

// Update changes a pane's name and labels: a nil name leaves it, an empty
// one clears it; each label is set, or removed when its value is nil.
// changed reports whether anything changed.
func (p *Pane) Update(name *string, labels map[string]*string) (changed bool, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return false, ErrClosed
	}
	if name != nil && *name != p.name {
		p.name, changed = *name, true
	}
	if len(labels) > 0 {
		next := maps.Clone(p.labels)
		if next == nil {
			next = map[string]string{}
		}
		for k, v := range labels {
			if v == nil {
				delete(next, k)
			} else {
				next[k] = *v
			}
		}
		if len(next) > MaxLabels {
			return false, errors.New("a pane has at most 32 labels")
		}
		if !maps.Equal(next, p.labels) {
			if len(next) == 0 {
				next = nil
			}
			p.labels, changed = next, true
		}
	}
	return changed, nil
}

// MaxLabels is how many labels a pane may have.
const MaxLabels = 32

// localDir reads an OSC 7 URL (file://host/path, or kitty-shell-cwd://)
// and returns the directory when the host is this machine.
func localDir(raw string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "file" && u.Scheme != "kitty-shell-cwd") {
		return "", false
	}
	if !thisHost(u.Hostname()) {
		return "", false
	}
	dir := u.Path
	if dir == "" || !filepath.IsAbs(dir) {
		return "", false
	}
	return filepath.Clean(dir), true
}

var hostname, _ = os.Hostname()

// thisHost reports whether an OSC 7 host names this machine: empty,
// localhost, or the host name (with or without its domain).
func thisHost(h string) bool {
	h = strings.ToLower(strings.TrimSuffix(h, "."))
	if h == "" || h == "localhost" {
		return true
	}
	me := strings.ToLower(hostname)
	short := func(s string) string { a, _, _ := strings.Cut(s, "."); return a }
	return h == me || short(h) == short(me)
}
