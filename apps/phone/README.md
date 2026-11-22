# The phone app's pages

The phone app's home is the hub's own board at phone width (`hub/public`:
the approved phone designs PhoneProjects C, LiveScreen B, NewSession D and
the menu PhoneMenu A), which the Android and iPhone shells (`../android`,
`../ios`) load from the hub over the pinned connection (`../../docs/PHONE.md`, section 1). This
folder is what the app adds:

- `src/board.ts` (`board.js`, `board.css`): the app's layer, first in the
  board's page. The board's `fetch('/api/...')` and its event stream go
  through the shell; Run asks for a fingerprint first; a bar says why when
  the Mac does not answer (Tailscale off or missing, or the Mac), with Open
  or Get Tailscale; Back closes the full-screen live screen, a sheet or a
  page; the board's menu gets This phone; an alert tapped opens its
  checkpoint or its project; the agents' symbols in the live screen come
  from the glyph font (`src/glyphs.css`).
- The app's own screens (`index.html`, `app.js`, `app.css`), for what a
  page of the board cannot do:

Licence: GPL-3.0-only (../../LICENSING.md).

| Screen | |
| --- | --- |
| `#/cp/<checkpoint>` | a question, a command, a secret (the private keyboard), a pick (swipe, circle a part, a note) or a drive (an agent asks to type into, close, restart or change a pane), opened from its alert or its card on the board; the checkpoints' phone frames, A A A; Phase 2, 32c |
| `#/fb/<checkpoint>` | a photo and a voice note for it |
| `#/settings` | the app's settings: the computer, push, Stay connected, Sign out (from the board's menu, This phone) |

Anything else goes back to the board.

The pages open no connection of their own. Every hub request and the live
stream go through the shell (`src/shell.ts`, the bridge
of docs/PHONE.md section 7), which makes them over TLS with the pinned key
and the device token.

## The demo

For a phone with no Mac (docs/PHONE.md, The demo): `src/demo.ts` answers
the board from the recording in `src/demo/` (made by
`node tools/demo-sample.mjs`, again when the board's API changes), and
`build.mjs` copies the board's own page (`hub/public`) into `dist/board/`
at each build. `node tools/serve.mjs --demo` serves it as the shells do (no
hub); `node tools/demo-check.mjs` walks it in headless Chromium and
`node tools/demo-android.mjs` on a headless emulator.

## Build and look

```sh
npm install                          # at the repository root
node build.mjs [--out <dir>]         # index.html, app.js, app.css, board.js, board.css
npm test && npm run typecheck
```

In a browser, against a made-up board (never the real one on :4600):

```sh
node tools/demo.mjs --port 4791 &    # a hub on a throwaway HOME, real panes and checkpoints
node tools/serve.mjs --port 4681 --hub http://127.0.0.1:4791 &
node tools/preview.mjs http://127.0.0.1:4681/phone/ out /settings
```

The board itself is the hub's: open the demo hub's own page at phone
width (412 x 915) in a headless browser.

A browser has no shell: no push, fingerprint, camera, microphone or
private keyboard, so Run and the secret say they need the app.
`?features=photo,voice` draws those buttons for a picture.

On a headless emulator, dark and light: the pick's alert with its
pictures, the swipe screen, the circle and note, an HTML pick in its
sandboxed frame, and the drives' screens (close and type, with the agent's
words); then, as the person, the pick sent, a typing allowed with a
fingerprint (enrolled on the emulator first), a close refused, and Not now
and Undo tapped in the shade: `node tools/pick-shots.mjs <outDir>` after
building the debug APK. It starts its own read-only emulator and names it
on every adb command.
`tools/demo.mjs --phone` also turns phone access on for an emulator.

The app end to end, on a headless emulator, every step by touch and
checked where it lands: `node tools/phone-e2e.mjs <outDir>` after building
the debug APK (`RAVENRYD` names the daemon). A link whose only host is a
tailnet name that does not resolve gives the Tailscale words, never the
host; the real link pairs; chips swap the detail; the idle sheet opens a
project; a 140 x 40 pane's Live screen at the phone's width (a wrapped
paragraph joined, no sideways scroll), scrolled back by a touch drag, the
jump pill, typed text and the key bar reaching the pane, which stays
140 x 40 before, during (keyboard up) and after; a checkpoint answered in
its card; New session starting a real pane in the project's folder, shown
as Starting, and the Sessions card opening it; each bottom bar item, a
page and Back, the menu's theme; Sign out's tap-to-screen time and the
device revoked on the hub; pictures dark and light at 412 x 915.
`tools/demo.mjs --e2e` is its board: sessions in Ravenry panes, a
stand-in `claude`, and the 140 x 40 pane.
