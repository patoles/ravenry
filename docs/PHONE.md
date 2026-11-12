# The phone apps

The contract between the hub, the phone apps (Android now, iOS next) and
the phone board they show. Decided once, before the code: what is written
here changes only with a new version number in the place that carries it
(the pairing link's `v`, the push message's `v`, the bridge's `v`, the
hub's `api`), and an old phone keeps working against a new hub.

## 1. What a phone app is

A thin native shell around one WebView. Its home is **the hub's own
board** at phone width (`hub/public`, the approved phone designs: the
projects as chips with the selected one's detail under them
(PhoneProjects C), the Live screen (LiveScreen B), the message box with
New session (NewSession D), and the menu: a top bar and a bottom bar with
Projects, Ideas, Rules, Ship and Pages (PhoneMenu A, 2026-11-12)), loaded
from the hub over the pinned connection at the app's own origin. The same
board serves a phone's browser. The app adds `apps/phone/src/board.ts`
first in that page (the app's layer: the board's requests through the
shell, a fingerprint before Run, the reach bar, Back, the connection for
the top bar's chip, the launch's landing spot, This phone in the menu) and its own screens, `apps/phone/` (a checkpoint full screen for a
secret, a pick or a drive, a photo or voice note for it, the app's
settings). The shell adds only what a page cannot do:

- notifications with action buttons and a reply line, so Needs you, an
  `ask --wait` or a checkpoint is answered from the shade;
- pairing with the computer: the QR code, the pinned key, the device token;
- a fingerprint (BiometricPrompt, Face ID on iOS) before every Run from the
  phone;
- a camera photo and a voice note dropped into a session;
- the connection to the hub in the background, and push;
- the private keyboard for a secret.

**Every byte to the hub goes through the shell.** The page never opens a
network connection of its own: it asks the shell (section 7), and the
shell makes the request over TLS with the pinned key and the device token.
So the pin is enforced in one place, the token never enters the page, and
a valid certificate from any authority is refused if its key is not the
pinned one. The app's own screens are served from the app
(`https://appassets.androidplatform.net/phone/` on Android,
`ravenry-app://phone/` on iOS); the board is the rest of that origin: the
shell fetches the hub's `/` (with `board.js` put first in its head), its
files and its pictures over the pinned connection, for the page itself
only (its own Referer and Origin; a frame of another origin is refused),
and the board's `fetch('/api/...')` and `EventSource('/api/events')` go
through the bridge (`http`, `hub.events`). A picture or file of the hub
for the app's own screens is `hub/<path>` relative to their page, fetched
the same way.

**The phone never resizes a pane.** The Mac keeps its own size: the board
shows a session's screen as text (the Live screen, from `GET /api/live`),
laid out at the phone's width, a line the pane's width wrapped joined
again (`pane.capture`'s `wrapped`), scrolled by touch; the key bar (Esc,
Tab, the arrows, Enter, Ctrl-C) over the message box in full screen
presses keys in a Ravenry pane (`POST /api/keys`). The hub turns a
`pane.resize` that comes from a phone on `/api/term` (an older app's
terminal) into a `pane.capture`, so the pane keeps its size; and the Mac
app asks for its own size back when it sees a pane drawn at a size it did
not ask for (one an older phone app left small).

**When the Mac does not answer**, the app says why in plain words, never
a host name or an address: "Tailscale is off on this phone. Turn it on,
then try again." (with Open Tailscale) when only the tailnet could answer
and no VPN is up or a tailnet name did not resolve; "This phone doesn't
have Tailscale. Install it and sign in, then try again." (Get Tailscale,
its store page) when it is not installed; else that the Mac did not
answer. On the pairing screen, in the board's bar at the top (with Try
again) and in the connection notification. Tailnet addresses are not
tried while no VPN is up, so the words come at once.

### The way back

Every screen has a way back on the screen and Android's Back goes one
level up (2026-11-12, the phonenotes2 walk):

- a full screen has its back arrow at the top left with its title (a page,
  Objectives, Search, Sessions, an open idea, a plan, New plan, Settings,
  and at phone width New project and Write the brief, which are full
  screens there); a sheet has Done or a close x and closes on a swipe down
  from its handle;
- Settings is the menu's (top bar, then Settings), a full screen with the
  bottom bar kept; it is not in Pages;
