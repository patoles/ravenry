package vt

// The libghostty-vt build this package was compiled against, as
// scripts/libghostty.sh names it (its folder in .deps, carrying the hash
// of daemon/patches): the Makefile, build.sh and CI pass it in
// CGO_CPPFLAGS as RAVENRY_LIBGHOSTTY, so Go's build cache sees a rebuilt
// library. A plain `go test` without those flags gets whatever library
// the cache compiled last, which may predate the patches: on 2026-11-11
// TestZshMoreMark and TestRenderDragZsh failed that way ("made short: not
// the command line once") on a tree where `make test` passes them.

/*
#ifndef RAVENRY_LIBGHOSTTY
#define RAVENRY_LIBGHOSTTY
#endif
#define RV_STR2(x) #x
#define RV_STR(x) RV_STR2(x)
static const char *rv_libghostty_build(void) { return RV_STR(RAVENRY_LIBGHOSTTY); }
*/
import "C"

// LibraryBuild is the libghostty-vt build's folder name this package was
// compiled with (RAVENRY_LIBGHOSTTY), or "" when none was given.
func LibraryBuild() string { return C.GoString(C.rv_libghostty_build()) }
