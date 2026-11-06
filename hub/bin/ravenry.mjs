#!/usr/bin/env node
// The `ravenry` command (npm i -g ravenry-app). See README.md.
//
//   ravenry              start the board on :4600 (PORT overrides) and open it;
//                        runs setup first if it never ran
//   ravenry setup        checks this Mac, then adds Ravenry's two hooks to
//                        ~/.claude/settings.json if you say yes
//   ravenry doctor       says what works and what does not
//   ravenry uninstall    takes the hooks out again (--purge also deletes ~/.ravenry)
//   ravenry --version, ravenry help
//
// Where the board runs, by where `ravenry` is typed:
//   in a cmux tab     the board runs in that tab, in cmux mode, and its page
//                     opens in a cmux browser pane above it
//   in an iTerm2 tab  a "Ravenry" tab opens with the page on top and the
//                     board below (tools/open-in-iterm.mjs, iTerm2 mode)
//   in a Rex tab      the board runs in that tab, in Rex mode, and its page
//                     opens in the default browser
//   anywhere else     the board runs in this terminal in iTerm2 mode (it never
//                     asks cmux, whose socket refuses processes started outside
//                     it), and the page opens in the default browser; sessions
//                     outside iTerm2 and Rex are watch only
// `--no-open` (or RAVENRY_NO_OPEN=1) opens no page; `--yes` answers yes to
// setup's questions about the hooks and the iTerm2 helper.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('-')));
const words = argv.filter((a) => !a.startsWith('-'));
const cmd = words[0] || '';
const YES = flags.has('--yes') || flags.has('-y');
const NO_OPEN = flags.has('--no-open') || process.env.RAVENRY_NO_OPEN === '1';
const env = process.env;
const PORT = Number(env.PORT || 4600);
const URL_ = `http://localhost:${PORT}/`;
const ITERM_URL = 'https://iterm2.com';
const CLAUDE_URL = 'https://claude.com/claude-code';
// npx keeps its copy in a cache (~/.npm/_npx) that it may clear or replace.
const FROM_NPX = /[/\\]_npx[/\\]/.test(ROOT);
const tilde = (p) => (p && p.startsWith(os.homedir() + path.sep) ? '~' + p.slice(os.homedir().length) : p);

const HELP = `Ravenry ${PKG.version}: a local board for every Claude Code session on this Mac.

  ravenry              start the board (http://localhost:${PORT}) and open it
  ravenry setup        check this Mac and install Ravenry's Claude Code hooks
                       (and Codex's, when Codex is installed)
  ravenry doctor       say what works and what does not
  ravenry uninstall    take the hooks out (--purge also deletes ~/.ravenry)
  ravenry --version    print the version
  ravenry help         this

Options: --yes (answer yes in setup and uninstall), --no-open (start without
opening the page). PORT=4700 ravenry runs the board on another port.`;

// ------------------------------------------------------------ small helpers

function ask(question, def = false) {
  if (YES) { console.log(`${question} yes (--yes)`); return Promise.resolve(true); }
  if (!process.stdin.isTTY) { console.log(`${question} no (not a terminal; --yes answers yes)`); return Promise.resolve(false); }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(`${question} ${def ? '[Y/n]' : '[y/N]'} `, (a) => {
    rl.close();
    const t = String(a || '').trim().toLowerCase();
    resolve(t ? /^y(es)?$/.test(t) : def);
  }));
}

function nodeMajorOk() {
  const want = Number(String((PKG.engines && PKG.engines.node) || '>=22').match(/(\d+)/)[1]);
  return { ok: Number(process.versions.node.split('.')[0]) >= want, want };
}

