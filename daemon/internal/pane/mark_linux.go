package pane

import (
	"hash/fnv"
	"os"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

// The pane's mark on Linux, for the processes that wipe their environment
// (RAVENRY_PANE with it): the soft limit of RLIMIT_RTTIME, the CPU time a
// real-time thread may use without blocking. Every process inherits it
// across fork and exec, setsid leaves it alone, /proc/<pid>/limits shows
// it to the user, and it only ever applies to real-time threads, which a
// user's programs do not get unless they ask (rtkit). The pane's first
// process starts with it (withMark): 2^61 microseconds (73,000 years)
// plus 48 bits of the pane's id, so `ulimit -R` in a pane shows that
// number instead of unlimited.

const markBase = uint64(1) << 61

func paneMark(id string) uint64 {
	h := fnv.New64a()
	h.Write([]byte(id))
	return markBase | h.Sum64()&(1<<48-1)
}

// markMu keeps one pane's start at a time inside withMark.
var markMu sync.Mutex

// withMark runs start, which forks the pane's first process, with this
// process's RLIMIT_RTTIME soft limit set to pane id's mark, then puts the
// limit back: the child carries the mark from its first instruction, so
// nothing it forks can be quicker than the mark. The limit is the
// process's, so pane starts take turns; the daemon itself runs no
// real-time thread, so the moment does not touch it. When the hard limit
// is lower than the mark, the pane goes without.
func withMark(id string, start func() error) error {
	markMu.Lock()
	defer markMu.Unlock()
	var cur unix.Rlimit
	if unix.Getrlimit(unix.RLIMIT_RTTIME, &cur) != nil {
		return start()
	}
	m := paneMark(id)
	if cur.Max != unix.RLIM_INFINITY && cur.Max < m {
		return start()
	}
	if unix.Setrlimit(unix.RLIMIT_RTTIME, &unix.Rlimit{Cur: m, Max: cur.Max}) != nil {
		return start()
	}
	defer unix.Setrlimit(unix.RLIMIT_RTTIME, &cur)
	return start()
}

// markOf reads a process's mark: its RLIMIT_RTTIME soft limit, when it is
// one of the marks.
func markOf(pid int) (uint64, bool) {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/limits")
	if err != nil {
		return 0, false
	}
	for _, l := range strings.Split(string(b), "\n") {
		if !strings.HasPrefix(l, "Max realtime timeout") {
			continue
		}
		f := strings.Fields(l)
		if len(f) < 4 {
			return 0, false
		}
		v, err := strconv.ParseUint(f[3], 10, 64)
		if err != nil || v < markBase || v >= markBase<<1 {
			return 0, false
		}
		return v, true
	}
	return 0, false
}

func hasMark(pid int, m uint64) bool {
	v, ok := markOf(pid)
	return ok && v == m
}
