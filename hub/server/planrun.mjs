// Running a plan: what the board writes into the brief when the user starts,
// answers, pauses, stops or changes a plan, and the words it sends the
// project's session. Every write goes through writeBriefSafe (a backup, then
// a rename) and touches only the plan's own objective. Who receives the
// words (the live session, or a new one through Revive) is decided in
// server/index.mjs.

import path from 'node:path';

import { writeBriefSafe, readBrief } from './brief.mjs';
import { parsePlanBlock, planMarkdown, insertPlan, editPlan, findPlanBlock, stepFromDraft, RULES_LINE, derive, oneLine, hm, stamp } from './planfmt.mjs';

// The rules for running a plan, as the session reads them. No single quote,
// so the text also travels as one quoted shell word (Revive's command line).
export function runRules() {
  return [
    'Rules for running a plan:',
    '(1) Work the steps in order, starting at the first step not marked [x] or [-].',
    '(2) Tick a step [x] only after adding under it a line "- Proof: <evidence> (HH:MM)" that holds real evidence: a command and its result, a number, or the path of a screenshot you looked at.',
    '(3) At a Branch, when the work answers its question, mark the arm taken [x] with its evidence and every other arm [-].',
    '(4) At a Gate, or at any outcome the plan did not foresee, mark that step [?], add under it "- Question: <your question>" and "- Choices: <a> | <b>", add a Log line, then stop and end your turn with that question.',
    '(5) Never skip a gate, and never answer one yourself.',
    '(6) When a step is done, add a Log line "- HH:MM <what happened>" under Log: at the end of the plan.',
    '(7) After a hand-off, read the plan first and carry on from the first step not ticked.',
    'When every step is done, add a last Log line and tell me in one line.',
  ].join(' ');
}

export function relBrief(project, file) {
  if (!file) return 'BRIEF.md';
  const rel = project.folder ? path.relative(project.folder, file) : file;
  return rel && !rel.startsWith('..') ? rel : file;
}

// The files the user attached while planning, as the session is told to read
// them: the plan's References, with what each one is for in their words.
// Double quotes only, so the text still travels as one quoted shell word.
export function refsSentence(refs) {
  const list = (refs || []).filter((r) => r && r.path);
  if (!list.length) return '';
  const one = (r) => `${r.path}${r.note ? ` ("${oneLine(r.note).replace(/'/g, '\u2019')}")` : ''}`;
  return `Before the first step, read the References listed under the Goal of the plan, the files I attached while we planned it, with what each is for: ${list.map(one).join('; ')}. `;
}

export function startPrompt(project, file, title, refs = []) {
  return `Run the plan "${title}" in ${relBrief(project, file)}, under ## Plan. ${refsSentence(refs)}${runRules()}`;
}

// The plan a draft becomes. A change keeps the running plan's header, its
// log and its finished steps exactly as they were.
export function planFromDraft(d, { started = stamp(), old = null } = {}) {
  const steps = d.steps.map((s) => (s.locked && s.orig ? s.orig : stepFromDraft(s)));
  return {
    title: old ? old.title : oneLine(d.title || 'Plan'),
    plan: true,
    started: old ? old.started : started,
    head: old ? old.head : null,
    goal: old ? old.goal : oneLine(d.goal),
    refs: draftRefs(d, old),
    state: null,
    stateAt: null,
    rules: RULES_LINE,
    meta: old ? old.meta : [],
    steps,
    log: old ? [...old.log, { at: hm(), text: 'Changed the plan, after you checked the steps' }] : [{ at: hm(), text: d.mode === 'own' ? 'Started from the plan you wrote, after you checked the steps' : 'Started from your words, after you checked the steps' }],
  };
}

// The draft's references as the plan keeps them: the path relative to the
// project folder and the user's words. A change keeps the running plan's ones.
export function draftRefs(d, old = null) {
  const out = [];
  const seen = new Set();
  for (const r of [...((old && old.refs) || []), ...(d.refs || [])]) {
    const p = oneLine(r.rel || r.path);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push({ path: p, note: oneLine(r.note).slice(0, 160) });
  }
  return out;
}

function activeIn(file) {
  const b = readBrief(file);
  if (!b) return null;
  for (const o of b.plan) {
    if (!o.plan) continue;
    const st = derive(o).state;
    if (st !== 'done' && st !== 'stopped') return o;
  }
  return null;
}

function fail(status, message) { const e = new Error(message); e.status = status; return e; }

