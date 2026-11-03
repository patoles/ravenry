// Plans on the board (docs/design/Plans.dc.html): the pure parts, shared by
// the page (public/app.js) and the tests (tools/plans-test.mjs). `plan` is
// the active plan the server sends per project (server/planfmt.mjs derive):
// { title, state: running|gate|paused, gate, total, current, steps, log,
//   handoffs, startedAt }.

export const KIND = { do: 'Do', done: 'Done when', branch: 'Branch', gate: 'Gate' };

const lower = (s) => String(s || '').charAt(0).toLowerCase() + String(s || '').slice(1);

// Which glyph a step gets: its kind and where it stands.
export function glyphKey(st) {
  if (st.kind === 'gate') return st.state === 'you' ? 'gateYou' : st.state === 'done' ? 'gateDone' : 'gateTodo';
  if (st.kind === 'branch') return st.state === 'done' ? 'branch' : st.state === 'you' ? 'you' : 'branchTodo';
  if (st.state === 'done') return 'done';
  if (st.state === 'now') return 'now';
  if (st.state === 'you') return 'you';
  if (st.state === 'skip') return 'skip';
  return 'todo';
}

// The approved one-line PLAN row in Objectives (A+): a dot per step (a fork
// for a branch, a diamond for a gate), "Step N of M", and where it stands:
// "At a gate: ..." in orange with a faint orange wash, or "Running: ..." in
// blue while its session works.
export function rowModel(plan) {
  const dots = plan.steps.map((s) => {
    if (s.kind === 'gate') return s.state === 'you' ? 'G' : s.state === 'done' ? 'Gd' : 'g';
    if (s.kind === 'branch') return s.state === 'done' ? 'b' : s.state === 'you' ? 'y' : 'bt';
    return { done: 'x', now: 'n', you: 'y', skip: 's' }[s.state] || 'o';
  });
  const cur = plan.steps.find((s) => s.n === plan.current) || null;
  const count = `Step ${plan.current} of ${plan.total}`;
  let next = { cls: '', text: '' };
  let wash = '';
  if (plan.state === 'gate' && plan.gate) {
    next = { cls: 'you', text: `${plan.gate.unforeseen ? 'Stopped to ask' : 'At a gate'}: ${plan.gate.short}` };
    wash = 'gate';
  } else if (plan.state === 'paused') {
    next = { cls: '', text: `Paused at step ${plan.current}` };
  } else if (cur && cur.state === 'now') {
    next = { cls: 'now', text: `Running: ${cur.kind === 'done' ? 'done when ' + lower(cur.text) : lower(cur.text)}` };
  } else if (cur) {
    next = { cls: '', text: `Next: ${cur.kind === 'done' ? 'done when ' + lower(cur.text) : lower(cur.text)}` };
  }
  return { dots, count, next, wash };
}

// The compact flow (the Plan card, the phone's plan view): the steps in
// order, with a "Picked up after a hand-off" line before the step a fresh
// session started from. `ld`: the line under a step is green (done into
// done, now or waiting).
export function flowItems(plan) {
  const out = [];
  const n = plan.steps.length;
  plan.steps.forEach((s, i) => {
    for (const h of plan.handoffs || []) if (h.step === s.n && i > 0) out.push({ type: 'handoff', step: h.step, at: h.at });
    const nx = plan.steps[i + 1];
    out.push({ type: 'step', step: s, first: i === 0, last: i === n - 1, ld: s.state === 'done' && !!nx && ['done', 'now', 'you', 'skip'].includes(nx.state) });
  });
  return out;
}

// The status line over the full plan view.
export function statusWords(plan, clock) {
  if (plan.state === 'gate') return { cls: 'you', text: `${plan.gate && plan.gate.unforeseen ? 'Stopped to ask' : 'Waiting at the gate'}${plan.gate && plan.gate.since ? ' since ' + clock(plan.gate.since) : ''}` };
  if (plan.state === 'paused') return { cls: 'idle', text: 'Paused' };
  const cur = plan.steps.find((s) => s.n === plan.current);
  if (cur && cur.state === 'now') return { cls: 'work', text: `Working on step ${plan.current}` };
  return { cls: 'idle', text: `Next: step ${plan.current}` };
}

// The proof tiles of the gate card: the latest proofs of the finished
// steps, text ones first, then the newest screenshot.
export function gateTiles(plan, max = 3) {
  const texts = [];
  let shot = null;
  for (const s of plan.steps) {
    if (s.n >= plan.current) break;
    for (const p of s.proofs || []) {
      if (p.type === 'shot') shot = { step: s.n, ...p };
      else texts.push({ step: s.n, kind: s.kind, ...p });
    }
  }
  const pick = texts.slice(-(shot ? max - 1 : max));
  return shot ? [...pick, shot] : pick;
}
