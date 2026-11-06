// Plans in a brief (docs/BRIEF-FORMAT.md, "Plans"; docs/design/Plans.dc.html,
// the brief-format section). A plan is one objective under the brief's
// `## Plan`, so today's board already reads it as a checklist and both the user
// and the agent can edit it in any editor:
//
//   ### Long notes on the paths
//   Runs on its own. Started: 2026-11-03 14:02. Not in the plan: stop and ask.
//   Goal: "Make long notes on the paths feel good"
//   References:
//     - .inbox/trail-look.png: I like this style
//   Rules: work the steps in order; ...
//
//   - [x] Do: Research how other rhythm games show long notes
//     - Proof: 6 of 9 use a held trail, 2 a ribbon, 1 neither. docs/research/long-notes.md (14:40)
//   - [x] Branch: What do most of them use?
//     - [x] If a held trail: build the trail. Taken, 6 of 9 (14:41)
//     - [-] If a ribbon: mock up the trail and the ribbon side by side
//   - [?] Gate: Ask me before installing on the headset
//     - Choices: Install on the headset | Not yet
//     - Question: The trail is built and the test passes. Install it now?
//   - [ ] Do: Install on the headset
//
//   Log:
//   - 14:02 Started from your words, after you checked the steps
//
// Marks: [x] done, [ ] to do, [?] at a gate (or stopped to ask), [-] a branch
// arm (or step) not taken, [>] being worked on. Pure functions only: the
// server reads and writes briefs through server/brief.mjs.

export const KINDS = { do: 'Do', done: 'Done when', branch: 'Branch', gate: 'Gate' };
const KIND_OF = { do: 'do', 'done when': 'done', branch: 'branch', gate: 'gate' };
const KIND_RE = /^(Do|Done when|Branch|Gate)\s*:\s*(.*)$/i;
const MARK_RE = /^\[( |x|X|\?|-|>)\]\s*/;
const MARK_STATE = { ' ': 'todo', x: 'done', X: 'done', '?': 'you', '-': 'skip', '>': 'now' };
const AT_RE = /\s*\(((?:\d{4}-\d{2}-\d{2}[ T])?\d{1,2}:\d{2})\)\s*$/;
const HEAD_RE = /^Runs on its own\b/i;

// The rules every plan runs by, written into the plan's Rules line so a
// session that only reads the brief (a fresh one after a hand-off) knows
// them too. The same rules go in the start prompt (server/planner.mjs).
export const RULES_LINE = 'work the steps in order; tick a step [x] only with a Proof line holding real evidence (a command result, a number, a screenshot path you looked at); at a Gate, or at any outcome the plan did not foresee, mark it [?], write the Question and the Choices here, then stop and end your turn with the question; never skip a gate; after a hand-off, read this plan first and carry on from the first step not ticked.';

export const ALWAYS_ON = [
  "Anything the plan didn't foresee is a gate: it stops and asks you.",
  'Each step shows its proof before the next one starts.',
];

const indentOf = (l) => (l.match(/^(\s*)/)[1].replace(/\t/g, '  ')).length;
const bulletText = (l) => { const m = l.match(/^\s*[-*+]\s+(.*)$/); return m ? m[1].replace(/\s+$/, '') : null; };

function splitAt(text) {
  const m = text.match(AT_RE);
  return m ? { text: text.slice(0, m.index).trim(), at: m[1] } : { text: text.trim(), at: null };
}

// Does this objective (its lines after the ### title) hold a plan?
export function isPlanBlock(lines) {
  for (const l of lines) {
    if (HEAD_RE.test(l.trim())) return true;
    const b = bulletText(l);
    if (b != null && indentOf(l) < 2) {
      const t = b.replace(MARK_RE, '');
      if (MARK_RE.test(b) && KIND_RE.test(t)) return true;
    }
  }
  return false;
}

