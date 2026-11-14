# Publishing the testers' release

Until the store releases, testers get Ravenry from one page and one public
repository: github.com/patoles/ravenry (the root package.json's
`ravenry.releases`; it also holds the npm board's code, on its `main`).

| What | Where |
| --- | --- |
| The launch page (`site/`) | that repository's `gh-pages` branch, on GitHub Pages: https://patoles.github.io/ravenry/ |
| The Mac app | its Releases: `Ravenry-mac.dmg` (the page's link, the same name on every release) and `Ravenry-<version>-mac-arm64.dmg` |
| The Mac app's updates | the same Releases: `latest-mac-native.json` and `RavenryNative-<version>.zip`, read by every packaged app (Resources/app-update.json, `Updater.swift`) |
| The Android app | the same Releases: `Ravenry-android.apk`. It has no updater: a tester downloads the new one from the page, and it installs over the old one, pairing kept |

The page is on `gh-pages`, not in a `docs/` folder, so the repository's
`main` (the npm board's code, whose own `docs/` is in use) is never touched.

## Tags and "latest"

A testers' release is tagged `v<version>` with the Mac app's version
(`v0.1.47`), made on the `gh-pages` commit of its page, and marked latest:
the page's links (`releases/latest/download/...`) and the Mac app's updater
both read the release marked latest. The npm board (`ravenry-app` on npm,
0.4.x) publishes no GitHub release there and has no update check that reads
one; if a release is ever made there by hand for it, make it with
`--latest=false`. The Electron app, and native builds packaged before
`ravenry.releases` (up to the first 0.1.47 package, on 2026-11-14), read the
private source repository's releases, not this one: nothing older picks up
a testers' release, and such a copy gets the testers' updates only once a
newer package is installed by hand. `tools/publish-testers.mjs` refuses a version
that is not newer than the release marked latest.

## The steps

1. Bump the version (`apps/desktop/package.json` and the lockfile, as
   "Make the app 0.1.47" did) and package:
   `node apps/macos/scripts/package.mjs`. It writes the zip, the feed and the
   dmg twice (`Ravenry-<version>-mac-arm64.dmg`, and `Ravenry-mac.dmg`, a
   hard link to it) in `apps/macos/build/package`.
2. The APK, with JDK 17: `cd apps/android && ./gradlew assembleRelease`. It
   is signed with the testers' key (below) and has the Mac app's version
   (versionCode major * 1000000 + minor * 1000 + patch, so it always goes up).
3. The usual release checks on the packaged app, and the release APK
   installed over the previous one on an emulator.
4. `node tools/publish-testers.mjs`: a dry run. It checks every file (the
   feed against the zip, the two dmgs the same, the app's update repository,
   the APK's version and key), reads the repository's releases, tags and
   Pages (GET only), and prints every step with each file's size and
   SHA-256. Read it, then `node tools/publish-testers.mjs --yes`, with `gh`
   signed in as an account that can write to the repository. It pushes the
   page to `gh-pages` (macVersion set, og:image made absolute), makes the
   release as a draft with every file, publishes it as latest, turns Pages
   on the first time, and reads the public feed and downloads back.
5. Open the page and download both files once.

### The Mac app's signature

On this Mac `package.mjs` signs with the Apple Development identity, not
notarized. A tester's Mac then refuses to open the app until they allow it
in System Settings, Privacy & Security, Open Anyway (the dry run warns). For
a release that opens normally, package with `RAVENRY_SIGN_IDENTITY` (a
Developer ID Application identity) and `RAVENRY_NOTARY_PROFILE`
(`package.mjs`'s header).

## The testers' Android key

Every testers' APK is signed with one key. An APK signed with any other
key does not install over the testers' copies: they would have to uninstall
it (and pair again). Keep it safe.

- The key: `~/.ravenry-release/ravenry-release.jks` (PKCS12, alias
  `ravenry-release`, RSA 4096, valid until 2054), the file mode 0600, the
  folder 0700. Outside the repository; never commit it.
- Its password: in the login keychain, item "Ravenry Android release key"
  (account `ravenry-release`). The store and the key share it. Gradle reads
  it with `/usr/bin/security` only when a release task runs.
- Its certificate's SHA-256 (public, in every APK it signs):
  `B1:89:B7:BB:C7:2A:03:F2:3C:CA:FF:DB:79:F4:D9:4B:1A:20:71:49:34:B3:A1:31:57:09:8C:5E:F7:AA:AC:65`.

Back it up now, both parts, somewhere that is not this Mac:

1. The password: `security find-generic-password -s "Ravenry Android release key" -w`
   prints it; put it in a password manager entry named "Ravenry Android
   release key".
2. The file: attach `~/.ravenry-release/ravenry-release.jks` to that entry
   (or copy it to an encrypted backup). A copy without its password, or the
   password without the file, cannot sign.

To restore it on another Mac: put the file back at the same path
(`chmod 700 ~/.ravenry-release; chmod 600 ~/.ravenry-release/ravenry-release.jks`),
then `security add-generic-password -a ravenry-release -s "Ravenry Android release key" -T /usr/bin/security -w`
(it asks for the password), and check the certificate with
`keytool -list -v -keystore ~/.ravenry-release/ravenry-release.jks` (the
SHA256 line above).

CI (`.github/workflows/android.yml`) signs with its own secrets, a
different upload key (its fingerprint is pinned there): its release APK
does not install over a tester's. To have CI build testers' APKs, put this
key in the secrets (`RAVENRY_ANDROID_KEYSTORE_B64` the file in base64,
both passwords this one, alias `ravenry-release`) and pin this
fingerprint in the workflow instead. For a Play release later, give Play
this key as the app signing key, so the testers' copies update from Play.

## The public repository's README

Proposed for patoles/ravenry's README, under the title (not applied):

> **Ravenry is now a Mac app.** The early test is open: get the Mac app and
> the Android app at https://patoles.github.io/ravenry/. This repository
> holds the npm board (`ravenry-app` 0.4), which the Mac app replaces.
