#!/usr/bin/env node
// tools/publish-testers.mjs, run end to end against stand-ins: nothing
// reaches GitHub or the network.
//
//   node tools/publish-testers-test.mjs
//
// `gh` and `git` are small scripts first on PATH that log every call and
// answer as a made-up copy of the testers' repository (the page checks that
// its links name that repository, so the name is the real one; the test
// stops before any run unless both resolve to the stand-ins); aapt2 and apksigner
// come from a made-up Android SDK (ANDROID_HOME); fetch is replaced in the
// script's process (node --import) by one that serves what the fake `git
// push` received, and throws on any other address. The cases:
//   1. the full release, --yes, where turning Pages on answers HTTP 409
//      ("already enabled"): it carries on, reads the source back, publishes;
//   2. the full release, --yes, Pages off and turned on: same, POST ok;
//   3. the full release, dry run: only GETs, the commands printed;
//   4. --page-only, dry run: only GETs, no release, tag or Pages step;
//   5. --page-only --yes: clone, commit, push and read back, and nothing else;
//   6. --page-only when the page's macVersion is not the latest release's:
//      refused, nothing pushed;
//   7. --page-only when Pages publishes another branch: refused.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'tools', 'publish-testers.mjs');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'desktop', 'package.json'), 'utf8')).version;
const PAGE_VERSION = /^\s*macVersion:\s*'([^']*)'/m.exec(fs.readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8'))[1];
const REPO = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).ravenry.releases;
const [OWNER, NAME] = REPO.split('/');
const PAGES = `https://${OWNER.toLowerCase()}.github.io/${NAME}/`;
// The testers' key's certificate, as the script expects it (one copy, there).
const APK_CERT = /const APK_CERT = '([0-9a-f]{64})'/.exec(fs.readFileSync(SCRIPT, 'utf8'))[1];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rvn-publish-test-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

// ---------------------------------------------------------------- stand-ins
const BIN = path.join(TMP, 'bin');
fs.mkdirSync(BIN);
const node = process.execPath;
fs.writeFileSync(path.join(BIN, 'gh'), `#!${node}
const fs = require('fs'); const D = process.env.FAKE_DIR; const a = process.argv.slice(2);
fs.appendFileSync(D + '/calls.log', 'gh ' + a.join(' ') + '\\n');
const st = JSON.parse(fs.readFileSync(D + '/state.json', 'utf8'));
const save = () => fs.writeFileSync(D + '/state.json', JSON.stringify(st));
if (a[0] === 'api' && a[2] === 'GET') {
  const v = st.routes[a[3]];
  if (v == null) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(v)); process.exit(0);
}
if (a[0] === 'api' && a[2] === 'POST' && /\\/pages$/.test(a[3])) {
  st.routes[a[3]] = st.pagesAfter; save();
  if (st.post409) { process.stderr.write('gh: Pages site already exists. (HTTP 409)\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(st.pagesAfter)); process.exit(0);
}
if (a[0] === 'release') process.exit(0);
process.stderr.write('fake gh: no answer for ' + a.join(' ') + '\\n'); process.exit(2);
`);
fs.writeFileSync(path.join(BIN, 'git'), `#!${node}
const fs = require('fs'); const D = process.env.FAKE_DIR; let a = process.argv.slice(2);
fs.appendFileSync(D + '/calls.log', 'git ' + a.join(' ') + '\\n');
let dir = process.cwd();
if (a[0] === '-C') { dir = a[1]; a = a.slice(2); }
while (a[0] === '-c') a = a.slice(2);
if (a[0] === 'clone') { fs.mkdirSync(a[a.length - 1] + '/.git', { recursive: true }); process.exit(0); }
if (a[0] === 'init') { fs.mkdirSync(dir + '/.git', { recursive: true }); process.exit(0); }
if (a[0] === 'push') { fs.rmSync(D + '/served', { recursive: true, force: true }); fs.cpSync(dir, D + '/served', { recursive: true, filter: (s) => !s.includes('/.git') }); process.exit(0); }
if (a[0] === 'rev-parse') { process.stdout.write('0123456789abcdef0123456789abcdef01234567\\n'); process.exit(0); }
if (a[0] === 'add' || a[0] === 'commit') process.exit(0);
process.stderr.write('fake git: no answer for ' + a.join(' ') + '\\n'); process.exit(2);
`);
const BT = path.join(TMP, 'sdk', 'build-tools', '99.0.0');
fs.mkdirSync(BT, { recursive: true });
const [va, vb, vc] = VERSION.split('.').map(Number);
fs.writeFileSync(path.join(BT, 'aapt2'), `#!/bin/sh\necho "package: name='app.ravenry' versionCode='${va * 1000000 + vb * 1000 + vc}' versionName='${VERSION}'"\n`);
fs.writeFileSync(path.join(BT, 'apksigner'), `#!/bin/sh\necho "Verified using v2 scheme (APK Signature Scheme v2): true"\necho "Signer #1 certificate SHA-256 digest: ${APK_CERT}"\n`);
for (const f of ['gh', 'git']) fs.chmodSync(path.join(BIN, f), 0o755);
for (const f of ['aapt2', 'apksigner']) fs.chmodSync(path.join(BT, f), 0o755);

