// How the app is packaged (electron-builder): a DMG and a zip per Mac
// architecture (the zip is what updates download), an AppImage and a .deb
// per Linux architecture, and the update files beside them (latest-mac.yml,
// latest-linux.yml, latest-linux-arm64.yml).
//
// Run it through scripts/pack.mjs, which first puts what goes inside the
// app in .stage/: ravenryd for each architecture, the builds it installs on
// other machines (remote/), the hub, build.json and the icon. It also decides signing: see scripts/pack.mjs.
//
// Updates come from the GitHub Releases of the repository this is built
// from: GITHUB_REPOSITORY in CI, else the root package.json's repository.
// The same build works when that repository turns public, with no change.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rootPkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'package.json'), 'utf8'));

function githubRepo() {
  const slug = process.env.GITHUB_REPOSITORY
    || /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(String(rootPkg.repository?.url || ''))?.[1];
  if (!slug) throw new Error('electron-builder.config.mjs: no GitHub repository (set GITHUB_REPOSITORY=owner/repo)');
  const [owner, repo] = slug.split('/');
  return { owner, repo };
}

const signed = process.env.RAVENRY_SIGNED === '1';
const notarize = process.env.RAVENRY_NOTARIZE === '1';
const { owner, repo } = githubRepo();

/** @type {import('electron-builder').Configuration} */
export default {
  // One id on every platform: the Mac bundle id, the Linux desktop id
  // (desktopName, which Electron also takes as the window's app id and
  // WM_CLASS) and Android's applicationId.
  appId: 'dev.ravenry.app',
  productName: 'Ravenry',
  copyright: `Copyright © ${new Date().getUTCFullYear()} ${rootPkg.author}`,
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/**/*', '!dist/**/*.map', 'package.json'],
  extraMetadata: { desktopName: 'dev.ravenry.app.desktop', author: rootPkg.author, homepage: `https://github.com/${owner}/${repo}` },
  // Everything the app runs is bundled into dist/ by esbuild: no node_modules.
  npmRebuild: false,
  nodeGypRebuild: false,
  asar: true,
  icon: '.stage/icon.png',
  extraResources: [
    { from: '.stage/ravenryd/${platform}-${arch}/ravenryd', to: 'ravenryd' },
    { from: '.stage/remote', to: 'remote' },
    { from: '.stage/hub', to: 'hub' },
    { from: '.stage/hub-modules', to: 'hub/node_modules' },
    { from: '.stage/build.json', to: 'build.json' },
  ],
  artifactName: 'Ravenry-${version}-${os}-${arch}.${ext}',
  // Electron's fuses, set in the executable itself. Off: NODE_OPTIONS (and
  // NODE_EXTRA_CA_CERTS), and Node's --inspect arguments and SIGUSR1, each
  // a way for whoever starts the app to run code in it (src/main/gate.ts).
  // On: ELECTRON_RUN_AS_NODE, which the hub service, the hooks and the npm
  // switch run the app's executable with (install.ts, npmswitch.ts).
  electronFuses: {
    runAsNode: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
  },
  publish: [{ provider: 'github', owner, repo, releaseType: 'draft' }],

  mac: {
    category: 'public.app-category.developer-tools',
    target: ['dmg', 'zip'],
    minimumSystemVersion: '13.0',
    darkModeSupport: true,
    // Unsigned builds are signed ad hoc ("-"): Apple silicon runs nothing
    // without a signature, and no keychain is read. Both run under the
    // hardened runtime (which notarization requires), so DYLD_ variables
    // from whoever starts the app load nothing into it. Ad hoc, library
    // validation would refuse Electron's own framework, so the ad hoc
    // entitlements turn it off (build/entitlements.adhoc.plist says why).
    ...(signed ? {} : { identity: '-' }),
    hardenedRuntime: true,
    entitlements: signed ? 'build/entitlements.mac.plist' : 'build/entitlements.adhoc.plist',
    entitlementsInherit: signed ? 'build/entitlements.mac.plist' : 'build/entitlements.adhoc.plist',
    notarize,
  },
  dmg: {
    title: 'Ravenry ${version}',
    writeUpdateInfo: true,
  },

  linux: {
    target: ['AppImage', 'deb'],
    category: 'Development',
    executableName: 'ravenry',
    synopsis: 'The terminal built for coding agents',
    description: 'Ravenry: real terminals beside a board of every coding agent session, with what needs you first.',
    maintainer: rootPkg.author,
    vendor: rootPkg.author,
    // dev.ravenry.app.desktop, with StartupWMClass dev.ravenry.app to match.
    syncDesktopName: true,
    desktop: { entry: { Keywords: 'terminal;agents;claude;codex;' } },
  },
  deb: {
    // A .deb never updates itself (the app says so); updates are the next .deb.
    packageCategory: 'devel',
    priority: 'optional',
  },
};
