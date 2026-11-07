// What the packaged app installs: version copies, the stable ravenryd link,
// pruning, and the hub service for launchd and systemd. Everything here
// runs in a throwaway folder and runs no launchctl or systemctl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dataRoot, ensureService, launchctlBin, plistText, pruneVersions, removeService, runtimeSource, selfUpdating, serviceFile, serviceMode,
  serviceSpec, stageRuntime, stageVersion, unitText,
} from '../src/main/install.ts';
import type { Runner } from '../src/main/install.ts';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rv-install-'));
}

function fakeResources(dir: string, tag: string): string {
  const res = path.join(dir, 'resources');
  fs.mkdirSync(path.join(res, 'hub', 'server'), { recursive: true });
  fs.writeFileSync(path.join(res, 'ravenryd'), `#!/bin/sh\necho ${tag}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(res, 'hub', 'server', 'index.mjs'), `// ${tag}\n`);
  return res;
}

test('dataRoot: the override, then the platform folder', () => {
  assert.equal(dataRoot({ RAVENRY_DESKTOP_DATA: '/x/data' }, 'darwin', '/h'), '/x/data');
  assert.equal(dataRoot({}, 'darwin', '/h'), '/h/Library/Application Support/Ravenry');
  assert.equal(dataRoot({}, 'linux', '/h'), '/h/.local/share/ravenry');
  assert.equal(dataRoot({ XDG_DATA_HOME: '/d' }, 'linux', '/h'), '/d/ravenry');
});

test('stageVersion copies once per build, links bin/ravenryd to the newest, and replaces a rebuilt copy', () => {
  const dir = tmp();
  const root = path.join(dir, 'data');
  const res = fakeResources(dir, 'one');
  const a = stageVersion({ resources: res, root, build: { version: '0.1.0', id: 'a' } });
  assert.equal(fs.readFileSync(a.ravenryd, 'utf8'), '#!/bin/sh\necho one\n');
  assert.ok(fs.statSync(a.ravenryd).mode & 0o100);
  assert.equal(fs.realpathSync(a.link), fs.realpathSync(a.ravenryd));
  assert.equal(path.basename(a.cli), 'ravenry');
  assert.equal(fs.realpathSync(a.cli), fs.realpathSync(a.ravenryd));
  assert.ok(fs.existsSync(a.hubEntry));
  // Same build: nothing is copied again.
  fs.writeFileSync(path.join(res, 'ravenryd'), '#!/bin/sh\necho changed\n');
  stageVersion({ resources: res, root, build: { version: '0.1.0', id: 'a' } });
  assert.equal(fs.readFileSync(a.ravenryd, 'utf8'), '#!/bin/sh\necho one\n');
  // Another build of the same version replaces it.
  stageVersion({ resources: res, root, build: { version: '0.1.0', id: 'b' } });
  assert.equal(fs.readFileSync(a.ravenryd, 'utf8'), '#!/bin/sh\necho changed\n');
  // A new version: its own folder, and the link moves to it.
  const b = stageVersion({ resources: fakeResources(path.join(dir, 'n'), 'two'), root, build: { version: '0.2.0', id: 'c' } });
  assert.equal(fs.realpathSync(b.link), fs.realpathSync(b.ravenryd));
  assert.equal(fs.realpathSync(b.cli), fs.realpathSync(b.ravenryd));
  assert.ok(fs.existsSync(a.ravenryd));
  assert.deepEqual(fs.readdirSync(path.join(root, 'versions')).sort(), ['0.1.0', '0.2.0']);
  assert.throws(() => stageVersion({ resources: res, root, build: { version: '../x', id: 'd' } }));
});

test('pruneVersions keeps the current version, running daemons and what the service names', () => {
  const root = path.join(tmp(), 'data');
  for (const v of ['0.1.0', '0.2.0', '0.3.0', '0.4.0']) fs.mkdirSync(path.join(root, 'versions', v, 'hub'), { recursive: true });
  const svc = `<string>${path.join(root, 'versions', '0.2.0', 'hub', 'server', 'index.mjs')}</string>`;
  const gone = pruneVersions(root, '0.4.0', ['0.1.0'], svc);
  assert.deepEqual(gone, ['0.3.0']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'versions')).sort(), ['0.1.0', '0.2.0', '0.4.0']);
});

