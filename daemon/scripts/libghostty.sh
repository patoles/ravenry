#!/bin/sh
# Builds libghostty-vt, the C library behind go.mitchellh.com/libghostty,
# into daemon/.deps, and prints the folder that holds its pkg-config file.
#
#   scripts/libghostty.sh            build if needed, print the pkgconfig dir
#   scripts/libghostty.sh --check    exit 1 if it is not built yet
#
# One pin only: go.mod pins go-libghostty, and go-libghostty's own
# CMakeLists.txt pins the ghostty commit its bindings were written against.
# This script reads that commit from the module, so the two can never drift.
#
# Needs Zig 0.17 or newer on PATH (ghostty's minimum_zig_version), git and
# Go. The build takes about two minutes the first time.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here"

moddir=$(go list -m -f '{{.Dir}}' go.mitchellh.com/libghostty)
if [ -z "$moddir" ] || [ ! -f "$moddir/CMakeLists.txt" ]; then
  go mod download go.mitchellh.com/libghostty
  moddir=$(go list -m -f '{{.Dir}}' go.mitchellh.com/libghostty)
fi
commit=$(sed -n 's/^[[:space:]]*GIT_TAG[[:space:]]*\([0-9a-f]*\).*/\1/p' "$moddir/CMakeLists.txt")
if [ -z "$commit" ]; then
  echo "libghostty.sh: no GIT_TAG in $moddir/CMakeLists.txt" >&2
  exit 1
fi
short=$(printf %s "$commit" | cut -c1-12)
target="$(go env GOOS)-$(go env GOARCH)"
out="$here/.deps/libghostty-vt-$short-$target"

if [ -f "$out/lib/libghostty-vt.a" ] && [ -f "$out/lib/pkgconfig/libghostty-vt-static.pc" ]; then
  echo "$out/lib/pkgconfig"
  exit 0
fi
if [ "${1:-}" = "--check" ]; then
  echo "libghostty.sh: libghostty-vt $short is not built for $target; run scripts/libghostty.sh" >&2
  exit 1
fi

if ! command -v zig >/dev/null 2>&1; then
  echo "libghostty.sh: zig is not on PATH. Install Zig 0.17 or newer (https://ziglang.org/download/)." >&2
  exit 1
fi
zv=$(zig version)
case "$zv" in
  0.1[7-9].*|0.[2-9][0-9].*|[1-9].*) ;;
  *) echo "libghostty.sh: zig $zv is too old; ghostty needs 0.17 or newer" >&2; exit 1 ;;
esac

src="$here/.deps/ghostty-src"
if [ ! -d "$src/.git" ]; then
  mkdir -p "$src"
  git -C "$src" init -q
  git -C "$src" remote add origin https://github.com/ghostty-org/ghostty.git
fi
if [ "$(git -C "$src" rev-parse HEAD 2>/dev/null || true)" != "$commit" ]; then
  git -C "$src" fetch -q --depth 1 origin "$commit"
  git -C "$src" -c advice.detachedHead=false checkout -q FETCH_HEAD
fi

echo "libghostty.sh: building libghostty-vt $short for $target with zig $zv" >&2
rm -rf "$out.tmp"
# -Dcpu=baseline: for the architecture, not this machine's CPU. Zig builds
# for the native CPU by default on Linux, and a library built on one CI
# runner then died with SIGILL on another (a cached build), as a release
# binary would on a user's machine. On macOS ghostty picks a generic CPU
# itself.
(cd "$src" && zig build -Demit-lib-vt -Demit-xcframework=false -Doptimize=ReleaseFast -Dcpu=baseline --prefix "$out.tmp" >&2)
# The .pc files carry the prefix as an absolute path: point them at the
# final folder before moving it there.
for pc in "$out.tmp"/lib/pkgconfig/*.pc; do
  sed "s|^prefix=.*|prefix=$out|" "$pc" > "$pc.new" && mv "$pc.new" "$pc"
done
rm -rf "$out"
mv "$out.tmp" "$out"
echo "$out/lib/pkgconfig"
