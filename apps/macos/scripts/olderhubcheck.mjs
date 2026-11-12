#!/usr/bin/env node
// A hub from before 2026-11-09 still draws right (UPD-017): the window runs
// the hub's own sidebar.mjs, cpwords.mjs and briefnext.mjs in JavaScriptCore
// for a hub that sends no `sidebar`, no checkpoint `words` (OlderHub.swift).
// The same demo board (apps/desktop/tools/demo-hub.mjs, 127.0.0.1) is run
// twice, on this tree's hub and on an older release's (a copy of its hub
// folder, 0.1.22 from 2026-11-08 by default), the app off every screen on
// each, a question arriving in paper-boat; the sidebar's rows and each
// card's words the window has (its report) must be the same.
//
//   node scripts/olderhubcheck.mjs APP OLD_HUB_DIR [OUT]
//
// OLD_HUB_DIR: a release's hub folder (it is copied, never run in place),
// e.g. "~/Library/Application Support/Ravenry/versions/0.1.22/hub".
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemoHub } from '../../desktop/tools/demo-hub.mjs';
import { boatPng } from './cards-fixture.mjs';
import { testApp } from './testapp.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAC = path.resolve(HERE, '..');
const REPO = path.resolve(MAC, '..', '..');
const { app: APP, exe: EXE } = testApp(process.argv[2] || path.join(MAC, 'build', 'RavenryMac.app'));
const SRC = process.argv[3] && path.resolve(process.argv[3]);
if (!SRC || !fs.existsSync(path.join(SRC, 'server', 'index.mjs'))) { console.error('usage: node scripts/olderhubcheck.mjs APP OLD_HUB_DIR [OUT]'); process.exit(2); }
fs.mkdirSync(path.join(REPO, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(REPO, '.tmp', 'olderhub.'));
const OUT = path.resolve(process.argv[4] || tmp);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'pass' : 'FAIL'} ${name}${detail ? `: ${String(detail).slice(0, 500)}` : ''}`); };
async function until(ms, f) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await sleep(200); } return null; }
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const OLD = path.join(tmp, 'old-hub');
execFileSync('/usr/bin/ditto', [SRC, OLD]);
const oldVersion = JSON.parse(fs.readFileSync(path.join(OLD, 'package.json'), 'utf8')).version;

async function run(name, hubDir) {
  const root = path.join(tmp, name);
  const user = path.join(root, 'u'), rt = path.join(root, 'r'), st = path.join(root, 's');
  for (const d of [user, rt, st]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(user, '.zshrc'), "PROMPT='~ > '\n");
  const env = { HOME: user, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: st, RAVENRY_DESKTOP_DATA: path.join(root, 'd') };
  const daemon = spawn(path.join(APP, 'Contents', 'MacOS', 'ravenryd'), ['serve'], { env, stdio: 'ignore' });
  await until(10000, () => fs.readdirSync(rt).some((n) => n.endsWith('.sock')));
  const port = await freePort();
  // The board follows this daemon: agents in its panes ask, propose a command, ask for a secret and show a pick
  // (ravenry ask/approve/secret/pick --no-wait), so each card's words come from the hub, or from its cpwords.mjs here.
  const rd = path.join(APP, 'Contents', 'MacOS', 'ravenryd');
  const hub = await startDemoHub({ dir: path.join(root, 'hub'), port, hubDir, runtime: rt, env: { MC_NO_EVENTS: '0', RAVENRY_DAEMON_BIN: rd } });
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(rd, path.join(bin, 'ravenry'));
  const pics = [[0, [196, 86, 64]], [0.12, [72, 120, 190]]].map(([tilt, hull], n) => { const f = path.join(root, `boat-${n}.png`); fs.writeFileSync(f, boatPng(tilt, hull)); return f; });
  const sq = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
  const asks = [
    `ravenry ask ${sq('Tilt the hull with the slope too, or keep it level?')} --option ${sq('Tilt it with the slope')} --option ${sq('Keep it level')} --text`,
    `ravenry approve --why ${sq('The settings screen is done.')} --warn ${sq('It publishes the beta.')} --no-wait -- npm publish --tag beta`,
    `ravenry secret ${sq('Paste the Cloudflare API token for the map tiles')} --env TILES_TOKEN --no-wait -- /bin/sh -c true`,
    `ravenry pick ${sq('Which hull shape for the boat?')} --variant ${sq(`Flat hull=${pics[0]}`)} --variant ${sq(`V hull=${pics[1]}`)}`,
  ];
  for (const [n, c] of asks.entries()) {
    const line = c.includes('--no-wait') ? c : `${c} --no-wait`;
    execFileSync(rd, ['new', '--cwd', user, '--name', `agent-${n}`, '--json', '--', '/bin/sh', '-c', `export PATH=${sq(bin)}:/usr/bin:/bin; ${line} > ${sq(path.join(root, `cp-${n}.out`))} 2>&1; exec sleep 100000`], { env });
  }
  const report = path.join(root, 'report.json');
  const app = spawn(EXE, ['--offscreen'], { env: { ...env, RAVENRY_HUB_URL: hub.url, RAVENRY_MAC_REPORT: report }, stdio: 'ignore' });
  const rep = () => { try { return JSON.parse(fs.readFileSync(report, 'utf8')); } catch { return null; } };
  try {
    await until(20000, () => rep()?.hub?.generatedAt && rep().sidebar.length > 0);
    await hub.arrive('paper-boat');
    const got = await until(20000, () => { const r = rep(); return r && r.cpwords.filter((c) => c.words).length >= asks.length ? r : null; });
    await sleep(2500);
    const r = rep() || got;
    return { sidebar: r?.sidebar || [], words: (r?.cpwords || []).filter((c) => c.words).map((c) => c.words).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1) };
  } finally {
    app.kill('SIGTERM');
    await until(5000, () => app.exitCode !== null);
    hub.stop();
    daemon.kill();
  }
}

try {
  const now = await run('new', path.join(REPO, 'hub'));
  const old = await run('old', OLD);
  check('older_hub_sidebar_same', now.sidebar.length > 0 && JSON.stringify(now.sidebar) === JSON.stringify(old.sidebar), `this hub: ${now.sidebar.length} rows; ${oldVersion}: ${old.sidebar.length} rows${JSON.stringify(now.sidebar) === JSON.stringify(old.sidebar) ? ', the same' : `; only now: ${now.sidebar.filter((k) => !old.sidebar.includes(k)).join(', ')}; only old: ${old.sidebar.filter((k) => !now.sidebar.includes(k)).join(', ')}`}`);
  fs.writeFileSync(path.join(OUT, 'words-new.json'), JSON.stringify(now.words, null, 1));
  fs.writeFileSync(path.join(OUT, 'words-old.json'), JSON.stringify(old.words, null, 1));
  check('older_hub_cards_listed', now.words.length >= 4 && old.words.length === now.words.length, `this hub: ${now.words.length} cards with words; ${oldVersion}: ${old.words.length}`);
  if (now.words.length) check('older_hub_card_words_same', now.words.length > 0 && JSON.stringify(now.words) === JSON.stringify(old.words), `this hub: ${JSON.stringify(now.words).slice(0, 200)}; ${oldVersion}: ${JSON.stringify(old.words).slice(0, 200)}`);
} finally {
  fs.writeFileSync(path.join(OUT, 'olderhubcheck.json'), JSON.stringify({ app: APP, old: SRC, oldVersion, at: new Date().toISOString(), results }, null, 2));
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} of ${results.length} checks failed` : `all ${results.length} checks pass`);
process.exit(failed.length ? 1 : 0);
