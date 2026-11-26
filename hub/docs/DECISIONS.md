# The decision ledger

The person's directions, kept verbatim with their time and project, so
hand-offs, new sessions and agents read what was settled instead of
asking again. `server/decisions.mjs` keeps it in
`<RAVENRY_HOME>/decisions.json` (mode 0600, written atomically).

## How an entry gets in

Ravenry never reads prompts to find decisions: hook reports drop prompt
text on purpose (PROTOCOL.md section 4, agent.report), and that rule
stays. An entry comes only by explicit capture:

- **An agent records the person's words**, verbatim, with
  `ravenry decide "<quote>" [--project P] [--replaces ID] [--scope S]`,
  which sends `POST /api/decisions/record`. It counts at once. The entry
  is marked with who recorded it: the pane the caller's process runs in,
  as `ravenryd peer` judges it (never a pane the body names: a body with
  `recorded_by` is refused), and that pane's assistant and session from
  its daemon (`pane.list`). A caller outside every pane records as
  `client`. The person is told at once, "Saved your decision: ...", on the
  board's stream and the phone, with Undo for a minute.
- **The person** adds, edits, undoes (within the minute) or removes any
  entry: person rows (docs/PERSON.md).

When an entry replaces others (`replaces`, or `overrides` on add), they
get `overridden_by` and leave the active view; removing or undoing the new
one makes them active again.

## The file

```json
{ "version": 1, "decisions": [
  { "id": "dk4x34fg",
    "quote": "The menu opens on the left.",
    "at": "2026-11-07T10:00:00.000Z",
    "project": "game",
    "scope": "menus",
    "overrides": ["dgqx2jyr"],
    "by": "agent",
    "recorded_by": { "pane": "pqwertyu", "session": "5b1c...", "assistant": "claude" },
    "edited_at": "2026-11-07T10:02:00.000Z",
    "reads": { "2026-11-07": 5 },
    "last_read_at": "2026-11-07T11:40:00.000Z" } ] }
```

- `id`: "d" and 7 characters of a-z and 2-7.
- `project`: the registry project's id (a project can be renamed and two
  can share a name; the id never changes), or null for every project.
- `by`: `person`, `agent` (recorded from inside a pane) or `client`
  (recorded through /record by a program outside every pane).
- `reads`: how often agents read it each day, the last 30 days.

## The API

| Call | Class | Body | Answer |
| --- | --- | --- | --- |
| `GET /api/decisions?project=&search=&all=&agent=` | open read | | `{ ok, project, decisions: [Entry + reads_today, reads_total, undo_until?] }`, newest first |
| `GET /api/decisions?page=1&show=&only=&search=` | open read | | what the Decisions page shows (`decisions.page()`): `{ ok, total, active, replaced, undoable, projects: [{ id, name }], days: [{ day, rel, items }], empty }`; never counted as a read |
| `POST /api/decisions/record` | open | `{ quote, project?, replaces?, scope? }` | `{ ok, decision }` |
| `POST /api/decisions/add` | person | `{ quote, project?, replaces? or overrides?, scope? }` | `{ ok, decision }` |
| `POST /api/decisions/edit` | person | `{ id, quote?, project?, scope? }` | `{ ok, decision }` |
| `POST /api/decisions/undo` | person | `{ id }`, within a minute of `at`; or `{ ids }`, the decisions of one notice (one project, saved by agents, each within 2 minutes of the one before), within a minute of the latest | `{ ok, removed }` (a list for `ids`) |
| `POST /api/decisions/remove` | person | `{ id }` | `{ ok, removed }` |

- `project` anywhere: a project's id, its name, or an absolute folder
  inside it or inside one of its sessions' worktrees, so an agent can pass
  its working folder. An unknown one is 404. On /record without one, the
  recording pane's session's project.
- `search`: every word must appear in the quote or the scope, any case.
  `all`: the replaced entries too.
- `page=1`: the page's view, worked out here for every client. `show`:
  `now` (the active ones, the default), `replaced` or `all`; `only`: one
  project's id, its own entries alone; days in the hub's local date, `rel`
  `today` or `yesterday`; each item adds `project_name` (null for every
  project), `where` (the session it was said in), `gone`, `replaced_at`
  (when the entry that replaced it was saved) and `replaces` (the entries
  it replaced, verbatim, for an active one); `empty` is `none` (no entry
  at all) or `nomatch`.
- **Reads.** A GET counts one read of each entry it returns when it comes
  from an agent: `agent=1` (what `ravenry decisions` sends) or a caller
  inside a pane. The board's and the app's own looks do not count.
- A field the ledger does not know is refused (400), not dropped.
- The board's event stream (`GET /api/events`) carries `event: decision`
  with `{ type: "saved", decision, undo_until, group }`, `{ type: "edited",
  decision }` or `{ type: "removed", id }`. The phone gets an alert of
  kind `decision` (docs/PHONE.md section 5) with Undo, closed after the
  minute.
- Decisions an agent saves for one project, each within 2 minutes of the
  one before, are one notice (`group`: `{ id, ids, count, rev, latest,
  words, undo_until }`, server/push.mjs groupDecision()): one quiet alert on
  the phone, updated in place, and one toast on the board and the Mac
  ("Saved 3 decisions, the latest on the sails."), whose Undo sends `{ ids }`
  and takes them all back within the minute after the latest. The
  Decisions page's own Undo still takes back one, within its own minute.

## Who reads it

- **Agents**, before asking the person anything: `ravenry decisions
  --project P --search WORDS` (the skill says so).
- **Hand-offs:** the hand-off's words (server/handoff.mjs reasonText) carry
  the project's active decisions, newest first, verbatim, at most 10 and
  about 3000 bytes, and tell the session not to copy them into the
  hand-off (the next session reads the ledger itself).
- **New sessions and briefs:** the first prompt the hub types for a new
  session that reads the brief (POST /api/sessions/start, Revive, New
  session, a hand-off's fresh session) adds one line: "Before you ask the
  user anything, check their N decisions on record: ravenry decisions
  --project P." A first message of the person's own is left as written,
  and nothing is written into BRIEF.md: a copy in the brief would go stale
  when an entry is edited or replaced.
