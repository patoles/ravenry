// Starting an assistant session in a ravenryd pane through the hub (POST
// /api/sessions/start), on this machine or a remote one: the app's "Start
// Claude in <folder>" calls this instead of pane.new, so the session gets
// what every session the board starts gets. Its pane is labelled for the
// app (ravenry.session, ravenry.project); the assistant starts with the
// project's brief to read (Hand-off section first), or the person's first
// message; its hooks report through `ravenryd hook` to the pane's daemon,
// and the hand-off works on it, also on a remote machine.
//
// plan() is the pure part (what runs where); server/ravenryd.mjs
// startSession() opens the pane and types it.

import path from 'node:path';
import { shellWord } from './create.mjs';

const ASSISTANTS = new Set(['claude', 'codex']);

// body: { projectId, folder, machine, assistant, text, cols, rows }.
// project: the registry's (or null); launch(project, assistant): { kind,
// command }; briefPath(project): its BRIEF.md or null; briefExists(p).
// Returns { ok, cwd, machine, line, label, labels, cols, rows, kind, env } or
// { ok: false, status, error }.
// binPath(name): the PATH a pane on this machine starts the assistant with,
// its own folder first, or null when it is not found here. The board finds
// an assistant where its installer puts it (~/.local/bin, ~/.claude/local)
// even when the person's shell files do not add that folder, so a pane
// started from the app (whose daemon has the short PATH the Finder gives)
// would say "command not found: claude".
// worktree: { branch, folder } when the session works in a worktree of its
// own (server/worktrees.mjs), so its first prompt says so. decisions: one
// line pointing at the project's decisions on record (server/decisions.mjs
// promptLine), added to the brief's prompt.
export function plan(body, { project = null, launch, briefPath = () => null, briefExists = () => false, machines = [], binPath = () => null, worktree = null, decisions = '' }) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.projectId != null && !project) return { ok: false, status: 404, error: 'No such project.' };
  const machine = b.machine == null || b.machine === '' ? (project && project.machine) || null : String(b.machine);
  if (machine && !machines.includes(machine)) return { ok: false, status: 404, error: `No machine is called ${machine}. Add it first.` };
  const folder = typeof b.folder === 'string' && b.folder.trim() ? b.folder.trim() : project ? project.folder : null;
  if (!folder || !path.isAbsolute(folder)) return { ok: false, status: 400, error: 'Give the folder to start in (an absolute path).' };
  if (b.assistant != null && !ASSISTANTS.has(b.assistant)) return { ok: false, status: 400, error: 'assistant is claude or codex.' };
  const L = launch(project, b.assistant || null);
  const text = typeof b.text === 'string' && b.text.trim() ? b.text.trim() : null;
  let prompt = text;
  if (!prompt && project) {
    const bp = briefPath(project);
    if (bp && (machine || briefExists(bp))) {
      const rel = path.relative(folder, bp);
      prompt = `Read ${rel.startsWith('..') ? bp : rel} (Hand-off section first) and continue.`;
      if (decisions) prompt += ` ${decisions}`;
    }
  }
  if (worktree) {
    const note = `You work in your own git worktree, ${worktree.folder}, on the branch ${worktree.branch}: commit your work there. The user reviews the branch and merges it.`;
    prompt = prompt ? `${prompt} ${note}` : note;
  }
  const line = prompt ? `${L.command} ${prompt.startsWith('-') ? '-- ' : ''}${shellWord(prompt)}` : L.command;
  const first = String(L.command).trim().split(/\s+/)[0];
  const PATH = !machine && ASSISTANTS.has(first) ? binPath(first) : null;
  const size = (n) => (Number.isInteger(n) && n >= 1 && n <= 4096 ? n : null);
  const cols = size(b.cols), rows = size(b.rows);
  return {
    ok: true, cwd: folder, machine, line, kind: L.kind, ...(PATH ? { env: { PATH } } : {}),
    label: String((project && project.name) || path.basename(folder) || 'Session').slice(0, 60),
    labels: { 'ravenry.session': L.kind, ...(project ? { 'ravenry.project': project.id.slice(0, 256) } : {}) },
    ...(cols && rows ? { cols, rows } : {}),
  };
}
