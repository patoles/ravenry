// The project registry: ~/.ravenry/projects.json (the data folder is
// chosen in home.mjs).
//
// A project is mapped to cmux workspace UUIDs EXPLICITLY, because folders
// are shared (two projects can run in one repo). On first run every
// cmux workspace becomes one project; later, new workspaces are appended and
// existing entries are never rewritten, so hand edits survive.

import fs from 'node:fs';
import path from 'node:path';
import { RAVENRY_HOME, SCRATCH_DATA, assertDataWrite, inRepoTmp, repoTmpPaths } from './home.mjs';
import { isBroadFolder } from './folders.mjs';

export { RAVENRY_HOME };
export const REGISTRY_PATH = path.join(RAVENRY_HOME, 'projects.json');

// A save may drop at most this many projects the file on disk holds. Nothing
// on the board removes a project (Hide sets "hidden"), so a save that loses
// more is a stale or foreign copy: a test's scratch registry overwrote
// a real board's 21 projects on 2026-11-03 and lost three of them.
export const MAX_DROP = 2;
// Structural backups (projects added or lost) kept next to the file.
const KEEP_STRUCTURE_BACKUPS = 30;

export const DEFAULT_SETTINGS = {
  // A finished turn counts as "needs you" for this long; after that it is idle.
  handbackHours: 36,
  // A finished turn that ends on a question stays "needs you" this long.
  questionHours: 24 * 14,
  // A transcript that changed this recently, mid-turn, counts as working.
  workingMinutes: 10,
  // A session with hook events but no screen to read, whose prompt event
  // and transcript have both been silent this long, is not working any more.
  eventWorkingHours: 3,
  contextWindow: 1000000,
  // Auto-append cmux workspaces that are not in the registry yet.
  autoImport: true,
  // The clean hand-off (docs/HANDOFF.md). false: no session is asked on its
  // own (the threshold and ceiling are ignored); Hand off now still works.
  handoffEnabled: true,
  // Percentages of contextWindow.
  handoffThreshold: 50,
  handoffCeiling: 70,
  // Open the fresh session by itself once the hand-off is written.
  handoffAutoStart: true,
  // What the fresh tab runs; the prompt is appended as one quoted argument.
  handoffCommand: 'claude',
  // Sessions page: no activity for this long lists a session as idle.
  idleHours: 24,
};

const NOTE = 'Edit freely. Each project lists the cmux workspace UUIDs it owns. "brief" is a path relative to "folder" (or absolute); null means no brief.';

