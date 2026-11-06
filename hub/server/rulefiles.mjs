// Your rules, file by file (docs/design/CodexStage2.dc.html, section 4,
// variant A): for every project, then for each project, the file Claude Code
// reads (CLAUDE.md) beside the one Codex reads (AGENTS.md), each whole with
// its path. Read only: nothing here writes a rules file.
//
// Which AGENTS.md Codex reads, measured on Codex 0.166.0 (the strings in its
// binary: "AGENTS.override.md" then "AGENTS.md" as the candidates in one
// folder, "Failed to read global AGENTS.md instructions from" for the one in
// its home, and its prompt's "the AGENTS.md file at the root of the repo and
// any directories from the CWD up to the root"):
//   every project   <CODEX_HOME>/AGENTS.override.md, else <CODEX_HOME>/AGENTS.md
//                   (CODEX_HOME is ~/.codex unless set)
//   a project       AGENTS.override.md, else AGENTS.md, at the project's
//                   folder (its repo root); folders below it add their own.
// Claude Code's: ~/.claude/CLAUDE.md (cfg.globalClaudeMd) and the project's
// CLAUDE.md, the files the rule suggestions read (server/config.mjs).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { parseBlocks, splitCite } from './repeats.mjs';
import { plainRule } from './rules.mjs';
import { codexHome } from './codexrollout.mjs';
import { isBroadFolder } from './folders.mjs';
import { SCRATCH_DATA, inRepoTmp } from './home.mjs';

const HOME = os.homedir();
const short = (p) => (p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);
const readOr = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

// A file's rules as the Your rules cards show them: the "- " rules under
// each "## " heading, as before; rules above the first "## " go under the
// file's "# " title (a project's CLAUDE.md often has no "## " at all), else
// under the file's name.
export function groupsOf(md, fileName) {
  const title = (String(md).match(/^#\s+(.+)$/m) || [])[1];
  const groups = [];
  for (const b of parseBlocks(md)) {
    const heading = b.heading || (title ? title.trim() : fileName);
    let g = groups[groups.length - 1];
    if (!g || g.heading !== heading) { g = { heading, rules: [] }; groups.push(g); }
    g.rules.push(plainRule(splitCite(b.text).body));
  }
  return groups;
}

// One file: { path, file, exists, groups, count }. `candidates` in the
// order the assistant tries them; the first one there is the one read
// (an AGENTS.override.md only when it holds something, as Codex skips an
// empty one).
function fileView(candidates, label) {
  for (const [i, f] of candidates.entries()) {
    const md = readOr(f);
    if (md == null) continue;
    if (i < candidates.length - 1 && !md.trim()) continue;
    const groups = groupsOf(md, path.basename(f));
    return { path: label(f), file: f, exists: true, groups, count: groups.reduce((n, g) => n + g.rules.length, 0) };
  }
  const f = candidates[candidates.length - 1];
  return { path: label(f), file: f, exists: false, groups: [], count: 0 };
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// Every scope: { key, name, folder, claude, codex }. The first is every
// project; then one per project folder (projects sharing a folder share one
// scope), by name, only where at least one of the two files is there.
export function scopes(cfg, projects = [], { root = null, codex = codexHome() } = {}) {
  const out = [{
    key: 'global', name: 'Every project', folder: null,
    claude: fileView([cfg.globalClaudeMd], short),
    codex: fileView([path.join(codex, 'AGENTS.override.md'), path.join(codex, 'AGENTS.md')], short),
  }];
  const byFolder = new Map();
  for (const p of projects || []) {
    if (!p || p.hidden || !p.folder || !path.isAbsolute(p.folder)) continue;
    if (!SCRATCH_DATA && inRepoTmp(p.folder)) continue;
    if (isBroadFolder(p.folder, projects, root)) continue;
    const k = real(p.folder);
    if (!byFolder.has(k)) byFolder.set(k, { folder: p.folder, names: [] });
    byFolder.get(k).names.push(p.name || path.basename(p.folder));
  }
  const rest = [];
  for (const [k, e] of byFolder) {
    try { if (!fs.statSync(k).isDirectory()) continue; } catch { continue; }
    const claude = fileView([path.join(e.folder, 'CLAUDE.md')], (f) => path.basename(f));
    const cx = fileView([path.join(e.folder, 'AGENTS.override.md'), path.join(e.folder, 'AGENTS.md')], (f) => path.basename(f));
    if (!claude.exists && !cx.exists) continue;
    const names = e.names.sort((a, b) => a.localeCompare(b));
    rest.push({ key: k, name: names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0], folder: short(e.folder), claude, codex: cx });
  }
  rest.sort((a, b) => a.name.localeCompare(b.name));
  return [...out, ...rest].map(({ claude, codex: x, ...s }) => ({ ...s, claude: strip(claude), codex: strip(x) }));
}

// The page gets the short path only, never the absolute one.
const strip = ({ file, ...v }) => v;
