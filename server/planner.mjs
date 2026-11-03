// Plans, drafted together (docs/design/Plans.dc.html, section 1 "Planning it
// together", variant A). The user says what they want done; Claude drafts a plan
// of tagged steps (Do, Done when, Branch with if-arms, Gate) and asks at most
// two questions, only where a wrong guess would change the plan. Their rules
// come in as gates marked "From your rules". They comment on a step, drags
// steps, removes a rule gate or asks for bigger changes in the chat box;
// each revision marks only the steps it changed. "Looks right, start"
// writes the plan into the project's brief (server/planfmt.mjs) and the
// server hands it to the project's session.
//
// Model calls: `claude -p` on the user's own login with no saved session, no
// user settings or MCP servers (`--strict-mcp-config --setting-sources
// project,local`, as the mockup rounds since b3d6f5c), Sonnet, no tools (the
// brief and the rules are in the prompt), a JSON schema for the answer, and
// the answer checked again here (validateDraft). Each call logs its time and
// tokens to the board's output and to <RAVENRY_HOME>/plans/calls.jsonl.
//
// Files: the goal box, the chat box and a step's comment box take files
// (saved into the project's .inbox by the composer's route). They become the
// draft's references, each with the words the user sent it with ("I like this
// style"). A call with references gets the Read tool for exactly those files
// (`--tools Read` and one `Read(//<real path>)` allow rule each, anything
// else that would ask is refused) and runs in an empty folder, so nothing
// else is readable either. Start writes them into the plan as References.
//
// One draft per project, kept in <RAVENRY_HOME>/plans/drafts/<id>.json so a
// reload, a phone or a restart picks the conversation up where it was.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { RAVENRY_HOME } from './home.mjs';
import * as repeats from './repeats.mjs';
import { plainRule } from './rules.mjs';
import { oneLine, KINDS } from './planfmt.mjs';

export const DIR = path.join(RAVENRY_HOME, 'plans');
const DRAFTS = path.join(DIR, 'drafts');
// The working folder of a call that may read files: empty, so the only
// readable files are the ones its allow rules name.
const EMPTY = path.join(DIR, 'empty');
export const MAX_FILES = 10;
const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;
const CALLS = path.join(DIR, 'calls.jsonl');

let changed = () => {};
export function onChange(fn) { changed = fn; }

// ------------------------------------------------------------ the schema

export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'reply', 'steps', 'questions'],
  properties: {
    title: { type: 'string', description: '3 to 7 words naming the work, like a task title' },
    reply: { type: 'string', description: 'One or two plain sentences to the user' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'text', 'detail', 'arms', 'choices', 'rule'],
        properties: {
          id: { type: 'string', description: 'The id of the step you kept, or "new"' },
          kind: { type: 'string', enum: ['do', 'done', 'branch', 'gate'] },
          text: { type: 'string' },
          detail: { type: 'string', description: 'One short line under the step, or empty' },
          arms: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['if', 'then'], properties: { if: { type: 'string' }, then: { type: 'string' } } } },
          choices: { type: 'array', items: { type: 'string' } },
          rule: { type: 'string', description: 'For a gate that comes from one of the user\'s rules: its id, like R3. Else empty' },
        },
      },
    },
    questions: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['text', 'options'], properties: { text: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } } },
    },
  },
};

const KIND_SET = new Set(['do', 'done', 'branch', 'gate']);
const clip = (s, n) => { const t = oneLine(s); return t.length > n ? t.slice(0, n - 3).replace(/\s+\S*$/, '') + '...' : t; };