function slug(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

// "✳ Agent-flow review" -> "Agent-flow review"; a shell title -> folder name.
export function nameFromWorkspace(ws, cwd) {
  let t = String(ws.title || '').trim().replace(/^[^\w\s…~/.]\s+/u, '');
  if (!t || /^[\w.-]+@[\w.-]+:/.test(t) || /^…\//.test(t)) t = cwd ? path.basename(cwd) : ws.ref;
  return t;
}

export function load() {
  try {
    const j = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    j.settings = { ...DEFAULT_SETTINGS, ...(j.settings || {}) };
    j.projects = Array.isArray(j.projects) ? j.projects : [];
    return j;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('registry: cannot read', REGISTRY_PATH, e.message);
    return null;
  }
}

// Why a registry may not be written to `file`, or null. `scratch` says the
// data folder is a test's (inside the repo's .tmp).
export function refuseSave(reg, onDisk, { file = REGISTRY_PATH, scratch = SCRATCH_DATA } = {}) {
  try { assertDataWrite(file); } catch (e) { return e.message.replace(/^Ravenry: /, ''); }
  if (!scratch) {
    const bad = repoTmpPaths(reg);
    if (bad.length) return `refused to write ${file}: it would hold ${bad.length} path(s) inside the repo's .tmp (a test's scratch data), first ${bad[0]}`;
  }
  if (onDisk && onDisk.unreadable) return `refused to write ${file}: it is there but cannot be read (${onDisk.unreadable}), so it is left as it is`;
  if (onDisk && Array.isArray(onDisk.projects)) {
    const now = new Set((reg.projects || []).map((p) => p && p.id));
    const lost = onDisk.projects.map((p) => p && p.id).filter((id) => id && !now.has(id));
    if (lost.length > MAX_DROP) return `refused to write ${file}: it would drop ${lost.length} projects at once (${lost.join(', ')}); at most ${MAX_DROP} may go in one save`;
  }
  return null;
}

// The file as it is on disk: null when missing, { unreadable } when it is
// there but not JSON (never overwritten: it may be a hand edit gone wrong).
function readDisk(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try { return JSON.parse(txt); } catch (e) { return { unreadable: e.message }; }
}

const stampOf = (now) => {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
};

// projects.json.bak-YYYYMMDD-HHMMSS-structure before any save that adds or
// loses a project, keeping the newest KEEP_STRUCTURE_BACKUPS of them.
function structureBackup(reg, onDisk, file) {
  if (!onDisk || !Array.isArray(onDisk.projects) || !fs.existsSync(file)) return null;
  const was = onDisk.projects.map((p) => p && p.id).sort().join('\n');
  const will = (reg.projects || []).map((p) => p && p.id).sort().join('\n');
  if (was === will) return null;
  let to = `${file}.bak-${stampOf(new Date())}-structure`;
  for (let k = 2; fs.existsSync(to); k++) to = `${file}.bak-${stampOf(new Date())}-structure-${k}`;
  fs.copyFileSync(file, to);
  const dir = path.dirname(file);
  const base = path.basename(file) + '.bak-';
  const old = fs.readdirSync(dir).filter((n) => n.startsWith(base) && /-structure(-\d+)?$/.test(n)).sort();
  for (const n of old.slice(0, Math.max(0, old.length - KEEP_STRUCTURE_BACKUPS))) fs.rmSync(path.join(dir, n), { force: true });
  return to;
}

// Every write of projects.json goes through here: refused (logged and thrown)
// when refuseSave says so, backed up first when projects come or go.
export function save(reg, { file = REGISTRY_PATH, scratch = SCRATCH_DATA } = {}) {
  const onDisk = readDisk(file);
  const why = refuseSave(reg, onDisk, { file, scratch });
  if (why) {
    console.error('registry:', why);
    const e = new Error(why);
    e.code = 'EREFUSED';
    throw e;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  structureBackup(reg, onDisk, file);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// The projects root a registry's setting names, unless it is a test's
// scratch folder and this is not a test's data folder.
export function settingRoot(settings, scratch = SCRATCH_DATA) {
  const r = (settings && settings.projectsRoot) || null;
  return r && !scratch && inRepoTmp(r) ? null : r;
}

// Adds a project for every cmux workspace no project claims yet.
// `cwdFor(ws)` returns the best folder guess for a workspace.
// `skip(ws)` leaves out a workspace the board itself is opening right now
// (New project, Revive), which registers it under its own project.
export function importWorkspaces(reg, workspaces, cwdFor, skip = () => false) {
  const first = !reg;
  // A new registry: the daily repeats detector (claude -p on the user's own
  // login) stays off until `ravenry setup` asks; a registry from before
  // this keeps its old default, on (server/config.mjs).
  if (!reg) reg = { version: 1, note: NOTE, settings: { ...DEFAULT_SETTINGS, repeatsAuto: false }, projects: [] };
  if (!first && reg.settings.autoImport === false) return { reg, added: [] };
  const claimed = new Set(reg.projects.flatMap((p) => p.workspaces || []));
  const ids = new Set(reg.projects.map((p) => p.id));
  // Workspaces that are not projects (the board's own "Ravenry"
  // workspace): list their UUIDs in the registry's "ignoreWorkspaces".
  const ignored = new Set(Array.isArray(reg.ignoreWorkspaces) ? reg.ignoreWorkspaces : []);
  const added = [];
  for (const ws of workspaces) {
    if (claimed.has(ws.id) || ignored.has(ws.id)) continue;
    if (/^mc-test/.test(ws.title)) continue; // the phase B scratch workspace
    if (skip(ws)) continue;
    // A workspace sitting in a too-broad folder (the projects root, home)
    // gets no folder: a project that took the projects folder had every
    // session under it.
    const at = cwdFor(ws);
    const envRoot = process.env.MC_PROJECTS_ROOT && (SCRATCH_DATA || !inRepoTmp(process.env.MC_PROJECTS_ROOT)) ? process.env.MC_PROJECTS_ROOT : null;
    const root = envRoot || settingRoot(reg.settings);
    const cwd = at && !isBroadFolder(at, reg.projects, root) && (SCRATCH_DATA || !inRepoTmp(at)) ? at : null;
    const name = nameFromWorkspace(ws, cwd);
    let id = slug(name);
    for (let k = 2; ids.has(id); k++) id = slug(name) + '-' + k;
    ids.add(id);
    const p = { id, name, folder: cwd || null, workspaces: [ws.id], brief: cwd ? 'BRIEF.md' : null, waitingOn: null, imported: new Date().toISOString() };
    reg.projects.push(p);
    added.push(p);
  }
  // A shared folder cannot hold one BRIEF.md per project, so a project that
  // shares its folder gets no brief by default (set "brief" by hand).
  if (added.length) {
    const byFolder = new Map();
    for (const p of reg.projects) if (p.folder) byFolder.set(p.folder, (byFolder.get(p.folder) || 0) + 1);
    for (const p of added) if (p.folder && byFolder.get(p.folder) > 1) p.brief = null;
  }
  if (first) { save(reg); return { reg, added }; }
  if (!added.length) return { reg, added };
  // Only the new projects are written, onto the file as it is on disk: the
  // board keeps its registry in memory from start-up, and saving that copy
  // whole wrote back whatever it had loaded (a test's registry, or the file
  // before a hand edit or a restore).
  const merged = update((raw) => {
    const have = new Set(raw.projects.flatMap((p) => p.workspaces || []));
    for (const p of added) {
      if ((p.workspaces || []).some((w) => have.has(w))) continue;
      if (raw.projects.some((x) => x.id === p.id)) p.id = uniqueId(raw, p.name);
      raw.projects.push(p);
    }
  });
  return { reg: merged || reg, added };
}

// Which other projects share this project's folder.
export function sharedWith(reg, project) {
  if (!project.folder) return [];
  return reg.projects.filter((p) => p !== project && p.folder === project.folder && !p.hidden).map((p) => p.name);
}

export function briefPath(project) {
  if (!project.brief) return null;
  // An absolute brief (~/.ravenry/briefs/<id>.md) needs no folder: an idea
  // with no repo keeps its brief.
  if (path.isAbsolute(project.brief)) return project.brief;
  return project.folder ? path.join(project.folder, project.brief) : null;
}

// Read the registry from disk, change it, write it back. Reading first keeps
// any hand edit made while the board was running.
// The settings stay as written (defaults are filled in only in memory).
export function update(fn) {
  let raw;
  // A file that is there but cannot be read is never replaced by an empty
  // registry: only a missing one starts fresh.
  try { raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`registry: cannot read ${REGISTRY_PATH} (${e.message}), so it is left as it is`);
    raw = { version: 1, note: NOTE, settings: { repeatsAuto: false }, projects: [] };
  }
  raw.projects = Array.isArray(raw.projects) ? raw.projects : [];
  fn(raw);
  save(raw);
  return load();
}

// Add to a project (docs/design/CodexStage2.dc.html, section 1): a cmux
// workspace no project lists joins one project's workspaces, through the
// registry's write path (a backup at most once per burst, then update(),
// so hand edits made meanwhile survive). Refused when the project is gone or
// hidden, or when some project, or ignoreWorkspaces, lists the workspace by
// the time of the write. Returns { ok, reg, project, backup } or
// { ok: false, status, error }.
export function addWorkspace(projectId, workspaceId) {
  const wid = String(workspaceId || '');
  if (!wid) return { ok: false, status: 400, error: 'Name the workspace to add.' };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); } catch (e) { return { ok: false, status: 500, error: `Could not read ${path.basename(REGISTRY_PATH)} (${e.code === 'ENOENT' ? 'it is not there' : e.message})` }; }
  const projects = Array.isArray(raw.projects) ? raw.projects : [];
  const target = projects.find((p) => p && p.id === projectId && !p.hidden);
  if (!target) return { ok: false, status: 404, error: 'No such project.' };
  const owner = projects.find((p) => p && (p.workspaces || []).includes(wid));
  if (owner) return { ok: false, status: 409, error: `${owner.name || owner.id} lists that workspace already.` };
  if ((raw.ignoreWorkspaces || []).includes(wid)) return { ok: false, status: 409, error: 'That workspace is in ignoreWorkspaces, so it is not added.' };
  let backup = null;
  let r;
  try {
    backup = backupRegistry();
    r = update((reg) => {
      const p = reg.projects.find((x) => x && x.id === projectId);
      if (p && !(p.workspaces || []).includes(wid)) p.workspaces = [...(p.workspaces || []), wid];
    });
  } catch (e) {
    const why = { EACCES: 'permission denied', EPERM: 'permission denied', EROFS: 'the disk is read-only', ENOSPC: 'the disk is full' }[e.code] || e.message;
    return { ok: false, status: e.code === 'EREFUSED' ? 409 : 500, error: `Could not write ${path.basename(REGISTRY_PATH)} (${why})` };
  }
  return { ok: true, reg: r, project: { id: target.id, name: target.name }, backup };
}

export function uniqueId(reg, name) {
  const ids = new Set(reg.projects.map((p) => p.id));
  const base = slug(name);
  let id = base;
  for (let k = 2; ids.has(id); k++) id = base + '-' + k;
  return id;
}

// ------------------------------------------------------------ hand-off settings
// The board's Settings card (docs/design/HandoffSettings.dc.html, variant A)
// reads and writes these keys, and only these.

export const HANDOFF_KEYS = ['handoffEnabled', 'handoffThreshold', 'handoffCeiling', 'contextWindow', 'handoffAutoStart'];
export const HANDOFF_MIN = 10;
export const HANDOFF_MAX = 95;
// The ceiling stays at least this many points above the threshold.
export const HANDOFF_GAP = 5;
export const CONTEXT_WINDOWS = [200000, 1000000];

export function handoffSettings(settings) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  return {
    handoffEnabled: s.handoffEnabled !== false,
    handoffThreshold: Number(s.handoffThreshold),
    handoffCeiling: Number(s.handoffCeiling),
    contextWindow: Number(s.contextWindow),
    handoffAutoStart: s.handoffAutoStart !== false,
  };
}

