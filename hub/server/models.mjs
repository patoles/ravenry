// The model a session runs, said the way people say it, and the one a new
// session starts with.
//
// Where it comes from: Claude Code's transcript (each reply's
// message.model, server/transcript.mjs), Codex's rollout (each turn's
// turn_context model, server/codexrollout.mjs). Both are read again on every
// turn, so a /model switch shows with the next reply.
//
// Names: Claude ids become their family and version ("claude-opus-5-5" ->
// "Opus 5.5", "claude-haiku-4-5-20251001" -> "Haiku 4.5", a "[1m]" suffix ->
// "(1M)"); Codex's ids stay as Codex prints them ("gpt-5.4"). The short
// name, for a narrow sidebar, is the family ("Opus") or "Codex".
//
// Starting: New session's Model (the Mac's Start screen, the board's
// project head) is remembered per project and per assistant in the
// registry (`models: { claude, codex }`); the session starts with
// `claude --model <m>` or `codex -m <m>`. Switching during a session stays
// the CLI's own /model.

import { assistantName } from './cpwords.mjs';

// A model id as a command line takes it: letters, digits, . _ : - and a
// "[1m]" suffix.
export const MODEL_ID = /^[A-Za-z0-9][\w.:-]{0,79}(?:\[1m\])?$/;

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
// Claude Code's --model aliases (`claude --help`): the newest of a family.
export const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku'];

// "claude-opus-5-5" -> { family: 'opus', version: '5.5', long: false }.
function claudeParts(id) {
  const s = String(id || '').trim();
  const long = /\[1m\]$/i.test(s);
  const bare = s.replace(/\[1m\]$/i, '');
  if (CLAUDE_ALIASES.includes(bare.toLowerCase())) return { family: bare.toLowerCase(), version: null, long };
  let m = bare.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i);
  if (m) return { family: m[1].toLowerCase(), version: m[3] != null ? `${m[2]}.${m[3]}` : m[2], long };
  // The older order: claude-3-5-sonnet-20241022, claude-3-opus-20240229.
  m = bare.match(/^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/i);
  if (m) return { family: m[3].toLowerCase(), version: m[2] != null ? `${m[1]}.${m[2]}` : m[1], long };
  return null;
}

/** The model as people say it: "Opus 5.5", "Fable 5.2", "gpt-5.4"; null for none. */
export function modelName(id) {
  const s = String(id || '').trim();
  if (!s || s === '<synthetic>') return null;
  const c = claudeParts(s);
  if (!c) return s;
  return `${cap(c.family)}${c.version ? ' ' + c.version : ''}${c.long ? ' (1M)' : ''}`;
}

/** The family alone, for a narrow row: "Opus", else the assistant ("Codex"). */
export function modelShort(id, kind) {
  const c = claudeParts(id);
  if (c) return cap(c.family);
  return assistantName(kind) || (id ? String(id) : null);
}

/**
 * What a session's chip and head say about its model, from the id its
 * transcript last named: { model, modelName, modelShort, modelTitle }
 * ("claude-opus-5-5", "Opus 5.5", "Opus", "Claude Opus 5.5"); all null
 * while it has named none.
 */
export function modelView(id, kind) {
  const name = modelName(id);
  if (!name) return { model: null, modelName: null, modelShort: null, modelTitle: null };
  const who = assistantName(kind);
  return { model: String(id), modelName: name, modelShort: modelShort(id, kind), modelTitle: who ? `${who} ${name}` : name };
}

// ------------------------------------------------------------ starting with one

/** The launch command with the model to start on: `--model` for Claude Code, `-m` for Codex (any one it had replaced). */
export function withModel(command, kind, model) {
  const m = typeof model === 'string' ? model.trim() : '';
  if (!m || !MODEL_ID.test(m)) return command;
  const flag = kind === 'codex' ? '-m' : '--model';
  const rest = String(command || (kind === 'codex' ? 'codex' : 'claude')).replace(/\s+(?:-m|--model)(?:=|\s+)(?:'[^']*'|\S+)/g, '');
  return `${rest} ${flag} ${/^[\w.:-]+$/.test(m) ? m : `'${m}'`}`;
}

/** The model a project starts its next session of `kind` with, or null (the assistant's default). */
export function projectModel(project, kind) {
  const m = project && project.models && typeof project.models === 'object' ? project.models[kind] : null;
  return typeof m === 'string' && MODEL_ID.test(m) ? m : null;
}

/**
 * The Model menu of New session, per assistant: the assistant's default
 * first, then for Claude Code its aliases (named by the newest version seen
 * on this Mac, "Opus 5.5") and the other models seen by id ("Fable 5.2");
 * for Codex the ids seen and the one its config.toml names. `seen`: the
 * model ids of the sessions the board reads; `codexDefault`: config.toml's.
 * Each option is { id, label }: id '' is the default.
 */
export function startMenus({ seen = [], codexDefault = null, picked = [] } = {}) {
  const ids = [...new Set([...seen, ...picked].filter((x) => typeof x === 'string' && x && x !== '<synthetic>'))];
  const claudeIds = ids.filter((x) => claudeParts(x));
  const codexIds = ids.filter((x) => !claudeParts(x));
  const newest = (family) => claudeIds.map(claudeParts).filter((c) => c.family === family && c.version && !c.long)
    .sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }))[0] || null;
  const claude = [{ id: '', label: "Claude Code's default" }];
  for (const a of CLAUDE_ALIASES) {
    const n = newest(a);
    claude.push({ id: a, label: n ? `${cap(a)} ${n.version}` : cap(a) });
  }
  // A family with no alias, by its newest full id.
  const others = new Map();
  for (const id of claudeIds) {
    const c = claudeParts(id);
    if (CLAUDE_ALIASES.includes(c.family) || !c.version) continue;
    const had = others.get(c.family);
    if (!had || c.version.localeCompare(claudeParts(had).version, 'en', { numeric: true }) > 0 || (c.version === claudeParts(had).version && id.length < had.length)) others.set(c.family, id);
  }
  for (const id of [...others.values()].sort()) claude.push({ id, label: modelName(id) });
  // A remembered pick not listed above (an exact id): listed as it is.
  for (const id of picked) if (claudeParts(id) && !claude.some((o) => o.id === id)) claude.push({ id, label: modelName(id) });
  const codex = [{ id: '', label: codexDefault ? `Codex's default (${codexDefault})` : "Codex's default" }];
  for (const id of [...new Set([...(codexDefault ? [codexDefault] : []), ...codexIds])].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))) {
    if (MODEL_ID.test(id)) codex.push({ id, label: id });
  }
  return { claude, codex };
}
