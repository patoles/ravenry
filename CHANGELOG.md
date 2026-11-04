# Changelog

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
