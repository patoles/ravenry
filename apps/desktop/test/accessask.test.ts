// The app asks macOS for a folder the hub has no answer for itself
// (src/main/accessask.ts, the Mac app's AccessAsk.swift): which folders, once
// per folder and state, only in front, the hub told to ask again after, and
// a test's run never reads the person's own protected folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccessAsker, isTestRun, personsOwn, readOffMain, wanted } from '../src/main/accessask.ts';

const access = (blocked: unknown[]) => ({ waiting: null, denied: [], slow: [], blocked, words: null, settings: null });

test('wanted: the folders waiting or refused, never a slow one, and the 503\'s path', () => {
  const a = access([
    { folder: '~/Documents', name: 'Documents', path: '/Users/x/Documents', state: 'waiting' },
    { folder: '~/Desktop', name: 'Desktop', path: '/Users/x/Desktop', state: 'denied' },
    { folder: '~/Downloads', name: 'Downloads', path: '/Users/x/Downloads', state: 'slow' },
    { folder: 'odd', name: 'odd', path: 'relative/odd', state: 'denied' },
  ]);
  assert.deepEqual(wanted(a, null), [{ path: '/Users/x/Documents', state: 'waiting' }, { path: '/Users/x/Desktop', state: 'denied' }]);
  assert.deepEqual(wanted(null, '/Users/x/Documents'), [{ path: '/Users/x/Documents', state: 'waiting' }]);
  assert.deepEqual(wanted(a, '/Users/x/Documents').length, 2);
  assert.deepEqual(wanted({ waiting: null }, null), []);
});

test('personsOwn: Documents, Desktop, Downloads, iCloud Drive and volumes, against the account\'s home', () => {
  const home = '/Users/someone';
  for (const p of ['/Users/someone/Documents', '/Users/someone/Desktop/x', '/Users/someone/Downloads', '/Users/someone/Library/Mobile Documents/com~apple~CloudDocs', '/Volumes/Disk']) assert.ok(personsOwn(p, home), p);
  for (const p of ['/Users/someone/DocumentsX', '/tmp/Documents', '/Users/you/Documents']) assert.ok(!personsOwn(p, home), p);
  // The real account's home, whatever HOME says (a test's throwaway HOME is not it).
  assert.ok(personsOwn(path.join(os.userInfo().homedir, 'Documents')));
});

test('isTestRun: a test\'s data, a test\'s hub data or a window off every screen', () => {
  assert.equal(isTestRun({}), false);
  assert.equal(isTestRun({ RAVENRY_HOME: '/tmp/x' }), true);
  assert.equal(isTestRun({ RAVENRY_DESKTOP_DATA: '/tmp/x' }), true);
  assert.equal(isTestRun({ RAVENRY_OFFSCREEN: '1' }), true);
});

test('ask: only in front, once per folder and state, then the hub asks again; a test never reads the person\'s own', async () => {
  const reads: string[] = [];
  const logs: string[] = [];
  let retries = 0;
  const home = '/Users/someone';
  const a = new AccessAsker({ test: true, home, log: (l) => logs.push(l), read: async (p) => { reads.push(p); return { how: 'ok', ms: 1 }; } });
  const want = [{ path: '/tmp/ravenry-ask', state: 'waiting' as const }, { path: `${home}/Documents`, state: 'denied' as const }];
  a.ask(want, false, () => retries++);
  assert.deepEqual(reads, [], 'not in front: nothing read');
  a.ask(want, true, () => retries++);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(reads, ['/tmp/ravenry-ask']);
  assert.equal(retries, 1);
  assert.deepEqual(a.record, [`skipped ${home}/Documents`, 'read /tmp/ravenry-ask: ok']);
  a.ask(want, true, () => retries++);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(reads.length, 1, 'asked once per folder and state');
  a.ask([{ path: '/tmp/ravenry-ask', state: 'denied' }], true, () => retries++);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(reads.length, 2, 'refused after waiting: asked again');
  assert.equal(retries, 2);
  assert.ok(logs.some((l) => l.includes("a test's run does not ask macOS")));
});

test('readOffMain: lists a folder in a worker thread and says how it went', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvask-'));
  try {
    const ok = await readOffMain(dir);
    assert.equal(ok.how, 'ok');
    const gone = await readOffMain(path.join(dir, 'missing'));
    assert.match(gone.how, /^error ENOENT/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
