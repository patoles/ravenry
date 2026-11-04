# Changelog

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
