#!/bin/sh
# The app's headless self-test on a throwaway daemon:
#
#   scripts/selftest.sh [OUT_DIR]   (SELFTEST_APP: the .app, default apps/macos/build/RavenryMac.app)
#
# A daemon of the app's own ravenryd runs with a HOME, runtime and state
# folder of its own (never the person's), its pane a zsh at a prompt
# "~ > ". The app runs with its window off every screen, no Dock icon,
# drawing into an offscreen texture, a private pasteboard of its own (the
# person's clipboard is never written) and links recorded rather than
# opened. SelfTest.swift drives the view's own event handlers with real
# events (keys, the wheel, clicks and drags, a drop) and checks what the
# daemon sent back. It writes OUT_DIR/selftest.json and pictures; the
# script prints one line a check and exits 1 when one failed.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../.." && pwd)
app=${SELFTEST_APP:-$here/build/RavenryMac.app}
bin="$app/Contents/MacOS/ravenryd"
mkdir -p "$repo/.tmp"
dir=$(mktemp -d "$repo/.tmp/macos-selftest.XXXXXX")
out=${1:-$dir}
mkdir -p "$out"
rm -f "$out/selftest.json"
mkdir -m 700 "$dir/user" "$dir/run" "$dir/state"
printf '%s\n' "PROMPT='~ > '" > "$dir/user/.zshrc"
printf '%s\n' "skip_global_compinit=1" > "$dir/user/.zshenv"
envs="HOME=$dir/user PATH=/usr/bin:/bin SHELL=/bin/zsh LANG=en_US.UTF-8 RAVENRY_RUNTIME_DIR=$dir/run RAVENRY_STATE_DIR=$dir/state"
sock="$dir/run/ravenryd-0.0.0-dev.sock"
daemon=
cleanup() {
  [ -n "$daemon" ] && kill "$daemon" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
# shellcheck disable=SC2086
env -i $envs "$bin" serve 2>"$dir/daemon.log" &
daemon=$!
i=0
while [ ! -S "$sock" ]; do
  i=$((i + 1))
  [ $i -gt 100 ] && { echo "selftest: the daemon did not start" >&2; exit 1; }
  sleep 0.05
done
# shellcheck disable=SC2086
env -i $envs "$app/Contents/MacOS/RavenryMac" --offscreen --socket "$sock" --selftest "$out/selftest.json" 2>"$dir/app.log" &
apppid=$!
i=0
while kill -0 "$apppid" 2>/dev/null; do
  i=$((i + 1))
  [ $i -gt 1800 ] && { kill "$apppid"; echo "selftest: the app did not finish in 180 s" >&2; exit 1; }
  sleep 0.1
done
[ -f "$out/selftest.json" ] || { tail -5 "$dir/app.log" >&2; echo "selftest: no result; see $dir/app.log" >&2; exit 1; }
echo "selftest: files in $out" >&2
/usr/bin/python3 -I - "$out/selftest.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
if "error" in r:
    print("selftest: error:", r["error"][:300]); sys.exit(1)
failed = 0
for c in r["checks"]:
    ok = c["ok"]
    failed += 0 if ok else 1
    detail = c.get("detail", "").replace("\n", "\\n")
    print("%s %s%s" % ("pass" if ok else "FAIL", c["name"], (": " + detail) if detail else ""))
print("selftest: %d checks, %d failed" % (len(r["checks"]), failed))
sys.exit(1 if failed else 0)
PY
