// What the window offers of the switch from the npm board, and how the hub
// script is run (src/main/npmswitch.ts). The switch itself is proved in
// hub/tools/npmswitch-test.mjs and, with the real npm board and the
// packaged app, tools/npm-switch-test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mayRunHub, offerFor, runScript, scriptPath } from '../src/main/npmswitch.ts';
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

test('scriptPath: beside the hub server', () => {
  assert.equal(scriptPath('/d/versions/0.1.0/hub/server/index.mjs'), '/d/versions/0.1.0/hub/server/npmswitch.mjs');
});

test('runScript: the JSON it prints, its log lines as they come, and a clear error when it prints none', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-npmswitch-'));
  const ok = path.join(dir, 'ok.mjs');
  fs.writeFileSync(ok, "process.stderr.write('one\\ntwo\\n'); console.log(JSON.stringify({ ok: true, asNode: process.env.ELECTRON_RUN_AS_NODE, args: process.argv.slice(2) }));\n");
  const lines: string[] = [];
  const r = await runScript<{ asNode: string; args: string[] }>({ exe: process.execPath, script: ok, args: ['detect', '--x'], onLog: (l) => lines.push(l) });
  assert.equal(r.ok, true);
  assert.equal(r.asNode, '1');
  assert.deepEqual(r.args, ['detect', '--x']);
  assert.deepEqual(lines, ['one', 'two']);
  const bad = path.join(dir, 'bad.mjs');
  fs.writeFileSync(bad, "process.stderr.write('boom\\n'); process.exit(3);\n");
  const b = await runScript({ exe: process.execPath, script: bad, args: [] });
  assert.equal(b.ok, false);
  assert.match(String(b.error), /ended with 3: boom/);
});
