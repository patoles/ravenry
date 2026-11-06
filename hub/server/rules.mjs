// Rule suggestions: "the things I ask again and again". Two kinds:
// - feedback memories in the user's scope (config.ruleSources) that the global
//   CLAUDE.md does not cite by name yet (it cites file names in parentheses);
// - repeats: corrections they typed in two or more sessions (server/repeats.mjs).
// Memory files are only ever read. Accepting a rule APPENDS one line to a
// "## Added from the board" section, after a timestamped backup. The same
// write path serves Codex's AGENTS.md for a repeat said in Codex sessions. The one
// rewrite allowed is a repeat's Reword rule: it replaces exactly one rule
// line of a CLAUDE.md, after a timestamped backup, and only while that line
// still reads exactly as it did when the suggestion was made. No other line
// of any CLAUDE.md is rewritten.

import fs from 'node:fs';
import path from 'node:path';

import { RAVENRY_HOME } from './registry.mjs';

export const RULES_PATH = path.join(RAVENRY_HOME, 'rules.json');
export const SECTION = 'Added from the board';

export function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const k = line.match(/^\s*(name|description|type)\s*:\s*(.*)$/);
    if (!k) continue;
    let v = k[2].trim();
    if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } }
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
    if (!(k[1] in out)) out[k[1]] = v;
  }
  return out;
}

// No em dashes on the board or in anything it writes.
export function plainRule(s) {
  return String(s || '').replace(/\s*—\s*/g, ': ').replace(/\s+/g, ' ').trim();
}

export function citedNames(md) {
  const names = new Set();
  for (const m of String(md || '').matchAll(/\(([^()]*)\)/g)) {
    for (const t of m[1].split(/[,;\s]+/)) {
      const w = t.replace(/\.md$/, '').trim();
      if (/^[a-z0-9][a-z0-9-]*$/.test(w)) names.add(w);
    }
  }
  return names;
}

export function readDecisions() {
  try { return JSON.parse(fs.readFileSync(RULES_PATH, 'utf8')); } catch { return { version: 1, decisions: {} }; }
}

export function writeDecisions(d) {
  fs.mkdirSync(RAVENRY_HOME, { recursive: true });
  const tmp = RULES_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n');
  fs.renameSync(tmp, RULES_PATH);
}

// Every feedback memory in scope, grouped by name (one rule can live in
// several projects' memory).
export function scan(cfg) {
  const byName = new Map();
  for (const src of cfg.ruleSources) {
    let files = [];
    try { files = fs.readdirSync(src.memory).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md'); } catch { continue; }
    for (const f of files) {
      let md;
      try { md = fs.readFileSync(path.join(src.memory, f), 'utf8'); } catch { continue; }
      const fm = frontmatter(md);
      if (fm.type !== 'feedback') continue;
      const stem = f.replace(/\.md$/, '');
      const g = byName.get(stem) || { id: stem, names: new Set([stem]), text: plainRule(fm.description || fm.name || stem), sources: [] };
      if (fm.name) g.names.add(fm.name);
      g.sources.push({ label: src.label, claudeMd: src.claudeMd, file: path.join(src.memory, f) });
      byName.set(stem, g);
    }
  }
  return [...byName.values()];
}

function joinNames(a) {
  return a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
}

let cache = null;
export function invalidate() { cache = null; }

export function list(cfg, { fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 60000) return cache.value;
  let global = '';
  try { global = fs.readFileSync(cfg.globalClaudeMd, 'utf8'); } catch { /* none yet */ }
  const cited = citedNames(global);
  const dec = readDecisions().decisions || {};
  const now = Date.now();
  const rules = [];
  for (const g of scan(cfg)) {
    const isCited = [...g.names].some((n) => cited.has(n));
    const d = dec[g.id];
    const labels = [...new Set(g.sources.map((s) => s.label))];
    const recent = d && now - Date.parse(d.at) < 30 * 60 * 1000;
    if ((isCited || d) && !recent) continue;
    const where = joinNames(labels);
    rules.push({
      id: g.id, text: g.text, projects: labels,
      why: `Only in ${where} memory, so a session in any other project never sees it. From ${g.id}.md.`,
      localLabel: labels.length === 1 ? `${labels[0]} only` : `${where} only`,
      pending: !d, done: d ? { action: d.action, label: d.action === 'global' ? 'Every project' : d.action === 'local' ? (labels.length === 1 ? `${labels[0]} only` : 'Those projects') : 'Not a rule' } : null,
    });
  }
  rules.sort((a, b) => a.projects[0].localeCompare(b.projects[0]) || a.id.localeCompare(b.id));
  const value = { rules, pending: rules.filter((r) => r.pending).length, globalPath: cfg.globalClaudeMd };
  cache = { at: Date.now(), value };
  return value;
}

export function pendingCount(cfg) {
  try { return list(cfg).pending; } catch { return 0; }
}

function stamp(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// `name` is the rules file's: CLAUDE (Claude Code's) or AGENTS (Codex's).
export function backup(file, cfg, tag, name = 'CLAUDE') {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(cfg.backupDir, { recursive: true });
  const to = path.join(cfg.backupDir, `${tag}-${name}-before-board-rule-${stamp()}-${process.pid}${Math.random().toString(36).slice(2, 5)}.md`);
  fs.copyFileSync(file, to, fs.constants.COPYFILE_EXCL);
  return to;
}

// Appends `line` at the very end, under "## Added from the board" (starting
// that section when it is not the last one). Never touches other lines.
export function appendRule(file, line) {
  const md = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (md.split('\n').some((l) => l.trim() === line.trim())) return { already: true };
  const heads = [...md.matchAll(/^##\s+(.+?)\s*$/gm)];
  const last = heads.length ? heads[heads.length - 1][1] : null;
  let add = '';
  if (md && !md.endsWith('\n')) add += '\n';
  if (last !== SECTION) add += (md.trim() ? '\n' : '') + `## ${SECTION}\n`;
  add += line + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, add);
  return { already: false };
}

export function decide(id, action, cfg) {
  if (!['global', 'local', 'dismiss'].includes(action)) { const e = new Error('Unknown action.'); e.status = 400; throw e; }
  const g = scan(cfg).find((x) => x.id === id);
  if (!g) { const e = new Error('That rule is no longer in memory.'); e.status = 404; throw e; }
  const line = `- ${g.text} (${g.id})`;
  const rec = { action, at: new Date().toISOString(), text: g.text };
  if (action === 'global') {
    rec.backup = backup(cfg.globalClaudeMd, cfg, 'global');
    rec.target = [cfg.globalClaudeMd];
    rec.already = appendRule(cfg.globalClaudeMd, line).already;
  } else if (action === 'local') {
    const targets = [...new Set(g.sources.map((s) => s.claudeMd).filter(Boolean))];
    if (!targets.length) { const e = new Error('No project CLAUDE.md is known for this rule.'); e.status = 409; throw e; }
    rec.target = targets;
    rec.backup = [];
    for (const t of targets) {
      const label = g.sources.find((s) => s.claudeMd === t).label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      rec.backup.push(backup(t, cfg, label));
      appendRule(t, line);
    }
  }
  const d = readDecisions();
  d.decisions = d.decisions || {};
  d.decisions[id] = rec;
  writeDecisions(d);
  cache = null;
  return rec;
}

// The global rules, as the New project modal lists them (read-only).
export function globalHeadings(cfg) {
  try {
    return [...fs.readFileSync(cfg.globalClaudeMd, 'utf8').matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]);
  } catch {
    return [];
  }
}