function which(bin) {
  try { return execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

// Claude Code's `claude`: on PATH, or where its installer puts it.
// Rex: its command, whether its server answers and the API revision it
// speaks (server/rex.mjs check; never starts a server).
const REX_REMOTE = "Rex: Open in Rex needs Remote Control on in Rex's Settings (off by default); everything else works without it.";
async function rexState() {
  const rex = await import('../server/rex.mjs');
  const s = await rex.check({ fresh: true });
  if (s.ok) return { ok: true, bin: s.bin, version: s.version, revision: s.revision };
  return { ok: false, why: String(s.error).replace(/\.?$/, '.') };
}

function claudePath() {
  return which('claude') || [path.join(os.homedir(), '.local', 'bin', 'claude'), path.join(os.homedir(), '.claude', 'local', 'claude')].find((p) => fs.existsSync(p)) || null;
}

// The terminal this command runs in: 'cmux', 'iterm', 'rex' or another name.
async function hereTerminal() {
  const { terminalOf } = await import('../server/termenv.mjs');
  return terminalOf(env).terminal || null;
}

async function names() {
  const { nameOf } = await import('../server/terminal.mjs');
  return nameOf;
}

async function apps() {
  const { appInstalled } = await import('../server/terminal.mjs');
  return { cmux: appInstalled('cmux'), iterm: appInstalled('iterm'), rex: appInstalled('rex') };
}

async function boardUp(port = PORT) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json().catch(() => null);
    return { up: true, ours: !!(j && 'projects' in j) };
  } catch { return { up: false, ours: false }; }
}

function openUrl(url) {
  return new Promise((resolve) => execFile(env.RAVENRY_OPEN_BIN || '/usr/bin/open', [url], () => resolve()));
}

async function dataHome() {
  return (await import('../server/home.mjs')).RAVENRY_HOME;
}

async function setupFile() { return path.join(await dataHome(), 'setup.json'); }

async function readSetup() {
  try { return JSON.parse(fs.readFileSync(await setupFile(), 'utf8')); } catch { return null; }
}

// ------------------------------------------------------------ setup

