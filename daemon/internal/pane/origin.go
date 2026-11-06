package pane

import (
	"fmt"
	"path/filepath"
	"strings"

	"ravenryd/internal/paths"
)

// Origin says where a process comes from: from inside a pane, from an ssh
// session, or neither. The daemon asks it about the process at the other
// end of each connection, and `ravenryd peer` about the process behind a
// local TCP connection (the hub, for its HTTP API), to decide whether that
// process may act as the person: answer a checkpoint, decide for a hook
// (PROTOCOL.md section 4, Who acts as the person).
type Origin struct {
	PID int
	// Known is false when the process could not be read (it is gone, or
	// it is not this user's): nothing can be said about it.
	Known bool
	// Pane: the process runs inside a pane of the daemons of the scope's
	// runtime directory, as closing a pane finds them: it or one of its
	// ancestors (by parent; and the leader of its session, with that
	// leader's ancestors) is a pane's first process, is the child of one
	// of those daemons, belongs to a pane by what the daemon saw while
	// the pane lived (Scope.Member), carries a pane's mark (Linux), or
	// started with RAVENRY_SOCKET naming one of them (or RAVENRY_PANE
	// without RAVENRY_SOCKET) in its environment.
	Pane bool
	// PaneID is the pane, when it is known.
	PaneID string
	// SSH: it runs in an ssh session (SSH_CONNECTION, SSH_CLIENT or
	// SSH_TTY in its or an ancestor's environment, or an sshd ancestor).
	SSH bool
	// Name is the process's own name, for messages.
	Name string
}

// Scope is whose panes count: the daemons of one runtime directory, the
// daemons that share this machine's panes (PROTOCOL.md section 9). A
// daemon in another runtime directory is another Ravenry (a test's), and
// its panes are not these.
type Scope struct {
	// Dir is the runtime directory. Empty: every daemon's panes count.
	Dir string
	// Roots maps the first process of each running pane known to the
	// asker to its pane id (Manager.Roots), or is nil.
	Roots map[int]string
	// Member, when set, says which pane a process belongs to by what the
	// daemon saw while the pane lived (Manager.PaneOf, proctree.go): a
	// process that left its parents and whose environment the system
	// hides (macOS 26, for Apple's own programs) or that wiped it.
	Member func(pid int) (string, bool)
}

// Person reports whether the process may act as the person on its own:
// it was read, and it is neither inside a pane nor in an ssh session.
func (o Origin) Person() bool { return o.Known && !o.Pane && !o.SSH }

// Why says, for people, why the process is not the person; empty when it
// is.
func (o Origin) Why() string {
	who := fmt.Sprintf("process %d", o.PID)
	if o.Name != "" {
		who = fmt.Sprintf("process %d (%s)", o.PID, o.Name)
	}
	switch {
	case !o.Known:
		return who + " could not be read"
	case o.Pane && o.PaneID != "":
		return who + " runs inside pane " + o.PaneID
	case o.Pane:
		return who + " runs inside a pane"
	case o.SSH:
		return who + " runs in an ssh session"
	}
	return ""
}

// OriginOf reads where process pid comes from.
func OriginOf(pid int, sc Scope) Origin {
	o := Origin{PID: pid}
	if pid <= 1 {
		return o
	}
	peerArgs, _, ok := procArgsEnv(pid)
	if !ok {
		return o
	}
	o.Known = true
	if len(peerArgs) > 0 {
		o.Name = filepath.Base(peerArgs[0])
	}
	pane := func(id string) {
		o.Pane = true
		if o.PaneID == "" {
			o.PaneID = id
		}
	}
	starts := []int{pid}
	if sid := sessionOf(pid); sid > 1 && sid != pid {
		starts = append(starts, sid)
	}
	seen := map[int]bool{}
	for _, start := range starts {
		for q, depth := start, 0; q > 1 && !seen[q] && depth < 512; depth++ {
			seen[q] = true
			if id, ok := sc.Roots[q]; ok {
				pane(id)
			}
			if sc.Member != nil {
				if id, ok := sc.Member(q); ok {
					pane(id)
				}
			}
			// The pane's mark (Linux, mark_linux.go), for the panes the
			// scope knows.
			if m, ok := markOf(q); ok {
				for _, id := range sc.Roots {
					if paneMark(id) == m {
						pane(id)
					}
				}
			}
			// Its short name, which the system tells for every process
			// (an sshd that runs as root included).
			if strings.HasPrefix(commOf(q), "sshd") {
				o.SSH = true
			}
			if args, env, ok := procArgsEnv(q); ok {
				if q != pid && isDaemon(args) && sc.has(daemonDir(args, env)) {
					pane("")
				}
				get := envGetter(env)
				if s := get("RAVENRY_SOCKET"); s != "" {
					if sc.has(filepath.Dir(s)) {
						pane(get("RAVENRY_PANE"))
					}
				} else if id := get("RAVENRY_PANE"); id != "" {
					pane(id)
				}
				if get("SSH_CONNECTION") != "" || get("SSH_CLIENT") != "" || get("SSH_TTY") != "" {
					o.SSH = true
				}
			}
			q = parentOf(q)
		}
	}
	return o
}

// has reports whether dir is the scope's runtime directory. An unknown
// dir ("") counts: what cannot be placed is taken to be inside.
func (sc Scope) has(dir string) bool {
	if sc.Dir == "" || dir == "" {
		return true
	}
	if filepath.Clean(dir) == filepath.Clean(sc.Dir) {
		return true
	}
	a, err1 := filepath.EvalSymlinks(dir)
	b, err2 := filepath.EvalSymlinks(sc.Dir)
	return err1 == nil && err2 == nil && a == b
}

func envGetter(env []string) func(string) string {
	m := make(map[string]string, len(env))
	for _, kv := range env {
		if k, v, ok := strings.Cut(kv, "="); ok {
			if _, dup := m[k]; !dup {
				m[k] = v
			}
		}
	}
	return func(k string) string { return m[k] }
}

// isDaemon reports whether argv is a ravenryd daemon's (`ravenryd serve`,
// whatever the binary is called: ravenryd, ravenryd-<version>, ravenry).
func isDaemon(argv []string) bool {
	return len(argv) > 1 && strings.HasPrefix(filepath.Base(argv[0]), "ravenry") && argv[1] == "serve"
}

// daemonDir is the runtime directory of a daemon with these arguments and
// environment: that of its --socket, else what its environment says. ""
// when its environment could not be read.
func daemonDir(argv, env []string) string {
	for i, a := range argv {
		if v, ok := strings.CutPrefix(a, "--socket="); ok {
			return filepath.Dir(v)
		}
		if a == "--socket" && i+1 < len(argv) {
			return filepath.Dir(argv[i+1])
		}
	}
	if len(env) == 0 {
		return ""
	}
	d, err := paths.RuntimeDirFor(envGetter(env))
	if err != nil {
		return ""
	}
	return d
}

// TCPOwners returns this user's processes that hold the TCP connection
// from local port local to remote port remote: the client of a connection
// a server on this machine accepted on port remote, coming from port
// local.
func TCPOwners(local, remote int) ([]int, error) { return tcpOwners(local, remote) }