// A patch of hand-off keys, checked against the stored values it lands on.
// Returns null when it is fine, else the reason.
export function checkHandoffPatch(patch, current) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'Send an object of hand-off settings.';
  const keys = Object.keys(patch);
  if (!keys.length) return 'Nothing to change.';
  const unknown = keys.filter((k) => !HANDOFF_KEYS.includes(k));
  if (unknown.length) return `Not a setting the board changes: ${unknown.join(', ')}.`;
  for (const k of ['handoffEnabled', 'handoffAutoStart']) {
    if (k in patch && typeof patch[k] !== 'boolean') return `${k} must be true or false.`;
  }
  for (const k of ['handoffThreshold', 'handoffCeiling']) {
    if (k in patch && !(Number.isInteger(patch[k]) && patch[k] >= HANDOFF_MIN && patch[k] <= HANDOFF_MAX)) return `${k} must be a whole number from ${HANDOFF_MIN} to ${HANDOFF_MAX}.`;
  }
  if ('contextWindow' in patch && !CONTEXT_WINDOWS.includes(patch.contextWindow)) return `contextWindow must be ${CONTEXT_WINDOWS.join(' or ')}.`;
  const next = { ...handoffSettings(current), ...patch };
  if (next.handoffCeiling - next.handoffThreshold < HANDOFF_GAP) return `The ceiling (${next.handoffCeiling}%) must stay at least ${HANDOFF_GAP} points above the clean-point line (${next.handoffThreshold}%).`;
  return null;
}