const staged = { version: '0.1.0', dir: '/d/versions/0.1.0', ravenryd: '/d/versions/0.1.0/ravenryd', link: '/d/bin/ravenryd', cli: '/d/bin/ravenry', hubEntry: '/d/versions/0.1.0/hub/server/index.mjs' };

test('the service runs the app as Node on the staged hub; an AppImage copies its runtime', () => {
  const spec = serviceSpec({ execPath: '/Applications/Ravenry.app/Contents/MacOS/Ravenry', staged, env: { PATH: '/usr/bin:/tmp/shim', RAVENRY_HOME: '/r' }, platform: 'darwin', home: '/h' });
  assert.equal(spec.exe, '/Applications/Ravenry.app/Contents/MacOS/Ravenry');
  assert.equal(spec.env.RAVENRY_DAEMON_BIN, '/d/bin/ravenryd');
  assert.equal(spec.env.RAVENRY_TERMINAL, 'ravenry');
  assert.equal(spec.env.RAVENRY_HOME, '/r');
  assert.ok(!spec.env.PATH.includes('/tmp/shim'));
  assert.ok(spec.env.PATH.split(':').includes('/h/.local/bin'));
  const p = plistText(spec);
  assert.match(p, /<string>dev\.ravenry\.hub<\/string>/);
  assert.match(p, /<key>ELECTRON_RUN_AS_NODE<\/key>\s*<string>1<\/string>/);
  assert.match(p, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
  assert.match(p, /<string>\/Applications\/Ravenry\.app\/Contents\/MacOS\/Ravenry<\/string>\s*<string>\/d\/versions\/0\.1\.0\/hub\/server\/index\.mjs<\/string>/);

  assert.equal(runtimeSource('/tmp/.mount_x/ravenry', { APPIMAGE: '/home/you/Apps/Ravenry.AppImage' }, 'linux'), '/tmp/.mount_x');
  assert.equal(runtimeSource('/opt/Ravenry/ravenry', {}, 'linux'), null);
  assert.equal(runtimeSource('/Applications/Ravenry.app/Contents/MacOS/Ravenry', { APPIMAGE: '/x' }, 'darwin'), null);
  const u = unitText(serviceSpec({ execPath: '/opt/Ravenry/ravenry', staged: { ...staged, hubEntry: '/d/100% $x/index.mjs' }, env: { PATH: '/usr/bin' }, platform: 'linux', home: '/h' }));
  assert.match(u, /^ExecStart="\/opt\/Ravenry\/ravenry" "\/d\/100%% \$\$x\/index\.mjs"$/m);
  assert.match(u, /^Environment="ELECTRON_RUN_AS_NODE=1"$/m);
  assert.match(u, /^KillMode=process$/m);
  assert.match(u, /^WantedBy=default\.target$/m);
});

test('self-updating: macOS and the AppImage, not a .deb', () => {
  assert.equal(selfUpdating({}, 'darwin'), true);
  assert.equal(selfUpdating({ APPIMAGE: '/a.AppImage' }, 'linux'), true);
  assert.equal(selfUpdating({}, 'linux'), false);
});

test('serviceMode: install when packaged, off in development and offscreen runs, RAVENRY_SERVICE wins', () => {
  assert.equal(serviceMode({}, true), 'install');
  assert.equal(serviceMode({}, false), 'off');
  assert.equal(serviceMode({ RAVENRY_OFFSCREEN: '1' }, true), 'off');
  assert.equal(serviceMode({ RAVENRY_SERVICE: 'dry-run' }, false), 'dry-run');
});

test('ensureService: installs, keeps a current one, updates a changed one, and leaves a running board alone', async () => {
  for (const platform of ['darwin', 'linux']) {
    const home = tmp();
    const calls: string[] = [];
    let active = false;
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (args[0] === 'print' || args.includes('is-active')) return { status: active ? 0 : 3, out: '' };
      if (args[0] === 'bootstrap' || args.includes('restart')) active = true;
      if (args[0] === 'bootout') active = false;
      return { status: 0, out: '' };
    };
    const base = { platform, home, uid: 501, run, env: {}, boardAnswers: async () => false, wait: async () => {} };
    const spec = serviceSpec({ execPath: '/app/ravenry', staged, env: { PATH: '/usr/bin' }, platform, home });
    const file = serviceFile(platform, home, {});

    // Another board already runs and no service of ours exists: nothing.
    const skipped = await ensureService({ ...base, mode: 'install', spec, boardAnswers: async () => true });
    assert.equal(skipped.state, 'skipped');
    assert.ok(!fs.existsSync(file));

    // Dry run: the file, and no command.
    const dry = await ensureService({ ...base, mode: 'dry-run', spec });
    assert.equal(dry.state, 'installed');
    assert.ok(fs.existsSync(file));
    assert.deepEqual(calls, []);
    assert.ok(dry.commands.length > 0);
    fs.rmSync(file);

    const first = await ensureService({ ...base, mode: 'install', spec });
    assert.equal(first.state, 'installed');
    assert.ok(calls.some((c: string) => c.includes(platform === 'darwin' ? 'bootstrap gui/501' : 'restart dev.ravenry.hub.service')));
    calls.length = 0;
    assert.equal((await ensureService({ ...base, mode: 'install', spec })).state, 'kept');
    assert.ok(calls.every((c: string) => / print | is-active /.test(` ${c} `)));

    // A new version: rewritten and restarted, and a board answering does not matter now.
    const next = serviceSpec({ execPath: '/app/ravenry', staged: { ...staged, version: '0.2.0', hubEntry: '/d/versions/0.2.0/hub/server/index.mjs' }, env: { PATH: '/usr/bin' }, platform, home });
    const upd = await ensureService({ ...base, mode: 'install', spec: next, boardAnswers: async () => true });
    assert.equal(upd.state, 'updated');
    assert.match(fs.readFileSync(file, 'utf8'), /versions\/0\.2\.0/);

    // The same version rebuilt (another build id): rewritten and restarted
    // too, so the hub never keeps serving the old build.
    const built = (id: string) => serviceSpec({ execPath: '/app/ravenry', staged: { ...staged, version: '0.2.0', hubEntry: '/d/versions/0.2.0/hub/server/index.mjs', build: id }, env: { PATH: '/usr/bin' }, platform, home });
    assert.equal((await ensureService({ ...base, mode: 'install', spec: built('0.2.0+aaa.1') })).state, 'updated');
    calls.length = 0;
    assert.equal((await ensureService({ ...base, mode: 'install', spec: built('0.2.0+aaa.1') })).state, 'kept');
    const rebuilt = await ensureService({ ...base, mode: 'install', spec: built('0.2.0+bbb.2') });
    assert.equal(rebuilt.state, 'updated');
    assert.match(fs.readFileSync(file, 'utf8'), /0\.2\.0\+bbb\.2/);
    assert.ok(calls.some((c: string) => c.includes(platform === 'darwin' ? 'bootstrap gui/501' : 'restart dev.ravenry.hub.service')), calls.join('; '));
  }
});