async function setup({ fromStart = false } = {}) {
  console.log(`Ravenry ${PKG.version} setup\n`);
  if (process.platform !== 'darwin') { console.log('Ravenry runs on macOS only (it reads cmux, iTerm2 and Rex, which are Mac apps).'); return 1; }
  const node = nodeMajorOk();
  if (!node.ok) { console.log(`Ravenry needs Node ${node.want} or newer; this is Node ${process.versions.node}. Install a newer one (https://nodejs.org) and run ravenry setup again.`); return 1; }
  console.log(`  ok    macOS, Node ${process.versions.node}`);

  const claude = claudePath();
  // A Mac with only Codex is fine: the board follows and starts Codex there.
  const codexToo = !claude && (await import('../server/hookinstall.mjs')).codexInstalled();
  console.log(claude ? `  ok    Claude Code: ${tilde(claude)}` : codexToo ? `  note  Claude Code (claude) is not on your PATH, so Ravenry follows Codex sessions here. For Claude Code's too: ${CLAUDE_URL}` : `  !!    Claude Code (claude) is not on your PATH. Ravenry follows Claude Code sessions, so install it first: ${CLAUDE_URL}`);

  // The terminal: where the board can answer sessions.
  const here = await hereTerminal();
  const nameOf = await names();
  const iterm = await import('../server/itermhelper.mjs');
  const { cmux: hasCmux, iterm: hasIterm, rex: hasRex } = await apps();
  let terminal;
  if (here === 'cmux') { terminal = 'cmux'; console.log('  ok    Terminal: cmux. The board answers sessions in cmux.'); }
  else if (here === 'iterm') { terminal = 'iterm'; console.log('  ok    Terminal: iTerm2. The board answers sessions in iTerm2.'); }
  else if (here === 'rex') {
    terminal = 'rex';
    const r = await rexState();
    console.log(r.ok ? '  ok    Terminal: Rex. The board answers sessions in Rex.' : `  !!    Terminal: Rex, but ${r.why} Until then sessions in Rex are watch only.`);
    console.log(`  note  ${REX_REMOTE}`);
  }
  else {
    terminal = hasIterm ? 'iterm' : 'none';
    const what = here ? nameOf(here) : 'this terminal';
    if (hasIterm) console.log(`  ok    Terminal: ${what}. iTerm2 is installed, so the board answers sessions in iTerm2${hasRex ? ' and Rex' : ''}; sessions in ${what} are watch only.`);
    else if (hasRex) console.log(`  note  Terminal: ${what}. Sessions here are watch only; the board answers sessions in Rex. Start ravenry from a Rex tab so new sessions open in Rex too.`);
    else if (hasCmux) console.log(`  note  Terminal: ${what}. Sessions here are watch only. Start ravenry from a cmux tab to answer sessions in cmux, or install iTerm2 (free): ${ITERM_URL}`);
    else console.log(`  note  Terminal: ${what}. Ravenry shows your sessions here (watch only) but cannot answer them. To answer from the board, install iTerm2 (free): ${ITERM_URL}`);
  }

  // iTerm2's Python API and the arrow-key helper: only for iTerm2.
  if (here === 'iterm') {
    if (!iterm.apiOn()) console.log("  !!    iTerm2's Python API is off. Turn it on (iTerm2 > Settings > General > Magic > Enable Python API) so the board can pick menu options with the arrow keys.");
    const st = iterm.helperState();
    if (st.ready) console.log(`  ok    iTerm2 helper: ${tilde(st.python)}`);
    else {
      console.log(`\nTo pick a menu option in iTerm2 (Yes, No, a choice), the board presses the arrow keys through iTerm2's Python API. That needs a small private Python folder with iTerm2's package: ${tilde(iterm.VENV)} (pip install iterm2, about 10 MB). Everything else works without it.`);
      if (await ask('Set it up now?')) {
        const r = iterm.makeHelper((s) => console.log('        ' + s));
        console.log(r.ok ? `  ok    iTerm2 helper: ${tilde(r.python)}` : `  !!    iTerm2 helper not set up: ${r.error}`);
      } else console.log('  note  iTerm2 helper skipped. Run ravenry setup again any time.');
    }
  }

  // The data folder.
  const home = await dataHome();
  fs.mkdirSync(home, { recursive: true });
  console.log(`  ok    Data folder: ${tilde(home)}`);

  // The hooks.
  const hk = await import('../server/hookinstall.mjs');
  let hooks = 'declined';
  console.log('');
  if (FROM_NPX) {
    console.log('Hooks: not installed from npx. A hook needs a copy of Ravenry that stays put, and npx keeps its copy in a cache it may clear. Install it for good with:\n\n  npm i -g ravenry-app\n\nthen run ravenry setup again.');
    hooks = 'npx';
  } else {
    let cur;
    try { cur = hk.readSettings(); } catch (e) { console.log(`  !!    ${e.message}`); return 1; }
    const st = hk.status(cur.json);
    const { settings, changes } = hk.plan(cur.json);
    if (!changes.length) { console.log(`  ok    Hooks: both are in ${tilde(cur.file)}.`); hooks = 'installed'; }
    else {
      console.log(`Ravenry learns what each Claude Code session is doing from two hooks, which Claude Code runs on its own events. They write one line per event to ${tilde(path.join(home, 'events'))} and never block a session.`);
      if (st.state === 'stale') for (const s of st.stale) console.log(`  !!    The ${s.event} hook ${s.script} is stale: ${s.why}.`);
      console.log(`\n${st.state === 'missing' ? 'Setup adds' : 'Setup changes'} only these entries in ${tilde(cur.file)}${cur.exists ? ' (backed up first)' : ' (a new file)'}; every other hook and setting stays as it is:\n`);
      for (const c of changes) console.log('  ' + c);
      console.log('\n' + JSON.stringify({ hooks: hk.preview() }, null, 2).split('\n').map((l) => '  ' + l).join('\n') + '\n');
      if (await ask(`Write ${st.state === 'missing' ? 'these hooks' : 'these changes'} to ${tilde(cur.file)}?`)) {
        const backup = hk.writeSettings(cur.file, cur.raw, settings);
        console.log(`  ok    Hooks installed.${backup ? ` Backup: ${tilde(backup)}` : ''} New Claude sessions pick them up; running ones after a restart.`);
        hooks = 'installed';
      } else console.log('  note  Hooks not installed. Without them the board sees sessions only in cmux. Run ravenry setup again any time.');
    }
  }

  // Codex's hooks: only when Codex is installed (docs/ASSISTANTS.md).
  let codexHooks = null;
  if (!FROM_NPX && hk.codexInstalled()) {
    codexHooks = 'declined';
    let plan;
    try { plan = hk.codexPlan(); } catch (e) { console.log(`  !!    ${e.message}`); plan = null; }
    if (plan && !plan.changes.length) { console.log(`  ok    Codex hooks: in ${tilde(plan.hooks.file)}, trusted in ${tilde(plan.config.file)}.`); codexHooks = 'installed'; }
    else if (plan) {
      console.log(`\nCodex is installed. The board follows Codex sessions too (state, live screen, replies) through the same two hooks, which Codex runs on its own events. Setup adds only these entries to ${tilde(plan.hooks.file)}${plan.hooks.raw != null ? ' (backed up first)' : ' (a new file)'}, and the trust entries Codex needs to run them to ${tilde(plan.config.file)}${plan.config.raw != null ? ' (backed up first)' : ' (a new file)'}; every other hook and setting stays as it is:\n`);
      for (const c of plan.changes) console.log('  ' + c);
      console.log('');
      if (await ask(`Write them to ${tilde(plan.hooks.file)} and ${tilde(plan.config.file)}?`)) {
        const backups = hk.codexWrite(plan);
        console.log(`  ok    Codex hooks installed.${backups.length ? ` Backup${backups.length > 1 ? 's' : ''}: ${backups.map(tilde).join(', ')}` : ''} New Codex sessions pick them up.`);
        codexHooks = 'installed';
      } else console.log('  note  Codex hooks not installed. Without them the board shows a Codex session only from its screen in cmux or iTerm2. Run ravenry setup again any time.');
      if (plan.hooksOff) console.log(`  note  Codex's hooks are turned off in ${tilde(plan.config.file)} ([features] hooks = false). Ravenry leaves that as you set it; turn it on for the board to follow Codex sessions.`);
    }
  }

  // Rule suggestions: a choice about the user's data and quota, so --yes
  // never turns them on.
  const registry = await import('../server/registry.mjs');
  const reg = registry.load();
  const auto = reg && reg.settings && reg.settings.repeatsAuto;
  let rulesAuto = auto === true || (auto == null && !!reg);
  if (!rulesAuto && process.stdin.isTTY && !YES) {
    // The calls run on the assistant new sessions start with (printWith).
    const viaCodex = (await import('../server/assistant.mjs')).printWith((reg && reg.settings) || {}) === 'codex';
    console.log(`\nThe Rules view can suggest CLAUDE.md and AGENTS.md lines from the corrections you keep typing. For that, once a day Ravenry sends the messages you typed in your sessions to ${viaCodex ? 'Codex through codex exec, on your own Codex login' : 'Claude through claude -p, on your own Claude login'} (at most 3 calls a day).`);
    rulesAuto = await ask('Turn rule suggestions on?');
  }
  // Written only when it changes what the board does (a registry from before
  // this setting has them on already).
  const w = auto === !!rulesAuto || (auto == null && reg && rulesAuto) ? { ok: true } : registry.writeSettings({ repeatsAuto: !!rulesAuto });
  if (!w.ok) console.log(`  !!    ${w.error}`);
  else console.log(`  ${rulesAuto ? 'ok  ' : 'note'}  Rule suggestions ${rulesAuto ? 'on' : 'off (ravenry setup turns them on)'}.`);

  fs.writeFileSync(await setupFile(), JSON.stringify({ version: PKG.version, at: new Date().toISOString(), hooks, ...(codexHooks ? { codexHooks } : {}), terminal, rulesAuto: !!rulesAuto }, null, 2) + '\n');
  console.log(fromStart ? '\nSetup done. Starting the board.\n' : '\nSetup done. Start the board with: ravenry');
  return 0;
}

