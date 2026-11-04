// New project, Write the brief, and Revive: the three ways the board starts
// work. Each writes a BRIEF.md in the format of docs/BRIEF-FORMAT.md and, for
// New project and Revive, opens a NEW cmux workspace or tab running Claude,
// or a NEW iTerm2 tab when the board runs in iTerm2 mode (term.BOARD).
// Nothing here ever types into, selects or closes an existing tab.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';

import * as term from './terminal.mjs';

const { cmux } = term;
import * as registry from './registry.mjs';
import { RAVENRY_HOME } from './home.mjs';

const HOME = os.homedir();
const short = (p) => (p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);
const clean = (s) => String(s ?? '').replace(/—/g, ', ').replace(/\r/g, '').trim();
const oneLine = (s) => clean(s).replace(/\s*\n\s*/g, ' ');
const lines = (s) => clean(s).split('\n').map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim()).filter(Boolean);

export const KINDS = ['Web game', 'VR', 'Unity', 'Unreal', 'App', 'Website', 'Tool or CLI', 'Research', 'Something else'];

// The kind is free text: the words typed win, else the chip.
export function kindOf(form) {
  const own = oneLine(form.kindText);
  if (own) return own;
  return oneLine(form.kind) || null;
}

export function briefMarkdown(form, { stage } = {}) {
  const name = oneLine(form.name);
  const out = [`# ${name}`, ''];
  const goal = oneLine(form.goal);
  const done = oneLine(form.doneMeans);
  const kind = kindOf(form);
  if (goal) out.push(`Goal: ${goal}`);
  if (done) out.push(`Done means: ${done}`);
  if (kind) out.push(`Kind: ${kind}`);
  if (stage) out.push(`Stage: ${stage}`);
  out.push('');
  const rules = lines(form.rules);
  out.push('## Rules');
  for (const r of rules) out.push(`- ${r}`);
  out.push('');
  const ms = lines(form.milestones);
  out.push('## Plan');
  // Each milestone is an objective; the agent breaks it into tasks.
  for (const m of ms) out.push(`### ${m}`);
  out.push('');
  out.push('## Next step');
  out.push(ms.length ? `Break "${ms[0]}" into tasks and start on it.` : 'Write the first milestone.');
  out.push('');
  out.push('## Hand-off');
  out.push('');
  out.push('## Notes');
  out.push('');
  return out.join('\n');
}

function validate(form) {
  const name = oneLine(form.name);
  if (!name) return 'Give it a name first.';
  if (name.length > 80) return 'Keep the name under 80 characters.';
  if (!oneLine(form.goal)) return 'Write the goal: one or two sentences.';
  return null;
}

