package server

import "golang.org/x/sys/unix"

// socketPeerPID asks the kernel which process connected (LOCAL_PEERPID).
func socketPeerPID(fd int) int {
	pid, err := unix.GetsockoptInt(fd, unix.SOL_LOCAL, unix.LOCAL_PEERPID)
	if err != nil {
		return 0
	}
	return pid
}