// ------------------------------------------------------------ doctor

async function doctor() {
  let bad = 0;
  const line = (k, t) => { if (k === 'fix') bad++; console.log(`  ${k.padEnd(5)} ${t}`); };
  console.log(`Ravenry ${PKG.version} at ${tilde(ROOT)}\n`);
  if (process.platform !== 'darwin') line('fix', 'This is not macOS. Ravenry runs on macOS only.');
  else { let v = ''; try { v = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(); } catch { /* old macOS */ } line('ok', `macOS ${v}`); }
  const node = nodeMajorOk();
  line(node.ok ? 'ok' : 'fix', node.ok ? `Node ${process.versions.node}` : `Node ${process.versions.node}: Ravenry needs ${node.want} or newer (https://nodejs.org).`);
  if (FROM_NPX) line('note', 'Running from npx. For the hooks, install it for good: npm i -g ravenry-app, then ravenry setup.');
  const claude = claudePath();
  const codexOnly = !claude && (await import('../server/hookinstall.mjs')).codexInstalled();
  line(claude ? 'ok' : codexOnly ? 'note' : 'fix', claude ? `Claude Code: ${tilde(claude)}` : codexOnly ? `Claude Code (claude) is not on your PATH; Ravenry follows Codex sessions here: ${CLAUDE_URL}` : `Claude Code (claude) is not on your PATH: ${CLAUDE_URL}`);

  const here = await hereTerminal();
  const nameOf = await names();
  const iterm = await import('../server/itermhelper.mjs');
  const { cmux: hasCmux, iterm: hasIterm, rex: hasRex } = await apps();
  const installed = [hasCmux && 'cmux', hasIterm && 'iTerm2', hasRex && 'Rex'].filter(Boolean);
  const listed = installed.length > 1 ? installed.slice(0, -1).join(', ') + ' and ' + installed[installed.length - 1] : installed[0];
  line('ok', `This terminal: ${here ? nameOf(here) : 'unknown'}. Installed: ${listed || 'none of cmux, iTerm2 or Rex'}.`);
  if (!hasCmux && !hasIterm && !hasRex) line('note', `The board can only watch sessions. To answer them from the board, install iTerm2 (free): ${ITERM_URL}`);
  if (hasRex) {
    const r = await rexState();
    line(r.ok ? 'ok' : 'note', r.ok ? `Rex: ${tilde(r.bin)}, its server answers (Rex ${r.version}, API revision ${r.revision}).` : `Rex: ${r.why}`);
    line('note', REX_REMOTE);
  }
  if (hasIterm) {
    line(iterm.apiOn() ? 'ok' : 'note', iterm.apiOn() ? "iTerm2's Python API is on." : "iTerm2's Python API is off: turn it on in iTerm2 > Settings > General > Magic so the board can pick menu options.");
    const st = iterm.helperState();
    line(st.ready ? 'ok' : 'note', st.ready ? `iTerm2 helper: ${tilde(st.python)}` : 'iTerm2 helper for the arrow keys is not set up: run ravenry setup in an iTerm2 tab.');
  }

  const hk = await import('../server/hookinstall.mjs');
  try {
    const cur = hk.readSettings();
    const st = hk.status(cur.json);
    if (st.state === 'ok') line('ok', `Hooks: both in ${tilde(cur.file)}, running this copy.`);
    else if (st.state === 'stale') for (const s of st.stale) line('fix', `Hook ${s.script} on ${s.event} is stale: ${s.why}. Run ravenry setup to point it here.`);
    else if (st.state === 'partial') line('fix', `Hooks: only some are in ${tilde(cur.file)} (${st.scripts.map((s) => `${s.script} on ${s.events.join(', ') || 'nothing'}`).join('; ')}). Run ravenry setup.`);
    else line('fix', `Hooks: not installed, so the board sees sessions only in cmux. Run ravenry setup.`);
  } catch (e) { line('fix', e.message); }
  if (hk.codexInstalled()) {
    try {
      const cs = hk.codexStatus();
      if (cs.state === 'ok') line('ok', `Codex hooks: both in ${tilde(cs.file)}, trusted, running this copy.`);
      else if (cs.state === 'stale') for (const s of cs.stale) line('note', `Codex hook ${s.script} on ${s.event} is stale: ${s.why}. Run ravenry setup to point it here.`);
      else if (cs.state === 'untrusted') line('note', `Codex hooks: in ${tilde(cs.file)} but Codex has no trust entry for ${cs.untrusted.length} of them, so outside cmux it skips them. Run ravenry setup.`);
      else if (cs.state === 'partial') line('note', `Codex hooks: only some are in ${tilde(cs.file)}. Run ravenry setup.`);
      else line('note', 'Codex hooks: not installed, so the board shows a Codex session only from its screen. Run ravenry setup.');
      if (cs.hooksOff) line('note', "Codex's hooks are turned off in its config.toml ([features] hooks = false).");
    } catch (e) { line('note', `Codex hooks: ${e.message}`); }
  }

  const home = await dataHome();
  const setupDone = await readSetup();
  if (!fs.existsSync(home)) line('note', `Data folder ${tilde(home)} is not there yet: ravenry setup makes it.`);
  else {
    let n = 0;
    try { n = (JSON.parse(fs.readFileSync(path.join(home, 'projects.json'), 'utf8')).projects || []).filter((p) => !p.hidden).length; } catch { /* none yet */ }
    line('ok', `Data folder: ${tilde(home)} (${n} project${n === 1 ? '' : 's'})${setupDone ? '' : '; setup has not run from this copy'}.`);
  }
  const b = await boardUp();
  line(b.up && !b.ours ? 'fix' : 'ok', b.up ? (b.ours ? `The board answers on ${URL_}` : `Something that is not Ravenry holds :${PORT}. Stop it, or start with PORT=<another port> ravenry.`) : `The board is not running (ravenry starts it on :${PORT}).`);
  let pw = false;
  try { await import('playwright'); pw = true; } catch { /* optional */ }
  line(pw ? 'ok' : 'note', pw ? 'Playwright: found (idea mockup pictures work).' : 'Playwright: not installed. Optional, only for idea mockup pictures: npm i -g playwright && npx playwright install chromium');
  console.log(bad ? `\n${bad} thing${bad > 1 ? 's' : ''} to fix.` : '\nAll good.');
  return bad ? 1 : 0;
}

