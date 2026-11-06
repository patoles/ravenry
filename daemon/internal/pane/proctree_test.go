package pane

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"slices"
	"sort"
	"syscall"
	"testing"
	"time"

	"ravenryd/internal/testprog"
)

// belongs on a made-up process table: who joins a pane, and who never
// does.
func TestBelongs(t *testing.T) {
	const root = 1000
	procs := []proc{
		{pid: root, ppid: 999, sid: root, pgid: root, start: 1},
		{pid: 1001, ppid: root, sid: root, pgid: 1001, start: 2},     // a child
		{pid: 1003, ppid: 1, sid: 1002, pgid: 1002, start: 4},        // a double fork's end: its session leader 1002 is gone
		{pid: 1004, ppid: 1, sid: 1004, pgid: 1004, start: 5},        // seen while it lived, now a child of launchd
		{pid: 1005, ppid: 1004, sid: 1004, pgid: 1004, start: 6},     // and its child
		{pid: 2000, ppid: 999, sid: 2000, pgid: 2000, start: 1},      // another pane's first process
		{pid: 2001, ppid: 1, sid: 2000, pgid: 2001, start: 2},        // in that pane's session
		{pid: 3000, ppid: 1, sid: 3000, pgid: 3000, start: 9},        // outside every pane, on a pid the pane once had
		{pid: 3001, ppid: 3000, sid: 3000, pgid: 3000, start: 10},    // and its child
		{pid: 4000, ppid: 1, sid: 4000, pgid: 4000, start: 1},        // outside every pane
		{pid: os.Getpid(), ppid: 1, sid: root, pgid: root, start: 1}, // this process, never
	}
	rec := map[int]int64{root: 1, 1002: 3, 1004: 5, 3000: 7, 2001: 2}
	got := []int{}
	for _, p := range belongs(procs, root, rec, map[int]bool{2000: true}, nil) {
		got = append(got, p.pid)
	}
	sort.Ints(got)
	if want := []int{root, 1001, 1003, 1004, 1005}; !slices.Equal(got, want) {
		t.Fatalf("belongs: %v, want %v", got, want)
	}
	// The pane's first process gone and its pid taken by another: nothing
	// of the newcomer's joins.
	procs2 := []proc{{pid: root, ppid: 1, sid: root, pgid: root, start: 50}, {pid: 1001, ppid: root, sid: root, pgid: root, start: 51}}
	if got := belongs(procs2, root, map[int]int64{root: 1}, nil, nil); len(got) != 0 {
		t.Fatalf("a reused first pid joined: %v", got)
	}
	// A mark (the environment, the Linux limit) brings one in, and its
	// children with it.
	extra := func(p proc) bool { return p.pid == 4000 }
	procs3 := append(slices.Clone(procs), proc{pid: 4001, ppid: 4000, sid: 4000, pgid: 4000, start: 2})
	got = got[:0]
	for _, p := range belongs(procs3, root, rec, map[int]bool{2000: true}, extra) {
		got = append(got, p.pid)
	}
	if !slices.Contains(got, 4000) || !slices.Contains(got, 4001) {
		t.Fatalf("marked: %v", got)
	}
	// What seen keeps: a gone pid only while it leads a session or group.
	s := newSeen()
	s.update([]proc{{pid: 1002, start: 3}, {pid: 1006, start: 8}, {pid: 3000, start: 7}}, procs)
	have := s.copy()
	if _, ok := have[1002]; !ok {
		t.Error("forgot a gone session leader whose session lives on")
	}
	if _, ok := have[1006]; ok {
		t.Error("kept a gone pid that leads nothing")
	}
	if _, ok := have[3000]; ok {
		t.Error("kept a pid that now names another process")
	}
}

// A helper that detaches itself as a daemon does (a double fork: a new
// session, its parent gone, its environment wiped, its output closed) is
// ended when its pane closes, on macOS 26 too, where /bin/sleep's
// environment cannot be read at all. A helper detached the same way from
// another pane, and a process outside every pane, are left alone.
func TestCloseEndsDetachedHelpers(t *testing.T) {
	m := newManager(t)
	argv, env := testprog.Command("detach")
	start := func() (*Pane, int, int) {
		p := newPane(t, m, Config{Command: argv, Env: env})
		r := waitText(t, p, `detached (\d+) (\d+)`, 0)
		var helper, mid int
		fmt.Sscan(r.Groups[0], &helper)
		fmt.Sscan(r.Groups[1], &mid)
		return p, helper, mid
	}
	p1, h1, mid1 := start()
	p2, h2, _ := start()
	outside := exec.Command("/bin/sleep", "600")
	outside.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := outside.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { outside.Process.Kill(); outside.Wait() }()
	for _, pid := range []int{h1, h2} {
		defer syscall.Kill(pid, syscall.SIGKILL)
	}

	// The helper really is detached, with nothing that names the pane.
	deadline := time.Now().Add(5 * time.Second)
	for alive(mid1) && !zombie(mid1) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	pr, ok := procOf(h1)
	if !ok {
		t.Fatalf("helper %d is not running", h1)
	}
	if pr.ppid == p1.pid || pr.sid == p1.pid || pr.sid != mid1 || envHas(h1, []byte("RAVENRY_PANE="+p1.ID()+"\x00")) {
		t.Fatalf("helper %+v is not detached (pane's first process %d, middle %d)", pr, p1.pid, mid1)
	}
	how := "the fork watch saw its middle process"
	if runtime.GOOS == "linux" {
		if !hasMark(h1, paneMark(p1.ID())) {
			t.Fatalf("helper %d does not carry pane %s's mark", h1, p1.ID())
		}
		how = "it carries the pane's mark"
	} else if _, ok := p1.seen.copy()[mid1]; !ok {
		t.Fatalf("pane %s did not see the middle process %d: %v", p1.ID(), mid1, p1.seen.copy())
	}
	if id, ok := m.PaneOf(h1); !ok || id != p1.ID() {
		t.Fatalf("PaneOf(helper) = %q, %v; want %s", id, ok, p1.ID())
	}
	if id, ok := m.PaneOf(outside.Process.Pid); ok {
		t.Fatalf("PaneOf(a process outside every pane) = %q", id)
	}

	if _, _, err := m.Close(p1.ID(), 600*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if alive(h1) && !zombie(h1) {
		t.Fatalf("the detached helper %d survived the close of its pane", h1)
	}
	if !alive(h2) {
		t.Fatalf("the close of pane %s ended another pane's helper %d", p1.ID(), h2)
	}
	if !alive(outside.Process.Pid) {
		t.Fatalf("the close of pane %s ended a process outside every pane", p1.ID())
	}
	t.Logf("closing the pane ended its detached helper (%s); another pane's and an outside process were left alone", how)
	if _, _, err := m.Close(p2.ID(), 600*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if alive(h2) && !zombie(h2) {
		t.Fatalf("the other pane's helper %d survived its own close", h2)
	}
}