// The model's answer, checked and cleaned. { ok, value } or { ok: false, error }.
// `rules` maps rule ids (R1...) to their text; a gate's rule id becomes that
// text, and an unknown id is dropped rather than trusted.
export function validateDraft(data, rules = new Map()) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'The answer is not an object.' };
  const title = clip(data.title, 80);
  if (!title) return { ok: false, error: 'The plan has no title.' };
  if (!Array.isArray(data.steps) || !data.steps.length) return { ok: false, error: 'The plan has no steps.' };
  if (data.steps.length > 14) return { ok: false, error: `The plan has ${data.steps.length} steps; keep it to 14.` };
  const steps = [];
  for (const [i, s] of data.steps.entries()) {
    if (!s || typeof s !== 'object') return { ok: false, error: `Step ${i + 1} is not an object.` };
    const kind = String(s.kind || '').toLowerCase();
    if (!KIND_SET.has(kind)) return { ok: false, error: `Step ${i + 1} has the kind "${s.kind}"; it must be do, done, branch or gate.` };
    const text = clip(s.text, 200);
    if (!text) return { ok: false, error: `Step ${i + 1} has no text.` };
    const out = { id: oneLine(s.id) || 'new', kind, text, detail: clip(s.detail, 200), arms: [], choices: [], rule: null, ruleId: null };
    if (kind === 'branch') {
      const arms = (Array.isArray(s.arms) ? s.arms : []).map((a) => ({ if: clip(a && a.if, 120).replace(/^if\s+/i, ''), then: clip(a && a.then, 200) })).filter((a) => a.if && a.then);
      if (arms.length < 2 || arms.length > 3) return { ok: false, error: `Step ${i + 1} is a branch with ${arms.length} arms; give it 2 or 3.` };
      out.arms = arms;
    }
    if (kind === 'gate') {
      const ch = (Array.isArray(s.choices) ? s.choices : []).map((c) => clip(c, 60)).filter(Boolean);
      out.choices = ch.length >= 2 ? ch.slice(0, 3) : ['Go ahead', 'Not yet'];
      const rid = oneLine(s.rule).toUpperCase();
      if (rid && rules.has(rid)) { out.ruleId = rid; out.rule = rules.get(rid); }
    }
    steps.push(out);
  }
  const questions = (Array.isArray(data.questions) ? data.questions : []).slice(0, 2).map((q) => ({
    text: clip(q && q.text, 200),
    options: (Array.isArray(q && q.options) ? q.options : []).map((o) => clip(o, 60)).filter(Boolean).slice(0, 3),
  })).filter((q) => q.text && q.options.length >= 2);
  return { ok: true, value: { title, reply: clip(data.reply, 400), steps, questions } };
}

// ------------------------------------------------------------ revisions

const sig = (s) => JSON.stringify([s.kind, s.text, s.detail || '', (s.arms || []).map((a) => [a.if, a.then]), s.kind === 'gate' ? s.choices || [] : [], s.rule || '']);

// Which steps a revision changed: a kept id whose step reads differently is
// Updated, a step that was not there is Added; a step the same as before
// keeps its id and no mark. Returns { steps (with ids), marks, removed }.
export function markChanges(before, after) {
  const prev = new Map(before.map((s) => [s.id, s]));
  const used = new Set();
  const marks = {};
  let n = before.reduce((m, s) => Math.max(m, Number(String(s.id).replace(/^s/, '')) || 0), 0);
  const steps = after.map((s) => {
    let id = s.id;
    const old = prev.get(id);
    if (old && !used.has(id)) {
      used.add(id);
      if (sig(old) !== sig(s)) marks[id] = 'upd';
      return { ...s, id };
    }
    const same = before.find((b) => !used.has(b.id) && sig(b) === sig(s));
    if (same) { used.add(same.id); return { ...s, id: same.id }; }
    id = 's' + (++n);
    marks[id] = 'add';
    return { ...s, id };
  });
  const removed = before.filter((b) => !used.has(b.id)).map((b) => b.id);
  return { steps, marks, removed };
}

// ------------------------------------------------------------ the user's rules

// The user's rules, from the same files the Rules view reads: the global
// CLAUDE.md (its rule lines under each ## heading) and the project's own
// CLAUDE.md. Memory-name citations are dropped. Ids R1, R2, ...
export function collectRules(cfg, project) {
  const out = [];
  const add = (where, text) => { const t = plainRule(repeats.splitCite(text).body); if (t && out.length < 90) out.push({ id: 'R' + (out.length + 1), where, text: t }); };
  try { for (const g of repeats.mine(cfg).groups) for (const r of g.rules) add(`Every project, ${g.heading}`, r); } catch { /* no global file */ }
  const local = project && project.folder ? path.join(project.folder, 'CLAUDE.md') : null;
  if (local) {
    let md = '';
    try { md = fs.readFileSync(local, 'utf8'); } catch { /* none */ }
    for (const b of repeats.parseBlocks(md)) add(`${project.name}${b.heading ? ', ' + b.heading : ''}`, b.text);
  }
  return out;
}

