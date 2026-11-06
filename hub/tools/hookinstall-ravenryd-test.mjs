// Proves the first-launch hook setup (server/hookinstall.mjs
// setupWithRavenryd): `ravenryd hook --assistant claude|codex` goes into
// Claude Code's settings.json and Codex's hooks.json (with its trust
// entries in config.toml), beside the two Node scripts, which then carry
// --ravenryd; a rerun changes nothing; every other hook stays; status
// reports it; removing takes it all out. Only scratch files under .tmp,
// never the real ~/.claude or ~/.codex: MC_CLAUDE_SETTINGS and
// MC_CODEX_HOME point there before anything is imported.
import './test-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'hookinstall-'));
const SETTINGS = path.join(T, 'claude', 'settings.json');
const CODEX = path.join(T, 'codex');
fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
fs.mkdirSync(CODEX, { recursive: true });
process.env.MC_CLAUDE_SETTINGS = SETTINGS;
process.env.MC_CODEX_HOME = CODEX;
process.env.MC_CODEX = '1';
process.env.HOME = path.join(T, 'home');
fs.mkdirSync(process.env.HOME);
const BIN = path.join(T, 'bin', 'ravenryd');
fs.mkdirSync(path.dirname(BIN));
fs.writeFileSync(BIN, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

const theirs = { type: 'command', command: '/usr/local/bin/their-hook --x', timeout: 3 };
fs.writeFileSync(SETTINGS, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [theirs] }] } }, null, 2));
fs.writeFileSync(path.join(CODEX, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'their-codex-hook' }] }] } }, null, 2));
fs.writeFileSync(path.join(CODEX, 'config.toml'), 'model = "gpt"\n');

const hk = await import('../server/hookinstall.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const cmds = (json, ev) => ((json.hooks || {})[ev] || []).flatMap((g) => g.hooks || []).map((h) => h.command);

check('refuses a relative or missing ravenryd', !hk.setupWithRavenryd({ ravenryd: 'ravenryd' }).ok && !hk.setupWithRavenryd({ ravenryd: path.join(T, 'nope') }).ok);

const dry = hk.setupWithRavenryd({ ravenryd: BIN, dry: true });
check('a dry run lists the changes and writes nothing', dry.ok && dry.claude.changes.length > 0 && read(SETTINGS).hooks.Stop.length === 1);

const r = hk.setupWithRavenryd({ ravenryd: BIN });
const s = read(SETTINGS);
const stop = cmds(s, 'Stop');
check('Claude: the daemon hook on every event it reads', hk.RAVENRYD_EVENTS.claude.every((ev) => cmds(s, ev).includes(`${BIN} hook --assistant claude`)), JSON.stringify(stop));
check('Claude: the Node scripts carry --ravenryd', stop.some((c) => /hooks\/events\.mjs --ravenryd$/.test(c)) && stop.some((c) => /hooks\/handoff-stop\.mjs --ravenryd$/.test(c)));
check('Claude: their hook and their settings stay', stop.includes(theirs.command) && s.model === 'opus');
check('Claude: the file was backed up', !!r.claude.backup && fs.existsSync(r.claude.backup));
const st = hk.status(s);
check('status: the scripts and the daemon hook are ok', st.state === 'ok' && st.ravenryd.state === 'ok' && st.ravenryd.bin === BIN, JSON.stringify(st.ravenryd));

const ch = read(path.join(CODEX, 'hooks.json'));
const toml = fs.readFileSync(path.join(CODEX, 'config.toml'), 'utf8');
check('Codex: the daemon hook, the scripts with --assistant=codex --ravenryd, theirs kept', cmds(ch, 'PermissionRequest').includes(`${BIN} hook --assistant codex`) && cmds(ch, 'Stop').some((c) => /events\.mjs --assistant=codex --ravenryd$/.test(c)) && cmds(ch, 'Stop').includes('their-codex-hook'));
const cs = hk.codexStatus();
check('Codex: every entry of ours is trusted in config.toml', /model = "gpt"/.test(toml) && cs.state === 'ok' && cs.ravenryd.state === 'ok', JSON.stringify({ state: cs.state, untrusted: cs.untrusted }));

const again = hk.setupWithRavenryd({ ravenryd: BIN });
check('a rerun changes nothing', again.claude.changes.length === 0 && again.codex.changes.length === 0, JSON.stringify([again.claude.changes, again.codex.changes]));

// The old `ravenry setup` path (no ravenryd given) keeps the daemon hook and --ravenryd.
const keep = hk.plan(read(SETTINGS));
check('a plain setup keeps the daemon hook', keep.changes.length === 0, JSON.stringify(keep.changes));

// A newer app at another path: the entries move with it.
const BIN2 = path.join(T, 'bin2', 'ravenryd');
fs.mkdirSync(path.dirname(BIN2));
fs.copyFileSync(BIN, BIN2);
fs.chmodSync(BIN2, 0o755);
hk.setupWithRavenryd({ ravenryd: BIN2 });
check('a moved ravenryd is rewritten in place, not added twice', cmds(read(SETTINGS), 'Stop').filter((c) => / hook --assistant claude$/.test(c)).length === 1 && cmds(read(SETTINGS), 'Stop').includes(`${BIN2} hook --assistant claude`));

const off = hk.setupWithRavenryd({ remove: true });
const s2 = read(SETTINGS);
check('remove: all of ours goes, theirs stays', off.ok && JSON.stringify(s2.hooks) === JSON.stringify({ Stop: [{ hooks: [theirs] }] }) && s2.model === 'opus', JSON.stringify(s2.hooks));
check('remove: Codex too, with its trust entries', cmds(read(path.join(CODEX, 'hooks.json')), 'Stop').join() === 'their-codex-hook' && !/ravenry/i.test(fs.readFileSync(path.join(CODEX, 'config.toml'), 'utf8')));

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
