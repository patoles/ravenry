// The Ideas board: ~/.ravenry/ideas.json, pictures copied into
// ~/.ravenry/ideas/. Each thread message and
// "Get 3 directions" runs `claude -p` in that folder, one at a time per idea.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

import { RAVENRY_HOME } from './registry.mjs';
import * as mk from './mockups.mjs';

export const IDEAS_PATH = path.join(RAVENRY_HOME, 'ideas.json');
export const IDEAS_DIR = path.join(RAVENRY_HOME, 'ideas');
export const STAGES = { spark: 'Spark', mock: 'Mockup', green: 'Greenlit', park: 'Parked' };
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif']);
const H = os.homedir();

// A new board starts with no ideas. (The first board was seeded once, on
// 2026-11-02, with its user's own; that list never shipped.)
const SEED = [];

let db = null;
const listeners = new Set();
const jobs = new Map(); // ideaId or '#brainstorm' -> { child, timer }

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed() { for (const fn of listeners) { try { fn(); } catch { /* ignore */ } } }

const now = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const noDash = (s) => String(s ?? '').replace(/\s*—\s*/g, ', ');

function save() {
  fs.mkdirSync(RAVENRY_HOME, { recursive: true });
  const tmp = IDEAS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n');
  fs.renameSync(tmp, IDEAS_PATH);
}

function copyPicture(src, stem) {
  if (!src || !fs.existsSync(src)) return null;
  fs.mkdirSync(IDEAS_DIR, { recursive: true });
  const ext = path.extname(src).toLowerCase();
  const name = `${stem}-${Date.now().toString(36)}${ext}`;
  fs.copyFileSync(src, path.join(IDEAS_DIR, name), fs.constants.COPYFILE_EXCL);
  return name;
}

export function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(IDEAS_PATH, 'utf8'));
    db.ideas = Array.isArray(db.ideas) ? db.ideas : [];
  } catch (e) {
    if (e.code !== 'ENOENT') { console.error('ideas: cannot read', IDEAS_PATH, e.message); db = { version: 1, ideas: [], broken: true }; return db; }
    // First run: seed once with the real ideas.
    db = { version: 1, seededAt: now(), ideas: [] };
    for (const s of SEED) {
      const id = newId();
      let img = null;
      try { img = copyPicture(s.src, id); } catch (err) { console.error('ideas: picture not copied', s.src, err.message); }
      db.ideas.push({ id, name: s.name, stage: s.stage, pitch: s.pitch, status: s.status, img, alt: img ? s.alt : null, thread: [], created: now(), updated: now() });
    }
    save();
  }
  // A reply that was running when the board stopped will never land.
  let fixed = false;
  for (const it of db.ideas) if (it.pending) { it.thread.push({ who: 'claude', error: true, text: 'The board restarted before Claude answered. Send it again.', at: now() }); delete it.pending; fixed = true; }
  for (const it of db.ideas) if (it.mockups && it.mockups.job) { it.mockups.error = { round: it.mockups.job.round, text: `The board restarted before round ${it.mockups.job.round} came back.`, note: it.mockups.job.note || '', from: it.mockups.job.from || null }; delete it.mockups.job; fixed = true; }
  if (db.brainstorm) { db.brainstormError = 'The board restarted before the directions came back. Try again.'; delete db.brainstorm; fixed = true; }
  if (fixed) save();
  return db;
}

function find(id) {
  const it = load().ideas.find((x) => x.id === id && !x.archived);
  if (!it) { const e = new Error('No such idea.'); e.status = 404; throw e; }
  return it;
}

// What the board gets: live ideas, newest jobs' state, picture urls.
export function view() {
  const d = load();
  return {
    ideas: d.ideas.filter((x) => !x.archived).map((x) => ({
      id: x.id, name: x.name, stage: x.stage, pitch: x.pitch || '', status: x.status || '',
      img: x.img ? `/api/ideas/img/${encodeURIComponent(x.img)}` : null, alt: x.alt || x.name,
      thread: (x.thread || []).map((m) => (m.mockupRound ? { who: 'board', text: roundLine(x, m.mockupRound), at: m.at, error: false, images: [], mockupRound: m.mockupRound } : { who: m.who, text: m.text, at: m.at, error: !!m.error, images: (m.images || []).map((f) => `/api/ideas/img/${encodeURIComponent(f)}`) })),
      pending: x.pending || null, updated: x.updated,
      mockups: mockupsView(x),
    })),
    archived: d.ideas.filter((x) => x.archived).length,
    brainstorm: d.brainstorm || null,
    brainstormError: d.brainstormError || null,
    lastBrainstorm: d.lastBrainstorm || null,
  };
}

