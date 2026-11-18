// The demo's stand-in for the Mac (src/demo.ts) on its recording
// (src/demo/sample.json), without a page: the times moved to the visit, the
// question arriving later, an answer taken as the hub takes it, nothing
// answered that the recording does not have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { ASK_AFTER_MS, Demo, RUN_MS, keyOf, shifted } from '../src/demo.ts';
import type { Sample, Visit } from '../src/demo.ts';

const sample = JSON.parse(fs.readFileSync(new URL('../src/demo/sample.json', import.meta.url), 'utf8')) as Sample;
const at = (t0: number) => { let now = t0; return { clock: () => now, go: (ms: number) => { now += ms; } }; };
const make = (t0 = Date.parse('2027-01-05T10:00:00Z')) => { const c = at(t0); let saved: Visit | null = null; const d = new Demo(sample, null, (v) => { saved = v; }, c.clock); return { d, c, saved: () => saved }; };

test('the recording\'s times move to the visit, other numbers stay', () => {
  const o = { a: '2026-11-18T14:00:00.000Z', b: sample.capturedAt - 1000, c: 42, d: 'not a time' };
  const s = shifted(o, 3600000, sample.capturedAt);
  assert.equal(s.a, '2026-11-18T15:00:00.000Z');
  assert.equal(s.b, sample.capturedAt - 1000 + 3600000);
  assert.equal(s.c, 42);
  assert.equal(s.d, 'not a time');
});

test('a request\'s key leaves out the cache-busting v', () => {
  assert.equal(keyOf('/api/pic/x?p=shots%2Fa.png&v=123'), '/api/pic/x?p=shots%2Fa.png');
  assert.equal(keyOf('/api/live?surface=ravenry%3Aabc&v=4'), '/api/live?surface=ravenry%3Aabc');
});

test('the question arrives a few seconds into the visit; the pick and the command wait from the start', () => {
  const { d, c } = make();
  const kinds = () => d.openCheckpoints().map((x) => x.kind).sort();
  assert.deepEqual(kinds(), ['approve', 'pick']);
  assert.equal(d.alert(), null);
  c.go(ASK_AFTER_MS);
  assert.deepEqual(kinds(), ['approve', 'ask', 'pick']);
  const a = d.takeAlert();
  assert.equal(a.title, 'Demo: notes-app needs you');
  assert.match(a.detail, /Sample question\. Your answer stays on this phone\.$/);
  assert.deepEqual(a.actions.map((x: { id: string }) => x.id), ['choice:0', 'choice:1', 'open']);
  assert.equal(d.takeAlert(), null, 'once a visit');
});

test('an answer closes its card as the hub does; a command runs, then is done; nothing else is taken', () => {
  const { d, c } = make();
  c.go(ASK_AFTER_MS);
  const r = d.request('POST', '/api/checkpoints/answer', { id: sample.ask, choice: 0, by: 'phone' });
  assert.equal(r.status, 200);
  assert.equal(d.request('POST', '/api/checkpoints/answer', { id: sample.ask, choice: 1 }).status, 409, 'answered already');
  assert.ok(!d.state().checkpoints.some((x: { id: string }) => x.id === sample.ask));
  const surface = d.sample.open.state.checkpoints.find((x: { id: string }) => x.id === sample.ask).surfaceId;
  assert.match(JSON.stringify(d.live(surface, null).entries), /Got your answer/);
  d.answer({ id: sample.approve, approve: true });
  assert.equal(d.openCheckpoints().find((x) => x.id === sample.approve)?.state, 'running');
  c.go(RUN_MS + 10);
  assert.ok(!d.openCheckpoints().some((x) => x.id === sample.approve));
  assert.equal(d.request('POST', '/api/project/new', { name: 'x' }).status, 409);
  assert.equal(d.request('GET', '/api/nothing-recorded', null).status, 404);
  assert.deepEqual(d.misses, ['POST /api/project/new', 'GET /api/nothing-recorded']);
});

test('the board hears a phone, never this Mac; every session takes a message', () => {
  const { d } = make();
  assert.deepEqual(d.request('GET', '/api/whoami', null).json, { local: false });
  const st = d.state();
  assert.ok(st.projects.flatMap((p: { sessions: { live: boolean }[] }) => p.sessions || []).every((s: { live: boolean }) => s.live));
  assert.equal(st.openOn.projectId, 'paper-boat');
  const text = JSON.stringify(sample);
  for (const leak of [os.homedir(), '/private/', '/var/folders/', 'MacBook']) assert.ok(!text.includes(leak), `the recording says ${leak}`);
});