// A prompt goes to cmux as one quoted shell word. cmux reads backslash
// escapes in --command, so the quoting never uses a backslash.
export function quoteWord(s) {
  const t = String(s);
  if (!t.includes("'")) return `'${t}'`;
  if (!/["$`\\!]/.test(t)) return `"${t}"`;
  return `'${t.replace(/'/g, '')}'`;
}

function launchLine(cfg, prompt) {
  return `${cfg.launchCommand} ${quoteWord(prompt)}`;
}

// Opens a NEW workspace and returns its UUID (cmux prints only the ref, and
// refs can move, so it is resolved at once).
async function openWorkspace({ name, cwd, command, focus }) {
  const r = await cmux.newWorkspace({ name, cwd, command, focus });
  if (!r.ok) return { ok: false, error: 'cmux did not open a workspace: ' + (r.err || r.out || 'no answer') };
  const ref = (r.out.match(/workspace:\d+/) || [])[0];
  for (let i = 0; i < 10; i++) {
    const all = await cmux.listWorkspaces();
    const ws = all.find((w) => w.ref === ref && (w.title === name || !name)) || all.find((w) => w.ref === ref);
    if (ws) return { ok: true, workspaceId: ws.id, workspaceRef: ws.ref };
    await new Promise((res) => setTimeout(res, 250));
  }
  return { ok: false, error: `cmux opened ${ref || 'a workspace'} but it did not show in its tree.` };
}

// A shell word for a typed command: single quotes, a quote inside closed,
// escaped and reopened. (The iTerm2 tab runs a login shell; nothing here
// passes through cmux's --command, so a backslash is fine.)
export function shellWord(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// iTerm2 mode: a NEW tab (in the window of `near`, a session of the
// project, when it is open, else iTerm2's current window, else a new
// window) that goes to the folder and runs the command. Returns
// { ok, surfaceId, surfaceRef, where } or { ok: false, error }.
async function openBoardTab({ cwd, command, near = null }) {
  const kind = term.BOARD;
  const name = term.nameOf(kind);
  const made = await term.openTab(kind, { near });
  if (!made.ok) return { ok: false, error: `${name} did not open a tab: ` + (made.err || 'no answer') };
  await new Promise((r) => setTimeout(r, 900)); // let the shell draw its prompt
  const tab = { kind, surfaceId: made.surfaceId };
  const a = await term.pasteText(tab, `cd ${shellWord(cwd)} && ${command}`);
  const b = a.ok ? await term.pressKey(tab, 'enter') : a;
  if (!b.ok) return { ok: false, error: 'the new tab opened but the command was not typed: ' + (b.err || '') };
  return { ok: true, surfaceId: made.surfaceId, surfaceRef: made.surfaceRef, where: name };
}

function gitInit(dir) {
  execFileSync('git', ['init', '-q', dir], { timeout: 8000 });
}

// ------------------------------------------------------------ Existing folder
// New project can start in a folder that is already there: one the board
// knows (another project's), or one Finder's own dialog returned. Only a
// real directory inside the home folder is accepted, symlinks resolved, and
// never the home folder itself, ~/Library, the board's own data folder or a
// system path.

const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const SYSTEM = ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/tmp', '/opt', '/cores', '/dev', '/Volumes', '/Network'];

export function checkExistingFolder(input, { home = HOME, dataHome = RAVENRY_HOME } = {}) {
  let raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: 'Pick a folder first.' };
  if (raw === '~' || raw.startsWith('~/')) raw = path.join(home, raw.slice(1));
  if (!path.isAbsolute(raw)) return { ok: false, error: `${raw} is not a full path to a folder.` };
  let real;
  try { real = fs.realpathSync(raw); } catch { return { ok: false, error: `${short(raw)} is not there.` }; }
  let st;
  try { st = fs.statSync(real); } catch { return { ok: false, error: `${short(raw)} is not there.` }; }
  if (!st.isDirectory()) return { ok: false, error: `${short(raw)} is a file, not a folder.` };
  const h = realOr(home);
  if (real === h) return { ok: false, error: 'The home folder itself cannot be a project folder. Pick a folder inside it.' };
  if (!inside(real, h)) return { ok: false, error: `${short(raw)} is outside your home folder, so the board will not start a project there.` };
  if (inside(real, path.join(h, 'Library'))) return { ok: false, error: '~/Library holds the Mac\'s own app data, so the board will not start a project there.' };
  for (const d of [dataHome, path.join(home, '.ravenry'), path.join(home, '.mission-control')]) {
    if (d && inside(real, realOr(d))) return { ok: false, error: `${short(realOr(d))} is the board's own data folder, so it cannot hold a project.` };
  }
  // The home folder is never under a system path on a normal Mac; this only
  // matters when it is (a test home in /tmp is checked against the test home).
  if (SYSTEM.some((s) => inside(real, s) && !inside(h, s))) return { ok: false, error: `${short(raw)} is a system folder, so the board will not start a project there.` };
  return { ok: true, folder: real };
}

// The registered folder that is the same directory as `real`, written the
// way the registry already writes it, so sharing is seen by every module
// that compares folders as strings.
function registeredSpelling(projects, real) {
  const hit = projects.find((p) => p.folder && realOr(p.folder) === real);
  return hit ? hit.folder : real;
}

// One row of the Existing list: the folder, the projects using it, and
// whether a BRIEF.md is there already (then a new project writes its own
// BRIEF-<id>.md, like a shared folder).
export function folderEntry(folder, projects, extra = {}) {
  const real = realOr(folder);
  const users = projects.filter((p) => !p.hidden && p.folder && realOr(p.folder) === real);
  return { folder: registeredSpelling(projects, real), short: short(folder), name: path.basename(folder) || folder, parent: short(path.dirname(folder)), projects: users.map((p) => p.name), hasBrief: fs.existsSync(path.join(real, 'BRIEF.md')), ...extra };
}

// The folders the board knows: registered projects' folders that are still
// on disk, deduplicated, most recently active first (`lastActive(project)`
// gives an ISO time or ''). `ids` lets the page name the brief it will write.
export function knownFolders(reg, lastActive = () => '') {
  const projects = (reg && reg.projects) || [];
  const by = new Map();
  for (const p of projects) {
    if (p.hidden || !p.folder) continue;
    const real = realOr(p.folder);
    const t = lastActive(p) || '';
    const e = by.get(real);
    if (e) { if (t > e.t) e.t = t; continue; }
    by.set(real, { folder: p.folder, t });
  }
  const out = [];
  for (const [real, e] of by) {
    try { if (!fs.statSync(real).isDirectory()) continue; } catch { continue; }
    out.push({ ...folderEntry(e.folder, projects), t: e.t });
  }
  out.sort((a, b) => (b.t > a.t ? 1 : b.t < a.t ? -1 : a.name.localeCompare(b.name)));
  return { folders: out.map(({ t, ...rest }) => rest), ids: projects.map((p) => p.id) };
}

// Finder's own folder dialog, through osascript, on the Mac's screen. It
// blocks until the user answers, so it runs as a child process (the server
// keeps answering) with a timeout, and only one can be open at a time.
// Its answer goes to a file, not a pipe: with the server busy in a sync git
// call when the dialog closed, a pipe's last bytes were seen to go missing,
// which read as a cancel. MC_CHOOSE_FOLDER_COMMAND (JSON argv) replaces
// osascript in tests.
// `purpose` picks the dialog's prompt from a fixed list (never page text):
// the project's folder (Existing), the folder new projects go in (Settings,
// first run), or the parent of this one project's new folder (Change for
// this one).
const CHOOSE_PROMPTS = {
  project: 'Pick the project folder',
  root: 'Pick the folder new projects go in',
  parent: 'Pick the folder to make this project\'s folder in',
};
let choosing = null;
export function chooseFolder({ purpose = 'project', timeoutMs = Number(process.env.MC_CHOOSE_FOLDER_TIMEOUT_MS) || 5 * 60 * 1000 } = {}) {
  if (choosing) return Promise.resolve({ ok: false, status: 409, error: 'The Finder dialog is already open on the Mac.' });
  const prompt = CHOOSE_PROMPTS[purpose] || CHOOSE_PROMPTS.project;
  const argv = process.env.MC_CHOOSE_FOLDER_COMMAND ? JSON.parse(process.env.MC_CHOOSE_FOLDER_COMMAND) : ['osascript', '-e', `POSIX path of (choose folder with prompt "${prompt}")`];
  choosing = new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenry-choose-'));
    const outFile = path.join(dir, 'out');
    const errFile = path.join(dir, 'err');
    const outFd = fs.openSync(outFile, 'w');
    const errFd = fs.openSync(errFile, 'w');
    let killed = false;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      resolve(r);
    };
    const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
    const [cmd, ...args] = argv;
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', outFd, errFd] });
    } finally {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
    }
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.on('error', (e) => finish({ ok: false, status: 500, error: `Finder's folder dialog did not open: ${e.message}` }));
    child.on('exit', (code, signal) => {
      const out = read(outFile);
      const err = read(errFile);
      // A busy server can run the timer after the dialog already answered:
      // only a dialog the board really killed counts as timed out.
      if (killed && signal) return finish({ ok: false, status: 504, error: 'The Finder dialog was open too long, so the board closed it.' });
      if (code !== 0) {
        if (/-128|User canceled/i.test(err)) return finish({ ok: true, cancelled: true });
        return finish({ ok: false, status: 500, error: `Finder's folder dialog did not open: ${(err.trim().split('\n').pop() || 'exit ' + code).slice(0, 200)}` });
      }
      const p = out.trim().replace(/\/+$/, '');
      finish(p ? { ok: true, path: p } : { ok: true, cancelled: true });
    });
  }).finally(() => { choosing = null; });
  return choosing;
}

