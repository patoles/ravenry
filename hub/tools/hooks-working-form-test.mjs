// Proves that hooks which work count as on, whatever their spelling, and
// that setup leaves them alone (server/hookinstall.mjs hooksOn and the
// works() of oursFor). Simon's Mac on the native app: the Electron era's
// entries (ELECTRON_RUN_AS_NODE=1 .../Ravenry '<data>/current/hub/hooks/
// events.mjs' --ravenryd, and '<data>/bin/ravenryd' hook) ran fine, yet
// the Settings row and the panel said "Not set up" / "Alerts turned off",
// because the row was a dry run of setup with the app's own node and the
// ravenryd inside the app, which "would change" every entry.
//
// A scratch app data folder (versions/9.9.9/hub, current, bin/ravenryd)
// and a scratch Ravenry.app (Ravenry, node, ravenryd), never the real
// ~/.claude or ~/.codex: MC_CLAUDE_SETTINGS and MC_CODEX_HOME point under
// .tmp before anything is imported.
import './test-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = fs.mkdtempSync(path.join(HUB, '.tmp', 'hookform-'));
const SETTINGS = path.join(T, 'claude', 'settings.json');
const CODEX = path.join(T, 'codex');
fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
fs.mkdirSync(CODEX, { recursive: true });
process.env.MC_CLAUDE_SETTINGS = SETTINGS;
process.env.MC_CODEX_HOME = CODEX;
process.env.MC_CODEX = '1';
process.env.HOME = path.join(T, 'home');
fs.mkdirSync(process.env.HOME);

// The app's data folder: this hub as version 9.9.9, current pointing at it, bin/ravenryd at its ravenryd.
const DATA = path.join(T, 'data');
fs.mkdirSync(path.join(DATA, 'versions', '9.9.9'), { recursive: true });
fs.symlinkSync(HUB, path.join(DATA, 'versions', '9.9.9', 'hub'));
fs.writeFileSync(path.join(DATA, 'versions', '9.9.9', 'ravenryd'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
fs.symlinkSync(path.join(DATA, 'versions', '9.9.9'), path.join(DATA, 'current'));
fs.mkdirSync(path.join(DATA, 'bin'));
fs.symlinkSync('../versions/9.9.9/ravenryd', path.join(DATA, 'bin', 'ravenryd'));
const ROOT = path.join(DATA, 'versions', '9.9.9', 'hub');
const STABLE = path.join(DATA, 'bin', 'ravenryd');
// The app: its executable (Node when ELECTRON_RUN_AS_NODE=1 is set), its node, its ravenryd.
const MACOS = path.join(T, 'Ravenry.app', 'Contents', 'MacOS');
fs.mkdirSync(MACOS, { recursive: true });
const APPBIN = path.join(MACOS, 'Ravenry');
fs.writeFileSync(APPBIN, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const NODE = path.join(MACOS, 'node');
fs.symlinkSync(process.execPath, NODE);
const BUNDLED = path.join(MACOS, 'ravenryd');
fs.writeFileSync(BUNDLED, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

const hk = await import('../server/hookinstall.mjs');
const skills = await import('../server/skills.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const text = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const all = (f) => [text(SETTINGS), text(path.join(CODEX, 'hooks.json')), text(path.join(CODEX, 'config.toml'))].join('\n----\n');
const commands = (f) => Object.values((JSON.parse(text(f) || '{}').hooks) || {}).flatMap((l) => l.flatMap((g) => g.hooks || [])).map((h) => h.command);
const ours = (f) => commands(f).filter((c) => /ravenryd|hooks\/(events|handoff-stop)\.mjs/.test(c));
const row = (k) => skills.withHooks([{ kind: k, found: true }], (kind) => { const r = hk.hooksOn(kind, { root: ROOT }); return r ? { file: r.file, on: r.on } : null; })[0].hooks;

// ---- Simon's files: the Electron app wrote them (its executable as Node, the stable bin/ravenryd).
const theirs = { type: 'command', command: '/usr/local/bin/their-hook --x', timeout: 3 };
fs.writeFileSync(SETTINGS, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [theirs] }] } }, null, 2));
fs.writeFileSync(path.join(CODEX, 'config.toml'), 'model = "gpt"\n');
const cur = hk.readSettings();
const p0 = hk.plan(cur.json, { root: ROOT, node: APPBIN, electron: true, ravenryd: STABLE });
hk.writeSettings(SETTINGS, cur.raw, p0.settings);
hk.codexWrite(hk.codexPlan({ root: ROOT, node: APPBIN, electron: true, ravenryd: STABLE }));
const electronEra = ours(SETTINGS);
check('the fixture is the Electron era\'s form', electronEra.some((c) => c.startsWith(`${hk.AS_NODE} ${APPBIN} `) && c.includes('/current/hub/hooks/events.mjs') && c.endsWith(' --ravenryd')) && electronEra.includes(`${STABLE} hook --assistant claude`), electronEra.slice(0, 2).join(' | '));

check('Claude: on (hooksOn), the Settings row says on', hk.hooksOn('claude', { root: ROOT }).on === true && row('claude') === 'on', JSON.stringify(hk.hooksOn('claude', { root: ROOT })));
check('Codex: on, the Settings row says on', hk.hooksOn('codex', { root: ROOT })?.on === true && row('codex') === 'on', JSON.stringify(hk.hooksOn('codex', { root: ROOT })));
check('GET /api/setup/hooks\'s status agrees (ok, the daemon hook ok)', hk.status(hk.readSettings().json, { root: ROOT }).state === 'ok' && hk.codexStatus({ root: ROOT }).state === 'ok');

