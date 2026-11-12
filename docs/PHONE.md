# The phone apps

The contract between the hub, the phone apps (Android now, iOS next) and
the phone board they show. Decided once, before the code: what is written
here changes only with a new version number in the place that carries it
(the pairing link's `v`, the push message's `v`, the bridge's `v`, the
hub's `api`), and an old phone keeps working against a new hub.

## 1. What a phone app is

A thin native shell around one WebView. The **phone board** (the sessions,
the live terminal, the checkpoint screens, the sidebar's pages) is web
code, `apps/phone/`, shared by both shells and built from the desktop
app's own modules where they exist (the sidebar's groups from
`apps/desktop/src/renderer/model.ts`, checkpoints from `checkpoints.ts`,
pages from `pages.ts`, the terminal through `@ravenry/client` and
xterm.js). The shell ships that bundle inside the app and adds only what a
page cannot do:

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
pinned one. The page is served from the app itself
(`https://appassets.androidplatform.net/phone/` on Android,
`ravenry-app://phone/` on iOS); a picture or file of the hub is
`hub/<path>` relative to the page, which the shell fetches the same way,
for the page itself only (its own Referer and Origin), never for a frame
of another origin.

## 2. Reaching the hub

**Phone access** is a switch on the computer, off until the person turns
it on (pairing turns it on). While it is on, the hub listens with TLS on
the **phone port** (`RAVENRY_PHONE_PORT`, default the board's port plus
one: 4601) and takes connections that arrive on:

- a private LAN address of this machine (10/8, 172.16/12, 192.168/16): the
  home Wi-Fi;
- a Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48): away from home
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
  HTTP API, never this stream.
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
| `hub.events` | `on` | events `hub` `{ name, data }` and `link` `{ state: "up" \| "down", error }` |
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
| `pair.reset` | | sign out on this phone and go back to pairing |
| `push.status` | | `{ distributors, current, off }`: the UnifiedPush apps on the phone, the one in use, and whether alerts by push are off |
| `push.set` | `on` | alerts by push on (register with the distributor) or off (target `none`); the new status |
| `connection.get`, `connection.set` | `on` | the held connection (Stay connected) on or off: `{ on }` |
| `open.settings` | | the system's notification settings for the app |

Events also carry `open` `{ alert }` when the person taps an alert, and
`back` when they press Back (the page answers with `back.done` when it
handled it, else the shell leaves).

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
| Sessions from every machine, Needs you first | the phone board | the phone board |
| Live terminal and key bar | the phone board (xterm.js) | the phone board |
| Replies and menu answers | the phone board | the phone board |
| Hand-off | the phone board | the phone board |
| The checkpoint screens | the phone board | the phone board |
| The sidebar's pages | the phone board (the desktop's pages code) | the phone board |
| Store | F-Droid, then Play | App Store |
