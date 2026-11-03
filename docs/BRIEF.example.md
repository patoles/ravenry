# Ravenry

Goal: One local board that shows every project running in cmux at a glance, so you know in one look which agent needs you, and can answer it without hunting for the tab.
Done means: You follow all your projects from the board for a full day without opening a cmux tab just to check on one.
Kind: Local web tool (Node, no build step)
Stage: Build

## Rules
- Never type into, select, rename or close an existing cmux workspace in tests. Test on a scratch workspace and close it.
- Browsers run headless only.
- No em dashes anywhere.

## Plan
### Phase A: live, read-only board
- [x] cmux adapter, the only module that calls cmux
- [x] State per session from screen, title, transcript and hook record
- [x] Context per session from the transcript
- [x] Registry mapped to workspace UUIDs, shared folders flagged
- [x] BRIEF.md format and parser
- [x] Projects view live over SSE

### Phase B: answer from the board
- [x] Composer types into the chosen Claude surface
- [x] Files saved to the project's .inbox, paths appended
- [x] Add as note writes to the brief
- [>] Prove a message and a path land in a scratch workspace

### Later views
- [x] Objectives, Ideas, Rules and Ship views (phase D)
- [x] Hand-off at 50% context, at a clean point

## Next step
Use the board for a day and say what is missing.

## Hand-off
- 2026-11-02 22:30 Phases A and B built; screenshots in docs/shots.
Quick answers: Looks right | Show me first

## Notes
- [ ] "is there a way to prompt from the interface when the agent waits an answer, and paste files?"
- [x] "when there's no picture it should leave the space instead of showing a placeholder"
- [x] "Context should probably be near the top"

## Pictures
- shots/desktop-dark.png | The board on a desktop, dark theme
