# Who acts as the person on the hub's API

A checkpoint exists so that a person answers it, and so does every other
write that stands for a person's decision: passing a plan's gate,
starting or stopping a plan, deciding a hand-off, saving a rule into
CLAUDE.md or AGENTS.md, closing or starting sessions, adding machines,
pairing the phone, installing hooks, typing into a session from the
board's composer. An agent must not be able to do any of these for the
person with `curl`.

The rule is the daemon's (packages/protocol/PROTOCOL.md section 4, Who
acts as the person), and `server/person.mjs` applies it to the HTTP API:

- **A person row** is refused with 403 (`notPerson: true`, and a plain
  "Only a person can ..." message) when the request comes from a program
  on this machine that runs inside a ravenryd pane or in an ssh session.
  Nothing has happened by then: the check runs before the body is read.
  `ravenryd peer --tcp <its port> --to <the hub's port>` finds the
  process that holds the connection and judges it with the daemon's own
  code. The board page in a browser and the desktop app run outside
  every pane and pass.
- **The phone** (another address, with its device token) is the person.
- **An open row** is fine for agents too: it adds something the person
  reads later, and runs nothing, removes nothing and decides nothing.
- **A POST under `/api/` that no row names is a person's**, so a new
  endpoint is closed until it is classed here.
- **Without ravenryd** the board cannot judge. A checkpoint answer is then
  refused, as before. Any other person row is taken when no ravenryd
  runs in the board's runtime folder either: then no process here is
  inside a pane (a board that drives cmux, iTerm2 or Rex only). An ssh
  session cannot be told apart in that case. When a daemon runs but the
  board cannot find its command, the row is refused.

When a row is ambiguous it gets the safer class, and its reason says so.

## A plan's gate

A plan's gate lives in the brief (BRIEF.md, docs/BRIEF-FORMAT.md, Plans),
and the agent running the plan edits that file: it could tick its own
gate `[x]`, write an `Answer:` under it, or take the gate out. Refusing
`curl` to `/api/plan/answer` does not stop that, so the board never takes
a gate as passed from the file alone:

- **The hub keeps its own record** of gates, `<RAVENRY_HOME>/plan-gates.json`
  (`server/gates.mjs`): per plan, the gates the person started it with and
  the gates the person passed. Only person rows write it: `/api/plan/start`
  (the plan's gates), `/api/plan/answer` (a gate passed),
  `/api/plan/confirm` and `/api/plan/reopen`.
- **The plan runner** (`server/planfmt.mjs` derive) takes a gate as passed
  only when that record has the person's answer.
- **A gate ticked (`[x]` or `[-]`) in the file with no answer in the
  record** shows on the board as "Marked passed in the file, not by you",
  and the plan stays waiting there (even if the file also says the plan is
  done, or the session works on past it). A gate the person started the
  plan with that is gone from the file shows "Taken out of the file, not by
  you" the same way. The person **confirms** it (the record takes it as
  passed, or as taken out; one Log line) or **reopens** it (the gate is
  `[?]` again, put back if it was taken out, the file's Answer line goes,
  and the session is told to stop and wait at it). An answer to such a gate
  is refused until then.