// The names in `dir` already taken by a folder with files in it, for New
// folder's hint (the server still refuses them).
export function takenIn(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name)
      .filter((n) => { try { return fs.readdirSync(path.join(dir, n)).some((f) => f !== '.DS_Store'); } catch { return false; } })
      .map((n) => ({ name: n, hasBrief: fs.existsSync(path.join(dir, n, 'BRIEF.md')) }));
  } catch { return []; }
}

// ------------------------------------------------------------ New project

export async function createProject(form, { cfg, settings, reserve }) {
  const err = validate(form);
  if (err) return { ok: false, status: 400, error: err };
  const name = oneLine(form.name);
  const slug = registry.slug(name);
  let cur = registry.load() || { projects: [] };
  let folder;
  let made = false;
  const existing = form.existingFolder != null && String(form.existingFolder).trim() !== '';
  // "Change for this one": a new folder made under another parent, for this
  // project only; the projects root in Settings stays as it is.
  let parent = cfg.projectsRoot;
  if (!existing && form.parentFolder != null && String(form.parentFolder).trim() !== '') {
    const chk = checkExistingFolder(form.parentFolder);
    if (!chk.ok) return { ok: false, status: 400, error: chk.error };
    parent = chk.folder;
  }
  if (existing) {
    // An existing folder, picked under Existing: it may hold anything and
    // may be another project's.
    const chk = checkExistingFolder(form.existingFolder);
    if (!chk.ok) return { ok: false, status: 400, error: chk.error };
    folder = registeredSpelling(cur.projects, chk.folder);
  } else {
    folder = path.join(parent, slug);
    if (fs.existsSync(folder)) {
      if (!fs.statSync(folder).isDirectory()) return { ok: false, status: 409, error: `${short(folder)} exists and is a file.` };
      const entries = fs.readdirSync(folder).filter((f) => f !== '.DS_Store');
      if (entries.length && !form.useExisting) return { ok: false, status: 409, code: 'exists', folder: short(folder), error: `${short(folder)} already exists and is not empty. Pick it under Existing to start there.` };
    } else {
      fs.mkdirSync(folder, { recursive: true });
      made = true;
    }
  }
  const real = realOr(folder);
  const sharing = cur.projects.filter((p) => !p.hidden && p.folder && (p.folder === folder || realOr(p.folder) === real));
  const id = registry.uniqueId(cur, name);
  // A folder another project uses, or one that already has a BRIEF.md,
  // gets this project's own BRIEF-<id>.md (its hand-off goes there too).
  const briefRel = sharing.length || (existing && fs.existsSync(path.join(folder, 'BRIEF.md'))) ? `BRIEF-${id}.md` : 'BRIEF.md';
  const briefAbs = path.join(folder, briefRel);
  if (fs.existsSync(briefAbs)) return { ok: false, status: 409, error: `${short(briefAbs)} already exists, so nothing was written.` };
  if (made) gitInit(folder);
  fs.writeFileSync(briefAbs, briefMarkdown(form, { stage: form.stage || 'Start' }), { flag: 'wx' });
  const entry = { id, name, folder, workspaces: [], brief: briefRel, waitingOn: null, created: new Date().toISOString(), kind: kindOf(form) };
  if (form.ideaId) entry.fromIdea = String(form.ideaId);
  let reg = registry.update((r) => { r.projects.push(entry); });
  const prompt = `Read ${briefRel} and start on the first milestone.`;
  if (term.BOARD !== 'cmux') {
    const t = await openBoardTab({ cwd: folder, command: launchLine(cfg, prompt) });
    if (!t.ok) return { ok: true, partial: true, id, reg, folder: short(folder), brief: short(briefAbs), error: `Folder and brief are ready, but ${t.error}` };
    return { ok: true, id, reg, folder: short(folder), brief: short(briefAbs), workspaceRef: t.where, surfaceId: t.surfaceId, gitInit: made, message: `${name} is in ${short(folder)}. Claude is reading the brief in a new ${t.where} tab.` };
  }
  const release = reserve(name);
  let ws;
  try {
    ws = await openWorkspace({ name, cwd: folder, command: launchLine(cfg, prompt), focus: settings.focusNewWorkspace === true });
    if (ws.ok) reg = registry.update((r) => { const p = r.projects.find((x) => x.id === id); if (p) p.workspaces = [ws.workspaceId]; });
  } finally {
    release();
  }
  if (!ws.ok) return { ok: true, partial: true, id, reg, folder: short(folder), brief: short(briefAbs), error: `Folder and brief are ready, but ${ws.error}` };
  return { ok: true, id, reg, folder: short(folder), brief: short(briefAbs), workspaceRef: ws.workspaceRef, gitInit: made };
}

