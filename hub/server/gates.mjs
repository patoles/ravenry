// The hub's own record of plan gates (docs/PERSON.md, "A plan's gate"). A
// plan's gate lives in BRIEF.md, which the agent running the plan can edit:
// it could tick its own gate, write an Answer line under it, or take the
// gate out. So the board never takes a gate as passed from the file alone:
//
// - <RAVENRY_HOME>/plan-gates.json (mode 0600) keeps, per plan, the gates
//   the person started it with (`expected`) and the gates the person
//   passed (`passed`). Only person-checked routes write it (server/person.mjs:
//   /api/plan/start, /api/plan/answer, /api/plan/confirm, /api/plan/reopen).
// - The plan runner (server/planfmt.mjs derive, with forPlan() below) takes
//   a gate as passed only when it is in `passed`. A gate ticked ([x] or
//   [-]) in the file without it shows "Marked passed in the file, not by
//   you", and a gate the person started the plan with that is gone from the
//   file shows "Taken out of the file, not by you": the plan waits there
//   until the person confirms or reopens it.
//
// A plan is known by its brief file, its title and its Started stamp; a
// gate by its words and which of the plan's gates with those words it is
// (the first, the second), so reordering steps keeps it. An agent that
// edits any of these makes a gate unknown, which only ever makes it wait.
//
// The first hub that has this file adopts the gates already passed in the
// briefs it knows (adopt()), once, so plans that ran before the ledger
// existed do not all stop. A deleted ledger is adopted again from the
// files: like the answer key, the ledger is a file of the user's, and
// deleting it is a deliberate attack, not a mistake (docs/PERSON.md, Limits).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RAVENRY_HOME, assertDataWrite } from './home.mjs';
import { gatesOf } from './planfmt.mjs';

export const FILE = path.join(RAVENRY_HOME, 'plan-gates.json');

let data = null;

function load() {
  if (data) return data;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    data = { version: 1, adopted: j.adopted || null, plans: j.plans && typeof j.plans === 'object' ? j.plans : {} };
  } catch { data = { version: 1, adopted: null, plans: {}, missing: true }; }
  return data;
}

function save() {
  const d = load();
  try {
    assertDataWrite(FILE);
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, adopted: d.adopted, plans: d.plans }, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, FILE);
    delete d.missing;
  } catch (e) { console.error('plan gates:', e.message); }
}

const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// The key of a plan in a brief file.
export function planKey(file, plan) {
  return crypto.createHash('sha256').update([realOr(file), plan.title, plan.started || ''].join('\0')).digest('hex').slice(0, 32);
}

function entry(file, plan, make = false) {
  const d = load();
  const k = planKey(file, plan);
  if (!d.plans[k] && make) d.plans[k] = { file: realOr(file), title: plan.title, started: plan.started || null, expected: null, passed: {} };
  return d.plans[k] || null;
}

// What derive() needs for one plan of one brief: which gates the person
// passed, and which gates the person started it with (null: not known).
export function forPlan(file, plan) {
  const e = file ? entry(file, plan) : null;
  return {
    passed: (key) => !!(e && e.passed[key]),
    expected: e && Array.isArray(e.expected) ? e.expected : null,
  };
}

// A plan the person started or changed: its gates are the ones it must
// pass. A change keeps the gates already passed that are still there.
export function recordStart(file, plan) {
  const e = entry(file, plan, true);
  const keys = gatesOf(plan).map((g) => g.key);
  e.expected = keys;
  for (const k of Object.keys(e.passed)) if (!keys.includes(k)) delete e.passed[k];
  save();
}

// The person passed a gate (an answer, or a confirm of one ticked in the file).
export function recordPass(file, plan, key, { answer = null, by = 'board', how = 'answered' } = {}) {
  const e = entry(file, plan, true);
  e.passed[key] = { answer, by, how, at: new Date().toISOString() };
  if (Array.isArray(e.expected) && !e.expected.includes(key)) e.expected.push(key);
  save();
}

// The person reopened a gate: it is no longer passed.
export function forget(file, plan, key) {
  const e = entry(file, plan);
  if (e && e.passed[key]) { delete e.passed[key]; save(); }
}

// The person confirmed taking a gate out of the plan.
export function dropExpected(file, plan, key) {
  const e = entry(file, plan);
  if (e && Array.isArray(e.expected)) { e.expected = e.expected.filter((k) => k !== key); save(); }
}

// Once, when the hub first has no ledger: the gates passed in the briefs it
// knows (`briefs`: [{ file, plans }] with each plan as planfmt parses it)
// count as passed, and each plan's gates as the ones it must keep.
export function adopt(briefs) {
  const d = load();
  if (!d.missing) return false;
  for (const { file, plans } of briefs || []) {
    for (const plan of plans || []) {
      if (!plan || !plan.plan) continue;
      const e = entry(file, plan, true);
      const list = gatesOf(plan);
      e.expected = list.map((g) => g.key);
      for (const g of list) if (g.mark === 'x' || g.mark === '-') e.passed[g.key] = { answer: null, by: 'adopted', how: 'adopted', at: new Date().toISOString() };
    }
  }
  d.adopted = new Date().toISOString();
  save();
  return true;
}

// For tests.
export function _reset() { data = null; }
