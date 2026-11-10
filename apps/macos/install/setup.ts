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
//   node setup.mjs prune --keep VERSION
//       removes the version folders nothing runs from (their hook scripts
//       left as stubs that run current's)
//
// Bundled into one file by apps/macos/scripts/package.mjs (esbuild): it
// needs nothing but Node.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  dataRoot, ensureService, launchctlBin, pruneVersions, readBuildInfo, serviceFile, serviceMode, serviceSpec, stageVersion, updateAttempt,
} from '../../desktop/src/main/install.ts';
import type { Staged } from '../../desktop/src/main/install.ts';
import { launchPlan, runScript, scriptPath } from '../../desktop/src/main/npmswitch.ts';
import type { NpmDetect } from '../../desktop/src/main/npmswitch.ts';
import { hubUrl } from '../../desktop/src/main/hub.ts';

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

async function boardAnswers(): Promise<boolean> {
  try { return (await fetch(hubUrl() + '/api/state', { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

// The new hub after an update: up to 60 s to listen, then 30 s from its
// listen for any HTTP answer (main.ts newHubAnswers).
async function newHubAnswers(port: number): Promise<boolean> {
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

async function hub(resources: string, exe: string): Promise<object> {
  const st = stage(resources);
  // The npm board (npmswitch.ts): the hub script says what of it is here.
  const npm = (await runScript({ exe: process.execPath, script: scriptPath(st.hubEntry), args: ['detect', '--app-data', dataRoot()], env: { ...process.env, RAVENRY_LAUNCHCTL: launchctlBin() } })) as unknown as NpmDetect;
  const detect = npm && npm.ok ? npm : null;
  let installed = false;
  try { installed = fs.existsSync(serviceFile()); } catch { /* none */ }
  const plan = launchPlan(detect, installed);
  appLog(`launch: native app ${st.version}: ${plan} (npm board traces: ${detect ? (detect.npm ? 'yes' : 'none') : 'not looked at'}, service ${installed ? 'installed' : 'not installed'})`);
  if (plan === 'offer') return { ok: true, plan, why: 'an npm board serves this data: the app starts no hub of its own beside it' };
  if (plan === 'finish') {
    const r = await runScript({ exe: process.execPath, script: scriptPath(st.hubEntry), args: ['switch', '--ravenryd', st.link, '--app-data', dataRoot()], env: { ...process.env, RAVENRY_LAUNCHCTL: launchctlBin() } });
    appLog(`npm board: finished the switch: ${r.ok ? 'its traces moved' : r.error || 'it stopped'}`);
  }
  const mode = serviceMode(process.env, true);
  const port = Number(new URL(hubUrl()).port) || 4600;
  let before: string | null = null;
  try { before = fs.readFileSync(serviceFile(), 'utf8'); } catch { /* none yet */ }
  const updating = mode !== 'off' && mode !== 'dry-run' && !!before && !before.includes(`${path.sep}versions${path.sep}${st.version}${path.sep}`);
  const rec = readRecord();
  const { attempt, stop } = updateAttempt(rec, st.version);
  if (updating && stop) {
    appLog(`launch: update to ${st.version} stopped after 3 failed attempts: ${rec?.why || ''}`);
    return { ok: false, plan, stopped: true, why: rec?.why || 'the new hub did not answer' };
  }
  if (updating) appLog(`launch: update to ${st.version}, attempt ${attempt}`);
  const r = await ensureService({ mode, spec: serviceSpec({ execPath: exe, staged: st }), run: serviceRun, boardAnswers, answers: () => newHubAnswers(port) });
  const would = mode === 'dry-run' ? `; would run: ${r.commands.map((c) => c.join(' ')).join('; ')}` : '';
  appLog(`service: ${r.state}${r.file ? ` ${r.file}` : ''}${r.why ? ` (${r.why})` : ''}${would}`);
  if (updating) writeRecord(r.state === 'failed' ? { version: st.version, attempts: attempt, why: r.why || '' } : null);
  return { ok: r.state !== 'failed', plan, service: r.state, file: r.file || null, why: r.why || null, updating, attempt: updating ? attempt : 0 };
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

try {
  if (cmd === 'stage') {
    const st = stage(opt('--resources') || '');
    out({ ok: true, version: st.version, dir: st.dir, ravenryd: st.ravenryd, link: st.link, cli: st.cli, hubEntry: st.hubEntry, build: st.build });
  } else if (cmd === 'hub') {
    out(await hub(opt('--resources') || '', opt('--exe') || ''));
  } else if (cmd === 'prune') {
    out(prune(opt('--keep') || ''));
  } else {
    out({ ok: false, error: `usage: setup.mjs stage|hub|prune (got ${cmd || 'nothing'})` });
  }
} catch (e) {
  appLog(`install: ${(e as Error).message || e}`);
  out({ ok: false, error: String((e as Error).message || e) });
}
