# Paper Boat

Goal: An osu!-style rhythm game in VR.
Stage: Prototype

## Rules
- Pictures first.

## Plan
### Long notes on the paths
Runs on its own. Started: 2026-11-03 14:02. Not in the plan: stop and ask.
Goal: "Make long notes on the paths feel good"
Rules: work the steps in order.

- [x] Do: Research how other rhythm games show long notes (at least 8 games)
  - Proof: 6 of 9 use a held trail, 2 a ribbon, 1 neither. docs/research/long-notes.md (14:40)
- [x] Branch: What do most of them use? (most = more than half)
  - [x] If a held trail: build the trail. Taken, 6 of 9 (14:41)
  - [-] If a ribbon: mock up the trail and the ribbon side by side, then ask me which
- [x] Do: Build the held trail
  - Proof: committed a41c9e2 (16:05)
  - Hand-off here (16:12)
- [x] Done when: GestureTests pass in the Unity editor, and a screenshot shows the trail
  - Proof: 14 passed, 0 failed (17:02)
  - Proof: shots/trail-held.png, looked at (17:04)
- [?] Gate: Ask me before installing on the headset
  - Choices: Install on the headset | Not yet
  - Question: The trail is built and the gesture test passes. Install it on the headset now?
- [ ] Do: Install on the headset

Log:
- 14:02 Started from your words, after you checked the steps
- 16:12 Picked up after a hand-off at step 4
- 17:06 Step 5: gate reached

### Gesture mechanic: strikes for beats, paths for melodies
- [x] Strikes
- [x] Paths
- [ ] Legato line
  - [ ] an old-style indented task

## Next step
Wait for the gate.

## Hand-off
- 2026-11-03 16:12 Handed off at step 4.

## Notes
- [ ] "a note"
