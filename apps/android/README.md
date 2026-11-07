# Ravenry Android app

A thin Kotlin shell around one WebView. The phone board in the WebView
(sessions, the live terminal, the checkpoint screens, the sidebar's pages)
is web code shared with iOS, `../phone`, built into the app's assets. The
shell adds only what a page cannot: pairing (QR code, typed code, the
`ravenry://pair` link), TLS with the pinned key, the device token,
notifications with action buttons and a reply line, a fingerprint before
every Run, a camera photo and a voice note into a session, the connection
held in the background, push through UnifiedPush, and the private keyboard
for a secret. The contract is [../../docs/PHONE.md](../../docs/PHONE.md).

Licence: GPL-3.0-only (../../LICENSING.md). No Google Play services and no
proprietary library: it builds for F-Droid.

## Build

```sh
npm ci                                   # at the repository root, for the phone board
cd apps/android
./gradlew assembleDebug testDebugUnitTest
```

Java 17 and the Android SDK (compileSdk 36). `buildPhoneBoard` runs
`node ../phone/build.mjs --out app/build/generated/phone-assets/phone`
before every build; without that file a placeholder page says so, and
`RAVENRY_PHONE_OPTIONAL=1` takes the placeholder when the board does not
build. A release is signed only with `RAVENRY_ANDROID_KEYSTORE` (a path),
`RAVENRY_ANDROID_KEYSTORE_PASSWORD`, `RAVENRY_ANDROID_KEY_ALIAS` and
`RAVENRY_ANDROID_KEY_PASSWORD`, from the environment or local.properties;
CI signs only when its secrets exist.

## Run on an emulator against a hub

Only an emulator, headless, and every adb command names it, so a phone on
the same cable is never touched:

```sh
avdmanager create avd -n ravenry-pixel -k "system-images;android-34;google_apis;arm64-v8a" -d pixel_7
emulator -avd ravenry-pixel -no-window -no-audio -no-boot-anim &
adb -s emulator-5554 install -r app/build/outputs/apk/debug/app-debug.apk
```

The emulator reaches this computer at 10.0.2.2. Start a hub with phone
access on and `RAVENRY_PHONE_HOSTS=10.0.2.2` so its pairing link names that
address, take the link from the Mac's phone card (`GET /api/phone`), and
open it in the app:

```sh
adb -s emulator-5554 shell am start -a android.intent.action.VIEW -d 'ravenry://pair?v=1&...'
```

The app asks "Pair with <name>?" first (a link can come from anyone), then
pairs and opens the board.

## How it works

- **Pairing.** The QR code (CameraX and ZXing) or the link carries the
  hub's addresses, port, key pin and a one-time code. The app connects
  with TLS that accepts only that key, sends the code to
  `POST /api/phone/pair`, and keeps the device token and the pin encrypted
  with a key in the Android Keystore. A typed code has no pin: the app
  shows the key's check number to compare with the Mac before pairing.
- **The board.** Served from the app at
  `https://appassets.androidplatform.net/phone/`. It talks to the shell
  over `ravenryShell` (`addWebMessageListener`, the page's origin only);
  every hub request, event stream and terminal socket goes through
  `HubClient` (OkHttp, the pin, the token). `hub/<path>` under the page is
  a picture or file of the hub, served to the page itself only (its own
  Referer and Origin; a frame of another origin is refused).
- **Push.** UnifiedPush with any distributor (the ntfy app, for one). The
  endpoint and its keys go to `POST /api/phone/push`; the hub encrypts each
  alert for this phone (RFC 8291) and the connector decrypts it. A
  foreground service also holds the hub's live stream while paired, so
  alerts arrive without a distributor too, under the quiet "Linked to ..."
  line. With a single distributor on the phone the app takes it without
  asking. ntfy listens only while Android lets it run in the background:
  turn its battery optimization off (the "Fix now" of its banner), or a
  registration made while ntfy is in the background gets an endpoint that
  nobody listens on until ntfy is next opened (Android 12 and later refuse
  its listening service otherwise).
- **Alerts.** Buttons and the reply line per docs/PHONE.md section 5,
  answered from the shade (`ActionReceiver`); Run opens only the
  fingerprint prompt (`RunActivity`). A secret is never typed into a
  notification.

## Tests

- `./gradlew testDebugUnitTest`: the pin (another key refused, even one an
  authority signed), the pairing link and the check number, the alert
  messages and their calls, push bodies opened with the connector's own
  decryption (the RFC 8291 example and one made by Node).
- Push through a real distributor, on the emulator:
  `RAVENRYD_BIN=../daemon/ravenryd node tools/push-ntfy-e2e.mjs --serial emulator-5554`
  in `hub/` installs ntfy's published APK (its SHA-256 and signer checked),
  runs ntfy's server in Docker on 127.0.0.1, pairs this app with a test hub,
  turns Stay connected off, closes the app, and proves that an ask and an
  approve arrive in the shade through ntfy and that their buttons answer
  the waiting `ravenry ask` and `ravenry approve`.
- On the emulator (`app/src/androidTest`): the bridge round trip against
  a pinned TLS server, and the MCP Apps sandbox spike (`SpikeActivity`,
  debug builds only). Build `assembleDebug assembleDebugAndroidTest`,
  install both APKs with `adb -s emulator-5554 install -r -t`, then
  `adb -s emulator-5554 shell am instrument -w dev.ravenry.app.test/androidx.test.runner.AndroidJUnitRunner`.
