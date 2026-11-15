#!/usr/bin/env node
// The testers' release: the Mac app and the Android app on the public
// repository's GitHub Releases, and the launch page (site/) on its GitHub
// Pages. The testers' Mac apps update from those releases (Updater.swift
// reads releases/latest/download/latest-mac-native.json of the repository
// in their app-update.json, the root package.json's ravenry.releases).
//
//   node tools/publish-testers.mjs            a dry run: checks and prints every step
//   node tools/publish-testers.mjs --yes      does it
//   node tools/publish-testers.mjs --page-only [--yes]
//            the page alone: site/ to gh-pages and read back, nothing else
//            (no release, tag, files or feed). It refuses unless the page's
//            macVersion is the version of the release marked latest.
//   options: --repo owner/repo (default ravenry.releases), --apk FILE (default the
//            Gradle release APK), --package DIR (default apps/macos/build/package)
//
// Before: `node apps/macos/scripts/package.mjs` (the zip, the feed, both
// dmgs) and `./gradlew assembleRelease` in apps/android (signed with the
// testers' key, docs/PUBLISHING.md). Nothing is built here.
//
// What --yes does, in this order, so the page and "latest" never point at a
// release that is missing a file:
//   1. the page: site/ without tools/ and its README, macVersion set to this version and
//      og:image made absolute, committed to the gh-pages branch (its own
//      branch, so the repository's main, the npm board's code, is never
//      touched), with .nojekyll;
//   2. the release v<version>, made as a draft on that gh-pages commit with
//      every file attached: RavenryNative-<version>.zip and
//      latest-mac-native.json (the updater's), Ravenry-<version>-mac-arm64.dmg
//      and Ravenry-mac.dmg (the page's link, the same on every release),
//      Ravenry-android.apk; then published and marked latest;
//   3. GitHub Pages turned on for gh-pages (only the first time; "already
//      on", HTTP 409, is fine: GitHub may turn it on by itself when gh-pages
//      is pushed), then its source read back: gh-pages, /;
//   4. the public links read back: the feed's version, both downloads.
// The npm board (ravenry-app on npm, 0.4.x) publishes no GitHub release
// here; one made by hand must be --latest=false, or the testers' links and
// updates would point at it. This script refuses a version that is not
// newer than the release marked latest.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const YES = argv.includes('--yes');
const PAGE_ONLY = argv.includes('--page-only');
if (YES && argv.includes('--dry-run')) throw new Error('--yes or --dry-run, not both');
const REPO = opt('--repo') || JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).ravenry?.releases;
if (!/^[\w.-]+\/[\w.-]+$/.test(String(REPO || ''))) throw new Error(`no repository (ravenry.releases in package.json, or --repo owner/repo): ${REPO}`);
const [OWNER, NAME] = REPO.split('/');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'desktop', 'package.json'), 'utf8')).version;
const TAG = `v${VERSION}`;
const PKG = path.resolve(opt('--package') || path.join(ROOT, 'apps', 'macos', 'build', 'package'));
const APK = path.resolve(opt('--apk') || path.join(ROOT, 'apps', 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'));
const PAGES = `https://${OWNER.toLowerCase()}.github.io/${NAME}/`;
// The testers' Android key's certificate (public: it is inside every APK it signs).
const APK_CERT = 'b189b7bbc72a03f23ccaffdb79f4d94b1a20714934b3a13157098c5ef7aaac65';

let problems = 0;
let warnings = 0;
const say = (s = '') => console.log(s);
const ok = (good, what, detail = '') => { say(`  ${good ? 'ok  ' : 'NO  '} ${what}${detail ? `: ${detail}` : ''}`); if (!good) problems++; return good; };
const warn = (what) => { say(`  WARN ${what}`); warnings++; };
const run = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...o });
const tryRun = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20 }); return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }; };
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const mib = (n) => `${(n / 1048576).toFixed(1)} MiB`;
const newer = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
/** A GitHub API GET (never anything else in a dry run); null on 404. */
const get = (p) => { const r = tryRun('gh', ['api', '-X', 'GET', p]); if (r.code === 0) return JSON.parse(r.out); if (/HTTP 404/.test(r.out)) return null; throw new Error(`gh api ${p}: ${r.out.trim()}`); };
/** What --yes runs; the dry run prints it. */
const step = (args, o = {}) => { say(`  $ ${args.map((a) => (/[\s"'$]/.test(a) ? `'${a}'` : a)).join(' ')}`); if (YES) return run(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'inherit'], ...o }); return ''; };

