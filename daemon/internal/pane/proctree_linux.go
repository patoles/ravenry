package pane

import (
	"bytes"
	"os"
	"strconv"
	"strings"
	"syscall"
)

func listProcs() []proc {
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	uid := uint32(os.Getuid())
	var out []proc
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		var st syscall.Stat_t
		if syscall.Stat("/proc/"+e.Name(), &st) != nil || st.Uid != uid {
			continue
		}
		f, ok := statFields(pid)
		if !ok || len(f) < 4 {
			continue
		}
		ppid, _ := strconv.Atoi(f[1])
		sid, _ := strconv.Atoi(f[3])
		out = append(out, proc{pid: pid, ppid: ppid, sid: sid})
	}
	return out
}

// statFields returns the fields of /proc/<pid>/stat after the command
// name: state, ppid, pgrp, session, ...
func statFields(pid int) ([]string, bool) {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return nil, false
	}
	i := bytes.LastIndexByte(b, ')')
	if i < 0 {
		return nil, false
	}
	return strings.Fields(string(b[i+1:])), true
}

func envHas(pid int, marker []byte) bool {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/environ")
	if err != nil {
		return false
	}
	return bytes.HasPrefix(b, marker) || bytes.Contains(b, append([]byte{0}, marker...))
}

func zombie(pid int) bool {
	f, ok := statFields(pid)
	return ok && len(f) > 0 && f[0] == "Z"
}