export function count() {
  return load().ideas.filter((x) => !x.archived).length;
}

export function add({ name, pitch, stage }) {
  const n = noDash(name).replace(/\s+/g, ' ').trim();
  if (!n) { const e = new Error('Name the idea first.'); e.status = 400; throw e; }
  const it = { id: newId(), name: n.slice(0, 80), stage: STAGES[stage] ? stage : 'spark', pitch: noDash(pitch).trim(), status: `Added ${day(new Date())}.`, img: null, alt: null, thread: [], created: now(), updated: now() };
  load().ideas.unshift(it);
  save(); changed();
  return it;
}

export function update(id, patch) {
  const it = find(id);
  if (patch.name != null) { const n = noDash(patch.name).replace(/\s+/g, ' ').trim(); if (n) it.name = n.slice(0, 80); }
  if (patch.pitch != null) it.pitch = noDash(patch.pitch).trim();
  if (patch.status != null) it.status = noDash(patch.status).trim();
  if (patch.stage != null) {
    if (!STAGES[patch.stage]) { const e = new Error('Unknown stage.'); e.status = 400; throw e; }
    if (patch.stage !== it.stage) {
      it.stage = patch.stage;
      // Move it to the end of its new column.
      const all = load().ideas;
      all.splice(all.indexOf(it), 1);
      all.push(it);
    }
  }
  it.updated = now();
  save(); changed();
  return it;
}

// Kill is an archive, never a delete.
export function kill(id, reason = 'killed') {
  const it = find(id);
  if (jobs.has(id)) stop(id);
  if (it.mockups) delete it.mockups.job;
  it.archived = true;
  it.archivedAt = now();
  it.archivedWhy = reason;
  delete it.pending;
  save(); changed();
  return it;
}

export function promoted(id, projectId) {
  const it = find(id);
  it.promotedTo = projectId;
  return kill(id, 'promoted');
}

export function savePicture(id, filename, buf, { asReference = false } = {}) {
  const it = find(id);
  let ext = path.extname(String(filename || '')).toLowerCase();
  if (!IMG_EXT.has(ext)) {
    // Sniff the common ones: a pasted screenshot can arrive as "image".
    if (buf[0] === 0x89 && buf[1] === 0x50) ext = '.png';
    else if (buf[0] === 0xff && buf[1] === 0xd8) ext = '.jpg';
    else if (buf.slice(0, 4).toString() === 'GIF8') ext = '.gif';
    else if (buf.slice(8, 12).toString() === 'WEBP') ext = '.webp';
    else { const e = new Error('Only pictures can go on an idea (png, jpg, gif, webp).'); e.status = 415; throw e; }
  }
  fs.mkdirSync(IDEAS_DIR, { recursive: true });
  const name = `${it.id}-${Date.now().toString(36)}${ext}`;
  fs.writeFileSync(path.join(IDEAS_DIR, name), buf, { flag: 'wx' });
  if (!asReference) {
    it.img = name;
    it.dropped = name;
    it.alt = `${it.name}: ${path.basename(String(filename || 'picture'))}`;
    it.updated = now();
    save(); changed();
  }
  return name;
}

export function picturePath(file) {
  // A mockup picture: <idea id>/mockups/r<N>-<a|b|c>.png, for a real idea.
  const m = String(file).match(/^([\w-]+)\/mockups\/(r\d{1,3}-[abc]\.png)$/);
  if (m) {
    if (!load().ideas.some((x) => x.id === m[1])) return null;
    const abs = path.join(IDEAS_DIR, m[1], 'mockups', m[2]);
    return fs.existsSync(abs) ? abs : null;
  }
  const base = path.basename(String(file));
  if (base !== file || !IMG_EXT.has(path.extname(base).toLowerCase())) return null;
  const abs = path.join(IDEAS_DIR, base);
  return fs.existsSync(abs) ? abs : null;
}

// ------------------------------------------------------------ claude -p

