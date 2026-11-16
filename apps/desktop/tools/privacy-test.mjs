// Help, Privacy opens the privacy page (site/privacy.html, published at
// shared/strings/en.json privacy.url) in the browser. The built app runs
// offscreen on a stub hub and a throwaway daemon; the menu item is clicked
// as a click on it does, and what would have opened is read from the app's
// record (RAVENRY_OPEN_LOG: offscreen, nothing opens).
//
//   node tools/privacy-test.mjs [--exe APP_EXECUTABLE]     (after node build.mjs)
import { hubState } from './stub-state.mjs';
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runApp, stopDaemons } from './run-app.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const REPO = path.resolve(APP, '..', '..');
const argv = process.argv.slice(2);
const exeAt = argv.indexOf('--exe');
const EXE = exeAt >= 0 ? path.resolve(argv.splice(exeAt, 2)[1]) : null;
const BIN = path.resolve(process.env.RAVENRYD || (EXE ? path.join(path.dirname(EXE), '..', 'Resources', 'ravenryd') : path.join(REPO, 'daemon', 'ravenryd')));
const words = JSON.parse(fs.readFileSync(path.join(REPO, 'shared', 'strings', 'en.json'), 'utf8'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvpv-'));
const home = path.join(root, 'h');
const rt = path.join(root, 'r');
const work = path.join(root, 'w');
for (const d of [home, rt, work]) fs.mkdirSync(d, { recursive: true });
fs.chmodSync(rt, 0o700);
const openLog = path.join(root, 'open.jsonl');
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : ''}`); if (!ok) fails++; };

const denv = { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: path.join(root, 'state') };
execFileSync(BIN, ['serve', '--detach'], { env: denv });
const state = { generatedAt: new Date().toISOString(), projects: [], checkpoints: [] };
const srv = http.createServer((q, r) => {
  if (q.url.startsWith('/api/events')) { r.writeHead(200, { 'Content-Type': 'text/event-stream' }); r.write(`event: state\ndata: ${JSON.stringify(hubState(state))}\n\n`); return; }
  if (q.url.startsWith('/api/state')) { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(hubState(state))); return; }
  r.writeHead(404, { 'Content-Type': 'application/json' }); r.end('{}');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const hubUrl = `http://127.0.0.1:${srv.address().port}`;
const menuOut = path.join(work, 'help.json');
const opened = () => { try { return fs.readFileSync(openLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
// The Help menu's items, then Privacy clicked as a click on it does.
const HELP = `const top = electron.Menu.getApplicationMenu().items.find((m) => m.role === 'help' || m.label === 'Help');
  const items = top ? top.submenu.items.map((i) => i.label) : null;
  require('fs').writeFileSync(${JSON.stringify(menuOut)}, JSON.stringify(items));
  const it = top && top.submenu.items.find((i) => i.label === ${JSON.stringify(words['privacy.title'])});
  if (it) it.click();
  await new Promise((r) => setTimeout(r, 400));`;
try {
  await runApp({ name: 'privacy', work, rt, bin: EXE ? undefined : BIN, exe: EXE || undefined, home, hubUrl, env: { RAVENRY_SERVICE: 'off', RAVENRY_UPDATES: '0', RAVENRY_OPEN_LOG: openLog }, width: 1200, height: 800, steps: [
    { ready: true },
    { main: HELP },
  ] });
  const items = JSON.parse(fs.readFileSync(menuOut, 'utf8'));
  check('Help has Privacy, after Learn Ravenry', Array.isArray(items) && items.indexOf(words['privacy.title']) === items.indexOf('Learn Ravenry') + 1, items);
  const o = opened();
  check('Privacy opens the privacy page in the browser, and nothing else', o.length === 1 && o[0].kind === 'url' && o[0].what === words['privacy.url'] && /^https:\/\/.+\/privacy\.html$/.test(o[0].what), o);
} catch (e) {
  check('the app ran its steps', false, String(e.message || e).slice(0, 2000));
} finally {
  srv.close();
  stopDaemons(BIN, rt);
  if (fails) console.log(`kept for its output: ${root}`); else fs.rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
