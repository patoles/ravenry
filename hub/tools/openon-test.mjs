#!/usr/bin/env node
// Where every client opens (server/openon.mjs, docs/FEATURES.md NAV-009):
// the project of the session the person used last, on any device.
//
// 1. The rule (pick): typed, answered, opened and none known; newest wins
//    across devices; a project waiting on someone for days, listed first,
//    is never chosen for that; a session gone leaves its project; a project
//    gone leaves the next newest.
// 2. On a real hub (the demo board, apps/desktop/tools/demo-hub.mjs, on
//    127.0.0.1 with a throwaway home, shaped like the person's: a project
//    waiting on someone for days first in the list, above the ones in use):
//    state.openOn follows the last prompt typed, then an open a phone
//    reports (POST /api/opened), then a prompt typed later on the Mac;
//    an unknown project is refused; the last open is kept across a restart.
// Never touches the board on :4600.
//
// Usage: node tools/openon-test.mjs
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as openon from '../server/openon.mjs';
import { startDemoHub, freePort } from '../../apps/desktop/tools/demo-hub.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'openon-test');
let fails = 0, passes = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : ''}`); if (ok) passes++; else fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = 3600000;
const now = Date.parse('2026-11-15T20:40:00Z');
const iso = (msAgo) => new Date(now - msAgo).toISOString();

// ---------------------------------------------------------------- 1. the rule
// As the person's board: Flow review waits on someone since a week
// and is listed before the others; Kite game needs them since 16:23; Ravenry
// is the session in use.
const projects = [
  { id: 'flow-review', state: 'wait', since: iso(7 * 24 * H), sessions: [{ surfaceId: 'ravenry:pgripnaj', since: iso(7 * 24 * H) }] },
  { id: 'kite-game', state: 'you', since: iso(4.3 * H), sessions: [{ surfaceId: 'ravenry:pjru37x3', since: iso(4.3 * H) }] },
  { id: 'paper-fold', state: 'idle', since: null, sessions: [] },
  { id: 'ravenry', state: 'work', since: null, sessions: [{ surfaceId: 'ravenry:pkxhevl6', since: iso(5 * 24 * H) }, { surfaceId: 'ravenry:pcuo7kol', since: iso(60000) }] },
];
const typed = { 'ravenry:pcuo7kol': iso(2 * 60000), 'ravenry:pjru37x3': iso(4.5 * H), 'ravenry:pgripnaj': iso(7 * 24 * H) };
const typedAt = (_p, s) => typed[s.surfaceId] || null;
const activeAt = (_p, s) => s.since;
const tabOf = (cp) => 'ravenry:' + cp.pane;

let r = openon.pick(projects, { typedAt, activeAt });
check('typed: the session typed to last, not the one waiting on someone and listed first', r && r.projectId === 'ravenry' && r.surfaceId === 'ravenry:pcuo7kol' && r.key === 'ravenry/ravenry:pcuo7kol' && r.why === 'typed', r);

r = openon.pick(projects, { typedAt, activeAt, tabOf, checkpoints: [{ id: 'c1', pane: 'pjru37x3', state: 'answered', answer: { at: iso(60000), by: 'phone' } }, { id: 'c0', pane: 'pgripnaj', state: 'answered', answer: { at: iso(30 * H) } }] });
check('answered: a card answered on the phone after the last prompt', r && r.projectId === 'kite-game' && r.surfaceId === 'ravenry:pjru37x3' && r.why === 'answered', r);

r = openon.pick(projects, { typedAt, activeAt, opened: { projectId: 'paper-fold', surfaceId: null, at: iso(30000), device: 'ipad' } });
check('opened: a project opened on the iPad after that, even with no session', r && r.projectId === 'paper-fold' && r.surfaceId === null && r.key === null && r.why === 'opened' && r.device === 'ipad', r);

r = openon.pick(projects, { typedAt, activeAt, opened: { projectId: 'flow-review', surfaceId: 'ravenry:pgripnaj', at: iso(3 * H), device: 'phone' } });
check('across devices: opened on the phone at 17:40, typed on the Mac at 20:38: the Mac wins', r && r.projectId === 'ravenry' && r.why === 'typed', r);

r = openon.pick(projects, { typedAt: () => null, activeAt });
check('none known: the session active last (Ravenry), not the waiting one listed first', r && r.projectId === 'ravenry' && r.surfaceId === 'ravenry:pcuo7kol' && r.why === 'active', r);

r = openon.pick(projects, { typedAt, activeAt, opened: { projectId: 'kite-game', surfaceId: 'ravenry:gone0000', at: iso(1000), device: 'mac' } });
check('a session gone: its project, no session', r && r.projectId === 'kite-game' && r.surfaceId === null && r.why === 'opened', r);

r = openon.pick(projects, { typedAt, activeAt, opened: { projectId: 'deleted', surfaceId: null, at: iso(1000), device: 'mac' } });
check('a project gone: the next newest', r && r.projectId === 'ravenry' && r.why === 'typed', r);

check('nothing on the board: null', openon.pick([], {}) === null);

// ---------------------------------------------------------------- 2. a real hub
// The demo board with weather-widget waiting on the designer since three
// days, first in the list; its prompts: notes-app 2.2 min ago, paper-boat
// 2.3, garden-planner 4, recipe-box 11, weather-widget 74 h.
const port = await freePort();
const waitFirst = ({ MC }) => {
  const f = path.join(MC, 'projects.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const w = j.projects.find((p) => p.id === 'weather-widget');
  w.waitingOn = 'the designer';
  j.projects = [w, ...j.projects.filter((p) => p !== w)];
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
};
let hub = await startDemoHub({ dir: T, port, prepare: waitFirst });
const post = (p, body) => fetch(hub.url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) });
const openOnNow = async (want, ms = 8000) => {
  let st = null;
  for (const t0 = Date.now(); Date.now() - t0 < ms;) { st = await hub.state(); if (want(st.openOn)) break; await sleep(150); }
  return st;
};
try {
  let st = await openOnNow((o) => o && o.projectId === 'notes-app');
  const order = st.projects.map((p) => p.id);
  check('hub: the waiting project is first in the list and in Waiting on others', order[0] === 'weather-widget' && st.projects[0].state === 'wait', order.join(', '));
  check('hub: openOn is the session typed to last (notes-app)', st.openOn && st.openOn.projectId === 'notes-app' && st.openOn.why === 'typed' && st.openOn.key === 'notes-app/sf-4', st.openOn);

  let res = await post('/api/opened', { projectId: 'recipe-box', surfaceId: 'sf-2', device: 'phone' });
  const j = await res.json();
  check('hub: POST /api/opened from the phone: 200', res.status === 200 && j.ok && j.opened.projectId === 'recipe-box' && j.opened.device === 'phone', { status: res.status, j });
  st = await openOnNow((o) => o && o.projectId === 'recipe-box');
  check('hub: openOn follows the phone\'s open', st.openOn && st.openOn.projectId === 'recipe-box' && st.openOn.why === 'opened' && st.openOn.device === 'phone' && st.openOn.key === 'recipe-box/sf-2', st.openOn);

  res = await post('/api/opened', { projectId: 'no-such-project' });
  check('hub: an unknown project is refused (404), openOn unchanged', res.status === 404 && (await hub.state()).openOn.projectId === 'recipe-box', res.status);

  // The person types to garden-planner on the Mac (its transcript and its hook event).
  await sleep(1100);
  const tr = hub.transcript('garden-planner');
  const at = new Date().toISOString();
  fs.appendFileSync(tr, JSON.stringify({ type: 'user', cwd: path.join(hub.root, 'garden-planner'), sessionId: 'a1a1a1a1-0000-4000-8000-000000000001', timestamp: at, message: { role: 'user', content: 'A week before sowing.' } }) + '\n');
  fs.appendFileSync(path.join(hub.home, '.ravenry', 'events', 'a1a1a1a1-0000-4000-8000-000000000001.jsonl'), JSON.stringify({ at, event: 'UserPromptSubmit', session_id: 'a1a1a1a1-0000-4000-8000-000000000001', cwd: path.join(hub.root, 'garden-planner'), transcript_path: tr, workspace_id: 'ws-1', surface_id: 'sf-1' }) + '\n');
  st = await openOnNow((o) => o && o.projectId === 'garden-planner', 15000);
  check('hub: a prompt typed later on the Mac wins over the phone\'s open', st.openOn && st.openOn.projectId === 'garden-planner' && st.openOn.why === 'typed' && Date.parse(st.openOn.at) >= Date.parse(at) - 1000, st.openOn);

  // The last open is kept across a restart (opened.json).
  await post('/api/opened', { projectId: 'paper-boat', device: 'browser' });
  st = await openOnNow((o) => o && o.projectId === 'paper-boat');
  const kept = JSON.parse(fs.readFileSync(path.join(hub.home, '.ravenry', 'opened.json'), 'utf8'));
  check('hub: the open is written to opened.json', kept.projectId === 'paper-boat' && kept.device === 'browser', kept);
  hub.stop();
  await sleep(800);
  hub = await startDemoHub({ dir: T + '-2', port: await freePort(), prepare: (x) => { waitFirst(x); fs.writeFileSync(path.join(x.MC, 'opened.json'), JSON.stringify({ ...kept, at: new Date().toISOString() })); } });
  st = await openOnNow((o) => o && o.projectId === 'paper-boat');
  check('hub: after a restart, openOn is the open it kept', st.openOn && st.openOn.projectId === 'paper-boat' && st.openOn.why === 'opened', st.openOn);
} finally {
  hub.stop();
}
console.log(`\n${fails ? `${fails} failed` : 'all passed'} (${passes} passed)`);
process.exit(fails ? 1 : 0);
