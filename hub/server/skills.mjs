// The Ravenry skill, installed for Claude Code (<CLAUDE_CONFIG_DIR or
// ~/.claude>/skills/ravenry) and Codex (<CODEX_HOME or ~/.codex>/skills/
// ravenry): one SKILL.md that has the assistant run `ravenry skill` and
// follow the guide it prints, so it always matches the installed version.
// Its hooks are hookinstall.mjs's (POST /api/setup/hooks).
//
// Installed only when the person says so (the first-launch step 2, or
// Settings, Skills). Removing it puts the folder back exactly as it was:
// a ravenry skill that was there before comes back file for file, and a
// skills folder (or the assistant's own folder) Ravenry made goes. What
// was there is kept in <RAVENRY_HOME>/skills-undo.json until then (the
// route passes the file; this module never imports home.mjs).
//
// Routes (server/index.mjs):
//
//   GET /api/setup/skills
//     -> { ok: true, skills: [Row, Row] }   // claude first, then codex
//   Row: { kind: "claude" | "codex", name: "Claude Code" | "Codex",
//          found,        // the assistant is installed here (firstlaunch.mjs)
//          dir,          // the skill's folder, as people read it ("~/.claude/skills/ravenry")
//          installed,    // a ravenry skill is there
//          ours,         // it is the one Ravenry wrote (Remove takes it out)
//          version }     // the Ravenry version that wrote it, when ours, else null
//
//   POST /api/setup/skills  (the Mac only; a person's: server/person.mjs)
//     { kind: "claude" | "codex", on: true, ravenryd: "<abs path>", version: "0.1.22" }
//       installs it; the command it runs is the `ravenry` link beside
//       ravenryd when there is one, else ravenryd itself.
//     { kind, on: false }   removes it.
//     { adopt: { <skill dir>: UndoRecord } }   (alone, or with the above)
//       the undo records a client kept before the hub did (the desktop's
//       <userData>/skills-undo.json): kept where the hub has none for that
//       folder, so Remove still puts the folder back as it was.
//     -> { ok: true, skills: [Row, Row] }  or 400 { error }

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sayPath } from '../public/homepath.mjs';
import { findAssistants } from './firstlaunch.mjs';

export const SKILL_ASSISTANTS = ['claude', 'codex'];
const NAMES = { claude: 'Claude Code', codex: 'Codex' };

/** The assistant's own folder: ~/.claude (CLAUDE_CONFIG_DIR) or ~/.codex (CODEX_HOME). */
export function assistantHome(a, env = process.env, home = os.homedir()) {
  if (a === 'claude') return env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return env.CODEX_HOME || path.join(home, '.codex');
}

export function skillDir(a, env = process.env, home = os.homedir()) {
  return path.join(assistantHome(a, env, home), 'skills', 'ravenry');
}

const MARK = 'ravenry-stub';

/** The SKILL.md Ravenry writes: the command it runs is the app's stable link, so updates need no rewrite. */
export function skillText(bin, version) {
  return [
    '---',
    'name: ravenry',
    'description: Use Ravenry\'s terminals from the command line. Open a pane beside you for a server or a build, read its screen, type into it, wait for its output, show the person pictures to pick from, and ask them through the board and their phone.',
    'metadata:',
    `  ${MARK}: "1"`,
    `  ravenry-version: "${version}"`,
    '---',
    '<!-- Installed by Ravenry. Remove it in Ravenry: Settings, Skills. -->',
    '',
    `Run \`"${bin}" skill\` and follow the guide it prints. It comes from the`,
    'installed Ravenry, so it describes the commands of that version.',
    '',
    'If the command is not there, Ravenry is no longer installed on this machine:',
    'say so to the person and do not guess at commands.',
    '',
  ].join('\n');
}

