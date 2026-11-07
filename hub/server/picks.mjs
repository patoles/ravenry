// The pictures of a pick (a `pick` checkpoint, PROTOCOL.md section 4),
// kept in Ravenry's data with the project they belong to, never in the
// repository: the agent's files may be temporary (a shot, a build output),
// and the person's choice should still show what they chose from.
//
// When a pick opens, the hub copies each variant from the machine that
// holds the checkpoint (file.read through its daemon) to
//
//   <RAVENRY_HOME>/projects/<project id>/picks/<checkpoint id>/<n>.<ext>
//
// (<RAVENRY_HOME>/picks/<checkpoint id>/ when the pick belongs to no
// project), beside its record, pick.json:
//
//   { checkpoint, title, project, machine, created_at,
//     variants: [ { label, type ("image" or "html"), source (the path the
//       agent gave, on its machine), file (the kept copy, or null when it
//       could not be copied), size, pane? } ],
//     answer?: { label, region?, note?, by?, at } | { declined: true,
//       reason?, by?, at } | { closed: "cancelled" | "expired", at } }
//
// The variants are served from the kept copies (GET
// /api/checkpoints/<id>/variants/<n>), and the hub's checkpoint view links
// the record.

import fs from 'node:fs';
import path from 'node:path';
import { RAVENRY_HOME, assertDataWrite } from './home.mjs';

export const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8' };
export const MAX_FILE = 32 << 20;
const SAFE = /^[\w.-]{1,128}$/;
const CP = /^[a-z0-9]{1,16}$/;

export function dirFor(cpId, projectId, home = RAVENRY_HOME) {
  if (!CP.test(cpId)) return null;
  return projectId && SAFE.test(projectId) && projectId !== '.' && projectId !== '..'
    ? path.join(home, 'projects', projectId, 'picks', cpId)
    : path.join(home, 'picks', cpId);
}

// The folder of a pick already kept, wherever its project is.
export function find(cpId, home = RAVENRY_HOME) {
  if (!CP.test(cpId)) return null;
  const loose = path.join(home, 'picks', cpId);
  if (fs.existsSync(path.join(loose, 'pick.json'))) return loose;
  let projects = [];
  try { projects = fs.readdirSync(path.join(home, 'projects')); } catch { return null; }
  for (const p of projects) {
    const d = path.join(home, 'projects', p, 'picks', cpId);
    if (fs.existsSync(path.join(d, 'pick.json'))) return d;
  }
  return null;
}

export function record(cpId, home = RAVENRY_HOME) {
  const d = find(cpId, home);
  if (!d) return null;
  try { return { dir: d, ...JSON.parse(fs.readFileSync(path.join(d, 'pick.json'), 'utf8')) }; } catch { return null; }
}

function write(dir, rec) {
  const f = path.join(dir, 'pick.json');
  assertDataWrite(f);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, f);
}

export const extOf = (p) => path.extname(String(p || '')).slice(1).toLowerCase();

// Keeps a pick's variants: `read(path)` resolves to { ok, data } (the
// daemon's file.read). Copies what is not kept yet, so it can run again
// (a copy that failed is tried at the next look). Returns the record.
const busy = new Map();
export function keep(cp, opts) {
  if (busy.has(cp.id)) return busy.get(cp.id);
  const p = keepNow(cp, opts).finally(() => busy.delete(cp.id));
  busy.set(cp.id, p);
  return p;
}
async function keepNow(cp, { projectId = null, machine = null, read, home = RAVENRY_HOME }) {
  if (!cp || cp.kind !== 'pick' || !Array.isArray(cp.variants)) return null;
  const old = record(cp.id, home);
  const dir = old ? old.dir : dirFor(cp.id, projectId, home);
  if (!dir) return null;
  const rec = old ? { ...old } : { checkpoint: cp.id, title: cp.title, project: projectId || null, machine: machine || null, created_at: cp.created_at || new Date().toISOString(), variants: [] };
  delete rec.dir;
  rec.variants = await Promise.all(cp.variants.slice(0, 4).map(async (v, n) => {
    const had = rec.variants && rec.variants[n];
    if (had && had.file && fs.existsSync(path.join(dir, had.file))) return had;
    const ext = extOf(v.path);
    const out = { label: v.label, type: v.type === 'html' ? 'html' : 'image', source: v.path, file: null, ...(v.size != null ? { size: v.size } : {}), ...(v.pane ? { pane: v.pane } : {}) };
    if (!TYPES[ext] || (out.type === 'html') !== /^html?$/.test(ext)) return { ...out, error: 'not a picture or an HTML page' };
    const r = await read(v.path);
    if (!r.ok) return { ...out, error: r.error };
    const name = `${n}.${ext}`;
    const f = path.join(dir, name);
    assertDataWrite(f);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, r.data, { mode: 0o600 });
    return { ...out, file: name, size: r.data.length };
  }));
  write(dir, rec);
  return { dir, ...rec };
}

// A closed pick: the answer goes into its record.
export function closed(cp, home = RAVENRY_HOME) {
  const r = record(cp.id, home);
  if (!r || r.answer) return r;
  const a = cp.answer || {};
  const answer = a.pick ? { label: a.pick.label, ...(a.pick.region ? { region: a.pick.region } : {}), ...(a.pick.note ? { note: a.pick.note } : {}), ...(a.by ? { by: a.by } : {}), at: a.at || cp.closed_at }
    : a.declined ? { declined: true, ...(a.reason ? { reason: a.reason } : {}), ...(a.by ? { by: a.by } : {}), at: a.at || cp.closed_at }
      : { closed: cp.state, at: cp.closed_at || new Date().toISOString() };
  const { dir, ...rec } = r;
  write(dir, { ...rec, answer });
  return { dir, ...rec, answer };
}

// The kept file of variant n, or null.
export function keptFile(cpId, n, home = RAVENRY_HOME) {
  const r = record(cpId, home);
  const v = r && r.variants && r.variants[n];
  if (!v || !v.file || !/^\d\.[a-z]+$/.test(v.file)) return null;
  const f = path.join(r.dir, v.file);
  return fs.existsSync(f) ? { file: f, ext: extOf(v.file), type: v.type } : null;
}
