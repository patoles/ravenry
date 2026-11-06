# Pages: the sidebar's pages as files

The pages under the sessions (Objectives, Plans, Ideas, Rules, Ship, and any
you or an agent add) are page files: `*.page.yaml`, in the format of
`packages/page-format` (its README and `docs/pages.md`, which agents read
through `ravenry page docs`). The hub reads them, serves them to the app
and the phone, and makes every write to their items. This page says how.

## Where pages come from

Nearest first, matched by id (a page's id is its file name):

| | Where | Who writes it |
| --- | --- | --- |
| A project's | `<project folder>/.ravenry/pages/<id>.page.yaml` | the repository: it came with a clone |
| Yours | `~/.ravenry/pages/<id>.page.yaml` (`RAVENRY_HOME/pages`) | you, an agent, or Customize |
| Shipped | `hub/pages/defaults/` | Ravenry; copied from `packages/page-format/defaults` by `tools/vendor-page-format.mjs` |

The sidebar shows the shipped five in their order (a copy of one keeps its
place), then a line, then the pages you or an agent added in the order their
files were made, then each project's own pages with the project's name.

A page's folder (`source: { folder: notes/ }`) is beside its file; a shipped
page's is in `~/.ravenry/pages/` (the Ideas page reads
`~/.ravenry/pages/ideas/`). A `files` source looks inside the page's folder,
or the project's folder for a project's page. Items are the `.md` files at
the top of the folder, newest change first unless the page sorts them; dot
files and `.archive/` are left out.

## Reading, watching, live

`server/pages.mjs` reads every page file and resolves them with
page-format's `resolvePages`. It reads again only what changed (size and
time), when `fs.watch` sees a change in `~/.ravenry/pages/` or the defaults,
and on every board tick (2 s), so a project's pages and a change made by an
agent, an editor or a pull show within moments. The snapshot every page
gets over `/api/events` carries `pages`: one row per page with its label,
icon, number (`navNumber` over its items), whether its file has a mistake,
its trust, and `rev`, which moves whenever what the page draws moves.