test('after the switch from the npm board: a current service restarts when asked; the way back stops it and deletes its file; a stand-in launchctl is used when named', async () => {
  assert.equal(launchctlBin({}), '/bin/launchctl');
  for (const platform of ['darwin', 'linux']) {
    const home = tmp();
    const calls: string[] = [];
    let active = false;
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (args[0] === 'print' || args.includes('is-active')) return { status: active ? 0 : 3, out: '' };
      if (args[0] === 'bootstrap' || args.includes('restart')) active = true;
      if (args[0] === 'bootout' || args.includes('disable')) active = false;
      return { status: 0, out: '' };
    };
    const env = { RAVENRY_LAUNCHCTL: '/t/fake-launchctl.mjs' };
    const base = { platform, home, uid: 501, run, env, boardAnswers: async () => false };
    const spec = serviceSpec({ execPath: '/app/ravenry', staged, env: { PATH: '/usr/bin' }, platform, home });
    const file = serviceFile(platform, home, {});
    await ensureService({ ...base, mode: 'install', spec });
    if (platform === 'darwin') assert.ok(calls.length > 0 && calls.every((c: string) => c.startsWith('/t/fake-launchctl.mjs ')), calls.join('; '));
    calls.length = 0;
    const r = await ensureService({ ...base, mode: 'install', spec, restart: true });
    assert.equal(r.state, 'kept');
    assert.equal(r.why, 'restarted');
    assert.ok(calls.includes(platform === 'darwin' ? '/t/fake-launchctl.mjs kickstart -k gui/501/dev.ravenry.hub' : 'systemctl --user restart dev.ravenry.hub.service'), calls.join('; '));
    // A dry run deletes nothing.
    const dry = removeService({ mode: 'dry-run', run, platform, home, uid: 501, env });
    assert.ok(fs.existsSync(file) && dry.commands.length > 0);
    calls.length = 0;
    removeService({ mode: 'install', run, platform, home, uid: 501, env });
    assert.ok(!fs.existsSync(file));
    assert.ok(calls.includes(platform === 'darwin' ? '/t/fake-launchctl.mjs bootout gui/501/dev.ravenry.hub' : 'systemctl --user disable --now dev.ravenry.hub.service'), calls.join('; '));
    assert.equal(removeService({ mode: 'off', run, platform, home, uid: 501, env }).state, 'off');
  }
});

