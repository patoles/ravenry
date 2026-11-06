// How the app is packaged (electron-builder): a DMG and a zip per Mac
// architecture (the zip is what updates download), an AppImage and a .deb
// per Linux architecture, and the update files beside them (latest-mac.yml,
// latest-linux.yml, latest-linux-arm64.yml).
//
// Run it through scripts/pack.mjs, which first puts what goes inside the
// app in .stage/: ravenryd for each architecture, the hub, build.json and
// the icon. It also decides signing: see scripts/pack.mjs.
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
  appId: 'gg.ravenry.desktop',
  productName: 'Ravenry',
  copyright: `Copyright © ${new Date().getUTCFullYear()} ${rootPkg.author}`,
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/**/*', '!dist/**/*.map', 'package.json'],
  extraMetadata: { author: rootPkg.author, homepage: `https://github.com/${owner}/${repo}` },
  // Everything the app runs is bundled into dist/ by esbuild: no node_modules.
  npmRebuild: false,
  nodeGypRebuild: false,
  asar: true,
  icon: '.stage/icon.png',
  extraResources: [
    { from: '.stage/ravenryd/${platform}-${arch}/ravenryd', to: 'ravenryd' },
    { from: '.stage/hub', to: 'hub' },
    { from: '.stage/hub-modules', to: 'hub/node_modules' },
    { from: '.stage/build.json', to: 'build.json' },
  ],
  artifactName: 'Ravenry-${version}-${os}-${arch}.${ext}',
  publish: [{ provider: 'github', owner, repo, releaseType: 'draft' }],

  mac: {
    category: 'public.app-category.developer-tools',
    target: ['dmg', 'zip'],
    minimumSystemVersion: '13.0',
    darkModeSupport: true,
    // Unsigned builds are signed ad hoc ("-"): Apple silicon runs nothing
    // without a signature, and no keychain is read. The hardened runtime
    // (which notarization requires) comes with a real signature only: ad
    // hoc, its library validation would refuse Electron's own framework.
    ...(signed ? {} : { identity: '-' }),
    hardenedRuntime: signed,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
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
    desktop: { entry: { StartupWMClass: 'Ravenry', Keywords: 'terminal;agents;claude;codex;' } },
  },
  deb: {
    // A .deb never updates itself (the app says so); updates are the next .deb.
    packageCategory: 'devel',
    priority: 'optional',
  },
};