const SITE_HTML = fs.readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8');
const PAGE_VERSION = (/^\s*macVersion:\s*'([^']*)'/m.exec(SITE_HTML) || [])[1];
/** Pages serves gh-pages from its root: the source this script publishes to. */
const pagesSource = (p) => `${p?.source?.branch} ${p?.source?.path}`;
const PAGES_OK = (p) => p?.source?.branch === 'gh-pages' && p?.source?.path === '/';

if (PAGE_ONLY) say(`publish-testers --page-only: the page (site/, macVersion ${PAGE_VERSION}) to ${PAGES}, nothing else`);
else say(`publish-testers: Ravenry ${VERSION} to github.com/${REPO} (releases) and ${PAGES} (the page)`);
say(YES ? 'MODE: --yes, publishing' : `MODE: dry run (nothing is written; ${PAGE_ONLY ? '--page-only --yes' : '--yes'} publishes)`);

// ---------------------------------------------------------------- the files
const files = [
  { name: `RavenryNative-${VERSION}.zip`, src: path.join(PKG, `RavenryNative-${VERSION}.zip`), what: 'the app, for the updater' },
  { name: 'latest-mac-native.json', src: path.join(PKG, 'latest-mac-native.json'), what: 'the updater\'s feed' },
  { name: `Ravenry-${VERSION}-mac-arm64.dmg`, src: path.join(PKG, `Ravenry-${VERSION}-mac-arm64.dmg`), what: 'the Mac app, by version' },
  { name: 'Ravenry-mac.dmg', src: path.join(PKG, 'Ravenry-mac.dmg'), what: 'the Mac app, the page\'s link' },
  { name: 'Ravenry-android.apk', src: APK, what: 'the Android app, the page\'s link' },
];
const by = Object.fromEntries(files.map((f) => [f.name, f]));
if (!PAGE_ONLY) {
  say('\n1. The files');
  for (const f of files) {
    if (!ok(fs.existsSync(f.src), `${f.name} (${f.what})`, fs.existsSync(f.src) ? '' : `missing: ${f.src}`)) continue;
    f.size = fs.statSync(f.src).size;
    f.sha = sha256(f.src);
  }
  for (const f of files.filter((x) => x.sha)) say(`       ${f.name.padEnd(32)} ${String(f.size).padStart(10)} B  ${mib(f.size).padStart(9)}  sha256 ${f.sha}  <- ${path.relative(ROOT, f.src)}`);

  // ---------------------------------------------------------------- the checks
  say('\n2. The checks');
  const feedF = by['latest-mac-native.json'];
  if (feedF.sha) {
    const feed = JSON.parse(fs.readFileSync(feedF.src, 'utf8'));
    const zip = by[`RavenryNative-${VERSION}.zip`];
    ok(feed.version === VERSION, 'the feed\'s version is this version', feed.version);
    ok(feed.url === zip.name && feed.sha256 === zip.sha && feed.size === zip.size, 'the feed names the zip with its SHA-256 and size');
  }
  const dmgV = by[`Ravenry-${VERSION}-mac-arm64.dmg`];
  const dmgF = by['Ravenry-mac.dmg'];
  if (dmgV.sha && dmgF.sha) ok(dmgV.sha === dmgF.sha, 'Ravenry-mac.dmg is the same file as the versioned dmg');
  const app = path.join(PKG, 'Ravenry.app');
  if (fs.existsSync(app)) {
    const au = JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'app-update.json'), 'utf8'));
    ok(au.owner === OWNER && au.repo === NAME, 'the app updates from this repository (Resources/app-update.json)', `${au.owner}/${au.repo}`);
    const plistV = run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(app, 'Contents', 'Info.plist')]).trim();
    ok(plistV === VERSION, 'the app\'s version', plistV);
    const cs = tryRun('/usr/bin/codesign', ['-dv', '--verbose=2', app]).out;
    const authority = (/^Authority=(.*)$/m.exec(cs) || [])[1] || 'none (ad hoc)';
    const devId = /^Developer ID Application/.test(authority);
    say(`       signed by: ${authority}`);
    // The page's own setting, so the warning says whether testers are told.
    const note = /^\s*firstLaunchNote:\s*true\b/m.test(SITE_HTML);
    if (!devId) warn(`the Mac app is not signed with a Developer ID: macOS on a tester's Mac refuses to open it until they allow it in System Settings, Privacy & Security, Open Anyway (the page's firstLaunchNote is ${note ? 'on: the page tells them' : 'off: turn it on in site/index.html'}). Package with RAVENRY_SIGN_IDENTITY and RAVENRY_NOTARY_PROFILE for a release that opens normally.`);
    const st = tryRun('/usr/bin/xcrun', ['stapler', 'validate', dmgV.src || app]);
    if (st.code === 0) say('       the dmg is notarized and stapled');
    else if (devId) warn('the dmg is not notarized and stapled: Gatekeeper asks testers to allow it by hand');
  }
  const apkF = by['Ravenry-android.apk'];
  if (apkF.sha) {
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library', 'Android', 'sdk');
    const bt = path.join(sdk, 'build-tools');
    const latest = fs.existsSync(bt) ? fs.readdirSync(bt).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop() : null;
    if (ok(!!latest, 'the Android SDK\'s build-tools', latest || `none in ${bt}`)) {
      const jh = process.env.JAVA_HOME || tryRun('/usr/libexec/java_home', ['-v', '17']).out.trim();
      const env = { ...process.env, ...(jh ? { JAVA_HOME: jh, PATH: `${jh}/bin:${process.env.PATH}` } : {}) };
      const badging = tryRun(path.join(bt, latest, 'aapt2'), ['dump', 'badging', apkF.src]).out.split('\n')[0];
      const vn = (/versionName='([^']*)'/.exec(badging) || [])[1];
      const vc = Number((/versionCode='(\d+)'/.exec(badging) || [])[1]);
      const [a, b, c] = VERSION.split('.').map(Number);
      ok(vn === VERSION && vc === a * 1000000 + b * 1000 + c, 'the APK is this version', `${vn} (${vc})`);
      const sig = spawnSync(path.join(bt, latest, 'apksigner'), ['verify', '--verbose', '--print-certs', apkF.src], { encoding: 'utf8', env });
      const out = `${sig.stdout || ''}${sig.stderr || ''}`;
      const certs = [...out.matchAll(/certificate SHA-256 digest: ([0-9a-f]{64})/g)].map((m) => m[1]);
      ok(sig.status === 0 && /Verified using v2 scheme \(APK Signature Scheme v2\): true/.test(out), 'the APK\'s signature verifies (v2)', /v3 scheme \(APK Signature Scheme v3\): true/.test(out) ? 'v2 and v3' : 'v2');
      ok(certs.length === 1 && certs[0] === APK_CERT, 'signed with the testers\' key, the one every earlier release used', certs.join(', ') || 'unsigned');
    }
  }
}

