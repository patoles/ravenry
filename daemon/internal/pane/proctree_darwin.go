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
		out = append(out, proc{pid: pid, ppid: int(kps[i].Eproc.Ppid), sid: sid, pgid: int(kps[i].Eproc.Pgid)})
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

func zombie(pid int) bool {
	kp, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return false
	}
	return kp.Proc.P_stat == 5 // SZOMB
}