- Back closes the layer on top, whichever it is (any dialog or menu, a
  future one too: it presses that layer's own close control), else takes a
  screen back to its destination (a page to Pages, Sessions or Search to
  where it was opened, an open idea to Ideas, Suggested to Your rules), else
  a destination to Projects; at home it leaves the app, which stays as it
  was in the background (no launch when it comes back). The board's
  `window.ravenryBack` (`hub/public/app.js` phoneBack) does it; the app calls
  it from Android's Back (`board.ts`). A dialog with no close control is a
  bug: Back hides it (never leaves the app behind it) and
  `hub/tools/phone-back-test.mjs` fails on it. On the pairing screen Back
  goes one step up (the code typed or the Pair question to the camera) and
  leaves from the camera.

### The connection

The phone's top bar carries a chip saying whether the phone reaches the
Mac and how: Wi-Fi (green), Tailscale (blue), Reconnecting (orange, its
dot pulsing) or Offline (red). "Wi-Fi", never "Home Wi-Fi": the phone may be
on any Wi-Fi the Mac is on. The home's bar is B (picked 2026-11-12): the
word Ravenry at 18 px beside a 24 px mark, the chip 28 px tall at 12 px,
Search and More at their 40 dp, so the word stays beside the chip at 360,
393 and 412 px in every state; narrower, it gives way to the mark alone
(`phone-bar-test.mjs`). A tap opens its details sheet: which Mac, how
("Wi-Fi, straight to the Mac"; "Tailscale, through Ravenry's own device on
your tailnet" or "through the Mac's Tailscale app"; this computer), since
when, how fast it answers, and Open
Tailscale and Reconnect. Offline, the reason words stay under the top bar
(the reach bar, with Open Tailscale and Try again).

In the app the shell watches (`MainActivity` ConnWatch): `GET
/api/phone/hello` every 30 s while up and every 3 s while not (5 s each at
most), the stream's own drops too; a failure makes it Reconnecting, three
in a row Offline (with the reason, `Reach.kt`), an answer Up again (the
stream reopened at once). It sends the page `conn` events (state, path,
since, round trip, reason) and answers `conn.now` and `conn.reconnect`. The
path is `Reach.via`: an address that is not a tailnet host is Wi-Fi;
`ravenry.<tailnet>.ts.net` and the 100.x address the pairing link lists
after it are Ravenry's own device; other tailnet addresses the Mac's
Tailscale app. A phone's browser reads its own address the same way (a
`.ts.net` name or 100.64.0.0/10 is Tailscale) and its live stream for
Reconnecting and Offline; the Mac's own board has no chip.

Wi-Fi first (`HubClient.order`): whenever a Wi-Fi address (any that is
not a tailnet host; "home" in the code) answers, the phone goes through it,
Tailscale only when none does, whichever answered last. A Wi-Fi address
gets 1.5 s to accept a connection (a local network answers in tens of ms);
one that did not answer is tried after Tailscale until it answers again or
the phone's network changes, so off that Wi-Fi it costs requests nothing
(measured: 2 ms a request after the first). The 30 s check tries the Wi-Fi
addresses first every time, so coming back to the Mac's Wi-Fi switches the
path and the chip to Wi-Fi within one check (sooner when the phone joins the Wi-Fi: the network
callback checks at once), leaving switches to Tailscale, and the stream
reopens on the new path (`HubOrderTest`; on the emulator both answering is
Wi-Fi, the Wi-Fi address dropped is Tailscale in 29 s, back is Wi-Fi in
29 s).

### The launch

On a cold start the app draws itself in ink (the approved Ink, variant A,
`phoneink` 2026-11-12): Android's splash plays an animated vector
(`res/drawable*/ink_splash.xml`, generated by `apps/android/tools/
ink-avd.mjs` from the mark's geometry, 288 dp with no icon background,
night and day) in which ink drops swirl in and merge into the raven and its
eye opens with one ripple, in 800 ms. Then the app holds that last frame
exactly where the splash drew it (`InkLaunch.kt`; the window's own
background is the still mark too, so no frame is ever empty) until the
board has drawn its top bar (`board.js` says where the bar's mark is,
`ink.ready`), and the mark flies on an arc to the bar's mark while the
board is revealed from there through a soft edge (a radial gradient: the
same on every Android version, rather than an AGSL shader on 13 and a
circular reveal on 12). When the Mac takes longer: the same drawing,
"Reaching your Mac..." after 1.4 s, the eye breathing, then the same exit;
after 12 s the reason words and Try again (the board loads afresh once the
Mac answers). With the phone's animations off, the still mark and then the
board at once; Android 8 to 11 have no splash API, so the window shows the
still mark and the exit still plays.

Coming back to the app is never an empty screen (phonefix3, Simon on his
Flip: "2/3 seconds of blank screen" on a reopen). A hot start (the activity
and its board still there) shows the board at once. What changes while the
app is open or in the background no longer rebuilds it: a fold or the cover
screen, a new size, density or colour mode, a keyboard, the font size, a
new network country (`configChanges` in the manifest; the WebView lays the
board out again in place). When the activity is rebuilt anyway (Android
closed it in the background, the page's renderer was killed, a light or
dark switch), the board reloads behind the still mark: centred where the
splash draws it, "Reaching your Mac..." after 1.4 s, and a 150 ms fade as
soon as the board's bar is laid out (the page's hello says `launch:
"warm"`, so it reports at once instead of when idle). Measured on the
emulator with 150 ms of network latency: Don't keep activities, 0.1.43 had
500 ms of empty window, now the mark for 350 ms and the board at 415 ms;
density and size changes keep the board (no reload).

## 2. Reaching the hub

