// The clean context hand-off, shared by the Stop hook (hooks/handoff-stop.mjs)
// and the board. Node built-ins only, because the hook runs on every stop of
// every Claude session and must start fast. The whole loop is written up in
// docs/HANDOFF.md.
//
// One marker per Claude session: <RAVENRY_HOME>/handoffs/<session_id>.json.
// States, in order: queued -> requested -> written -> resumed.
//   queued     past the hand-off line (or the user pressed "Hand off now"), and
//              the last stop was not a clean point the hook could see.
//   requested  the hook blocked a stop and asked Claude to hand off.
//   written    the Hand-off section of the brief (or HANDOFF.md) changed
//              after the request.
//   resumed    the board opened a fresh session in the same workspace.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { RAVENRY_HOME, REGISTRY_PATH, DEFAULT_SETTINGS } from './registry.mjs';
import { sessionFolder, ownerOf, isBroadFolder } from './folders.mjs';

export const HANDOFF_DIR = path.join(RAVENRY_HOME, 'handoffs');
// Starts every reason the hook gives Claude, so the board can tell the
// hook's words from the user's in a transcript. OLD_TAGS are the tags it used
// before (Mission Control, the board's name before Ravenry): transcripts of
// sessions asked under that name still hold them.
export const TAG = '[ravenry hand-off]';
export const OLD_TAGS = ['[mission-control hand-off]'];
export const ALL_TAGS = [TAG, ...OLD_TAGS];
export const hasTag = (text) => ALL_TAGS.some((t) => String(text || '').includes(t));
// The one line Claude answers with when it is not at a clean point. The
// board skips it when it reads the transcript, so a question Claude ended
// on stays the last thing on the card.
export const DEFERRED = 'Hand-off deferred: not at a clean point.';
export const STATES = ['queued', 'requested', 'written', 'resumed'];

// ------------------------------------------------------------ settings

export function loadSettings() {
  try {
    const j = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    return { settings: { ...DEFAULT_SETTINGS, ...(j.settings || {}) }, projects: Array.isArray(j.projects) ? j.projects : [] };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, projects: [] };
  }
}

// ------------------------------------------------------------ markers

const SAFE_ID = /^[A-Za-z0-9_-]{6,80}$/;

export function markerPath(sessionId) {
  if (!SAFE_ID.test(String(sessionId || ''))) return null;
  return path.join(HANDOFF_DIR, sessionId + '.json');
}

export function readMarker(sessionId) {
  const p = markerPath(sessionId);
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Writes atomically and records every state change in `history`.
export function writeMarker(sessionId, next) {
  const p = markerPath(sessionId);
  if (!p) throw new Error('bad session id');
  fs.mkdirSync(HANDOFF_DIR, { recursive: true });
  const prev = readMarker(sessionId);
  const now = new Date().toISOString();
  const m = { ...(prev || {}), ...next, sessionId, updatedAt: now };
  m.history = Array.isArray(prev && prev.history) ? prev.history.slice(-30) : [];
  if (!prev || prev.state !== m.state) m.history.push({ state: m.state, at: now });
  const tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
  fs.renameSync(tmp, p);
  return m;
}

export function listMarkers() {
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(HANDOFF_DIR); } catch { return out; }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(HANDOFF_DIR, f), 'utf8'));
      if (m && m.sessionId) out.set(m.sessionId, m);
    } catch { /* half-written or hand-edited: skip */ }
  }
  return out;
}

export function stateRank(s) {
  return STATES.indexOf(s);
}

// ------------------------------------------------------------ context

