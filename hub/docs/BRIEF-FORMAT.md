# BRIEF.md format

A brief is one Markdown file per project that says what the project is for,
where it stands, and what is open. Agents keep it current; the board reads it.
It is plain Markdown so it reads fine in an editor, on GitHub and in cmux's
Markdown viewer.

The parser (server/brief.mjs) is tolerant: section names are matched without
case, unknown sections are ignored, and a missing section just shows nothing.
A project without a brief shows "No brief yet".

## Where it lives

`<project folder>/BRIEF.md` by default. Projects that share a folder cannot
share one file, so for them the board starts with no brief; set `"brief"` for
the project in `~/.ravenry/projects.json` to a path relative to the
project folder or an absolute one. The drafted briefs live outside the repos,
in `~/.ravenry/briefs/<project-id>.md`.

## Shape

```markdown
status: draft (from README.md, memory (3 notes), session recap 2026-11-02, git log), review me

# Project name

Goal: One or two sentences. What we are making and why.
Done means: How we will both know it is finished.
Kind: Free text. Web game, VR app, Mac menu-bar app, research, anything.
Stage: Free text. Idea, Mockup, Build, Trial, Live, or whatever fits.
Waiting on: Optional. Who or what, when the work is blocked on someone else.

## Rules
- Project rules, one per line.

## Plan
### First objective
- [x] A task that is done
- [>] The task being worked on now
- [?] A task waiting on you
- [~] A task waiting on someone else
- [ ] A task still to do

### An objective tracked elsewhere
Progress: 119 of 141 (PLAN-IOS.md)

## Next step
What happens next, in a sentence.

## Hand-off
- 2026-11-02 21:10 What the last session finished and where the next one starts.
Quick answers: Push you back | Slow you down

## Notes
- [ ] "A playtest note, in your words"
- [x] "A note that has been fixed"

## Pictures
- shots/latest.png | Alt text for the picture
- ![Home screen](shots/home.png)

## Ship
- [x] Notes fixed, each with its proof shot
- [x] Trial deploy and a full pass
- [?] Prod, on your call

## Parked
Since: 2026-09-10
Why: The reason it stopped.
Back when: What would bring it back.
```

## Fields

| Field | Where | Notes |
| --- | --- | --- |
| Status | `status:` line at the top | `status: draft (from <sources>), review me` marks a brief drafted from the project's own material; the Objectives view shows a Draft label until the line is changed or removed. |
| Title | `# Name` | Informational; the board uses the registry name. |
| Goal, Done means, Kind, Stage, Waiting on | `Key: value` lines before the first `##`, or a `## Goal` (etc.) section with a paragraph | Kind and Stage are free text, so non-game projects fit. |
| Rules | `## Rules`, one bullet each | |
| Plan | `## Plan`, one `###` per objective | Tasks are bullets with a state mark. A plan the board drafted is an objective too (Plans, below). Instead of a mark, a trailing `(now)`, `(waiting on you)`, `(waiting on others)` or `(done)` also works. An objective with no tasks can carry `Progress: N of M (source)`. |
| Next step | `Next step:` line or `## Next step` | |
| Hand-off | `## Hand-off` bullets, optionally starting with a date `YYYY-MM-DD HH:MM` | Shown first in the Hand-backs card. Indented sub-bullets (`State:`, `Next step:`, `Open items:`, `Key files:`, as the automatic hand-off writes them) belong to the bullet above and are not shown as their own rows. A `Quick answers: a \| b` line (also allowed at the top or as its own `## Quick answers` section) becomes the quick-answer buttons while the project needs you. |
| Notes | `## Notes` bullets, `[ ]` open, `[x]` fixed | "Add as note" on the board appends `- [ ] text (added <time>)` here, creating the section when it is missing. A trailing `(fixed)` also marks a note fixed. |
| Pictures | `## Pictures` bullets: `path \| alt`, `path: alt`, or `![alt](path)` | Paths are relative to the brief's folder. Only listed files that exist are served. After the listed ones comes the project's latest picture, picked by the board (server/pictures.mjs) from the project's current session only (the one the board shows for it): the newest image its main transcript showed you (its own Read of an image, or an image path it wrote in its text to you, outside tool calls). Never a subagent's transcript, a path in a tool call's input or a path in tool output. No older sessions, no scan of the folder. Only from the project's folder or the current session's scratchpad, at most 15 MB and 30 days old. When the current session changes (a hand-off's fresh session), the old picture goes and nothing shows until the new session shows an image. No listed pictures and no image shown in the current session means no picture block at all. |
| Parked | `## Parked` with `Since:`, `Why:`, `Back when:` | Shown on the card of an idle project. |
| Ship | `## Ship`, one task bullet each, same marks as the plan | The checklist on the Ship view. `[?]` items count as "waiting for your call". |

