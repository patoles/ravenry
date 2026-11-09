#!/bin/sh
# The native app's headless check, on a throwaway daemon:
#
#   scripts/selftest.sh [APP]       default APP: apps/macos/build/RavenryMac.app
#
# It starts the app's own ravenryd as a throwaway daemon (its HOME, runtime
# and state folders in the repository's .tmp/, /bin/sh as the shell), then
# the app with its window off every screen and no Dock icon. The app types
# into its Ghostty terminal through its key path, reads what the terminal
# shows, grows the window and prints 200000 lines (SelfTest.swift). This
# script then checks the daemon's side: the pane saw the typed command and
# its answer, and took the window's size. Nothing touches the real daemon,
# the hub or the user's folders.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../.." && pwd)
app=${1:-$here/build/RavenryMac.app}
bin="$app/Contents/MacOS/ravenryd"

mkdir -p "$repo/.tmp"
dir=$(mktemp -d "$repo/.tmp/macos-selftest.XXXXXX")
mkdir -m 700 "$dir/user" "$dir/run" "$dir/state"
envs="HOME=$dir/user PATH=/usr/bin:/bin SHELL=/bin/sh LANG=en_US.UTF-8 RAVENRY_RUNTIME_DIR=$dir/run RAVENRY_STATE_DIR=$dir/state"
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
  [ $i -gt 100 ] && { echo "selftest: the daemon did not start; see $dir/daemon.log" >&2; exit 1; }
  sleep 0.05
done

rv() {
  # shellcheck disable=SC2086
  env -i $envs "$bin" "$@" --socket "$sock"
}

# The query probe the app runs in its pane (`sh q`, from the pane's folder,
# its HOME): it asks for device attributes (the daemon answers), the
# background colour and the size in characters (only the window answers),
# and records every byte it reads back.
cat > "$dir/user/q" <<'Q'
exec /usr/bin/python3 -I q.py answers.txt
Q
cat > "$dir/user/q.py" <<'Q'
import os, sys, tty, termios, select, time
fd = 0
old = termios.tcgetattr(fd)
tty.setraw(fd)
os.write(1, b"\x1b[c\x1b]11;?\x1b\\\x1b[18t")
buf = b""
end = time.time() + 1.5
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.05)
    if r:
        buf += os.read(fd, 4096)
termios.tcsetattr(fd, termios.TCSADRAIN, old)
open(sys.argv[1], "w").write(repr(buf))
print("probe-done")
Q

echo "selftest: app on $dir" >&2
# shellcheck disable=SC2086
env -i $envs "$app/Contents/MacOS/RavenryMac" --offscreen --socket "$sock" \
  --selftest "$dir/result.json" -- /bin/sh 2>"$dir/app.log" &
apppid=$!
i=0
while kill -0 "$apppid" 2>/dev/null; do
  i=$((i + 1))
  [ $i -gt 1200 ] && { kill "$apppid"; echo "selftest: the app did not finish in 120 s; see $dir/app.log" >&2; exit 1; }
  sleep 0.1
done

[ -f "$dir/result.json" ] || { echo "selftest: no result; see $dir/app.log" >&2; exit 1; }
pane=$(rv ls --json --label ravenry.client=macos | /usr/bin/python3 -I -c 'import json,sys; p=json.load(sys.stdin); print(p[0]["id"] if p else "")')
[ -n "$pane" ] || { echo "selftest: no pane was started" >&2; exit 1; }
rv inputs "$pane" > "$dir/inputs.txt"
rv ls --json --label ravenry.client=macos > "$dir/pane.json"
rv close "$pane" >/dev/null

# A window with no --socket finds the running daemon itself, as a real
# run does (never starting one: --no-start), and a window that started its
# pane closes it when it goes, even when the app is killed: the pty hangs
# up and `ravenryd attach --close` closes the pane.
# shellcheck disable=SC2086
env -i $envs "$app/Contents/MacOS/RavenryMac" --offscreen -- /bin/sh 2>>"$dir/app.log" &
apppid=$!
i=0
until rv ls --json --label ravenry.client=macos | grep -q '"id"'; do
  i=$((i + 1))
  [ $i -gt 100 ] && { kill "$apppid"; echo "selftest: the second window started no pane" >&2; exit 1; }
  sleep 0.05
done
kill -TERM "$apppid"
i=0
closed=no
while [ $i -lt 100 ]; do
  if ! rv ls --json --label ravenry.client=macos | grep -q '"id"'; then closed=yes; break; fi
  i=$((i + 1))
  sleep 0.05
done
echo "$closed" > "$dir/closed.txt"

/usr/bin/python3 -I - "$dir" <<'EOF'
import json, sys, os
d = sys.argv[1]
r = json.load(open(os.path.join(d, "result.json")))
pane = json.load(open(os.path.join(d, "pane.json")))[0]
inputs = open(os.path.join(d, "inputs.txt")).read()
answers = open(os.path.join(d, "user", "answers.txt")).read() if os.path.exists(os.path.join(d, "user", "answers.txt")) else ""
checks = [
    ("prompt reached the window", r.get("prompt") is True),
    ("typed keys reached the pane, as the person's", "expr 50 - 8" in inputs and "person" in inputs),
    ("the pane's answer reached the window", r.get("typed_answer") is True),
    ("the window grew", r["grid_after"] != r["grid_before"]),
    ("the pane took the window's size", [pane["cols"], pane["rows"]] == r["grid_after"]),
    ("the program saw the new size", r.get("stty_after") is True),
    ("200000 lines reached the window", r.get("seq_done") is True),
    ("one answer to device attributes (the daemon's)", answers.count("c") >= 1 and answers.count("\\x1b[?") == 1),
    ("the window answered its colour and size", "]11;rgb:" in answers and "[8;" in answers),
    ("a picture was drawn", bool(r.get("picture")) and os.path.exists(r["picture"])),
    ("a window found the daemon, and its pane closed when it was killed", open(os.path.join(d, "closed.txt")).read().strip() == "yes"),
]
for name, ok in checks:
    print(("ok   " if ok else "FAIL ") + name)
print("grid %s -> %s, pane %sx%s" % (r["grid_before"], r["grid_after"], pane["cols"], pane["rows"]))
print("first prompt %s ms after launch; typed answer %s ms; 200000 lines %s ms" % (r.get("prompt_ms"), r.get("typed_answer_ms"), r.get("seq_ms")))
print("query answers the program read: %s" % answers)
print("picture: %s" % r.get("picture"))
sys.exit(0 if all(ok for _, ok in checks) else 1)
EOF
