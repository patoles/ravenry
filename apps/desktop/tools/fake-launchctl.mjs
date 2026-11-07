#!/usr/bin/env node
// Stands in for /bin/launchctl in the npm-switch test (RAVENRY_LAUNCHCTL),
// so no job is ever loaded into the person's real launchd. It keeps its
// jobs in RAVENRY_FAKE_LAUNCHD (a test folder): jobs.json, and calls.log
// with one line per call.
//
//   print gui/<uid>/<label>        0 when loaded, 113 when not
//   bootstrap gui/<uid> <plist>    starts ProgramArguments in the background
//                                  with the plist's variables over the
//                                  test's (<state>/env.json: its HOME, port
//                                  and stand-ins; HOME always the test's,
//                                  where launchd would give the real one)
//   bootout gui/<uid>/<label>      SIGTERM to the job, then unloaded
//   kickstart -k gui/<uid>/<label> restarts a loaded job
//
// It refuses to start a job whose folders are not a test's or whose port
// is :4600 (tools/test-env.mjs).
import { assertTestEnv, isTestPath } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const STATE = process.env.RAVENRY_FAKE_LAUNCHD;
const fail = (code, msg) => { process.stderr.write(msg + '\n'); process.exit(code); };
if (!STATE || !path.isAbsolute(STATE) || !isTestPath(STATE)) fail(2, 'fake-launchctl: RAVENRY_FAKE_LAUNCHD must name a test folder');
fs.mkdirSync(STATE, { recursive: true });
const JOBS = path.join(STATE, 'jobs.json');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(STATE, 'calls.log'), JSON.stringify({ at: new Date().toISOString(), args }) + '\n');

const read = () => { try { return JSON.parse(fs.readFileSync(JOBS, 'utf8')); } catch { return {}; } };
const write = (j) => fs.writeFileSync(JOBS, JSON.stringify(j, null, 2) + '\n');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const labelOf = (target) => String(target || '').split('/').slice(2).join('/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(job) {
  const p = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', job.plist], { encoding: 'utf8' }));
  let extra = {};
  try { extra = JSON.parse(fs.readFileSync(path.join(STATE, 'env.json'), 'utf8')); } catch { /* none */ }
  // The plist's own variables win (the app's hub names its terminal, data
  // and port there); the test's fill in the rest, and its HOME always.
  const env = { ...extra, ...(p.EnvironmentVariables || {}), ...(extra.HOME ? { HOME: extra.HOME } : {}) };
  if (!env.HOME || !isTestPath(env.HOME)) fail(2, `fake-launchctl: refused ${p.Label}: no test HOME`);
  if (String(env.PORT || '4600') === '4600') fail(2, `fake-launchctl: refused ${p.Label}: it would take :4600`);
  assertTestEnv(env, p.Label);
  const logFile = p.StandardOutPath || path.join(STATE, `${p.Label}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const [file, ...rest] = p.ProgramArguments;
  const child = spawn(file, rest, { env, cwd: p.WorkingDirectory || env.HOME, stdio: ['ignore', out, out], detached: true });
  child.unref();
  return { label: p.Label, plist: job.plist, pid: child.pid, args: p.ProgramArguments, at: new Date().toISOString() };
}

async function stop(job) {
  if (!job || !job.pid || !alive(job.pid)) return;
  try { process.kill(job.pid, 'SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 100 && alive(job.pid); i++) await sleep(50);
  if (alive(job.pid)) { try { process.kill(job.pid, 'SIGKILL'); } catch { /* gone */ } }
}

const [cmd] = args;
const jobs = read();
if (cmd === 'print') {
  const j = jobs[labelOf(args[1])];
  if (!j) fail(113, `Could not find service "${labelOf(args[1])}" in domain for user gui`);
  console.log(`${j.label} = {\n\tstate = ${alive(j.pid) ? 'running' : 'not running'}\n\tpid = ${j.pid}\n\tpath = ${j.plist}\n}`);
} else if (cmd === 'bootstrap') {
  const plist = args[2];
  if (!plist || !fs.existsSync(plist)) fail(5, `Bootstrap failed: 5: Input/output error (${plist})`);
  const label = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' })).Label;
  if (jobs[label]) fail(5, 'Bootstrap failed: 5: Input/output error (already loaded)');
  jobs[label] = start({ plist });
  write(jobs);
} else if (cmd === 'bootout') {
  const label = labelOf(args[1]);
  if (!jobs[label]) fail(3, `Boot-out failed: 3: No such process (${label})`);
  await stop(jobs[label]);
  delete jobs[label];
  write(jobs);
} else if (cmd === 'kickstart') {
  const label = labelOf(args[args.length - 1]);
  if (!jobs[label]) fail(113, `Could not find service "${label}"`);
  await stop(jobs[label]);
  jobs[label] = start(jobs[label]);
  write(jobs);
} else {
  fail(64, `fake-launchctl: ${cmd} is not supported`);
}
