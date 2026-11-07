# Ravenry desktop app

The Electron window: the board in a sidebar (what needs you first), real
terminals in the middle, and the session panel on the right. It ships as a
DMG for macOS (Apple silicon and Intel) and as an AppImage and a .deb for
Linux (x64 and arm64), with ravenryd and the hub inside.

It holds no terminals itself. Sessions live in `ravenryd` (../../daemon), so
they survive the window closing, restarting or updating. The window talks
to the daemon over protocol v1 (../../packages/protocol) through
`@ravenry/client` (../../packages/client), and reads sessions from the hub
(../../hub).

Licence: GPL-3.0-only (../../LICENSING.md).

## Run it

```sh
npm install                      # at the repository root
cd daemon && make && cd ..       # ravenryd (daemon/README.md)
npm run desktop                  # builds dist/ and opens the window
```

The app finds the newest running daemon (PROTOCOL.md section 9) and starts
`ravenryd serve --detach` when none runs: `RAVENRYD`, else the one shipped
in the app, else `daemon/ravenryd` in this repository, else the `PATH`. The
board comes from the hub the running board wrote to `~/.ravenry/board.json`
(`RAVENRY_HUB_URL` overrides it). The top of src/main/main.ts lists every
setting.

## How it is built

- **Electron 45.2.2, pinned exactly.** 45.2.3 draws xterm.js's WebGL text
  tiny (xterm.js #6297, electron/electron#55616). Check a screenshot on every
  Electron bump.
- **xterm.js 6 with the WebGL addon**, one instance for the pane on screen.
  Tabs that are not on screen run no xterm.js at all: the daemon keeps their
  screens, and showing one subscribes again, which starts with a fresh
  snapshot.
- **The daemon answers terminal queries**, so xterm.js must not: its query
  replies are swallowed (`suppressTerminalQueries` in @ravenry/client).
- **Acks:** each frame is acknowledged in xterm.js's write callback, so the
  daemon bundles output by backlog and a slow window never slows a pane.
- **Paste** goes to the daemon as one paste (`pane.send`, mode `paste`): it
  is bracketed when the program asked for it, and unsafe control
  characters are made harmless.
- **The page is sandboxed.** It reaches the daemon through a MessagePort
  that the main process pipes to the daemon's unix socket, and the hub
  through the main process.

## Pages

The rows under the sessions are pages: page files the hub reads
(../../hub/docs/PAGES.md, the format in ../../packages/page-format). The
shipped five come first, then a line, then pages you or an agent added, and
a project's own with its name in grey; a new one is lit for a few seconds,
and one whose file has a mistake carries a red dot. A page opens in the
middle and right columns (`src/renderer/pages.ts`); picking a session brings
the terminal back.

- **Every view and slot of the format:** list, cards, board (dragging a card
  sets its field; below about 240 px a lane it becomes a list grouped by
  lane, the last one folded), table, stats and document; title, subtitle,
  badges, progress, picture (only from the page's folder, through the hub),
  time, checklist, excerpt, and Ravenry's own pieces (hub/docs/PAGES.md).
- **A mistake** keeps the last good version under a bar with the problem's
  line, Open file and Ask Claude to fix (typed into a session, never sent).
- **A project's page** is read-only, with what each button would do, until
  you trust it.
- **Customize** copies a shipped page to `~/.ravenry/pages/` and opens it;
  when the shipped one changes later, one quiet line says so, with See what
  changed and Ask Claude to bring these in.
- **Buttons** do only what the format allows; a run is an approval card in
  the panel, with the item's values shown as variables.

Opening a file, a link or the clipboard goes to your own apps; offscreen
(tests) nothing opens and each is written to `RAVENRY_OPEN_LOG`.

## Checkpoints

When an agent runs `ravenry ask`, `ravenry approve` or `ravenry secret`
(packages/protocol/PROTOCOL.md section 4), its session's row in the sidebar
gets a mark (a speech bubble with the question, a prompt box with the
command, a key with the secret's name) and moves to Needs you, its tab gets
the Needs you dot, and a card opens at the top of the session panel (over
the terminal on a narrow window):

- **A question:** one answer per line, picked with the mouse or the 1 to 9
  keys, and a field for an answer in your own words (Enter sends it).
- **A command:** the exact command, then its folder, machine and pane on
  lines of their own, a warning when it can't be undone, then the agent's
  words, marked as its own. `Run on <machine>`, Edit (the command becomes a
  field and what changed is tinted) or Refuse.
- **A secret:** what it is for and the exact command it goes to, a masked
  field with a character count, and Send to the terminal or Not now.

Once answered, the card says how it went until the session moves on. The
window hears of checkpoints from the daemons it holds and from the hub (every
machine's), and answers through the daemon when it holds it, else the hub.
Only the person may answer: a window started from inside a pane shows the
cards with their buttons off and says so.

**The secret stays in its field.** It is never in the window's state, a log
or an error: the field is emptied when it loses the focus, when its card
leaves the panel or the panel closes, and as it is sent, in the one answer
call. The daemon masks it in the pane's output from then on.

**Running an edited command needs the back end.** Protocol v1's
`checkpoint.answer` approves the command as proposed only. The app sends an
edited one as `approve` with `command`, which today's daemons refuse (and the
hub would drop), so Run edited command says it can't yet.

## Who drives a pane, and what it shows

The Phase 2 screens (the picks of the design notes' frames 6, 16, 19, 31,
32 and 33), over ravenryd's per-pane permissions, input log, leases, files
and filmstrips (PROTOCOL.md section 4) and the hub's ledger, worktrees and
picks:

- **An agent asks to act on a pane it did not start** (a `drive`
  checkpoint): the card says the action in its title and buttons ("Claude
  wants to close", Let it close; "Let it type in dev server?", what it would
  press in order, Let it type this, Let it use this pane until its session
  ends, Refuse, or a word for it), with the pane and the asking session by
  the names the window shows. The row in the sidebar says "Wants to type in
  dev server".
- **What an agent typed is marked where it shows** (`marks.ts`): its exact
  keys are tinted in its colour in the terminal, with its name and the time
  (and "you let it once") at the end of the line; the person's typing stays
  plain and nothing moves. A shell's panel says who opened it, **Who can
  type here** (you always; an agent asks each time, or can type until its
  session ends, which the person takes back there) and **Typed here**, the
  pane's input log, filtered by All, Agents and You.
- **A lent pane** (an agent holds its lease) has a strip across its top:
  who has it since when, who waits, **Hand it to ...** and **Take it back**;
  its tab carries the holder's name, and the sidebar says "Using dev
  server" and "Waiting for dev server, Claude has it". A session's panel
  lists **Panes it uses** and **Files it changed**, with a file another
  session changed too in orange, and **See all** opens the project's grid.
- **The filmstrip** (the film button in the tab strip): a sheet under the
  pane with its last 20 seconds, frames along a track, the blank, half drawn
  and stalled ones marked, step and play, Send to the agent that owns the
  pane, and Save as GIF; a clicked frame fills the pane under a "Showing"
  strip until Back to live.
- **Decisions** (a row under the pages): the ledger newest first, a
  decision that replaced another with the old one crossed out, how often
  agents read each, and a toast with Undo and Show when an agent saves one.
  A question's card says what the agent checked first.
- **A pick**: its card in the panel, and side by side in the middle, with
  Circle a part (a ring and its note), anything else for the agent, None of
  these and Send B, with 1 note.
- **A new session where another one works** gets its own copy of the code
  and the start screen says why in one line, with Work in the folder
  instead. A worktree session gets a **Review** tab beside its terminal
  (files, diff, line comments sent together, Merge into main), a card when
  it is done ("Done. 3 files to review" in the sidebar) and, after the
  merge, Undo the merge and Delete the branch.

## The back end it uses

- **Plain shells** are panes labelled `ravenry.kind: shell` (and
  `ravenry.agent` for an assistant started without a board), listed on every
  running daemon at launch. window.json keeps only pinned sessions, the tabs'
  order and the panel's state; an older window.json's list of shells is
  turned into labels once.
- **Tabs follow `cd`** through `pane.cwd`, and a tab not on screen that
  printed gets a quiet dot through `pane.activity`.
- **Start** asks the hub (`POST /api/sessions/start`) so the session gets its
  hooks, brief and hand-off and shows in the sidebar; with no board it opens
  the assistant in a pane of the app's own.
- **Hook setup:** when the hub's dry run (`POST /api/setup/hooks`) says
  Claude Code's or Codex's settings would change, the start screen asks once,
  in a sentence that names the files, with Skip. The hooks point at
  `<data>/bin/ravenryd` (development: `RAVENRYD`).
- **Machines:** a remote session or checkpoint carries the hub's `machine`.

## What the packaged app installs

Nothing outside the user's own folders, and nothing as root.

- **Its version of ravenryd and the hub, copied out of the app** on
  launch to `versions/<version>/` in the data folder
  (`~/Library/Application Support/Ravenry` on macOS,
  `~/.local/share/ravenry` on Linux), with `bin/ravenryd` and `bin/ravenry`
  linking to the newest. Daemons and the hub run from that copy, so
  replacing the app
  (an update, an AppImage unmounting) never pulls a running binary away. A
  version folder goes once nothing runs from it.
- **The hub as a user service**, always on, so alerts reach the phone with
  the window closed: a launchd agent (`~/Library/LaunchAgents/dev.ravenry.hub.plist`)
  or a systemd user unit (`~/.config/systemd/user/dev.ravenry.hub.service`). It
  runs the app's own executable as Node (`ELECTRON_RUN_AS_NODE=1`), so no
  Node is needed, on the copied hub, in Ravenry terminal mode. An AppImage
  runs from a folder it mounts only while it runs, and its launcher adds
  `--no-sandbox`, which Node refuses, so its hub runs a copy of the
  Electron runtime kept in `versions/<version>/runtime`. Written on
  first launch, rewritten and restarted when the app changes. While the
  npm board is here (below), nothing is installed and the app shows that
  board. `RAVENRY_SERVICE=off` turns it off; `dry-run` writes the file and
  runs no launchctl or systemctl.

## Switching from the npm board

A person who runs the board from npm (`ravenry`, ravenry-app 0.4.x) keeps
everything in the same `~/.ravenry`. The app's hub never runs beside it on
that data: both rewrite the same JSON files with no lock, and the hub's
one-time move of ideas.json leaves the npm board writing a file nothing
reads (`hub/server/npmswitch.mjs` says why in full). So at launch the app
asks the hub script what of the npm board is here: a board serving the
data (its board.json, else :4600, checked by its projects.json), a login
start (a LaunchAgent that runs it), and its hooks in Claude Code's and
Codex's settings. While there is any, it installs no hub and offers the
switch, full size the first time, then as a quiet bar after Not now.

The person agrees once. The switch turns each login start off (booted
out, its file kept in the backup), stops the board, keeps a copy of the
data and the hook settings in `~/.ravenry/backups/switch-<when>/`, moves
the hooks to the app's copy with `ravenryd hook` beside them, records all
of it in `~/.ravenry/switch.json`, and starts the app's hub on the same
port. That hub then runs its one-time moves (each backed up, each safe to
run twice). Ravenry > Go Back to the npm Board undoes it: the app's hub
stops and its service goes, ideas.json is written again from
`pages/ideas/`, the hooks are the npm board's exact commands again, and a
login start is put back and loaded, which starts the board. A board that
was started by hand is left to start as before; the bar says the command.

The screen is a plain placeholder for now (`src/renderer/npmswitch.ts`).
`node tools/npm-switch-test.mjs release/mac-arm64/Ravenry.app OUT` proves
the switch and the way back on macOS with the real npm board 0.4.0
installed from npm, run in throwaway HOMEs on spare ports, with
`tools/fake-launchctl.mjs` in place of launchd.

## Updates

From the GitHub Releases of this repository (electron-updater). macOS and
the AppImage download a new version in the background and install it when
the app quits, or at once from the menu (Ravenry > Check for Updates on
macOS, Help on Linux). A .deb does not update itself and says so there.
A Mac update needs a signed app: an unsigned build cannot update.

**An update never ends a session.** Sessions live in ravenryd, not in the
app. On the next launch the new version's ravenryd starts beside the old
one: new panes go to it, and the old one keeps its panes and exits once
they end (../../packages/protocol/PROTOCOL.md section 9). The hub service is
restarted onto the new version; ravenryd runs in its own process session
and the service leaves it alone (`AbandonProcessGroup`, `KillMode=process`).

## Packaging

```sh
npm run pack                          # this machine: DMG and zip, or AppImage and .deb
npm run pack -- --dir                 # the unpacked app only
npm run pack -- --mac --arch arm64,x64 --ravenryd DIR   # ravenryd-<platform>-<arch> from DIR
node tools/package-check.mjs release/Ravenry-<version>-mac-arm64.dmg
```

`scripts/pack.mjs` stages ravenryd (built here by
`scripts/build-ravenryd.sh` when it is for this machine: static on Linux,
macOS 13 or newer on the Mac, the app's version), the hub and
`build.json`, then runs electron-builder (`electron-builder.config.mjs`).
`tools/package-check.mjs` checks a DMG, zip, AppImage, .deb or unpacked
app: what is inside, then the app offscreen beside an older ravenryd, the
hub service in dry-run mode in a throwaway HOME, and the hub run as that
service says. CI's release workflow (`.github/workflows/release.yml`)
builds every target on a machine of its own, checks every artifact and,
on a `v*` tag, uploads them to a draft release, never published by CI.

**The first run, timed.** `node tools/first-run.mjs APP [OUT] [--runs N]`
opens a packaged app for the first time in a fresh throwaway HOME (a
project in ~/code and a stand-in Claude Code, `tools/stand-in-claude.sh`,
in ~/.local/bin, off the PATH as for an app started from the Finder),
starts the hub as its written service says the moment it appears, and
times the window, the first prompt of a new shell, and Start Claude on
the first-launch screen (hook offer accepted) until the session is in the
sidebar. It fails over 30 s (`--budget`); CI runs it on the Linux package.

**Signing (macOS).** With a Developer ID certificate (`CSC_LINK`,
`CSC_KEY_PASSWORD`) the app is signed with the hardened runtime, and with
an App Store Connect API key (`APPLE_API_KEY` as the .p8's path,
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) or an Apple ID (`APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) it is notarized. Without a
certificate it is signed ad hoc and the build says UNSIGNED loudly: it
runs on the machine that built it, macOS blocks it after a download, and
it cannot update itself. No keychain is ever searched for an identity.

## Layout

| Path | |
| --- | --- |
| `src/main/` | The main process: the window and menu, the daemon pipe, the hub feed, first-launch lookups. |
| `src/preload/` | The page's only door to the main process. |
| `src/renderer/` | The page: sidebar, tabs, terminal, panel, first launch. `model.ts` turns the hub's state into the sidebar (tested without a window). |
| `test/` | Unit tests (`npm test`). |
| `tools/` | The end-to-end smoke test, the packaged app's check, screenshots and the echo measurement, all offscreen. |
| `scripts/` | Packaging: `pack.mjs`, `build-ravenryd.sh`. |
| `build/` | electron-builder's resources (the Mac entitlements). |

## Shortcuts

| macOS | Linux | |
| --- | --- | --- |
| ⌘T | Ctrl+Shift+T | New shell |
| ⌘N | Ctrl+Shift+N | New session |
| ⌘W | Ctrl+Shift+W | Close the tab (ends the shell and everything it started) |
| ⌘1 to ⌘9 | Alt+1 to Alt+9 | Go to a tab |
| Ctrl+Tab, ⌘⇧] | Ctrl+Tab | Next tab |
| ⌘⌥B | Ctrl+Shift+B | Show or hide the session panel |
| ⌘C, ⌘V | Ctrl+Shift+C, Ctrl+Shift+V | Copy, paste |

## Checks

```sh
npm run typecheck && npm test
RAVENRYD=../../daemon/ravenryd npm run smoke          # the app end to end, offscreen
RAVENRYD=../../daemon/ravenryd npm run shots -- out   # screenshots and keystroke echo
RAVENRYD=../../daemon/ravenryd node tools/checkpoint-shots.mjs out   # the checkpoint cards, from real checkpoints
RAVENRYD=<new build> RAVENRYD_OLD=<older build> node tools/machines-shots.mjs out   # the Machines page, from real installs behind a fake ssh
RAVENRYD=../../daemon/ravenryd node tools/pages-test.mjs out [light|dark]   # the pages, end to end, and every frame of their picture
RAVENRYD=../../daemon/ravenryd node tools/phase2-shots.mjs out   # the Phase 2 screens in dark and light, from stand-in agents in real panes
```

The smoke test and the screenshots never put a window on screen: the
window renders offscreen and is captured. They run with a throwaway HOME,
app data folder and daemon runtime folder, and the screenshots use a demo
board (`tools/demo-hub.mjs`) whose projects are made up.
