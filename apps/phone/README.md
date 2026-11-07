# The phone board

The web code the phone apps show: the Android shell (`../android`) ships it
inside the app, and the iOS shell will too (`../../docs/PHONE.md`). It is
built from the desktop app's own modules where they exist: the sidebar's
groups (`model.ts`), what a checkpoint says (`checkpoints.ts`), the pages
(`pages.ts`, with the desktop's stylesheet nested under `.pgx`) and the
terminal (`terminal.ts`, xterm.js on `@ravenry/client`).

Licence: GPL-3.0-only (../../LICENSING.md).

| Screen | | Picture |
| --- | --- | --- |
| `#/` | the sessions from every machine, Needs you first | Android 2 |
| `#/s/<session>` | a session live: terminal, answers, key bar, reply, Hand off | Android 3 |
| `#/cp/<checkpoint>` | a question, a command, a secret, a pick (swipe, circle a part, a note) or a drive (an agent asks to type into, close, restart or change a pane) | the checkpoints' phone frames, A A A; Phase 2, 32c |
| `#/fb/<checkpoint>` | a photo and a voice note for it | Android 6 |
| `#/p/<page>`, `#/pages` | the sidebar's pages | the pages' phone frame 6b |

The page opens no connection of its own. Every hub request, the live
stream and the terminal go through the shell (`src/shell.ts`, the bridge
of docs/PHONE.md section 7), which makes them over TLS with the pinned key
and the device token.

## Build and look

```sh
npm install                          # at the repository root
node build.mjs [--out <dir>]         # index.html, app.js, app.css
npm test && npm run typecheck
```

In a browser, against a made-up board (never the real one on :4600):

```sh
node tools/demo.mjs --port 4791 &    # a hub on a throwaway HOME, real panes and checkpoints
node tools/serve.mjs --port 4681 --hub http://127.0.0.1:4791 &
node tools/preview.mjs http://127.0.0.1:4681/phone/ out / /pages
```

A browser has no shell: no push, fingerprint, camera, microphone or
private keyboard, so Run and the secret say they need the app.
`?features=photo,voice` draws those buttons for a picture.

On a headless emulator, the pick end to end (the alert with its pictures,
the swipe screen, the circle and note, a drive's screen), dark and light:
`node tools/pick-shots.mjs <outDir>` after building the debug APK; it
starts its own read-only emulator and names it on every adb command.
`tools/demo.mjs --phone` also turns phone access on for an emulator.
