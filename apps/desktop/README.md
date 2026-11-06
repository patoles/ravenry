# Ravenry desktop app

Placeholder. Nothing is built here yet.

The desktop app will be an Electron window with xterm.js panes: the board in
its sidebar layout, the terminals, the first-launch screen, a signed and
notarized DMG with auto-update on macOS, and a Linux build.

It holds no terminals itself. Sessions live in `ravenryd` (../../daemon), so
they survive the window closing, restarting or updating, and the window
talks to `ravenryd` and to the hub over the same protocol a remote machine
uses (../../packages/protocol, ../../docs/ARCHITECTURE.md).

Licence: GPL-3.0-only (../../LICENSING.md).