test('stageRuntime copies what the hub needs of an AppImage runtime, once per build', async () => {
  const dir = tmp();
  const appdir = path.join(dir, 'mount');
  fs.mkdirSync(path.join(appdir, 'resources'), { recursive: true });
  fs.mkdirSync(path.join(appdir, 'locales'), { recursive: true });
  for (const f of ['ravenry', 'libffmpeg.so', 'icudtl.dat', 'v8_context_snapshot.bin', 'AppRun', 'chrome-sandbox', 'ravenry.desktop']) fs.writeFileSync(path.join(appdir, f), f);
  const staged = stageVersion({ resources: fakeResources(dir, 'one'), root: path.join(dir, 'data'), build: { version: '0.1.0', id: 'a' } });
  const exe = await stageRuntime({ from: appdir, staged, build: { version: '0.1.0', id: 'a' }, exeName: 'ravenry' });
  assert.equal(exe, path.join(staged.dir, 'runtime', 'ravenry'));
  assert.deepEqual(fs.readdirSync(path.join(staged.dir, 'runtime')).sort(), ['.build.json', 'icudtl.dat', 'libffmpeg.so', 'ravenry', 'v8_context_snapshot.bin']);
  fs.writeFileSync(path.join(appdir, 'ravenry'), 'changed');
  await stageRuntime({ from: appdir, staged, build: { version: '0.1.0', id: 'a' }, exeName: 'ravenry' });
  assert.equal(fs.readFileSync(exe, 'utf8'), 'ravenry');
  await stageRuntime({ from: appdir, staged, build: { version: '0.1.0', id: 'b' }, exeName: 'ravenry' });
  assert.equal(fs.readFileSync(exe, 'utf8'), 'changed');
});

// launchd as it is: after bootout the job lingers for a moment, and a
// bootstrap then fails with 5 and loads nothing (2026-11-07, the hub down).
function lingeringLaunchd(opts: { linger: number; refuse?: (file: string) => boolean }) {
  const calls: string[] = [];
  let loadedFile: string | null = null;
  let lingering = 0;
  const run: Runner = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (args[0] === 'print') { if (lingering > 0) { lingering--; return { status: 0, out: '' }; } return { status: loadedFile ? 0 : 113, out: '' }; }
    if (args[0] === 'bootout') { if (loadedFile) lingering = opts.linger; loadedFile = null; return { status: 0, out: '' }; }
    if (args[0] === 'bootstrap') {
      const text = fs.readFileSync(args[2], 'utf8');
      if (lingering > 0 || (opts.refuse && opts.refuse(text))) return { status: 5, out: 'Bootstrap failed: 5: Input/output error' };
      loadedFile = text;
      return { status: 0, out: '' };
    }
    if (args[0] === 'kickstart') return { status: loadedFile ? 0 : 113, out: '' };
    return { status: 0, out: '' };
  };
  return { run, calls, loaded: () => loadedFile };
}

