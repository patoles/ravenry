package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"ravenryd/internal/pane"
	"ravenryd/internal/proto"
)

// Who acts as the person (PROTOCOL.md section 4, Who acts as the person).
// A checkpoint exists so that a person answers it, so the methods below
// are refused to a connection that comes from a program inside a pane (an
// agent, or anything it started), and to one that comes over ssh unless
// it carries the answer key this machine trusts:
//
//   - checkpoint.answer: answering a checkpoint;
//   - agent.decisions and agent.decide: deciding what an assistant's hook
//     answers, which the hub does for the person (a hand-off);
//   - pane.revoke: ending a grant that lets an agent drive a pane.
//
// The daemon judges a connection once, at hello, from the process at the
// other end of the socket (its pid from the kernel: LOCAL_PEERPID on
// macOS, SO_PEERCRED on Linux) and where that process comes from
// (pane.OriginOf, the same marks closing a pane looks for).

var personOnly = map[string]bool{
	"checkpoint.answer": true,
	"agent.decisions":   true,
	"agent.decide":      true,
	// Ending a grant takes back what a person gave.
	"pane.revoke": true,
}

type connKey struct{}

// connContext keeps each accepted connection in its requests' context, so
// ServeHTTP can ask the kernel who is at the other end.
func connContext(ctx context.Context, c net.Conn) context.Context {
	return context.WithValue(ctx, connKey{}, c)
}

// peerPID returns the pid of the process at the other end of a unix
// socket connection, or 0.
func peerPID(nc net.Conn) int {
	uc, ok := nc.(*net.UnixConn)
	if !ok {
		return 0
	}
	sc, err := uc.SyscallConn()
	if err != nil {
		return 0
	}
	pid := 0
	sc.Control(func(fd uintptr) { pid = socketPeerPID(int(fd)) })
	return pid
}

// judge decides, at hello, whether this connection may act as the person.
func (c *conn) judge(key string) {
	o := pane.OriginOf(c.peer, c.s.scope())
	// The Ravenry app's own main process is the person's window, wherever
	// it was started from: on 2026-11-07 an agent opened it with `open -a`
	// from a pane, it inherited RAVENRY_PANE and RAVENRY_SOCKET, and every
	// key the person typed in it became that agent's drive checkpoint. Its
	// hello name alone is not enough (any program can give it): the
	// process must be the app's (pane.DesktopApp).
	app := c.client.Name == pane.DesktopAppClient && pane.DesktopApp(c.peer)
	if app && o.Pane {
		c.s.o.Log.Printf("the Ravenry app (process %d) carries pane %s's variables or runs under it; its window is the person's, so it is judged as the person", c.peer, firstNonEmpty(o.PaneID, "?"))
		o.Pane, o.PaneID = false, ""
	}
	person, why := o.Person(), o.Why()
	if c.peer == 0 {
		why = "the daemon could not tell which process this connection comes from"
	}
	if o.Known && !o.Pane && o.SSH {
		switch ok, err := c.s.keys.allow(key); {
		case err != nil:
			why = "this connection comes over ssh, and the daemon could not read the answer key it trusts: " + err.Error()
		case key == "":
			why = o.Why() + " and gave no answer key"
		case !ok:
			why = o.Why() + " and its answer key is not the one this machine trusts (to trust another hub, delete " + c.s.keys.where() + " on this machine)"
		default:
			person, why = true, ""
		}
	}
	c.mu.Lock()
	c.person, c.notPerson = person, why
	if o.Pane && !person {
		c.agentPane = o.PaneID
	}
	c.mu.Unlock()
	if app && person {
		c.s.cancelAppDrives()
	}
}

// cancelAppDrives cancels the open drive checkpoints a connection named as
// the app asked: the person's own typing, taken for an agent's while the
// app was judged inside a pane. The app is back as the person, so none of
// them is a real question.
func (s *Server) cancelAppDrives() {
	var ids []string
	s.cps.mu.Lock()
	for id, x := range s.cps.all {
		if x.c.State == stOpen && x.c.Kind == kindDrive && x.c.Drive != nil && x.c.Drive.Agent.Client == pane.DesktopAppClient {
			ids = append(ids, id)
		}
	}
	s.cps.mu.Unlock()
	for _, id := range ids {
		if _, ok := s.closeCheckpoint(id, stOpen, stCancelled, nil, "typed by the person in the Ravenry window, which was taken for a program in a pane"); ok {
			s.o.Log.Printf("cancelled drive checkpoint %s: the Ravenry app's own typing", id)
		}
	}
}

// scope is whose panes count: this daemon's, by their first processes,
// and those of every daemon beside it in its runtime directory (a test's
// daemon in another directory is another Ravenry).
func (s *Server) scope() pane.Scope {
	sc := pane.Scope{Roots: s.o.Manager.Roots(), Member: s.o.Manager.PaneOf}
	if s.o.Socket != "" {
		sc.Dir = filepath.Dir(s.o.Socket)
	}
	return sc
}

// asPerson checks that this connection may call a person-only method, and
// answers the request with forbidden when it may not.
func (c *conn) asPerson(id uint64, method string) bool {
	c.mu.Lock()
	ok, why := c.person, c.notPerson
	c.mu.Unlock()
	if ok {
		return true
	}
	c.s.o.Log.Printf("refused %s to client %q: %s", method, c.client.Name, why)
	c.fail(&id, proto.CodeForbidden, fmt.Sprintf("only a person can do this (%s), in the Ravenry app or on the phone: %s", method, why))
	return false
}

// ------------------------------------------------------------ answer keys

// answerKeys is the answer key this machine trusts over ssh: the first
// one a connection over ssh (outside every pane) gave, kept as its SHA-256
// in <state>/answer-key. Deleting the file lets the next hub pair. With
// no file (tests), it is kept in memory.
type answerKeys struct {
	path string
	mu   sync.Mutex
	mem  string
}

func keyHash(key string) string {
	h := sha256.Sum256([]byte(key))
	return "sha256:" + base64.RawURLEncoding.EncodeToString(h[:])
}

func (k *answerKeys) where() string {
	if k.path == "" {
		return "the daemon's answer key"
	}
	return k.path
}

// allow reports whether key is the trusted one. With none trusted yet, it
// pins key.
func (k *answerKeys) allow(key string) (bool, error) {
	if key == "" {
		return false, nil
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	want := k.mem
	if k.path != "" {
		want = ""
		b, err := os.ReadFile(k.path)
		switch {
		case err == nil:
			want = strings.TrimSpace(string(b))
		case !os.IsNotExist(err):
			return false, err
		}
	}
	got := keyHash(key)
	if want == "" {
		if k.path != "" {
			tmp := k.path + ".tmp"
			if err := os.WriteFile(tmp, []byte(got+"\n"), 0o600); err != nil {
				return false, err
			}
			if err := os.Rename(tmp, k.path); err != nil {
				return false, err
			}
		}
		k.mem = got
		return true, nil
	}
	return subtle.ConstantTimeCompare([]byte(want), []byte(got)) == 1, nil
}

// AnswerKeyFile is where a daemon with this state directory keeps the
// answer key it trusts.
func AnswerKeyFile(state string) string { return filepath.Join(state, "answer-key") }