**Phone access** is a switch on the computer, off until the person turns
it on (pairing turns it on). While it is on, the hub listens with TLS on
the **phone port** (`RAVENRY_PHONE_PORT`, default the board's port plus
one: 4601) and takes connections that arrive on:

- a private LAN address of this machine (10/8, 172.16/12, 192.168/16): the
  Wi-Fi the Mac is on;
- a Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48): off that Wi-Fi,
  through the Tailscale app on this Mac, when it runs;
- loopback, so an emulator on this machine reaches it (its 10.0.2.2), and
  so does Ravenry's own device on the person's tailnet (Away from home,
  below), which passes the owner's phones to it.

A connection to any other local address is closed before TLS. With the
switch off there is no TLS socket at all. The board's own port (4600)
serves the Mac's window on loopback (127.0.0.1 and ::1, always), and phone
browsers signed in with the QR cookie on the Wi-Fi only while the same
switch is on: off, the board listens on this Mac only, so a connection to
its Wi-Fi or Tailscale address is refused; on, it listens on every address
too (`hub/server/boardlisten.mjs`), opened and closed the moment the switch
moves, without a restart, the Mac's own loopback connections kept. A
request from the Wi-Fi that still arrives while it is off (the QR's `/?k=`
sign-in, a cookie or a token) gets 403, "Phone access is off on the
computer.

### Away from home

The phone reaches this Mac away from home through the person's own
Tailscale, with no VPN app on the Mac: Ravenry joins their tailnet as a
device of its own, named **ravenry** (Tailscale adds a number when the name
is taken), with Tailscale's tsnet inside `ravenryd tailnet`
(`daemon/internal/tailnet`). The phone needs the Tailscale app, signed in
with the same account.

- **The switch.** Away from home, in the phone card under the code
  (`POST /api/phone/away { on }`, kept in `phone.json` as `away`). The
  device runs, as a child of the hub (`hub/server/tailnet.mjs`), only while
  phone access and Away from home are both on and the person signed in;
  otherwise nothing of Ravenry is on the tailnet and nothing listens there.
  Off, the keys are kept: on again, it joins again without a sign-in. The
  hub gone, its input closes and the device leaves with it.
- **Sign in with Tailscale** (`POST /api/phone/away/signin`): the hub starts
  the device, which asks Tailscale for a sign-in page; the hub answers with
  it (`away.authURL`) and the card opens it in the browser. Waiting, the
  card offers the page again and **Cancel** (`/api/phone/away/cancel`: the
  device stops, nothing is kept). A sign-in not finished within 10 minutes
  fails: "The sign-in did not finish, so nothing changed.", and **Try
  again** starts a new one. The sign-in page is never written to a log.