test('ensureService on macOS, from each way the service came to be: it ends loaded with this build, or the one that ran is put back', async () => {
  const platform = 'darwin';
  const specOf = (home: string, version: string, build: string) => serviceSpec({ execPath: '/Applications/Ravenry.app/Contents/MacOS/Ravenry', staged: { ...staged, version, hubEntry: `/d/versions/${version}/hub/server/index.mjs`, build }, env: { PATH: '/usr/bin' }, platform, home });
  // A hub answers on the port (the one the service runs) whenever a service is there.
  const go = (home: string, ld: ReturnType<typeof lingeringLaunchd>, spec: ReturnType<typeof specOf>, more: { restart?: boolean } = {}) =>
    ensureService({ mode: 'install', spec, run: ld.run, platform, home, uid: 501, env: {}, boardAnswers: async () => !!ld.loaded(), wait: async () => {}, ...more });

  // First launch: nothing installed, nothing answering.
  {
    const home = tmp();
    const ld = lingeringLaunchd({ linger: 3 });
    const r = await ensureService({ mode: 'install', spec: specOf(home, '0.1.2', 'b2'), run: ld.run, platform, home, uid: 501, env: {}, boardAnswers: async () => false, wait: async () => {} });
    assert.equal(r.state, 'installed');
    assert.match(String(ld.loaded()), /0\.1\.2/);
  }
  // Installed by the switch from the npm board (0.1.0, no build named),
  // loaded, its hub answering; a new build: rewritten and loaded, even
  // though launchd lingers after the bootout.
  for (const [what, before] of [['the switch (0.1.0, no build named)', specOf('', '0.1.0', '')], ['an earlier version', specOf('', '0.1.1', '0.1.1+aaa')], ['the same version, another build', specOf('', '0.1.2', '0.1.2+old')]] as const) {
    const home = tmp();
    const ld = lingeringLaunchd({ linger: 4 });
    const old = { ...before, env: { ...before.env } };
    if (!old.env.RAVENRY_APP_BUILD) delete old.env.RAVENRY_APP_BUILD;
    assert.equal((await go(home, ld, old)).state, 'installed', what);
    const r = await go(home, ld, specOf(home, '0.1.2', '0.1.2+new'));
    assert.equal(r.state, 'updated', `${what}: ${r.why}`);
    assert.match(String(ld.loaded()), /0\.1\.2\+new/, what);
    assert.ok(ld.calls.filter((c) => c.includes(' bootstrap ')).length >= 1, what);
  }
  // The file is current but the service is not loaded (a bootstrap that
  // failed before): loaded now.
  {
    const home = tmp();
    const ld = lingeringLaunchd({ linger: 0 });
    const spec = specOf(home, '0.1.2', '0.1.2+new');
    await go(home, ld, spec);
    ld.run('/bin/launchctl', ['bootout', 'gui/501/dev.ravenry.hub']);
    const r = await go(home, ld, spec);
    assert.equal(r.state, 'updated');
    assert.ok(ld.loaded());
  }
  // launchd refuses the new file every time: the old one is put back and
  // loaded, and the result says so.
  {
    const home = tmp();
    const ld = lingeringLaunchd({ linger: 2, refuse: (t) => t.includes('0.1.2+bad') });
    await go(home, ld, specOf(home, '0.1.1', '0.1.1+good'));
    const r = await go(home, ld, specOf(home, '0.1.2', '0.1.2+bad'));
    assert.equal(r.state, 'failed');
    assert.match(String(r.why), /the service that ran before is loaded again/);
    assert.match(String(ld.loaded()), /0\.1\.1\+good/);
    assert.match(fs.readFileSync(serviceFile(platform, home, {}), 'utf8'), /0\.1\.1\+good/);
  }
});
