// What the native Mac app puts on this machine besides its window, done as
// the Electron app's main process does it (apps/desktop/src/main/main.ts:
// stage(), startHub(), setUpService(), and the prune a minute later), with
// the same code (install.ts, npmswitch.ts), so both apps keep one layout:
// <data>/versions/<version>/, <data>/bin/ravenryd and ravenry, <data>/current
// (the hub points it at its folder), the hub service dev.ravenry.hub in
// ~/Library/LaunchAgents, the app's log ~/Library/Logs/Ravenry/app.log.
//
// The app runs it on the Node it carries (Contents/MacOS/node), one
// command a run, each printing one line of JSON:
//
//   node setup.mjs stage --resources DIR
//       copies DIR's ravenryd, hub and remote/ to <data>/versions/<version>
//       (unless that build is there) and points bin/ at it
//   node setup.mjs hub --resources DIR --exe APP_EXECUTABLE
//       the hub service: none beside an npm board (the switch offered in
//       the Electron app is left to it: this says `offer`), the switch
//       finished when only its traces are left, else the service installed
//       or brought to this build, run as APP_EXECUTABLE with
//       ELECTRON_RUN_AS_NODE=1 (the app runs its Node for it), with the
//       update attempts counted as the Electron app counts them
//       --retry: the update that stopped after 3 tries is tried again
//       (Try again in the window); --port P --restart: the switch's hub,
//       on the npm board's port, restarted
//   node setup.mjs prune --keep VERSION
//       removes the version folders nothing runs from (their hook scripts
//       left as stubs that run current's)
//   node setup.mjs npm-detect --resources DIR
//   node setup.mjs npm-choice --set not-now|back|switched
//   node setup.mjs npm-switch --resources DIR --exe APP_EXECUTABLE
//   node setup.mjs npm-back --resources DIR
//       the switch from the npm board and the way back, as the Electron
//       app's main.ts does them (detectNpm, switchFromNpm, backToNpm): what
//       the window offers (offerFor), each step on standard error as it is
//       done (`@step {...}` lines, and the script's log lines), the answer
//       on standard output. The person's choice (Not now, back, switched)
//       is kept in <data>/npm-choice.json (the Electron app keeps it in
//       window.json, read when this file is not there).
//   node setup.mjs command --state | --on | --off
//       the `ravenry` a terminal runs (the person's login shell's PATH): the
//       app's (<data>/bin/ravenry, the one agents use) or another (the npm
//       board's launcher, ravenry-app). --on links ~/.local/bin/ravenry to
//       <data>/bin/ravenry and, only when ~/.local/bin does not come before
//       the other one on that PATH, adds two marked lines at the end of the
//       shell's startup file (~/.zshrc, ~/.bash_profile), backed up first;
//       never over a ~/.local/bin/ravenry that is not the app's. --off takes
//       out exactly what --on made. The window asks the person first.
//   node setup.mjs uninstall [--purge]
//       Ravenry taken off this Mac (HUB-016): its hooks out of Claude Code's
//       and Codex's files and its skill out of their skills folders (each put
//       back as it was, else only Ravenry's entries out, backed up), the hub
//       service stopped and its file removed, the ravenry command (--off),
//       bin/, current and the version folders; --purge deletes the data too
//       (<data> and RAVENRY_HOME, ~/.ravenry). The terminals open now keep
//       running until they end. Answers what it did, line by line.
//
// Bundled into one file by apps/macos/scripts/package.mjs (esbuild): it
// needs nothing but Node.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  dataRoot, ensureService, launchctlBin, pruneVersions, readBuildInfo, removeService, serviceFile, serviceMode, serviceSpec, stageVersion, updateAttempt,
} from '../../desktop/src/main/install.ts';
import type { Staged } from '../../desktop/src/main/install.ts';
import { launchPlan, offerFor, runScript, scriptPath } from '../../desktop/src/main/npmswitch.ts';
import type { NpmDetect } from '../../desktop/src/main/npmswitch.ts';
import { hubUrl } from '../../desktop/src/main/hub.ts';
import { setupWithRavenryd } from '../../../hub/server/hookinstall.mjs';
import { setSkill, skillStatus, SKILL_ASSISTANTS } from '../../../hub/server/skills.mjs';
import { sayPath } from '../../../hub/public/homepath.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const out = (o: object): never => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(0); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A line in the app's log, beside the hub's (the Electron app's appLog).
function appLog(line: string): void {
  try {
    const dir = path.join(os.homedir(), 'Library', 'Logs', 'Ravenry');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'app.log'), `${new Date().toISOString()} ${line}\n`);
  } catch { /* no log: the app goes on */ }
}