function day(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function runClaude(key, prompt, cfg, done, argv = cfg.printCommand) {
  fs.mkdirSync(IDEAS_DIR, { recursive: true });
  const [cmd, ...args] = argv;
  let out = '';
  let err = '';
  let finished = false;
  const child = spawn(cmd, args, { cwd: IDEAS_DIR, env: { ...process.env, MC_IDEA_JOB: key }, stdio: ['pipe', 'pipe', 'pipe'] });
  const finish = (result) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    jobs.delete(key);
    done(result);
  };
  const timer = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
    const t = cfg.claudeTimeoutMs >= 60000 ? `${Math.round(cfg.claudeTimeoutMs / 60000)} minutes` : `${Math.round(cfg.claudeTimeoutMs / 1000)} seconds`;
    finish({ ok: false, error: `No answer after ${t}, so it was stopped. Send it again, or ask something smaller.` });
  }, cfg.claudeTimeoutMs);
  jobs.set(key, { child, timer });
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', (e) => finish({ ok: false, error: `Could not run ${path.basename(cmd)}: ${e.message}` }));
  child.on('close', (code) => {
    if (code === 0 && out.trim()) finish({ ok: true, text: out.trim() });
    else finish({ ok: false, error: `Claude stopped without an answer${code != null ? ' (exit ' + code + ')' : ''}${err.trim() ? ': ' + err.trim().split('\n').slice(-1)[0].slice(0, 200) : ''}.` });
  });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
}

function stop(key) {
  const j = jobs.get(key);
  if (!j) return;
  clearTimeout(j.timer);
  try { j.child.kill('SIGTERM'); } catch { /* gone */ }
  jobs.delete(key);
}

function context(it) {
  const lines = [
    'You are helping the user think through an idea on their Ideas board.',
    'Answer like a sharp collaborator: short (under 160 words), concrete, with a clear recommendation when they ask for one. Plain text, short lines or a few bullets, no headings, no em dashes.',
    '',
    `Idea: ${it.name}`,
    `Stage: ${STAGES[it.stage]}`,
    `Pitch: ${it.pitch || '(none yet)'}`,
    `Where it stands: ${it.status || '(nothing written)'}`,
  ];
  if (it.img) lines.push(`Its picture: ${path.join(IDEAS_DIR, it.img)} (read it if it helps)`);
  const th = (it.thread || []).filter((m) => !m.error);
  if (th.length > 1) {
    lines.push('', 'The conversation so far:');
    for (const m of th.slice(0, -1).slice(-16)) lines.push(m.mockupRound ? `Board: ${roundContext(it, m.mockupRound)}` : `${m.who === 'you' ? 'User' : 'Claude'}: ${m.text}${(m.images || []).length ? ` [pictures: ${m.images.map((f) => path.join(IDEAS_DIR, f)).join(', ')}]` : ''}`);
  }
  const last = th[th.length - 1];
  lines.push('', `The user now says: ${last.text}${(last.images || []).length ? `\n(They attached: ${last.images.map((f) => path.join(IDEAS_DIR, f)).join(', ')}. Read them.)` : ''}`);
  return lines.join('\n');
}

export function say(id, text, images, cfg) {
  const it = find(id);
  const t = String(text || '').trim();
  const imgs = (images || []).map(String).filter((f) => picturePath(f));
  if (!t && !imgs.length) { const e = new Error('Type a message first.'); e.status = 400; throw e; }
  if (it.pending) { const e = new Error('Claude is still answering the last one.'); e.status = 409; throw e; }
  if (it.mockups && it.mockups.job) { const e = new Error(`Claude is drawing round ${it.mockups.job.round}. Send it when the pictures are back.`); e.status = 409; throw e; }
  it.thread = it.thread || [];
  it.thread.push({ who: 'you', text: t || '(a picture)', images: imgs, at: now() });
  it.pending = { startedAt: now(), timeoutMs: cfg.claudeTimeoutMs };
  it.updated = now();
  save(); changed();
  runClaude(id, context(it), cfg, (r) => {
    const cur = load().ideas.find((x) => x.id === id);
    if (!cur) return;
    delete cur.pending;
    if (cur.archived) { save(); return; }
    cur.thread.push(r.ok ? { who: 'claude', text: noDash(r.text), at: now() } : { who: 'claude', error: true, text: r.error, at: now() });
    cur.updated = now();
    save(); changed();
  });
  return it;
}