// Context in use, from the last assistant record with `usage`, reading the
// transcript from its end in growing chunks (they reach 100 MB).
export function lastUsage(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const { size } = fs.fstatSync(fd);
    let text = null;
    for (const want of [64 * 1024, 512 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024]) {
      const start = Math.max(0, size - want);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift();
      let usage = null; let model = null; let lastText = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        if (!l.includes('"assistant"')) continue;
        let rec;
        try { rec = JSON.parse(l); } catch { continue; }
        if (rec.type !== 'assistant' || rec.isSidechain || !rec.message) continue;
        if (lastText == null && Array.isArray(rec.message.content)) {
          const t = rec.message.content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('\n').trim();
          if (t) lastText = t;
        }
        if (rec.message.usage && rec.message.model !== '<synthetic>') { usage = rec.message.usage; model = rec.message.model || null; break; }
      }
      if (usage) {
        const tokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
        return { tokens, model, lastText };
      }
      text = lines;
      if (start === 0) break;
    }
    return text ? { tokens: null, model: null, lastText: null } : null;
  } finally {
    fs.closeSync(fd);
  }
}

// ------------------------------------------------------------ the hand-off file

// The text of the "## Hand-off" section of a brief, or the whole file for a
// HANDOFF.md. null when the file or the section is missing.
export function handoffText(file) {
  let md;
  try { md = fs.readFileSync(file, 'utf8'); } catch { return null; }
  if (!isBriefFile(file)) return md.trim() || null;
  const lines = md.replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => /^##\s+(hand-?\s?off)\s*:?\s*$/i.test(l.trim()));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i]) || /^#\s/.test(lines[i])) { end = i; break; }
  return lines.slice(start + 1, end).join('\n').trim() || null;
}

export function handoffHash(file) {
  const t = handoffText(file);
  return t == null ? null : crypto.createHash('sha1').update(t).digest('hex');
}

// Written = the section exists now and is not what it was at the request.
export function handoffWritten(marker) {
  if (!marker || !marker.handoffFile) return false;
  const h = handoffHash(marker.handoffFile);
  return h != null && h !== (marker.handoffBase ?? null);
}

// A hand-off written while the marker was still queued: the session wrote
// one on its own, or the user asked it to by hand, before any stop was a clean
// point. handoffWritten() cannot see it, because the hook takes a fresh
// base at every queued stop, so the next stop after the write swallows the
// change. Two things together say it is this session's hand-off: the
// section's newest bullet is dated at or after the minute it was queued,
// and this session's own transcript wrote to the hand-off file since then
// (another session past the line on the same brief did not).
export function writtenWhileQueued(marker, transcriptPath) {
  if (!marker || marker.state !== 'queued' || !marker.handoffFile || !marker.queuedAt) return false;
  const top = newestBulletAt(handoffText(marker.handoffFile));
  const since = Date.parse(marker.queuedAt);
  if (top == null || isNaN(since) || top < Math.floor(since / 60000) * 60000) return false;
  return wroteFile(transcriptPath, marker.handoffFile, marker.queuedAt, marker.cwd);
}

// The time of the section's newest bullet, "- YYYY-MM-DD HH:MM ...", read
// as local time (the hand-off line asks for the clock the user reads).
export function newestBulletAt(text) {
  let best = null;
  for (const m of String(text || '').matchAll(/^\s*-\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/gm)) {
    const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
    if (best == null || t > best) best = t;
  }
  return best;
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']);

// Did this session (not a subagent) call a tool that writes, naming the
// file, at or after `sinceIso`? Reads the transcript's last 64 MB.
export function wroteFile(transcriptPath, file, sinceIso, cwd) {
  if (!transcriptPath || !file) return false;
  let fd;
  try { fd = fs.openSync(transcriptPath, 'r'); } catch { return false; }
  let text;
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - 64 * 1024 * 1024);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    text = buf.toString('utf8');
  } catch { return false; } finally { fs.closeSync(fd); }
  const names = [file];
  if (cwd) { const rel = path.relative(cwd, file); if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) names.push(rel); }
  const since = Date.parse(sinceIso) || 0;
  const base = path.basename(file);
  for (let i = text.indexOf(base); i >= 0; i = text.indexOf(base, i + base.length)) {
    const a = text.lastIndexOf('\n', i) + 1;
    let b = text.indexOf('\n', i); if (b < 0) b = text.length;
    const line = text.slice(a, b);
    i = b;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== 'assistant' || rec.isSidechain || !rec.message || !Array.isArray(rec.message.content)) continue;
    if ((Date.parse(rec.timestamp) || 0) < since) continue;
    for (const c of rec.message.content) {
      if (!c || c.type !== 'tool_use' || !WRITE_TOOLS.has(c.name)) continue;
      const input = JSON.stringify(c.input || {});
      if (names.some((n) => input.includes(JSON.stringify(n).slice(1, -1)))) return true;
    }
  }
  return false;
}