function stage(resources: string): Staged {
  const build = readBuildInfo(resources);
  if (!build) throw new Error(`no build.json in ${resources}`);
  return stageVersion({ resources, root: dataRoot(), build });
}

// The update record (the Electron app keeps it in window.json; the native
// app's window writes that file, so this keeps it apart).
const recordFile = () => path.join(dataRoot(), 'update.json');
function readRecord(): { version?: string; attempts?: number; why?: string } | null {
  try { return JSON.parse(fs.readFileSync(recordFile(), 'utf8')); } catch { return null; }
}
function writeRecord(r: object | null): void {
  try { if (r) fs.writeFileSync(recordFile(), JSON.stringify(r) + '\n'); else fs.rmSync(recordFile(), { force: true }); } catch { /* next time */ }
}

function serviceRun(c: string, args: string[]): { status: number | null; out: string } {
  const r = spawnSync(c, args, { encoding: 'utf8', timeout: 15000 });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// A test's run (its own data folder or launchd label): the board only where
// RAVENRY_HUB_URL or the test's own board.json names it, never the default
// :4600, which is the person's board (2026-11-11: a check's setup took the
// person's board for its own and installed no service).
const isTestRun = () => !!process.env.RAVENRY_DESKTOP_DATA || /^dev\.ravenry\.hub\.test-/.test(process.env.RAVENRY_SERVICE_LABEL || '');
function boardUrl(): string | null {
  if (process.env.RAVENRY_HUB_URL) return hubUrl();
  const bj = path.join(process.env.RAVENRY_HOME || path.join(os.homedir(), '.ravenry'), 'board.json');
  if (isTestRun() && !fs.existsSync(bj)) return null;
  return hubUrl();
}
/** The board's port: the URL's, else the service's PORT, else 4600 (never 4600 in a test's run: 0). */
function boardPort(): number {
  const u = boardUrl();
  const p = (u && Number(new URL(u).port)) || Number(process.env.PORT) || 4600;
  return isTestRun() && p === 4600 ? 0 : p;
}

async function boardAnswers(): Promise<boolean> {
  const u = boardUrl();
  if (!u || (isTestRun() && Number(new URL(u).port) === 4600)) return false;
  try { return (await fetch(u + '/api/state', { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

// The new hub after an update: up to 60 s to listen, then 30 s from its
// listen for any HTTP answer (main.ts newHubAnswers).
async function newHubAnswers(port: number): Promise<boolean> {
  if (!port) { appLog('service: a test run with no port of its own: the new hub is not waited for'); return false; }
  const t0 = Date.now();
  const open = () => new Promise<boolean>((r) => {
    const s = net.connect(port, '127.0.0.1');
    const done = (v: boolean) => { s.destroy(); r(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1000, () => done(false));
  });
  let listening = false;
  while (!listening && Date.now() - t0 < 60000) { listening = await open(); if (!listening) await sleep(250); }
  if (!listening) { appLog('service: the new hub did not listen within 60 s'); return false; }
  const at = Date.now();
  while (Date.now() - at < 30000) {
    try { await fetch(`http://127.0.0.1:${port}/api/whoami`, { signal: AbortSignal.timeout(2000) }); appLog(`service: the new hub answered ${Date.now() - at} ms after it listened`); return true; } catch { /* not yet */ }
    await sleep(500);
  }
  appLog('service: the new hub did not answer within 30 s of its listen');
  return false;
}

// ------------------------------------------------------------ the npm board

// The hub script of this version (the staged hub), on the app's Node.
const npmEnv = () => ({ ...process.env, RAVENRY_LAUNCHCTL: launchctlBin() });
function npmScript(st: Staged, args: string[], onLog?: (l: string) => void): Promise<Record<string, unknown> & { ok: boolean; error?: string }> {
  return runScript({ exe: process.execPath, script: scriptPath(st.hubEntry), args: [...args, '--app-data', dataRoot()], env: npmEnv(), onLog });
}

// The person's answer to the offer: npm-choice.json, else the Electron app's window.json.
const choiceFile = () => path.join(dataRoot(), 'npm-choice.json');
function readChoice(): string | null {
  try { return String(JSON.parse(fs.readFileSync(choiceFile(), 'utf8')).choice || '') || null; } catch { /* none here */ }
  try { return String(JSON.parse(fs.readFileSync(path.join(dataRoot(), 'window.json'), 'utf8')).npmChoice || '') || null; } catch { return null; }
}
function writeChoice(choice: string): void {
  try { fs.mkdirSync(dataRoot(), { recursive: true }); fs.writeFileSync(choiceFile(), JSON.stringify({ choice, at: new Date().toISOString() }) + '\n'); } catch { /* next time */ }
}

async function detectNpm(st: Staged): Promise<NpmDetect | null> {
  const d = (await npmScript(st, ['detect'])) as unknown as NpmDetect;
  if (!d || !d.ok) { appLog(`npm board: could not look for it: ${d?.error || 'no answer'}`); return null; }
  return d;
}

// A line to the window as it happens: standard error, as the hub script's.
const tell = (line: string) => { try { process.stderr.write(line + '\n'); } catch { /* the window went */ } };

async function waitForHub(port: number, ms = 30000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) })).ok) return true; } catch { /* not yet */ }
    await sleep(500);
  }
  return false;
}

