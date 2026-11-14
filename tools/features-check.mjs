#!/usr/bin/env node
// Checks docs/FEATURES.md against the release check: every step of
// apps/desktop/tools/release-check.mjs is cited (RC-<n>) by some feature
// row, no row cites a step that does not exist, every feature id is
// unique and well formed, every row has a value for each status column,
// and every file a row names exists. And the agent guide (`ravenry skill`,
// daemon/cmd/ravenryd/skill.go) says what Ravenry does with one line per
// area of section 2, "- **Area**", so it never falls behind the app.
//
//   node tools/features-check.mjs
//
// Exit 1 on any problem, each printed on its own line.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FEATURES = path.join(ROOT, 'docs', 'FEATURES.md');
const RC = path.join(ROOT, 'apps', 'desktop', 'tools', 'release-check.mjs');
const STATUS = new Set(['done', 'partial', 'missing', 'n/a', '?']);
const SKILL = path.join(ROOT, 'daemon', 'cmd', 'ravenryd', 'skill.go');

// The release check's steps: the number each step(...) name starts with
// ("5/7 update", "1-3: ...", "21 F/A2" give each number), the sub-tool
// table's [n, 'label', 'tool.mjs'] rows, and the env step.
function rcSteps(src) {
  const steps = new Set();
  for (const m of src.matchAll(/step\(\s*[`'"](\d+(?:[/-]\d+)*)\b/g)) for (const n of m[1].split(/[/-]/)) steps.add(n);
  for (const m of src.matchAll(/\[(\d+), '[\w-]+', '[\w-]+\.mjs'\]/g)) steps.add(m[1]);
  if (/step\(\s*'env:/.test(src)) steps.add('env');
  // "1-3" is a range: its middle numbers are steps too.
  for (const m of src.matchAll(/step\(\s*[`'"](\d+)-(\d+)\b/g)) for (let i = Number(m[1]); i <= Number(m[2]); i++) steps.add(String(i));
  return steps;
}

const problems = [];
const steps = rcSteps(fs.readFileSync(RC, 'utf8'));
const doc = fs.readFileSync(FEATURES, 'utf8');
const ids = new Map();
const cited = new Set();
let rows = 0;
for (const [i, line] of doc.split('\n').entries()) {
  const m = /^\| ([A-Z0-9]+-\d+) \|/.exec(line);
  if (!m) continue;
  rows++;
  const at = `docs/FEATURES.md:${i + 1}`;
  const id = m[1];
  if (!/^[A-Z][A-Z0-9]*-\d{3}$/.test(id)) problems.push(`${at}: ${id} is not AREA-NNN`);
  if (ids.has(id)) problems.push(`${at}: ${id} is used again (first at line ${ids.get(id)})`);
  ids.set(id, i + 1);
  const cells = line.split(' | ').map((c) => c.replace(/^\| ?| ?\|$/g, '').trim());
  if (cells.length !== 8) { problems.push(`${at}: ${id} has ${cells.length} cells, not 8`); continue; }
  for (const s of cells.slice(4)) if (!STATUS.has(s)) problems.push(`${at}: ${id} has the status "${s}" (done, partial, missing, n/a or ?)`);
  for (const r of cells[3].matchAll(/\bRC-(\d+|env)\b/g)) {
    cited.add(r[1]);
    if (!steps.has(r[1])) problems.push(`${at}: ${id} cites RC-${r[1]}, which the release check does not have`);
  }
  // Files named in the acceptance and logic cells, as `path/with/a.ext`.
  for (const f of (cells[2] + ' ' + cells[3]).matchAll(/`([\w.@-]+(?:\/[\w.@-]+)+\.\w+)`/g)) {
    if (!fs.existsSync(path.join(ROOT, f[1]))) problems.push(`${at}: ${id} names ${f[1]}, which does not exist`);
  }
}
for (const s of [...steps].sort((a, b) => (Number(a) || 1e9) - (Number(b) || 1e9))) {
  if (!cited.has(s)) problems.push(`release check step ${s} is cited by no feature (add RC-${s} to the row it proves)`);
}
if (!rows) problems.push('docs/FEATURES.md has no feature rows');

// The guide's "What Ravenry does": one "- **Area**" line per area of
// section 2 (its ### headings), and no area section 2 does not have.
const areas = (doc.split(/^## 2\./m)[1] || '').split(/^## 3\./m)[0].match(/^### .+$/gm)?.map((h) => h.slice(4).trim()) || [];
const skillSrc = fs.readFileSync(SKILL, 'utf8');
const does = (skillSrc.split('## What Ravenry does')[1] || '').split(/^## /m)[0];
if (!does) problems.push('daemon/cmd/ravenryd/skill.go: the guide has no "## What Ravenry does" section');
const said = new Set([...does.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1].toLowerCase()));
for (const a of areas) if (!said.has(a.toLowerCase())) problems.push(`daemon/cmd/ravenryd/skill.go: What Ravenry does has no line for the area "${a}" (add "- **${a}**: ..." in the person's words)`);
const known = new Set(areas.map((a) => a.toLowerCase()));
for (const s of said) if (!known.has(s)) problems.push(`daemon/cmd/ravenryd/skill.go: What Ravenry does has "${s}", which is no area of docs/FEATURES.md section 2`);
for (const p of problems) console.log(p);
console.log(problems.length
  ? `\nfeatures-check: ${problems.length} problem(s)`
  : `features-check: ${rows} features, every one of the release check's ${steps.size} steps cited, the guide's ${areas.length} areas said`);
process.exit(problems.length ? 1 : 0);
