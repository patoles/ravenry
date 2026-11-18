# Putting the iPhone and iPad app on the App Store

How the App Store build is made and uploaded, what is already set in App
Store Connect, and what is left before the app goes to App Review. The
App Review notes are in REVIEW.md here; the pictures in `screenshots/`.

## What you upload

`Ravenry.ipa`, made from the release's commit by
`apps/ios/scripts/archive.sh` (`apps/ios/build/release/Ravenry.ipa`,
never committed): `xcodebuild archive` (Release, automatic signing,
Apple Development) then `xcodebuild -exportArchive` (method
app-store-connect, Apple Distribution). `scripts/archive.sh upload` also
uploads it with `xcrun altool --upload-app`. `scripts/build.sh` (the
simulator, signed ad hoc, as the checks and CI build it) is unchanged.

The version is the Mac app's (`apps/desktop/package.json`) and the build
number Android's versionCode (major * 1000000 + minor * 1000 + patch:
0.1.69 is build 1069), so the Mac, Android and iOS apps of one release
say the same number. App Store Connect takes one upload per build number:
a second upload of the same version needs `RAVENRY_IOS_BUILD=1069.1`
(the build on 0.1.69 now), then 1069.2 and so on.
The App Store version in App Store Connect is named the same (0.1.69).

### The environment

Nothing in the repository names the key; give it each time:

```sh
cd apps/ios
ASC_KEY_ID=<key ID> ASC_ISSUER_ID=<issuer ID> scripts/archive.sh upload
```

- `ASC_KEY_ID`, `ASC_ISSUER_ID`: an App Store Connect API key with the App
  Manager (or Admin) role (Users and Access, Integrations). Its `.p8` is
  read from `~/.appstoreconnect/private_keys/AuthKey_<key ID>.p8`, where
  altool also looks, or from `ASC_KEY_PATH`. The notary key of the Mac app
  is a different key; leave it to the Mac.
- `RAVENRY_IOS_TEAM`: the team, by default the one docs/PUBLISHING.md names.
- `RAVENRY_IOS_BUILD`: the build number, when it is not the version's own.

### The signing, made once

- The archive: Xcode's automatic signing with the Apple Development
  identity already in the login keychain; `-allowProvisioningUpdates` and
  the key let xcodebuild make its profile.
- The export: an App Manager key cannot use Apple's cloud-managed
  distribution certificate ("Cloud signing permission error"), so the
  export signs by hand with an Apple Distribution certificate of its own,
  made through the API. Its private key lives in a keychain of its own,
  `~/.ravenry-release/ravenry-ios-distribution.keychain-db` (beside the
  Android release key), whose password is the login keychain item
  "Ravenry iOS distribution keychain". archive.sh unlocks it and adds it
  to the keychain search list for the export only, then puts the list
  back; nothing else in the login keychain changes and codesign never
  asks for a password on screen.
- The App Store profile, "Ravenry App Store" for dev.ravenry.ios:
  `scripts/profile.mjs` (run by archive.sh) fetches it through the API,
  or makes it from the newest Apple Distribution certificate when there
  is none or it is about to expire, and installs it where Xcode looks.
- If that keychain is ever lost: revoke the certificate (Certificates,
  Identifiers & Profiles), make a new one from a new CSR through the API
  (`POST /v1/certificates`, type DISTRIBUTION), import it into a new
  keychain at the same path, and delete the old profile so profile.mjs
  makes a new one. An Admin key could use the cloud-managed certificate
  instead.

### Export compliance