// Pulls the first JSON array out of a reply, tolerating a code fence.
export function parseDirections(text) {
  const s = String(text);
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try {
    const arr = JSON.parse(s.slice(a, b + 1));
    if (!Array.isArray(arr)) return null;
    const out = arr.map((x) => ({ name: noDash(x && x.name).trim(), pitch: noDash(x && x.pitch).trim() })).filter((x) => x.name && x.pitch);
    return out.length ? out.slice(0, 3) : null;
  } catch {
    return null;
  }
}

export function brainstorm(seed, cfg) {
  const d = load();
  const s = String(seed || '').replace(/\s+/g, ' ').trim();
  if (!s) { const e = new Error('Write a seed first, e.g. a cosy co-op game for the TV.'); e.status = 400; throw e; }
  if (d.brainstorm) { const e = new Error('Claude is still working on the last seed.'); e.status = 409; throw e; }
  d.brainstorm = { seed: s, startedAt: now(), timeoutMs: cfg.claudeTimeoutMs };
  delete d.brainstormError;
  save(); changed();
  const existing = d.ideas.filter((x) => !x.archived).map((x) => `- ${x.name}: ${x.pitch}`).join('\n');
  const prompt = [
    'The user keeps an Ideas board for games and projects.',
    `Give exactly 3 distinct directions for this seed: "${s}".`,
    'Each one: a short evocative name (one or two words) and a one-sentence pitch that says what the player does and the hook. No em dashes.',
    existing ? `Avoid repeating what is already on the board:\n${existing}` : '',
    'Answer with ONLY a JSON array, no prose, no code fence: [{"name": "...", "pitch": "..."}, {"name": "...", "pitch": "..."}, {"name": "...", "pitch": "..."}]',
  ].filter(Boolean).join('\n\n');
  runClaude('#brainstorm', prompt, cfg, (r) => {
    const cur = load();
    delete cur.brainstorm;
    const dirs = r.ok ? parseDirections(r.text) : null;
    if (!dirs) {
      cur.brainstormError = r.ok ? 'Claude answered, but not with 3 directions the board could read. Try again.' : r.error;
    } else {
      const when = day(new Date());
      const made = dirs.map((x) => ({ id: newId(), name: x.name.slice(0, 80), stage: 'spark', pitch: x.pitch, status: `From the seed "${s}", ${when}.`, img: null, alt: null, thread: [], created: now(), updated: now() }));
      cur.ideas.unshift(...made);
      cur.lastBrainstorm = { seed: s, ids: made.map((x) => x.id), at: now() };
    }
    save(); changed();
  });
  return d.brainstorm;
}

export function clearBrainstormError() {
  const d = load();
  if (d.brainstormError) { delete d.brainstormError; save(); changed(); }
}

export function lastBrainstorm() {
  return load().lastBrainstorm || null;
}

// ------------------------------------------------------------ mockups
// docs/design/IdeaMockups.dc.html, variant A. it.mockups = { rounds: [{ n,
// at, note, from, picked, ms, usage, variants: [{ key, title, note }] }],
// job, error }. Pictures are <id>/mockups/r<N>-<key>.png in IDEAS_DIR; Pick
// makes one the card's cover (it.img) and a dropped picture stays in
// it.dropped, so it can be the cover again.

const LETTER = (k) => k.toUpperCase();
const shortPath = (p) => (p.startsWith(H) ? '~' + p.slice(H.length) : p);
const pngRel = (id, n, key) => `${id}/mockups/r${n}-${key}.png`;
const imgUrl = (rel) => `/api/ideas/img/${encodeURIComponent(rel)}`;

function roundLine(it, n) {
  const r = ((it.mockups && it.mockups.rounds) || []).find((x) => x.n === n);
  if (!r) return `Mockup round ${n}.`;
  const v = r.variants.find((x) => x.key === r.picked);
  return `Mockup round ${n}: ${r.variants.length} variants${r.note ? ', with your note' : ''}.${v ? ` Picked ${LETTER(v.key)}, ${v.title}.` : ''}`;
}