function parseSub(b) {
  const mk = b.match(MARK_RE);
  if (mk && /^If\b/i.test(b.slice(mk[0].length))) {
    const rest = b.slice(mk[0].length);
    const { text, at } = splitAt(rest);
    const m = text.match(/^If\s+(.*?)\s*:\s*(.*)$/i);
    let cond = m ? m[1] : text.replace(/^If\s+/i, '');
    let then = m ? m[2] : '';
    let note = null;
    const tk = then.match(/\.?\s*Taken(?:,\s*(.*?))?\.?$/i);
    if (tk && mk[1] !== ' ' && mk[1] !== '-') { note = tk[1] ? tk[1].trim() : ''; then = then.slice(0, tk.index).trim(); }
    return { k: 'arm', mark: mk[1] === 'X' ? 'x' : mk[1], cond: cond.trim(), then: then.trim(), note, at };
  }
  let m;
  if ((m = b.match(/^Proof\s*:\s*(.*)$/i))) return { k: 'proof', ...splitAt(m[1]) };
  if ((m = b.match(/^Note\s*:\s*(.*)$/i))) return { k: 'note', text: m[1].trim() };
  if ((m = b.match(/^From your rules\s*:\s*(.*)$/i))) return { k: 'rule', text: m[1].trim() };
  if ((m = b.match(/^Choices\s*:\s*(.*)$/i))) return { k: 'choices', list: m[1].split('|').map((s) => s.trim()).filter(Boolean) };
  if ((m = b.match(/^Question\s*:\s*(.*)$/i))) return { k: 'question', text: m[1].trim() };
  if ((m = b.match(/^Answer\s*:\s*(.*)$/i))) return { k: 'answer', ...splitAt(m[1]) };
  if ((m = b.match(/^Hand-?off here\b(.*)$/i))) return { k: 'handoff', at: splitAt(m[1]).at };
  return { k: 'other', text: b };
}

// lines: the objective's lines after its ### title.
export function parsePlanBlock(title, lines) {
  const plan = { title, plan: true, started: null, head: null, goal: null, refs: [], state: null, stateAt: null, rules: null, meta: [], steps: [], log: [] };
  let inLog = false;
  let inRefs = false;
  let step = null;
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, '');
    if (!l.trim()) continue;
    const b = bulletText(l);
    const ind = indentOf(l);
    // References: the files the user attached while planning, one indented
    // bullet each, under the header and before the first step.
    if (inRefs && b != null && ind >= 2 && !step && !inLog) { plan.refs.push(parseRef(b)); continue; }
    inRefs = false;
    if (b == null) {
      const t = l.trim();
      let m;
      if (/^Log\s*:\s*$/i.test(t)) { inLog = true; step = null; continue; }
      if (!step && !inLog && /^References\s*:\s*$/i.test(t)) { inRefs = true; continue; }
      if (HEAD_RE.test(t)) {
        plan.head = t;
        const s = t.match(/Started:\s*(\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2})/i);
        if (s) plan.started = s[1].replace('T', ' ');
        continue;
      }
      if ((m = t.match(/^(?:Goal|In your words)\s*:\s*(.*)$/i))) { plan.goal = m[1].trim().replace(/^["“](.*)["”]$/, '$1'); continue; }
      if ((m = t.match(/^State\s*:\s*(\w+)(?:\s*\(([^)]*)\))?/i))) { plan.state = m[1].toLowerCase(); plan.stateAt = m[2] ? m[2].trim() : null; continue; }
      if ((m = t.match(/^Rules\s*:\s*(.*)$/i))) { plan.rules = m[1].trim(); continue; }
      plan.meta.push(t);
      continue;
    }
    if (inLog) {
      const m = b.match(/^((?:\d{4}-\d{2}-\d{2}[ T])?\d{1,2}:\d{2})\s+(.*)$/);
      plan.log.push(m ? { at: m[1].replace('T', ' '), text: m[2].trim() } : { at: null, text: b.trim() });
      continue;
    }
    if (ind >= 2 && step) { step.subs.push(parseSub(b)); continue; }
    const mk = b.match(MARK_RE);
    const rest = mk ? b.slice(mk[0].length) : b;
    const km = rest.match(KIND_RE);
    step = { kind: km ? KIND_OF[km[1].toLowerCase()] : 'do', mark: mk ? (mk[1] === 'X' ? 'x' : mk[1]) : ' ', text: (km ? km[2] : rest).trim(), subs: [] };
    plan.steps.push(step);
  }
  return plan;
}