`Info.plist` says `ITSAppUsesNonExemptEncryption` NO, so App Store
Connect asks nothing per build. The app's only encryption is Apple's
own: TLS through URLSession to the person's own Mac (the pinned key is
checked by comparing a SHA-256 of the certificate's public key, which is
authentication, not encryption), SHA-256 from CryptoKit for that pin and
the check number, and the Keychain. No encryption algorithm of its own,
no third-party crypto library; the board's page uses no Web Crypto. That
is the "only the encryption in Apple's operating system" case, exempt,
with no documentation to upload. When push through APNs comes (alerts
encrypted on the Mac for the phone, as Android's are), look again: with
CryptoKit's standard algorithms it stays exempt from documentation in
App Store Connect's own form, but the answer is to be checked then.

## What is set in App Store Connect

The app record (name "Ravenry: Agents Anywhere", SKU, primary language
English (U.S.), bundle ID dev.ravenry.ios), App Privacy ("Data Not
Collected") and the privacy policy URL were set by hand. Through the API:

- **App Information**: subtitle (en-US "Answer your coding agents", fr-FR
  "Répondez à vos agents de code"), category Developer Tools, secondary
  Productivity, the privacy policy URL for fr-FR too.
- **Age rating**: every content question None or No. Messaging and chat:
  no (the person writes only to their own agents on their own Mac, never
  to another person). User-generated content: no (what the board shows
  comes from the person's own Mac and is shown to them alone; nothing is
  shared between people). Unrestricted web access: no (the web view shows
  only the board the app carries; a link opens in Safari). Advertising,
  parental controls, age assurance, health topics, gambling, loot boxes,
  social media: no.
- **Pricing and availability**: Free, every territory, and new territories
  as Apple adds them.
- **The version (0.1.69)**: description, keywords, promotional text,
  support URL and marketing URL (the download page) in en-US and fr-FR
  (from the Play listing, listing.md, said again for iOS: Face ID in
  place of the fingerprint, a photo or a file and no voice note, no
  alerts in the background until push comes), the copyright line (the
  year and the owner's name, set there only), the build attached.
- **App Review Information**: Sign-in required off, the notes from
  REVIEW.md as they are. The contact's name, phone and email are left
  empty: the owner fills them in by hand.
- **TestFlight**: the build is in an internal group, "Internal", with
  every build, and the account holder as its tester. Internal testing
  needs no review.

## What is left before review

1. The screenshots: pick from `screenshots/` (below) and upload them on
   the version's page (iPhone 6.9" and iPad 13").
2. App Review Information: the contact's first and last name, phone and
   email.
3. Install the build from TestFlight on an iPhone and an iPad and try it
   with a Mac.
4. Add for Review, then Submit to App Review: the owner's own go.

## The screenshots

`screenshots/`, from the real app (a debug build of this repository) in
its demo on the simulator, dark, the status bar at 9:41, no frame and no
added text, no alpha channel; made by `apps/ios/tools/store-shots.mjs`
(headless: `xcrun simctl boot`, never Simulator.app), the same moments as
the Play pictures (docs/store/play/README.md). The demo's bar ("Demo.
Sample projects, nothing leaves this phone.", "this iPad" on the iPad) is
on each, as the app draws it.

| File | Size | What it shows |
| --- | --- | --- |
| `iphone-1-question.png` | 1320 x 2868 | notes-app's Claude asks "Ship the beta to the testers?", with Ship it, Not yet and a field for your own words. |
| `iphone-2-board.png` | 1320 x 2868 | The board on paper-boat: the projects, "Needs you since" and the session's live screen. |
| `iphone-3-pick.png` | 1320 x 2868 | The pick: B of three renders of the boat, the spray circled and a note pinned to it ("This, but less spray at the bow. It hides the boat."). |
| `iphone-4-approve.png` | 1320 x 2868 | recipe-box's command, `git push origin main && npm publish`, Ravenry's warning, where it runs, Refuse and Run (Face ID first). |
| `iphone-5-alert.png` | 1320 x 2868 | The question's alert, "Demo: notes-app needs you", held open with its answers. |
| `iphone-6-live.png` | 1320 x 2868 | paper-boat's live screen, full, with its keys and the message box. |
| `ipad-1-question.png` | 2752 x 2064 | The iPad, sideways: the wide board, notes-app's question beside its live screen. |
| `ipad-2-board.png` | 2752 x 2064 | The wide board on paper-boat: the pick waiting, the live screen. |
| `ipad-3-pick.png` | 2752 x 2064 | The pick, B circled with its note. |
| `ipad-4-approve.png` | 2752 x 2064 | recipe-box's command to approve. |
| `ipad-5-alert.png` | 2752 x 2064 | The question's alert over the wide board. |
| `ipad-6-live.png` | 2752 x 2064 | paper-boat's live screen, full, with its keys and the message box. |

```sh
cd apps/ios
xcrun simctl create "store iPhone" com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max   # then boot it
node tools/store-shots.mjs --udid <udid> --out <dir> --prefix iphone
node tools/store-shots.mjs --udid <iPad Pro 13-inch udid> --out <dir> --prefix ipad --sideways
```