// ------------------------------------------------------------ uninstall

async function uninstall() {
  const purge = flags.has('--purge');
  const hk = await import('../server/hookinstall.mjs');
  let cur;
  try { cur = hk.readSettings(); } catch (e) { console.log(e.message); return 1; }
  const { settings, changes } = hk.plan(cur.json, { remove: true });
  if (!changes.length) console.log(`Ravenry's hooks are not in ${tilde(cur.file)}; nothing to take out.`);
  else {
    console.log(`Takes only Ravenry's entries out of ${tilde(cur.file)} (backed up first):\n`);
    for (const c of changes) console.log('  ' + c);
    console.log('');
    if (await ask('Take them out?')) {
      const backup = hk.writeSettings(cur.file, cur.raw, settings);
      console.log(`Hooks removed. Backup: ${tilde(backup)}`);
    } else { console.log('Nothing changed.'); return 1; }
  }
  // Codex's hooks, when Codex is there and they are in its files.
  if (hk.codexInstalled()) {
    let cp = null;
    try { cp = hk.codexPlan({ remove: true }); } catch (e) { console.log(e.message); }
    if (cp && cp.changes.length) {
      console.log(`\nTakes only Ravenry's entries out of ${tilde(cp.hooks.file)} and ${tilde(cp.config.file)} (backed up first):\n`);
      for (const c of cp.changes) console.log('  ' + c);
      console.log('');
      if (await ask('Take them out?')) { const b = hk.codexWrite(cp); console.log(`Codex hooks removed. Backup${b.length > 1 ? 's' : ''}: ${b.map(tilde).join(', ')}`); }
      else console.log('Codex hooks left in place.');
    }
  }
  // The "Ravenry board" profiles `ravenry` wrote for iTerm2 (its own file).
  const prof = path.join(os.homedir(), 'Library', 'Application Support', 'iTerm2', 'DynamicProfiles', 'ravenry.json');
  if (fs.existsSync(prof)) { fs.rmSync(prof, { force: true }); console.log(`Removed the iTerm2 profile file ${tilde(prof)}.`); }
  const home = await dataHome();
  if (purge && fs.existsSync(home)) {
    console.log(`\n--purge deletes ${tilde(home)}: your briefs, ideas, settings and the iTerm2 helper.`);
    if (await ask(`Delete ${tilde(home)}?`)) { fs.rmSync(home, { recursive: true, force: true }); console.log(`Deleted ${tilde(home)}.`); }
  } else if (fs.existsSync(home)) console.log(`Your data stays in ${tilde(home)} (ravenry uninstall --purge deletes it).`);
  const b = await boardUp();
  if (b.up && b.ours) console.log(`The board still runs on ${URL_}: stop it with Ctrl+C in its terminal.`);
  console.log('To remove the command too: npm rm -g ravenry');
  return 0;
}