export function skillStatus(a, env = process.env, home = os.homedir()) {
  const dir = skillDir(a, env, home);
  let text = null;
  try { text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch { /* none */ }
  const ours = !!text && text.includes(`${MARK}:`);
  return { kind: a, dir, installed: text != null, ours, version: ours ? ((/ravenry-version: "([^"]+)"/.exec(text) || [])[1] || null) : null };
}

/** GET /api/setup/skills's rows. */
export function skillsView(env = process.env, home = os.homedir()) {
  const found = findAssistants(env, home);
  return SKILL_ASSISTANTS.map((k) => {
    const st = skillStatus(k, env, home);
    return { ...st, dir: sayPath(st.dir, home), name: NAMES[k], found: !!found.find((x) => x.kind === k)?.found };
  });
}

function readUndo(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}
function writeUndo(file, u) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(u, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function filesOf(dir, base = dir, out = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) filesOf(f, base, out);
    else if (e.isFile()) out[path.relative(base, f)] = fs.readFileSync(f).toString('base64');
  }
  return out;
}

/** Writes the skill. Keeps what the folder had, for Remove. */
export function installSkill(a, bin, version, undoFile, env = process.env, home = os.homedir()) {
  const dir = skillDir(a, env, home);
  const u = readUndo(undoFile);
  if (!u[dir]) {
    const made = [];
    for (const d of [assistantHome(a, env, home), path.dirname(dir), dir]) if (!fs.existsSync(d)) made.push(d);
    let before = null;
    if (fs.existsSync(dir)) before = filesOf(dir);
    u[dir] = { made, before, after: '' };
  }
  fs.mkdirSync(dir, { recursive: true });
  const text = skillText(bin, version);
  const tmp = path.join(dir, `.SKILL.md.tmp-${process.pid}`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, path.join(dir, 'SKILL.md'));
  u[dir].after = text;
  writeUndo(undoFile, u);
  return skillStatus(a, env, home);
}

/**
 * Takes Ravenry's skill out. With a record of the install: the folder goes
 * back exactly as it was (a skill there before comes back, folders the
 * install made go). Without one: only a SKILL.md Ravenry wrote, and the
 * folder when it is then empty. Someone else's ravenry skill is never touched.
 */
export function removeSkill(a, undoFile, env = process.env, home = os.homedir()) {
  const dir = skillDir(a, env, home);
  const st = skillStatus(a, env, home);
  const u = readUndo(undoFile);
  const r = u[dir];
  if (!st.ours) {
    if (r) { delete u[dir]; writeUndo(undoFile, u); }
    return st;
  }
  if (r) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (r.before) {
      for (const [rel, b64] of Object.entries(r.before)) {
        const f = path.join(dir, rel);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, Buffer.from(b64, 'base64'));
      }
      if (!Object.keys(r.before).length) fs.mkdirSync(dir, { recursive: true });
    }
    // The folders the install made, innermost first, while empty.
    for (const d of [...r.made].reverse()) {
      try { if (fs.existsSync(d) && !fs.readdirSync(d).length) fs.rmdirSync(d); } catch { /* kept */ }
    }
    delete u[dir];
    writeUndo(undoFile, u);
  } else {
    fs.rmSync(path.join(dir, 'SKILL.md'), { force: true });
    try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { /* kept */ }
  }
  return skillStatus(a, env, home);
}

/**
 * Undo records a client kept (the desktop's before 0.1.23), kept where the
 * hub has none for that folder. Only records for this machine's two skill
 * folders, whose files stay inside the folder and whose made folders are
 * the ones an install can make, are taken. Returns how many were taken.
 */
export function adoptUndo(records, undoFile, env = process.env, home = os.homedir()) {
  if (!records || typeof records !== 'object') return 0;
  const u = readUndo(undoFile);
  let n = 0;
  for (const a of SKILL_ASSISTANTS) {
    const dir = skillDir(a, env, home);
    const r = records[dir];
    if (!r || typeof r !== 'object' || u[dir]) continue;
    const may = [assistantHome(a, env, home), path.dirname(dir), dir];
    if (!Array.isArray(r.made) || !r.made.every((d) => may.includes(d))) continue;
    if (r.before !== null && (typeof r.before !== 'object' || Array.isArray(r.before))) continue;
    const inside = (rel) => typeof rel === 'string' && !!rel && !path.isAbsolute(rel) && !path.normalize(rel).split(path.sep).includes('..');
    if (r.before && !Object.entries(r.before).every(([rel, b]) => inside(rel) && typeof b === 'string')) continue;
    u[dir] = { made: r.made, before: r.before, after: typeof r.after === 'string' ? r.after : '' };
    n++;
  }
  if (n) writeUndo(undoFile, u);
  return n;
}

/**
 * POST /api/setup/skills. `undoFile`: <RAVENRY_HOME>/skills-undo.json.
 * Returns { ok: true, skills } or { ok: false, error }.
 */
export function setSkill(body, undoFile, env = process.env, home = os.homedir()) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.adopt) adoptUndo(b.adopt, undoFile, env, home);
  if (b.kind === undefined && b.adopt) return { ok: true, skills: skillsView(env, home) };
  if (!SKILL_ASSISTANTS.includes(b.kind)) return { ok: false, error: 'No such assistant.' };
  if (b.on) {
    const bin = typeof b.ravenryd === 'string' ? b.ravenryd : '';
    // It goes in the SKILL.md between quotes and backticks: a plain absolute path only.
    if (!bin || !path.isAbsolute(bin) || /["`\\\n\r\0]/.test(bin) || !fs.existsSync(bin)) return { ok: false, error: 'Ravenry\'s command is not installed yet.' };
    const version = typeof b.version === 'string' && /^[\w.+-]{1,40}$/.test(b.version) ? b.version : null;
    if (!version) return { ok: false, error: 'Send the Ravenry version that installs it.' };
    const link = path.join(path.dirname(bin), 'ravenry');
    installSkill(b.kind, fs.existsSync(link) ? link : bin, version, undoFile, env, home);
  } else removeSkill(b.kind, undoFile, env, home);
  return { ok: true, skills: skillsView(env, home) };
}