// A reference bullet: "<path relative to the project folder>: <what it is
// for, in the user's words>", or the path alone.
export function parseRef(b) {
  const m = String(b).trim().match(/^(\S+?):\s+(.*)$/);
  return m ? { path: m[1], note: m[2].trim() } : { path: String(b).trim().replace(/:$/, ''), note: '' };
}

const refLine = (r) => `  - ${r.path}${r.note ? ': ' + r.note : ''}`;

function subLine(s) {
  const at = (x) => (x ? ` (${x})` : '');
  switch (s.k) {
    case 'arm': return `[${s.mark}] If ${s.cond}: ${s.then}${s.note != null ? `. Taken${s.note ? ', ' + s.note : ''}` : ''}${at(s.at)}`;
    case 'proof': return `Proof: ${s.text}${at(s.at)}`;
    case 'note': return `Note: ${s.text}`;
    case 'rule': return `From your rules: ${s.text}`;
    case 'choices': return `Choices: ${s.list.join(' | ')}`;
    case 'question': return `Question: ${s.text}`;
    case 'answer': return `Answer: ${s.text}${at(s.at)}`;
    case 'handoff': return `Hand-off here${at(s.at)}`;
    default: return s.text;
  }
}

// The canonical Markdown of a plan objective, ### title included.
export function planMarkdown(plan) {
  const out = [`### ${plan.title}`];
  out.push(plan.head || `Runs on its own.${plan.started ? ` Started: ${plan.started}.` : ''} Not in the plan: stop and ask.`);
  if (plan.goal) out.push(`Goal: "${plan.goal}"`);
  if (plan.refs && plan.refs.length) out.push('References:', ...plan.refs.map(refLine));
  if (plan.state && plan.state !== 'running') out.push(`State: ${plan.state}${plan.stateAt ? ` (${plan.stateAt})` : ''}`);
  if (plan.rules) out.push(`Rules: ${plan.rules}`);
  for (const m of plan.meta || []) out.push(m);
  out.push('');
  for (const s of plan.steps) {
    out.push(`- [${s.mark}] ${KINDS[s.kind] || 'Do'}: ${s.text}`);
    for (const x of s.subs) out.push(`  - ${subLine(x)}`);
  }
  if (plan.log && plan.log.length) {
    out.push('', 'Log:');
    for (const e of plan.log) out.push(`- ${e.at ? e.at + ' ' : ''}${e.text}`);
  }
  return out.join('\n');
}

// For today's checklists: each step as a task with the brief's states.
export function planTasks(plan) {
  return plan.steps.map((s) => ({ text: `${KINDS[s.kind]}: ${s.text}`, state: s.mark === '-' ? 'done' : MARK_STATE[s.mark] || 'todo' }));
}

// ------------------------------------------------------------ reading a plan

// "14:40" or "2026-11-03 14:40" to an ISO time. Times without a date follow
// the plan's start: each one is on the day of the time before it, or the
// next day when the clock went backwards.
function timeline(plan) {
  let cur = plan.started ? new Date(plan.started.replace(' ', 'T')) : null;
  return (s) => {
    if (!s) return null;
    const full = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/);
    if (full) { cur = new Date(`${full[1]}T${full[2].padStart(2, '0')}:${full[3]}`); return cur.toISOString(); }
    const hm = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!hm || !cur) return null;
    const d = new Date(cur);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d < cur && cur - d > 60000) d.setDate(d.getDate() + 1);
    cur = d;
    return d.toISOString();
  };
}

