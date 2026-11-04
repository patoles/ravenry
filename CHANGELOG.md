# Changelog

## 0.3.2

- On a phone the gallery's thumbnails stay small whatever the number of
  pictures: each is a sixth of the strip, centred. Before, they split the
  strip's width between them, so with one picture its thumbnail was a
  full-width square that took more room than the picture above it.

## 0.3.1

- A new session for a project (Revive from its brief, New session, a
  plan's start) starts the project's own assistant, else Settings' "Start
  new sessions with", else Claude Code, and its "New sessions:" switch
  shows the same; before, a project with no assistant of its own took the
  assistant of its newest session, so a throwaway Codex check run in its
  folder made Revive start Codex. A hand-off's fresh session still
  continues on the assistant of the session it hands off from.
- After Start session with the New session switch on, the sheet moves to
  the new session as soon as it shows on the board (its Live screen, the
  message box back to Send for it), on a desktop and a phone. Until then
  the message box's card reads "Starting a new session..."; after 30 s it
  says the session has not shown and the sheet stays where it was. Picking
  another session in the meantime keeps that pick. Revive from the brief
  and a plan that opens a new session follow the same rule. The board
  reads a tab it just opened every 2 s for a minute, until Claude shows in
  it, instead of every 10 s as for a plain shell, so the move does not wait
  on the tab's title. Before, the sheet stayed on the session that was
  selected, so the new one had to be found by hand.
- On a phone the Live screen has no Copy button: a tap on highlighted code,
  a code block or an inline chip, copies it and rings it green with a
  check, and a code block takes the whole width the pill used to take. A
  desktop keeps the Copy icon inside a code block.

## 0.3.0

- Code on the Live screen: a fenced block is now one code block, however
  the terminal or the screen width wraps it, with one Copy at its end that
  copies the block's own text (a command with `&&`, quotes or a `<code>`
  placeholder exactly; a block of several lines with its indentation and
  blank lines). A `! ` command alone on its line is a code block too.
  Inline code in a sentence is a chip at the text's line height with no
  button in the line: on a desktop a Copy floats over it on hover, on a
  phone a tap copies it. Before, a fenced line was drawn as an inline chip,
  so a long command wrapped into pieces that looked like separate chips,
  and every `! ` span, even mid-sentence, carried a 32 px Copy pill on a
  phone that pushed its line apart.
- The hand-off no longer asks at every stop. After a session defers, the
  hook waits for a new prompt from the user, Hand off now, the ceiling, or
  10 minutes before it asks again; task notifications and its own reason
  fed back do not count. The board says when it asks next. Waiting on the
  user's answer is now a clean point: the hand-off carries the open
  question in its open items.
- The board can start Codex as well as Claude Code. A registry setting,
  `startWith` (`claude` or `codex`, Claude Code by default), picks the
  assistant New project starts, and a project created with its own
  `assistant` keeps it. Revive, New session and a plan's start continue a
  project with its own assistant, else the one of its newest session. When
  the chosen assistant is not installed the board starts the other one and
  says so. Settings opens on an Assistant section, "Start new sessions
  with" Claude or Codex; New project has an Assistant row under Folder,
  set from Settings; in a Codex project the New session switch says it
  opens Codex. `GET` and `POST /api/settings/assistant` read and write the
  setting.
- Plans, the Ideas thread, Get 3 directions and idea mockups follow the same
  setting: with Codex they run `codex exec` (read-only, no tools, no hooks),
  so a Codex-only Mac keeps them. They log tokens only, since Codex reports
  no cost.
- When the model in Codex's `config.toml` is one the account refuses, the
  board's calls run again on `codexModel` (a registry setting) or Codex's own
  default, and the sessions it starts get `-m` with that model. Codex's
  config is never edited.
- Rule suggestions read Codex's sessions too (its rollouts, the user's own
  prompts only), with the same clustering and thresholds. A suggestion says
  whose sessions it came from, and accepting it writes to CLAUDE.md for
  Claude Code's, AGENTS.md (`~/.codex/AGENTS.md`, or the project's) for
  Codex's, both when both, with the same backups and guards. The
  detector's calls run on `codex exec` when new sessions start with Codex.
- In Ideas, a reply Codex wrote is stored and shown as Codex's. Busy,
  restart and error lines in Ideas and Plans, and the page's lines about a
  project's sessions, name the assistant actually running (for example
  "Codex is still answering the last one.").
- `POST /api/project/assistant` sets a project's assistant after it was
  created (or clears it); the next New session, Revive and plan start use
  it.