- **Who gets in.** The device listens on the tailnet on the phone port only,
  and passes each connection, unchanged, to the phone port on 127.0.0.1
  (TLS end to end: the pin and the device token of sections 2 and 3 are
  checked by the hub as on the Wi-Fi). Before a byte is passed it looks the
  caller up (Tailscale's WhoIs): only a device of the account that owns
  `ravenry` gets in. A tagged device, a device shared in from another
  account and another account's device are closed at once. The board's own
  port is not on the tailnet: the phone app needs only the phone port.
- **Sign out** (`/api/phone/away/signout`): the device logs out (as
  `tailscale logout`: Tailscale takes it off the tailnet), its keys are
  deleted and the switch goes off. When Tailscale cannot be reached the keys
  are deleted all the same and the card says to remove ravenry in
  Tailscale's admin page.
- **No internet.** The device keeps its name and joins again by itself; the
  card says the phone cannot reach the Mac away from home meanwhile.
- **Its keys** live in `<RAVENRY_HOME>/tailnet/` (mode 0700), what it last
  was (name, MagicDNS name, addresses, account) in
  `<RAVENRY_HOME>/tailnet.json` (mode 0600). Tailscale's log uploads are
  off.
- **The card** (`GET /api/phone`) carries `wifi` (the address the Home
  Wi-Fi row shows) and `away`: `{ on, state, name, host, ips, account,
  authURL?, error?, listening }`, `state` one of `off`, `ready`, `starting`,
  `waiting`, `on`, `offline`, `failed`, `paused` (signed in, phone access
  off).
- **Tests** never sign in to a real tailnet: `MC_TEST_TAILNET_CONTROL`
  points the device at `daemon/tools/tailnetlab` (Tailscale's test control
  server on 127.0.0.1). A person's board quits on it (exit 2), so does a
  release of the Mac app run as Node, and `ravenryd tailnet` takes no
  control server but Tailscale's or one on loopback.

**The key.** The hub makes one ECDSA P-256 key and a self-signed
certificate for it on first use (`<RAVENRY_HOME>/phone-tls/`, key mode
0600). The **pin** is the base64url SHA-256 of the certificate's
SubjectPublicKeyInfo (43 characters). The phone checks the pin on every
connection and refuses any other key, whoever signed it. New key (below)
does not change the TLS key: the pin outlives tokens.

**Every request on the phone port is a phone's.** It carries the device
token as `Authorization: Bearer <token>`, or it is refused with 401
(`signedOut: true`). Nothing on the phone port is treated as the Mac, even
on loopback. The exceptions: `POST /api/phone/pair` (the pairing code is
its proof) and `GET /api/phone/hello` (the hub's name and `api`, no
secret).

## 3. Pairing and tokens

### The pairing link

The Mac shows a QR code holding

```
ravenry://pair?v=1&name=<hub name>&hosts=<host>[,<host>...]&port=<phone port>&pin=<pin>&code=<pairing code>
```

- `name`: what the phone calls the computer (its host name, `.local`
  dropped), URL-encoded.
- `hosts`: the addresses to try, in order: the Wi-Fi's first, then, while
  Away from home is on, the ravenry device's MagicDNS name
  (`ravenry.<tailnet>.ts.net`) and its 100.x address, then this Mac's own
  Tailscale addresses (the Tailscale app's, when it runs), then any in
  `RAVENRY_PHONE_HOSTS` (comma separated, for an emulator: `10.0.2.2`). A
  host is an address or a name; the phone resolves a name (MagicDNS, through
  its Tailscale app) and checks the pin whatever the name.
- `pin`: section 2.
- `code`: a **pairing code**, 16 characters of Crockford base32 (80 bits),
  made when the Mac shows the card. It works once, for 10 minutes. Showing
  the card again makes a new one and the old one stops working.

The app opens the same link when it is tapped or pasted (a deep link), so
a link sent by another way pairs too.

**Typed instead of scanned.** "Type the code instead" asks for the
computer's address and the code, shown on the card as `XXXX-XXXX-XXXX-XXXX`.
There is no pin to type, so the phone connects, takes the certificate's
key, and shows its **check number**: the first five bytes of the key's
SHA-256 (the pin's bytes) read as one big-endian number, modulo 10^12, as
two groups of six digits (`482193 300571`). The Mac's card shows the same
check number under the code; the person pairs only when they match. After
that the phone pins that key exactly as if it had scanned it.

### Pairing

`POST /api/phone/pair` on the phone port, body
`{ "code": "...", "name": "Pixel 8", "platform": "android", "app": "0.1.0" }`.
The name is the one the person gave the phone: the system device name
(Settings.Global DEVICE_NAME), then Bluetooth's name, then maker and model
(never Build.MODEL alone, a code like "SM-F731B"). The Mac's card can rename it.

- **200** `{ ok, device: { id, name }, token, hub: { name, pin, port, api } }`.
  `token` is 32 random bytes, base64url. The hub keeps only its SHA-256.
- **401** `{ error }`: the code is wrong, used or out of date. Five wrong
  codes in a minute lock pairing for a minute.
- **403**: phone access is off.

The code is compared in constant time and used up by the first success.

### Devices

`<RAVENRY_HOME>/phone.json` (mode 0600) keeps one record per device:
`{ id, hash, name, platform, app, created, lastSeen, push }`. A phone
browser signed in with the QR cookie is a device too (`platform: "browser"`,
its cookie is its token). The same token store serves both; the cookie
`mc_phone` and the header are two ways to carry a token.

| Route | Where | Class | |
| --- | --- | --- | --- |
| `GET /api/phone/me` | the device | read | `{ device, hub, access }` |
| `POST /api/phone/unpair` | the device | person | signs this device out (its token is forgotten) |
| `POST /api/phone/push` | the device | person | sets this device's push target (section 4) |
| `GET /api/phone/devices` | the Mac | read | every device, without hashes |
| `POST /api/phone/devices/rename` | the Mac | person | `{ id, name }`: the name the card and the phone's settings show (60 characters at most) |
| `POST /api/phone/devices/revoke` | the Mac | person | `{ id }`: that device is signed out at once, its open streams end |
| `POST /api/phone/access` | the Mac | person | `{ on }`: phone access on or off |
| `POST /api/phone/away` | the Mac | person | `{ on }`: Away from home on or off (section 2) |
| `POST /api/phone/away/signin`, `cancel`, `signout` | the Mac | person | Sign in with Tailscale (answers with the sign-in page), Cancel, Sign out (`removed`: Tailscale took the log-out) |
| `POST /api/phone/new-key` | the Mac | person | as before: a new sign-in key, every device signed out |
| `GET /api/phone` | the Mac | person | the card: the browser QR as before, and while access is on the app's pairing link, its QR, the code and the check number |

A revoked or forgotten token gets 401 with `signedOut: true` on its next
request, and the app goes back to the pairing screen.

### Who the phone is

A paired device's request is **the person** (`server/person.mjs`,
`hub/docs/PERSON.md`): from another address with a valid token it passes
every person row. From an address of this machine (an emulator, or a
program here that stole a token) it is judged like any other local caller,
by `ravenryd peer`: inside a pane it is refused. `POST /api/phone/pair`
is a person row: from another address the code proves it, from this
machine it is judged.

## 4. Push

Each device has at most one **push target**, set by the device itself with
`POST /api/phone/push`:

| `kind` | Fields | Built | |
| --- | --- | --- | --- |
| `unifiedpush` | `endpoint`, `p256dh`, `auth` | now | Android, through any UnifiedPush distributor (ntfy) |
| `apns` | `relay`, `token`, `p256dh`, `auth` | later | iOS, through a Ravenry relay to APNs |
| `fcm` | `token`, `p256dh`, `auth` | later | Android with Google services, through a relay |
| `none` | | now | no push; alerts arrive only while the app holds its connection |

The hub refuses a kind it does not build yet with 400, so a phone never
believes push works when it does not.

**End to end.** Every push body is encrypted for the device with Web Push
message encryption (RFC 8291, `aes128gcm`, RFC 8188): `p256dh` is the
device's P-256 public key (uncompressed, base64url) and `auth` its 16-byte
secret (base64url), both made on the phone. A distributor, a relay, Apple
or Google sees only ciphertext and the endpoint. The plaintext is the
message of section 5, at most 3000 bytes (longer texts are cut with `...`).

- **unifiedpush**: `POST <endpoint>` with `Content-Encoding: aes128gcm`,
  `TTL: 3600`, `Urgency: high`, the encrypted body. 404 or 410 drops the
  target; another failure is tried once more after 30 s. The endpoint must
  be https, or http to an IP address on this computer (loopback), the home
  network (10/8, 172.16/12, 192.168/16, IPv6 fc00::/7) or Tailscale
  (100.64/10), where a self-hosted distributor such as ntfy often runs
  without TLS; the body is encrypted for the phone either way. http to a
  host name or a public address is refused with 400.
- **apns** (designed): `POST <relay>/v1/apns` `{ token, ttl, body }` with the
  same encrypted body in base64url; the relay sends it to APNs with
  `mutable-content: 1` and a placeholder title, and the app's Notification
  Service Extension decrypts it and draws the real alert. The relay keeps
  nothing.

The same messages also reach a device on its live event stream
(`GET /api/events`, as `event: phone`), so an app that holds its connection
shows an alert at once and without push. The app keeps each alert id it
has shown and draws it once.

## 5. Alerts and their actions

### The message

```json
{
  "v": 1, "type": "alert", "id": "cp:c7k2m9qx", "at": "2026-11-06T17:36:02.120Z",
  "kind": "ask",
  "title": "Sync settings asks",
  "body": "Ship the beta to the testers?",
  "detail": "Claude waits until 18:04.",
  "project": { "id": "notes-app", "name": "notes-app" },
  "machine": null,
  "session": { "surfaceId": "ravenry:pk3m9q2x", "topic": "Sync settings", "assistant": "claude" },
  "checkpoint": { "id": "c7k2m9qx", "kind": "ask", "expires_at": "2026-11-06T18:04:00.000Z" },
  "actions": [
    { "id": "choice:0", "label": "Ship it" },
    { "id": "choice:1", "label": "Not yet" }
  ],
  "reply": { "action": "text", "label": "Answer", "hint": "Answer in your own words" }
}
```

`{ "v": 1, "type": "close", "id": "cp:c7k2m9qx" }` takes an alert off the
phone: the checkpoint was answered, cancelled or ran out, or the session
left Needs you. `{ "v": 1, "type": "test", ... }` is a test alert.

Unlike the third-party channels (Telegram, Discord, ntfy topics), which
carry only "<Project> needs you", an app alert carries the question, the
command and the agent's words: it is encrypted for that phone.

### Ids

| Alert | `id` |
| --- | --- |
| A checkpoint | `cp:<checkpoint id>` |
| A decision an agent saved | `dec:<decision id>` |
| A session in Needs you | `s:<project id>:<surface id>:<since>` |
| A plan gate | `gate:<first 16 characters of the base64url SHA-256 of the gate key>` |
| A test | `test:<time>` |

### Kinds, buttons and the reply line

Android shows at most three buttons. When a menu has more answers than
fit, it shows the first ones and **Open**.

| `kind` | When | Buttons | Reply line |
| --- | --- | --- | --- |
| `ask` | `ravenry ask` (a checkpoint) | its options, `choice:<i>`; with `free_text`, at most two of them | with `free_text`: **Answer** |
| `approve` | `ravenry approve` | **Run** (`run`, fingerprint first), **Refuse** (`refuse`), **Open** (`open`) | none |
| `secret` | `ravenry secret` | **Type it** (`open`), **Not now** (`decline`) | **none**, ever: a secret is never typed into a notification |
| `drive` | an agent typed into, closed, restarted or changed the test conditions of a pane it did not start (`checkpoint.drive.action`: `input`, `close`, `restart`, `override`), and waits | **Allow once** (`allow:once`, fingerprint first), **This session** (`allow:session`, fingerprint first), **Refuse** (`refuse`) | none |
| `pick` | `ravenry pick` (2 to 4 variants) | the shade shows **Compare** (`open`, the app's swipe screen) and **Not now** (`later`: the alert goes, nothing is sent, the agent keeps waiting), whatever the message lists; `pick:<i>` per variant label still answers when a message's action asks for it | none: the region and the note ("this, but...") are in the app |
| `decision` | an agent saved the person's words in the decision ledger | **Undo** (`undo`), for a minute; then the alert closes | none |
| `permission` | the assistant's own permission menu | its answers, `quick:<n>` (Yes, Yes always, No) | none |
| `question` | the assistant asked in the session | its quick answers, `quick:<n>`, at most two | **Reply** |
| `handback` | the session handed back | **Open** | **Reply** |
| `gate` | a plan waits at a gate | **Open** | none |

What each action does, as the device, on the phone port:

| Action | Call |
| --- | --- |
| `choice:<i>` | `POST /api/checkpoints/answer { id: checkpoint, choice: i, by: "phone" }` |
| the reply of an `ask` | `POST /api/checkpoints/answer { id: checkpoint, text, by: "phone" }` |
| `run` (marked `biometric: true`) | BiometricPrompt, then `POST /api/checkpoints/answer { id: checkpoint, approve: true, by: "phone" }` |
| `refuse`, `decline` | `POST /api/checkpoints/answer { id: checkpoint, decline: true, by: "phone" }` |
| `allow:once`, `allow:session` (marked `biometric: true`) | BiometricPrompt, then `POST /api/checkpoints/answer { id: checkpoint, approve: true, allow: "once" or "session", by: "phone" }` |
| `pick:<i>` | `POST /api/checkpoints/answer { id: checkpoint, pick: { label: checkpoint.variants[i].label }, by: "phone" }` |
| `later` | nothing: the alert leaves the shade |
| `undo` | `POST /api/decisions/undo { id: decision.id }` (refused after `decision.undo_until`) |
| `quick:<n>` | `POST /api/send { projectId, surfaceId, choice: n }`; an answer the screen gave no number carries its `text` on the action, and sends `{ projectId, surfaceId, text }` instead |
| the reply of a session | `POST /api/send { projectId, surfaceId, text }` |
| `open` | opens the app on that checkpoint or session |

**Run always asks for a fingerprint**, from the shade and in the app, and
cannot be turned off. So do **Allow once** and **This session** on a
`drive`: letting an agent type into a pane is as strong as running a
command there.

**A drive** carries `checkpoint.drive: { pane, action, name, session,
reason?, keys? }`: the pane the agent wants to act on, what it wants to do
(`input`: type into it; `close`; `restart`; `override`: change its size,
speed or TERM), the pane's `name` as the sidebar and the tabs show it
(the topic of the session that runs in it, else its name, its title or
its command's program; null when the hub does not know the pane), the
asking `session`'s topic, and `reason`, the agent's own words for why
(at most 300 characters here), when it gave them. The title names both,
never by id: "Claude, in Tilting the hull, wants to type in dev server"
("... wants to close dev server", "... restart ...", "... change how
dev server runs"); with no `name`, the daemon's own title. `body` is
"Claude says: <reason>" when there is a reason, with what it would type
in `detail` ("It would type: ..."); else `body` is what it would type or
which conditions it would set. What it would type always reads with its
keys as people say them, never as tokens ("[Ctrl C] npm run dev
[Enter]", from the one formatter, hub/public/keys.mjs), and `keys` carries
it in parts (`{ kind: "text" | "key", text }`) so the app draws each key as
a key. The phone says it the same way, with one yes for an
action other than typing (**Let it close**, **Let it restart**, **Let it
change it**, as `allow:once`) beside **Refuse**; typing keeps **Allow
once** and **This session**. Closing or restarting ends
what runs there, so the same fingerprint goes before Allow once and This
session. Allowing it for the
session lasts until the agent's session ends; there is no "always".

**A pick** carries `checkpoint.variants: [{ label, type: "image" | "html",
description?, url }]` (`description`: the agent's line about the
variant, at most 200 characters here, when it gave one). `url` is `/api/checkpoints/<id>/variants/<n>` on the hub, served
with the device token from the copy the hub keeps in its data (never the
agent's own file); HTML and SVG come with `Content-Security-Policy:
sandbox`. The app fetches the image variants over the pinned connection
and draws them side by side in the alert, with the question and "3
pictures.". The app's pick screen shows one variant at a time, full
width, swiped, with its letter ("B, 2 of 3"), its label whole as its
name and its `description` as the agent's words ("Claude: ..."); an HTML
variant shows in a frame with no scripts (the page allows frames of its
own origin only, the hub's pages through the shell, which keeps the
hub's `Content-Security-Policy: sandbox` on them); Circle a part lets
the person draw around a part of the chosen one with a finger (the box
around the path is the region) and type or speak a note, and it
answers `{ id, pick: { label, region: { x, y, w, h } (each 0 to
1 of the picture), note }, by: "phone" }`.

**A saved decision** carries `decision: { id, undo_until }`, the quote in
`body` and who recorded it in `detail`. With no fingerprint (or face) set up on the phone,
Run says so and does nothing; the command is approved on the computer.

After an action the notification says what was sent ("Sent: Ship it"),
then goes after four seconds. If the hub refused it (answered elsewhere
first, signed out), the notification says why and keeps **Open**.

### Channels (Android)

| Channel | Importance | |
| --- | --- | --- |
| `needs-you` | high (heads-up, sound) | every alert |
| `connection` | min, silent | "Linked to <computer> and <machines>. N sessions working, M need you." while the app holds its connection |

## 6. The terminal on the phone

`GET /api/term?pane=<pane id>`, a WebSocket upgrade with the subprotocol
`ravenry.v1`, on the phone port. The hub finds the daemon that holds the
pane (this machine's, or a machine's through `ssh host ravenryd proxy`)
and joins the two byte streams: the phone speaks protocol v1
(`packages/protocol/PROTOCOL.md`) to the daemon, handshake included.

- It is a person row: it types into panes, and the daemon takes the hub as
  the person.
- The hub reads every text frame the phone sends and lets through only
  `hello`, `cancel`, `pane.list`, `pane.capture`, `pane.read`,
  `pane.subscribe`, `pane.unsubscribe`, `pane.resize`, `pane.send` and
  `ack`. Anything else closes the connection (1008). Answers go through the
  HTTP API, never this stream. A phone's `pane.resize` never reaches the
  daemon: the hub sends a `pane.capture` of the same pane with the same id
  instead, so the phone gets an answer and the pane keeps the Mac's size.
- Binary frames (input) pass as they are; the daemon tags them as the
  person's in the pane's input log. A `pane.send` from the phone board
  carries `by: "phone"` so its input is tagged the person's too (without
  it, the daemon tags it as the client that sent it).

## 7. The bridge between the page and the shell

The page talks to the shell with JSON messages over one channel named
`ravenryShell`: `WebViewCompat.addWebMessageListener` on Android,
restricted to the page's own origin (never `addJavascriptInterface`, which
every frame of every origin could call), and
`webkit.messageHandlers.ravenryShell` on iOS. Requests are
`{ "v": 1, "id": 7, "op": "...", ... }`; each gets one reply
`{ "id": 7, "ok": true, "result": ... }` or `{ "id": 7, "ok": false, "error": "..." }`.
The shell sends events as `{ "event": "...", ... }`.

| `op` | Fields | Result |
| --- | --- | --- |
| `hello` | | `{ v, platform, app, hub: { name, port }, device: { id, name }, features }` |
| `hub.call` | `method`, `path`, `body` | `{ status, body }` |
| `http` | `method`, `path`, `headers` (Content-Type, X-Filename, Accept), `b64` | the board's fetch: `{ status, type, b64 }`; a computer that does not answer: an error with the reach words, and the event `reach` |
| `reach.now`, `reach.retry` | | the last reason the computer did not answer (`{ reason, words }` or null); try again (the board reloads when it answers) |
| `open.tailscale` | | the Tailscale app, or its page in the store |
| `bars` | `light`, `color` | the system bars take the board's background and theme |
| `hub.events` | `on` | events `hub` `{ name, data }` and `link` `{ state: "up" \| "down", error }` |
| `conn.now`, `conn.reconnect` | | the connection now (`{ state: "up" \| "reconnecting" \| "offline", via: "wifi" \| "tailscale" \| "tailscale-mac" \| "local", since, rtt, reason, words, mac }`), and the event `conn` with the same each time it changes or is measured; reconnect from scratch (the stream reopened) |
| `ink.ready` | `x`, `y`, `w`, `h`, `dpr`, `dark` | the board's top bar is drawn: where its mark is (CSS px), for the launch's exit |
| `socket.open` | `path`, `protocol` | `{ sid }`; events `socket.message` `{ sid, text }` or `{ sid, b64 }`, `socket.close` `{ sid, code, reason }` |
| `socket.send` | `sid`, `text` or `b64` | |
| `socket.close` | `sid` | |
| `biometric` | `title`, `subtitle` | `{ ok }`, or an error the page shows |
| `photo` | `projectId` | the camera; the picture goes to the project's inbox (`POST /api/inbox/<project>`): `{ path, short, name, thumb }`, `thumb` a small JPEG data URL |
| `voice.start` | | recording starts |
| `voice.stop` | `projectId` | `{ path, short, name, ms }`, sent to the inbox the same way |
| `voice.cancel` | | |
| `secret.open` | `checkpoint`, `rect`, `dark`, `size` | the private field over `rect` (CSS px from the page's top left), transparent: the page draws the field around it, its count and its eye; `size` is the text's CSS px; events `secret.count` `{ n }`, `secret.done` `{ ok, error }` when the keyboard's Send sent it |
| `secret.move` | `rect`, `reveal` | the field follows the card when the page moves; `reveal` shows or hides what was typed |
| `secret.send` | | the shell answers the checkpoint with what was typed: `{ ok }` |
| `secret.close` | | |
| `speech` | | voice typing for the reply field: `{ text }` |
| `alerts.clear` | `id` | |
| `pair.reset` | | sign out on this phone: the pairing screen at once; the computer is told (`POST /api/phone/unpair` with the old token) in the background, again after 5 s doubling to 5 min and at each start of the app, until it answers |
| `push.status` | | `{ distributors, current, off }`: the UnifiedPush apps on the phone, the one in use, and whether alerts by push are off |
| `push.set` | `on` | alerts by push on (register with the distributor) or off (target `none`); the new status |
| `connection.get`, `connection.set` | `on` | the held connection (Stay connected) on or off: `{ on }` |
| `open.settings` | | the system's notification settings for the app |

Events also carry `open` `{ alert }` when the person taps an alert, and
`back` when they press Back (the page answers with `back.done` when it
handled it, one level up through the board's `window.ravenryBack`, else the
shell leaves: the app goes to the background as it is).

**The private keyboard.** A secret is typed in a native field the shell
lays over the card's field: password input, no suggestions, and
`IME_FLAG_NO_PERSONALIZED_LEARNING`, so the keyboard learns nothing and
keeps nothing. The page never sees the secret: on Send the shell answers
the checkpoint itself and forgets the text. Only the number of characters
goes to the page. On iOS, a secure `UITextField` does the same.

**Features** in `hello` say what this shell can do (`push`, `biometric`,
`photo`, `voice`, `speech`, `secret`), so the page hides what a shell
lacks. A browser running the phone board for development has none of
them.

## 8. Versions

- The pairing link: `v=1`. A link with a higher `v` asks to update the app.
- The push message: `v: 1`. An unknown `type` is ignored; an unknown
  `kind` shows its title and body with **Open** only.
- The bridge: `v: 1`. An unknown `op` is refused.
- The hub's phone API: `api: 1` in `/api/phone/hello` and
  `/api/phone/me`. A hub with a higher `api` still answers `api: 1` calls.

## 9. Android and iOS

| | Android (now) | iOS (next) |
| --- | --- | --- |
| The phone board | WebView, the bundle from the APK | WKWebView, the bundle from the app |
| Serving the page | `WebViewAssetLoader` at `appassets.androidplatform.net` | `WKURLSchemeHandler` for `ravenry-app:` |
| The bridge | `addWebMessageListener`, page origin only | `WKScriptMessageHandlerWithReply` |
| TLS with the pin | OkHttp, a trust manager that accepts only the pinned key | `URLSession` delegate, server trust checked against the pin |
| Device token | EncryptedSharedPreferences (Android Keystore) | Keychain, this device only |
| Pairing: QR | CameraX and ZXing | AVFoundation's QR reader |
| Pairing: typed code | the check number | the check number |
| Pairing: deep link | `ravenry://pair` | `ravenry://pair` |
| Pairing: found on this Wi-Fi | later | later |
| Push | UnifiedPush (ntfy or any distributor), RFC 8291 | APNs through the relay, decrypted in a Notification Service Extension |
| Push without a distributor | the connection held by a foreground service | the connection while the app is open |
| Alert buttons | notification actions | `UNNotificationCategory` actions |
| A pick's picture in the alert | `BigPictureStyle` with the image variants side by side in one picture, fetched over the pinned connection when the alert arrives | a `UNNotificationAttachment` the Notification Service Extension fetches over the pinned connection |
| A pick's region and note | the phone board's pick screen | the phone board's pick screen |
| Allow an agent to type into a pane | an action that opens BiometricPrompt, then answers | an action with `.authenticationRequired`, then Face ID in the app |
| Undo a saved decision | a notification action, for a minute | a notification action, for a minute |
| Reply line | `RemoteInput` | `UNTextInputNotificationAction` |
| Run from the shade | a small activity shows BiometricPrompt, then answers | an action with `.authenticationRequired`, then Face ID in the app |
| Secret | never in the shade; opens the app | never in the shade; opens the app |
| Fingerprint before Run | BiometricPrompt, `BIOMETRIC_STRONG` | LocalAuthentication, `deviceOwnerAuthenticationWithBiometrics` |
| Camera photo into a session | the camera app (`TakePicture`) | `UIImagePickerController` |
| Voice note into a session | `MediaRecorder`, AAC in .m4a | `AVAudioRecorder`, AAC in .m4a |
| Voice typing in the reply field | `RecognizerIntent` when the phone has one | `SFSpeechRecognizer` |
| Private keyboard | native field, no suggestions, no learning | secure `UITextField` |
| Screen kept from screenshots while a secret is typed | `FLAG_SECURE` (release builds) | the secure field |
| Connection status | the `connection` notification | none (iOS has no such notification) |
| Projects from every machine, Needs you first | the hub's board (chips, the machines line) | the hub's board |
| Live screen and key bar | the hub's board (text at the phone's width; the pane keeps the Mac's size) | the hub's board |
| Replies, answers, a checkpoint's card (ask, command) | the hub's board | the hub's board |
| New session | the hub's board (NewSession D) | the hub's board |
| Hand-off | the hub's board | the hub's board |
| A secret, a pick, a drive | the app's own screens (`apps/phone`) | the app's own screens |
| The sidebar's pages | the hub's board (Pages) | the hub's board |
| Store | F-Droid, then Play | App Store |
