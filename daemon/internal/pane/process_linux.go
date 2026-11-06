package pane

import (
	"bytes"
	"os"
	"strconv"
	"strings"
	"time"
)

// ProcessInfo reads a process from /proc.
func ProcessInfo(pid int) (*Process, error) {
	dir := "/proc/" + strconv.Itoa(pid)
	b, err := os.ReadFile(dir + "/cmdline")
	if err != nil {
		return nil, err
	}
	pr := &Process{PID: pid}
	b = bytes.TrimRight(b, "\x00")
	if len(b) > 0 {
		pr.Argv = strings.Split(string(b), "\x00")
	}
	if len(pr.Argv) == 0 {
		if c, err := os.ReadFile(dir + "/comm"); err == nil {
			pr.Argv = []string{strings.TrimSpace(string(c))}
		}
	}
	pr.Exe, _ = os.Readlink(dir + "/exe")
	pr.Cwd, _ = os.Readlink(dir + "/cwd")
	if f, ok := statFields(pid); ok && len(f) > 19 {
		if ticks, err := strconv.ParseInt(f[19], 10, 64); err == nil {
			if boot := bootTime(); !boot.IsZero() {
				// /proc counts in USER_HZ, which is 100 on Linux.
				pr.Started = boot.Add(time.Duration(ticks) * 10 * time.Millisecond)
			}
		}
	}
	return pr, nil
}

func bootTime() time.Time {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return time.Time{}
	}
	for _, l := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(l, "btime "); ok {
			if n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
				return time.Unix(n, 0)
			}
		}
	}
	return time.Time{}
}