// ---------------------------------------------------------------- GitHub, read only
say(`\n${PAGE_ONLY ? 1 : 3}. github.com/${REPO} now (read only)`);
const repo = get(`repos/${REPO}`);
if (ok(!!repo, 'the repository exists')) {
  ok(!repo.private, 'it is public (testers download without an account)', repo.private ? 'private' : 'public');
  say(`       default branch ${repo.default_branch}`);
}
const latest = get(`repos/${REPO}/releases/latest`);
if (PAGE_ONLY) {
  // The page alone links releases/latest/download/: it must say that release's version and find its files there.
  const lv = latest && latest.tag_name.replace(/^v/, '');
  if (ok(!!latest, 'a release is marked latest', latest ? latest.tag_name : 'none: publish one first, without --page-only')) {
    ok(PAGE_VERSION === lv, 'the page\'s macVersion is the latest release\'s version', `page ${PAGE_VERSION}, latest ${latest.tag_name}`);
    const names = new Set(latest.assets.map((x) => x.name));
    const S = { macFile: (/macFile:\s*'([^']*)'/.exec(SITE_HTML) || [])[1], apkFile: (/apkFile:\s*'([^']*)'/.exec(SITE_HTML) || [])[1] };
    ok(names.has(S.macFile) && names.has(S.apkFile), 'the latest release has the page\'s downloads', `${S.macFile}, ${S.apkFile}`);
  }
} else {
  const tagRel = get(`repos/${REPO}/releases/tags/${TAG}`);
  ok(!tagRel, `no release ${TAG} yet`, tagRel ? `${tagRel.html_url}${tagRel.draft ? ' (a draft: delete it or publish it by hand)' : ''}` : '');
  const tagRef = get(`repos/${REPO}/git/ref/tags/${TAG}`);
  ok(!tagRef, `no tag ${TAG} yet`);
  if (latest) {
    const lv = latest.tag_name.replace(/^v/, '');
    ok(newer(VERSION, lv), `this version is newer than the release marked latest`, latest.tag_name);
    if (!latest.assets.some((x) => x.name === 'latest-mac-native.json')) warn(`the release marked latest (${latest.tag_name}) is not a testers' release: no latest-mac-native.json`);
  } else say('       no release marked latest yet (the first one)');
}
const pagesBranch = get(`repos/${REPO}/branches/gh-pages`);
say(`       gh-pages branch: ${pagesBranch ? `yes, at ${pagesBranch.commit.sha.slice(0, 7)}` : 'not yet (made now)'}`);
const pages = get(`repos/${REPO}/pages`);
say(`       GitHub Pages: ${pages ? `on, from ${pagesSource(pages)}, ${pages.html_url}` : `off (${PAGE_ONLY ? 'the page-only push needs it on' : 'turned on for gh-pages'})`}`);
if (PAGE_ONLY) {
  ok(!!pagesBranch, 'the gh-pages branch exists', pagesBranch ? '' : 'none: publish without --page-only first');
  ok(PAGES_OK(pages), 'Pages publishes gh-pages /', pages ? pagesSource(pages) : 'off');
} else if (pages && !PAGES_OK(pages)) warn(`Pages publishes ${pagesSource(pages)}, not gh-pages /: change it in the repository's Settings, Pages`);