const IMG = /(?:^|[\s(:;,])((?:~|\.{0,2}\/|[\w.-]+\/)?[\w./@+-]*\.(?:png|jpe?g|webp|gif))\b/i;
// One proof as the board shows it: a screenshot path, a test line, or text.
export function proofKind(text) {
  const m = String(text).match(IMG);
  if (m) return { type: 'shot', path: m[1], text };
  if (/\b\d+\s+(passed|failed|passing|tests?)\b/i.test(text) || /\bexit\s+0\b/i.test(text)) return { type: 'test', text };
  return { type: 'text', text };
}

// Everything the board shows about a plan: per step its state and proof,
// the step being worked, the gate it waits at, the hand-offs, and the plan's
// own state. `working` is whether the project's session is working now.
export function derive(plan, { working = false } = {}) {
  const t = timeline(plan);
  const startedAt = t(plan.started);
  const steps = plan.steps.map((s, i) => {
    const out = { n: i + 1, kind: s.kind, mark: s.mark, text: s.text, state: MARK_STATE[s.mark] || 'todo', proofs: [], arms: [], choices: [], question: null, answer: null, rule: null, note: null, handoffAt: null, at: null };
    for (const x of s.subs) {
      if (x.k === 'proof') { const at = t(x.at); out.proofs.push({ ...proofKind(x.text), at }); if (at) out.at = at; }
      else if (x.k === 'arm') { const at = t(x.at); out.arms.push({ state: MARK_STATE[x.mark] || 'todo', cond: x.cond, then: x.then, note: x.note, at }); if (at) out.at = at; }
      else if (x.k === 'choices') out.choices = x.list;
      else if (x.k === 'question') out.question = x.text;
      else if (x.k === 'answer') { out.answer = { text: x.text, at: t(x.at) }; if (out.answer.at) out.at = out.answer.at; }
      else if (x.k === 'rule') out.rule = x.text;
      else if (x.k === 'note') out.note = x.text;
      else if (x.k === 'handoff') out.handoffAt = t(x.at);
    }
    return out;
  });
  const tl = timeline(plan);
  const log = (plan.log || []).map((e) => ({ at: tl(e.at), text: e.text }));
  const handoffs = [];
  for (const e of log) {
    const m = e.text.match(/picked up after a hand-off at step (\d+)/i);
    if (m) handoffs.push({ step: Number(m[1]), at: e.at });
  }
  for (const s of steps) if (s.handoffAt && !handoffs.some((h) => h.step === s.n + 1)) handoffs.push({ step: s.n + 1, at: s.handoffAt });
  const cur = steps.find((s) => s.state !== 'done' && s.state !== 'skip') || null;
  let state = 'running';
  if (plan.state === 'stopped') state = 'stopped';
  else if (!cur || plan.state === 'done') state = 'done';
  else if (cur.state === 'you') state = 'gate';
  else if (plan.state === 'paused') state = 'paused';
  if (cur && state === 'running' && working) cur.state = 'now';
  else if (cur && cur.state === 'todo' && state === 'running') cur.state = 'next';
  let gate = null;
  if (state === 'gate') {
    const q = cur.question || (cur.kind === 'gate' ? cur.text : null);
    gate = {
      n: cur.n, kind: cur.kind, text: cur.text, unforeseen: cur.kind !== 'gate', rule: cur.rule,
      question: q || cur.text,
      choices: cur.choices.length ? cur.choices : cur.kind === 'gate' ? ['Go ahead', 'Not yet'] : [],
      short: shortQuestion(q || cur.text),
      since: log.length ? log[log.length - 1].at : null,
    };
  }
  const times = [startedAt, ...steps.map((s) => s.at), ...log.map((e) => e.at)].filter(Boolean).sort();
  return {
    title: plan.title, goal: plan.goal, refs: (plan.refs || []).map((r) => ({ path: r.path, note: r.note, image: /\.(png|jpe?g|webp|gif)$/i.test(r.path) })), started: plan.started, startedAt, state, gate,
    total: steps.length, current: cur ? cur.n : steps.length, steps, log, handoffs,
    lastAt: times.length ? times[times.length - 1] : null,
  };
}

// The gate's question, short enough for a list row and a phone alert:
// its last question sentence, at most 60 characters, lower case first.
export function shortQuestion(q) {
  const s = String(q || '').replace(/\s+/g, ' ').trim();
  // Sentences end at . ! or ? followed by a space and a new sentence, so a
  // file name (greeting.md) or a number (1.5) never splits one.
  const parts = s.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/);
  const qs = parts.filter((x) => /\?["”)]?$/.test(x.trim()));
  let t = (qs.length ? qs[qs.length - 1] : s).trim();
  if (t.length > 60) t = t.slice(0, 57).replace(/\s+\S*$/, '') + '...';
  return t.charAt(0).toLowerCase() + t.slice(1);
}

// The active plan of a brief: the first plan objective that is not done or
// stopped. Finished ones stay in the brief as checklists.
export function activePlan(objectives, opts) {
  for (const o of objectives || []) {
    if (!o.plan) continue;
    const d = derive(o, opts);
    if (d.state !== 'done' && d.state !== 'stopped') return d;
  }
  return null;
}

// ------------------------------------------------------------ writing

// The lines of the `### title` objective under `## Plan`: [start, end) with
// trailing blank lines left outside, or null.
export function findPlanBlock(md, title) {
  const lines = String(md).replace(/\r/g, '').split('\n');
  let inPlan = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^##\s+/.test(l)) { inPlan = /^##\s+(plan|objectives|milestones)\s*$/i.test(l.trim()); continue; }
    if (inPlan && /^###\s+/.test(l) && l.replace(/^###\s+/, '').trim() === title) {
      let j = i + 1;
      while (j < lines.length && !/^#{1,3}\s/.test(lines[j])) j++;
      while (j > i + 1 && !lines[j - 1].trim()) j--;
      return { start: i, end: j, lines };
    }
  }
  return null;
}

// Puts a new plan objective first under `## Plan`, making the section (before
// Next step or Hand-off, else at the end) when the brief has none.
export function insertPlan(md, block) {
  const src = String(md).replace(/\r/g, '');
  const lines = src.split('\n');
  const at = lines.findIndex((l) => /^##\s+(plan|objectives|milestones)\s*$/i.test(l.trim()));
  const body = block.split('\n');
  if (at >= 0) {
    let k = at + 1;
    while (k < lines.length && !lines[k].trim()) k++;
    lines.splice(at + 1, k - (at + 1), ...body, '');
    return lines.join('\n');
  }
  const before = lines.findIndex((l) => /^##\s+(next step|next|hand-?off|notes|pictures|ship|parked)\s*$/i.test(l.trim()));
  if (before >= 0) {
    lines.splice(before, 0, '## Plan', ...body, '');
    return lines.join('\n');
  }
  return src.replace(/\s*$/, '') + '\n\n## Plan\n' + block + '\n';
}

// Replaces the `### title` objective with `block`. Every line outside it
// stays exactly as it was.
export function replacePlan(md, title, block) {
  const f = findPlanBlock(md, title);
  if (!f) throw new Error(`The brief has no plan called "${title}" under ## Plan.`);
  const out = [...f.lines.slice(0, f.start), ...block.split('\n'), ...f.lines.slice(f.end)];
  return out.join('\n');
}

// Reads the plan objective `title` from the brief text, lets `fn` change it,
// and returns the new brief text.
export function editPlan(md, title, fn) {
  const f = findPlanBlock(md, title);
  if (!f) throw new Error(`The brief has no plan called "${title}" under ## Plan.`);
  const plan = parsePlanBlock(title, f.lines.slice(f.start + 1, f.end));
  fn(plan);
  return replacePlan(md, title, planMarkdown(plan));
}

export function hm(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function stamp(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm(d)}`;
}

// A drafted step (server/planner.mjs) as a plan step.
export function stepFromDraft(d) {
  const subs = [];
  if (d.detail) subs.push({ k: 'note', text: oneLine(d.detail) });
  if (d.kind === 'branch') for (const a of d.arms || []) subs.push({ k: 'arm', mark: ' ', cond: oneLine(a.if).replace(/^if\s+/i, ''), then: oneLine(a.then), note: null, at: null });
  if (d.kind === 'gate') subs.push({ k: 'choices', list: (d.choices && d.choices.length ? d.choices : ['Go ahead', 'Not yet']).map(oneLine) });
  if (d.rule) subs.push({ k: 'rule', text: oneLine(d.rule) });
  return { kind: d.kind, mark: d.mark || ' ', text: oneLine(d.text), subs: d.subs ? d.subs : subs };
}

// No em dashes in anything the board writes (a rule of the board).
export function oneLine(s) {
  return String(s ?? '').replace(/\s*\u2014\s*/g, ', ').replace(/\s+/g, ' ').trim();
}
