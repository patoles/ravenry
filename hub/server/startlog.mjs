// The hub's own record of its start, in hub.log and beside it (2026-11-07:
// three updates rolled back because the new hub, run by launchd on a real
// board, listened and then answered nothing for about 34 s, and nothing on
// the Mac said where the time went).
//
//   - phase(name): what the hub is doing now. A watchdog checks the main
//     thread every 100 ms; any stretch it was held over 500 ms is logged
//     with the phase it began in ("stall: ... in tick 1: events").
//   - step(name, fn): a start-up step, timed and logged ("start: name N ms").
//   - tickPhases(n): for the first 3 ticks, each phase's ms on one line.
//   - profileStart(): for a service hub (RAVENRY_HUB_SERVICE=1) of a version
//     not profiled before, a CPU profile of its first 90 s (the inspector,
//     no flags), written in 15 s parts as it goes and when the hub exits:
//     <logs>/start-<version>.<from>-<to>s.cpuprofile, and the parts joined
//     into <logs>/start-<version>.cpuprofile at the end. A part written as
//     it goes survives a rollback that ends the hub early.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const T0 = Date.now();
// Since the process started (not this module), as the hub's other lines say.
const since = () => Math.round(process.uptime() * 1000);
const ring = []; // [at, phase]
let now = 'start';
export function phase(name) {
  now = name;
  ring.push([Date.now(), name]);
  if (ring.length > 1000) ring.splice(0, 200);
}
function phaseAt(t) {
  let n = 'start';
  for (const [at, name] of ring) { if (at <= t) n = name; else break; }
  return n;
}

export function watchStalls() {
  let last = Date.now();
  const iv = setInterval(() => {
    const t = Date.now();
    const held = t - last - 100;
    if (held > 500) console.log(`stall: the main thread was held ${held} ms in "${phaseAt(last + 100)}", ${since()} ms after start`);
    last = t;
  }, 100);
  iv.unref();
}

export async function step(name, fn) {
  phase(`start: ${name}`);
  const t = Date.now();
  try { return await fn(); } finally { console.log(`start: ${name} ${Date.now() - t} ms, ${since()} ms after start`); }
}

// One tick's phases: mark(name) at each; done() logs them (first 3 ticks).
export function tickPhases(n) {
  const on = n <= 3;
  let t = Date.now();
  let cur = null;
  const out = [];
  return {
    mark(name) {
      const x = Date.now();
      if (cur && on) out.push(`${cur} ${x - t}`);
      cur = name;
      t = x;
      phase(`tick ${n}: ${name}`);
    },
    done() {
      if (cur && on) out.push(`${cur} ${Date.now() - t}`);
      if (on) console.log(`tick ${n} phases (ms): ${out.join(', ')}`);
      phase('idle');
    },
  };
}

function logsDir() {
  return process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Logs', 'Ravenry') : path.join(os.homedir(), '.local', 'state', 'ravenry');
}

// Parts of one profile joined: one root, each part's nodes under it, ids
// offset, samples and time deltas in order.
function join(parts) {
  const nodes = [{ id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, hitCount: 0, children: [] }];
  const samples = [];
  const timeDeltas = [];
  let offset = 1;
  let prevEnd = null;
  for (const p of parts) {
    let max = 0;
    for (const n of p.nodes) {
      max = Math.max(max, n.id);
      nodes.push({ ...n, id: n.id + offset, children: (n.children || []).map((c) => c + offset) });
    }
    nodes[0].children.push(p.nodes[0].id + offset);
    for (const x of p.samples) samples.push(x + offset);
    // The first sample of a later part also carries the gap since the last part ended.
    p.timeDeltas.forEach((d, i) => timeDeltas.push(i === 0 && prevEnd != null ? Math.max(0, p.startTime - prevEnd) + d : d));
    prevEnd = p.endTime;
    offset += max;
  }
  return { nodes, startTime: parts[0].startTime, endTime: parts[parts.length - 1].endTime, samples, timeDeltas };
}

export async function profileStart() {
  if (process.env.RAVENRY_HUB_SERVICE !== '1') return;
  const version = String(process.env.RAVENRY_APP_VERSION || 'unknown').replace(/[^0-9A-Za-z.+-]/g, '_');
  const dir = logsDir();
  const whole = path.join(dir, `start-${version}.cpuprofile`);
  if (fs.existsSync(whole)) return; // once per version
  let inspector;
  try { inspector = await import('node:inspector'); } catch { return; }
  const s = new inspector.Session();
  try { s.connect(); } catch { return; }
  const post = (m, p = {}) => new Promise((r) => s.post(m, p, (e, res) => r(e ? null : res)));
  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', { interval: 1000 });
  await post('Profiler.start');
  fs.mkdirSync(dir, { recursive: true });
  const parts = [];
  let from = 0;
  let done = false;
  // Stops, writes the part, and starts again (unless it is the last).
  // Synchronous: the inspector answers in the same turn, so it also runs
  // in an exit handler.
  const cut = (last) => {
    if (done) return;
    const to = Math.round(since() / 1000);
    s.post('Profiler.stop', (e, res) => {
      if (!e && res && res.profile) {
        parts.push(res.profile);
        try { fs.writeFileSync(path.join(dir, `start-${version}.${from}-${to}s.cpuprofile`), JSON.stringify(res.profile)); } catch { /* the hub goes on */ }
      }
    });
    from = to;
    if (last) {
      done = true;
      try { if (parts.length) fs.writeFileSync(whole, JSON.stringify(join(parts))); } catch { /* the hub goes on */ }
      console.log(`start: CPU profile of the first ${to} s written to ${whole}`);
      try { s.disconnect(); } catch { /* gone */ }
    } else s.post('Profiler.start');
  };
  const timers = [15, 30, 45, 60, 75].map((sec) => setTimeout(() => cut(false), sec * 1000 - since()));
  const end = setTimeout(() => cut(true), 90000 - since());
  for (const t of [...timers, end]) t.unref();
  process.on('exit', () => cut(true));
  console.log(`start: a CPU profile of the first 90 s goes to ${whole}`);
}