// The package and the APK: made-up bytes with a feed that names them.
const PKG = path.join(TMP, 'package');
fs.mkdirSync(PKG);
fs.writeFileSync(path.join(PKG, `RavenryNative-${VERSION}.zip`), 'zip');
fs.writeFileSync(path.join(PKG, `Ravenry-${VERSION}-mac-arm64.dmg`), 'dmg');
fs.writeFileSync(path.join(PKG, 'Ravenry-mac.dmg'), 'dmg');
const zipSha = (await import('node:crypto')).createHash('sha256').update('zip').digest('hex');
fs.writeFileSync(path.join(PKG, 'latest-mac-native.json'), JSON.stringify({ version: VERSION, url: `RavenryNative-${VERSION}.zip`, sha256: zipSha, size: 3 }));
const APK = path.join(TMP, 'app.apk');
fs.writeFileSync(APK, 'apk');

// fetch in the script's process: the page from what was pushed, the release files as published.
const STUB = path.join(TMP, 'fetch-stub.mjs');
fs.writeFileSync(STUB, `import fs from 'node:fs';
const D = process.env.FAKE_DIR; const PAGES = '${PAGES}'; const DL = 'https://github.com/${REPO}/releases/latest/download/';
globalThis.fetch = async (url, o = {}) => {
  const u = new URL(String(url)); const plain = u.origin + u.pathname;
  fs.appendFileSync(D + '/calls.log', 'fetch ' + (o.method || 'GET') + ' ' + plain + '\\n');
  if (plain.startsWith(PAGES)) {
    const f = D + '/served/' + (plain.slice(PAGES.length) || 'index.html');
    return fs.existsSync(f) ? new Response(fs.readFileSync(f)) : new Response('', { status: 404 });
  }
  if (plain === DL + 'latest-mac-native.json') return new Response(JSON.stringify({ version: '${VERSION}' }));
  if (plain.startsWith(DL)) return new Response('', { status: 200 });
  throw new Error('fetch stub: no network in the test: ' + url);
};
`);

