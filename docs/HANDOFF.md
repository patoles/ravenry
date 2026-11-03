# The clean context hand-off

Around half context, a long session used to need asking to "sum up and
continue in a new session". This automates it, and hands off only at a clean point: the task
finished, the work committed, nothing running.

## How it works

1. **Queued.** The context bar has an orange tick at the clean-point line
   (50% unless changed in Settings, below). Once a session passes it,
   its project shows the blue flag "Hand-off after this task" and the sheet
   shows the four clean-point checks. Nothing happens to the session yet.
2. **Requested.** At the session's next stop (the end of a Claude turn), the
   Stop hook `hooks/handoff-stop.mjs` blocks the stop once and tells Claude:
   if you are mid-task, have background agents or tests running, or are
   waiting on the user, reply `Hand-off deferred: not at a clean point.` and
   carry on; otherwise write the hand-off, commit, and say so in one line.
   The hook asks again at later stops until the hand-off is written.
3. **Written.** Claude adds a dated bullet at the top of the `## Hand-off`
   section of the project's BRIEF.md, with `State:`, `Next step:`,
   `Open items:` and `Key files:` sub-bullets, and commits. Without a
   BRIEF.md it writes `HANDOFF.md` at the repo root (`HANDOFF-<project>.md`
   when two projects share that folder). Either the hook (at the stop after)
   or the board (once the session is at rest) sees the section change.
4. **Resumed.** The board opens a NEW tab in the same cmux workspace, next
   to the old one, not focused, in the session's folder, running
   `claude 'Read the Hand-off section of BRIEF.md and continue from it.'`.
   It does this once per hand-off: the marker records `resumeStartedAt`
   before cmux is asked for anything, so restarts and later ticks never open
   a second tab. The old tab is never touched; it reads "Handed off" on the
   board, not as a hand-back.

**Ceiling.** Past the ceiling (70% unless changed) the hook's wording changes: do not start the next
step, finish or safely stop the one in hand, commit (a work-in-progress
commit is fine) and hand off now, before Claude Code compacts the session.

**Off.** With "Hand off automatically" off in Settings (`handoffEnabled:
false`) no line asks on its own: the hook treats the threshold and ceiling
as never reached, the board shows no tick and no queued hand-off, and a
session queued by the line before it was turned off is not asked either.
Hand off now still works.

**Hand off now.** The sheet's button asks for a hand-off whatever the
context, and whether or not hand-off is on: it writes a request marker the hook acts on at the session's next
stop, with the same clean-point rule. A session sitting idle at its prompt
has no next stop until it gets a message, so the sheet says to send one.

## Plans and hand-offs

A plan (docs/BRIEF-FORMAT.md, Plans) lives in the brief, so it survives a
hand-off: the fresh session reads it where the old one left it. The rules a
session runs a plan by are in the start prompt the board sends and in the
plan's own `Rules:` line:

- Work the steps in order, from the first step not marked `[x]` or `[-]`.
- Tick a step `[x]` only after a `- Proof: <evidence> (HH:MM)` line under it
  that holds real evidence: a command and its result, a number, or the path
  of a screenshot the session looked at.
- At a Branch, mark the arm the work answered `[x]` with its evidence and the
  others `[-]`.
- At a Gate, or at any outcome the plan did not foresee, mark the step `[?]`,
  write `- Question:` and `- Choices: a | b` under it and a Log line, then stop
  and end the turn with the question. Never skip a gate, never answer one.
- After a hand-off, read the plan first and carry on from the first step not
  ticked.

When the board opens the fresh session for a project whose brief has a
running plan, its prompt adds: "The brief has a running plan, "<title>",
under ## Plan: read it first and carry on from the first step not ticked, by
the rules written in it." (with ", and the References listed under its Goal"
after "read it first" when the plan has References, the files the user
attached while planning) and the board writes "Picked up after a hand-off
at step N" into the plan's Log, N being the first step not ticked. The Plan
card and the full plan show that line where the fresh session took over.

## What the hook checks by itself

The hook never blocks a stop when:

- `stop_hook_active` is set (Claude is already answering a stop hook), so it
  can never loop;
- `background_tasks` (Stop hook input) lists a task still running, or
  `session_crons` lists a scheduled loop. Claude Code lists only tasks it
  holds as `running` or `pending` (`{ id, type, status, description,
  agent_type | command }`), but a long session can keep finished ones listed
  for hours, so `server/tasks.mjs` drops a task whose finished notification
  is in the session's transcript (or whose subagent has finished), and Claude
  Code's own housekeeping (`dream`, `auto-mode scan`, `memory import`). Any
  other status counts as not running, so an unknown word can never hold a
  hand-off back. The events hook logs each list it gets (ids, types and
  statuses only) to `~/.ravenry/logs/background-tasks.jsonl`;
- Claude's last message ends on a question (the question stays on screen for
  the user; the hook asks after their answer);
- the hand-off for this session is already written.

Everything else (mid-task or not) is Claude's call, because only Claude
knows. The board's four checks are a picture of the same thing: past the
line, the session not working, `git status` showing no tracked changes in
its folder (untracked files are ignored, since shared trees always hold
some), and no background agents on its screen.

Below the line, with nothing requested, the hook reads only the tail of the
transcript and exits 0 with no output: about 40 ms on a 176 MB transcript.
Any error also exits 0 silently, so a broken hook can never stop a session.

