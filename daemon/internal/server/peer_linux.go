package server

import "golang.org/x/sys/unix"

// socketPeerPID asks the kernel which process connected (SO_PEERCRED).
func socketPeerPID(fd int) int {
	cr, err := unix.GetsockoptUcred(fd, unix.SOL_SOCKET, unix.SO_PEERCRED)
	if err != nil {
		return 0
	}
	return int(cr.Pid)
}