// ------------------------------------------------------------ assistant settings
// Which assistant the board starts (docs/ASSISTANTS.md, "Starting
// sessions"): `startWith` ('claude' | 'codex', Claude Code when unset) and
// `codexModel`, the model Codex runs when the one in its config.toml is
// refused (empty: Codex's own default). A project may name its own
// `assistant` (the New project form's choice).

export const ASSISTANT_KEYS = ['startWith', 'codexModel'];
export const ASSISTANT_KINDS = ['claude', 'codex'];
const MODEL_NAME = /^[A-Za-z0-9][\w.:-]{0,79}$/;

// The assistant a project names for itself, or null (then startWith, else
// Claude Code; never its newest session's).
export const projectAssistant = (project) => (project && ASSISTANT_KINDS.includes(project.assistant) ? project.assistant : null);

export function assistantSettings(settings) {
  const s = settings || {};
  return {
    startWith: ASSISTANT_KINDS.includes(s.startWith) ? s.startWith : 'claude',
    codexModel: typeof s.codexModel === 'string' && MODEL_NAME.test(s.codexModel) ? s.codexModel : null,
  };
}

// A patch of assistant keys: null when it is fine, else the reason. A
// codexModel of null or '' clears it.
export function checkAssistantPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'Send an object of assistant settings.';
  const keys = Object.keys(patch);
  if (!keys.length) return 'Nothing to change.';
  const unknown = keys.filter((k) => !ASSISTANT_KEYS.includes(k));
  if (unknown.length) return `Not a setting the board changes: ${unknown.join(', ')}.`;
  if ('startWith' in patch && !ASSISTANT_KINDS.includes(patch.startWith)) return `startWith must be ${ASSISTANT_KINDS.join(' or ')}.`;
  if ('codexModel' in patch && patch.codexModel != null && patch.codexModel !== '' && !(typeof patch.codexModel === 'string' && MODEL_NAME.test(patch.codexModel))) return 'codexModel must be a model name like gpt-5.6-luna, or empty.';
  return null;
}