if (problems) {
  say(`\npublish-testers: ${problems} problem(s) above; nothing ${YES ? 'was' : 'would be'} published.`);
  process.exit(1);
}

// ---------------------------------------------------------------- the page
const SITE_VERSION = PAGE_ONLY ? PAGE_VERSION : VERSION;
say(`\n${PAGE_ONLY ? 2 : 4}. The page, to the gh-pages branch (${PAGES})`);
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'rvn-pages-'));
process.on('exit', () => fs.rmSync(stage, { recursive: true, force: true }));
const site = path.join(stage, 'site');
if (pagesBranch && YES) step(['git', 'clone', '--quiet', '--depth', '1', '--branch', 'gh-pages', `https://github.com/${REPO}.git`, site]);
else if (YES) { fs.mkdirSync(site); step(['git', '-C', site, 'init', '--quiet', '-b', 'gh-pages']); }
else { fs.mkdirSync(site); say(`  $ git ${pagesBranch ? `clone --depth 1 --branch gh-pages https://github.com/${REPO}.git <tmp>` : 'init -b gh-pages <tmp>'}`); }
for (const e of fs.readdirSync(site)) if (e !== '.git') fs.rmSync(path.join(site, e), { recursive: true, force: true });
// The page's files only: not its review tools or its README (the repository's notes, not the site's).
fs.cpSync(path.join(ROOT, 'site'), site, { recursive: true, filter: (s) => !s.startsWith(path.join(ROOT, 'site', 'tools')) && s !== path.join(ROOT, 'site', 'README.md') });
fs.writeFileSync(path.join(site, '.nojekyll'), '');
{
  const f = path.join(site, 'index.html');
  let html = fs.readFileSync(f, 'utf8');
  const v = html.replace(/macVersion: '[^']*'/, `macVersion: '${SITE_VERSION}'`);
  const og = v.replace('<meta property="og:image" content="assets/og-image.png">', `<meta property="og:image" content="${PAGES}assets/og-image.png">`);
  ok(og !== v || v.includes(`content="${PAGES}assets/og-image.png"`), 'og:image made absolute', `${PAGES}assets/og-image.png`);
  ok(/macFile: 'Ravenry-mac\.dmg'/.test(og) && /apkFile: 'Ravenry-android\.apk'/.test(og) && og.includes(`downloads: 'https://github.com/${REPO}/releases/latest/download/'`), 'the page links this repository\'s latest Ravenry-mac.dmg and Ravenry-android.apk');
  html = og;
  fs.writeFileSync(f, html);
  say(`       macVersion '${SITE_VERSION}'`);
}
if (problems) { say(`\npublish-testers: ${problems} problem(s); nothing published.`); process.exit(1); }
const listing = (d, p = '') => fs.readdirSync(path.join(d, p), { withFileTypes: true }).filter((e) => e.name !== '.git').flatMap((e) => (e.isDirectory() ? listing(d, path.join(p, e.name)) : [path.join(p, e.name)])).sort();
const pushed = {};
for (const f of listing(site)) { const s = fs.statSync(path.join(site, f)).size; pushed[f] = sha256(path.join(site, f)); say(`       ${f.padEnd(28)} ${String(s).padStart(8)} B  sha256 ${pushed[f]}`); }
step(['git', '-C', site, 'add', '-A']);
step(['git', '-C', site, '-c', 'user.name=Ravenry release', '-c', 'user.email=release@ravenry.invalid', 'commit', '--quiet', '-m', `The launch page for Ravenry ${SITE_VERSION}`]);
step(['git', '-C', site, 'push', '--quiet', `https://github.com/${REPO}.git`, 'HEAD:gh-pages']);

if (PAGE_ONLY) {
  // Read back: every file the page is made of, as Pages serves it (a query
  // string past its cache), until each is the one pushed. Pages builds in a
  // minute or two.
  say('\n3. Read back');
  const served = Object.keys(pushed).filter((f) => !path.basename(f).startsWith('.'));
  for (const f of served) say(`  GET ${PAGES}${f === 'index.html' ? '' : f}`);
  if (YES) {
    const waitS = 300;
    const t0 = Date.now();
    let left = served;
    for (;;) {
      const now = [];
      for (const f of left) {
        const r = await fetch(`${PAGES}${f === 'index.html' ? '' : f}?rb=${Date.now()}`, { cache: 'no-store' }).catch(() => null);
        const got = r && r.ok ? crypto.createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex') : null;
        if (got !== pushed[f]) now.push(f);
      }
      left = now;
      if (!left.length || Date.now() - t0 > waitS * 1000) break;
      await new Promise((r) => setTimeout(r, 10000));
    }
    const secs = Math.round((Date.now() - t0) / 1000);
    ok(!left.length, `the page serves what was pushed (${served.length} files)`, left.length ? `after ${secs} s still old or missing: ${left.join(', ')}` : `after ${secs} s`);
  }
  say(`\npublish-testers --page-only: ${YES ? (problems ? `${problems} problem(s)` : 'the page is published') : 'dry run done, nothing written'}${warnings ? `; ${warnings} warning(s) above` : ''}.`);
  process.exit(problems ? 1 : 0);
}

// ---------------------------------------------------------------- the release
say(`\n5. The release ${TAG}: a draft with every file, then published as latest`);
const notes = path.join(stage, 'notes.md');
fs.writeFileSync(notes, [
  `Ravenry ${VERSION} for testers.`,
  '',
  `- Mac (Apple silicon, macOS 13 or later): Ravenry-mac.dmg`,
  '- Android: Ravenry-android.apk',
  '',
  `The page: ${PAGES}. The Mac app updates itself from these releases.`,
  '',
  'SHA-256:',
  '',
  ...files.map((f) => `    ${f.sha}  ${f.name}`),
  '',
].join('\n'));
say(`  notes (${notes}):`);
for (const l of fs.readFileSync(notes, 'utf8').trimEnd().split('\n')) say(`    | ${l}`);
// The APK goes up under its page name.
const apkUp = path.join(stage, 'Ravenry-android.apk');
fs.copyFileSync(by['Ravenry-android.apk'].src, apkUp);
const target = YES ? run('git', ['-C', site, 'rev-parse', 'HEAD']).trim() : '<the gh-pages commit above>';
step(['gh', 'release', 'create', TAG, '--repo', REPO, '--draft', '--target', target, '--title', `Ravenry ${VERSION}`, '--notes-file', notes,
  ...files.filter((f) => f.name !== 'Ravenry-android.apk').map((f) => f.src), apkUp]);
step(['gh', 'release', 'edit', TAG, '--repo', REPO, '--draft=false', '--latest']);

// ---------------------------------------------------------------- Pages, once
say('\n6. GitHub Pages');
if (pages) say(`       already on, from ${pagesSource(pages)}`);
else {
  // GitHub may have turned Pages on by itself when gh-pages was pushed above:
  // then it answers 409, "already enabled", which is what this step wants.
  const args = ['api', '-X', 'POST', `repos/${REPO}/pages`, '-f', 'source[branch]=gh-pages', '-f', 'source[path]=/'];
  say(`  $ gh ${args.join(' ')}`);
  if (YES) {
    const r = tryRun('gh', args);
    if (r.code === 0) say('       turned on');
    else if (/HTTP 409/.test(r.out)) say('       already on (HTTP 409: GitHub turned it on when gh-pages was pushed)');
    else ok(false, 'turning Pages on', r.out.trim());
  }
}
if (YES) {
  const now = get(`repos/${REPO}/pages`);
  ok(PAGES_OK(now), 'Pages publishes gh-pages /', now ? pagesSource(now) : 'off');
} else say(`  GET repos/${REPO}/pages: the source must be gh-pages /`);

// ---------------------------------------------------------------- read back
say('\n7. Read back');
const dl = `https://github.com/${REPO}/releases/latest/download/`;
for (const u of [`${dl}latest-mac-native.json`, `${dl}Ravenry-mac.dmg`, `${dl}Ravenry-android.apk`, PAGES]) say(`  GET ${u}`);
if (YES) {
  const feed = await (await fetch(`${dl}latest-mac-native.json`)).json().catch(() => null);
  ok(feed && feed.version === VERSION, 'the public feed says this version', feed && feed.version);
  for (const n of ['Ravenry-mac.dmg', 'Ravenry-android.apk']) { const r = await fetch(dl + n, { method: 'HEAD', redirect: 'follow' }); ok(r.ok, `${n} downloads`, String(r.status)); }
  say(`  the page may take a minute to appear at ${PAGES}`);
}

say(`\npublish-testers: ${YES ? (problems ? `${problems} problem(s)` : 'published') : 'dry run done, nothing written'}${warnings ? `; ${warnings} warning(s) above` : ''}.`);
process.exit(problems ? 1 : 0);