function roundContext(it, n) {
  const r = ((it.mockups && it.mockups.rounds) || []).find((x) => x.n === n);
  if (!r) return `Mockup round ${n}.`;
  const vs = r.variants.map((v) => `${LETTER(v.key)} "${v.title}" (${path.join(IDEAS_DIR, pngRel(it.id, n, v.key))})`).join(', ');
  const v = r.variants.find((x) => x.key === r.picked);
  return `Mockup round ${n}${r.note ? ` from their note "${r.note}"` : ''}: ${vs}.${v ? ` They picked ${LETTER(v.key)}.` : ''} Read the pictures if they help.`;
}

function mockupsView(x) {
  const m = x.mockups;
  if (!m) return null;
  return {
    rounds: (m.rounds || []).map((r) => ({
      n: r.n, at: r.at, note: r.note || '', picked: r.picked || null, ms: r.ms || null, model: r.model || null,
      tokens: r.usage ? { input: r.usage.input, output: r.usage.output } : null,
      variants: r.variants.map((v) => ({ key: v.key, title: v.title, note: v.note, img: imgUrl(pngRel(x.id, r.n, v.key)) })),
    })),
    job: m.job ? { round: m.job.round, startedAt: m.job.startedAt, timeoutMs: m.job.timeoutMs, note: m.job.note || '' } : null,
    error: m.error ? { round: m.error.round, text: m.error.text, note: m.error.note || '', from: m.error.from || null } : null,
    dropped: x.dropped && x.img !== x.dropped && picturePath(x.dropped) ? imgUrl(x.dropped) : null,
    folder: shortPath(mk.dir(IDEAS_DIR, x.id)),
  };
}

const fail = (msg, status) => { const e = new Error(msg); e.status = status; return e; };

// Starts a round. `from` = { round, key }: the variant it builds on (its
// HTML goes in the prompt with the note). Answers at once; the round lands
// over the change listeners.
export function startMockups(id, { note, from } = {}, cfg) {
  const it = find(id);
  if (it.pending) throw fail('Claude is still answering the last message. Mock it up when it is back.', 409);
  it.mockups = it.mockups || { rounds: [] };
  const m = it.mockups;
  if (m.job) throw fail(`Claude is still drawing round ${m.job.round}.`, 409);
  const n = m.rounds.length + 1;
  const text = noDash(note).replace(/\s+/g, ' ').trim().slice(0, 500);
  let base = null;
  if (from && from.round != null && from.key) {
    const r = m.rounds.find((x) => x.n === Number(from.round));
    const v = r && r.variants.find((x) => x.key === from.key);
    if (!v) throw fail('That variant is not there any more.', 400);
    let html = '';
    try { html = fs.readFileSync(path.join(mk.dir(IDEAS_DIR, id), `r${r.n}-${v.key}.html`), 'utf8'); } catch { throw fail('That variant\'s page is missing from the mockups folder.', 409); }
    base = { round: r.n, key: v.key, title: v.title, picked: r.picked === v.key, html };
  }
  const token = newId();
  m.job = { token, round: n, startedAt: now(), timeoutMs: cfg.claudeTimeoutMs, note: text, from: base ? { round: base.round, key: base.key } : null };
  delete m.error;
  it.updated = now();
  save(); changed();
  const thread = (it.thread || []).filter((x) => !x.error).map((x) => (x.mockupRound ? { who: 'Board', text: roundContext(it, x.mockupRound) } : { who: x.who === 'you' ? 'User' : 'Claude', text: x.text }));
  const promptText = mk.prompt({
    idea: { name: it.name, stageName: STAGES[it.stage], pitch: it.pitch, status: it.status },
    picturePath: it.img && !String(it.img).includes('/mockups/') ? path.join(IDEAS_DIR, it.img) : null,
    thread, from: base, note: text,
  });
  const t0 = Date.now();
  const current = () => { const cur = load().ideas.find((x) => x.id === id); return cur && cur.mockups && cur.mockups.job && cur.mockups.job.token === token ? cur : null; };
  const failed = (why) => {
    const cur = current();
    if (!cur) return;
    cur.mockups.error = { round: n, text: `Round ${n} did not come back: ${why}.${n > 1 ? ` Round ${n - 1} is kept.` : ''}`, note: text, from: cur.mockups.job.from };
    delete cur.mockups.job;
    cur.updated = now();
    console.log(`ideas: mockup round ${n} for ${cur.name} failed after ${mk.took(Date.now() - t0)}: ${why}`);
    save(); changed();
  };
  runClaude(id, promptText, cfg, async (r) => {
    if (!current()) return; // stopped
    if (!r.ok) return failed(/No answer after/.test(r.error) ? `Claude stopped at ${Math.round(cfg.claudeTimeoutMs / 60000) >= 1 ? Math.round(cfg.claudeTimeoutMs / 60000) + ' minutes' : Math.round(cfg.claudeTimeoutMs / 1000) + ' seconds'} without an answer` : r.error.replace(/\.$/, ''));
    const un = mk.unwrap(r.text);
    if (un.error) return failed(un.error.replace(/\.$/, ''));
    const vs = mk.parseVariants(un.text);
    if (!vs) return failed('Claude answered, but not with 3 pictures the board could read');
    const dir = mk.dir(IDEAS_DIR, id);
    let files;
    try {
      fs.mkdirSync(dir, { recursive: true });
      files = vs.map((v, k) => { const f = path.join(dir, `r${n}-${mk.KEYS[k]}.html`); fs.writeFileSync(f, v.html); return f; });
      await mk.render(files);
    } catch (e) {
      return failed(/need Playwright/.test(e.message) ? e.message : `the board could not draw the pictures (${String(e.message).split('\n')[0].slice(0, 160)})`);
    }
    const cur = current();
    if (!cur) { for (const f of files) { fs.rmSync(f, { force: true }); fs.rmSync(f.replace(/\.html$/, '.png'), { force: true }); } return; }
    const ms = Date.now() - t0;
    const round = { n, at: now(), note: text, from: cur.mockups.job.from, picked: null, ms, usage: un.usage, model: (un.usage && un.usage.model) || null, variants: vs.map((v, k) => ({ key: mk.KEYS[k], title: v.title, note: v.note })) };
    cur.mockups.rounds.push(round);
    delete cur.mockups.job;
    cur.thread = cur.thread || [];
    cur.thread.push({ who: 'board', mockupRound: n, at: now() });
    cur.updated = now();
    const u = un.usage;
    const log = { idea: cur.id, name: cur.name, round: n, at: round.at, ms, input: u ? u.input : null, output: u ? u.output : null, thinking: u ? u.thinking : null, turns: u ? u.turns : null, costUsd: u ? u.costUsd : null, model: round.model, note: text || null };
    try { fs.appendFileSync(path.join(dir, 'rounds.jsonl'), JSON.stringify(log) + '\n'); } catch { /* the folder went away */ }
    console.log(`ideas: mockup round ${n} for ${cur.name}: 3 variants in ${mk.took(ms)}, ${u ? `${u.input} tokens in, ${u.output} out (${u.thinking} thinking)${u.turns ? `, ${u.turns} turn${u.turns === 1 ? '' : 's'}` : ''}${u.costUsd != null ? `, $${u.costUsd.toFixed(3)}` : ''}` : 'no usage reported'}`);
    save(); changed();
  }, cfg.mockupCommand);
  return m.job;
}