// What the person cares about, as the app's hub now shows it (main.ts hubCounts).
async function hubCounts(port: number): Promise<Record<string, number> | null> {
  const url = `http://127.0.0.1:${port}`;
  const get = async (p: string) => (await fetch(url + p, { signal: AbortSignal.timeout(4000) })).json();
  try {
    const st = await get('/api/state') as { projects?: { hidden?: boolean; sessions?: unknown[]; plan?: unknown }[] };
    const projects = (st.projects || []).filter((p) => !p.hidden);
    const ideas = await get('/api/ideas').catch(() => ({})) as { ideas?: { archived?: boolean }[] };
    const rules = await get('/api/rules/mine').catch(() => ({})) as { count?: number };
    return {
      projects: projects.length,
      sessions: projects.reduce((n, p) => n + (p.sessions || []).length, 0),
      ideas: (ideas.ideas || []).filter((i) => !i.archived).length,
      plans: projects.filter((p) => p.plan).length,
      rules: Number(rules.count) || 0,
    };
  } catch { return null; }
}

// The person agreed (main.ts switchFromNpm): the npm board stops, its
// login start and hooks move, and the app's hub starts on the same data
// and port.
async function npmSwitch(resources: string, exe: string): Promise<object> {
  const st = stage(resources);
  const from = await detectNpm(st);
  const r = await npmScript(st, ['switch', '--ravenryd', st.link], tell);
  if (!r.ok) return { ok: false, phase: 'error', message: r.error || 'The switch stopped.', from, detect: await detectNpm(st) };
  const rec = (r as { record?: { port?: number } }).record || {};
  const port = Number(rec.port) || 4600;
  tell(`hub: starting the app's hub on :${port}`);
  tell(`@step ${JSON.stringify({ id: 'hub', port, done: false })}`);
  await serviceUp(st, exe, { port, restart: true });
  const up = await waitForHub(port);
  if (up) tell(`@step ${JSON.stringify({ id: 'hub', port, done: true })}`);
  const counts = up ? await hubCounts(port) : null;
  writeChoice('switched');
  const detect = await detectNpm(st);
  appLog(`npm board: switched to the app's hub on :${port}${up ? '' : ', which did not answer'}`);
  return {
    ok: up, phase: up ? 'switched' : 'error', result: r, counts, from, detect, offer: 'none',
    message: up ? null : `The npm board is stopped and the hooks moved, but the app's hub did not answer on :${port}. Its log: ~/Library/Logs/Ravenry/hub.log`,
  };
}

