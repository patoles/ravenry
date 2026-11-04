# Developing Ravenry

The developer's guide: how the board works and how to run it from this
checkout. The user's guide, shipped in the npm package, is
[README.md](../README.md); [PUBLISHING.md](PUBLISHING.md) says what the
package holds and how to check it before a release.

A local board for following every Claude Code session running in cmux or
iTerm2 (and, watch only, in any other terminal): which project needs you,
which is working, how full each context is, and a composer to answer an
agent (with files) without hunting for its tab.

```sh
npm start            # http://localhost:4600
npm run iterm        # the board in an iTerm2 tab: its page above, npm start below
node bin/ravenry.mjs setup|doctor|uninstall   # the package's command, from this checkout
```

Ravenry was called Mission Control until 2026-11-03 (renamed because macOS
already has a famous Mission Control). Its data lives in `~/.ravenry`
(`RAVENRY_HOME` overrides it; `MC_HOME`, the old name, still works, and a
Mac that only has the old `~/.mission-control` keeps using it). The hooks
and the board still recognise the old `[mission-control hand-off]` tag in
transcripts and the old `X-Mission-Control` write header, and
`tools/install-hook.mjs` rewrites hook entries that point at the old
`mission-control/hooks/` path. The other `MC_*` env names keep their names.

The public repository is a snapshot of the maintainer's private one, made
by `node tools/export-public.mjs` (Tools, below; docs/PUBLISHING.md). It
leaves out the design mockups (`docs/design/*.dc.html`, which code comments
and this guide name: they were drawn from a real board's data), screenshots
(`docs/shots/`), captured screens of real sessions (`tools/fixtures/live/`),
the logo rounds (`brand/candidates/`) and `tools/phase-d-e2e.mjs` (it needs
a real cmux and real Claude memory folders). Tests that use the captured
screens or old commits skip those checks where they are absent.

Node 22, no runtime npm dependencies (the QR encoder, uqr 0.1.2, is vendored
in `server/vendor/`). Playwright and jsQR are dev dependencies, used by the
headless test and screenshot tools. The board loads Playwright lazily, only
to draw idea mockup pictures, and runs without it (the round then says how to
install it).

- `server/assistant.mjs` is the one assistant interface, beside the
  terminal one: everything particular to Claude Code or OpenAI Codex (the
  screen, the prompt, transcripts, how a reply is typed, menus, the rules
  file, what the board can show) goes through it to an adapter,
  `server/claude.mjs` (whose parts are `server/screen.mjs`,
  `server/suggestion.mjs`, `server/transcript.mjs`, `server/tasks.mjs`) or
  `server/codex.mjs` (with `server/codexrollout.mjs` for its transcripts and
  `server/codexhooks.mjs` for its hooks.json and trust entries). Sessions
  carry `assistant` from the events hook (`--assistant=codex` in Codex's
  hook commands); none is Claude Code. New project, Revive and New session
  start the assistant `startWith` (registry settings) or the project names,
  and Plans and Ideas run `claude -p` or `codex exec` by the same setting.
  [docs/ASSISTANTS.md](ASSISTANTS.md) has the interface, what works for
  each, Codex's events, screen and transcript, the hand-off, starting
  sessions, print mode and the install.
- `server/terminal.mjs` is the one terminal interface: every read, text,
  key, focus, new tab and close goes through it to an adapter,
  `server/cmux.mjs` (the only module that runs the cmux CLI) or
  `server/iterm.mjs` (the only one that talks to iTerm2, through AppleScript
  and, for the arrow keys, its Python API). The events hook records which
  terminal each session runs in; a session in any other terminal is watch
  only, and its controls say why. [docs/TERMINALS.md](TERMINALS.md)
  has the operations, the detection, the iTerm2 setup (`node
  tools/install-iterm.mjs` once, the Python API on in iTerm2) and
  Terminal.app as the next adapter.
- `~/.ravenry/projects.json` maps projects to cmux workspace UUIDs.
  It is created from cmux on first run and never rewritten after that, except
  to append workspaces it has not seen. Edit it freely: rename projects, merge
  workspaces into one project, set `brief`, `waitingOn`, or `hidden`.
  A project is a real folder, not a workspace: when one workspace's tabs work
  in different repos, each repo is its own project listing the same
  workspace, and `surfaces` (cmux surface ids) pins a tab to a project. A tab
  no project names goes to the project of the repo its tool calls work in,
  else to the workspace's home project (the one that names none of its tabs).
  See docs/STATE-RULES.md, "Which project a tab is in". `main: true` marks the
  project that owns a shared folder's plan files.
- How states are decided: [docs/STATE-RULES.md](STATE-RULES.md). Hook
  events first: the board's own Claude Code hook (`hooks/events.mjs`, not
  Agent Flow's) records SessionStart, SessionEnd, UserPromptSubmit,
  Notification and Stop per session in `~/.ravenry/events/`; the
  screen is read for sessions with no events. Each sheet says which one
  decided its state.
- The brief format: [docs/BRIEF-FORMAT.md](BRIEF-FORMAT.md), with an
  example in [docs/BRIEF.example.md](BRIEF.example.md).
- `ignoreWorkspaces` (registry root, cmux workspace UUIDs) lists workspaces
  that are not projects and are never auto-imported, such as the
  "Ravenry" workspace that shows this board in a cmux browser pane.
- The accepted design this ports: [docs/design/Main.dc.html](design/Main.dc.html).
- Memory and closing idle sessions: [docs/SESSIONS.md](SESSIONS.md).
  The top bar shows what every claude and codex process holds ("Sessions
  10.2 GB | 14 idle"); it opens the Sessions page, which closes the ticked idle
  sessions through cmux or iTerm2 and can reopen them for 14 days.

## Open on your phone

The phone button in the top bar (the Mac only) drops a card with a QR code.
A phone on the same Wi-Fi scans it and gets the whole board, live, and can
answer agents like the Mac. Design: [docs/design/PhoneQR.dc.html](design/PhoneQR.dc.html), variant A.

At phone width the Projects view shows the projects that need you, are
working or wait on others as chips above the selected project's detail, and
the idle ones behind an "N idle" chip that opens them in a sheet. Design:
[docs/design/PhoneProjects.dc.html](design/PhoneProjects.dc.html), variant C.

- The board listens on every interface, but answers only to a Host of
  `localhost`, `127.0.0.1`, `[::1]` or one of the Mac's current private LAN
  IPv4 addresses with its port; anything else gets 421 (no DNS rebinding).
- The Mac itself (loopback) needs no key. Every other request, page, file,
  API or live stream, needs a phone cookie or gets 401.
- The QR code is `http://<Wi-Fi address>:<port>/?k=<key>`. The key is 32
  random bytes in `~/.ravenry/phone.json` (mode 0600), made on first
  use. A matching key gives the phone its own token as an HttpOnly,
  SameSite=Strict cookie for a year and redirects to `/`, so the key leaves
  the address bar. phone.json keeps a hash of each token with its user agent
  and when it was made and last seen; the card counts them.
- New key (Mac only) makes a new key and forgets every phone; their open
  pages turn into "Signed out. Scan the code on the Mac again." The card,
  the key and New key are never served to a phone.
- With no private Wi-Fi address (en0 first) the card says the Mac is not on
  Wi-Fi.
- The first time the board listens beyond loopback, the macOS firewall may
  ask once whether node may accept incoming connections. Allow it, or phones
  cannot reach the board.

## The Live screen

Each project page shows its session's terminal, trimmed, so you can follow
what is happening ([docs/design/LiveScreen.dc.html](design/LiveScreen.dc.html),
variant B, with a shorter default height).

- Desktop: the first card of the right column, about 18 lines tall; the
  right column (the card, the project picture and the notes) is pinned as
  one piece while the left column scrolls, so nothing in it slides under
  the card. A column taller than the window moves with the page until its
  foot is in view, and back until its top is, scrolling up. The two
  columns split evenly (about 70 characters a line). Phone: the title, the
  folder and stage line and the hand-off details come first, as on
  desktop, then the card right above the answer card ("Doing now" and the
  composer) it goes with, about 14 lines; a tap opens full screen.
- Full screen (the expand button, or a tap on the phone): the terminal at
  about 125 characters a line with the project's composer under it, the
  same composer, moved. Esc, Exit full screen or Back closes it.
- It follows the bottom as lines arrive. Scrolled up, it stops following
  and a "N new lines, jump to latest" pill counts what arrived.
- The dot under the title: "Live, read N s ago" under 5 s, orange "Slow"
  from 5 to 30 s, red "Not updating" past 30 s (text dimmed to 60%), from
  the time of the server's last good read and the server's clock.
- The status row at its foot: the session's state, then the spinner's words
  or "N background agents", or the last done line, and each agent's task
  and time.
- Trimming (`trimScreen` in `server/screen.mjs`): Claude Code's prompt box
  and everything under it (mode line, footer, agent list), folded tool
  groups such as "Read 1 file (ctrl+o to expand)", "Message from" notices,
  spinner lines and Claude Code's notes under tool output are removed; each
  tool call is one dim line with its output's line count; a run of the same
  background notice ("Agent "X" is waiting on its own background work",
  times aside, blank lines between) is one line with "×N" at its end, the
  text cut before the count on a narrow card (`foldNotices`); lines Claude Code
  wrapped at the terminal width are joined again and wrap to the card;
  tables keep their drawing and scroll sideways. A screen with no Claude
  shows verbatim.
- Server: a page asks `GET /api/live?surface=<id>[&v=<version>]` after each
  snapshot; that surface is then read with 200 lines of scrollback each tick
  (other tabs keep the 40-line read), and an unchanged screen answers with
  its read time only. The snapshot carries just `screenAt` per session. The
  state rules still read the last 40 lines (`tailLines`).

## The project's folder

The folder path under the project title opens the folder in Finder on the
Mac (underlined on hover, "Open in Finder"): `POST /api/project/open-folder`
with the project's id runs `open` on that project's registered folder,
never a path from the page, after the board's write guard; 403 for a phone
(where the path stays plain text), 404 for an unknown project, 409 when
the folder is not on disk. `MC_OPEN_COMMAND` (JSON argv, the folder
appended) replaces `open` in tests, and a test board (RAVENRY_HOME or
MC_HOME set) never runs the real `open` without `MC_OPEN_REAL=1`.

## The project picture and its gallery

The picture card in the right column (under the Live screen) shows the
newest picture the project's current session showed you
(`server/pictures.mjs`: only that session's main transcript, and in it only
its own Read of an image or an image path it wrote in its text to you,
outside tool calls; never a subagent's transcript, a path in a tool call's
input such as a command, a Write target or a script's arguments, nor a path
in tool output, so a subagent's verification shots, "before" shots and test
fixtures a script draws stay out. Only files in the project's folder or
that session's own scratchpad, 15 MB, 30 days; a hand-off's fresh session
starts with none). Clicking it opens the gallery
([docs/design/Gallery.dc.html](design/Gallery.dc.html), variant B):

- **The card** ([docs/design/GalleryCard.dc.html](design/GalleryCard.dc.html),
  variant B) shows the session's last three: the newest takes two thirds
  of the width, top left, and the two before it sit stacked on the right,
  each a third wide and half the height. Columns at 2:1 in a 24:9 card, so
  every tile is 16:9 (173 px tall in a 462 px column, a real board's 1273 x 740
  pane; 128 px at a phone's 342). The count with a pictures icon sits on
  the big tile's bottom-right corner. Each tile is its own button ("Open
  picture 5 of 6, shapes.png", numbered as the gallery numbers them)
  and opens the gallery on its own picture, with a zoom-in cursor and a
  focus ring. Two pictures: two thirds and one third side by side at the
  same height, the small one cropped to its middle, "2" on the big tile.
  One picture: the whole width at 16:9, no count, as before. The same
  layout on a phone.
- **Desktop**: the whole window, like the Live screen's full screen. The top
  bar has the project's name, "Pictures from this session", the hint "Left
  and right arrows to move, Esc to close" and Close. The picture is shown
  whole (contain, never cropped, portrait included) between big previous and
  next buttons in the side margins. The caption: file name, "Made by
  <script, command or tool>" (or "Read in this session" when the session
  only looked at it), its age, pixel size, its path relative to the project
  (or to the session's scratchpad), Show in Finder (the Mac only) and Copy
  path. Along the foot, the last 6, oldest left to newest right, each with
  its age, the shown one ringed. It opens on the picture clicked on the
  card.
- **Phone**: the whole screen with an X at the top left and "N of 6", the
  caption (name, who made it and its age) under the picture, square
  thumbnails and big Previous and Next buttons at thumb height. A swipe
  moves. No Show in Finder.
- Left and right arrows move, Esc (or Back) closes.
- **Zoom** on the picture shown (`public/gallery.js`): a two-finger pinch,
  the wheel or a trackpad pinch (ctrl+wheel in Chromium, gesture events in
  WebKit) zooms around the fingers or the pointer, a double click or double
  tap toggles 2.5x, a drag pans while zoomed. 1x to 5x, or up to the
  picture's own pixels when that is more (12x at most); the pan is held so
  the picture never leaves its view, which clips it, so it never covers
  the arrows or the caption. While zoomed a small "250% Fit" button sits in
  the picture's corner, the first Esc goes back to fit and the next closes,
  a finger pans instead of swiping, and the arrows, Previous and Next still
  move; each picture opens whole. The view has `touch-action: none`, since
  the page's viewport (`maximum-scale=1`) and the swipe left the browser
  nothing to zoom but the whole page.
- **Server**: each minute (sooner when the session changes) the board keeps
  the 6 newest allowed pictures the session showed (by file time), each
  checked by the same rule as the single pick was; the newest is the card's
  picture. Who made one comes from the main transcript's tool calls, for
  the caption only (they never admit a picture): the call whose input names
  it, or whose output printed it (a script run by node or python goes by its
  last two path parts, "tools/shoot.mjs"; a subagent's hand-back, "a
  subagent"); a later Read does not replace who made it, commands that only
  look (ls, open, cp...) say nothing, and a picture only named in the
  session's text has no maker line.
  The pixel size is read from the file's header (PNG, GIF, JPEG, WebP).
  The snapshot carries them with the card's picture (`gallery`: key, name,
  url, at, by, made, w, h, rel, path). `GET /api/pic/<id>?auto=<name>&k=<key>`
  serves only one of the current 6, re-checked on every request.
- **Show in Finder**: `POST /api/project/reveal-picture` with the project and
  the picture's key runs `open -R` on that picture's real path, after the
  write guard and the same re-check; never a path from the page. 403 for a
  phone, 404 for anything that is not one of the current 6. It uses the
  folder path's `open` (above), so `MC_OPEN_COMMAND` replaces it in tests and
  a test board never runs the real `open`.

## Answering from the board

Send types the message into the chosen Claude tab through cmux's paste path
(in iTerm2, AppleScript's `write text`, a message with a line break as one
bracketed paste), then presses Enter. While Claude works, Claude Code queues it and reads it
after the current step. Dropped, pasted or attached files are saved to
`<project folder>/.inbox/` (which ignores itself in git) and their absolute
paths are appended to the message. The board refuses to type when the tab has
no Claude running, when its prompt holds half-typed text, or when a dialog is
open (then only the dialog's own options are offered). Claude Code's dim
suggested reply is not half-typed text: the message replaces it
(`server/suggestion.mjs`; docs/STATE-RULES.md, "The suggested reply"). Writes are accepted
only from the board's own page.

A dialog's option (a permission prompt, an AskUserQuestion question, the
folder-trust prompt) is chosen the way a person would (`server/choose.mjs`):
the board reads which option the `❯` marks, presses Up or Down until the
screen shows the `❯` on the wanted one, presses Enter, and reads the screen
again until the menu has gone or a different one is open. The option's
number is never typed, because some menus ignore digits (the folder-trust
prompt left "No, exit" selected on "2"). If the `❯` never reaches the option,
Enter is not pressed; if the menu is still open after Enter, the board says
so instead of reporting the choice as sent.

## Installing the hooks

```sh
node tools/install-hook.mjs            # the events hook and the hand-off hook
node tools/install-hook.mjs --remove   # take both out
```

`ravenry setup` and `ravenry uninstall` (bin/ravenry.mjs) do the same from an
installed copy, through the same module (`server/hookinstall.mjs`), after
showing the exact entries and asking. A hook command names Node and the
script by absolute path (`<node> <copy>/hooks/events.mjs`): a hook runs
through `sh -c` with whatever PATH Claude Code has, and `npm i -g ravenry-app`
upgrades in place, so the path holds across upgrades. What can go stale is
Node (a removed nvm version) or a moved copy: `ravenry doctor` names each
stale command and `ravenry setup` rewrites it in place. The Node named is a
PATH entry that is the same binary when there is one (`/opt/homebrew/bin/node`
rather than its versioned Cellar path).

It backs up `~/.claude/settings.json` first and touches nothing but its own
two entries (docs/HANDOFF.md, Install). New sessions pick the hooks up.

## Hand-off at half context

Past 50% context (the line is set from the gear in the top bar, and can be
turned off there) a session hands off to a fresh one at its next clean point:
a Claude Code Stop hook asks it to write the hand-off into its brief, and the
board opens a new Claude tab in the same workspace that reads it. Installed
with the events hook (above); see [docs/HANDOFF.md](HANDOFF.md) for how
it works and for the Settings card
([docs/design/HandoffSettings.dc.html](design/HandoffSettings.dc.html),
variant A).

## Phone alerts

When a project starts needing you, the board can send one short alert to
your phone ([docs/design/PhoneAlerts.dc.html](design/PhoneAlerts.dc.html),
variant B). The gear card has a "Phone alerts, this board" section under
Hand-off: the switch "Alert my phone when a project needs me", one status
line ("Not set up", "On, Telegram. Last alert 4 min ago", or in red "Last
alert failed: Telegram said the token is wrong"), Set up (or Change and Send
a test), and the line saying the bell also sends these as Mac notifications
(below), on or off. Set up opens a
sheet (centred on a desktop, rising from the bottom on a phone) with the
picker, each channel's steps, Send a test, the privacy line, and Done, which
turns blue once a test went through and then turns alerts on.

- **Channels** (`server/channels.mjs`, one `send(alert)` each; a future
  native app is one more entry, the triggers stay untouched):
  - **Telegram**: a BotFather token (checked with getMe), then Find my chat,
    which reads getUpdates after you message the bot and keeps the private
    chat's id. The alert is HTML with an "Open on the board" button; if
    Telegram refuses the button's link, the link goes in the text.
  - **Discord or Slack**: one incoming webhook URL; which one comes from the
    URL (discord.com/api/webhooks/..., hooks.slack.com/services/...), and
    each gets its own JSON (Discord `content` with a masked link and no
    mentions, Slack `text` in mrkdwn).
  - **ntfy**: a private random topic (`ravenry-` + 20 characters) on
    https://ntfy.sh, or the `ntfy.server` set in alerts.json. Published as
    JSON to the server root (title, message, click, priority 4). The QR
    holds `ntfy://ntfy.sh/<topic>?display=Ravenry`: on Android it opens the
    ntfy app on the topic and subscribes (docs.ntfy.sh, "ntfy:// links").
    The ntfy iPhone app registers no link scheme, so no code or link can
    subscribe it: Copy topic puts the topic on the Mac's clipboard (it
    reaches an iPhone through Universal Clipboard) and the user pastes it
    after + in ntfy. `https://ntfy.sh/<topic>` was not chosen: it opens
    ntfy's web app, which subscribes only that browser tab, with background
    notifications off unless installed as a web app.
- **Triggers** (`server/alerts.mjs`, `observe()` every tick with full cmux
  reads): a project moving into Needs you because its session asked a
  question, handed back, or waits on a permission prompt (a
  `permission_prompt` Notification, or a permission dialog on screen). A
  half-typed reply sends nothing. Nothing for states already Needs you when
  the board starts (8 s, and each project's first look), the same session,
  kind and moment seen again, a project alerted in the last 10 minutes, or
  a project in an `mc-test*` workspace. The alert is "<Project> needs you"
  plus "Asked you a question", "Handed back" or "Waiting for permission",
  never the session's text, and links to `http://<Wi-Fi address>:<port>/#<project id>`,
  where the phone's sign-in cookie opens it. A plan gate ("Plan gate:
  <short question>") always needs you, so the 10 minutes do not apply to
  it: each distinct gate (its plan, step and question) alerts once, and a
  gate neither waits for the cooldown nor starts it. A gate already open at
  the first look, or seen while alerts are off, counts as seen.
- **Failures**: shown in the status line and logged (`alerts: ... failed by
  Telegram: ...`), tried once more after 30 s. Every send is started
  without waiting and gives up after 10 s, so it never holds up the tick.
- **Secrets** live in `~/.ravenry/alerts.json`, mode 0600. No client ever
  gets them in full: the snapshot and `GET /api/alerts` carry only the
  status, and `GET /api/alerts/setup` (the Mac only) carries them masked;
  the ntfy link leaves the server only inside its QR picture. Nothing logged
  holds a token, URL or topic. All writes pass the board's write guard. A
  signed-in phone may use the switch and Send a test; the sheet's data and
  every secret write answer it 403 ("Tokens are set up on the Mac only..."),
  and its sheet says so.
- `node tools/alerts-test.mjs [--real-ntfy]` proves the payloads against a
  local stub, the triggers, the board end to end on :4665, the QR and the
  phone's 403s. Env for tests: `MC_TELEGRAM_API`, `MC_ALERT_BOARD_URL`,
  `MC_ALERT_PRIME_MS`, `MC_ALERT_RETRY_MS`, `MC_ALERT_COOLDOWN_MS`,
  `MC_COPY_COMMAND`.

## Mac notifications (the bell)

The bell in the top bar is the switch for Mac notifications, sent by the
server (`server/desktop.mjs`), so they come with no page open. On unless
turned off; the state is `desktop.enabled` in `~/.ravenry/alerts.json`, and
a phone's bell turns the Mac's notifications on or off too. Its tooltip says
"Mac notifications on: a question, a hand-back, a permission prompt or a
plan gate"; off, the bell is drawn with a slash.

- **The same moments as the phone alerts**, with their wording and dedupe
  (nothing at start, a blip is not sent twice, 10 minutes per project, each
  distinct plan gate once and outside the cooldown, nothing for `mc-test*`),
  but as their own channel with their own trigger state: they need no phone
  setup, and turning either off leaves the other alone. Never the session's
  text: "<Project> needs you" and the kind ("Plan gate: <short question>"
  for a gate).
- **In iTerm2 mode** (below, "The board in iTerm2") it is always
  `osascript -e 'display notification ...'`; cmux is never asked.
- **How**: `cmux notify --title "<Project> needs you" --body "<kind>"
  --workspace <its workspace> --surface <its tab>`, so clicking it opens the
  project's workspace. The board runs in a cmux terminal, and cmux files a
  notification under `$CMUX_SURFACE_ID` over `--workspace` (the one real
  send landed on the calling tab's workspace), so those variables are left
  out of the call. With no open workspace, or when cmux refuses or is
  missing, `osascript -e 'display notification ...'` instead. The last send
  shows in the Settings line when it failed, and every send is logged
  (`desktop: ... shown by cmux`).
- The page sends no notification of its own (the old web Notification
  needed the page open and never showed in cmux's browser pane), so there
  are never two from the board.
- cmux also sends its own notifications for Claude prompts. If the same
  moment shows up twice, turn off one of them: the bell here, or cmux's own
  in cmux Settings.
- Tests: `node tools/desktop-notify-test.mjs`. A test board (RAVENRY_HOME or
  MC_HOME set) never runs the real cmux or osascript for this; it needs
  `CMUX_BIN` (the fake cmux records `notify`) and `MC_OSASCRIPT_BIN`
  (`tools/stub-osascript.mjs`), or `MC_DESKTOP_REAL=1`.

## Plans: handing the work over

A plan hands a piece of work to a project's session: you say what you
want done, Claude drafts the steps, they go over them together, and the
session runs them on its own, stopping at the gates
([docs/design/Plans.dc.html](design/Plans.dc.html): section 1 "Planning
it together", variant A's Plan card and full plan, and A+'s one-line row in
Objectives).

- **Planning conversation** (`server/planner.mjs`): New plan on the project's
  Plan card opens a sheet (a page of its own on a phone, with the chat box
  and Start pinned at the bottom). The goal box asks "What do you want
  done?"; Draft a plan asks Claude for tagged steps (Do, Done when, Branch
  with if-arms, Gate) and at most two questions with quick answers, only
  where a wrong guess changes the plan. Your rules (the global
  `~/.claude/CLAUDE.md` and the project's CLAUDE.md, the files the Rules
  view reads) come in as gates marked "From your rules", each with Remove.
  Every step has a comment button and a handle to drag it; the chat box
  takes bigger changes. A revision marks only the steps it changed (Updated,
  Added, computed by the board from step ids, not by the model) and says
  what changed in one line. Answering the last open question sends the
  answers for a revision, so the plan reflects them. "Looks right, start" is
  off while a question is open or Claude is working. "Write the plan
  yourself" takes free text and structures it, keeping your words. Dictate
  uses the browser's own speech recognition where it has one.
- **Files in planning**: the goal box, the chat box and each step's comment
  box take files like the composer: Attach (on a phone, the file picker
  offers the gallery), drop (on a box, or anywhere on the sheet for the open
  comment, else the chat box), paste. They are saved through the composer's
  route (`POST /api/inbox/<project>`, the same limits and write guard) into
  the project's `.inbox/` and shown as the composer's chips, each with
  remove. A file goes with words saying what it is for (a file sent with an
  empty box is refused: "Say what the file is for, like "I like this
  style""), and the server takes only files that are inside that project's
  `.inbox` (real paths, symlinks resolved, at most 10 at a time). They
  become the draft's references, shown under your message in the thread (a
  picture as a thumbnail, through the picture route). A call with references
  gets `--tools Read`, one `--allowedTools Read(//<real path>)` per file and
  `--permission-prompts none`, runs in the empty `plans/empty` folder (so
  nothing else is readable), and its prompt lists each file with where and
  how you sent it ("with their comment on step 3, "...": "I like this style"")
  and asks for the file's path in any step that depends on it. Start writes
  them under the plan's Goal as `References:` (docs/BRIEF-FORMAT.md, Plans),
  and the start prompt tells the session to read them before the first step.
  The full plan shows them under Your goal (on a phone, above the steps). A
  real draft and revision on a scratch project with a style picture took
  7.3 s (6,535 tokens in, 693 out) and 15.2 s (17,262 in, 1,425 out), and the
  revision named the picture in four steps.
- **Model calls**: `claude -p --no-session-persistence --model sonnet --tools ""
  --strict-mcp-config --setting-sources project,local --output-format json`
  with a `--system-prompt` and a `--json-schema` (`planCommand`, or
  `MC_PLAN_COMMAND` in tests), run in `~/.ravenry/plans`, stopped after 3
  minutes. The answer is checked again (`validateDraft`: kinds, 2 or 3 arms
  per branch, gate choices, at most two questions, rule ids that exist, no em
  dashes) and asked once more with the reason when it fails. Each call logs
  its time and tokens to the board's output and `plans/calls.jsonl`. The
  draft lives in `plans/drafts/<project>.json`, so a reload or a phone picks
  the conversation up. With `startWith: 'codex'` (or Claude Code not
  installed) the same prompts and schema go to `codex exec` instead, with the
  schema as `--output-schema`, no tools, at medium effort
  ([docs/ASSISTANTS.md](ASSISTANTS.md), Print mode); it logs tokens and no
  cost.
- **Storage**: Start writes the plan first under the brief's `## Plan`, in
  the format of docs/BRIEF-FORMAT.md (Plans), through `writeBriefSafe`: a
  backup in `~/.ravenry/backups/briefs/`, then a temp file and a rename, the
  whole write redone once if the file changed meanwhile, and only the plan's
  own objective changed. One plan runs per project.
- **Running** (`server/planrun.mjs`): a session live at its prompt gets the
  start prompt through the composer's send path; with none, Revive opens a new
  tab (or workspace) with the start prompt instead of its usual one. A
  session working on something else is not interrupted: Start says so. The
  prompt holds the rules for running a plan (docs/HANDOFF.md, Plans and
  hand-offs). A fresh session after a hand-off is told about the running
  plan, and the board logs where it picked up.
- **Plan card** (variant A): under the answer card, the steps with their tags,
  proofs (text, a test line, a screenshot thumbnail), times, the branch
  taken in green and the one not taken dimmed, and where a hand-off happened.
  Open the plan (`#/plan/<project>`) shows the flow with every branch laid
  out, Your goal, Rules for every plan and the Log, with Change the plan (the
  conversation again, finished steps locked), Pause and Stop the plan.
- **Gates**: a plan waiting at a `[?]` step, with its session not working,
  makes the project Needs you with "Plan gate: <short question>" as its line,
  the answer card becomes the gate card (the question, the proof tiles, the
  plan's choices and the free answer box), and the phone alert goes out with
  that line as its kind (`server/alerts.mjs`, kind `gate`). A `[?]` on a step
  that is not a Gate is "Not in the plan, so I stopped to ask". Answering
  writes `Answer:` under the step (a gate is passed) and a Log line, then
  sends the session the answer with the rules.
- **Objectives**: an active plan is one row with a PLAN label, a dot per step
  (a fork for a branch, a diamond for a gate), "Step N of M", and "At a gate:
  ..." with a faint orange wash, or "Running: ..." in blue, and Open the plan.

## Starting work and following it (phase D)

The top bar switches views; each view lives in the URL (`#/objectives`,
`#/ideas`, `#/rules`, `#/ship`).

- **Objectives**: every project with a brief, its objectives and tasks as
  status dots with counts and the next step, then the plan files in its
  folder (`PLAN*.md`, `ROADMAP*`/`TODO*`/`TASKS*.md` at the root, any
  `*plan*`/`*roadmap*`/`*todo*` file under `docs/`) that carry markdown
  checkboxes: one row each with a bar, "done of total" as the file states it,
  and "updated <age>" from its last commit (or its modified time when it has
  uncommitted changes). `server/plans.mjs`. In a shared folder a plan file
  goes to the project its name names, else to the `main` project, else to
  none. The same objectives show on the Projects sheet. A brief that starts
  with `status: draft (...)` shows a **Draft** label; clicking it copies the
  brief's path. Projects with neither a brief nor a plan file are one quiet
  line each with **Write the brief**.
- **Draft briefs** live in `~/.ravenry/briefs/<project-id>.md`,
  outside every repo, with the registry `brief` pointing at them. They were
  written from each project's own docs, plans, memory notes, latest session
  recap and git log, and say so in their first line. The hand-off hook and
  Add as note work with a brief there like with a BRIEF.md (the hook asks
  for a bullet in its Hand-off section and does not ask to commit it).
- **New project** (top bar): name, kind (chips or your own words, so a
  non-game project fits), goal, done means, first milestones, project rules.
  Start makes `<projects root>/<slug>` (git init; the root is below, "Where
  new projects go"), writes BRIEF.md, adds the
  registry entry and opens a NEW cmux workspace (not focused) running
  `claude 'Read BRIEF.md and start on the first milestone.'`; on a board in
  iTerm2 mode, a NEW iTerm2 tab in its current window that runs
  `cd <folder> && claude '...'`. The Folder row
  under Name ([docs/design/NewProjectFolder.dc.html](design/NewProjectFolder.dc.html),
  variant A) is a "New folder | Existing" switch. New folder shows the path
  the name makes; when that folder already holds files, the hint says so and
  links to Existing (the server still refuses it). On the Mac, "Change for
  this one" at the end of that path line opens Finder's dialog
  (`purpose: "parent"`, which also returns the names taken there) to pick
  another parent folder: the new folder is made there, for this project only
  (`parentFolder`, checked with the same guards, the taken-name check made
  against that parent), and the default in Settings stays as it is. "Back to
  default" puts the default parent back. Existing lists the folders
  the board knows (`GET /api/project/folders`: registered folders still on
  disk, one row each, most recently active first, 6 shown, 5 on a phone) and,
  on the Mac only, "Choose…", which opens Finder's own folder dialog through
  `POST /api/project/choose-folder` (`osascript`, loopback only, 403 for a
  phone, one at a time, closed after 5 minutes; `MC_CHOOSE_FOLDER_COMMAND`
  replaces it in tests). An existing folder must be a real directory inside
  the home folder, symlinks resolved, and not the home folder itself,
  `~/Library`, the board's data folder or a system path. In a folder another
  project uses, or one that already has a BRIEF.md, the project gets its own
  `BRIEF-<id>.md`, which also holds its hand-off; no git init there. An
  existing brief is never overwritten. `node tools/new-project-folder-test.mjs`
  proves the guards and routes on a test board on :4663 with the fake cmux.
- **Where new projects go** ([docs/design/ProjectsRoot.dc.html](design/ProjectsRoot.dc.html),
  `server/projectsroot.mjs`): only a brand-new folder is made in the projects
  root; a project in a folder that is already there can live anywhere, and
  nothing on the board moves when the root changes. The order:
  `MC_PROJECTS_ROOT` (read at start), then `settings.projectsRoot`, then the
  parent folder most registered projects share (saved as the setting, with
  `projectsRootFrom: "shared"`, the first time the board sees it), then
  asking once. The Settings card ends with "Projects, this Mac": "New
  projects go in", the path, and Change (the Mac only), which opens Finder's
  dialog through `POST /api/project/choose-folder` (`purpose: "root"`) and
  saves through `POST /api/settings/projects-root` (403 for a phone, 409
  while `MC_PROJECTS_ROOT` holds it). The line under it says where the folder
  came from ("Picked from where 9 of your 11 projects live. Existing folders
  can be anywhere."), or after a change "Projects already on the board stay
  where they are."; while Finder is open, "Waiting for Finder's folder dialog
  on this Mac."; Saved shows in the field. A phone shows the path read-only
  with "Change it on the Mac. The folder dialog opens there."; with
  `MC_PROJECTS_ROOT` the field has a lock and "Set by MC_PROJECTS_ROOT when
  the board started." With no projects and nothing set, the Mac (never a
  phone) asks "Where do your projects live?" with the first of ~/Developer,
  ~/Projects, ~/Code, ~/dev or ~/src that exists, else ~/Projects, made when
  the first project needs it; Use this, Choose… and closing it all save an
  answer (closing keeps the suggestion), so it asks once. The chosen folder
  passes the same guards as an existing project folder (inside the home
  folder, not the home folder itself, not ~/Library, not the board's data
  folder, a real directory) and is written through the registry's settings
  path, after a `projects.json.bak-*` backup. `node tools/projects-root-test.mjs`
  proves the order, the guards, the first run and the routes on test boards
  on :4668 to :4670.
- **Write the brief**: the same form for a project without one. It writes
  BRIEF.md, or `BRIEF-<id>.md` plus the registry `brief` field when the
  folder is shared.
- **Revive** (an idle project with a brief): a NEW tab in its workspace, or a
  new workspace when it has none, running
  `claude 'Read BRIEF.md (Hand-off section first) and continue.'`; in iTerm2
  mode a NEW iTerm2 tab, in the window of the project's own iTerm2 session
  when it has one. Old tabs are never touched.
- **New session** ([docs/design/NewSession.dc.html](design/NewSession.dc.html),
  variant D): a small switch after Attach in the project's message box, off
  whenever a project opens. On, the box gets a blue ring and Send reads Start
  session, which goes through Revive (`POST /api/project/revive` with `text`
  and `paths`) whether or not a session is live: the new tab runs
  `claude '<words> <paths>'`, the words and escaped file paths Send would
  type, as one exact shell word (`--` before words that start with a dash),
  and needs no brief; empty, it is Revive. After starting, the switch goes
  off, the box empties, the selection stays on the session being watched,
  and the new row reads Starting (a dashed blue ring) until its first hook
  event, a minute at most.
- **Ideas**: `~/.ravenry/ideas.json`, pictures copied into
  `~/.ravenry/ideas/` (seeded once with five real ideas; originals
  are only copied). Drag between Spark, Mockup, Greenlit and Parked; open a
  card to edit name, pitch and status, switch stage, Kill (an archive, never
  a delete) or Promote to project (the New project form, prefilled). Drop or
  paste a picture on a card or the open idea to attach it; one dropped in the
  thread box goes with the next message. Each thread message and "Get 3
  directions" runs `claude -p --no-session-persistence --tools Read` in
  `~/.ravenry/ideas` with the idea as context, one at a time, stopped
  after 3 minutes with a clear message. With `startWith: 'codex'` (or
  Claude Code not installed) the thread, the directions and the mockup
  rounds run `codex exec` instead, the idea's pictures attached with `-i`
  ([docs/ASSISTANTS.md](ASSISTANTS.md), Print mode).
  - **Mockups** ([docs/design/IdeaMockups.dc.html](design/IdeaMockups.dc.html),
    variant A): a card between the open idea and its thread. "Mock it up"
    runs one round: the same `claude -p --no-session-persistence --tools
    Read` plus `--strict-mcp-config --setting-sources project,local --model
    sonnet --output-format json` (`mockupCommand` or `MC_MOCKUP_COMMAND`
    replace it), in `~/.ravenry/ideas`, one job per idea
    shared with the thread, stopped at 3 minutes. The prompt is the thread's
    context and asks for a JSON array of 3 `{title, note, html}`, each a
    self-contained 800x500 page, inline CSS and SVG, no scripts, under 6 KB.
    The board checks the answer, writes `ideas/<id>/mockups/r<N>-<a|b|c>.html`
    and draws each to a PNG in headless Chromium (Playwright, a dev
    dependency) with JavaScript off and the network blocked; the PNGs are
    served only as `<id>/mockups/r<N>-<a|b|c>.png` through the idea-picture
    route. The card shows the viewed variant big with Pick, the 3 thumbnails,
    a note and Another round (which sends the picked, else the viewed,
    variant's page with the note), and Round 1 | Round 2 | ... While an idea
    has rounds, the big picture replaces its own picture in the open idea.
    Working shows the time and Stop; a failed round is one sentence and the
    last round stays. Pick makes the variant the card's cover; a dropped
    picture stays and can be put back. The board card shows the cover, the
    latest round's thumbnails and one line; the thread gets one quiet line
    per round. Dragging into the Mockup column starts nothing. Each round
    logs its time, tokens and cost to the board's output and
    `mockups/rounds.jsonl`. Without the user's settings and MCP servers a
    turn starts at about 4k input tokens instead of 64k (the first real
    round cost $0.335, almost all of it that context). `node tools/idea-mockups-test.mjs` proves it
    with a stub model on a test board on :4664.
- **Rules** ([docs/design/Repeats.dc.html](design/Repeats.dc.html)):
  a switch under the title, "Your rules N | Suggested M", opening on Your
  rules. The top-bar Rules count is M, the suggestions waiting.
  - **Your rules**: the lines of `~/.claude/CLAUDE.md`, as cards under its
    own `##` headings, read-only. Memory-name citations in parentheses are
    hidden on the board only.
  - **Suggested**: corrections you typed in two or more sessions, most
    said first, from `server/repeats.mjs` (below). Each row has the rule in
    your words, "Said N times in S sessions, last on D.", one verbatim quote,
    one action and Not now. **Reword rule** (the rule exists and you still
    say it) replaces exactly that one line, after a timestamped backup in
    `~/.claude/backups`, and refuses when the line no longer reads exactly
    as it did when the suggestion was made; the written line keeps its
    citations and merges in new ones. When the rule lives only in a memory
    file, the memory is left alone and the reworded line is appended to that
    project's CLAUDE.md. **Add to every project** (only one project's memory
    knows it) and **Add rule** (nothing covers it) append to a
    `## Added from the board` section of `~/.claude/CLAUDE.md`. **Not now**
    and every accept are recorded with a time in
    `~/.ravenry/rules.json` (`repeats`); a newer repeat brings the
    row back.
  - **N more from project memory** > Show: feedback memories from the
    memory folders of the projects in `ruleSources` that `~/.claude/CLAUDE.md` does not
    cite by name yet, as before. "Every project" appends `- <rule> (<memory
    name>)` to the `## Added from the board` section, after a backup; "This
    project" does the same in the project's CLAUDE.md; "Not a rule" is
    remembered in `~/.ravenry/rules.json`.
  Memory files are only read. The only line the board ever rewrites is a
  Reword rule's one line.
- **Ship**: per git repo, commits not pushed to its upstream, tracked files
  changed and the last commit, plus each brief's `## Ship` checklist. A
  `shipCommand` in a project's registry entry shows as a `! <command>` line
  to copy. The board never runs a deploy or a push.

## The repeats detector

`server/repeats.mjs` finds the corrections the user repeats across sessions:

- It reads their own typed messages from `~/.claude/projects/*/*.jsonl` for
  the projects in `ruleSources` (by default every project on the board with
  a folder, and the projects root; no subagent sidechains, meta records, tool
  results, task notifications, compact summaries, pasted content, system
  reminders or board hand-off prompts). It keeps a per-file offset, size and
  inode and reads only new bytes; a new inode or a shorter file is read
  again from 0. Codex's sessions are read the same way from its rollouts
  (`~/.codex/sessions`), each going to the source its folder is in, the
  user's own prompts only (docs/ASSISTANTS.md, "Rules"). Every kept message
  is stored verbatim, with its verdict, in `~/.ravenry/repeats/`, because
  Claude Code deletes transcripts after 30 days.
- Model calls: `claude -p --no-session-persistence --model sonnet --tools ""
  --strict-mcp-config --setting-sources project,local --output-format json`
  with a short `--system-prompt` and a `--json-schema`, on your own
  Claude login (no API key, no hooks, no saved session, run in
  `~/.ravenry/repeats`). A run sends every new message, with no
  keyword prefilter, in at most 3 classify calls of up to 120 messages
  (each message is a cluster, a new cluster, or not a correction), then one
  draft call for up to 10 clusters that just reached 2 sessions (rule line,
  matching line in a CLAUDE.md or memory, reword). Each call stops after 5
  minutes. When new sessions start with Codex (`startWith`), the same
  calls run through `codex exec` (docs/ASSISTANTS.md, "Print mode").
- Plain code does the rest: counts, dates, dedupe (a message re-sent with
  an addition counts once), whether the rule was in that session's scope
  when you said it (which picks Reword, Add to every project or Add rule),
  and quotes, which are cut from the stored text, never from model output.
  Accepting a row writes to CLAUDE.md for what Claude Code's sessions said
  and to AGENTS.md (`globalAgentsMd`, `<CODEX_HOME>/AGENTS.md` by default,
  or a project's) for what Codex's said, both when both did.
- It runs once a day while the board is up, and at start when the last run
  is more than 24 h old (a failed run is retried after 6 h). Each run logs
  its message count and tokens to the board's output and to
  `repeats/runs.jsonl`. Daily runs follow the registry's `repeatsAuto`:
  a registry made by this version starts with it false, and `ravenry setup`
  asks (it is a choice about the user's data and quota, so `--yes` never
  turns it on); a registry from before the setting has none and keeps the
  old default, on for the real board (no `RAVENRY_HOME` or `MC_HOME`
  override). `MC_REPEATS_AUTO=1|0` overrides both.
- First start: it stores every message in the transcripts with no model
  call and marks all bytes read; all of them wait for the first run. No seed
  ships. The first board was seeded from the approved mockup's data pass (12
  clusters in a private seed file; `MC_REPEATS_SEED=<file>`
  loads a seed): messages up to its last one kept its verdicts, the rest were
  backlog and never sent.

Every path and command these use can be pointed elsewhere in the registry's
`settings` (the tests do): `projectsRoot`, `globalClaudeMd`, `backupDir`,
`ruleSources` (`[{ label, memory, claudeMd }]`), `launchCommand` (default
`claude`), `printCommand` (argv, prompt on stdin), `claudeTimeoutMs`,
`focusNewWorkspace` (default false), `repeatsCommand` (argv),
`repeatsTimeoutMs`, `repeatsAuto`, `rulesScopeName`, `planCommand` (argv), `planTimeoutMs`; a `ruleSources` entry
may name its `transcripts` folder. Env overrides: `MC_PROJECTS_ROOT`,
`MC_GLOBAL_CLAUDE_MD`, `MC_BACKUP_DIR`, `MC_CLAUDE_BIN`, `MC_PRINT_COMMAND`,
`MC_REPEATS_COMMAND`, `MC_REPEATS_AUTO`, `MC_PLAN_COMMAND`.

## The board in iTerm2

For someone who works in iTerm2 only, no cmux: the board lives in one
iTerm2 tab named Ravenry, as it lives in the pinned "Ravenry" workspace in
cmux, with its page on top and a small terminal under it running
`npm start`.

1. Once: install iTerm2's Browser Plugin (download it from
   https://iterm2.com/browser-plugin.html and put `iTermBrowserPlugin.app`
   in /Applications), turn on iTerm2 > Settings > General > Magic > Enable
   Python API, and run `node tools/install-iterm.mjs`.
2. In this repo, from any terminal: `npm run iterm`.
3. A tab named Ravenry opens in iTerm2's front window (`npm run iterm --
   --window` gives it a window of its own): the board page on top, an
   8-row terminal under it running the board. Run it again and the same tab
   comes forward; when its board has stopped, it starts it again there.
   `npm run iterm -- --close` closes that tab, which ends its board.

What happens then:

- **iTerm2 mode.** A board started in an iTerm2 tab drives iTerm2 and never
  runs cmux: no cmux call, no cmux error, no cmux words on the page. New
  project and Revive open new iTerm2 tabs that `cd` to the folder and run
  claude, Reopen and a hand-off's fresh session open iTerm2 tabs, "Open in
  iTerm2" brings a session's tab forward, Mac notifications are macOS's own
  (`display notification`), and a Claude session in an iTerm2 tab whose
  folder no project holds becomes a project of that folder, as a new cmux
  workspace does in cmux mode. The mode comes from where the board was
  started: inside cmux, cmux mode; in iTerm2, iTerm2 mode; from launchd or
  elsewhere, cmux when cmux is installed, else iTerm2.
  `RAVENRY_TERMINAL=cmux` or `RAVENRY_TERMINAL=iterm` decides it instead.
  The snapshot says which (`board: { kind, name }`).
- **cmux sessions** are not driven by a board in iTerm2 mode. One that
  reports anyway shows watch only, saying "This session runs in cmux, and
  this board runs in iTerm2, so it only shows what the session's hook
  events say. Answer it in cmux." It stays in the project of its cmux
  workspace, and its Live card says "Watch only".
- **No Browser Plugin**: iTerm2 would stop on a "Browser Plugin Missing"
  alert, so `npm run iterm` never asks it for a page then. The terminal
  still opens in iTerm2, the page opens in the default browser, and it says
  so in one line.
- **By hand**: `npm run iterm` writes a Web Browser profile, "Ravenry board"
  (`~/Library/Application Support/iTerm2/DynamicProfiles/ravenry.json`),
  so iTerm2 > Profiles > Ravenry board opens the page in a new tab too.
- **The page waits for the board**: a browser session loads its first page
  once, so the terminal starts first and the page is split in above it when
  the board answers, through iTerm2's Python API (AppleScript can only split
  below; without the Python API the page goes below, and the line says so).
- **No resume binding**: iTerm2 has nothing like cmux's. After a reboot, or
  when the tab was closed, run `npm run iterm` again.
- One board per port, as before: a second `npm start` prints one line and
  exits. When a board already answers on the port (in cmux, by launchd),
  `npm run iterm` opens only the page.
- First time only, macOS may ask to let your terminal control iTerm2
  (Automation), and to open the Browser Plugin, an app downloaded from the
  internet.

Measured on 2026-11-03 (iTerm2 3.7.6, a second board on :4602 with a
scratch RAVENRY_HOME): `npm run iterm -- --window` took 2.8 s from nothing
to the page showing the board, in a 1280 by 853 window with the page 657
points high over an 8-row terminal. With that board already running, the
page alone took 1.3 s.
New project from that page opened a new iTerm2 tab that ran
`cd <folder> && <launch command> 'Read BRIEF.md and start on the first milestone.'`.

## Run at login

The board runs inside cmux, because cmux's socket is in "cmux processes
only" mode and refuses anything started outside it ("Access denied - only
processes started inside cmux can connect"). The pinned "Ravenry"
workspace holds two panes: the browser on http://localhost:4600 on top, and
a small terminal below it that runs `npm start` in this repo. That terminal
carries a cmux resume binding, so when cmux reopens after a quit or restart
it runs `npm start` again there:

```sh
cmux surface resume show --json --workspace <Ravenry> --surface <board terminal>
# command 'npm' 'start', cwd this repo, auto_resume true, approval_policy auto
```

To set it up again on a new terminal surface, run this from that terminal:

```sh
cmux surface resume set --name "Ravenry board" --kind server -- npm start
```

A binding set from the CLI only runs on its own once cmux has approved it
(right-click the terminal > Resume Commands > Auto-Restore, or Settings >
Terminal > Resume Commands); `show --json` says `auto_resume: true` when it
has. cmux starts a terminal only when it is first shown or restored, so a
freshly made board terminal in a background workspace starts the board the
first time you open that workspace.

If a board of this repo already holds :4600, a new `npm start` prints one
line ("Ravenry is already running ...") and exits 0; if something
else holds it, it says which process and exits 1.

### LaunchAgent (needs a cmux socket password)

```sh
node tools/install-login.mjs            # install, take over :4600, start
node tools/install-login.mjs --remove   # stop and delete the LaunchAgent
MC_LAUNCHD_DRYRUN=1 node tools/install-login.mjs   # print only, change nothing
```

This exists but cmux refuses it unless cmux's socket access is set to
Password (cmux Settings > Automation). It writes `~/Library/LaunchAgents/gg.ravenry.board.plist`, which runs
this Node (`process.execPath` at install time) on `server/index.mjs` with
RunAtLoad and KeepAlive (restarts after a crash, at most every 10 s), logs to
`~/.ravenry/logs/board.{out,err}.log`, and a PATH that holds node,
claude, cmux and the system folders, since launchd gives jobs a bare PATH.
Before loading it stops a board already on :4600, only if that process is
this repo's board, then waits for :4600 to answer 200 and checks that cmux
still answers the board. Rerun it after switching Node versions (nvm), since
the plist names one Node binary. If it reports cmux REFUSED, cmux's socket is
in "cmux processes only" mode: set a password under cmux Settings >
Automation and rerun with `MC_CMUX_SOCKET_PASSWORD=<it>`.

## Tools

Every test keeps its data inside this repo's `.tmp/` and can never write the
real `~/.ravenry` (a test once wrote its scratch registry over the real
`projects.json`). Its first import is `tools/test-guard.mjs`, which marks the
process and its children (`TEST_RAVENRY=1`), refuses to start with a
`RAVENRY_HOME` outside `.tmp/`, and gives a test with none a guard home there.
`server/home.mjs` refuses to load in a marked process whose data is not in
`.tmp/`, and refuses a write into the real data folder from a test or from a
process whose `RAVENRY_HOME` changed after it settled. `registry.save()`
refuses to drop more than two projects at once or to write `.tmp/` paths into
a data folder that is not a test's, and backs up the file
(`projects.json.bak-<stamp>-structure`, newest 30 kept) before any save that
adds or loses a project; a real board never takes a projects root in `.tmp/`,
a board on a test's data never listens on :4600, and `npm run iterm` refuses
a shell that carries a test's settings. `node tools/data-guard-test.mjs`
proves each guard, replaying the incident against a fake home outside `.tmp/`.

- `node tools/export-public.mjs <new folder> [--commit "<message>"]`: the
  public snapshot. Copies the tracked files its ALLOW list names and its
  DENY list does not, then audits the copy and fails on any hit, printed as
  file:line: personal terms (one per line in `tools/private/audit-terms.txt`,
  which never ships; `--terms <file>` names another), email addresses, phone
  numbers, dates of birth, IBAN and card numbers, API keys and tokens
  (Telegram, Slack, Discord, ntfy, OpenAI and Anthropic, GitHub, npm, AWS,
  Google, JWT), private keys, home paths and their Claude Code slugs, long
  hex strings, real-looking UUIDs, PNG text chunks, and any PNG, JPEG, GIF
  or WebP embedded as a data URI (an SVG one is decoded and audited as
  text). `--commit` runs `git init` and one commit there, only when the
  audit is clean. `--audit <folder>` audits a folder without copying.
- `node tools/shoot.mjs <outDir> [--url ...]`: headless screenshots at
  1440x1000 and 390x844.
- `node tools/readme-shot.mjs [outDir]`: the README's screenshots
  (`docs/screenshot.png`, `docs/screenshot-phone.png`), drawn headless in
  dark at 1440x900 and 390x844 from a made-up demo board on :4693: five
  projects with briefs under a demo HOME in `.tmp/readme-demo` (so folders
  read `~/Projects/<name>`), sessions in each state through written hook
  events, the fake cmux, the neutral gallery placeholders, and
  `tools/stub-ps.mjs` as ps and lsof (`MC_PS_BIN`, `MC_LSOF_BIN`), so the
  memory line counts made-up processes, never this Mac's. Nothing in the
  pictures comes from a real board, which is why they may ship in the
  public repo.
- `node tools/phone-overflow.mjs [--w 390] [--engine webkit|chromium|both]
  [--shots <dir>]`: opens every view of the running board headless at phone
  width (Projects with Sessions, Hand-backs and the live screen, the live
  screen full screen, the idle
  projects' sheet, Objectives, a Plan card with its gate card, the full plan
  and the planning sheet,
  Ideas, an opened idea and one with mockup rounds, Rules with Suggested, a Reword preview and the
  memory list, Ship, Sessions, the New project modal and its Folder row on Existing, the Settings card, the phone alerts sheet on each channel)
  and exits 1 if any
  scrolls sideways or cuts content off at the screen edge, listing the
  elements. Read-only: it never presses Send, Save, Close or anything that
  writes. `--files <file>` adds the planning sheet with that file attached to
  each box it shows, which saves it into the project's `.inbox`.
- `node tools/live-screen-test.mjs`: the Live screen. The trim rules on
  real captured screens (`tools/fixtures/live/`, private: only in the
  maintainer's repo, skipped elsewhere) and a crafted one, proof that
  `parseScreen` gives the same output as before (commit 4acb04b, also
  skipped where that history is absent) and that the last 40 of a 200-line read are a 40-line
  read, then a test board on :4661 with `tools/fake-cmux.mjs` driven in
  Chromium and WebKit: stick to the bottom, the jump pill, Slow and Not
  updating, full screen with the composer, the pinned card. Touches only
  `.tmp/`.
- `node tools/send-test.mjs <test server url> <projectId> <outDir>`: drives
  the composer headless against a test server whose registry holds only a
  scratch workspace running `tools/fake-claude.mjs`. Start one with
  `RAVENRY_HOME=<scratch dir> PORT=4601 MC_NO_EVENTS=1 npm start`.
- `node tools/handoff-hook-test.mjs` and `node tools/handoff-e2e.mjs`: the
  hand-off proofs (docs/HANDOFF.md, Tests).
- `node tools/events-hook-test.mjs`: pipes crafted input for each of the five
  events into `hooks/events.mjs` (lines written, silent exit 0, timing,
  board down, hung or up, rotation, pruning) and proves the installer on a
  scratch settings file. Touches only `.tmp/`.
- `node tools/events-e2e.mjs [shotsDir]`: a test board on :4601 whose cmux is
  `tools/fake-cmux.mjs` (reads from a fixture, refuses every write), driven
  by the real hook through each event to state mapping, with headless shots
  in `.tmp/shots/events/` (or the folder given).
- `node tools/phase-d-e2e.mjs [shotsDir]`: New project, Write the brief,
  Revive, Rules and Ideas, headless, against a test server on :4601 whose
  registry, CLAUDE.md copies, backups and projects root live in `.tmp/phase-d`.
  Its cmux workspaces are named `mc-test-*`, never focused, and closed at the
  end. `claude -p` is `tools/stub-claude.mjs`, so it spends no quota.
- `node tools/phone-access-test.mjs [shotsDir]`: phone access end to end on
  test boards on :4621 and :4622 (no Wi-Fi), reached through the Mac's own
  LAN address so requests arrive as a phone: 421, 401, wrong and right key,
  the cookie, live updates, New key, the Mac-only card, the QR decoded with
  jsQR, and headless shots. Touches only `.tmp/`.
- `node tools/alerts-test.mjs [--real-ntfy]`: phone alerts (above), with
  every channel pointed at a local stub; `--real-ntfy` adds one publish to a
  throwaway random ntfy.sh topic. Touches only `.tmp/`.
- `node tools/projects-root-test.mjs`: where new projects go and "Change for
  this one" (above), on test boards on :4668 to :4670. Touches only `.tmp/`.
- `node tools/desktop-notify-test.mjs`: Mac notifications (above), with the
  fake cmux and the osascript stub, and a test board on :4674. Touches only
  `.tmp/`.
- `node tools/choose-test.mjs [--real <scratch folder>]`: choosing a
  dialog's option with arrows and Enter (`server/choose.mjs`) on real
  captured menus (`tools/fixtures/menus/`: the folder-trust prompt, a Bash
  permission prompt, an AskUserQuestion question), the fake cmux checked
  against the screens the real terminal showed after the same keys, the
  failures (a menu that does not move gets no Enter, a menu still open after
  Enter is an error), then a test board on :4666 whose fake cmux plays the
  menus (`menus` in its fixture; every other surface still refuses writes).
  `--real` opens a throwaway `mc-test-choose-*` workspace running `claude`
  in a new folder under the scratch folder, answers its folder-trust prompt
  through a test board on :4667's choice route, checks Claude's prompt
  replaced it, and closes the workspace. Touches only `.tmp/` and that
  workspace.
- `node tools/iterm-test.mjs [shotsDir]`: the terminal interface and the
  iTerm2 adapter (docs/TERMINALS.md, Tests): detection from the hook's
  environment, the adapter against `tools/fake-iterm.mjs` (osascript and
  the Python helper), then a test board on :4680 with an iTerm2 session, a
  VS Code session (watch only) and an iTerm2 session whose tab is gone, and
  the page headless. Touches only `.tmp/`.
- `node tools/iterm-mode-test.mjs`: iTerm2 mode and `npm run iterm`
  (above, "The board in iTerm2"): which terminal the board drives from
  where it was started, the Ravenry tab against `tools/fake-iterm.mjs`
  (new tab, page split in above once the board answers, reuse, the start
  command again when its board is down, only the page when a board
  already runs, the default browser without the Browser Plugin, below
  without the Python API, `--close`, a tab without the tag left alone),
  then a test board on :4682 with `RAVENRY_TERMINAL=iterm` and a cmux
  tripwire: no cmux call at all, New project and Revive open iTerm2 tabs,
  Open, a session's folder becoming a project, a cmux session watch only,
  and the page saying iTerm2. Touches only `.tmp/`.
- `node tools/suggestion-test.mjs [--real <scratch folder> [--first styled]]`: Claude Code's
  suggested reply told apart from a half-typed one (docs/STATE-RULES.md,
  "The suggested reply"): the styled read on captured render grids
  (`tools/fixtures/prompt/`), the history of reads (a suggestion at the
  turn's end, typed over, typed during the turn, a turn shorter than a read,
  a board started mid-rest), the state rules on a judged screen, the probe
  on an in-memory prompt, then a test board on :4690 whose fake cmux plays
  prompts (Send over a suggestion with and without the styled read, over
  typed text, a `! command`). `--real` opens a throwaway
  `mc-test-suggest-*` workspace running `claude`, asks until it suggests a
  reply, and runs the board's real Send (test boards on :4691 with
  `MC_NO_STYLED_READ=1`, the probe path, and :4692) over the suggestion and
  over a real half-typed reply, which must be refused and left intact.
  Claude Code rarely offers a second suggestion after one was typed over, so
  the second of the two sends may print SKIP; `--first styled` runs the
  styled-read send first. Only that workspace is typed into; it is closed
  at the end.
- `node tools/assistant-test.mjs`: the assistant interface
  (docs/ASSISTANTS.md, Tests): Claude Code's reading of every captured screen
  unchanged since 76873a4, Codex's captured screens (`tools/fixtures/codex/`,
  private, skipped elsewhere) and their Live screen trim, a Codex menu chosen,
  the events hook and the hand-off hook with `--assistant=codex` on Codex's
  real hook inputs, a rollout, the trust hash against cmux's, and setup and
  uninstall on a scratch CODEX_HOME (`MC_CODEX_HOME`). Touches only `.tmp/`.
  The live check it does not do, done by hand on 2026-11-04: a throwaway
  `mc-test-codex` cmux workspace running Codex with a scratch CODEX_HOME
  (its auth.json copied in, removed after) whose hooks.json got Ravenry's
  hooks through `hookinstall.codexPlan`, `RAVENRY_HOME` and `MC_BOARD_URL`
  in Codex's environment pointing at a scratch board on :4699 whose registry
  holds that workspace; replies, menu choices and Hand off now through that
  board's routes.
- `node tools/start-with-test.mjs [--real]`: which assistant the board
  starts and Plans and Ideas on Codex (docs/ASSISTANTS.md, Starting sessions
  and Print mode, and its Tests): the launch command per assistant and the
  words through `/bin/sh`, `startWith` and its fallback, continuing a
  project, the settings' check, `codex exec`'s argv and output against
  `tools/stub-codex.mjs` (`MC_CODEX_BIN`; `STUB_CODEX_ARGV_FILE` records each
  run), then a test board on :4695 with the fake cmux (also: replies,
  busy lines and restart lines naming Codex, and `POST
  /api/project/assistant`), and the page on
  :4696 (`--shots <dir>`: Settings, New project and the New session line at
  1440x900 and 390x844, dark and light). `--real` runs one
  plan draft through the real `codex exec` in a scratch CODEX_HOME (auth.json
  copied in, deleted after) and a New session on a board on :4697 into a
  throwaway `mc-test-codexstart-*` workspace, closed at the end. Touches only
  `.tmp/` and that workspace. Env for tests: `MC_CODEX=0|1` and
  `MC_CLAUDE=0|1` say whether each assistant is installed.
- `node tools/codex-stage2-test.mjs [--shots <dir>]`: Codex stage two
  ([docs/design/CodexStage2.dc.html](design/CodexStage2.dc.html), sections 1,
  2 and 4): a Codex menu's Live screen text once, which processes are Codex
  sessions, the Rules scopes on scratch files, then a test board on :4696
  with the fake cmux (`hookSessions` in its fixture) and the ps stub: a
  Codex trust menu in a workspace no project lists in Needs you as a folder,
  an idle one in Not in a project, hidden and ignored workspaces nowhere, the
  menu answered from the board, Add to a project and New project from this
  folder writing the registry, the tags, the Sessions page and Rules in two
  columns. Touches only `.tmp/`.
- `node tools/new-session-test.mjs [--shots <dir>] [--real <scratch folder>]`:
  the New session switch on a test board on :4686 with the fake cmux (whose
  `newSurfaces` opens tabs): the route's exact command lines, switch off to
  Send, on to a new tab with the files, the reset, the Starting row and the
  phone rows; iTerm2 mode on :4687. `--real` opens a throwaway
  `mc-test-newsession-*` workspace running `claude`, answers its trust
  prompt through a board on :4688, runs the page's Start session with "Say
  hi in one word", reads the new tab back and closes the workspace.
- `node tools/sessions-test.mjs`: the Sessions rules on crafted input
  (which processes count, process to session mapping, groups, records).
  Touches only `.tmp/`.
- `node tools/rules-repeats-test.mjs`: the repeats detector and its writes
  on crafted transcripts, temp CLAUDE.md and memory files under `.tmp/`,
  with `tools/stub-repeats-claude.mjs` as the model (no quota): offsets
  (truncated and replaced files), dedupe, citation keeping, the line-replace
  guard, Add rule, a memory-only rule, Not now and rows coming back; then
  Codex's sessions on made-up rollouts in a scratch sessions folder (what
  counts as the user's typing, which project a rollout is in, offsets, the
  calls through `tools/stub-codex.mjs` with a strict schema, and writes to a
  scratch global and project AGENTS.md beside CLAUDE.md).
- `node tools/open-folder-test.mjs`: the folder path's Open in Finder on a
  test board on :4675 with the fake cmux and `tools/stub-open.mjs` for
  `open`: the registered folder only, 403 for a phone and for another site's
  page, 404, 409, and a board on :4676 with no stub refusing the real
  `open`. Touches only `.tmp/`.
- `node tools/gallery-test.mjs [--shots <dir>]`: the picture gallery. The
  last 6 kept (only what the main session read or named in its text: a
  subagent's own screenshot, a file a command wrote and a path only in a
  command or a Write target are left out), their order, who made each, the pixel sizes, the privacy rule
  unchanged (outside files, symlinks out and other sessions' scratchpads
  refused), the route and Show in Finder refusing anything that is not one
  of the 6 and refusing a phone, then a test board on :4679 with the fake
  cmux and `tools/stub-open.mjs`, driven in headless Chromium at 1440x900
  and 390x844 (the count, opening on the newest, arrows, the strip, Esc,
  swipe; zoom by wheel, ctrl+wheel, WebKit gesture events, drag, double
  click, Fit and Esc at 1440x900, and a real two-finger pinch, pan,
  double tap and swipe through CDP touch events at 390x844), and a real board of 2026-11-03: a 1273x740 pane with a
  permission prompt whose terminal rules are 200 columns wide and a long
  page scrolled down, checking that no screen text runs out of the answer
  card or the Live screen, each rule is one row, the Live screen never
  covers the picture card and the gallery opened from there covers the
  window. `GL_WEBKIT=1` runs it all in WebKit (cmux's browser) instead,
  without the swipe (WebKit has no Touch constructor). The pictures are the
  mockup's own placeholders drawn to PNG.
  `--shots` saves the gallery in light and dark on both. Touches only
  `.tmp/`.
- `node tools/gallery-card-test.mjs [--shots <dir>]`: the picture card,
  variant B. A test board on :4689 with the fake cmux and three sessions
  that showed 6, 2 and 1 pictures, driven headless at 1273x740 (the card
  173 px tall in the 462 px column) and 390x844 (128 px at 342): the
  tiles' places and sizes, every tile 16:9, newest first, the count on the
  big tile, each tile's name, each tile opening the gallery on its own
  picture (click, tap, Tab and Enter, focus back on close), the 2 and 1
  picture cards, and the right column still pinned (in the 740 px pane and
  in a 560 px window it does not fit). `GL_WEBKIT=1` runs it in WebKit.
  `--shots` saves the card in light and dark at both sizes, the mockup's B
  frames and each pair side by side. Touches only `.tmp/`.
- `node tools/plan-files-test.mjs`: files in planning: the References
  format and brief round trip, the attached-file guard, the planner call's
  argv (Read for exactly the attached files, the strict settings kept), the
  start prompt, then a test board on :4677 with the fake cmux and
  `tools/stub-plan-claude.mjs` (which records its argv with
  `STUB_PLAN_ARGV_FILE`): the inbox route, a draft, a comment and a chat
  message with files, the picture route, and Start writing References into
  the brief and the launch command (the fake cmux records `new-workspace`
  and refuses it). Touches only `.tmp/`.
- `RAVENRY_HOME=<scratch> node tools/repeats-run.mjs [--seed|--view]`: one
  detector run (or the seed only, or the Suggested rows) outside the board,
  using that RAVENRY_HOME's registry settings. It refuses to run without
  `RAVENRY_HOME` (or `MC_HOME`).
- `node tools/shoot-views.mjs <outDir> [--url ...] [--idea name]`: headless
  shots of the phase D views at 1440 and 390 wide.
- `node tools/plans-test.mjs`: Plans on crafted input under `.tmp/`: the plan
  format's parse, write and round trip, old plans read exactly as the parser
  before plans read them (every brief in docs/ and, read only, the drafted
  briefs), the safe write and its backup, the draft schema check, revision
  highlighting, gate detection, the gate alert through a local stub webhook,
  and the Objectives row. `tools/stub-plan-claude.mjs` stands in for the
  model on test boards (`MC_PLAN_COMMAND`). Env for tests:
  `MC_ALERT_ALLOW_TEST=1` lets a test board alert on its own `mc-test`
  workspace.