const before = all();
for (const [name, bin] of [['the app\'s own ravenryd', BUNDLED], ['the stable bin/ravenryd', STABLE]]) {
  const d = hk.setupWithRavenryd({ ravenryd: bin, dry: true, root: ROOT, node: NODE });
  check(`a dry run with the native app's node and ${name} changes nothing`, d.ok && d.claude.changes.length === 0 && d.codex.changes.length === 0, JSON.stringify([d.claude?.changes, d.codex?.changes]));
}
const w = hk.setupWithRavenryd({ ravenryd: BUNDLED, root: ROOT, node: NODE });
check('Set up pressed anyway: the files stay byte for byte (working hooks are never rewritten for their spelling)', w.ok && all() === before && !w.claude.backup && !w.codex.backups.length);

// ---- What does count as off.
const variant = (edit) => { const j = JSON.parse(before.split('\n----\n')[0]); edit(j); fs.writeFileSync(SETTINGS, JSON.stringify(j, null, 2)); return hk.hooksOn('claude', { root: ROOT }); };
const each = (j, f) => { for (const l of Object.values(j.hooks)) for (const g of l) for (const h of g.hooks || []) f(h); };
let r = variant((j) => { delete j.hooks.UserPromptSubmit; });
check('an event with no hook of ours: off', r.on === false, JSON.stringify(r));
r = variant((j) => each(j, (h) => { h.command = h.command.replace(`${hk.AS_NODE} `, ''); }));
check('the app started without ELECTRON_RUN_AS_NODE=1 (it would open the app): off', r.on === false, JSON.stringify(r));
r = variant((j) => each(j, (h) => { h.command = h.command.replace(STABLE, path.join(T, 'gone', 'ravenryd')); }));
check('the daemon\'s hook naming a ravenryd that is not there, the scripts leaving Ravenry\'s panes to it: off', r.on === false, JSON.stringify(r));
r = variant((j) => { for (const ev of Object.keys(j.hooks)) j.hooks[ev] = j.hooks[ev].map((g) => ({ ...g, hooks: g.hooks.filter((h) => !/ hook --assistant/.test(h.command)) })).filter((g) => g.hooks.length); });
check('no daemon hook while the scripts carry --ravenryd (no one reports Ravenry\'s panes): off', r.on === false, JSON.stringify(r));
const OTHER = path.join(T, 'other-copy');
fs.mkdirSync(path.join(OTHER, 'hooks'), { recursive: true });
fs.writeFileSync(path.join(OTHER, 'package.json'), JSON.stringify({ name: 'ravenry-app' }));
for (const s of ['events.mjs', 'handoff-stop.mjs']) fs.writeFileSync(path.join(OTHER, 'hooks', s), '');
r = variant((j) => each(j, (h) => { h.command = h.command.replace(path.join(DATA, 'current', 'hub'), OTHER); }));
check('another copy of Ravenry\'s hooks: off', r.on === false, JSON.stringify(r));
r = variant((j) => each(j, (h) => { if (/hooks\/(events|handoff-stop)\.mjs/.test(h.command)) h.command = `${NODE} '${path.join(DATA, 'current', 'hub', 'hooks', h.command.includes('handoff') ? 'handoff-stop.mjs' : 'events.mjs')}' --ravenryd`; }));
check('the native app\'s spelling (its node, no ELECTRON_RUN_AS_NODE) is on too', r.on === true, JSON.stringify(r));
fs.writeFileSync(SETTINGS, before.split('\n----\n')[0]);

// ---- A fresh home: off, Set up writes the form an update keeps, then on.
fs.writeFileSync(SETTINGS, JSON.stringify({ model: 'opus' }, null, 2));
fs.rmSync(path.join(CODEX, 'hooks.json'));
fs.writeFileSync(path.join(CODEX, 'config.toml'), 'model = "gpt"\n');
check('fresh: Claude and Codex off, the rows say off', hk.hooksOn('claude', { root: ROOT }).on === false && row('claude') === 'off' && hk.hooksOn('codex', { root: ROOT }).on === false && row('codex') === 'off');
const s1 = hk.setupWithRavenryd({ ravenryd: STABLE, root: ROOT, node: NODE });
const fresh = [...ours(SETTINGS), ...ours(path.join(CODEX, 'hooks.json'))];
check('Set up names the stable bin/ravenryd and current/hub, never a version folder or the ravenryd inside the app',
  s1.ok && fresh.length > 0 && fresh.filter((c) => / hook --assistant/.test(c)).every((c) => c.startsWith(`${STABLE} hook`) || c.startsWith(`'${STABLE}' hook`)) && fresh.filter((c) => /\.mjs/.test(c)).every((c) => c.includes('/current/hub/hooks/')) && !fresh.some((c) => c.includes(BUNDLED) || c.includes('/versions/9.9.9/')),
  fresh.slice(0, 3).join(' | '));
check('then on, and a second Set up changes nothing', hk.hooksOn('claude', { root: ROOT }).on && hk.hooksOn('codex', { root: ROOT }).on && hk.setupWithRavenryd({ ravenryd: STABLE, dry: true, root: ROOT, node: NODE }).claude.changes.length === 0);
const rm = hk.setupWithRavenryd({ remove: true, root: ROOT, node: NODE });
check('Remove: off again, their settings kept', rm.ok && !hk.hooksOn('claude', { root: ROOT }).on && JSON.parse(text(SETTINGS)).model === 'opus' && !ours(SETTINGS).length);

fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