// The way back (main.ts backToNpm): the app's hub stops and leaves, then
// the hub script puts the ideas, hooks and login start back.
async function npmBack(resources: string): Promise<object> {
  const st = stage(resources);
  const rm = removeService({ mode: serviceMode(process.env, true), run: serviceRun });
  tell(`hub: the app's hub service ${rm.state === 'off' ? 'was not installed' : 'is stopped and removed'}`);
  // Its board.json goes when it exits.
  const bj = path.join(process.env.RAVENRY_HOME || path.join(os.homedir(), '.ravenry'), 'board.json');
  for (let i = 0; i < 100; i++) {
    let pid = 0;
    try { pid = Number(JSON.parse(fs.readFileSync(bj, 'utf8')).pid) || 0; } catch { break; }
    try { process.kill(pid, 0); } catch { break; }
    await sleep(100);
  }
  const r = await npmScript(st, ['back'], tell);
  if (!r.ok) return { ok: false, phase: 'error', message: r.error || 'Going back stopped.', result: r, detect: await detectNpm(st) };
  writeChoice('back');
  const detect = await detectNpm(st);
  appLog('npm board: went back to the npm board');
  return { ok: true, phase: 'back', result: r, detect, offer: offerFor(detect, 'back') };
}

// The hub service, installed or brought to this build (main.ts setUpService).
async function serviceUp(st: Staged, exe: string, opts: { port?: number; restart?: boolean } = {}) {
  const mode = serviceMode(process.env, true);
  // The npm board's port when it ran on another (PORT=4700 ravenry).
  const env = opts.port && opts.port !== 4600 ? { ...process.env, PORT: String(opts.port) } : process.env;
  const port = opts.port || boardPort();
  return { mode, port, r: await ensureService({ mode, spec: serviceSpec({ execPath: exe, staged: st, env }), run: serviceRun, boardAnswers, restart: opts.restart, answers: () => newHubAnswers(port) }) };
}

async function hub(resources: string, exe: string, retry = false): Promise<object> {
  const st = stage(resources);
  // The npm board (npmswitch.ts): the hub script says what of it is here.
  let detect = await detectNpm(st);
  let installed = false;
  try { installed = fs.existsSync(serviceFile()); } catch { /* none */ }
  const plan = launchPlan(detect, installed);
  appLog(`launch: native app ${st.version}: ${plan} (npm board traces: ${detect ? (detect.npm ? 'yes' : 'none') : 'not looked at'}, service ${installed ? 'installed' : 'not installed'})`);
  if (plan === 'offer') return { ok: true, plan, why: 'an npm board serves this data: the app starts no hub of its own beside it', detect, offer: offerFor(detect, readChoice()) };
  if (plan === 'finish') {
    const r = await npmScript(st, ['switch', '--ravenryd', st.link]);
    appLog(`npm board: finished the switch: ${r.ok ? 'its traces moved' : r.error || 'it stopped'}`);
    detect = await detectNpm(st);
  }
  const mode = serviceMode(process.env, true);
  const port = boardPort();
  let before: string | null = null;
  try { before = fs.readFileSync(serviceFile(), 'utf8'); } catch { /* none yet */ }
  const updating = mode !== 'off' && mode !== 'dry-run' && !!before && !before.includes(`${path.sep}versions${path.sep}${st.version}${path.sep}`);
  if (retry) { writeRecord(null); appLog('launch: update tried again from the window'); }
  const rec = readRecord();
  const { attempt, stop } = updateAttempt(rec, st.version);
  if (updating && stop) {
    appLog(`launch: update to ${st.version} stopped after 3 failed attempts: ${rec?.why || ''}`);
    return { ok: false, plan, stopped: true, version: st.version, why: rec?.why || 'the new hub did not answer', detect, offer: offerFor(detect, readChoice()) };
  }
  if (updating) appLog(`launch: update to ${st.version}, attempt ${attempt}`);
  const r = await ensureService({ mode, spec: serviceSpec({ execPath: exe, staged: st }), run: serviceRun, boardAnswers, answers: () => newHubAnswers(port) });
  // launchctl's words end in a newline: one line, for app.log and the toast.
  if (r.why) r.why = r.why.replace(/\s*\n\s*/g, ' ').trim();
  const would = mode === 'dry-run' ? `; would run: ${r.commands.map((c) => c.join(' ')).join('; ')}` : '';
  appLog(`service: ${r.state}${r.file ? ` ${r.file}` : ''}${r.why ? ` (${r.why})` : ''}${would}`);
  if (updating) writeRecord(r.state === 'failed' ? { version: st.version, attempts: attempt, why: r.why || '' } : null);
  return { ok: r.state !== 'failed', plan, service: r.state, file: r.file || null, why: r.why || null, updating, attempt: updating ? attempt : 0, version: st.version, detect, offer: offerFor(detect, readChoice()) };
}

