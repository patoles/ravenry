// BRIEF.md: a project's goal, plan, notes and pictures, in plain Markdown.
// The format is in docs/BRIEF-FORMAT.md. The parser is tolerant: anything it
// does not recognise is ignored, never an error.

import fs from 'node:fs';
import path from 'node:path';

import { isPlanBlock, parsePlanBlock, planTasks } from './planfmt.mjs';
import { RAVENRY_HOME } from './home.mjs';

const SECTION_ALIASES = {
  goal: 'goal', 'done means': 'doneMeans', done: 'doneMeans', 'definition of done': 'doneMeans',
  kind: 'kind', type: 'kind', stage: 'stage', 'waiting on': 'waitingOn',
  rules: 'rules', plan: 'plan', objectives: 'plan', milestones: 'plan',
  'next step': 'next', next: 'next', 'hand-off': 'handoff', handoff: 'handoff', 'hand off': 'handoff', 'hand-backs': 'handoff',
  notes: 'notes', pictures: 'pictures', images: 'pictures', screenshots: 'pictures',
  parked: 'parked', 'quick answers': 'quickAnswers', status: 'status',
  ship: 'ship', 'ship gate': 'ship', release: 'ship',
};

const TASK_MARKS = [
  [/^\[(x|X|✓|✔)\]\s*/, 'done'],
  [/^\[(>|now|\*|wip)\]\s*/i, 'now'],
  [/^\[(\?|you|me)\]\s*/i, 'you'],
  [/^\[(~|wait|others|blocked)\]\s*/i, 'wait'],
  [/^\[\s?\]\s*/, 'todo'],
];
const TASK_TAGS = [
  [/\s*\((now|in progress|doing)\)\s*$/i, 'now'],
  [/\s*\((waiting on you|you)\)\s*$/i, 'you'],
  [/\s*\((waiting on others|waiting on someone( else)?|blocked)\)\s*$/i, 'wait'],
  [/\s*\((done)\)\s*$/i, 'done'],
];

function key(s) {
  return SECTION_ALIASES[String(s).trim().toLowerCase().replace(/[:.]+$/, '')] || null;
}

function bullet(line) {
  const m = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
  return m ? m[1].trim() : null;
}

function parseTask(text) {
  let state = null;
  let t = text;
  for (const [re, s] of TASK_MARKS) if (re.test(t)) { state = s; t = t.replace(re, ''); break; }
  for (const [re, s] of TASK_TAGS) if (re.test(t)) { state = state && state !== 'todo' ? state : s; t = t.replace(re, ''); break; }
  return { text: t.trim(), state: state || 'todo' };
}

function stripQuotes(s) {
  return s.replace(/^["“](.*)["”]$/, '$1');
}

