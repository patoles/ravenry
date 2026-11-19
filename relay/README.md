# The Ravenry relay

One Cloudflare Worker that hands sealed alerts to Apple's push service
(APNs) for the Ravenry iPhone and iPad app. Android needs no relay (its
alerts go through UnifiedPush); an iPhone cannot be reached any other way
while the app is closed, and only the holder of the app's APNs key can
send to it. The design is docs/PHONE.md section 4, "apns".

```
 the hub (your Mac)              the relay (this)                 APNs        the device
 encrypts the alert for   POST   signs a provider token,  HTTP/2  delivers    the Notification Service
 the device (RFC 8291) -------> posts the placeholder + -------> --------->  Extension opens it with the
 { token, body, ... }   /v1/apns the sealed bytes                             device's key, draws the alert
```

## What it sees, and keeps

It sees, per alert: the device token (which app install to wake), the
environment, the size and time, the sealed bytes (it cannot open them:
only the device holds the key), and the caller's network address, as any
server does. It keeps none of it:

- no storage binding (no KV, D1, R2, Durable Objects);
- no logs: observability (Workers Logs, traces) and Logpush are off in
  `wrangler.jsonc`, and the code never writes a request to the console
  (`test/relay-test.mjs` checks that nothing reaches it);
- the only state is the provider token it signs (module memory, made again
  every 40 minutes) and the rate limits' counters below.

## The route

`POST /v1/apns`, JSON, at most 8 KB:

| Field | | |
| --- | --- | --- |
| `token` | required | the APNs device token, hex, 64 to 200 characters |
| `body` | required | the sealed alert in base64url: an aes128gcm message (RFC 8188) for a P-256 key (RFC 8291), 103 to 2900 bytes |
| `environment` | `production` | `production` (TestFlight, the App Store) or `sandbox` (a debug build from Xcode) |
| `push` | `alert` | `alert`, or `background` for a close (a silent push, priority 5) |
| `ttl` | 3600 | seconds APNs keeps it while the device is off, 0 to a week |
| `collapse` | none | `apns-collapse-id`: at most 64 letters, digits, `-` or `_` |

Answers: 200 `{ ok: true }`; 410 the app is gone from that device (the hub
drops it); 400 a request it refuses, or a token APNs refuses (with APNs'
`reason`); 413 too big; 429 too many (`Retry-After: 60`); 502 APNs did not
take it (try again later); 503 the relay has no key set up. `GET /` says
what it is.

## Abuse

A public relay can be called by anyone, so it only ever does one fixed
thing, and nothing a caller sends can become words on someone's screen:

- **No free text is ever shown.** APNs gets the fixed placeholder (title
  "Ravenry", body "Open Ravenry to see this alert.") and the sealed bytes
  as `e`. The extension replaces the placeholder with what it decrypts; if
  it cannot (bytes not made for this device), the placeholder is all that
  shows. `body` must have the shape of an aes128gcm message for a P-256
  key, so a caller cannot even pass plain words through as the "sealed"
  part. A close is a silent push with no alert at all.
- **Not an open proxy.** It only calls APNs, at a fixed host, for one app
  (`APNS_TOPIC`, dev.ravenry.ios); the token must be hex, so it cannot
  name another path or host.
- **Size.** 8 KB a request, 2900 bytes of sealed body, so the payload is
  always within APNs' 4096.
- **Rate limits** (cheap: the Workers rate limiting binding, no storage):
  60 requests a minute per device token and 300 per network address, per
  Cloudflare location, keyed by a hash of each, the counters held in
  Cloudflare's memory for the minute only. The hub sends one request per
  alert per phone, so a person never comes near either.
- **Who can reach a device at all.** Only a caller who has that device's
  token, which only the person's own hub gets (from the app, over the
  paired connection). A stranger with a guessed token gets APNs' 400.
- What it does not do: accounts or a shared secret. A secret built into
  every hub would be public the day the source is, and it would stop no
  one; the limits above are what bound the cost.

## Set up and deploy

The account-specific values are never in the repository:

- `APNS_KEY`: the contents of the `.p8` APNs auth key file (Sandbox &
  Production), a Worker secret;
- `APNS_KEY_ID`: its key id, a Worker secret;
- `APNS_TEAM_ID`: the Apple team id, a Worker secret.

```
cd relay
npx wrangler@4 secret put APNS_KEY < /path/to/AuthKey_XXXXXXXXXX.p8
npx wrangler@4 secret put APNS_KEY_ID
npx wrangler@4 secret put APNS_TEAM_ID
npx wrangler@4 deploy
```

The relay's address goes into the iPhone app's build (it sends it to the
hub as `relay` with its token), from a value outside the repository
(apps/ios/README.md): a `*.workers.dev` address names the Cloudflare
account, so it is not written here. A custom domain (a route in
`wrangler.jsonc`) can be written in the repository and the app.

## Run it here

`npm test` (`node test/relay-test.mjs`): the relay in Node against a
stand-in APNs on 127.0.0.1, with an APNs key made for the run; nothing
goes to Apple. `hub/tools/iphone-apns-test.mjs` runs it between the hub's
sender and a stand-in APNs that opens each alert with the device's key.

`npx wrangler@4 dev` runs it in workerd. It reads the secrets from
`.dev.vars` (git ignores it), and `APNS_ORIGIN=http://127.0.0.1:PORT`
there sends to a stand-in APNs instead of Apple's (production never sets
it).

## Your own relay

The relay can only send to an app whose APNs key it holds, so another
relay is for another build of the app (its own bundle id and key): set
`APNS_TOPIC` in `wrangler.jsonc` to that bundle id, put that key in the
secrets, deploy, and build the app with that relay's address. A hub sends
to whatever relay the app names; for an app that names none it uses
`RAVENRY_APNS_RELAY` (an environment variable of the hub).
