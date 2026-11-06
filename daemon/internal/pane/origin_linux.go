package pane

import (
	"bytes"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// procArgsEnv reads a process's arguments and environment as it was
// started (/proc/<pid>/cmdline and environ). The environment of a process
// that is not dumpable cannot be read; its arguments still can.
func procArgsEnv(pid int) (argv, env []string, ok bool) {
	dir := "/proc/" + strconv.Itoa(pid)
	b, err := os.ReadFile(dir + "/cmdline")
	if err != nil {
		return nil, nil, false
	}
	if b = bytes.TrimRight(b, "\x00"); len(b) > 0 {
		argv = strings.Split(string(b), "\x00")
	}
	if e, err := os.ReadFile(dir + "/environ"); err == nil {
		if e = bytes.TrimRight(e, "\x00"); len(e) > 0 {
			env = strings.Split(string(e), "\x00")
		}
	}
	return argv, env, true
}

func commOf(pid int) string {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/comm")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func parentOf(pid int) int {
	f, ok := statFields(pid)
	if !ok || len(f) < 2 {
		return 0
	}
	ppid, _ := strconv.Atoi(f[1])
	return ppid
}

func sessionOf(pid int) int {
	f, ok := statFields(pid)
	if !ok || len(f) < 4 {
		return 0
	}
	sid, _ := strconv.Atoi(f[3])
	return sid
}

// tcpOwners finds the connection's socket in /proc/net/tcp and tcp6 (this
// network namespace), then the processes of this user holding it.
func tcpOwners(local, remote int) ([]int, error) {
	inodes := map[string]bool{}
	read := 0
	for _, f := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		read++
		for _, line := range strings.Split(string(b), "\n")[1:] {
			fs := strings.Fields(line)
			if len(fs) < 10 || fs[3] != "01" { // ESTABLISHED
				continue
			}
			if hexPort(fs[1]) == local && hexPort(fs[2]) == remote && fs[9] != "0" {
				inodes["socket:["+fs[9]+"]"] = true
			}
		}
	}
	if read == 0 {
		return nil, os.ErrNotExist
	}
	if len(inodes) == 0 {
		return nil, nil
	}
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	uid := uint32(os.Getuid())
	var out []int
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		var st syscall.Stat_t
		if syscall.Stat("/proc/"+e.Name(), &st) != nil || st.Uid != uid {
			continue
		}
		fds, err := os.ReadDir("/proc/" + e.Name() + "/fd")
		if err != nil {
			continue
		}
		for _, fd := range fds {
			if l, err := os.Readlink("/proc/" + e.Name() + "/fd/" + fd.Name()); err == nil && inodes[l] {
				out = append(out, pid)
				break
			}
		}
	}
	return out, nil
}

// hexPort reads the port of an address in /proc/net/tcp ("0100007F:1F90").
func hexPort(addr string) int {
	i := strings.LastIndexByte(addr, ':')
	if i < 0 {
		return -1
	}
	n, err := strconv.ParseUint(addr[i+1:], 16, 16)
	if err != nil {
		return -1
	}
	return int(n)
}
