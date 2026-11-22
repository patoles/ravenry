# Roadmap

What comes next, in order. Each item names its row in
[docs/FEATURES.md](docs/FEATURES.md), which says how it is checked and where
each app stands. An item is ticked when it ships to testers. The board's
Objectives page shows this file as "done of total".

## Shipped in 0.1.74

- [x] Start, continue and move sessions from the phone (SESS-009, SESS-015 to SESS-018, MACH-007)
- [x] Add an iPhone on the Mac: the App Store code and link (ALERT-016)
- [x] A saved decision's toast says "the" once on the Linux app and the board (DEC-003)
- [x] A remote pane comes back by itself after the connection drops (sleep, a network change) (MACH-011)
- [x] The Dock icon shows how many sessions need you (ALERT-018)

## Shipped in 0.1.75

- [x] Resume after a restart: one card with Resume all (SESS-053)
- [x] Any number of assistants, not only Claude Code and Codex (groundwork for SESS-054, SESS-055)
- [x] OpenCode sessions, with its models, OpenRouter ones too (SESS-054)
- [x] Antigravity CLI sessions, after a short test of its hooks (SESS-055)

## Shipped in 0.1.76

- [x] On the phone, open a link and select and copy text (TERM-021, TERM-028)
- [x] Command palette (NAV-011) and rebindable keys (SET-018)
- [x] A plain program's status on the board (SESS-056)
- [x] A tap on an Android alert opens its card, also when Android folds alerts together (ALERT-019)
- [x] Model lists are read only when a menu needs them, never on a timer (SESS-051)

## Decided against

- The phone away from the Mac's Wi-Fi without Tailscale (PHONE-045): it needs a relay server that the project would pay for and depend on. Tailscale, free on the person's own account, stays the way.