A page file with a mistake keeps its last good version, under the problem
(its line, the line's text and "Did you mean"). The last good text of each
file is kept in `RAVENRY_HOME/pages.json`, so a restart keeps it too. A page
of yours keeps its last good version's buttons; a project page's trust is
for its file as it is now.

## The API

| Endpoint | | |
| --- | --- | --- |
| `GET /api/pages` | | the rows (as in the snapshot) |
| `GET /api/pages/page?key=` | | a page: its typed model (the last good one), its problems, trust and notices, and every section's items |
| `GET /api/pages/img?key=&path=` | | a picture inside the page's folder; nothing outside it, no symlink out, images only |
| `GET /api/pages/docs?topic=` | | the page docs, or one topic |
| `POST /api/pages/check` | open | `{ text, path }`: problems by line, and what it draws (`ravenry page check`) |
| `POST /api/pages/item/create` | open | a new item file from the form, never replacing one |
| `POST /api/pages/item/set` | person | fields of an item, against the hash the screen was drawn from |
| `POST /api/pages/item/toggle` | person | one checkbox, found by its line and text |
| `POST /api/pages/item/archive`, `.../restore` | person | into `.archive/` and back |
| `POST /api/pages/trust` | person | trust a project's page, for this exact file |
| `POST /api/pages/approve` | person | let a page's background asks run, for this version of the file |
| `POST /api/pages/dismiss` | person | hide "changed since your copy" until the next revision |
| `POST /api/pages/customize` | person | copy a shipped page to `~/.ravenry/pages/`, stamped `from:` |
| `POST /api/pages/ask` | person | a page's ask button, or the app's Ask Claude to fix |
| `POST /api/pages/run` | person | a page's run button: an approval for the person |

Why each one is open or a person's is in `docs/PERSON.md`. A page's key is
its id, and `<project id>/<id>` for a project's.

## Writes

The app never rewrites a page file: the only page file Ravenry writes is the
new copy Customize makes. Item files are written field by field:

- **set** (a set button, dragging a card to another lane, the Edit form):
  page-format's `patchItem` changes the lines of those fields and nothing
  else, comments included. Only the folder's declared fields (and `title`),
  with values of their type and an enum only to one of its values. The patch
  is made against the hash the screen was drawn from: when the file changed
  since in other fields, it is made again on the new file; when one of its
  fields changed, nothing is written and the answer (409) holds the item as
  it is now.
- **toggle**: the box on that line if it still says that text, else the only
  box that says it; else nothing (409).
- **create**: the button's own values, then the form's, then each field's
  default; a file named after the title, `-2` when the name is taken.
- **archive**: the file moves into `.archive/`; restore moves it back.

Every write goes to a temp file in the same folder, then a rename (a new
file is linked into place, so none is ever replaced). Providers' items are
read only.

## Trust

A project's page shows straight away, read only, with what each of its
buttons would do (`explainActions`). Its buttons work once the person trusts
it: a record of its path and the SHA-256 of its exact text, in
`RAVENRY_HOME/pages.json`, written only by `/api/pages/trust`. When the file
changes (a pull, an edit, an agent) the page is read only again and asks
again. Your own pages and the shipped ones need no trust.

## Buttons

- **ask**: the session is the project its `session` names (`{project}` from
  the item), its main session. The text is filled from the item's own fields
  as data. It is typed into the session's box through the board's send path
  (`sendMessage` with `prefill`), never sent: the person presses Enter. A
  background ask is sent; it needs `/api/pages/approve` first, and again
  whenever the page file's text changes.
- **run**: the page's own argv (never item data), its folder (the page's,
  the project's for a project page), and the item's values as variables
  only. It becomes an approve checkpoint on this machine's ravenryd
  (`checkpoint.new` with `env`), which the person sees, may edit and runs or
  refuses like an agent's; the card names the page and the button. A
  ravenryd too old for `env` refuses it, and nothing runs.
- The others (open, set, create, toggle, copy, archive) are the app's.

## Ravenry's own pieces

The shipped pages place Ravenry's own views and buttons (`ravenry:`), which
map onto the board's existing code:

| | In the app |
| --- | --- |
| `ravenry:objective-rows`, `ravenry:plan-row` | drawn from the rows the hub adds to each item (`$ravenry`, built with `public/plan-view.js`) |
| `ravenry:plan` | opens the plan on the board (`#/plan/<project>`) |
| `ravenry:session-sheet` | picks the project's session |
| `ravenry:idea-thread` | opens the idea on the board's Ideas page |
| `ravenry:mockup-rounds` | the latest round's three pictures, from the Ideas code |
| `ravenry:brainstorm` | the seed box: `/api/ideas/add`, `/api/ideas/brainstorm` |
| `ravenry:memory-rules` | `/api/rules` and `/api/rules/<id>` |
| `ravenry:sessions` | the sessions with Close idle (`/api/sessions/close`) |
| `ravenry:save-rule`, `ravenry:not-now` | the suggestion's preview, then `/api/repeats/<id>` |
| `ravenry:write-brief` | the project's sheet on the board, where the brief form is |

## Ideas as files

The Ideas page reads `~/.ravenry/pages/ideas/`, one markdown file per idea
(`server/ideasfiles.mjs`): `title`, `stage` (spark, mockup, greenlit,
parked), `pitch`, `status`, `picture` and `id`. The board's own record of
each idea (its thread with the agent, its mockup rounds, a reply on its
way) is in `ideas/.ravenry/<id>.json`; pictures in `ideas/pictures/`, mockup
rounds in `ideas/mockups/<id>/`. The board's Ideas code writes the files
field by field and reads them again when anything else changed them.

**The move off ideas.json** runs once, when the board loads its ideas:
`ideas.json` and `~/.ravenry/ideas/` are copied to
`backups/ideas-<when>/` first, then every idea (archived ones into
`.archive/`), thread, mockup round and picture is copied into the new
folder, which is put in place by one rename at the end, so a move that
stops half way leaves no half folder. Nothing is deleted: `ideas.json` and
the old folder stay as they were. A marker
(`ideas/.ravenry/migrated.json`) makes a second run do nothing. A reply or a
brainstorm that was running when the board stopped says so in its thread, as
it always has.

## Commands

`ravenry page check FILE` and `ravenry page docs [TOPIC]` live in the
ravenry binary (`daemon/cmd/ravenryd/page.go`): agents run `ravenry` from a
pane, and `ravenry skill` lists it with the other commands. `check` sends
the file's text to the board on this machine, so it is checked by the same
code that draws the sidebar; the docs are built into the binary. npm's
`ravenry` (`bin/ravenry.mjs`) has the same two commands, checked here.

## Tests

- `tools/pages-test.mjs`: every provider against fixtures (the contract's
  fields and types only), the move of a realistic `ideas.json`
  (`tools/fixtures/ideas`) on a copy, and a board on scratch data: the
  rows, a page's items, writes and conflicts, a mistake, trust, Customize,
  "changed since your copy", check and docs (and the ravenry binary's,
  with `RAVENRYD_BIN`), live updates, and the web board's tabs.
- `tools/person-routes-test.mjs`: every pages write route has a row; from
  inside a real pane every person row is refused and changes nothing, the
  open ones go through.
- `apps/desktop/tools/pages-test.mjs`: the app offscreen, every frame of the
  pages picture.
