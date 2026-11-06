package pane

import (
	"bytes"
	"os"

	"golang.org/x/sys/unix"
)

func listProcs() []proc {
	kps, err := unix.SysctlKinfoProcSlice("kern.proc.uid", os.Getuid())
	if err != nil {
		return nil
	}
	out := make([]proc, 0, len(kps))
	for i := range kps {
		pid := int(kps[i].Proc.P_pid)
		sid, err := unix.Getsid(pid)
		if err != nil {
			sid = -1
		}
		st := kps[i].Proc.P_starttime
		out = append(out, proc{pid: pid, ppid: int(kps[i].Eproc.Ppid), sid: sid, pgid: int(kps[i].Eproc.Pgid), start: int64(st.Sec)*1e6 + int64(st.Usec)})
	}
	return out
}

// envHas reads a process's arguments and environment (KERN_PROCARGS2, as
// ps does) and looks for marker, which ends with a NUL.
func envHas(pid int, marker []byte) bool {
	raw, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil {
		return false
	}
	return bytes.Contains(raw, append([]byte{0}, marker...))
}

// procOf reads one process as listProcs does.
func procOf(pid int) (proc, bool) {
	kp, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || int(kp.Proc.P_pid) != pid {
		return proc{}, false
	}
	sid, err := unix.Getsid(pid)
	if err != nil {
		sid = -1
	}
	st := kp.Proc.P_starttime
	return proc{pid: pid, ppid: int(kp.Eproc.Ppid), sid: sid, pgid: int(kp.Eproc.Pgid), start: int64(st.Sec)*1e6 + int64(st.Usec)}, true
}

// macOS has no mark that survives a wiped environment: the fork watch
// (track_darwin.go) stands in for it.
func paneMark(string) uint64                      { return 0 }
func hasMark(int, uint64) bool                    { return false }
func withMark(_ string, start func() error) error { return start() }
func markOf(int) (uint64, bool)                   { return 0, false }

func zombie(pid int) bool {
	kp, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return false
	}
	return kp.Proc.P_stat == 5 // SZOMB
}
