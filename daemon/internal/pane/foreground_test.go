package pane

import (
	"os/exec"
	"syscall"
	"testing"
	"time"
)

// The process in front can end between finding it and reading it (a
// command that finishes, Ctrl+C): Foreground asks again and answers the
// shell, where pane.process failed with "open /proc/<pid>/cmdline: no
// such file or directory" (TestProcessBusy on Linux, 2026-11-16). Here the
// command in front is killed, and reaped, right in that gap.
func TestForegroundEndsWhileRead(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("no bash")
	}
	m := newManager(t)
	p := newPane(t, m, Config{Command: []string{bash, "--norc", "--noprofile", "-i"}, Env: map[string]string{"PS1": "ready$ "}})
	waitText(t, p, `ready\$ `, 0)
	if err := p.Input([]byte("sleep 30\r")); err != nil {
		t.Fatal(err)
	}
	sleeper := 0
	for deadline := time.Now().Add(10 * time.Second); sleeper == 0; time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("sleep never came to the front")
		}
		if pr, err := p.Foreground(); err == nil && pr.PID != p.pid {
			sleeper = pr.PID
		}
	}
	beforeProcessInfo = func(pid int) {
		if pid != sleeper {
			return
		}
		syscall.Kill(pid, syscall.SIGKILL)
		for i := 0; i < 300 && alive(pid); i++ {
			time.Sleep(10 * time.Millisecond)
		}
	}
	t.Cleanup(func() { beforeProcessInfo = nil })
	pr, err := p.Foreground()
	if err != nil {
		t.Fatalf("the command in front ended while it was read: %v", err)
	}
	if pr.PID != p.pid {
		t.Fatalf("in front after it ended: %d %v, want the shell %d", pr.PID, pr.Argv, p.pid)
	}
}