- A plan is known by its brief, its title and its Started stamp, a gate by
  its words (and which of the plan's gates with those words it is), so an
  agent that edits them only makes a gate unknown, which makes it wait.
- The first time a hub has no record, it starts one from the briefs it
  knows: the gates passed in them then count as passed, so plans that ran
  before the record existed do not all stop.
- **Limit:** the record is a file of the user's. An agent that deletes it
  and then gets the hub restarted makes the hub start a new record from
  the gates ticked in the briefs at that moment. Like reading the hub's
  answer key, that is a deliberate attack, not a mistake
  (packages/protocol/PROTOCOL.md section 4, Limits).

Existing briefs keep their grammar: nothing new is written into them but
the Log lines of a confirm or a reopen.

## The table

55 person rows (16 of them judged ambiguous), 5 open rows. GET routes not
listed are reads and stay open; the two listed hand out a pairing secret.

| Endpoint | Class | Why |
| --- | --- | --- |
| `/api/checkpoints/answer` | person | Answering a checkpoint is the person's answer to an agent. |
| `/api/plan/answer` | person | Passing a gate is the person's answer; an agent would pass its own gate. |
| `/api/plan/confirm` | person | It passes a gate the file alone marked passed; an agent would confirm its own. |
| `/api/plan/reopen` | person | It reopens a gate the file alone marked passed and stops the session at it. |
| `/api/plan/start` | person | Starting a plan writes it into the brief and sends it to the session to run on its own. |
| `/api/plan/pause` | person | Pausing a plan is the person's call. |
| `/api/plan/resume` | person | Resuming lets a paused plan run on its own again. |
| `/api/plan/stop` | person | Stopping a plan is the person's call. |
| `/api/plan/change` | person | It opens the running plan for changes that Start then sends to the session. |
| `/api/plan/draft` | person | Judged (ambiguous): it runs the planning model on the person's account for a plan they then start. |
| `/api/plan/own` | person | Judged (ambiguous): as draft, from the person's own words. |
| `/api/plan/revise` | person | Judged (ambiguous): it runs the planning model again on the person's comment. |
| `/api/plan/edit` | person | It answers the planner's questions and reorders or removes steps of the person's draft. |
| `/api/plan/halt` | person | It stops the planning run the person started. |
| `/api/plan/discard` | person | It throws the person's draft away. |
| `/api/send` | person | The composer types the person's words into a session; an agent would answer its own prompts. |
| `/api/sessions/start` | person | Judged (ambiguous): it starts an assistant on the person's account, with a first prompt. |
| `/api/sessions/close` | person | Closing a session ends the assistant in it. |
| `/api/sessions/reopen` | person | Reopening starts an assistant again. |
| `/api/project/revive` | person | Revive and New session start an assistant, with the person's first message. |
| `/api/handoff` | person | A hand-off decision is the person's. |
| `/api/handoff/start` | person | It ends a session's turn and starts the fresh session now. |
| `/api/open` | person | Judged (ambiguous): it moves windows on the person's screen. |
| `/api/rules/<id>` | person | Saving a rule into CLAUDE.md or AGENTS.md changes what every session is told. |
| `/api/repeats/<id>` | person | Saving a repeated instruction as a rule changes CLAUDE.md or AGENTS.md. |
| `/api/project/new` | person | It makes a folder and a brief and starts a session. |
| `/api/project/brief` | person | It writes the project's BRIEF.md from the sheet, the plan included. |
| `/api/project/assistant` | person | A setting: which assistant the next sessions start. |
| `/api/project/add-workspace` | person | Judged (ambiguous): it changes which project a session belongs to. |
| `/api/project/open-folder` | person | It opens a window on the person's screen. |
| `/api/project/reveal-picture` | person | It opens a window on the person's screen. |
| `/api/project/choose-folder` | person | It opens a dialog on the person's screen. |
| `/api/machines/add` | person | Adding a machine pairs this hub with it over ssh. |
| `/api/machines/remove` | person | Removing a machine is the person's call. |
| `/api/machines/retry` | person | Judged (ambiguous): it runs ssh with the person's keys. |
| `/api/setup/hooks` | person | It changes Claude Code's and Codex's settings. |
| `/api/settings/handoff` | person | A setting the person chose; an agent could turn its own hand-off off. |
| `/api/settings/assistant` | person | A setting the person chose. |
| `/api/settings/projects-root` | person | A setting the person chose. |
| `GET /api/phone` | person | The code holds the phone's sign-in key: whoever has it acts as the phone. |
| `/api/phone/new-key` | person | A new key signs the phone out. |
| `GET /api/alerts/setup` | person | It shows the alert channels' tokens and topic. |
| `/api/alerts/switch` | person | Judged (ambiguous): an agent could silence the alerts that call the person. |
| `/api/alerts/desktop` | person | Judged (ambiguous): as the switch. |
| `/api/alerts/test` | person | Judged (ambiguous): it sends to the person's phone. |
| `/api/alerts/{telegram,telegram/find-chat,webhook,ntfy,ntfy/new-topic,ntfy/copy,done}` | person | An agent could send the person's alerts to itself. |
| `/api/ideas/add` | open | Adding an idea: the person sees it on the Ideas page and decides. |
| `/api/ideas/<id>/ref` | open | Adds a reference picture to an idea; nothing is replaced. |
| `/api/ideas/<id>/image` | person | Judged (ambiguous): it replaces the idea's picture. |
| `/api/ideas/<id>/update` | person | Judged (ambiguous): it rewrites what the person wrote. Adding one stays open. |
| `/api/ideas/<id>/kill` | person | Dropping an idea is the person's call. |
| `/api/ideas/<id>/say` | person | Judged (ambiguous): it runs a model on the person's account. |
| `/api/ideas/brainstorm` | person | Judged (ambiguous): it runs a model on the person's account. |
| `/api/ideas/brainstorm/clear` | person | Judged (ambiguous): it hides an error shown to the person. |
| `/api/ideas/<id>/mockups` | person | Judged (ambiguous): it runs a model on the person's account. |
| `/api/ideas/<id>/mockups/stop` | person | It stops a run the person started. |
| `/api/ideas/<id>/mockups/pick` | person | Picking a variant is the person's taste. |
| `/api/note` | open | Adds a line under Notes in the brief. |
| `/api/inbox/<project>` | open | Puts a file in the project's inbox folder; nothing is sent or run. |
| `/api/hook-event` | open | The hooks inside every session post it: it only makes the board look at events already on disk. |

## Tests

`tools/person-routes-test.mjs` (`RAVENRYD_BIN=../daemon/ravenryd`): every
route in `server/index.mjs` has a row and this page lists every row; then,
against a real board and a real ravenryd on scratch data, every person
row sent with `curl` from inside a real pane gets 403 and changes nothing
(no file of the board, its home, Claude's settings or the project, no
pane started or closed, the checkpoint and the plan's gate still open),
and so does a `curl` that left the pane's tree first (a double fork into
a session of its own, its environment wiped, a child of launchd or init),
the open rows go through from a pane, and the same calls from outside
every pane pass the check: the plan's gate is passed, the checkpoint
answered, a machine added and removed, the hand-off settings saved. In
between, a script in a real pane ticks the plan's gate in BRIEF.md and
writes an Answer under it: the plan still waits at the gate, marked passed
in the file, not by you, the hub's record holds no answer, and an answer
to it is refused; the person reopens it (the `[?]` is back), answers it
(the record has the answer), and confirms the next gate the pane ticks.
`tools/plans-test.mjs` covers the rest without a board: a gate taken out
of the file, a `State: done` written over a waiting gate, reopening a
removed gate, a plan change, and the record started from existing briefs.
Without `RAVENRYD_BIN` it runs the first part only (the hub job on Linux
CI); the daemon job runs all of it against its build.