// ------------------------------------------------------------ files

function fail(status, message) { const e = new Error(message); e.status = status; return e; }

function realOrNull(p) { try { return fs.realpathSync(p); } catch { return null; } }
const within = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// Files the page attached: only files the composer's route saved into this
// project's .inbox, never a path of the client's choosing. Returns
// [{ path (real, absolute), rel (from the project folder), name }].
export function inboxFiles(project, list) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return [];
  if (items.length > MAX_FILES) throw fail(400, `Attach at most ${MAX_FILES} files at a time.`);
  const folder = project && project.folder ? realOrNull(project.folder) : null;
  if (!folder) throw fail(409, 'The project folder does not exist.');
  const inbox = realOrNull(path.join(folder, '.inbox'));
  const out = [];
  for (const it of items) {
    const raw = typeof it === 'string' ? it : it && it.path;
    const abs = raw && path.isAbsolute(String(raw)) ? realOrNull(String(raw)) : null;
    if (!abs || !inbox || !within(abs, inbox) || abs === inbox) throw fail(400, 'Only files attached here, saved in the project\'s .inbox, can go with a plan.');
    let st;
    try { st = fs.statSync(abs); } catch { st = null; }
    if (!st || !st.isFile()) throw fail(400, `${path.basename(abs)} is no longer in the .inbox.`);
    if (!out.some((x) => x.path === abs)) out.push({ path: abs, rel: path.relative(folder, abs), name: path.basename(abs) });
  }
  return out;
}

// The draft's references a call may read: each still a file inside the
// project's folder. A reference that moved or left the folder is left out.
export function readableRefs(project, refs) {
  const folder = project && project.folder ? realOrNull(project.folder) : null;
  if (!folder) return [];
  const out = [];
  for (const r of refs || []) {
    const abs = realOrNull(r.path && path.isAbsolute(r.path) ? r.path : path.resolve(folder, r.rel || r.path || ''));
    if (!abs || !within(abs, folder) || abs === folder) continue;
    try { if (!fs.statSync(abs).isFile()) continue; } catch { continue; }
    if (!out.some((x) => x.path === abs)) out.push({ ...r, path: abs, rel: path.relative(folder, abs) });
  }
  return out;
}

// The argv of one model call: the plan command, with the Read tool allowed
// for exactly `files` (real absolute paths) when there are any.
export function callArgs(cfg, files = []) {
  const [cmd, ...base] = cfg.planCommand;
  const args = [...base];
  if (files.length) {
    const k = args.indexOf('--tools');
    if (k >= 0) args.splice(k, 2, '--tools', 'Read');
    else args.push('--tools', 'Read');
    args.push('--allowedTools', ...files.map((f) => `Read(/${f})`), '--permission-prompts', 'none');
  }
  args.push('--system-prompt', SYSTEM, '--json-schema', JSON.stringify(SCHEMA));
  return { cmd, args, cwd: files.length ? EMPTY : DIR };
}

// ------------------------------------------------------------ prompts

const SYSTEM = 'You turn what the user wants done in one of their projects into a plan that a Claude Code session will run there on its own, step by step. Answer only through the structured output. Plain words, no em dashes.';

function projectContext(project, brief) {
  const l = [`Project: ${project.name}`, `Folder: ${project.folder || '(none)'}`];
  if (brief) {
    for (const [k, v] of [['Goal', brief.goal], ['Done means', brief.doneMeans], ['Kind', brief.kind], ['Stage', brief.stage], ['Next step', brief.next]]) if (v) l.push(`${k}: ${oneLine(v)}`);
    const objs = (brief.plan || []).filter((o) => !o.plan).slice(0, 6);
    for (const o of objs) {
      const open = (o.tasks || []).filter((t) => t.state !== 'done').slice(0, 5).map((t) => t.text);
      l.push(`Objective in the brief: ${o.title}${open.length ? ` (open: ${open.join('; ')})` : ''}`);
    }
    for (const r of (brief.rules || []).slice(0, 12)) l.push(`Project rule in the brief: ${oneLine(r)}`);
  }
  return l.join('\n');
}

