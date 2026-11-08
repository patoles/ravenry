// The Ravenry skill, installed for Claude Code (<CLAUDE_CONFIG_DIR or
// ~/.claude>/skills/ravenry) and Codex (<CODEX_HOME or ~/.codex>/skills/
// ravenry): one SKILL.md that has the assistant run `ravenry skill` and
// follow the guide it prints, so it always matches the installed version.
//
// Installed only when the person says so (the first-launch step, or
// Settings, Skills). Removing it puts the folder back exactly as it was:
// a ravenry skill that was there before comes back file for file, and a
// skills folder (or the assistant's own folder) Ravenry made goes. What
// was there is kept in <data>/skills-undo.json until then.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SkillAssistant = 'claude' | 'codex';
export const SKILL_ASSISTANTS: SkillAssistant[] = ['claude', 'codex'];

type Env = Record<string, string | undefined>;

/** The assistant's own folder: ~/.claude (CLAUDE_CONFIG_DIR) or ~/.codex (CODEX_HOME). */
export function assistantHome(a: SkillAssistant, env: Env = process.env, home: string = os.homedir()): string {
  if (a === 'claude') return env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return env.CODEX_HOME || path.join(home, '.codex');
}

export function skillDir(a: SkillAssistant, env: Env = process.env, home: string = os.homedir()): string {
  return path.join(assistantHome(a, env, home), 'skills', 'ravenry');
}

const MARK = 'ravenry-stub';

/** The SKILL.md Ravenry writes: the command it runs is the app's stable link, so updates need no rewrite. */
export function skillText(bin: string, version: string): string {
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

export interface SkillStatus {
  kind: SkillAssistant;
  dir: string;
  /** A ravenry skill is there. */
  installed: boolean;
  /** It is the one Ravenry wrote (Remove takes it out). */
  ours: boolean;
  /** The Ravenry version it was written by, when ours. */
  version: string | null;
}

export function skillStatus(a: SkillAssistant, env: Env = process.env, home: string = os.homedir()): SkillStatus {
  const dir = skillDir(a, env, home);
  let text: string | null = null;
  try { text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch { /* none */ }
  const ours = !!text && text.includes(`${MARK}:`);
  return { kind: a, dir, installed: text != null, ours, version: ours ? ((/ravenry-version: "([^"]+)"/.exec(text!) || [])[1] || null) : null };
}

interface UndoRecord {
  /** The folders that did not exist before the install (made by it), outermost first. */
  made: string[];
  /** The ravenry skill folder's files before, by relative path (base64), or null when there was none. */
  before: Record<string, string> | null;
  /** SKILL.md as Ravenry wrote it. */
  after: string;
}

function readUndo(file: string): Record<string, UndoRecord> {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}
function writeUndo(file: string, u: Record<string, UndoRecord>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(u, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function filesOf(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) filesOf(f, base, out);
    else if (e.isFile()) out[path.relative(base, f)] = fs.readFileSync(f).toString('base64');
  }
  return out;
}

/** Writes the skill. Keeps what the folder had, for Remove. */
export function installSkill(a: SkillAssistant, bin: string, version: string, undoFile: string, env: Env = process.env, home: string = os.homedir()): SkillStatus {
  const dir = skillDir(a, env, home);
  const u = readUndo(undoFile);
  if (!u[dir]) {
    const made: string[] = [];
    for (const d of [assistantHome(a, env, home), path.dirname(dir), dir]) if (!fs.existsSync(d)) made.push(d);
    let before: Record<string, string> | null = null;
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
export function removeSkill(a: SkillAssistant, undoFile: string, env: Env = process.env, home: string = os.homedir()): SkillStatus {
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
