// What the window offers of the switch from the npm board, and how the hub
// script is run (src/main/npmswitch.ts). The switch itself is proved in
// hub/tools/npmswitch-test.mjs and, with the real npm board and the
// packaged app, tools/npm-switch-test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchPlan, mayRunHub, offerFor, runScript, scriptPath } from '../src/main/npmswitch.ts';
import type { NpmDetect } from '../src/main/npmswitch.ts';

const found = (over: Partial<NpmDetect> = {}): NpmDetect => ({ ok: true, npm: true, board: null, login: [], hooks: { claude: [], codex: [] }, copy: null, record: null, ...over });

test('offerFor: the screen the first time, the bar after Not now or the way back, nothing without an npm board', () => {
  assert.equal(offerFor(null, null), 'none');
  assert.equal(offerFor({ ...found(), ok: false }, null), 'none');
  assert.equal(offerFor(found({ npm: false }), null), 'none');
  assert.equal(offerFor(found(), null), 'screen');
  assert.equal(offerFor(found(), 'not-now'), 'bar');
  assert.equal(offerFor(found(), 'back'), 'bar');
  assert.equal(offerFor(found({ record: { state: 'back' } as NpmDetect['record'] }), null), 'bar');
});

test('mayRunHub: never beside an npm board (its board, login start or hooks)', () => {
  assert.equal(mayRunHub(null), true);
  assert.equal(mayRunHub(found({ npm: false })), true);
  assert.equal(mayRunHub(found()), false);
  // A look that failed does not stop the app's own hub.
  assert.equal(mayRunHub({ ...found(), ok: false }), true);
});

test('launchPlan: the app\'s hub is brought up to this build from every starting state, and never runs beside an npm board', () => {
  const switched = { state: 'switched' } as NpmDetect['record'];
  const ownHub = { port: 4600, pid: 1, command: 'Ravenry versions/0.1.0/hub/server/index.mjs', cwd: null, root: '/d/versions/0.1.0/hub', version: '0.4.0', own: true };
  const npmBoard = { ...ownHub, command: 'node ravenry', root: '/n/ravenry-app', own: false };
  const codexHooks = { claude: [], codex: [{ event: 'Stop', command: 'node /n/ravenry-app/hooks/events.mjs --assistant=codex' }] };
  // First launch: nothing of npm's, no service.
  assert.equal(launchPlan(found({ npm: false }), false), 'hub');
  // A look that failed.
  assert.equal(launchPlan({ ...found(), ok: false }, false), 'hub');
  // Installed by the switch, its hub (0.1.0) answering, a new build, nothing of npm's left.
  assert.equal(launchPlan(found({ npm: false, board: ownHub, record: switched }), true), 'hub');
  // The same, with the npm board's Codex hooks left by the first switch (2026-11-07): finish it, then the hub.
  assert.equal(launchPlan(found({ board: ownHub, hooks: codexHooks, record: switched }), true), 'finish');
  // The service installed by an earlier version, no record, hooks left: finish too.
  assert.equal(launchPlan(found({ hooks: codexHooks }), true), 'finish');
  // A login start of npm's not loaded, after the switch: finish.
  assert.equal(launchPlan(found({ login: [{ label: 'x', plist: '/p', loaded: false, root: null, version: null }], record: switched }), true), 'finish');
  // An npm board serving the data, or one launchd starts: the offer, no hub, even when the app's service is installed.
  assert.equal(launchPlan(found({ board: npmBoard, record: switched }), true), 'offer');
  assert.equal(launchPlan(found({ login: [{ label: 'x', plist: '/p', loaded: true, root: null, version: null }], record: switched }), true), 'offer');
  // Never switched: the offer.
  assert.equal(launchPlan(found({ hooks: codexHooks }), false), 'offer');
  // Gone back to the npm board: the bar, no hub.
  assert.equal(launchPlan(found({ hooks: codexHooks, record: { state: 'back' } as NpmDetect['record'] }), false), 'offer');
});

test('scriptPath: beside the hub server', () => {
  assert.equal(scriptPath('/d/versions/0.1.0/hub/server/index.mjs'), '/d/versions/0.1.0/hub/server/npmswitch.mjs');
});

test('runScript: the JSON it prints, its log lines as they come, and a clear error when it prints none', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-npmswitch-'));
  const ok = path.join(dir, 'ok.mjs');
  fs.writeFileSync(ok, "process.stderr.write('one\\ntwo\\n'); console.log(JSON.stringify({ ok: true, asNode: process.env.ELECTRON_RUN_AS_NODE, args: process.argv.slice(2), execArgv: process.execArgv }));\n");
  const lines: string[] = [];
  const r = await runScript<{ asNode: string; args: string[]; execArgv: string[] }>({ exe: process.execPath, script: ok, args: ['detect', '--x'], onLog: (l) => lines.push(l) });
  assert.equal(r.ok, true);
  assert.equal(r.asNode, '1');
  assert.deepEqual(r.args, ['detect', '--x']);
  // No inspector on SIGUSR1 in a script the app runs outside every pane.
  assert.deepEqual(r.execArgv, ['--disable-sigusr1']);
  assert.deepEqual(lines, ['one', 'two']);
  const bad = path.join(dir, 'bad.mjs');
  fs.writeFileSync(bad, "process.stderr.write('boom\\n'); process.exit(3);\n");
  const b = await runScript({ exe: process.execPath, script: bad, args: [] });
  assert.equal(b.ok, false);
  assert.match(String(b.error), /ended with 3: boom/);
});