// Validates, backs up, then writes only the patched keys (writeSettings).
export function saveAssistantSettings(patch) {
  const why = checkAssistantPatch(patch);
  if (why) return { ok: false, status: 400, error: why };
  const p = { ...patch };
  if ('codexModel' in p && (p.codexModel == null || p.codexModel === '')) p.codexModel = undefined;
  const w = writeSettings(p);
  if (!w.ok) return w;
  return { ok: true, settings: assistantSettings(w.reg && w.reg.settings), backup: w.backup, reg: w.reg };
}

// Sets the assistant a project names for itself ('claude' or 'codex'), or
// clears it (null: startWith, else Claude Code). Its next New
// session, Revive and plan start use it; running sessions are not touched.
// The same write path as the settings: a backup (at most one per burst),
// then only that key of that project, through update().
// Returns { ok, project, assistant, backup, reg } or { ok: false, status, error }.
export function saveProjectAssistant(projectId, assistant) {
  if (assistant !== null && !ASSISTANT_KINDS.includes(assistant)) return { ok: false, status: 400, error: `assistant must be ${ASSISTANT_KINDS.join(' or ')}, or null to follow Settings.` };
  const cur = load();
  if (!cur || !cur.projects.some((p) => p && p.id === projectId)) return { ok: false, status: 404, error: 'No such project.' };
  let backup = null;
  let r;
  try {
    backup = backupRegistry();
    r = update((reg) => {
      const p = reg.projects.find((x) => x && x.id === projectId);
      if (!p) { const e = new Error('No such project.'); e.status = 404; throw e; }
      if (assistant === null) delete p.assistant;
      else p.assistant = assistant;
    });
  } catch (e) {
    if (e.status === 404) return { ok: false, status: 404, error: e.message };
    const why = { EACCES: 'permission denied', EPERM: 'permission denied', EROFS: 'the disk is read-only', ENOSPC: 'the disk is full' }[e.code] || e.message;
    return { ok: false, status: 500, error: `Could not write ${path.basename(REGISTRY_PATH)} (${why})` };
  }
  const project = r.projects.find((x) => x && x.id === projectId) || null;
  return { ok: true, project, assistant: projectAssistant(project), backup, reg: r };
}

// projects.json.bak-YYYYMMDD-HHMMSS next to it, local time, the name the
// hand-made backups already use. One per burst of changes: a backup at most
// every 10 minutes, so it holds the settings from before a round of clicks
// rather than one file per click.
const BACKUP_EVERY_MS = 10 * 60 * 1000;
let lastBackupAt = 0;
function backupRegistry(now = new Date()) {
  if (Date.now() - lastBackupAt < BACKUP_EVERY_MS || !fs.existsSync(REGISTRY_PATH)) return null;
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  let to = `${REGISTRY_PATH}.bak-${stamp}`;
  for (let k = 2; fs.existsSync(to); k++) to = `${REGISTRY_PATH}.bak-${stamp}-${k}`;
  fs.copyFileSync(REGISTRY_PATH, to);
  lastBackupAt = Date.now();
  return to;
}

// Validates, backs up, then writes only the patched keys through update().
// Returns { ok, settings, backup } or { ok: false, status, error }.
export function saveHandoffSettings(patch) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') return { ok: false, status: 500, error: `Could not read ${REGISTRY_PATH}: ${e.message}` };
    raw = {};
  }
  const why = checkHandoffPatch(patch, raw.settings);
  if (why) return { ok: false, status: 400, error: why };
  const w = writeSettings(patch);
  if (!w.ok) return w;
  return { ok: true, settings: handoffSettings(w.reg && w.reg.settings), backup: w.backup, reg: w.reg };
}

// The registry write path for settings the board changes: a backup (at most
// one per burst, above), then only the patched keys written through
// update(), so hand edits made meanwhile survive. Keys set to undefined are
// removed. Returns { ok, reg, backup } or { ok: false, status, error }.
export function writeSettings(patch) {
  let backup = null;
  let r;
  try {
    backup = backupRegistry();
    r = update((reg) => {
      reg.settings = reg.settings && typeof reg.settings === 'object' ? reg.settings : {};
      for (const k of Object.keys(patch)) {
        if (patch[k] === undefined) delete reg.settings[k];
        else reg.settings[k] = patch[k];
      }
    });
  } catch (e) {
    const why = { EACCES: 'permission denied', EPERM: 'permission denied', EROFS: 'the disk is read-only', ENOSPC: 'the disk is full' }[e.code] || e.message;
    return { ok: false, status: 500, error: `Could not write ${path.basename(REGISTRY_PATH)} (${why})` };
  }
  return { ok: true, reg: r, backup };
}

export { slug };
