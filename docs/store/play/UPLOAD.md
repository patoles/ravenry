# Putting the Android app on Google Play

The steps in the Play Console for the first release, and the words for
the forms it asks for. The graphics and the listing text are in this
folder (README.md, listing.md).

## What you upload

`Ravenry-<version>.aab`, the Android App Bundle, made from the release's
commit with `cd apps/android && ./gradlew bundleRelease`
(`app/build/outputs/bundle/release/app-release.aab`). It is signed with
the testers' key (docs/PUBLISHING.md, certificate SHA-256 `B1:89:B7:BB:...`),
the same key as `Ravenry-android.apk`, and has the same version (0.1.62 is
versionCode 1062). The bundle is never committed: the release round hands
it over with its SHA-256.

## 1. The app and Play App Signing

Play signs what it delivers with an app signing key. Use the testers' key
for it, not a new key from Google: then the app from Play has the same
signature as the APK the testers installed from the page, so it installs
over their copy and keeps their pairing. With a key made by Google, a
tester would have to uninstall the APK (and pair again) first.

1. Play Console, Create app: name Ravenry, App, Free, the declarations.
2. Testing, Internal testing, Create new release.
3. Under "App signing by Google Play" (or "App integrity"), choose to use
   a different key than the one Google makes ("Change app signing key" or
   "Use a different key"), then "Export and upload a key from Java
   keystore".
4. Download the two files the Console offers there: `pepk.jar` and the
   encryption public key (`encryption_public_key.pem`). Tell main where
   they are (Downloads is fine).
5. Main runs PEPK once (below) and gives you `ravenry-signing-key.zip`.
6. Upload that zip in the same place in the Console and save.

### The PEPK command (main runs it)

```sh
java -jar PATH/TO/pepk.jar \
  --keystore="$HOME/.ravenry-release/ravenry-release.jks" \
  --alias=ravenry-release \
  --output=PATH/TO/ravenry-signing-key.zip \
  --include-cert \
  --rsa-aes-encryption \
  --encryption-key-path=PATH/TO/encryption_public_key.pem
```

The keystore and the key share one password, the one Gradle reads: the
login keychain item "Ravenry Android release key"
(`/usr/bin/security find-generic-password -s "Ravenry Android release key" -w`).
Main gives it to PEPK from the keychain, never in chat and never in a
file kept afterwards: run `java -jar pepk.jar --help` first; when it lists
`--keystore-pass` and `--key-pass`, pass both from a temporary 0600 file
or an environment variable in the form its help gives, deleted right
after; else PEPK asks for it twice in the terminal. The zip holds the
private key encrypted for Google alone; it can be deleted once uploaded.

### The upload key

The same key is fine as the upload key: upload bundles signed with the
testers' key, as `bundleRelease` makes them. Play then has one key for
both roles. A separate upload key can be added later in App integrity if
the testers' key should ever stay off the build Mac.

## 2. The first release (Internal testing)

1. In the Internal testing release, upload `Ravenry-0.1.62.aab`. The
   Console reads versionCode 1062 and versionName 0.1.62.
2. Release name: `0.1.62`. Release notes (en-US): "First release on
   Google Play."
3. Testers tab: make an email list with the testers' Google accounts,
   save, and copy the opt-in link for them.
4. Review release, Start rollout to Internal testing.

Internal testing needs no review before testers get it, but the App
content forms below must be done before any release goes out.

## 3. App content forms

Policy, App content. The two that need words of their own are below; the
others are plain answers:

- Privacy policy: https://patoles.github.io/ravenry/privacy.html
- Ads: no ads.
- App access: below.
- Content rating: the questionnaire, a utility app with no user content
  shared with other people.
- Target audience: 18 and over.
- Data safety: no data collected or shared with Ravenry or third parties
  (the phone talks only to the person's own Mac; no account, no
  analytics; an alert sent through a push app the person picks, such as
  ntfy, is encrypted on the Mac for the phone alone). Encrypted in
  transit: yes.
- Foreground service permissions: below.

### Foreground service declaration (FOREGROUND_SERVICE_SPECIAL_USE)

The manifest declares one foreground service, `ConnectionService`, type
`specialUse`, subtype "Holds the connection to the person's own computer,
so its sessions' alerts arrive without a push service."

For the Console's form (tick "Other" / special use, then):

**What the task does.** Ravenry pairs the phone with the person's own
Mac, where their coding agents (Claude Code, Codex, OpenCode, Antigravity CLI) run. When an agent
needs them (a question, a choice, a command to approve), the Mac sends
an alert. The foreground service holds one encrypted connection to that
Mac and shows each alert as soon as it is sent. Its notification is
silent and always shown while it runs: "Connected to MacBook Pro" with
"Wi-Fi. 1 needs you.", or "Can't reach MacBook Pro" with "Trying again.".
It receives only; it uploads nothing and syncs no files.

**Why no other type fits.** There is no Ravenry server and no Firebase
push: alerts come straight from the person's computer. The connection
has no end the app can know in advance, so it is not dataSync (a
transfer that finishes, limited to 6 hours a day), not remoteMessaging
(messages between people), not connectedDevice (a peripheral the phone
drives over Bluetooth, USB or NFC) and not mediaPlayback or location.

**How it starts and stops.** It starts only after the person has paired
the phone with their Mac, from the app in the foreground (when the app
opens or comes to the front). It is on by default after pairing and the
person turns it off in the app's Settings, "Stay connected" ("Shows
alerts at once without push; a silent notification says so"); off, it
stops at once and does not start again. It also stops when the phone
is unpaired. A person who installs a UnifiedPush app (ntfy) can get
alerts by push instead and turn Stay connected off.

**What happens if it is stopped or deferred.** Alerts arrive late or
not at all while the app is in the background, so an agent waits on a
question the person does not see.

The Console also asks for a short video of the feature: a screen
recording of a paired phone showing the "Connected to ..." notification,
an alert arriving with the app in the background, and Settings, Stay
connected turned off and the notification going. Upload it unlisted
(YouTube or Drive) and give the link.

### App access

Choose "All or some functionality is restricted" and add these
instructions (no username or password: there is no account):

> Tap "Try the demo" at the bottom of the first screen ("No Mac yet? Try
> the demo"). The app opens on sample projects, with a bar on top that
> says it is a demo: browse Projects, Ideas, Rules, Ship and Pages, open a
> live screen, answer the question that arrives a few seconds in (with
> notifications allowed, it also comes as an alert titled "Demo: notes-app
> needs you"), run or refuse the command, and pick a picture. Everything
> stays on the phone; "Pair your Mac" in the bar leaves the demo.
>
> Ravenry is the phone companion of Ravenry for Mac, a free Mac app
> (https://patoles.github.io/ravenry/). It has no account and no server.
> To pair a real Mac: on a Mac with Apple silicon (macOS 13 or later),
> install Ravenry for Mac from the page above and open it; click the
> phone button in Ravenry; scan the QR code it shows with the phone (or
> tap "Type the code instead" and type the address and code under the QR
> code); check that the number on both screens matches and tap "They
> match, pair". The phone then shows the Mac's projects and sessions.
> The phone and the Mac must be on the same Wi-Fi network. Alerts appear
> when a coding agent (Claude Code, Codex, OpenCode or Antigravity CLI)
> running on the Mac asks a question.
