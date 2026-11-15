# The iPhone app

A thin Swift shell around the shared phone board (`../phone`, the same
board the Android app shows), its plumbing written again from the Android
app's tested behaviour (`../android/app/src/main/java/dev/ravenry/app`).
The contract is `../../docs/PHONE.md`; what it does and does not do yet is
the iOS column of `../../docs/FEATURES.md`. iOS 18 and later.

Licence: GPL-3.0-only (../../LICENSING.md).

| File | |
| --- | --- |
| `Sources/Ravenry/Core.swift` | the pairing link, the pin and its check number, the reach words, the order the Mac's addresses are tried in |
| `HubClient.swift` | TLS that takes only the pinned key (URLSession), the device token, the live stream, the Wi-Fi address's short time to connect and iOS's Local Network answer |
| `Store.swift` | the pairing and the token in the Keychain (this device only) |
| `Pairing.swift` | the pairing screens: the QR code (AVFoundation), the typed code and its check number, the `ravenry://pair` link, Which iPhone is this, the alerts' ask |
| `Board.swift` | the board in a WKWebView at `ravenry-app://phone/` (a WKURLSchemeHandler), the bridge, Face ID before Run, Sign out |
| `Shell.swift` | the connection watch (the top bar's chip), the private keyboard for a secret, the alerts while the app is open |
| `InkLaunch.swift` | the launch's Ink: the Mac's `Shaders.swift`, compiled from its source as is |

## Build

An XcodeGen project (`project.yml`; the `.xcodeproj` is generated, not
committed, as `../macos` does), built headless by `xcodebuild` for the
simulator and signed ad hoc: no Apple account and no team are needed.
XcodeGen and not a Swift package, since only an Xcode project builds an iOS
app bundle with its Info.plist, resources and test bundles from the
command line.

```sh
scripts/build.sh                   # the app, for the simulator
scripts/build.sh test <udid>       # the unit tests on a booted simulator
node tools/ios-e2e.mjs --udid <udid> --out <dir> [--theme light] [--shots-only]
```

`tools/ios-e2e.mjs` runs a test hub on 127.0.0.1 with demo content
(`../phone/tools/demo.mjs --phone --phone-hosts 127.0.0.1`), the unit tests
with their live cases against it, then the app driven as a person would
(`Tests/RavenryUITests`): pairing by the typed code and by the link, Which
iPhone is this, the board, an answer, Run with Face ID (enrolled and
answered on the simulator), the secret, a wrong pin, the launch's Ink, then
cards that arrive while the board is open (quotes and accents, a 250 KB
state, after the background, after 50 s of a silent Mac in front and 30 s
of one while away, an idea whose name the hub cut in half of an emoji), and
a launch from an alert (a pick, a secret, a command, shown by `simctl push`
and tapped with the app stopped, then one with it in the background); then
the token in the simulator's Keychain and the secret in no log and nowhere
in the app's data. The pairing screens, the secure field, iOS's own sheets
and Face ID are driven natively; the board's buttons are pressed by a line
of script in its page (a debug build's `TestDrive`, as the Android checks
use the WebView's debugging port), since the live screen keeps the page
from ever being idle for XCUITest. Boot the simulator with `xcrun simctl
boot`, never Simulator.app.

Not built yet: push through APNs (the relay, the Notification Service
Extension) and alert buttons from push, which need an Apple account; a
photo or a voice note, voice typing; the App Store build.
