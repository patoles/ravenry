#!/usr/bin/env node
// What a release takes from its launch (SIGN-001, Gate.swift), run on a
// package: the release and its test twin (scripts/package.mjs), each in a
// throwaway HOME and data folder. Every run of the release carries
// --offscreen besides the switch under test, so a gate that let a switch
// through would still open no window on the screen.
//
//   node scripts/gatecheck.mjs build/package/Ravenry.app [OUT]
//
// switches  each test or debugging switch makes the release exit 2 before any
//           window, with "a release build does not take --<switch>" on
//           standard error and in app.log; the twin takes the same launch
//           (--older-hub-check runs and writes its answer)
// variables the test variables are named as ignored in app.log
// node      run as Node (ELECTRON_RUN_AS_NODE=1): --inspect exits 2,
//           NODE_OPTIONS is dropped (a script reads none), a hub test switch
//           (MC_TEST_PHONE_PORT: callers on this Mac seen as a phone;
//           MC_TEST_TAILNET_CONTROL: Away from home on a test's control
//           server) exits 2 before the script runs; the twin as Node runs it
//           with the switch
// dyld      a library given in DYLD_INSERT_LIBRARIES is not loaded into the
//           release (the hardened runtime), while the same library loads
//           into a program built here without it (the control)
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAC = path.resolve(HERE, '..');
const REPO = path.resolve(MAC, '..', '..');
const REL = path.resolve(process.argv[2] || path.join(MAC, 'build', 'package', 'Ravenry.app'));
const TWIN = path.join(path.dirname(REL), 'release-test', 'Ravenry.app');
const isTwin = (a) => { try { return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :RavenryTestHooks', path.join(a, 'Contents', 'Info.plist')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true'; } catch { return false; } };
if (!fs.existsSync(path.join(REL, 'Contents', 'Resources', 'build.json')) || isTwin(REL) || !isTwin(TWIN)) { console.error('usage: node scripts/gatecheck.mjs PACKAGED_RELEASE [OUT] (its twin in release-test/ beside it)'); process.exit(2); }
fs.mkdirSync(path.join(REPO, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(REPO, '.tmp', 'gatecheck.'));
const OUT = path.resolve(process.argv[3] || tmp);
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'pass' : 'FAIL'} ${name}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`); };

let k = 0;
function run(app, args, extra = {}, exe = 'Ravenry') {
  const root = path.join(tmp, `run${++k}`);
  const home = path.join(root, 'home');
  for (const d of [home, path.join(root, 'data'), path.join(root, 'run'), path.join(root, 'state')]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const env = { HOME: home, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', RAVENRY_SERVICE: 'off', RAVENRY_DESKTOP_DATA: path.join(root, 'data'), RAVENRY_RUNTIME_DIR: path.join(root, 'run'), RAVENRY_STATE_DIR: path.join(root, 'state'), RAVENRY_HOME: path.join(home, '.ravenry'), ...extra };
  const r = spawnSync(path.join(app, 'Contents', 'MacOS', exe), args, { env, encoding: 'utf8', timeout: 15000 });
  const log = (() => { try { return fs.readFileSync(path.join(home, 'Library', 'Logs', 'Ravenry', 'app.log'), 'utf8'); } catch { return ''; } })();
  return { code: r.status, err: r.stderr || '', out: r.stdout || '', log, root };
}

// switches
const older = path.join(tmp, 'older.json');
fs.writeFileSync(older, JSON.stringify({ projects: [], generatedAt: new Date().toISOString() }));
const SW = [['--offscreen'], ['--selftest', 'x.json'], ['--sidetest', 'x.json'], ['--bench', 'x.json'], ['--socket', '/tmp/none.sock'], ['--screen', 'brief'],
  ['--restore-check'], ['--older-hub-check', older, path.join(tmp, 'o.json')], ['--inspect'], ['--remote-debugging-port=9222'], ['--', '/bin/echo', 'hi']];
for (const s of SW) {
  const name = s[0] === '--' ? '-- COMMAND' : s[0].split('=')[0];
  const args = s[0] === '--offscreen' ? s : ['--offscreen', ...s];
  const r = run(REL, args);
  const said = `a release build does not take ${''}`;
  const line = new RegExp(`launch: a release build does not take [^\\n]*${name.replace(/[-]/g, '\\-')}[^\\n]*: quitting`);
  check(`switch_${name.replace(/^-+/, '').replace(/ /g, '_')}`, r.code === 2 && line.test(r.log) && r.err.includes(said), `exit ${r.code}; ${(r.log.match(/launch: a release build does not take.*/) || [''])[0]}`);
}
const twin = run(TWIN, ['--older-hub-check', older, path.join(tmp, 'twin-o.json')]);
check('twin_takes_the_switch', twin.code === 0 && fs.existsSync(path.join(tmp, 'twin-o.json')), `exit ${twin.code}`);
const rel = run(REL, ['--older-hub-check', older, path.join(tmp, 'rel-o.json')]);
check('release_refuses_the_same', rel.code === 2 && !fs.existsSync(path.join(tmp, 'rel-o.json')), `exit ${rel.code}`);

// variables
const v = run(REL, ['--offscreen'], { RAVENRY_HUB_URL: 'http://127.0.0.1:1', RAVENRY_MAC_REPORT: '/tmp/x', RAVENRY_UPDATE_FEED: 'http://127.0.0.1:1/f', RAVENRY_TEST_SINGLE: '1', STUB_PS_STATE: '/tmp/s', NODE_OPTIONS: '--require /nonexistent', MC_TEST_PHONE_PORT: '4699', MC_TEST_TAILNET_CONTROL: 'http://127.0.0.1:1' });
const ign = (v.log.match(/launch: a release build ignores (.*)/) || [])[1] || '';
check('variables_named_ignored', ['MC_TEST_PHONE_PORT', 'MC_TEST_TAILNET_CONTROL', 'NODE_OPTIONS', 'RAVENRY_HUB_URL', 'RAVENRY_MAC_REPORT', 'RAVENRY_TEST_SINGLE', 'RAVENRY_UPDATE_FEED', 'STUB_PS_STATE'].every((x) => ign.includes(x)), ign);

// node
const ni = run(REL, ['--inspect', '-e', '1'], { ELECTRON_RUN_AS_NODE: '1' });
check('node_inspect_refused', ni.code === 2, `exit ${ni.code}: ${ni.err.trim().split('\n')[0]}`);
const no = run(REL, ['-e', 'console.log(process.env.NODE_OPTIONS || "none")'], { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--max-old-space-size=64' });
check('node_options_dropped', no.code === 0 && no.out.trim() === 'none', `exit ${no.code}, NODE_OPTIONS read: ${no.out.trim()}`);
// The hub's stand-in for the Wi-Fi (hub/server/testphone.mjs): the release as
// Node quits on it before the script runs; the twin runs the script with it.
const asPhone = (app, mark) => run(app, ['-e', `require('fs').writeFileSync(${JSON.stringify(mark)}, process.env.MC_TEST_PHONE_PORT || 'none')`], { ELECTRON_RUN_AS_NODE: '1', MC_TEST_PHONE_PORT: '4699' });
const relMark = path.join(tmp, 'rel-phone.mark'), twinMark = path.join(tmp, 'twin-phone.mark');
const rp = asPhone(REL, relMark);
check('node_hub_test_switch_refused', rp.code === 2 && rp.err.includes('a release build does not take MC_TEST_PHONE_PORT: quitting') && !fs.existsSync(relMark), `exit ${rp.code}: ${rp.err.trim().split('\n')[0]}; script ran: ${fs.existsSync(relMark)}`);
const tp = asPhone(TWIN, twinMark);
check('twin_node_takes_hub_test_switch', tp.code === 0 && fs.existsSync(twinMark) && fs.readFileSync(twinMark, 'utf8') === '4699', `exit ${tp.code}: ${fs.existsSync(twinMark) ? fs.readFileSync(twinMark, 'utf8') : 'script did not run'}`);
// Away from home's test control server (hub/server/tailnet.mjs): the same.
const asLab = (app, mark) => run(app, ['-e', `require('fs').writeFileSync(${JSON.stringify(mark)}, process.env.MC_TEST_TAILNET_CONTROL || 'none')`], { ELECTRON_RUN_AS_NODE: '1', MC_TEST_TAILNET_CONTROL: 'http://127.0.0.1:1' });
const relLab = path.join(tmp, 'rel-tailnet.mark'), twinLab = path.join(tmp, 'twin-tailnet.mark');
const rl = asLab(REL, relLab);
check('node_tailnet_test_switch_refused', rl.code === 2 && rl.err.includes('a release build does not take MC_TEST_TAILNET_CONTROL: quitting') && !fs.existsSync(relLab), `exit ${rl.code}: ${rl.err.trim().split('\n')[0]}; script ran: ${fs.existsSync(relLab)}`);
const tl = asLab(TWIN, twinLab);
check('twin_node_takes_tailnet_test_switch', tl.code === 0 && fs.existsSync(twinLab) && fs.readFileSync(twinLab, 'utf8') === 'http://127.0.0.1:1', `exit ${tl.code}: ${fs.existsSync(twinLab) ? fs.readFileSync(twinLab, 'utf8') : 'script did not run'}`);

// dyld
const lib = path.join(tmp, 'mark.dylib'), prog = path.join(tmp, 'plain');
fs.writeFileSync(path.join(tmp, 'mark.c'), '#include <stdio.h>\n#include <stdlib.h>\n__attribute__((constructor)) static void mark(void) { const char *f = getenv("MARK_FILE"); if (f) { FILE *o = fopen(f, "a"); if (o) { fputs("loaded\\n", o); fclose(o); } } }\n');
fs.writeFileSync(path.join(tmp, 'plain.c'), 'int main(void) { return 0; }\n');
execFileSync('/usr/bin/clang', ['-dynamiclib', '-o', lib, path.join(tmp, 'mark.c')]);
execFileSync('/usr/bin/clang', ['-o', prog, path.join(tmp, 'plain.c')]);
const ctl = path.join(tmp, 'control.mark'), mark = path.join(tmp, 'release.mark');
spawnSync(prog, [], { env: { DYLD_INSERT_LIBRARIES: lib, MARK_FILE: ctl } });
run(REL, ['-e', '1'], { ELECTRON_RUN_AS_NODE: '1', DYLD_INSERT_LIBRARIES: lib, MARK_FILE: mark });
run(REL, ['--offscreen'], { DYLD_INSERT_LIBRARIES: lib, MARK_FILE: mark });
check('dyld_control_loads', fs.existsSync(ctl), 'the library loads into a program built here without the hardened runtime');
check('dyld_release_refuses', !fs.existsSync(mark), fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8') : 'not loaded into the release, as the app or as Node');

fs.writeFileSync(path.join(OUT, 'gatecheck.json'), JSON.stringify({ release: REL, twin: TWIN, at: new Date().toISOString(), results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} of ${results.length} checks failed` : `all ${results.length} checks pass`);
process.exit(failed.length ? 1 : 0);
