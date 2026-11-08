// One budget of main-thread time for all of the hub's long jobs that give
// the event loop back as they go (a tick's builds, a transcript's reading,
// the pictures' and the repeats' scans, a daemon's backlog...).
//
// Each used to keep its own 15 to 50 ms slice and give back with
// setImmediate: when several ran at once, one turn of the event loop ran a
// slice of each, back to back, and held the main thread for their sum, up
// to 260 ms on the start-up load test (2026-11-08). Now they share it: a
// job asks due() after each piece of work and, when the hub has run for
// SLICE_MS since it last let timers and I/O through, waits on pause(). The
// stretch starts again only after a timer turn, so the jobs that wake in
// the same turn give way at once.
const SLICE_MS = 12;
let since = null;
let armed = false;

/** True when the hub has run its slice: the job should await pause(). */
export function due() {
  const now = Date.now();
  if (since === null) since = now;
  return now - since >= SLICE_MS;
}

/** Lets timers (the stall watch, the HTTP server's) and I/O through, then goes on. */
export function pause() {
  if (!armed) { armed = true; setTimeout(() => { armed = false; since = null; }, 0); }
  return new Promise((r) => setTimeout(r, 0));
}

/** due() then pause(), as one call. */
export async function breathe() { if (due()) await pause(); }