// ------------------------------------------------------------ start

// Is iTerm2 or Rex on this Mac? The same answers as server/terminal.mjs
// appInstalled, without loading it (MC_APPS stands in for the apps in tests).
async function itermThere() {
  if (env.MC_APPS != null) return env.MC_APPS.split(',').map((x) => x.trim()).includes('iterm');
  return [path.join('/Applications', 'iTerm.app'), path.join(os.homedir(), 'Applications', 'iTerm.app')].some((p) => fs.existsSync(p));
}
async function rexThere() {
  if (env.MC_APPS != null) return env.MC_APPS.split(',').map((x) => x.trim()).includes('rex');
  return !!(await import('../server/rex.mjs')).findBin(env);
}

async function serve() {
  await import('../server/index.mjs');
  return null; // the server keeps the process alive
}

async function start() {
  if (process.platform !== 'darwin') { console.log('Ravenry runs on macOS only.'); return 1; }
  // Decided before anything loads server/terminal.mjs, which reads it once.
  // Outside cmux, cmux's socket refuses the board, so it runs in iTerm2 mode,
  // or in Rex mode when started in a Rex tab.
  const here = await hereTerminal();
  const chosen = !!env.RAVENRY_TERMINAL;
  // A Mac with Rex and no iTerm2 runs Rex mode from anywhere, as one with
  // iTerm2 runs iTerm2 mode. (server/terminal.mjs is not loaded for this:
  // it reads RAVENRY_TERMINAL once, when it loads.)
  if (here !== 'cmux' && !chosen) env.RAVENRY_TERMINAL = here === 'rex' || (here !== 'iterm' && !(await itermThere()) && (await rexThere())) ? 'rex' : 'iterm';
  if (!(await readSetup())) { const r = await setup({ fromStart: true }); if (r) return r; }
  const b = await boardUp();
  if (b.up && !b.ours) { console.log(`Something that is not Ravenry holds :${PORT}. Stop it, or start with PORT=<another port> ravenry.`); return 1; }
  if (b.up) {
    console.log(`Ravenry is already running on ${URL_}`);
    if (!NO_OPEN) await openUrl(URL_);
    return 0;
  }
  if (here === 'iterm' && !NO_OPEN && !chosen) {
    const { main } = await import('../tools/open-in-iterm.mjs');
    const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    return main([], console.log, { run: `${sh(process.execPath)} ${sh(path.join(ROOT, 'bin', 'ravenry.mjs'))} serve` });
  }
  const { appInstalled } = await import('../server/terminal.mjs');
  if (here !== 'cmux' && here !== 'iterm' && here !== 'rex' && !appInstalled('iterm') && !appInstalled('rex')) console.log(`Watch only: answering sessions from the board needs iTerm2 (free), cmux or Rex. Install iTerm2: ${ITERM_URL}`);
  console.log(`Starting Ravenry on ${URL_} . Leave this window open; Ctrl+C stops it.`);
  await serve();
  if (!NO_OPEN) {
    for (let i = 0; i < 40 && !(await boardUp()).up; i++) await new Promise((r) => setTimeout(r, 250));
    if (here === 'cmux' && env.CMUX_WORKSPACE_ID) {
      // The page in a cmux browser pane above this terminal, as the pinned
      // "Ravenry" workspace holds it; the default browser if cmux says no.
      const cm = env.CMUX_BIN || '/Applications/cmux.app/Contents/Resources/bin/cmux';
      const ok = await new Promise((resolve) => execFile(cm, ['new-pane', '--type', 'browser', '--direction', 'up', '--url', URL_, '--workspace', env.CMUX_WORKSPACE_ID], { timeout: 8000 }, (err) => resolve(!err)));
      if (!ok) await openUrl(URL_);
    } else await openUrl(URL_);
  }
  return null;
}

// ------------------------------------------------------------ main

async function main() {
  if (flags.has('--version') || flags.has('-v') || cmd === 'version') { console.log(PKG.version); return 0; }
  if (cmd === 'help' || flags.has('--help') || flags.has('-h')) { console.log(HELP); return 0; }
  switch (cmd) {
    case '': return start();
    case 'start': return start();
    case 'setup': return setup();
    case 'doctor': return doctor();
    case 'uninstall': return uninstall();
    case 'serve': return serve();
    default: console.log(`Unknown command "${cmd}".\n\n${HELP}`); return 2;
  }
}

main().then((code) => { if (code != null) process.exit(code); }, (e) => { console.error(e.stack || e.message); process.exit(1); });
