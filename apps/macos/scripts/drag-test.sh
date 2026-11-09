#!/bin/sh
# The resize drag, headless, on a throwaway daemon:
#
#   scripts/drag-test.sh [COMMAND ARGS...]   (DRAG_APP: the .app, default apps/macos/build/RavenryMac.app)
#
# DRAG_MIN: the narrowest width of the drag in points (default 300, where
# the command line is taller than the window and zsh starts it with
# ">...."; 620 keeps it to wide windows).
#
# The pane runs zsh (with the daemon's shell integration, as a login shell
# does) at a prompt holding a long multi-line command line. The app drags
# its window's width down and back at about 120 steps a second and
# measures, after each step, how much text Ghostty's last frame shows
# and what text the terminal holds (SelfTest.swift, --drag). `ravenryd
# attach` records everything it sends the window (RAVENRY_ATTACH_TRACE).
# The script prints the frames that went blank, the steps whose screen
# held debris (text that is not one piece of the prompt and its command
# line, such as a leftover "~ >...." row of an earlier redraw), whether
# the window ends on the daemon's screen, and the snapshots and screen
# clears the window was sent during the drag. The target is 0 blank, 0
# debris, the daemon's screen.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../.." && pwd)
app=${DRAG_APP:-$here/build/RavenryMac.app}
# Arguments: the pane's command instead of the login shell (zsh).
bin="$app/Contents/MacOS/ravenryd"

mkdir -p "$repo/.tmp"
dir=$(mktemp -d "$repo/.tmp/macos-drag.XXXXXX")
mkdir -m 700 "$dir/user" "$dir/run" "$dir/state"
# DRAG_ZSHRC: more lines for the zsh startup file.
printf '%s\n' "PROMPT='%~ > '" "${DRAG_ZSHRC:-}" > "$dir/user/.zshrc"
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
  [ $i -gt 100 ] && { echo "drag-test: the daemon did not start" >&2; exit 1; }
  sleep 0.05
done

# shellcheck disable=SC2086
env -i $envs RAVENRY_ATTACH_TRACE="$dir/trace.txt" "$app/Contents/MacOS/RavenryMac" \
  --offscreen --socket "$sock" --selftest "$dir/result.json" --drag --drag-min "${DRAG_MIN:-300}" ${1:+--} "$@" 2>"$dir/app.log" &
apppid=$!
i=0
while kill -0 "$apppid" 2>/dev/null; do
  i=$((i + 1))
  [ $i -gt 1200 ] && { kill "$apppid"; echo "drag-test: the app did not finish in 120 s" >&2; exit 1; }
  sleep 0.1
done
[ -f "$dir/result.json" ] || { echo "drag-test: no result; see $dir/app.log" >&2; exit 1; }
# The daemon's screen, to compare with what the window ended on.
# shellcheck disable=SC2086
pane=$(env -i $envs "$bin" ls --json --socket "$sock" | /usr/bin/python3 -I -c 'import json,sys; p=json.load(sys.stdin); print(p[0]["id"] if p else "")')
# shellcheck disable=SC2086
env -i $envs "$bin" capture "$pane" --socket "$sock" > "$dir/daemon-screen.txt"

/usr/bin/python3 -I - "$dir" <<'EOF'
import json, sys, os, ast
d = sys.argv[1]
r = json.load(open(os.path.join(d, "result.json")))
steps = r.get("steps", [])
base = r.get("ink_before", 0)
print("steps %d, ink before %.4f, after %.4f" % (len(steps), base, r.get("ink_after", 0)))
blank = [s for s in steps if s["ink"] < base * 0.3]
print("blank frames during the drag: %d of %d" % (len(blank), len(steps)))
for s in blank[:10]:
    print("  at %4d ms, width %d, cols %d, ink %.4f" % (s["ms"], s["width"], s["cols"], s["ink"]))

# Ghostty's text joins soft-wrapped rows and the capture does not, so the
# two are compared without white space.
flat = lambda t: "".join(t.split())
win, dmn = flat(r.get("screen", "")), flat(open(os.path.join(d, "daemon-screen.txt")).read())
print("the window ends on the daemon's screen: %s (%d and %d characters)" % ("yes" if win == dmn else "NO", len(win), len(dmn)))

# Debris: a screen whose text, without white space, is not one piece of
# what was on the screen at the prompt followed by the pasted command line.
# zsh shows a command line taller than the screen from the middle, its
# top row the prompt and ">....", so that mark is taken off first.
prompt = flat(r.get("prompt_screen", ""))
whole = prompt + flat(r.get("pasted", ""))
def debris(t):
    f = flat(t)
    if f.startswith(prompt + ">...."):
        f = f[len(prompt) + 5:]
    elif f.startswith(">...."):
        f = f[5:]
    return f not in whole
bad = [s for s in steps if debris(s.get("text", ""))]
print("steps with debris on the screen: %d of %d%s" % (len(bad), len(steps), "" if steps and "text" in steps[0] else " (no step text: old app)"))
for s in bad[:3]:
    rows = [l for l in s["text"].split("\n") if l.strip()][:4]
    print("  at %4d ms, width %d, cols %d: %s" % (s["ms"], s["width"], s["cols"], " | ".join(x[:40] for x in rows)))
print("debris on the last screen: %s" % ("YES" if debris(r.get("screen", "")) else "no"))

# The trace: everything attach wrote to the window after the paste.
ev = []
for line in open(os.path.join(d, "trace.txt")):
    t, kind, rest = line.split(" ", 2)
    if kind in ("resize", "hold"):
        ev.append((float(t), kind, rest.strip(), b""))
        continue
    mark, n, q = rest.split(" ", 2)
    ev.append((float(t), kind, mark, ast.literal_eval(q).encode("utf-8", "surrogateescape")))
resizes = [e for e in ev if e[1] == "resize"]
start = resizes[0][0] if resizes else 0
during = [e for e in ev if e[0] >= start and e[1] in ("out", "snap")]
snaps = sum(1 for e in during if e[1] == "snap")
out = b"".join(e[3] for e in during)
print("resizes sent to the pane: %d" % len(resizes))
print("resize holds: %d" % sum(1 for e in ev if e[1] == "hold" and e[2] == "on"))
print("frames to the window during the drag: %d (%d bytes), snapshots %d" % (len(during), len(out), snaps))
for name, seq in [("ESC c (reset)", b"\x1bc"), ("ESC[2J (clear screen)", b"\x1b[2J"), ("ESC[J (clear below)", b"\x1b[J"),
                  ("ESC[0J", b"\x1b[0J"), ("ESC[H (home)", b"\x1b[H"), ("ESC[?2026h (sync start)", b"\x1b[?2026h")]:
    print("  %-26s %d" % (name, out.count(seq)))
EOF
echo "drag-test: files in $dir" >&2