- The project sheet's meta line ends on "New sessions:" and a Claude /
  Codex switch: the assistant this project's new sessions start with (New
  session, Revive, a plan's start), saved at once. Running sessions keep
  theirs. Its words sit on the meta line's baseline and the line keeps its
  height; on a phone the label and the switch move to a row together.
- Nothing changes for Claude Code: the same commands, the same `claude -p`
  calls (docs/ASSISTANTS.md).
- A session in a cmux workspace no project lists is on the board: in Needs
  you by its folder name when it waits on you (Codex's "Trust this folder?"
  included), else in a "Not in a project" group under Idle. Its sheet
  answers like any other and offers Add to a project and New project from
  this folder.
- Every session carries a small "Claude" or "Codex" tag: the Sessions card,
  the Live screen header, the Sessions page and folder rows. The top bar
  reads Sessions, and the Sessions page lists Codex sessions with their
  memory (Close idle still ends Claude Code sessions only).
- Your rules shows each scope's CLAUDE.md beside its AGENTS.md.
- A Codex menu's text showed twice on the Live screen; it shows once. The
  Live screen's tooltip names the session's assistant.
- The Live screen shows a run of the same background notice once, with a
  count: 16 rows of `Agent "X" is waiting on its own background work` are
  one row ending in "×16". Another agent's notice, another text such as
  "finished", or any other line in between starts a new row.

## 0.2.0

- The board follows OpenAI Codex sessions too, beside Claude Code's: their
  state (Needs you, Working, Idle), the Live screen, the context bar (with the
  model's own window), alerts, replies from the board, Codex's approval and
  folder-trust menus, and the hand-off at half context. `ravenry setup` adds
  the board's hooks to `~/.codex/hooks.json`, with the trust entries Codex
  needs in `~/.codex/config.toml`, only when Codex is installed; every other
  entry stays, and `ravenry uninstall` takes out only Ravenry's.
- Not shown for a Codex session: the pictures it showed, background tasks,
  its memory on the Sessions page (Close idle is Claude Code only), recaps,
  and its AGENTS.md in the Rules view. Codex started outside cmux runs in a
  shared daemon whose hooks cannot say which tab a session is in, so there
  the board finds the tab from the screen and the folder (cmux) or shows the
  session watch only.
- Nothing changes for Claude Code: its sessions read exactly as before
  (docs/ASSISTANTS.md).
- In Ideas, a seed typed while Add idea was still on its way is no longer
  wiped when its answer arrives, nor sent into the new idea's pitch box.
- A New session switch in the project's message box: on, Start session opens a new tab in the project's folder running Claude with your words and files as its first message (empty, it reads the brief like Revive).

## 0.1.2

- Replying from the board works again while Claude Code shows its dim
  suggested reply in the prompt. A plain read of the screen cannot tell that
  suggestion from typed text, so the board refused to send ("There is
  half-typed text in its prompt") and showed the session as half typed. The
  board now reads the prompt's styles in cmux, and elsewhere types one
  character to look before it sends or closes (taken back at once), so a
  suggestion is typed over and a real half-typed reply is still refused and
  left as it was.
- The gallery's picture zooms: pinch, the wheel or a trackpad pinch, or a
  double tap or click, and a drag pans while zoomed. Fit or the first Esc goes
  back to the whole picture, and each picture opens whole.
- The README shows the Ravenry logo at the top.

## 0.1.1

- The hand-off no longer waits forever on watches Claude Code keeps for itself: a
  monitor counts as running work only when a Monitor call started it. Pages
  published with the Artifact tool each keep such a watch, and six of them held
  a session past its hand-off line for hours.

## 0.1.0

The first package.

- `npm i -g ravenry-app`, then `ravenry`: starts the board on :4600 and opens it
  (in a cmux browser pane, an iTerm2 tab, or the default browser).
- `ravenry setup`: checks macOS, Node, Claude Code and the terminal, shows the
  two hooks it adds to `~/.claude/settings.json`, and asks first (backup
  before writing). `ravenry doctor` and `ravenry uninstall` (`--purge`).
- Supported terminals: cmux and iTerm2. Sessions in any other terminal are
  watch only, with a one-line suggestion to install iTerm2.
- A new board starts empty: projects appear from their running sessions.
- Rule suggestions (a daily `claude -p` on your own login) are off until
  setup asks.
- Playwright is optional, only for idea mockup pictures.
- Licensed under Apache 2.0 (LICENSE, NOTICE). The name "Ravenry" and its
  logo are trademarks (TRADEMARK.md).
