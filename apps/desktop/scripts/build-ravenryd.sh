#!/bin/sh
# Builds ravenryd for this machine the way the app ships it, into OUT:
#
#   scripts/build-ravenryd.sh OUT [VERSION]
#
# VERSION defaults to the app's (package.json): the app starts its own
# ravenryd beside an older running one, by version (PROTOCOL.md section 9).
# libghostty-vt is built for the baseline CPU by daemon/scripts/libghostty.sh
# (Zig 0.17 or newer). On Linux the binary is fully static (glibc's static
# libraries, the pure Go resolver and user lookup), so it runs on any
# distribution; on macOS it links only the system's libraries and runs on
# macOS 13 or newer: Zig builds libghostty-vt for macOS 13 at the
# least, so the app asks for 13 too (Electron 45 alone would run on 12).
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
daemon=${RAVENRY_DAEMON_SRC:-$(cd "$here/../../daemon" && pwd)}
out=$1
version=${2:-$(node -p "require('$here/package.json').version")}
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
mkdir -p "$(dirname "$out")"

PKG_CONFIG_PATH=$("$daemon/scripts/libghostty.sh")
export PKG_CONFIG_PATH
# The libghostty-vt build (its folder, named after its patches) in a flag
# Go's build cache sees: it does not see a rebuilt library otherwise.
CGO_CPPFLAGS="${CGO_CPPFLAGS:-} -DRAVENRY_LIBGHOSTTY=$(basename "$(dirname "$(dirname "$PKG_CONFIG_PATH")")")"
export CGO_CPPFLAGS
cd "$daemon"
ldflags="-s -w -X main.version=$version"
tags=
case "$(go env GOOS)" in
  linux)
    tags=netgo,osusergo
    ldflags="$ldflags -linkmode external -extldflags -static"
    ;;
  darwin)
    export MACOSX_DEPLOYMENT_TARGET=13.0
    export CGO_CFLAGS="${CGO_CFLAGS:-} -mmacosx-version-min=13.0"
    export CGO_LDFLAGS="${CGO_LDFLAGS:-} -mmacosx-version-min=13.0"
    ;;
esac
CGO_ENABLED=1 go build -trimpath ${tags:+-tags "$tags"} -ldflags "$ldflags" -o "$out" ./cmd/ravenryd
# Its version, with throwaway folders: a ravenryd started here never uses
# the real user's (tools/test-env.mjs keeps the same rule for every tool).
chk=$(mktemp -d "${TMPDIR:-/tmp}/ravenryd-version.XXXXXX")
env -i PATH=/usr/bin:/bin HOME="$chk" RAVENRY_RUNTIME_DIR="$chk/run" RAVENRY_STATE_DIR="$chk/state" "$out" version
rm -rf "$chk"