## Plans

A plan the board drafted with you (docs/design/Plans.dc.html, server/planfmt.mjs)
is one objective under `## Plan`, so every checklist on the board still reads
it, and you or the agent can edit it in any editor:

```markdown
## Plan
### Long notes on the paths
Runs on its own. Started: 2026-11-03 14:02. Not in the plan: stop and ask.
Goal: "Make long notes on the paths feel good"
References:
  - .inbox/trail-look.png: I like this style
Rules: work the steps in order; tick a step [x] only with a Proof line ...

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
```

- An objective is a plan when it has the `Runs on its own.` line or a step
  tagged `Do:`, `Done when:`, `Branch:` or `Gate:`. Every other objective is
  read exactly as before.
- Header lines: `Runs on its own. Started: YYYY-MM-DD HH:MM.`, `Goal:` (the
  sentence you gave the board, where the design said "In your words"),
  `Rules:` (how a plan runs, so a session that only reads the brief knows
  them), and `State: paused (time)` or `State: stopped (time)`, written by the
  board's Pause and Stop. No `State:` line means running.
- `References:` (optional, right under `Goal:`): the files you attached
  while planning (the planning sheet's goal, chat and comment boxes save them
  into the project's `.inbox/`), one indented bullet each, `- <path from the
  project folder>: <what it is for, in your words>` (the words you sent the
  file with, like "I like this style"), or the path alone. A session reads
  them before the first step: the start prompt names each one with its words,
  a changed plan's prompt and a fresh session's after a hand-off say to read
  them too. On the full plan a picture shows as a small thumbnail (served
  only while it passes the picture rules below), anything else as a file chip.
- Steps: `Do` an action, `Done when` a condition proven by a command result,
  a number or a screenshot, `Branch` a question with `[ ] If <outcome>: <what
  then>` arms (the one taken `[x]` with `Taken, <evidence>`, the others
  `[-]`), `Gate` a stop where you decide, with its `Choices: a | b`.
- Sub-bullets: `Proof: <evidence> (HH:MM)` (a step is ticked only with one),
  `Note:`, `From your rules: <rule>` (a gate the board added from your
  CLAUDE.md), `Question:` (written at a `[?]`), `Answer: <choice> (HH:MM)`
  (written by the board when you answer), `Hand-off here (HH:MM)`.
- `Log:` after the steps: `- HH:MM what happened`. The board logs Started,
  each answer, Pause, Resume, Stop, a change and "Picked up after a hand-off
  at step N".
- Times without a date follow the start day (the next day when the clock
  goes back). A plan is done when every step is `[x]` or `[-]`; done and
  stopped plans stay in the brief as checklists.
- A proof that names an image (`shots/trail-held.png`) shows as a thumbnail,
  served only while it passes the picture rules (the project's folder or its
  current session's scratchpad, at most 15 MB and 30 days old).

## Plan files in the repo

The board also reads the plan files a project already keeps (server/plans.mjs)
and shows each one with checkboxes as a count-only objective, so a brief does
not need a `Progress:` line for them. Which files, and who owns them in a
shared folder, is in docs/DEVELOPING.md (Objectives). Counts are shown as the file
states them, with its age, never corrected.

## Task states

| Mark | State | Board |
| --- | --- | --- |
| `[x]` | done | green check |
| `[>]` or `[now]` | now | blue dot, "Now" |
| `[?]` or `[you]` | waiting on you | orange ring, "You" |
| `[~]` or `[wait]` | waiting on others | dashed purple ring, "Someone else" |
| `[ ]` | to do | grey ring |
| `[-]` | a branch arm (or step) not taken, in a plan | dimmed; counts as finished |

See docs/BRIEF.example.md for a filled-in brief (this project's own).
