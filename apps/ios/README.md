# The iPhone app

A thin Swift shell around the shared phone board (`../phone`, the same
board the Android app shows), its plumbing written again from the Android
app's tested behaviour (`../android/app/src/main/java/dev/ravenry/app`).
On an iPad it runs full screen (C, picked 2026-11-15): the hub's
board at its wide width (the projects beside the open project) from 1000
pt, an 11-inch sideways or a 13-inch either way; the phone board in a
centred column of 700 pt narrower (an 11-inch upright, Split View, Slide
Over), live on a rotation (`Board.swift` BoardController.width); the app's
own pages and the pairing in a column of 640 pt; the words say iPad.
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
| `Shell.swift` | the connection watch (the top bar's chip), the private keyboard for a secret, the alerts (`AlertCenter`: drawn, taken off, and every button's answer) |
| `Push.swift` | push through APNs: the token and the alerts' key to the Mac (`POST /api/phone/push`, kind `apns`), a silent push (a close) opened |
| `Sources/Shared/PushCrypto.swift` | the alerts' key (P-256 and a 16-byte secret, in a Keychain group shared with the extension) and RFC 8291 decryption, CryptoKit only |
| `Sources/Shared/AlertContent.swift` | an alert as iOS draws it, with its buttons (a category made for each set), for the app and the extension |
| `Sources/Notify/NotificationService.swift` | the Notification Service Extension (`dev.ravenry.ios.notify`): opens each alert APNs brings and draws it; the relay's fixed placeholder when it cannot |
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
scripts/archive.sh [upload]        # the App Store build, signed, uploaded when asked
node tools/store-shots.mjs --udid <udid> --out <dir>   # the App Store's pictures, from the demo
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
and tapped with the app stopped, then one with it in the background); on an
iPad simulator, test9c: upright the column, sideways the wide layout and
back, live, the page and the open project kept, a card arriving live in
both, Run with Face ID, a pick opened and zoomed and an alert's screen
sideways, a Split View's room (simulated) the column, no launch hold in
either layout, none of the Mac's own controls, the iPad words (run it with
`--only test1_PairByTheTypedCode,test6_ThePairLinkAndWhichIPhone,test9c_TheIPadLayoutsFollowTheRoom`); then
the token in the simulator's Keychain and the secret in no log and nowhere
in the app's data. The pairing screens, the secure field, iOS's own sheets
and Face ID are driven natively; the board's buttons are pressed by a line
of script in its page (a debug build's `TestDrive`, as the Android checks
use the WebView's debugging port), since the live screen keeps the page
from ever being idle for XCUITest. Boot the simulator with `xcrun simctl
boot`, never Simulator.app.

Push through APNs (docs/PHONE.md section 4, "apns"): once paired, with
iOS showing its alerts, the app gives the Mac its APNs token, the APNs it
talks to (a debug build: `sandbox`; the App Store and TestFlight:
`production`, the `aps-environment` entitlement from
`RAVENRY_APS_ENVIRONMENT` in project.yml), the relay for this build
(Info.plist `RavenryRelay`, from `RAVENRY_RELAY`; scripts/archive.sh sets
it from the environment or the first line of
`~/.ravenry-release/ios-relay.txt`, and refuses to build without one) and
the public half of its alerts' key. The Mac seals each alert for it; the
relay (`../../relay`) hands it to APNs; the extension opens it. Buttons:
an answer (and the reply line) is sent from the alert with the phone
unlocked; Run, Allow once and This session open the app, which asks for
Face ID first; Open, Type it and Compare open the app. A simulator build
names no relay and gets no token from Apple: `tools/ios-e2e.mjs` test9k
gives it one (`RAVENRY_TEST_APNS_TOKEN`) and runs the real relay to a
stand-in APNs that hands each alert to `simctl push`. The App Store
profiles (`scripts/profile.mjs`): the app's with Push Notifications and
the extension's, its bundle ID registered the first time; `--check` only
reads.

Not built yet: a voice note, voice typing. The App Store build:
`scripts/archive.sh`, `../../docs/store/apple/UPLOAD.md`.
