#!/usr/bin/env node
// The prune the app runs a minute after its hub service is set up
// (Install.swift setUpHub: `setup.mjs prune --keep <version>`, UPD-013), run
// as the app runs it (the package's Node and setup.mjs) in a throwaway HOME
// and data folder, on version folders each named by one thing that runs:
//
//   0.1.20  a hook in ~/.claude/settings.json      kept; once the hook is gone, removed
//   0.1.21  a hook in Codex's hooks.json            kept
//   0.1.22  a running process's command line        kept
//   0.1.23  the hub service's file                  kept
//   0.1.24  a daemon's socket in the runtime folder kept
//   0.1.25  nothing                                 removed (its hook scripts left as stubs)
//   0.1.26  a folder of hook stubs already          kept
//
//   node scripts/prunecheck.mjs PACKAGED_APP
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testApp } from './testapp.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const { app: APP } = testApp(process.argv[2] || path.join(HERE, '..', 'build', 'package', 'Ravenry.app'));
const NODE = path.join(APP, 'Contents', 'MacOS', 'node'), SETUP = path.join(APP, 'Contents', 'Resources', 'setup.mjs');
fs.mkdirSync(path.join(REPO, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(REPO, '.tmp', 'prune.'));
const home = path.join(tmp, 'home'), data = path.join(tmp, 'data'), run = path.join(tmp, 'run'), state = path.join(tmp, 'state');
for (const d of [home, data, run, state]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
const label = `dev.ravenry.hub.test-${crypto.randomBytes(4).toString('hex')}`;
const env = { HOME: home, PATH: '/usr/bin:/bin', RAVENRY_DESKTOP_DATA: data, RAVENRY_RUNTIME_DIR: run, RAVENRY_STATE_DIR: state, RAVENRY_HOME: path.join(home, '.ravenry'), RAVENRY_SERVICE_LABEL: label };
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'pass' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const V = (v) => path.join(data, 'versions', v);
for (const v of ['0.1.36', '0.1.20', '0.1.21', '0.1.22', '0.1.23', '0.1.24', '0.1.25']) {
  fs.mkdirSync(path.join(V(v), 'hub', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(V(v), 'hub', 'hooks', 'events.mjs'), '// the hook\n');
  fs.writeFileSync(path.join(V(v), 'ravenryd'), 'binary\n');
}
fs.mkdirSync(V('0.1.26'), { recursive: true });
fs.writeFileSync(path.join(V('0.1.26'), 'REMOVED'), 'stubs\n');
const hook = (v) => ({ type: 'command', command: `/usr/bin/node "${path.join(V(v), 'hub', 'hooks', 'events.mjs')}"` });
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [hook('0.1.20')] }] } }, null, 2));
fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [hook('0.1.21')] }] } }, null, 2));
const proc = spawn('/bin/sh', ['-c', 'sleep 60; :', path.join(V('0.1.22'), 'ravenryd')], { stdio: 'ignore' });
fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
fs.writeFileSync(path.join(home, 'Library', 'LaunchAgents', `${label}.plist`), `<plist><string>${path.join(V('0.1.23'), 'hub', 'server', 'index.mjs')}</string></plist>\n`);
fs.writeFileSync(path.join(run, 'ravenryd-0.1.24.sock'), '');

const prune = () => JSON.parse(spawnSync(NODE, ['--disable-sigusr1', SETUP, 'prune', '--keep', '0.1.36'], { env, encoding: 'utf8' }).stdout.trim().split('\n').pop());
const whole = (v) => fs.existsSync(path.join(V(v), 'ravenryd'));
const stubs = (v) => fs.existsSync(path.join(V(v), 'REMOVED')) && !fs.existsSync(path.join(V(v), 'ravenryd'));
try {
  const r1 = prune();
  check('prune_removes_unnamed', r1.ok && r1.removed.join(',') === '0.1.25' && stubs('0.1.25') && fs.existsSync(path.join(V('0.1.25'), 'hub', 'hooks', 'events.mjs')), `removed: ${r1.removed.join(',')}; 0.1.25 left as hook stubs: ${stubs('0.1.25')}`);
  for (const [v, why] of [['0.1.36', 'this version'], ['0.1.20', 'a Claude Code hook'], ['0.1.21', 'a Codex hook'], ['0.1.22', 'a running process'], ['0.1.23', 'the service file'], ['0.1.24', 'a daemon socket']]) check(`prune_keeps_${v.replace(/\./g, '_')}`, whole(v), why);
  check('prune_keeps_stub_folder', fs.existsSync(path.join(V('0.1.26'), 'REMOVED')), '0.1.26');
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }, null, 2));
  const r2 = prune();
  check('prune_after_hook_removed', r2.removed.includes('0.1.20') && stubs('0.1.20') && whole('0.1.21'), `removed: ${r2.removed.join(',')}`);
  const log = fs.readFileSync(path.join(home, 'Library', 'Logs', 'Ravenry', 'app.log'), 'utf8');
  check('prune_logged', /install: removed versions nothing runs from: 0\.1\.25/.test(log) && /install: removed versions nothing runs from: 0\.1\.20/.test(log));
} finally { proc.kill(); }
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} of ${results.length} checks failed` : `all ${results.length} checks pass`);
process.exit(failed.length ? 1 : 0);