**Written while still queued.** A session can write its hand-off before
any stop was a clean point (the user asked it by hand, or tasks kept it
queued). The hook takes a fresh base at every queued stop, so the section
hash cannot show it. Instead a queued marker counts as written when the
section's newest bullet is dated at or after the minute it was queued and
the session's own transcript wrote to the hand-off file since then; the
hook checks at the next stop, the board once the session is at rest. If a
fresh session is already open in the same cmux workspace (started after
the queue, first prompt "Read the Hand-off section of"), the board marks
the hand-off resumed on it (`resumedBy: "found"`) instead of opening a
second one. A session chosen on the Sessions card moves to the fresh one
when it hands off, and the card lists sessions newest first, handed-off
ones last.

## Markers

`~/.ravenry/handoffs/<session_id>.json`, one per session, written
atomically. `state` moves `queued -> requested -> written -> resumed`, and
`history` records each change with its time. Other fields: `pct`, `tokens`,
`handoffFile`, `handoffBase` (a hash of the Hand-off section at the moment
of the request; the hand-off counts as written when the section changes from
it, so a note added to the brief does not), `workspaceId` and `surfaceId`
(from cmux's `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID`, which Claude Code
passes to its hooks), `manualAt`, `asks`, `lastCheck`, `resumedAt`,
`resumeSurfaceRef`, `resumeError`. Delete a marker to forget a hand-off.

## Settings

The gear in the board's top bar opens Settings
([docs/design/HandoffSettings.dc.html](design/HandoffSettings.dc.html),
variant A, plus the on/off switch): "Hand off automatically", one track with
an orange thumb for the clean-point line and a red one for the ceiling
(drag them, or step by 5 with minus and plus; each shows its tokens), the
200k | 1M context window and "Open a fresh session after a hand-off". Every
change saves at once; the footer says "Saved. Applies at each session's next
stop." or, in red, what failed (the control goes back to the stored value).
Both values run 10 to 95, and the ceiling stays at least 5 points above the
line: the thumb stops there, the button that would cross greys out, and an
orange line says why. Neither value pushes the other. A signed-in phone may
change these too.

`GET /api/settings/handoff` reads them; `POST /api/settings/handoff` takes
any of the five keys below except `handoffCommand`, with the board's write
guards (the `X-Ravenry` header and the Origin check). It refuses
anything else with 400 and leaves the file as it is: an unknown key, a
wrong type, a value out of range, a window other than 200000 or 1000000,
or a pair less than 5 points apart. It writes only the keys it was sent,
atomically (temp file and rename), after copying projects.json to
`projects.json.bak-YYYYMMDD-HHMMSS` beside it, at most once every 10
minutes so a round of clicks leaves one backup from before it. The hook
reads the file at every stop, so a change applies at each session's next
stop; the board picks it up at once.

They live in the `settings` of `~/.ravenry/projects.json`:

| Setting | Default | |
| --- | --- | --- |
| `handoffEnabled` | true | false: no session is asked on its own; Hand off now still works. |
| `contextWindow` | 1000000 | The transcript does not record the window. |
| `handoffThreshold` | 50 | Percent. The tick on the bar. |
| `handoffCeiling` | 70 | Percent. "Hand off now" wording. |
| `handoffAutoStart` | true | false: the sheet offers "Start fresh session" instead. |
| `handoffCommand` | `claude` | What the fresh tab runs; the prompt is appended as one quoted argument. |

## Install

One command installs both of Ravenry's hooks, this Stop hook and the
board's events hook (docs/STATE-RULES.md, "Events first, screen second"),
into `~/.claude/settings.json`:

```sh
node tools/install-hook.mjs            # install (or point at this Node/repo again)
node tools/install-hook.mjs --dry-run  # say what would change, write nothing
node tools/install-hook.mjs --remove   # take both out
node tools/install-hook.mjs --settings <file>   # work on another settings file
```

It backs the file up first (`settings.json.bak-<time>`), is idempotent, and
touches only entries that run `ravenry/hooks/handoff-stop.mjs` or
`ravenry/hooks/events.mjs`, or the same scripts under the pre-rename path
`mission-control/hooks/`, which it rewrites in place (a second copy of a
script on the same event is dropped); every other hook (Agent Flow's
included) and setting stays as it is. The entries it writes look like this (the
events hook gets the same entry on SessionStart, SessionEnd,
UserPromptSubmit, Notification and Stop, with `"timeout": 5`):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/you/.nvm/versions/node/v22.22.0/bin/node /Users/you/projects/ravenry/hooks/handoff-stop.mjs",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Stop hooks take no matcher. `timeout` is in seconds; the hook normally
finishes in well under one. The node path is absolute because hooks do not
load the shell's nvm setup. A new session always picks the hook up; `/hooks`
in a running session shows whether that one has. The board must
be running for the fresh session to start; the hook and the hand-off itself
work without it.

## Tests

- `node tools/handoff-hook-test.mjs [<real transcript>]` pipes crafted Stop
  input into the hook against a throwaway RAVENRY_HOME under `.tmp/`: below the
  line, past it, stop_hook_active, asking again, written, a note that is not
  a hand-off, ceiling, manual request, background task, question, no brief,
  hand-off off (past the line, past the ceiling, a manual request, a
  session queued before it was turned off), the line moved to 60, garbage
  input, and the speed on a copy of a real transcript.
- `node tools/handoff-e2e.mjs docs/shots/phase-c` runs the whole loop on a
  scratch cmux workspace it creates (`mc-test-handoff`, never focused) and
  closes, with a test server on :4601 that reads only a scratch registry,
  fake transcripts and a fake brief. The fresh tab runs `printf` instead of
  `claude`, so no real session starts.

## Known limits

- "Mid-task" is Claude's judgement. The hook can only see background tasks,
  scheduled loops and a closing question.
- A session at rest when its context crosses the line (or when "Hand off
  now" is pressed) waits for its next stop, which needs a message.
- The fresh session reads the hand-off; the old tab stays open for the user
  to close.
