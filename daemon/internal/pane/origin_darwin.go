package pane

/*
#include <arpa/inet.h>
#include <libproc.h>
#include <stdlib.h>
#include <sys/proc_info.h>
#include <unistd.h>

// ravenry_tcp_owners writes to out the pids of this user's processes that
// hold a TCP socket from local port lport to remote port fport (host byte
// order), and returns how many, or -1.
static int ravenry_tcp_owners(int lport, int fport, int *out, int max) {
	int n = proc_listpids(PROC_UID_ONLY, getuid(), NULL, 0);
	if (n <= 0) return -1;
	int cap = n / (int)sizeof(int) + 256;
	int *pids = calloc(cap, sizeof(int));
	if (!pids) return -1;
	n = proc_listpids(PROC_UID_ONLY, getuid(), pids, cap * (int)sizeof(int));
	if (n <= 0) { free(pids); return -1; }
	n /= (int)sizeof(int);
	int found = 0;
	for (int i = 0; i < n && found < max; i++) {
		int pid = pids[i];
		if (pid <= 0) continue;
		int sz = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
		if (sz <= 0) continue;
		sz += 64 * (int)sizeof(struct proc_fdinfo);
		struct proc_fdinfo *fds = malloc(sz);
		if (!fds) continue;
		sz = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, sz);
		int nf = sz > 0 ? sz / (int)sizeof(struct proc_fdinfo) : 0;
		for (int j = 0; j < nf; j++) {
			if (fds[j].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
			struct socket_fdinfo si;
			if (proc_pidfdinfo(pid, fds[j].proc_fd, PROC_PIDFDSOCKETINFO, &si, sizeof(si)) < (int)sizeof(si)) continue;
			if (si.psi.soi_kind != SOCKINFO_TCP) continue;
			struct in_sockinfo *in = &si.psi.soi_proto.pri_tcp.tcpsi_ini;
			if (ntohs((unsigned short)in->insi_lport) == lport && ntohs((unsigned short)in->insi_fport) == fport) {
				out[found++] = pid;
				break;
			}
		}
		free(fds);
	}
	free(pids);
	return found;
}
*/
import "C"

import (
	"bytes"
	"encoding/binary"
	"errors"
	"unsafe"

	"golang.org/x/sys/unix"
)

// procArgsEnv reads a process's arguments and environment as it was
// started (KERN_PROCARGS2).
func procArgsEnv(pid int) (argv, env []string, ok bool) {
	raw, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil || len(raw) < 4 {
		return nil, nil, false
	}
	argc := int(binary.LittleEndian.Uint32(raw[:4]))
	rest := raw[4:]
	i := bytes.IndexByte(rest, 0)
	if i < 0 {
		return nil, nil, true
	}
	rest = rest[i:]
	for len(rest) > 0 && rest[0] == 0 {
		rest = rest[1:]
	}
	for len(rest) > 0 {
		j := bytes.IndexByte(rest, 0)
		if j < 0 {
			j = len(rest)
		}
		s := string(rest[:j])
		if len(argv) < argc {
			argv = append(argv, s)
		} else {
			if s == "" {
				break
			}
			env = append(env, s)
		}
		if j == len(rest) {
			break
		}
		rest = rest[j+1:]
	}
	return argv, env, true
}

func parentOf(pid int) int {
	kp, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || int(kp.Proc.P_pid) != pid {
		return 0
	}
	return int(kp.Eproc.Ppid)
}

func commOf(pid int) string {
	kp, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || int(kp.Proc.P_pid) != pid {
		return ""
	}
	return unix.ByteSliceToString(kp.Proc.P_comm[:])
}

func sessionOf(pid int) int {
	sid, err := unix.Getsid(pid)
	if err != nil {
		return 0
	}
	return sid
}

func tcpOwners(local, remote int) ([]int, error) {
	out := make([]C.int, 64)
	n := C.ravenry_tcp_owners(C.int(local), C.int(remote), (*C.int)(unsafe.Pointer(&out[0])), C.int(len(out)))
	if n < 0 {
		return nil, errors.New("could not list this user's processes")
	}
	pids := make([]int, 0, int(n))
	for _, p := range out[:n] {
		pids = append(pids, int(p))
	}
	return pids, nil
}