// ---------------------------------------------------------------- the runs
const PAGES_ON = { source: { branch: 'gh-pages', path: '/' }, html_url: PAGES };
const release = (v) => ({ tag_name: `v${v}`, assets: ['latest-mac-native.json', 'Ravenry-mac.dmg', 'Ravenry-android.apk'].map((name) => ({ name })) });
function scenario({ latest, pages, pagesAfter = PAGES_ON, post409 = false, ghPages = true }) {
  const routes = {
    [`repos/${REPO}`]: { private: false, default_branch: 'main' },
    [`repos/${REPO}/releases/latest`]: latest ? release(latest) : null,
    [`repos/${REPO}/branches/gh-pages`]: ghPages ? { commit: { sha: 'cb4da6c0000000' } } : null,
    [`repos/${REPO}/pages`]: pages,
  };
  return { routes, pagesAfter, post409 };
}
let failures = 0;
let checks = 0;
function run(name, args, state) {
  const D = fs.mkdtempSync(path.join(TMP, 'case-'));
  fs.writeFileSync(path.join(D, 'state.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(D, 'calls.log'), '');
  const env = { ...process.env, FAKE_DIR: D, PATH: `${BIN}:${process.env.PATH}`, ANDROID_HOME: path.join(TMP, 'sdk'), JAVA_HOME: TMP };
  delete env.ANDROID_SDK_ROOT;
  const which = spawnSync('/bin/sh', ['-c', 'command -v gh; command -v git'], { encoding: 'utf8', env }).stdout.trim().split('\n');
  if (which[0] !== path.join(BIN, 'gh') || which[1] !== path.join(BIN, 'git')) throw new Error(`the stand-ins are not first on PATH: ${which.join(', ')}`);
  const r = spawnSync(node, ['--import', STUB, SCRIPT, '--package', PKG, '--apk', APK, ...args], { encoding: 'utf8', env });
  const out = `${r.stdout}${r.stderr}`;
  const calls = fs.readFileSync(path.join(D, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean);
  const writes = calls.filter((c) => /^gh (release|api -X (POST|PUT|PATCH|DELETE))|^git (?!.*rev-parse)/.test(c));
  console.log(`\n${name}: exit ${r.status}, ${calls.length} calls, ${writes.length} write(s)`);
  return { code: r.status, out, calls, writes, D };
}
function expect(good, what, detail) {
  checks++;
  console.log(`  ${good ? 'ok  ' : 'FAIL'} ${what}`);
  if (!good) { failures++; if (detail) console.log(detail.split('\n').map((l) => `       | ${l}`).join('\n')); }
}
const older = '0.0.1';

{
  const r = run('1. full release --yes, Pages answers 409', ['--yes'], scenario({ latest: older, pages: null, post409: true }));
  expect(r.code === 0, 'exits 0', r.out);
  expect(/already on \(HTTP 409/.test(r.out), 'says Pages was already on (409)');
  expect(/ok\s+Pages publishes gh-pages \/: gh-pages \//.test(r.out), 'reads the source back: gh-pages /');
  expect(r.calls.some((c) => c.startsWith(`gh release edit v${VERSION}`)) && r.calls.some((c) => c.startsWith('git -C') && c.includes(' push ')), 'pushed the page and published the release');
  expect(/publish-testers: published/.test(r.out), 'ends "published"');
}
{
  const r = run('2. full release --yes, Pages off then on', ['--yes'], scenario({ latest: older, pages: null }));
  expect(r.code === 0 && /\n\s+turned on\n/.test(r.out) && /ok\s+Pages publishes gh-pages \//.test(r.out), 'turns Pages on and reads gh-pages / back', r.out);
}
{
  const r = run('3. full release, dry run', [], scenario({ latest: older, pages: PAGES_ON }));
  expect(r.code === 0, 'exits 0', r.out);
  expect(r.writes.length === 0, 'no writes: only GETs', r.writes.join('\n'));
  expect(/\$ gh release create v/.test(r.out) && /\$ git -C .* push /.test(r.out), 'prints the release and push commands');
  expect(/already on, from gh-pages \//.test(r.out), 'Pages: already on, from gh-pages /');
}
{
  const r = run('4. --page-only, dry run', ['--page-only'], scenario({ latest: PAGE_VERSION, pages: PAGES_ON }));
  expect(r.code === 0, 'exits 0', r.out);
  expect(r.writes.length === 0, 'no writes: only GETs', r.writes.join('\n'));
  expect(/\$ git -C .* push --quiet https:\/\/github.com\/[\w.-]+\/[\w.-]+\.git HEAD:gh-pages/.test(r.out), 'prints the push to gh-pages');
  expect(!/gh release|releases\/tags|git\/ref\/tags|GitHub Pages\n|\. The files/.test(r.out) && !r.calls.some((c) => /releases\/tags|git\/ref/.test(c)), 'no release, tag, files or Pages step', r.out);
  expect(r.out.includes(`GET ${PAGES}\n`), 'prints the read back');
}
{
  const r = run('5. --page-only --yes', ['--page-only', '--yes'], scenario({ latest: PAGE_VERSION, pages: PAGES_ON }));
  expect(r.code === 0, 'exits 0', r.out);
  const kinds = r.writes.map((c) => (/^git (?:-C \S+ )?(?:-c .*? )?(clone|add|commit|push)\b/.exec(c) || [, c])[1]);
  expect(JSON.stringify(kinds) === JSON.stringify(['clone', 'add', 'commit', 'push']), 'writes only clone, add, commit, push', r.writes.join('\n'));
  const served = fs.readFileSync(path.join(r.D, 'served', 'index.html'), 'utf8');
  expect(served.includes(`macVersion: '${PAGE_VERSION}'`) && served.includes(`content="${PAGES}assets/og-image.png"`), 'pushed index.html: macVersion kept, og:image absolute');
  expect(!fs.existsSync(path.join(r.D, 'served', 'tools')) && !fs.existsSync(path.join(r.D, 'served', 'README.md')), 'without tools/ and the README');
  expect(/ok\s+the page serves what was pushed \(\d+ files\)/.test(r.out), 'reads every file back');
  expect(/the page is published/.test(r.out), 'ends "the page is published"');
}
{
  const r = run('6. --page-only --yes, the page is not the latest release', ['--page-only', '--yes'], scenario({ latest: older, pages: PAGES_ON }));
  expect(r.code === 1 && /NO\s+the page's macVersion is the latest release's version/.test(r.out), 'refuses', r.out);
  expect(r.writes.length === 0, 'nothing pushed', r.writes.join('\n'));
}
{
  const r = run('7. --page-only --yes, Pages publishes main', ['--page-only', '--yes'], scenario({ latest: PAGE_VERSION, pages: { source: { branch: 'main', path: '/docs' }, html_url: 'x' } }));
  expect(r.code === 1 && /NO\s+Pages publishes gh-pages \/: main \/docs/.test(r.out) && r.writes.length === 0, 'refuses, nothing pushed', r.out);
}

console.log(`\npublish-testers-test: ${checks - failures}/${checks} ok${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