// The first thing typed into a session, from the head of its transcript: a
// session the hand-off opened starts with "Read the Hand-off section of".
export function firstPrompt(transcriptPath) {
  let fd;
  try { fd = fs.openSync(transcriptPath, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.slice(0, n).toString('utf8').split('\n')) {
      if (!line.includes('"user"')) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.type !== 'user' || rec.isMeta || rec.isSidechain || !rec.message) continue;
      const c = rec.message.content;
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n') : '';
      if (t && !t.startsWith('<')) return t;
    }
    return null;
  } catch { return null; } finally { fs.closeSync(fd); }
}

export const isResumePrompt = (t) => /^Read the Hand-off section of /.test(String(t || ''));

function gitRoot(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// A hand-off file is the whole file for HANDOFF.md / HANDOFF-<id>.md, and
// the "## Hand-off" section of anything else: the project's brief, wherever
// the registry's "brief" points (~/.ravenry/briefs/<id>.md too).
export function isBriefFile(file) {
  return !!file && !/^HANDOFF/i.test(path.basename(file));
}

// Where this session's hand-off goes. The project's own brief when it has
// one, otherwise HANDOFF.md at the repo root (HANDOFF-<project>.md when two
// projects share that folder, so they cannot overwrite each other).
// The project: the one the board names (projectId), else the one this tab
// belongs to among the projects listing its workspace (by "surfaces", then
// by the repo the session's tool calls work in), else by folder.
export function resolveHandoffFile({ cwd, workspaceId, surfaceId, transcriptPath, projectId, projects, root = null }) {
  const live = (projects || []).filter((p) => !p.hidden);
  let project = projectId ? live.find((p) => p.id === projectId) || null : null;
  if (!project && workspaceId) {
    const owners = live.filter((p) => (p.workspaces || []).includes(workspaceId));
    const real = owners.length > 1 && transcriptPath ? sessionFolder(transcriptPath) : null;
    project = ownerOf(owners, surfaceId, real && real.folder, null, { projects: live, root });
  }
  if (!project && cwd) {
    // A too-broad folder (the projects root, home) never claims a session by folder.
    const under = live.filter((p) => p.folder && !isBroadFolder(p.folder, live, root) && isInside(cwd, p.folder)).sort((a, b) => b.folder.length - a.folder.length);
    if (under.length && (under.length === 1 || under[0].folder !== under[1].folder)) project = under[0];
  }
  if (project && project.brief && (project.folder || path.isAbsolute(project.brief))) {
    const b = path.isAbsolute(project.brief) ? project.brief : path.join(project.folder, project.brief);
    if (fs.existsSync(b)) return { file: b, projectId: project.id, folder: project.folder || null };
  }
  let base = (cwd && gitRoot(cwd)) || cwd || (project && project.folder) || null;
  // Never a HANDOFF.md dropped into the projects root or the home folder.
  if (base && isBroadFolder(base, live, root)) base = null;
  if (!base) return { file: null, projectId: project ? project.id : null, folder: null };
  const sharers = live.filter((p) => p.folder && path.resolve(p.folder) === path.resolve(base));
  const shared = sharers.length > 1;
  if (!shared && fs.existsSync(path.join(base, 'BRIEF.md'))) return { file: path.join(base, 'BRIEF.md'), projectId: project ? project.id : null, folder: base };
  const name = shared && project ? `HANDOFF-${project.id}.md` : 'HANDOFF.md';
  return { file: path.join(base, name), projectId: project ? project.id : null, folder: base };
}

// The marker fields for a resolved target. The file and the hash of its
// Hand-off section always travel together, so handoffWritten() never
// compares one file's section against another file's base.
export function targetFields(target) {
  const file = (target && target.file) || null;
  return { handoffFile: file, handoffBase: handoffHash(file), projectId: (target && target.projectId) || null, folder: (target && target.folder) || null };
}

// ------------------------------------------------------------ clean point

// Does the last paragraph ask something? Then Claude is waiting on the user,
// which is not a clean point: the question must stay on screen.
export function endsOnQuestion(text) {
  const ps = String(text || '').trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (!ps.length) return false;
  const last = ps[ps.length - 1].replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  return /\?["')\]*_]*\s*$/m.test(last) || /\?\s+[A-Z]/.test(last);
}

// Which background tasks are still running: server/tasks.mjs, shared with
// the events hook. It reads the session's transcript too, because Claude
// Code can keep a finished task listed as running.
export { runningTasks } from './tasks.mjs';

// ------------------------------------------------------------ the words

function k(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M' : Math.round(n / 1000) + 'k';
}

export function reasonText({ pct, tokens, window, threshold, ceiling, manual, file, autoStart }) {
  const where = file ? file : 'HANDOFF.md at the repo root';
  const isBrief = isBriefFile(file);
  const used = tokens != null ? `${Math.round(pct)}% (${k(tokens)} of ${k(window)})` : 'unknown';
  const over = pct != null && pct >= ceiling;
  const lines = [TAG];
  if (over) {
    lines.push(`Context is at ${used}, past the ${ceiling}% ceiling. Hand off now rather than let Claude Code compact this session.`);
    lines.push('Do not start the next step. If a step is half done, finish only that step (or stop where it is safe), then hand off. A work-in-progress commit is fine; say so in its message.');
  } else {
    if (manual) lines.push(`The user asked for a hand-off from Ravenry, with context at ${used}. Do it at a clean point.`);
    else lines.push(`Context is at ${used}, past the ${threshold}% hand-off line. Hand off to a fresh session, but only at a clean point.`);
    lines.push(`If you are in the middle of a task, have background agents, tests or jobs still running, or are waiting on the user's answer, do not hand off yet: reply with exactly this one line and nothing else, then carry on as before: ${DEFERRED} The hook asks again at a later stop.`);
    lines.push('Otherwise you are at a clean point. Hand off:');
  }
  lines.push(
    `1. Write the hand-off for a fresh session that has none of this context. ${isBrief
      ? `In ${where}, add a new bullet at the top of the "## Hand-off" section (create the section if it is missing):`
      : `Create or replace ${where} with a "## Hand-off" section holding one bullet:`} "- YYYY-MM-DD HH:MM <one line: what this session finished and where the next starts>", with indented sub-bullets "State:", "Next step:", "Open items:" and "Key files:" (absolute paths). ${isBrief ? 'Update "## Next step" too if the brief has one. ' : ''}Keep the project's writing rules (no em dashes).`,
    file && isInside(path.resolve(file), path.resolve(RAVENRY_HOME))
      ? `2. Commit your work, by pathspec if other agents share this tree, with a message that explains the cause. Do not push. The brief lives in ${RAVENRY_HOME}, outside the repo, so it is saved but not committed.`
      : '2. Commit your work and the hand-off together, by pathspec if other agents share this tree, with a message that explains the cause. Do not push.',
    `3. Reply to the user with one line: Hand-off written to ${where}.`,
    autoStart
      ? 'Ravenry then opens a fresh Claude session in a new tab next to this one that reads it and carries on. Do not open or close any session yourself, and do nothing after that line.'
      : 'The user starts the fresh session from Ravenry. Do not open or close any session yourself, and do nothing after that line.',
  );
  return lines.join('\n');
}
