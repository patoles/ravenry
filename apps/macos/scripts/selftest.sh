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
# A package's test twin, never the release (scripts/testapp.mjs, Gate.swift).
app=$(node "$here/scripts/testapp.mjs" "${SELFTEST_APP:-$here/build/RavenryMac.app}")
exe="$app/Contents/MacOS/RavenryMac"
[ -x "$exe" ] || exe="$app/Contents/MacOS/Ravenry"
bin="$app/Contents/MacOS/ravenryd"
mkdir -p "$repo/.tmp"
dir=$(mktemp -d "$repo/.tmp/macos-selftest.XXXXXX")
out=${1:-$dir}
mkdir -p "$out"
rm -f "$out/selftest.json"
mkdir -m 700 "$dir/user" "$dir/run" "$dir/state"
printf '%s\n' "PROMPT='~ > '" > "$dir/user/.zshrc"
printf '%s\n' "skip_global_compinit=1" > "$dir/user/.zshenv"
# Each assistant this PATH would find as the person's own (Claude Code,
# Codex, Antigravity CLI, OpenCode) is a stand-in first on it, as for every
# test (tools/test-env.mjs, the assistants).
testpath=$(node "$repo/tools/test-env.mjs" path /usr/bin:/bin "$dir/user")
envs="HOME=$dir/user PATH=$testpath SHELL=/bin/zsh LANG=en_US.UTF-8 RAVENRY_RUNTIME_DIR=$dir/run RAVENRY_STATE_DIR=$dir/state RAVENRY_DESKTOP_DATA=$dir/desktop"
# The app's event log goes to the test's folder, never the person's Library.
appenv="RAVENRY_MAC_EVENTS_LOG=$dir/events.log"
# Named after its version: 0.0.0-dev from build.sh, the release's in a package.
sock=
daemon=
cleanup() {
  [ -n "$daemon" ] && kill "$daemon" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
# shellcheck disable=SC2086
env -i $envs "$bin" serve 2>"$dir/daemon.log" &
daemon=$!
i=0
while sock=$(ls "$dir"/run/ravenryd-*.sock 2>/dev/null | head -1); [ ! -S "$sock" ]; do
  i=$((i + 1))
  [ $i -gt 100 ] && { echo "selftest: the daemon did not start" >&2; exit 1; }
  sleep 0.05
done
# shellcheck disable=SC2086
env -i $envs $appenv "$exe" --offscreen --socket "$sock" --selftest "$out/selftest.json" 2>"$dir/app.log" &
apppid=$!
i=0
while kill -0 "$apppid" 2>/dev/null; do
  i=$((i + 1))
  [ $i -gt 1800 ] && { kill "$apppid"; echo "selftest: the app did not finish in 180 s" >&2; exit 1; }
  sleep 0.1
done
[ -f "$out/selftest.json" ] || { tail -5 "$dir/app.log" >&2; echo "selftest: no result; see $dir/app.log" >&2; exit 1; }
# The relaunch: the same daemon, the app again; the tabs, splits and
# tab in front the first run left must come back (window.json in the
# throwaway RAVENRY_DESKTOP_DATA, the panes from the daemon).
# shellcheck disable=SC2086
env -i $envs $appenv "$exe" --offscreen --socket "$sock" --selftest "$out/restore.json" \
  --restore-check "$out/selftest.json" 2>>"$dir/app.log" &
apppid=$!
i=0
while kill -0 "$apppid" 2>/dev/null; do
  i=$((i + 1))
  [ $i -gt 600 ] && { kill "$apppid"; echo "selftest: the relaunch did not finish in 60 s" >&2; exit 1; }
  sleep 0.1
done
# The third launch: the relaunch closed every tab after its shell went to
# a folder of its own; with no tab to bring back, the first shell opens
# there (TERM-068, SelfTestTermA.swift).
# shellcheck disable=SC2086
env -i $envs $appenv RAVENRY_MAC_LASTCWD_CHECK=1 "$exe" --offscreen --socket "$sock" --selftest "$out/lastcwd.json" 2>>"$dir/app.log" &
apppid=$!
i=0
while kill -0 "$apppid" 2>/dev/null; do
  i=$((i + 1))
  [ $i -gt 600 ] && { kill "$apppid"; echo "selftest: the third launch did not finish in 60 s" >&2; exit 1; }
  sleep 0.1
done
# No daemon to reach (WIN-007): the app says why and quits, it never shows
# an empty window. Off every screen the alert's words are written instead.
t0=$(date +%s)
# shellcheck disable=SC2086
env -i $envs $appenv "$exe" --offscreen --socket "$dir/run/none.sock" --selftest "$out/nodaemon.json" 2>"$dir/nodaemon.log" &
apppid=$!
i=0
while kill -0 "$apppid" 2>/dev/null; do
  i=$((i + 1))
  [ $i -gt 300 ] && { kill "$apppid"; break; }
  sleep 0.1
done
echo "$(( $(date +%s) - t0 ))" > "$out/nodaemon.secs"
grep -c "alert: Ravenry cannot open a terminal" "$dir/nodaemon.log" > "$out/nodaemon.logged" || true
echo "selftest: files in $out" >&2
/usr/bin/python3 -I - "$out/selftest.json" "$out/restore.json" "$out/lastcwd.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
if "error" in r:
    print("selftest: error:", r["error"][:300]); sys.exit(1)
try:
    r2 = json.load(open(sys.argv[2]))
except Exception as e:
    r2 = {"checks": [{"name": "restore_ran", "ok": False, "detail": str(e)}]}
r["checks"] += r2.get("checks", [{"name": "restore_ran", "ok": False, "detail": r2.get("error", "")}])
try:
    r3 = json.load(open(sys.argv[3]))
except Exception as e:
    r3 = {"checks": [{"name": "lastcwd_ran", "ok": False, "detail": str(e)}]}
r["checks"] += r3.get("checks", [{"name": "lastcwd_ran", "ok": False, "detail": r3.get("error", "")}])
import os
d = os.path.dirname(sys.argv[1])
try:
    nd = json.load(open(os.path.join(d, "nodaemon.json")))
except Exception as e:
    nd = {"error": "", "why": str(e)}
secs = open(os.path.join(d, "nodaemon.secs")).read().strip() if os.path.exists(os.path.join(d, "nodaemon.secs")) else "?"
logged = open(os.path.join(d, "nodaemon.logged")).read().strip() if os.path.exists(os.path.join(d, "nodaemon.logged")) else "0"
ok = nd.get("alert") == "Ravenry cannot open a terminal" and "none.sock" in nd.get("error", "") and secs.isdigit() and int(secs) < 15 and logged not in ("", "0")
r["checks"].append({"name": "no_daemon_says_why_and_quits", "ok": ok, "detail": "quit after %s s; alert %r; why %r; logged %s" % (secs, nd.get("alert"), nd.get("error"), logged)})
failed = 0
for c in r["checks"]:
    ok = c["ok"]
    failed += 0 if ok else 1
    detail = c.get("detail", "").replace("\n", "\\n")
    print("%s %s%s" % ("pass" if ok else "FAIL", c["name"], (": " + detail) if detail else ""))
print("selftest: %d checks, %d failed" % (len(r["checks"]), failed))
sys.exit(1 if failed else 0)
PY