const HOW = [
  'Step kinds:',
  '- do: one action the session takes.',
  '- done: a condition that proves the work is finished, checkable with a command result, a number or a screenshot the session looks at. Write the condition, like "GestureTests pass in the editor, and a screenshot shows the trail".',
  '- branch: a question the work itself will answer, with 2 or 3 arms, each {if: the outcome, then: what to do}. Only when the outcome really changes what comes next.',
  '- gate: the session stops and asks the user, with 2 short choices (like "Ship it" and "Not yet"). Use a gate before anything they would want to see or approve first.',
  'Keep it short: 3 to 10 steps, each one line. At least one done step whose condition can be checked.',
  'The user\'s rules: add a gate for each rule below that this plan would cross, with that rule\'s id in "rule" (for example a rule asking for a picture before building anything visual, or for their call before a deploy, a push or an install). Only rules that apply to this plan; never a gate for a rule that has nothing to do with it.',
  'Questions: at most two, and only where a wrong guess would change the steps. When their words leave such a choice open (they name two options without picking one, or a detail the steps depend on is missing), ask it here, with 2 or 3 short answers, instead of choosing for them or turning it into a gate; draft the steps for the answer you think likelier. Ask nothing when the goal is clear enough.',
  'Anything the plan does not foresee is already a gate for the session, so do not add steps for that.',
];

// What the model is told about the files: each path, why the user sent it (their
// words, where they said them), and to name a file in a step that uses it.
export function filesBlock(refs) {
  if (!refs || !refs.length) return '';
  return [
    'Files the user attached (references). Read each one with the Read tool before you plan; they are part of what they want:',
    ...refs.map((r) => `- ${r.path} (${r.where || 'attached'}${r.note ? `: "${oneLine(r.note)}"` : ''})`),
    'When a step depends on one of them, name the file in that step by its path from the project folder, like "match the look of .inbox/style.png". The board also lists them under the plan as References.',
  ].join('\n');
}

function rulesBlock(rules) {
  return rules.length ? ['The user\'s rules:', ...rules.map((r) => `${r.id} (${r.where}): ${r.text}`)].join('\n') : 'The user\'s rules: none written down.';
}

const stepsJson = (steps) => JSON.stringify(steps.map((s) => ({ id: s.id, kind: s.kind, text: s.text, detail: s.detail || '', arms: s.arms || [], choices: s.choices || [], rule: s.ruleId || '', ...(s.locked ? { done: true } : {}) })), null, 1);

export function draftPrompt({ project, brief, rules, goal, own, refs = [] }) {
  return [
    projectContext(project, brief), '', rulesBlock(rules), '', ...HOW, '',
    ...(refs.length ? [filesBlock(refs), ''] : []),
    own
      ? `The user wrote the plan themselves, in their words below. Turn it into steps, keeping their words and their order. Ask a question only where their words leave a step that cannot be checked or that could go two ways. reply: one sentence, like "Here are your steps." plus why you ask, if you ask.\n\nTheir words: "${oneLine(own)}"`
      : `What the user wants done: "${oneLine(goal)}"\n\nDraft the plan. Every step gets id "new". reply: one sentence, like "Here is a draft plan." and, when you ask questions, why, in a few words ("Two questions first, because a wrong guess would change the steps:").`,
  ].join('\n');
}

export function revisePrompt({ project, brief, rules, goal, steps, asks, answers, openQuestions, refs = [] }) {
  const l = [projectContext(project, brief), '', rulesBlock(rules), '', ...HOW, '', `What the user wants done: "${oneLine(goal)}"`, '', ...(refs.length ? [filesBlock(refs), ''] : []), 'The plan now (JSON):', stepsJson(steps), ''];
  if (answers.length) l.push('The user answered your questions:', ...answers.map((a) => `- ${a.q} -> ${a.a}`), '');
  if (asks.length) l.push('The user asks for these changes:', ...asks.map((a) => `- ${a}`), '');
  l.push(openQuestions.length ? `Questions still open: ${openQuestions.map((q) => q.text).join(' | ')}. Ask them again only if they still matter.` : 'Ask no question again that they answered.');
  l.push('Revise the plan. Keep the id of every step you keep, even when you change it; a new step gets id "new". Steps marked done: true are finished, so keep them exactly as they are and in place. Change only what their answers and asks call for.');
  l.push('reply: one line saying what changed, like "Research now covers 12 games. Added: stop at the editor, no install, so the install gate is gone."');
  return l.join('\n');
}

