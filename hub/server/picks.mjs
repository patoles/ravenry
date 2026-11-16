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
//     variants: [ { label, type ("image", "html" or "video"), source (the
//       path the agent gave, on its machine), file (the kept copy, or null
//       when it could not be copied), size, pane?, video? (an HTML page's
//       own video, kept beside it as <n>.video.<ext>: the page's first
//       <video>, from a data: URI or a file next to the page) } ],
//     answer?: { label, region?, note?, by?, at } | { declined: true,
//       reason?, by?, at } | { closed: "cancelled" | "expired", at } }
//
// The variants are served from the kept copies (GET
// /api/checkpoints/<id>/variants/<n>, ?as=video for a page's video), and
// the hub's checkpoint view links the record.
//
// A page that holds a video plays as that video on every client (the
// pickvideo round, 2026-11-16): in a frame the page cannot play it (a
// sandboxed frame never starts a video by itself, and the Mac app draws a
// page as a picture), and a ring drawn on its paused frame needs the
// frame's time, which a sandboxed frame does not tell.

import fs from 'node:fs';
import path from 'node:path';
import { RAVENRY_HOME, assertDataWrite } from './home.mjs';

export const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm' };
export const VIDEO = new Set(['mp4', 'm4v', 'mov', 'webm']);
// A variant's file, a video's too (ravenryd's maxVariantSize).
export const MAX_FILE = 100 << 20;
const typeOfExt = (ext) => (/^html?$/.test(ext) ? 'html' : VIDEO.has(ext) ? 'video' : 'image');

// The first <video> of a page: its src, or its first <source>'s.
export function pageVideoSrc(html) {
  const m = /<video\b([^>]*)>([\s\S]*?)(?:<\/video\s*>|$)/i.exec(String(html || ''));
  if (!m) return null;
  const attr = (tag) => { const a = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag); return a ? (a[1] ?? a[2] ?? a[3]).replace(/&amp;/g, '&').trim() : null; };
  const own = attr(m[1]);
  if (own) return own;
  const src = /<source\b([^>]*)>/i.exec(m[2]);
  return src ? attr(src[1]) : null;
}
const MIME_EXT = { 'video/mp4': 'mp4', 'video/x-m4v': 'm4v', 'video/quicktime': 'mov', 'video/webm': 'webm' };
// A page's video as { data, ext }, or null: a data: URI, else a file the
// page names beside it (or by its whole path, file:// too) on the agent's
// machine, read through `read`. Never the web.
export async function pageVideo(html, pagePath, read) {
  const src = pageVideoSrc(html);
  if (!src) return null;
  const d = /^data:([\w.+/-]+)((?:;[\w=.-]+)*?)(;base64)?,(.*)$/is.exec(src);
  if (d) {
    const ext = MIME_EXT[d[1].toLowerCase()];
    if (!ext) return null;
    const data = d[3] ? Buffer.from(d[4].replace(/\s+/g, ''), 'base64') : Buffer.from(decodeURIComponent(d[4]), 'latin1');
    return data.length && data.length <= MAX_FILE ? { data, ext } : null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^file:/i.test(src)) return null;
  let f = src.replace(/[?#].*$/, '');
  try { f = decodeURIComponent(f.replace(/^file:\/\//i, '')); } catch { return null; }
  if (!path.posix.isAbsolute(f)) f = path.posix.join(path.posix.dirname(String(pagePath || '/')), f);
  const ext = extOf(f);
  if (!VIDEO.has(ext)) return null;
  const r = await read(f);
  return r && r.ok && r.data && r.data.length ? { data: r.data, ext } : null;
}
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
    const out = { label: v.label, type: v.type === 'html' || v.type === 'video' ? v.type : 'image', source: v.path, file: null, ...(typeof v.description === 'string' && v.description ? { description: v.description } : {}), ...(v.size != null ? { size: v.size } : {}), ...(v.pane ? { pane: v.pane } : {}) };
    if (!TYPES[ext] || out.type !== typeOfExt(ext)) return { ...out, error: 'not a picture, an HTML page or a video' };
    const r = await read(v.path);
    if (!r.ok) return { ...out, error: r.error };
    const name = `${n}.${ext}`;
    const f = path.join(dir, name);
    assertDataWrite(f);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, r.data, { mode: 0o600 });
    const kept = { ...out, file: name, size: r.data.length };
    // A page that holds a video: the video kept beside it, played in its place.
    if (out.type === 'html') {
      const pv = await pageVideo(r.data.toString('utf8'), v.path, read).catch(() => null);
      if (pv) {
        const vname = `${n}.video.${pv.ext}`;
        const vf = path.join(dir, vname);
        assertDataWrite(vf);
        fs.writeFileSync(vf, pv.data, { mode: 0o600 });
        kept.video = vname;
      }
    }
    return kept;
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

// The kept file of variant n, or null; `video`: the file of the video it
// plays (a video's own, a page's video), when it has one.
export function keptFile(cpId, n, home = RAVENRY_HOME) {
  const r = record(cpId, home);
  const v = r && r.variants && r.variants[n];
  if (!v || !v.file || !/^\d\.[a-z0-9]+$/.test(v.file)) return null;
  const f = path.join(r.dir, v.file);
  if (!fs.existsSync(f)) return null;
  const vf = v.type === 'video' ? f : v.video && /^\d\.video\.[a-z0-9]+$/.test(v.video) ? path.join(r.dir, v.video) : null;
  return { file: f, ext: extOf(v.file), type: v.type, ...(vf && fs.existsSync(vf) ? { video: vf, videoExt: extOf(vf) } : {}) };
}

// The URL a client plays variant n of a kept pick from, or null: a video's
// own, a page's video (?as=video).
export function videoUrl(cpId, v, n, kept) {
  const base = `/api/checkpoints/${encodeURIComponent(cpId)}/variants/${n}`;
  if (v && v.type === 'video') return base;
  const k = kept && kept.variants && kept.variants[n];
  return k && k.type === 'html' && k.video ? `${base}?as=video` : null;
}
