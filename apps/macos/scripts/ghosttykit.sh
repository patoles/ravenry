#!/bin/sh
# Builds GhosttyKit.xcframework, Ghostty's embedding library for macOS, into
# apps/macos/vendor/, and prints the path of the xcframework.
#
#   scripts/ghosttykit.sh            build if needed, print the xcframework path
#   scripts/ghosttykit.sh --check    exit 1 if it is not built yet
#
# One Ghostty pin for the whole repository. ravenryd links libghostty-vt
# from the commit that go-libghostty pins (daemon/go.mod, read the same way
# as daemon/scripts/libghostty.sh), and the Mac app draws with GhosttyKit
# from that same commit, so the daemon's screen state and the window that
# draws it never come from two different Ghosttys. Updating go-libghostty
# in daemon/go.mod moves both.
#
# Needs Zig (ghostty's minimum_zig_version, 0.17 at this pin), Xcode, git
# and Go. Ghostty is MIT licensed (vendor/ghostty/LICENSE); nothing of it
# is committed here.
#
# The Metal Toolchain: Ghostty compiles its shaders at build time with
# `xcrun metal`, which is an Xcode component downloaded on its own
# (`xcodebuild -downloadComponent MetalToolchain`). When it is missing, this
# script applies patches/ghostty-runtime-metal.patch, which embeds the
# shader source instead and compiles it when a surface starts (the Metal
# framework's own compiler, a few tens of milliseconds). With the toolchain
# installed, the build is Ghostty's own, otherwise.
#
# Always applied: patches/ghostty-hold-prompt-redraw.patch. When a resize
# clears the shell's prompt for the shell to redraw, Ghostty holds its
# frames in synchronized output until the redraw ends it (or its 1 s reset
# timer does): through the daemon the redraw comes milliseconds after the
# clear, not microseconds. And the clear starts at the prompt's first row,
# not at the cursor's line of a multi-line command line (apps/macos/README.md,
# Resize).
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../.." && pwd)
vendor="$here/vendor"

moddir=$(cd "$repo/daemon" && go list -m -f '{{.Dir}}' go.mitchellh.com/libghostty)
if [ -z "$moddir" ] || [ ! -f "$moddir/CMakeLists.txt" ]; then
  (cd "$repo/daemon" && go mod download go.mitchellh.com/libghostty)
  moddir=$(cd "$repo/daemon" && go list -m -f '{{.Dir}}' go.mitchellh.com/libghostty)
fi
commit=$(sed -n 's/^[[:space:]]*GIT_TAG[[:space:]]*\([0-9a-f]*\).*/\1/p' "$moddir/CMakeLists.txt")
if [ -z "$commit" ]; then
  echo "ghosttykit.sh: no GIT_TAG in $moddir/CMakeLists.txt" >&2
  exit 1
fi
short=$(printf %s "$commit" | cut -c1-12)

metal=yes
xcrun -sdk macosx metal --version >/dev/null 2>&1 || metal=no
flavour=$short-nosentry-holdprompt
[ "$metal" = no ] && flavour="$flavour-runtime-metal"
out="$vendor/GhosttyKit-$flavour.xcframework"

if [ -d "$out" ]; then
  echo "$out"
  exit 0
fi
if [ "${1:-}" = "--check" ]; then
  echo "ghosttykit.sh: GhosttyKit $flavour is not built; run apps/macos/scripts/ghosttykit.sh" >&2
  exit 1
fi

if ! command -v zig >/dev/null 2>&1; then
  echo "ghosttykit.sh: zig is not on PATH. Install Zig 0.17 or newer (https://ziglang.org/download/)." >&2
  exit 1
fi

src="$vendor/ghostty"
if [ ! -d "$src/.git" ]; then
  mkdir -p "$src"
  git -C "$src" init -q
  git -C "$src" remote add origin https://github.com/ghostty-org/ghostty.git
fi
if [ "$(git -C "$src" rev-parse HEAD 2>/dev/null || true)" != "$commit" ]; then
  git -C "$src" fetch -q --depth 1 origin "$commit"
  git -C "$src" -c advice.detachedHead=false checkout -q -f FETCH_HEAD
fi
# Start from the pinned tree every time, then patch it.
git -C "$src" checkout -q -- .
git -C "$src" apply "$here/patches/ghostty-hold-prompt-redraw.patch"
if [ "$metal" = no ]; then
  echo "ghosttykit.sh: no Metal Toolchain; compiling shaders at run time (patches/ghostty-runtime-metal.patch)" >&2
  git -C "$src" apply "$here/patches/ghostty-runtime-metal.patch"
fi

need=$(sed -n 's/.*minimum_zig_version = "\(.*\)".*/\1/p' "$src/build.zig.zon")
echo "ghosttykit.sh: building GhosttyKit $flavour with zig $(zig version) (ghostty wants $need or newer)" >&2
rm -rf "$src/macos/GhosttyKit.xcframework"
# native: this Mac's architecture only, which is all a local build needs.
# The release build of the app will want -Dxcframework-target=universal.
# -Dsentry=false: Ghostty's crash reporter keeps its files in Ghostty's own
# cache folder (~/Library/Caches/com.mitchellh.ghostty, shared with Ghostty
# and every app that embeds it) or ~/.cache/ghostty; Ravenry's window
# writes none of them. macOS's own crash reports still come.
(cd "$src" && zig build -Demit-xcframework=true -Demit-macos-app=false \
  -Dxcframework-target=native -Doptimize=ReleaseFast -Dsentry=false >&2)
rm -rf "$out.tmp"
cp -R "$src/macos/GhosttyKit.xcframework" "$out.tmp"
mv "$out.tmp" "$out"
echo "$out"
