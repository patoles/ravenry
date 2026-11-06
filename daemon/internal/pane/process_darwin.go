package pane

/*
#include <libproc.h>
#include <string.h>
#include <sys/proc_info.h>

static int ravenry_cwd(int pid, char *buf, int n) {
	struct proc_vnodepathinfo vpi;
	int r = proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &vpi, sizeof(vpi));
	if (r < (int)sizeof(vpi)) return -1;
	strlcpy(buf, vpi.pvi_cdir.vip_path, n);
	return 0;
}
*/
import "C"

import (
	"bytes"
	"encoding/binary"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// ProcessInfo reads a process: its arguments and executable from
// KERN_PROCARGS2 (as ps does), its start from its kinfo_proc and its
// working directory from proc_pidinfo.
func ProcessInfo(pid int) (*Process, error) {
	kp, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return nil, err
	}
	pr := &Process{PID: pid}
	st := kp.Proc.P_starttime
	if st.Sec > 0 {
		pr.Started = time.Unix(int64(st.Sec), int64(st.Usec)*1000)
	}
	if raw, err := unix.SysctlRaw("kern.procargs2", pid); err == nil && len(raw) > 4 {
		pr.Exe, pr.Argv = parseProcArgs(raw)
	}
	if len(pr.Argv) == 0 {
		pr.Argv = []string{unix.ByteSliceToString(kp.Proc.P_comm[:])}
	}
	buf := make([]byte, 4096)
	if C.ravenry_cwd(C.int(pid), (*C.char)(unsafe.Pointer(&buf[0])), C.int(len(buf))) == 0 {
		pr.Cwd = unix.ByteSliceToString(buf)
	}
	return pr, nil
}

// parseProcArgs reads KERN_PROCARGS2: argc, the executable's path, NUL
// padding, then argc arguments, each ending with a NUL.
func parseProcArgs(raw []byte) (exe string, argv []string) {
	argc := int(binary.LittleEndian.Uint32(raw[:4]))
	rest := raw[4:]
	i := bytes.IndexByte(rest, 0)
	if i < 0 {
		return "", nil
	}
	exe, rest = string(rest[:i]), rest[i:]
	for len(rest) > 0 && rest[0] == 0 {
		rest = rest[1:]
	}
	for len(argv) < argc && len(rest) > 0 {
		j := bytes.IndexByte(rest, 0)
		if j < 0 {
			argv = append(argv, string(rest))
			break
		}
		argv = append(argv, string(rest[:j]))
		rest = rest[j+1:]
	}
	return exe, argv
}
