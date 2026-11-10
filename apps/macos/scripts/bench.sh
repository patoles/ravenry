#!/bin/sh
# The headless bench of the native app on a throwaway daemon:
#
#   scripts/bench.sh [OUT_DIR]   (BENCH_APP: the .app, default apps/macos/build/RavenryMac.app)
#
# BENCH_LAYER=1: draw through the window's CAMetalLayer, as on screen,
# rather than into an offscreen texture (no pictures then).
# BENCH_MIN: the narrowest width of the drag in points (default 300, where
# the command line is taller than the window). BENCH_ZSHRC: more lines for
# the zsh startup file. BENCH_FONT_SIZE: another size than the settings'
# default (13), for this run only.
#
# A daemon of the app's own ravenryd runs with a HOME, runtime and state
# folder of its own (never the person's), its pane a zsh at a prompt
# "~ > ". The app runs with its window off every screen, no Dock icon,
# drawing into an offscreen texture (Bench.swift), and writes
# OUT_DIR/bench.json and pictures of what it drew. Prints a summary.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../.." && pwd)
app=${BENCH_APP:-$here/build/RavenryMac.app}
bin="$app/Contents/MacOS/ravenryd"
mkdir -p "$repo/.tmp"
dir=$(mktemp -d "$repo/.tmp/macos-bench.XXXXXX")
out=${1:-$dir}
mkdir -p "$out"
mkdir -m 700 "$dir/user" "$dir/run" "$dir/state"
printf '%s\n' "PROMPT='~ > '" "${BENCH_ZSHRC:-}" > "$dir/user/.zshrc"
printf '%s\n' "skip_global_compinit=1" > "$dir/user/.zshenv"
envs="HOME=$dir/user PATH=/usr/bin:/bin SHELL=/bin/zsh LANG=en_US.UTF-8 RAVENRY_RUNTIME_DIR=$dir/run RAVENRY_STATE_DIR=$dir/state RAVENRY_DESKTOP_DATA=$dir/desktop"
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
  [ $i -gt 100 ] && { echo "bench: the daemon did not start" >&2; exit 1; }
  sleep 0.05
done
# shellcheck disable=SC2086
env -i $envs "$app/Contents/MacOS/RavenryMac" --offscreen --socket "$sock" --bench "$out/bench.json" \
  --drag-min "${BENCH_MIN:-300}" ${BENCH_LAYER:+--bench-layer} ${BENCH_FONT_SIZE:+--font-size "$BENCH_FONT_SIZE"} 2>"$dir/app.log" &
apppid=$!
i=0
while kill -0 "$apppid" 2>/dev/null; do
  i=$((i + 1))
  [ $i -gt 1800 ] && { kill "$apppid"; echo "bench: the app did not finish in 180 s" >&2; exit 1; }
  sleep 0.1
done
[ -f "$out/bench.json" ] || { echo "bench: no result; see $dir/app.log" >&2; exit 1; }
/usr/bin/python3 -I - "$out/bench.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
if "error" in r:
    print("bench: error:", r["error"][:300], flush=True); sys.exit(1)
def s(d, unit="ms"):
    return "median %.2f, p95 %.2f, max %.2f %s (n %d)" % (d.get("median", 0), d.get("p95", 0), d.get("max", 0), unit, d.get("n", 0))
print("grid %s, cell %s px" % (r.get("grid"), r.get("cell_px")))
if r.get("tabs"):
    print("window: %s; the drags check both panes of the split in front" % r["tabs"])
w = r.get("window_900x560")
if w:
    print("a 900 x 560 pt window at scale %g in the settings' font (Menlo 13 by default): %s, grid %s, cell %s px (%s pt); Rex's cell (Menlo 12, 14x28 px) there: %s" % (w["scale"], w["font"], w["grid"], w["cell_px"], w["cell_pt"], w["rex_grid"]))
print("typing, key to drawn echo:", s(r["typing_ms"]))
d = r["drag"]
print("drag %d steps in %.2f s down to %d pt: blank %d, debris %d, ends on the daemon's screen: %s" % (d["steps"], d["seconds"], d["min_width"], d["blank"], d["debris"], d["ends_on_daemon_screen"]))
print("  draws %d (%.0f a second), gap between draws: %s" % (d["draws"], d["fps"], s(d["draw_gap_ms"])))
print("  frame time (CPU build and encode + GPU): %s" % s(d["frame_ms"]))
print("  CPU %s; GPU %s" % (s(d["cpu_ms"]), s(d["gpu_ms"])))
for e in d.get("debris_examples", []):
    print("  debris:", e[:200])
def after(a):
    if isinstance(a, list):
        for x in a: after(x)
        return
    print("  after: debris rows %d, blank rows %d (history %d), first row as before: %s, whole command line: %s" % (a.get("debris", -1), a.get("blank_rows", -1), a.get("history", -1), a.get("top_is_prompt"), a.get("whole")))
    for e in a.get("debris_examples", []):
        print("    debris row:", e[:200])
after(d.get("after", {}))
f = r.get("fast_drag")
if f:
    print("fast drag %d steps in %.2f s (%.0f a second): blank %d, debris %d (of %d ticks), ends on the daemon's screen: %s" % (f["steps"], f["seconds"], f["steps_per_s"], f["blank"], f["debris"], f["ticks"], f["ends_on_daemon_screen"]))
    print("  frame time (CPU + GPU): %s" % s(f["frame_ms"]))
    for e in f.get("examples", []):
        print("  on screen:", e[:200])
    after(f.get("after", {}))
v = r.get("divider_drag")
if v:
    print("divider drag %d steps in %.2f s (20%% to 80%%): blank %d, debris %d, ends on the daemon's screen: %s" % (v["steps"], v["seconds"], v["blank"], v["debris"], v["ends_on_daemon_screen"]))
    print("  frame time (CPU + GPU): %s" % s(v["frame_ms"]))
    for e in v.get("examples", []):
        print("  on screen:", e[:200])
    after(v.get("after", {}))
t = r.get("tab_switch")
if t:
    print("tab switches %d: blank panes %d" % (t["switches"], t["blank_panes"]))
    print("  to the first draw (the rows the panes had): %s" % s(t["first_draw_ms"]))
    print("  to the first frame of the new streams: %s" % s(t["first_frame_ms"]))
    for e in t.get("examples", []):
        print("  blank:", e[:200])
q = r["seq"]
print("seq 1 2000000: %.2f s to the prompt (done %s), draws %d (%.0f a second)" % (q["seconds"], q["done"], q["draws"], q["fps"]))
print("  gap between draws: %s" % s(q["draw_gap_ms"]))
print("  frame time (CPU + GPU): %s" % s(q["frame_ms"]))
PY
echo "bench: files in $out" >&2