export function stopMockups(id) {
  const it = find(id);
  const m = it.mockups;
  if (!m || !m.job) return false;
  const n = m.job.round;
  delete m.job;
  stop(id);
  it.updated = now();
  console.log(`ideas: mockup round ${n} for ${it.name} stopped`);
  save(); changed();
  return true;
}

// Pick: { round, key } makes that variant the cover; { dropped: true } puts
// the dropped picture back.
export function pickMockup(id, { round, key, dropped } = {}) {
  const it = find(id);
  if (dropped) {
    if (!it.dropped || !picturePath(it.dropped)) throw fail('There is no dropped picture to put back.', 409);
    it.img = it.dropped;
    it.alt = `${it.name}: the picture dropped on it`;
    it.updated = now();
    save(); changed();
    return it;
  }
  const r = ((it.mockups && it.mockups.rounds) || []).find((x) => x.n === Number(round));
  const v = r && r.variants.find((x) => x.key === key);
  if (!v) throw fail('That variant is not there any more.', 400);
  const rel = pngRel(id, r.n, v.key);
  if (!picturePath(rel)) throw fail('That picture is missing from the mockups folder.', 409);
  if (it.img && !String(it.img).includes('/mockups/') && !it.dropped) it.dropped = it.img;
  it.img = rel;
  it.alt = `${it.name}: mockup round ${r.n}, ${LETTER(v.key)}, ${v.title}`;
  r.picked = v.key;
  it.updated = now();
  save(); changed();
  return it;
}