// ------------------------------------------------------------ Write the brief

export function writeBrief(project, form) {
  if (!project.folder || !fs.existsSync(project.folder)) return { ok: false, status: 409, error: `${project.name} has no folder on disk to hold a brief.` };
  const err = validate({ ...form, name: form.name || project.name });
  if (err) return { ok: false, status: 400, error: err };
  const cur = registry.load() || { projects: [] };
  const shared = cur.projects.some((p) => p.id !== project.id && p.folder === project.folder && !p.hidden);
  const briefRel = project.brief || (shared ? `BRIEF-${project.id}.md` : 'BRIEF.md');
  const abs = path.isAbsolute(briefRel) ? briefRel : path.join(project.folder, briefRel);
  if (fs.existsSync(abs)) return { ok: false, status: 409, error: `${short(abs)} already exists, so nothing was written.` };
  fs.writeFileSync(abs, briefMarkdown({ ...form, name: form.name || project.name }), { flag: 'wx' });
  const reg = project.brief === briefRel ? null : registry.update((r) => { const p = r.projects.find((x) => x.id === project.id); if (p) p.brief = briefRel; });
  return { ok: true, brief: short(abs), briefRel, reg };
}

// ------------------------------------------------------------ Revive

// `prompt` replaces the default one (a plan's start or answer, server/planrun.mjs).
// `firstMessage`: the message box's New session switch
// (docs/design/NewSession.dc.html, D): the user's own words, with file paths
// appended as Send appends them, as the new session's first prompt. They
// reach Claude exactly: shellWord when the line is typed into a new tab's
// shell, and `--` before words that start with a dash. It needs no brief,
// and the project may have a live session already.
// `near`: in iTerm2 mode, a tab of the project's whose window gets the new one.
export async function revive(project, { cfg, settings, reserve, prompt: custom = null, firstMessage = null, near = null }) {
  const fm = firstMessage ? String(firstMessage) : null;
  const bp = registry.briefPath(project);
  if (!custom && !fm && (!bp || !fs.existsSync(bp))) return { ok: false, status: 409, error: `${project.name} has no brief yet. Write the brief first, so the new session has something to read.` };
  // No folder (an idea with no repo): cmux opens the session in the
  // project's workspace, which keeps it on the card; a new iTerm2 tab would
  // have nothing tying it to the project, so it is not opened.
  if (!project.folder && term.BOARD !== 'cmux') return { ok: false, status: 409, error: `${project.name} has no folder, so there is nowhere to start its session.` };
  const rel = project.folder && bp ? path.relative(project.folder, bp) : '..';
  const briefRel = rel.startsWith('..') ? bp : rel;
  const prompt = custom || `Read ${briefRel} (Hand-off section first) and continue.`;
  // `typed`: the line is pasted into a new tab's shell; else it is cmux's
  // --command for a new workspace, which reads backslashes (quoteWord).
  const line = (typed) => (fm ? `${cfg.launchCommand} ${fm.startsWith('-') ? '-- ' : ''}${typed ? shellWord(fm) : quoteWord(fm)}` : launchLine(cfg, prompt));
  const cmd = line(true);
  if (term.BOARD !== 'cmux') {
    const t = await openBoardTab({ cwd: project.folder, command: cmd, near });
    if (!t.ok) return { ok: false, status: 500, error: t.error.charAt(0).toUpperCase() + t.error.slice(1) };
    return { ok: true, where: 'tab', workspaceRef: t.where, surfaceRef: t.surfaceRef, surfaceId: t.surfaceId, command: cmd, message: `New ${t.where} tab for ${project.name}. ${fm ? 'It starts with your first message.' : 'It reads the brief first.'}` };
  }
  const all = await cmux.listWorkspaces();
  const ws = all.find((w) => (project.workspaces || []).includes(w.id));
  if (ws) {
    // A new tab next to the first terminal tab; the old tabs are never touched.
    const first = ws.surfaces.find((s) => s.type === 'terminal');
    const made = await term.openTab('cmux', { workspaceId: ws.id, paneId: first ? first.paneId : null, cwd: project.folder });
    if (!made.ok) return { ok: false, status: 500, error: 'cmux did not open a tab: ' + (made.err || 'no answer') };
    await new Promise((r) => setTimeout(r, 900)); // let the shell draw its prompt
    const tab = { kind: 'cmux', workspaceId: ws.id, surfaceId: made.surfaceId };
    const a = await term.pasteText(tab, cmd);
    const b = a.ok ? await term.pressKey(tab, 'enter') : a;
    if (!b.ok) return { ok: false, status: 500, error: 'The new tab opened but the command was not typed: ' + (b.err || '') };
    return { ok: true, where: 'tab', workspaceRef: ws.ref, surfaceRef: made.surfaceRef, surfaceId: made.surfaceId, command: cmd };
  }
  const release = reserve(project.name);
  try {
    const wcmd = line(false);
    const nw = await openWorkspace({ name: project.name, cwd: project.folder, command: wcmd, focus: settings.focusNewWorkspace === true });
    if (!nw.ok) return { ok: false, status: 500, error: nw.error };
    const reg = registry.update((r) => { const p = r.projects.find((x) => x.id === project.id); if (p) p.workspaces = [...(p.workspaces || []), nw.workspaceId]; });
    return { ok: true, where: 'workspace', workspaceRef: nw.workspaceRef, workspaceId: nw.workspaceId, command: wcmd, reg };
  } finally {
    release();
  }
}
