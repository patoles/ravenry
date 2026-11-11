package server

import (
	"fmt"
	"os"

	"ravenryd/internal/testenv"
	"ravenryd/internal/vt"
)

// These tests run on this tree's libghostty-vt, with daemon/patches, or
// not at all: a plain `go test` may link an older build from Go's cache
// and fail tests the patches fix (testenv.LibraryProblem).
func init() {
	if p := testenv.LibraryProblem(vt.LibraryBuild(), testenv.DaemonDir()); p != "" {
		fmt.Fprintln(os.Stderr, "FAIL:", p)
		os.Exit(1)
	}
}