function prune(keep: string): object {
  let svc: string | null = null;
  try { svc = fs.readFileSync(serviceFile(), 'utf8'); } catch { /* none */ }
  // The daemons running (their sockets), what runs from a version folder
  // (any process's command line), and the hooks that name one.
  const rt = process.env.RAVENRY_RUNTIME_DIR || path.join(process.env.RAVENRY_STATE_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'Ravenry'), 'run');
  let running: string[] = [];
  try { running = fs.readdirSync(rt).map((n) => /^ravenryd-(.+)\.sock$/.exec(n)?.[1]).filter((v): v is string => !!v); } catch { /* none */ }
  const inUse: string[] = [];
  try { inUse.push(spawnSync('/bin/ps', ['-axww', '-o', 'command='], { encoding: 'utf8', timeout: 10000 }).stdout || ''); } catch { /* none */ }
  for (const f of [path.join(os.homedir(), '.claude', 'settings.json'), path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json')]) {
    try { inUse.push(fs.readFileSync(f, 'utf8')); } catch { /* none */ }
  }
  const gone = pruneVersions(dataRoot(), keep, running, svc, inUse);
  if (gone.length) appLog(`install: removed versions nothing runs from: ${gone.join(', ')}`);
  return { ok: true, removed: gone };
}

// ------------------------------------------------------------ the ravenry command

const MARK = '# Ravenry: its ravenry command first (the Ravenry menu, Remove the ravenry Command, takes these two lines out)';
const LINE = 'export PATH="$HOME/.local/bin:$PATH"';
const real = (p: string): string | null => { try { return fs.realpathSync(p); } catch { return null; } };
const isExe = (f: string): boolean => { try { const st = fs.statSync(f); return st.isFile() && (st.mode & 0o111) !== 0; } catch { return false; } };

/** The PATH of a new terminal: the person's login shell, interactive, as Terminal starts it. */
function loginPath(): { path: string; shell: string } {
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
  const r = spawnSync(shell, ['-l', '-i', '-c', 'printf "\\n__RAVENRY_PATH__%s\\n" "$PATH"'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], cwd: os.homedir() });
  const m = /__RAVENRY_PATH__(.*)/.exec(r.stdout || '');
  return { path: m ? m[1].trim() : (process.env.PATH || ''), shell };
}

/** The startup file a new terminal of this shell reads last. */
function rcFile(shell: string): string {
  const b = path.basename(shell);
  if (b === 'zsh') return path.join(process.env.ZDOTDIR || os.homedir(), '.zshrc');
  if (b === 'bash') return path.join(os.homedir(), '.bash_profile');
  return path.join(os.homedir(), '.profile');
}

/** What another `ravenry` is, in words: the npm board's launcher with its version, else its path. */
function describe(f: string): string {
  const r = real(f) || f;
  const m = /^(.*\/node_modules\/ravenry-app)\//.exec(r);
  if (m) {
    let v = '';
    try { v = JSON.parse(fs.readFileSync(path.join(m[1], 'package.json'), 'utf8')).version || ''; } catch { /* none */ }
    return `the npm board's ravenry (ravenry-app${v ? ` ${v}` : ''})`;
  }
  return sayPath(f, os.homedir());
}

function commandState() {
  const target = path.join(dataRoot(), 'bin', 'ravenry');
  const linkDir = path.join(os.homedir(), '.local', 'bin');
  const link = path.join(linkDir, 'ravenry');
  const { path: PATH, shell } = loginPath();
  const dirs = PATH.split(':').filter(Boolean);
  const ours = (f: string) => { const a = real(f), b = real(target); return !!a && !!b && a === b; };
  let first: string | null = null;
  for (const d of dirs) { const f = path.join(d, 'ravenry'); if (isExe(f)) { first = f; break; } }
  const firstOurs = !!first && ours(first);
  let other: string | null = null;
  for (const d of dirs) { const f = path.join(d, 'ravenry'); if (isExe(f) && !ours(f)) { other = f; break; } }
  let linkOurs = false, blocked = false;
  try { fs.lstatSync(link); linkOurs = ours(link) || (() => { try { return fs.readlinkSync(link) === target; } catch { return false; } })(); blocked = !linkOurs; } catch { /* none */ }
  const iLink = dirs.indexOf(linkDir);
  const iOther = other ? dirs.indexOf(path.dirname(other)) : -1;
  const rc = rcFile(shell);
  let rcText = '';
  try { rcText = fs.readFileSync(rc, 'utf8'); } catch { /* none */ }
  return {
    ok: true, installed: isExe(target), target, link, linkOurs, blocked, first, firstOurs, other, otherWhat: other ? describe(other) : null,
    needsLine: iLink < 0 || (iOther >= 0 && iOther < iLink), rc, lineOurs: rcText.includes(MARK), shell,
  };
}

