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
- **The phone** (another address, with its device token) is the person,
  on the board's port and on the phone port, both only while phone access
  is on
  ([../../docs/PHONE.md](../../docs/PHONE.md)). A pairing on the phone
  port from another address is the person too: its one-time code proves
  it. A phone's token used from this machine (an emulator, or a program
  that took it) proves nothing and is judged like any local caller.
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

87 person rows (23 of them judged ambiguous), 9 open rows. GET routes not
listed are reads and stay open; the two `GET /api/phone...` rows hand out a
pairing secret, and `GET /api/term` opens a terminal. Among the open
reads: `GET /api/decisions` (the ledger, which agents check before
asking), `GET /api/sessions/<id>/diff` (a worktree session's diff) and
`GET /api/checkpoints/<id>/variants/<n>` (a pick's pictures, from the
copies kept in Ravenry's data, HTML and SVG sandboxed) and `GET
/api/projects/<id>/files` (what each session of a project changed, from
its hooks and git) and `GET /api/sessions/<id>/review` (a worktree
session's review comments and the agent's replies).

| Endpoint | Class | Why |
| --- | --- | --- |
| `/api/decisions/add` | person | A decision the person adds is their own word, which every agent then follows (an agent records one through /api/decisions/record instead, marked as its own). |
| `/api/decisions/undo` | person | Taking a decision back is the person's call; an agent would undo the person's words. |
| `/api/decisions/edit` | person | Rewriting a decision changes what every agent follows. |
| `/api/decisions/remove` | person | Taking a decision off the record changes what every agent follows. |
| `/api/access/retry` | open | It asks macOS again whether the board may read the folders it has no answer for (`server/access.mjs`); it changes nothing and asks the person nothing (the app sends it after asking macOS itself). |
| `/api/checkpoints/words` | open | It words the checkpoints the caller sends (`server/cpwords.mjs`) and changes nothing; an answer's secret is never read. |
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
| `/api/keys` | person | The key bar presses the person's keys in a session's pane; an agent would answer its own prompts. |
| `/api/opened` | person | Every client opens on the project the person opened last (server/openon.mjs); an agent would move where the person lands. |
| `/api/sessions/start` | person | Judged (ambiguous): it starts an assistant on the person's account, with a first prompt. |
| `/api/sessions/resume` | person | It starts the assistant again on one of the person's sessions, in a Ravenry pane. |
| `/api/sessions/move` | person | It ends the assistant's other processes on one of the person's sessions and starts it again in a Ravenry pane, or ends the Ravenry copy. |
| `/api/sessions/close` | person | Closing a session ends the assistant in it. |
| `/api/sessions/<id>/comment` | person | It types the person's review comment into the session, as the composer does; an agent would steer another agent in the person's name. |
| `/api/sessions/<id>/merge` | person | Merging a session's branch into the project's is the person's call; an agent would merge its own work unreviewed. |
| `/api/sessions/<id>/discard` | person | It deletes the session's worktree and branch, uncommitted changes included. |
| `/api/sessions/<id>/unmerge` | person | It moves the project's branch back to before the merge and opens the session's work again: the person's call, as the merge was. |
| `/api/sessions/<id>/delete-branch` | person | It deletes the branch a merged session kept, which ends the way to undo the merge. |
| `/api/sessions/<id>/review/comment` | person | A review comment is the person's word on an agent's work, which the session is then told; an agent would review its own work in the person's name. |
| `/api/sessions/<id>/review/remove` | person | Ambiguous, so the safer class: it takes back what the person wrote before it was sent. |
| `/api/sessions/<id>/review/send` | person | It types the person's review comments into the session, as the composer does; an agent would steer another agent in the person's name. |
| `/api/sessions/<id>/filmstrip` | person | It types into the session, as the composer does, and puts a file in the project's inbox; an agent would steer another agent in the person's name. |
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
| `/api/project/model` | person | A setting: which model the next sessions start on. |
| `/api/project/add-workspace` | person | Judged (ambiguous): it changes which project a session belongs to. |
| `/api/project/open-folder` | person | It opens a window on the person's screen. |
| `/api/project/reveal-picture` | person | It opens a window on the person's screen. |
| `/api/project/choose-folder` | person | It opens a dialog on the person's screen. |
| `/api/machines/add` | person | Adding a machine pairs this hub with it over ssh. |
| `/api/machines/remove` | person | Removing a machine is the person's call. |
| `/api/machines/retry` | person | Judged (ambiguous): it runs ssh with the person's keys. |
| `/api/machines/install` | person | It runs ssh with the person's keys and puts ravenryd and its hooks in Claude Code's and Codex's settings on another machine. |
| `/api/machines/uninstall` | person | It stops ravenryd on another machine, which can end the sessions there, and takes its files and hooks off. |
| `/api/setup/hooks` | person | It changes Claude Code's and Codex's settings. |
| `/api/onboarding` | person | Judged (ambiguous): it hides the person's one-time hints, Learn ticks and the assistant's setup step for good, on every client. |
| `/api/setup/skills` | person | It changes Claude Code's and Codex's skills folders. |
| `/api/settings/handoff` | person | A setting the person chose; an agent could turn its own hand-off off. |
| `/api/settings/repeats` | person | They spend the person's quota reading what they typed; the person decides. |
| `/api/settings/assistant` | person | A setting the person chose. |
| `/api/settings/projects-root` | person | A setting the person chose. |
| `/api/settings/theme-import` | open | It makes a theme of the text the caller sends (`server/themeimport.mjs`) and answers with it; nothing is written, the client saves it. |
| `GET /api/phone` | person | The code holds the phone's sign-in key: whoever has it acts as the phone. |
| `/api/phone/new-key` | person | A new key signs the phone out. |
| `/api/phone/pair` | person | Pairing gives a device the person's power. On the phone port the one-time code from the computer proves it is the person's phone; from this machine it is judged like every person row. |
| `/api/phone/unpair` | person | It signs the device out, so its alerts stop: an agent could cut the person off. |
| `/api/phone/takeover` | person | It moves an iPhone's row and alerts to the device that asks: an agent could take the person's alerts over. |
| `/api/phone/push` | person | It sets where the device's alerts go: an agent could send the person's alerts to itself. |
| `/api/phone/devices/rename` | person | Judged (ambiguous): it changes the name the person reads on the phone card and on the phone itself, which an agent could use to pass one device off as another. |
| `/api/phone/devices/revoke` | person | Signing a device out is the person's call; an agent could cut the person off. |
| `/api/phone/access` | person | Phone access opens a port on the Wi-Fi and Tailscale for paired phones. |
| `/api/phone/away` | person | It puts Ravenry on the person's Tailscale as a device of its own, so their phone reaches this Mac from anywhere: an agent could open that way in, or cut the person off. |
| `/api/phone/away/{signin,cancel,signout}` | person | Signing in joins Ravenry to a Tailscale account (whoever signs in owns the way in); signing out takes the person's phone's way in away. |
| `GET /api/term` | person | It types into panes and reads their screens through the hub, which the daemons take as the person. |
| `GET /api/alerts/setup` | person | It shows the alert channels' tokens and topic. |
| `/api/alerts/switch` | person | Judged (ambiguous): an agent could silence the alerts that call the person. |
| `/api/alerts/desktop` | person | Judged (ambiguous): as the switch. |
| `/api/alerts/test` | person | Judged (ambiguous): it sends to the person's phone. |
| `/api/alerts/desktop/test` | person | Judged (ambiguous): it shows a notification on the person's Mac, as the phone's test alert does on the phone. |
| `/api/alerts/desktop/result` | person | Judged (ambiguous): the app says whether macOS showed a notification; an agent could say one reached the person when it never did. |
| `/api/alerts/desktop/focus` | person | Judged (ambiguous): the app focused last gets the next Mac notification; an agent could send them to an app the person is not using. |
| `/api/alerts/iphone/{start,test,confirm,copy,remove}` | person | It makes the topic an iPhone gets the person's alerts on, adds that iPhone to the phones or removes it: an agent could send the person's alerts to itself, or cut an iPhone off. |
| `/api/alerts/phone/ntfy-again` | person | It changes where the device's alerts go, back to its old ntfy topic: an agent could move the person's alerts to a transport that carries them in clear. |
| `/api/alerts/phone/test` | person | Judged (ambiguous): it sends to one of the person's phones, as Send a test does. |
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
| `/api/pages/check` | open | Checks a page file's text and says what is wrong with it; writes nothing. Agents run it through `ravenry page check`. |
| `/api/pages/item/create` | open | Adds a new item file to a page's folder from its form; nothing is replaced (a taken name gets -2), and the person sees it on the page. An agent can write the same file itself. |
| `/api/pages/item/set` | person | Judged (ambiguous): it rewrites a field the person or their agent wrote (a status set to fixed is a decision), as an idea's update is. |
| `/api/pages/item/toggle` | person | Ticking a box says the thing is done: the person's call. |
| `/api/pages/item/archive` | person | It takes an item off the page (into .archive/), as dropping an idea is. |
| `/api/pages/item/restore` | person | Judged (ambiguous): it undoes the person's archive. |
| `/api/pages/trust` | person | Trust turns on buttons someone else wrote; an agent would trust its own page. |
| `/api/pages/approve` | person | It lets a page type into a session and send it without the person seeing it first. |
| `/api/pages/dismiss` | person | Judged (ambiguous): it hides "changed since your copy", shown to the person. |
| `/api/pages/customize` | person | Judged (ambiguous): the copy takes the shipped page's place in the sidebar. An agent can write a page file itself. |
| `/api/pages/ask` | person | It types into a session, and a background ask sends it: what the composer does. |
| `/api/pages/run` | person | Judged (ambiguous): it puts a command in front of the person to approve as if they pressed the button (an agent asks with `ravenry approve` instead). |
| `/api/decisions/record` | open | An agent records the person's words verbatim (`ravenry decide`): it counts at once, marked with the pane and session that recorded it, and the person is told at once and can undo it for a minute, or edit or remove it any time. |
| `/api/brief/tick` | person | Ticking a task says it is done: the person's call, as a page's box is. |
| `/api/review/reply` | open | An agent answers a review comment (`ravenry review reply`): its words join the comment's thread for the person to read, and nothing runs. Only the pane of the session the comment is on may reply (403 otherwise). |
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