export function parseBrief(md) {
  const brief = {
    title: null, status: null, draft: false, goal: null, doneMeans: null, kind: null, stage: null, waitingOn: null,
    rules: [], plan: [], next: null, handoff: [], quickAnswers: [], notes: [], pictures: [], parked: null, ship: [],
  };
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  let section = null;
  let objective = null;
  const text = {};
  const pushText = (k, l) => { (text[k] = text[k] || []).push(l); };

  const field = (l) => {
    const m = l.match(/^\s*(?:\*\*)?([A-Za-z][A-Za-z -]{1,24}?)(?:\*\*)?\s*:\s*(.*)$/);
    if (!m) return null;
    const k = key(m[1]);
    return k ? { k, v: m[2].trim() } : null;
  };

  for (const raw of lines) {
    const l = raw.replace(/\s+$/, '');
    let m;
    if ((m = l.match(/^#\s+(.+)$/)) && !brief.title) { brief.title = m[1].trim(); section = null; continue; }
    if ((m = l.match(/^##\s+(.+)$/))) { section = key(m[1]) || 'other'; objective = null; continue; }
    if ((m = l.match(/^###\s+(.+)$/))) {
      if (section === 'plan') { objective = { title: m[1].trim(), tasks: [], progress: null, source: null, _lines: [] }; brief.plan.push(objective); }
      continue;
    }
    // A plan objective (server/planfmt.mjs) is read from its own lines once
    // the section ends; the lines still go through the checklist rules below.
    if (section === 'plan' && objective) objective._lines.push(raw);
    if (!l.trim()) { if (section && text[section]) pushText(section, ''); continue; }

    // Key: value lines work at the top and inside Parked and Hand-off.
    const f = field(l);
    if (section === null || section === 'other') {
      if (f && ['goal', 'doneMeans', 'kind', 'stage', 'waitingOn', 'next', 'status'].includes(f.k)) { brief[f.k] = f.v || null; continue; }
      if (f && f.k === 'quickAnswers') { brief.quickAnswers = f.v.split('|').map((s) => s.trim()).filter(Boolean); continue; }
      continue;
    }
    if (section === 'parked') {
      brief.parked = brief.parked || { since: null, why: null, back: null };
      const pm = l.match(/^\s*(?:[-*]\s*)?(since|when|parked|why|back when|back|comes back when|unpark when)\s*:\s*(.*)$/i);
      if (pm) {
        const k = pm[1].toLowerCase();
        if (/^(since|when|parked)$/.test(k)) brief.parked.since = pm[2].trim();
        else if (k === 'why') brief.parked.why = pm[2].trim();
        else brief.parked.back = pm[2].trim();
      } else pushText('parked', l);
      continue;
    }
    if (section === 'plan') {
      const b = bullet(l);
      const pr = l.match(/^\s*progress\s*:\s*(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:\((.*)\))?/i);
      if (pr) {
        if (!objective) { objective = { title: 'Plan', tasks: [], progress: null, source: null }; brief.plan.push(objective); }
        objective.progress = { done: Number(pr[1]), total: Number(pr[2]) };
        objective.source = pr[3] ? pr[3].trim() : null;
        continue;
      }
      if (b != null) {
        if (!objective) { objective = { title: 'Plan', tasks: [], progress: null, source: null }; brief.plan.push(objective); }
        objective.tasks.push(parseTask(b));
      }
      continue;
    }
    if (section === 'handoff') {
      if (f && f.k === 'quickAnswers') { brief.quickAnswers = f.v.split('|').map((s) => s.trim()).filter(Boolean); continue; }
      const b = bullet(l);
      // Indented bullets (State, Next step, Open items, Key files) belong to
      // the hand-off above them, not a new one.
      if (b != null && /^\s{2,}/.test(l) && brief.handoff.length) { brief.handoff[brief.handoff.length - 1].details.push(b); continue; }
      if (b != null) {
        const hm = b.match(/^(\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?)\s*[:,-]?\s+(.*)$/);
        brief.handoff.push(hm ? { when: hm[1], text: hm[2], details: [] } : { when: null, text: b, details: [] });
      } else pushText('handoff', l);
      continue;
    }
    if (section === 'quickAnswers') {
      const b = bullet(l);
      if (b) brief.quickAnswers.push(b);
      else brief.quickAnswers.push(...l.split('|').map((s) => s.trim()).filter(Boolean));
      continue;
    }
    if (section === 'notes') {
      const b = bullet(l);
      if (b == null) continue;
      let fixed = false;
      let t = b;
      if (/^\[(x|X|✓|✔)\]\s*/.test(t)) { fixed = true; t = t.replace(/^\[[^\]]*\]\s*/, ''); }
      else if (/^\[\s?\]\s*/.test(t)) t = t.replace(/^\[\s?\]\s*/, '');
      if (/\s*\((fixed|done)\)\s*$/i.test(t)) { fixed = true; t = t.replace(/\s*\((fixed|done)\)\s*$/i, ''); }
      t = t.replace(/\s*\(added [^)]*\)\s*$/i, '');
      brief.notes.push({ text: stripQuotes(t.trim()), fixed });
      continue;
    }
    if (section === 'pictures') {
      const b = bullet(l) ?? l.trim();
      let mm;
      if ((mm = b.match(/^!\[([^\]]*)\]\(([^)]+)\)/))) brief.pictures.push({ path: mm[2].trim(), alt: mm[1].trim() });
      else if ((mm = b.match(/^`?([^`|]+?\.(?:png|jpe?g|gif|webp|avif|svg))`?\s*(?:[|:]\s*|\s+-\s+)?(.*)$/i))) brief.pictures.push({ path: mm[1].trim(), alt: mm[2].trim() });
      continue;
    }
    if (section === 'rules') {
      const b = bullet(l);
      if (b) brief.rules.push(b);
      continue;
    }
    if (section === 'ship') {
      const b = bullet(l);
      if (b) brief.ship.push(parseTask(b));
      continue;
    }
    pushText(section, l.trim());
  }
  // Plans: an objective whose lines hold a plan is read as one, with its
  // steps also as tasks so every checklist on the board still shows it.
  // Every other objective is exactly what the line rules above made of it.
  brief.plan = brief.plan.map((o) => {
    const lines = o._lines || [];
    delete o._lines;
    if (!isPlanBlock(lines)) return o;
    const p = parsePlanBlock(o.title, lines);
    return { ...p, tasks: planTasks(p), progress: null, source: null };
  });
  const para = (k) => (text[k] || []).join('\n').trim() || null;
  if (para('goal')) brief.goal = para('goal');
  if (para('doneMeans')) brief.doneMeans = para('doneMeans');
  if (para('next')) brief.next = para('next');
  if (para('kind')) brief.kind = para('kind');
  if (para('stage')) brief.stage = para('stage');
  if (para('waitingOn')) brief.waitingOn = para('waitingOn');
  if (brief.parked && !brief.parked.why && para('parked')) brief.parked.why = para('parked');
  // "status: draft (from ...), review me" marks a brief the board drafted
  // from a project's own material, until the user reviews it.
  brief.draft = /^draft\b/i.test(brief.status || '');
  return brief;
}

export function readBrief(file) {
  if (!file) return null;
  let md;
  try { md = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const b = parseBrief(md);
  b.path = file;
  return b;
}

// Appends "- [ ] text" to the end of the Notes section (creating it).
export function appendNote(file, note) {
  const md = fs.readFileSync(file, 'utf8');
  const clean = String(note).replace(/\s+/g, ' ').trim();
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const line = `- [ ] ${clean} (added ${stamp})`;
  const lines = md.replace(/\r/g, '').split('\n');
  let start = lines.findIndex((l) => /^##\s+notes\s*$/i.test(l.trim()));
  let out;
  if (start < 0) {
    out = md.replace(/\s*$/, '') + '\n\n## Notes\n' + line + '\n';
  } else {
    let end = start + 1;
    while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++;
    let at = end;
    while (at > start + 1 && !lines[at - 1].trim()) at--;
    lines.splice(at, 0, line);
    out = lines.join('\n');
  }
  fs.writeFileSync(file, out);
  return line;
}

// ------------------------------------------------------------ safe writes

// Every board write to a brief's plan goes through here: read, change, a
// timestamped backup in <RAVENRY_HOME>/backups/briefs/, then a temp file and
// a rename. `change(md)` returns the new text. When the file changed on disk
// between the read and the write (an agent editing it), the change is made
// again on the new text, once. Returns { changed, backup }.
export const BRIEF_BACKUPS = path.join(RAVENRY_HOME, 'backups', 'briefs');

function backupName(file, d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  const st = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const tag = path.basename(path.dirname(file)).replace(/[^\w.-]+/g, '-');
  return path.join(BRIEF_BACKUPS, `${tag}-${path.basename(file, '.md')}-${st}-${Math.random().toString(36).slice(2, 6)}.md`);
}

export function writeBriefSafe(file, change) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = fs.readFileSync(file, 'utf8');
    const after = change(before);
    if (after == null || after === before) return { changed: false, backup: null };
    fs.mkdirSync(BRIEF_BACKUPS, { recursive: true });
    const backup = backupName(file);
    fs.writeFileSync(backup, before);
    const tmp = file + '.ravenry-tmp';
    fs.writeFileSync(tmp, after.endsWith('\n') ? after : after + '\n');
    if (fs.readFileSync(file, 'utf8') !== before) { fs.rmSync(tmp, { force: true }); continue; }
    fs.renameSync(tmp, file);
    return { changed: true, backup };
  }
  throw new Error('The brief kept changing while the board wrote to it. Try again.');
}