// ------------------------------------------------------------ the model call

function logCall(rec) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(CALLS, JSON.stringify(rec) + '\n'); } catch { /* best effort */ }
  const u = rec.usage;
  console.log(`plans: ${rec.what} for ${rec.project} in ${(rec.ms / 1000).toFixed(1)} s, ${u ? `${u.in} tokens in, ${u.out} out${u.cost ? `, $${u.cost.toFixed(3)}` : ''}` : 'no usage reported'}${rec.ok ? '' : `, failed: ${rec.error}`}`);
}

export function callModel(cfg, prompt, { key, onChild, files = [] } = {}) {
  return new Promise((resolve) => {
    const { cmd, args, cwd } = callArgs(cfg, files);
    fs.mkdirSync(cwd, { recursive: true });
    let out = '';
    let err = '';
    let done = false;
    const child = spawn(cmd, args, { cwd, env: { ...process.env, MC_PLAN_JOB: key || '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    if (onChild) onChild(child);
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
      finish({ ok: false, error: `No answer after ${Math.round(cfg.planTimeoutMs / 1000)} s, so it was stopped. Try again.` });
    }, cfg.planTimeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, error: `Could not run ${path.basename(cmd)}: ${e.message}` }));
    child.on('close', (code, signal) => {
      if (signal === 'SIGTERM' && stopped.has(key)) return finish({ ok: false, error: 'Stopped.' , stopped: true });
      let j = null;
      try { j = JSON.parse(out); } catch { /* not json */ }
      if (!j) return finish({ ok: false, error: `Claude stopped without an answer (exit ${code}${(err || out).trim() ? ': ' + (err || out).trim().split('\n').pop().slice(0, 160) : ''}).` });
      const u = j.usage || {};
      const usage = { in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), out: u.output_tokens || 0, cost: j.total_cost_usd || 0, model: j.modelUsage ? Object.keys(j.modelUsage)[0] || null : null };
      let data = j.structured_output;
      if (!data && typeof j.result === 'string') { try { data = JSON.parse(j.result.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* prose */ } }
      if (j.is_error || !data) return finish({ ok: false, usage, error: `Claude gave no plan (${j.subtype || 'exit ' + code}).` });
      finish({ ok: true, data, usage });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

// ------------------------------------------------------------ drafts

const drafts = new Map();
const jobs = new Map();     // projectId -> child
const stopped = new Set();

const fileOf = (id) => path.join(DRAFTS, `${String(id).replace(/[^\w.-]+/g, '-')}.json`);
const now = () => new Date().toISOString();

export function get(id) {
  if (drafts.has(id)) return drafts.get(id);
  let d = null;
  try { d = JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); } catch { /* none */ }
  if (d && d.busy) { d.busy = null; d.error = d.error || 'The board restarted while Claude was drafting. Send it again.'; }
  drafts.set(id, d);
  return d;
}

function save(d) {
  d.updatedAt = now();
  drafts.set(d.projectId, d);
  fs.mkdirSync(DRAFTS, { recursive: true });
  const tmp = fileOf(d.projectId) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 1));
  fs.renameSync(tmp, fileOf(d.projectId));
  changed(d.projectId);
}

export function discard(id) {
  stop(id);
  drafts.set(id, null);
  try { fs.rmSync(fileOf(id), { force: true }); } catch { /* gone */ }
  changed(id);
}

export function stop(id) {
  const c = jobs.get(id);
  if (!c) return false;
  stopped.add(id);
  try { c.kill('SIGTERM'); } catch { /* gone */ }
  return true;
}

// The plan is in the brief already; Start again only delivers it.
export function markWritten(id, title) {
  const d = get(id);
  if (d) { d.written = title; save(d); }
}

// What the page gets: the draft, with the time a job has run.
export function view(id) {
  const d = get(id);
  if (!d) return null;
  const open = d.questions.filter((q) => q.answer == null);
  // Pictures among the files show as thumbnails, through the picture route.
  const pic = (f) => (IMAGE_RE.test(f.rel || '') ? { ...f, url: `/api/pic/${encodeURIComponent(d.projectId)}?plan=${encodeURIComponent(f.rel)}` } : f);
  const thread = d.thread.map((m) => (m.files ? { ...m, files: m.files.map(pic) } : m));
  return { ...d, thread, refs: (d.refs || []).map((r) => pic({ rel: r.rel, name: r.name, note: r.note })), openQuestions: open.length, canStart: !d.busy && !open.length && d.steps.length > 0 };
}

async function run(d, what, prompt, ctx, apply) {
  d.busy = { since: now(), what };
  d.error = null;
  save(d);
  const t0 = Date.now();
  const files = (ctx.refs || []).map((x) => x.path);
  let r = await callModel(ctx.cfg, prompt, { key: d.projectId, onChild: (c) => jobs.set(d.projectId, c), files });
  let v = r.ok ? validateDraft(r.data, ctx.ruleMap) : null;
  const calls = [{ ms: Date.now() - t0, usage: r.usage || null }];
  logCall({ at: now(), what, project: d.projectId, ms: calls[0].ms, usage: r.usage || null, ok: !!(v && v.ok), error: r.ok ? (v.ok ? null : v.error) : r.error, ...(files.length ? { files: files.length } : {}) });
  // One more try when the answer did not check out, saying why.
  if (r.ok && !v.ok && !stopped.has(d.projectId)) {
    const t1 = Date.now();
    r = await callModel(ctx.cfg, `${prompt}\n\nYour last answer was refused: ${v.error} Answer again.`, { key: d.projectId, onChild: (c) => jobs.set(d.projectId, c), files });
    v = r.ok ? validateDraft(r.data, ctx.ruleMap) : null;
    calls.push({ ms: Date.now() - t1, usage: r.usage || null });
    logCall({ at: now(), what: what + ' (again)', project: d.projectId, ms: calls[1].ms, usage: r.usage || null, ok: !!(v && v.ok), error: r.ok ? (v.ok ? null : v.error) : r.error });
  }
  jobs.delete(d.projectId);
  const wasStopped = stopped.delete(d.projectId);
  const cur = get(d.projectId);
  if (!cur || cur.id !== d.id) return; // discarded meanwhile
  cur.busy = null;
  cur.calls = [...(cur.calls || []), ...calls.map((c) => ({ what, ...c }))];
  if (wasStopped) { cur.error = null; save(cur); return; }
  if (!r.ok || !v.ok) { cur.error = r.ok ? `Claude's plan did not check out: ${v.error}` : r.error; save(cur); return; }
  apply(cur, v.value);
  save(cur);
}

function ctxFor(cfg, project, refs = []) {
  const rules = collectRules(cfg, project);
  return { cfg, rules, ruleMap: new Map(rules.map((r) => [r.id, r.text])), refs: readableRefs(project, refs) };
}

// New files as references of the draft and as the chips under their message.
function addRefs(d, files, note, where) {
  d.refs = d.refs || [];
  for (const f of files) if (!d.refs.some((r) => r.path === f.path)) d.refs.push({ path: f.path, rel: f.rel, name: f.name, note: oneLine(note).slice(0, 300), where, at: now() });
  return files.map((f) => ({ rel: f.rel, name: f.name }));
}

function guardBusy(d) {
  if (d && d.busy) { const e = new Error('Claude is still on the last change. Wait for it, or press Stop.'); e.status = 409; throw e; }
}

// The first draft, from the goal sentence (or from the user's own words).
export function start(project, brief, { goal, own, files }, cfg) {
  const words = oneLine(own || goal);
  if (!words) { const e = new Error(own ? 'Write the plan first.' : 'Say what you want done first.'); e.status = 400; throw e; }
  guardBusy(get(project.id));
  const attached = inboxFiles(project, files);
  const d = { id: Math.random().toString(36).slice(2, 10), projectId: project.id, mode: own ? 'own' : 'new', goal: words, title: null, thread: [], steps: [], questions: [], marks: {}, refs: [], busy: null, error: null, calls: [], createdAt: now() };
  const chips = addRefs(d, attached, words, own ? 'with the plan they wrote' : 'with what they want done');
  d.thread.push({ who: 'you', text: words, ...(chips.length ? { files: chips } : {}), at: now() });
  const ctx = ctxFor(cfg, project, d.refs);
  run(d, own ? 'structure' : 'draft', draftPrompt({ project, brief, rules: ctx.rules, goal: words, own, refs: ctx.refs }), ctx, (cur, v) => {
    let n = 0;
    cur.title = v.title;
    cur.steps = v.steps.map((s) => ({ ...s, id: 's' + (++n) }));
    const qs = v.questions.map((q, k) => ({ id: `q${k + 1}`, text: q.text, options: q.options, answer: null }));
    cur.questions = qs;
    cur.marks = {};
    cur.thread.push({ who: 'claude', text: v.reply || 'Here is a draft plan.', questions: qs.map((q) => q.id), at: now() });
  }).catch((e) => console.error('plans:', e.message));
  return d;
}

// A revision: comments on steps, a chat message, and the answers given.
export function revise(project, brief, { comment, message, files }, cfg) {
  const d = get(project.id);
  if (!d || !d.steps.length) { const e = new Error('There is no draft to change. Start a new plan.'); e.status = 409; throw e; }
  guardBusy(d);
  // Every file goes with words saying what it is for.
  const cFiles = comment ? inboxFiles(project, comment.files) : [];
  const mFiles = inboxFiles(project, files);
  if (cFiles.length && !oneLine(comment.text)) throw fail(400, 'Say what the file is for, like "I like this style".');
  if (mFiles.length && !oneLine(message)) throw fail(400, 'Say what the file is for, like "I like this style".');
  const asks = [];
  if (comment && oneLine(comment.text)) {
    const k = d.steps.findIndex((s) => s.id === comment.step);
    if (k < 0) { const e = new Error('That step is no longer in the plan.'); e.status = 409; throw e; }
    const line = `Comment on step ${k + 1}: ${oneLine(comment.text)}`;
    const chips = addRefs(d, cFiles, comment.text, `with their comment on step ${k + 1}, "${d.steps[k].text}"`);
    asks.push(`${line} (the step "${d.steps[k].text}")${chips.length ? ` (with ${chips.map((c) => c.rel).join(', ')})` : ''}`);
    d.thread.push({ who: 'you', text: line, ...(chips.length ? { files: chips } : {}), at: now() });
  }
  if (message && oneLine(message)) {
    const chips = addRefs(d, mFiles, message, 'with their message');
    asks.push(`${oneLine(message)}${chips.length ? ` (with ${chips.map((c) => c.rel).join(', ')})` : ''}`);
    d.thread.push({ who: 'you', text: oneLine(message), ...(chips.length ? { files: chips } : {}), at: now() });
  }
  const answers = d.questions.filter((q) => q.answer != null && !q.applied).map((q) => ({ q: q.text, a: q.answer }));
  if (!asks.length && !answers.length) { const e = new Error('Say what to change first.'); e.status = 400; throw e; }
  const ctx = ctxFor(cfg, project, d.refs);
  const open = d.questions.filter((q) => q.answer == null);
  const before = d.steps.map((s) => ({ ...s }));
  run(d, 'revise', revisePrompt({ project, brief, rules: ctx.rules, goal: d.goal, steps: before, asks, answers, openQuestions: open, refs: ctx.refs }), ctx, (cur, v) => {
    // Finished steps of a running plan stay exactly as they were.
    const lockedIds = new Set(before.filter((s) => s.locked).map((s) => s.id));
    const m = markChanges(before, v.steps.map((s) => (lockedIds.has(s.id) ? before.find((b) => b.id === s.id) : s)));
    for (const b of before) if (b.locked && !m.steps.some((s) => s.id === b.id)) m.steps.unshift(b);
    cur.steps = m.steps;
    cur.marks = m.marks;
    cur.title = cur.mode === 'change' ? cur.title : v.title || cur.title;
    for (const q of cur.questions) if (q.answer != null) q.applied = true;
    // Open questions the revision still asks stay; ones it dropped go.
    const still = v.questions.map((q) => q.text);
    cur.questions = cur.questions.filter((q) => q.answer != null || still.includes(q.text));
    const fresh = v.questions.filter((q) => !cur.questions.some((x) => x.text === q.text)).map((q, k) => ({ id: `q${cur.questions.length + k + 1}`, text: q.text, options: q.options, answer: null }));
    cur.questions.push(...fresh);
    cur.thread.push({ who: 'claude', text: v.reply || 'Revised.', revised: true, questions: fresh.map((q) => q.id), at: now() });
  }).catch((e) => console.error('plans:', e.message));
  return d;
}

// Local edits, no model call: an answer to a question, a new order, a rule
// gate removed. Answering the last open question sends the answers to
// Claude for a revision, so the plan always reflects them before it starts.
export function edit(project, brief, { answer, order, remove }, cfg) {
  const d = get(project.id);
  if (!d) { const e = new Error('There is no draft.'); e.status = 409; throw e; }
  guardBusy(d);
  if (answer) {
    const q = d.questions.find((x) => x.id === answer.id);
    if (!q) { const e = new Error('That question is gone.'); e.status = 409; throw e; }
    if (!q.options.includes(answer.option)) { const e = new Error('Pick one of its answers.'); e.status = 400; throw e; }
    q.answer = answer.option;
  }
  if (Array.isArray(order)) {
    const by = new Map(d.steps.map((s) => [s.id, s]));
    if (order.length !== d.steps.length || order.some((id) => !by.has(id))) { const e = new Error('The steps changed meanwhile. Try the move again.'); e.status = 409; throw e; }
    const moved = order.map((id) => by.get(id));
    const lockedOk = d.steps.every((s, k) => !s.locked || moved[k] === s);
    if (!lockedOk) { const e = new Error('Finished steps stay where they are.'); e.status = 409; throw e; }
    d.steps = moved;
  }
  if (remove) {
    const s = d.steps.find((x) => x.id === remove);
    if (!s) { const e = new Error('That step is already gone.'); e.status = 409; throw e; }
    if (s.locked) { const e = new Error('That step is finished, so it stays.'); e.status = 409; throw e; }
    d.steps = d.steps.filter((x) => x.id !== remove);
    d.thread.push({ who: 'you', text: `Removed step: ${s.text}`, local: true, at: now() });
  }
  save(d);
  if (answer && !d.questions.some((q) => q.answer == null)) return revise(project, brief, {}, cfg);
  return d;
}

// "Change the plan": a draft made from the running plan, its finished steps
// locked in place.
export function fromPlan(project, plan) {
  guardBusy(get(project.id));
  let n = 0;
  const steps = plan.steps.map((s) => {
    const done = s.mark === 'x' || s.mark === '-';
    const arms = s.subs.filter((x) => x.k === 'arm').map((a) => ({ if: a.cond, then: a.then }));
    const ch = s.subs.find((x) => x.k === 'choices');
    const note = s.subs.find((x) => x.k === 'note');
    const rule = s.subs.find((x) => x.k === 'rule');
    return { id: 's' + (++n), kind: s.kind, text: s.text, detail: note ? note.text : '', arms, choices: ch ? ch.list : [], rule: rule ? rule.text : null, ruleId: null, locked: done || undefined, orig: s };
  });
  // The running plan's references stay references, readable again.
  const refs = (plan.refs || []).map((r) => ({ path: project.folder ? path.resolve(project.folder, r.path) : r.path, rel: r.path, name: path.basename(r.path), note: r.note, where: 'a reference of the running plan' }));
  const d = { id: Math.random().toString(36).slice(2, 10), projectId: project.id, mode: 'change', planTitle: plan.title, goal: plan.goal || plan.title, title: plan.title, thread: [{ who: 'claude', text: 'Here is the plan as it runs now. Finished steps stay; say what to change.', at: now() }], steps, questions: [], marks: {}, refs, busy: null, error: null, calls: [], createdAt: now() };
  save(d);
  return d;
}

export { KINDS };