function commandOn() {
  const st = commandState();
  if (!st.installed) return { ...st, ok: false, error: `Ravenry's command is not installed yet (${sayPath(st.target, os.homedir())}).` };
  if (st.blocked) return { ...st, ok: false, error: `${sayPath(st.link, os.homedir())} is another program; Ravenry leaves it alone.` };
  const did: string[] = [];
  if (!st.linkOurs) {
    fs.mkdirSync(path.dirname(st.link), { recursive: true });
    fs.symlinkSync(st.target, st.link);
    did.push(`linked ${sayPath(st.link, os.homedir())} to ${sayPath(st.target, os.homedir())}`);
  }
  if (st.needsLine && !st.lineOurs) {
    let before: string | null = null;
    try { before = fs.readFileSync(st.rc, 'utf8'); } catch { /* a new file */ }
    if (before != null) {
      const backup = `${st.rc}.ravenry-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.writeFileSync(backup, before);
      did.push(`backed up ${sayPath(st.rc, os.homedir())} to ${sayPath(backup, os.homedir())}`);
    }
    const sep = before && !before.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(st.rc, `${sep}\n${MARK}\n${LINE}\n`);
    did.push(`added two lines at the end of ${sayPath(st.rc, os.homedir())}`);
  }
  for (const d of did) appLog(`command: ${d}`);
  const after = commandState();
  return { ...after, ok: after.firstOurs, did, ...(after.firstOurs ? {} : { error: `A new terminal still runs ${after.first ? describe(after.first) : 'no ravenry'}.` }) };
}

function commandOff() {
  const st = commandState();
  const did: string[] = [];
  if (st.linkOurs) { fs.rmSync(st.link, { force: true }); did.push(`removed ${sayPath(st.link, os.homedir())}`); }
  if (st.lineOurs) {
    const text = fs.readFileSync(st.rc, 'utf8');
    const next = text.replace(`\n${MARK}\n${LINE}\n`, '').replace(`${MARK}\n${LINE}\n`, '');
    fs.writeFileSync(st.rc, next);
    did.push(`took Ravenry's two lines out of ${sayPath(st.rc, os.homedir())}`);
  }
  for (const d of did) appLog(`command: ${d}`);
  return { ...commandState(), ok: true, did };
}

// ------------------------------------------------------------ uninstall

function uninstall(purge: boolean): object {
  const did: string[] = [];
  const left: string[] = [];
  const mcHome = process.env.RAVENRY_HOME || process.env.MC_HOME || path.join(os.homedir(), '.ravenry');
  const tilde = (p: string) => sayPath(p, os.homedir());
  // The hooks, Claude Code's and Codex's: put back as they were, else only ours out (backed up).
  try {
    const r = setupWithRavenryd({ remove: true, undoFile: path.join(mcHome, 'setup-undo.json') }) as { ok: boolean; error?: string; claude?: { file: string; changes: string[]; restored?: boolean; backup?: string | null } | null; codex?: { file: string; changes: string[]; restored?: boolean; backups?: string[] } | null };
    if (!r.ok) left.push(`the hooks: ${r.error}`);
    for (const [name, x] of [['Claude Code', r.claude], ['Codex', r.codex]] as const) {
      if (!x) continue;
      if (x.restored) did.push(`${name}'s hooks: ${tilde(x.file)} put back as it was before Ravenry`);
      else if (x.changes.length) did.push(`${name}'s hooks: Ravenry's ${x.changes.length} entr${x.changes.length === 1 ? 'y' : 'ies'} taken out of ${tilde(x.file)}${'backup' in x && x.backup ? ` (backup ${tilde(x.backup)})` : 'backups' in x && x.backups && x.backups.length ? ` (backup ${x.backups.map(tilde).join(', ')})` : ''}`);
    }
  } catch (e) { left.push(`the hooks: ${(e as Error).message}`); }
  // The skill, for each assistant, when it is Ravenry's.
  for (const k of SKILL_ASSISTANTS) {
    try {
      const st = skillStatus(k);
      if (!st.ours) continue;
      const r = setSkill({ kind: k, on: false }, path.join(mcHome, 'skills-undo.json')) as { ok: boolean; error?: string };
      if (r.ok) did.push(`the Ravenry skill taken out of ${tilde(st.dir)}`);
      else left.push(`the skill in ${tilde(st.dir)}: ${r.error}`);
    } catch (e) { left.push(`the ${k} skill: ${(e as Error).message}`); }
  }
  // The ravenry command, when the app put it there.
  try { const c = commandOff(); for (const d of c.did) did.push(`the ravenry command: ${d}`); } catch (e) { left.push(`the ravenry command: ${(e as Error).message}`); }
  // The hub service.
  const mode = serviceMode(process.env, true);
  let svc = false;
  try { svc = fs.existsSync(serviceFile()); } catch { /* none */ }
  if (svc) {
    const r = removeService({ mode, run: serviceRun });
    if (r.state === 'failed') left.push(`the hub service: ${r.why || 'it did not stop'}`);
    else did.push(`the board's background service stopped (${tilde(serviceFile())} removed)`);
  }
  // The program's own folders in <data>.
  const data = dataRoot();
  const gone: string[] = [];
  for (const n of ['bin', 'current', 'versions']) {
    const f = path.join(data, n);
    let there = false;
    try { fs.lstatSync(f); there = true; } catch { /* none */ }
    if (!there) continue;
    try { fs.rmSync(f, { recursive: true, force: true }); gone.push(n); } catch (e) { left.push(`${tilde(f)}: ${(e as Error).message}`); }
  }
  if (gone.length) did.push(`Ravenry's program files removed from ${tilde(data)} (${gone.join(', ')})`);
  if (purge) {
    for (const f of [mcHome, data]) {
      if (!fs.existsSync(f)) continue;
      try { fs.rmSync(f, { recursive: true, force: true }); did.push(`deleted ${tilde(f)}`); } catch (e) { left.push(`${tilde(f)}: ${(e as Error).message}`); }
    }
  }
  const kept = purge ? [] : [mcHome, data].filter((f) => fs.existsSync(f)).map(tilde);
  appLog(`uninstall: ${did.length ? did.join('; ') : 'nothing of Ravenry was there'}${left.length ? `; not done: ${left.join('; ')}` : ''}${kept.length ? `; kept ${kept.join(' and ')}` : ''}`);
  return { ok: !left.length, did, left, kept, purge };
}

try {
  if (cmd === 'stage') {
    const st = stage(opt('--resources') || '');
    out({ ok: true, version: st.version, dir: st.dir, ravenryd: st.ravenryd, link: st.link, cli: st.cli, hubEntry: st.hubEntry, build: st.build });
  } else if (cmd === 'hub') {
    out(await hub(opt('--resources') || '', opt('--exe') || '', argv.includes('--retry')));
  } else if (cmd === 'npm-detect') {
    const d = await detectNpm(stage(opt('--resources') || ''));
    const choice = readChoice();
    out({ ok: true, detect: d, choice, offer: offerFor(d, choice) });
  } else if (cmd === 'npm-choice') {
    const c = opt('--set') || '';
    if (!['not-now', 'back', 'switched'].includes(c)) out({ ok: false, error: `npm-choice: not-now, back or switched (got ${c || 'nothing'})` });
    writeChoice(c);
    out({ ok: true, choice: c });
  } else if (cmd === 'npm-switch') {
    out(await npmSwitch(opt('--resources') || '', opt('--exe') || ''));
  } else if (cmd === 'npm-back') {
    out(await npmBack(opt('--resources') || ''));
  } else if (cmd === 'prune') {
    out(prune(opt('--keep') || ''));
  } else if (cmd === 'command') {
    out(argv.includes('--on') ? commandOn() : argv.includes('--off') ? commandOff() : commandState());
  } else if (cmd === 'uninstall') {
    out(uninstall(argv.includes('--purge')));
  } else {
    out({ ok: false, error: `usage: setup.mjs stage|hub|prune|command|uninstall|npm-detect|npm-choice|npm-switch|npm-back (got ${cmd || 'nothing'})` });
  }
} catch (e) {
  appLog(`install: ${(e as Error).message || e}`);
  out({ ok: false, error: String((e as Error).message || e) });
}