// Start: write the drafted plan first under ## Plan (or, for a change,
// in place of the plan it changes).
export function writeStart(file, d) {
  if (!file) throw fail(409, 'This project has no brief yet, so there is nowhere to keep the plan. Write the brief first.');
  const running = activeIn(file);
  if (d.mode === 'change') {
    if (!running || running.title !== d.planTitle) throw fail(409, 'The plan it changes is no longer running.');
    const plan = planFromDraft(d, { old: running });
    const r = writeBriefSafe(file, (md) => editPlan(md, running.title, (p) => Object.assign(p, plan)));
    return { title: plan.title, backup: r.backup, changed: true };
  }
  if (running) throw fail(409, `"${running.title}" is still running. Stop it or change it first.`);
  let plan = planFromDraft(d);
  // Two plans never share a title, so the board can always find each one.
  const b = readBrief(file);
  const titles = new Set((b ? b.plan : []).map((o) => o.title));
  for (let k = 2; titles.has(plan.title); k++) plan = { ...plan, title: `${oneLine(d.title)} (${k})` };
  const r = writeBriefSafe(file, (md) => insertPlan(md, planMarkdown(plan)));
  return { title: plan.title, backup: r.backup, changed: false };
}

const log = (p, text) => { p.log = [...(p.log || []), { at: hm(), text }]; };

// An answer at a gate (or to a stop-and-ask): written under the step, the
// gate passed, one Log line. Returns what to tell the session.
export function writeAnswer(project, file, title, { choice, text }) {
  const answer = oneLine(choice || text);
  if (!answer) throw fail(400, 'Pick a choice or write an answer first.');
  let msg = null;
  writeBriefSafe(file, (md) => editPlan(md, title, (p) => {
    const k = p.steps.findIndex((s) => s.mark === '?');
    if (k < 0) throw fail(409, 'The plan is not waiting on you any more.');
    const s = p.steps[k];
    s.subs.push({ k: 'answer', text: choice ? answer : `"${answer}"`, at: hm() });
    // A gate is passed by the answer; a step it stopped at runs again with it.
    s.mark = s.kind === 'gate' ? 'x' : ' ';
    log(p, s.kind === 'gate' ? `Step ${k + 1}: you chose "${answer}"` : `Step ${k + 1}: you answered "${answer}"`);
    msg = s.kind === 'gate'
      ? `Plan gate at step ${k + 1} of "${title}" answered: "${answer}". It is written under the step in ${relBrief(project, file)}. Carry on with the plan. ${runRules()}`
      : `You stopped to ask at step ${k + 1} of "${title}". My answer: "${answer}". It is written under the step in ${relBrief(project, file)}. Carry on with the plan from that step. ${runRules()}`;
  }));
  return msg;
}

export function writeState(project, file, title, state) {
  let msg = null;
  writeBriefSafe(file, (md) => editPlan(md, title, (p) => {
    const d = derive(p);
    const n = d.current;
    if (state === 'running') {
      if (p.state !== 'paused') throw fail(409, 'The plan is not paused.');
      p.state = null; p.stateAt = null;
      log(p, `Resumed at step ${n}`);
      msg = `Resume the plan "${title}" in ${relBrief(project, file)}. ${runRules()}`;
      return;
    }
    if (d.state === 'done' || d.state === 'stopped') throw fail(409, 'The plan is not running.');
    p.state = state;
    p.stateAt = stamp();
    if (state === 'paused') {
      log(p, `Paused at step ${n}`);
      msg = `Pause the plan "${title}" after the step in hand: finish it or stop it safely, commit, add a Log line, and start nothing else of the plan until I resume it. It reads State: paused in ${relBrief(project, file)}.`;
    } else {
      log(p, `Stopped at step ${n}`);
      msg = `Stop the plan "${title}": start no other step of it. Finish or safely stop the step in hand, commit, and add a last Log line. It reads State: stopped in ${relBrief(project, file)}.`;
    }
  }));
  return msg;
}

// A fresh session after a hand-off: the pick-up goes in the plan's log, at
// the step it starts from.
export function writePickup(file, title) {
  let n = null;
  writeBriefSafe(file, (md) => {
    if (!findPlanBlock(md, title)) return null;
    return editPlan(md, title, (p) => { n = derive(p).current; log(p, `Picked up after a hand-off at step ${n}`); });
  });
  return n;
}

export function changedPrompt(project, file, title, refs = []) {
  return `The plan "${title}" in ${relBrief(project, file)} changed. Read it again${refs.length ? ', its References included,' : ''} and carry on from the first step not ticked. ${runRules()}`;
}

export { parsePlanBlock };
