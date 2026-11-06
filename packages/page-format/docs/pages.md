# Page files, version 1

A Ravenry page is one `*.page.yaml` file: where its items come from, how they are drawn, and which buttons they have. Ravenry ships five (objectives, plans, ideas, rules, ship); you or your agent can copy one to change it, or write a new one.

This text is generated from the page format's JSON Schema (`schema/page-1.json`) and provider contract (`schema/providers-1.json`). Print it with `ravenry page docs`, or one topic with `ravenry page docs <topic>` (board, actions, filter, providers...).

## Where page files live

- A project's pages: `<project>/.ravenry/pages/<id>.page.yaml`.
- Your pages, in every project: `~/.ravenry/pages/<id>.page.yaml`.
- The pages Ravenry ships.

Ravenry uses the first it finds for each id, in that order. The file name must be `<id>.page.yaml`. A page's data folder sits next to its file: `source: { folder: playtest/ }` beside `playtest.page.yaml`.

Customize on a shipped page copies it to `~/.ravenry/pages/` and stamps `from:`. Ravenry never rewrites a page file; when the shipped page changes, the app says so.

A page that came with a project (a cloned repository) shows its items read-only until you trust it, and asks again whenever the file changes.

## Check a page

Run `ravenry page check <file>` after every change. It prints `OK` and what the page shows, or each problem with its line, a plain sentence and, for a typo, "Did you mean". Errors stop the page: the app keeps showing the last version that worked, with the problem on top. Warnings never stop it.

```
playtest.page.yaml line 14: 'stauts' is not a field. Did you mean status?
```

## A whole page

The Playtest notes page: a board of notes grouped by status, two buttons on each card and New note at the top.

```yaml
version: 1
id: playtest
title: Playtest notes
nav: { icon: flag, count: { status: new } }
source:
  folder: playtest/
  fields:
    status:  { type: enum, values: [new, fixing, fixed] }
    project: { type: string }
    device:  { type: string }
    picture: { type: image }
sections:
  - view: board
    group_by: status
    item:
      title: title
      badges: [project, device]
      image: picture
      time: modified
      actions:
        - { label: Fixed, set: { status: fixed } }
        - label: Ask Claude to fix
          ask:
            session: "{project}"
            prefill: "Fix this playtest note: {title}"
actions:
  - { label: New note, create: { status: new } }
```

One note in its folder, `playtest/boat-clips-the-dock.md`: the fields in the frontmatter, the text after it.

```markdown
---
title: Boat clips through the dock on the left turn
status: new
project: paper-boat
device: Pixel 8
picture: shots/dock-clip.png
---
Third run, turning left past the dock at about half speed.
The bow goes inside the planks for a moment, then pops
back out. Every time on the left side, never on the right.
```

## The top of the file

### version

Takes the number 1. The page format version. Always 1 for this format. A file with a higher number needs a newer Ravenry.

```yaml
version: 1
```

### id

Takes lower case letters, digits and -, starting with a letter, at most 40 long. The page's id. Pages are matched by id: a project page replaces a global page, which replaces the shipped default with the same id. The file is named <id>.page.yaml.

```yaml
id: playtest
```

### title

Takes text of 1 to 80 characters. The page's title, shown at the top of the page and, unless nav.label says otherwise, in the sidebar.

```yaml
title: Playtest notes
```

### revision

Takes a whole number from 1. Only in the pages Ravenry ships: the default's own revision, raised whenever the default changes. Customize writes it into the copy's from line.

```yaml
revision: 3
```

### from

Takes <owner>/<id>@<revision>, such as ravenry/objectives@3. Stamped by Customize on a copy of a shipped page: which default it came from and that default's revision. Ravenry uses it to say when the default has changed since the copy. It never merges anything.

```yaml
from: ravenry/objectives@3
```

### requires

Takes a Ravenry version such as >=0.6 or >=0.6.2. The oldest Ravenry that can draw this page. An older Ravenry shows a line asking for an update instead of the page.

```yaml
requires: ">=0.6"
```

### sections

Takes a list of sections. What the page shows, top to bottom. A page has either sections or tabs.

### tabs

Takes a list of tabs. Instead of sections: a switch at the top of the page, each tab with its own sections.

```yaml
tabs:
  - label: Open
    sections: [{ view: list, where: { status: open } }]
  - label: Done
    sections: [{ view: list, where: { status: done } }]
```

### actions

Takes a list of buttons. Buttons at the top of the page. They have no item, so their text cannot use {field}.

```yaml
actions: [{ label: New note, create: { status: new } }]
```

A page has `sections` or `tabs`, not both. Keys starting with `x-` are yours: Ravenry keeps them and never reads them.

## nav

The page's row in the sidebar (and on the phone).

```yaml
nav: { icon: flag, count: { status: new } }
```

### nav.label

Takes text of 1 to 40 characters. The row's text. Defaults to the title.

```yaml
label: Playtest
```

### nav.icon

Takes an icon name such as flag. One of Ravenry's icons: target, plans, idea, rules, ship, flag, list, cards, board, table, chart, doc, check, star, bug, inbox, clock, folder, terminal, tag, heart, bolt, page. An unknown name draws the page icon.

```yaml
icon: flag
```

### nav.count

Takes true, false or a filter. The number after the label: true counts every item of the page's source, a filter counts the items it matches. Off when left out.

```yaml
count: { status: new }
```

### nav.sum

Takes a field name, or a dotted path such as brief.goal. Instead of count: the number after the label is this number field added up over the page's items.

```yaml
sum: ship_waiting
```

### nav.count_label

Takes text of 1 to 20 characters. A word after the number, such as running in "2 running".

```yaml
count_label: new
```

### nav.route

Takes a route: lower case letters, digits, - and /. Where the page opens in the app. Defaults to pages/<id>.

```yaml
route: pages/playtest
```

Icons: target, plans, idea, rules, ship, flag, list, cards, board, table, chart, doc, check, star, bug, inbox, clock, folder, terminal, tag, heart, bolt, page.

## source

Where the items come from: a folder of markdown files (one per item, fields in the frontmatter), files matched by a glob (read for their checkboxes), or a provider (Ravenry's own read-only data). A section can have its own source; otherwise it uses the page's.

### source.folder

Takes a path inside the page's folder, such as notes/ (not starting with / or ~, no ..). A folder of markdown files, one per item, next to the page file: playtest/ beside playtest.page.yaml. For a shipped page, beside where its copy would go (~/.ravenry/pages/). Each file's frontmatter holds the fields; its body is the item's text.

```yaml
folder: playtest/
```

### source.fields

Takes a mapping of field names to fields. With folder only: the fields each item has. They also build the New and Edit forms. Every item also has title, body, file, created and modified.

```yaml
fields:
  status: { type: enum, values: [new, fixing, fixed] }
  device: { type: string }
```

### source.files

Takes a glob such as docs/**/PLAN*.md. Markdown files matched by a glob inside the page's folder (the project's folder for a project page), one item per file, read for their checkboxes: done, total, title.

```yaml
files: docs/**/PLAN*.md
```

### source.provider

Takes a provider id such as projects, or <plugin>:<name>. Ravenry's own data, read only: projects, brief, plans, plan-files, git, rule-files, repeats, sessions. Their field names are fixed (see providers-1.json). A plugin's provider is <plugin>:<name>.

```yaml
provider: projects
```

## Field types

Each field of a folder's items has a type, and optionally a label, values (for enum), a default and required.

### fields.<name>.type

Takes one of string, number, date, bool, enum, list or image. string: one line of text. number. date: YYYY-MM-DD, or with a time. bool: true or false. enum: one of its values. list: a list of short texts. image: a picture file inside the page's folder (never a web address). A type from a newer Ravenry is read as text, with a warning.

```yaml
type: enum
```

### fields.<name>.label

Takes text of 1 to 40 characters. The field's name in forms and table headers. Defaults to the field name, capitalised.

```yaml
label: Device
```

### fields.<name>.values

Takes a list of values. With enum only: the values, in order. A board shows one lane per value in this order.

```yaml
values: [new, fixing, fixed]
```

### fields.<name>.default

Takes a value of the field's type. The value a new item starts with.

```yaml
default: new
```

### fields.<name>.required

Takes true or false. The New and Edit forms ask for it.

```yaml
required: true
```

### Fields every folder item has

- `title` (string): The frontmatter title, else the first # heading, else the file name.
- `body` (string): The text after the frontmatter.
- `file` (string): The file's path inside the folder.
- `created` (date): When the file was made.
- `modified` (date): When the file last changed.

`title` can also be declared, to make the New form ask for it. The others cannot be field names, and neither can has, not and any (filters use them).

### Fields of a files source

- `title` (string): The file's first heading, else its name.
- `body` (string): The file's text.
- `file` (string): The file's path.
- `done` (number): Boxes ticked.
- `total` (number): Boxes in all.
- `modified` (date): When the file last changed.

## providers

The read-only data a page file can name in source.provider, and the field names of each provider's items. These names are part of the page format: they freeze at the public launch, and after it they only grow (a new field, a new provider), never rename or retype. Dates are ISO 8601 text. A field with no value is left out, so has: <field> and not: { has: <field> } work on all of them. A list of objects names its entries' fields under fields. An enum lists every value it can take today.

A provider's items are read-only: set, create, toggle and archive need a folder.

### projects

One item per project on the board (hidden projects are left out).

- `id` (string): The project's id.
- `name` (string): The project's name.
- `state` (enum: you, work, idle): you: needs you. work: working. idle: nothing running or waiting.
- `since` (date): When it entered that state.
- `updated` (date): Its newest change: the brief, a plan file or a session's last turn.
- `line` (string): The one line the board shows for it.
- `question` (string): The question waiting on you, when there is one.
- `folder` (string): Its folder, with ~ for your home.
- `machine` (string): The machine it lives on, when that is not this one.
- `sessions` (number): How many sessions it has open.
- `picture` (image): The first picture of its brief.
- `brief` (object): Its brief (BRIEF.md), when it has one.
  - `brief.path` (string): The brief's path, with ~ for your home.
  - `brief.goal` (string): The Goal line.
  - `brief.done_means` (string): The Done means line.
  - `brief.kind` (string): The Kind line.
  - `brief.stage` (string): The Stage line.
  - `brief.next` (string): The Next step section.
  - `brief.waiting_on` (string): The Waiting on line.
  - `brief.status` (string): The status line.
  - `brief.draft` (bool): true while the brief is a draft the board wrote and you have not reviewed.
- `objectives` (list): The objectives under the brief's Plan, in order.
  - `title` (string): The objective's heading.
  - `state` (enum: done, now, you, wait, todo): Where it stands as a whole.
  - `done` (number): Tasks done.
  - `total` (number): Tasks in all.
  - `plan` (bool): true when the objective is a plan (it runs on its own).
  - `tasks` (list): Its tasks.
    - `text` (string): The task.
    - `state` (enum: done, now, you, wait, todo): Where the task stands.
- `plan` (object): The plan running in its brief, when there is one.
  - `plan.title` (string): The plan's title.
  - `plan.state` (enum: running, gate, paused): running, waiting at a gate for you, or paused.
  - `plan.step` (number): The step it is on, from 1.
  - `plan.total` (number): Its steps in all.
  - `plan.question` (string): At a gate: the question.
- `plan_files` (list): Its PLAN, ROADMAP and TODO files that hold checkboxes.
  - `title` (string): The file's first heading.
  - `source` (string): The file's path in the project's folder.
  - `done` (number): Boxes ticked.
  - `total` (number): Boxes in all.
  - `updated` (date): Its last commit, or its last change when it has uncommitted changes.

### brief

One item per project brief (BRIEF.md).

- `project` (string): The project's id.
- `project_name` (string): The project's name.
- `path` (string): The brief's path, with ~ for your home.
- `updated` (date): When the file last changed.
- `goal` (string): The Goal line.
- `done_means` (string): The Done means line.
- `kind` (string): The Kind line.
- `stage` (string): The Stage line.
- `next` (string): The Next step section.
- `waiting_on` (string): The Waiting on line.
- `status` (string): The status line.
- `draft` (bool): true while the brief is a draft the board wrote and you have not reviewed.
- `parked` (bool): true when the brief has a Parked section.
- `open_notes` (number): Notes not marked fixed.
- `rules` (list): The Rules section's lines.
- `notes` (list): The Notes section.
  - `text` (string): The note.
  - `fixed` (bool): true when it is ticked or says (fixed).
- `objectives` (list): The objectives under Plan, with the same fields as projects' objectives.
  - `title` (string): The objective's heading.
  - `state` (enum: done, now, you, wait, todo): Where it stands as a whole.
  - `done` (number): Tasks done.
  - `total` (number): Tasks in all.
  - `plan` (bool): true when the objective is a plan.
- `ship` (list): The Ship section's tasks.
  - `text` (string): The task.
  - `state` (enum: done, now, you, wait, todo): Where the task stands.

### plans

One item per plan in any brief, running or finished.

- `id` (string): <project id>/<plan title>.
- `project` (string): The project's id.
- `project_name` (string): The project's name.
- `title` (string): The plan's title.
- `goal` (string): The plan's goal.
- `state` (enum: running, gate, paused, done, stopped): running, waiting at a gate for you, paused, done or stopped.
- `step` (number): The step it is on, from 1.
- `total` (number): Its steps in all.
- `done` (number): Steps done or skipped.
- `question` (string): At a gate: the question.
- `started` (date): When it started.
- `last` (date): Its newest step, proof or log line.
- `brief_path` (string): The brief it lives in, with ~ for your home.

### plan-files

One item per PLAN, ROADMAP or TODO file that holds checkboxes, in every project's folder.

- `id` (string): <project id>/<source>.
- `project` (string): The project's id.
- `project_name` (string): The project's name.
- `title` (string): The file's first heading.
- `source` (string): The file's path in the project's folder.
- `done` (number): Boxes ticked.
- `total` (number): Boxes in all.
- `updated` (date): Its last commit, or its last change when it has uncommitted changes.

### git

One item per git repository a project lives in.

- `path` (string): The repository's top folder, with ~ for your home.
- `project` (string): The id of its first project.
- `projects` (list): The names of the projects in it.
- `branch` (string): The branch checked out.
- `upstream` (string): The branch's upstream, such as origin/main.
- `ahead` (number): Commits not pushed to the upstream.
- `behind` (number): Commits on the upstream not here.
- `changed` (number): Tracked files changed and not committed.
- `status` (enum: ahead, changed, no_upstream, clean): Where the repository stands, the first that holds: ahead (commits not pushed), changed (tracked files not committed), no_upstream (nothing to compare with), clean (pushed and nothing changed).
- `status_text` (string): That status in words, as the Ship card says it: 3 commits to push, Uncommitted changes, No upstream, Pushed and clean. A renderer gives it status's tone.
- `last_commit` (object): The last commit.
  - `last_commit.hash` (string): Its short hash.
  - `last_commit.at` (date): When it was made.
  - `last_commit.subject` (string): Its first line.
- `ship` (list): The Ship tasks of its projects' briefs.
  - `text` (string): The task.
  - `state` (enum: done, now, you, wait, todo): Where the task stands.
- `ship_waiting` (number): Ship tasks waiting on you.
- `ship_command` (string): The command a project's registry entry gives for shipping. Shown for you to run, never run by Ravenry.
- `picture` (image): The first picture of its projects' briefs.

### rule-files

One item per rules file an agent reads: Claude Code's CLAUDE.md and Codex's AGENTS.md, for every project and for each project's folder.

- `scope` (string): global for the files every project reads, else the project folder, with ~ for your home.
- `scope_name` (string): Every project, or the names of the projects in that folder.
- `assistant` (string): Whose file it is: claude or codex today; more may come.
- `file_name` (string): CLAUDE.md, AGENTS.md or AGENTS.override.md.
- `path` (string): The file's path, with ~ for your home.
- `exists` (bool): false when there is no such file yet.
- `count` (number): Rules in it.
- `body` (string): The file's text.
- `groups` (list): Its rules, under their headings.
  - `heading` (string): The heading.
  - `rules` (list): The rules under it, as plain text.

### repeats

One item per thing you corrected in more than one session that no rule covers yet: the Suggested rules.

- `id` (string): The suggestion's id.
- `rule` (string): The rule it suggests.
- `kind` (enum: add, every, reword): add: no rule says it. every: one project's rule, said elsewhere too. reword: a rule exists and you still said it.
- `button` (string): The words for saving it: Add rule, Add to every project or Reword rule.
- `messages` (number): How many times you said it.
- `sessions` (number): In how many sessions.
- `sessions_text` (string): Those sessions in words, such as 3 Claude Code sessions.
- `last` (date): When you last said it.
- `tail` (string): Why it is suggested, in one sentence.
- `assistants` (list): Whose sessions said it: claude, codex.
- `targets` (list): The files saving it writes to.
- `quote` (object): One of the times you said it.
  - `quote.text` (string): Your words.
  - `quote.project` (string): The project's name.
  - `quote.date` (string): When, in words.

### sessions

One item per agent session running on this machine.

- `id` (string): The session's id, or pid:<n> when it maps to none.
- `project` (string): The project's id, when it is in one.
- `project_name` (string): The project's name, or its folder when it is in none.
- `assistant` (string): claude or codex today; more may come.
- `state` (string): What its screen shows: working, dialog, asked, draft, idle and others.
- `group` (enum: use, left, handed, idle, unmapped): use: in use. left: left with a question or a half-typed reply. handed: handed off. idle. unmapped: a process with no session found.
- `line` (string): What it last said, in one line.
- `folder` (string): Its folder, with ~ for your home.
- `machine` (string): The machine it runs on, when that is not this one.
- `since` (date): Its last sign of life.
- `memory_kb` (number): Its memory, in KB.
- `closable` (bool): true when Close idle can end it.
- `blocked` (string): Why Close idle cannot end it.

## sections

One part of a page: a view of items from a source.

### title

Takes text of 1 to 80 characters. A heading above the section.

```yaml
title: No brief yet
```

### source

Takes a mapping with one of folder, files or provider. Where the items come from: a folder of markdown files (one per item, fields in the frontmatter), files matched by a glob (read for their checkboxes), or a provider (Ravenry's own read-only data). A section can have its own source; otherwise it uses the page's.

```yaml
source:
  folder: playtest/
  fields:
    status: { type: enum, values: [new, fixing, fixed] }
```

### where

Takes a filter (a mapping). Which items to keep. Every line must hold. field: value keeps items whose field is that value; field: [a, b] keeps either; field: { gt: 0 } compares (gt, gte, lt, lte, not); has: field keeps items where the field is set and not empty; not: {filter} and any: [filters] combine. There are no formulas.

```yaml
where: { status: new }
```

### sort

Takes a list of fields, each optionally starting with -. The order of the items: by the first field, then the next. Dates go newest first and everything else A to Z or smallest first; a - in front reverses it.

```yaml
sort: [modified]
```

### limit

Takes a whole number from 1 to 500. Show at most this many items, then an "N more" line.

```yaml
limit: 20
```

### empty

Takes text of 1 to 200 characters. What the section says when it has no items.

```yaml
empty: Nothing waiting.
```

### actions

Takes a list of buttons. Buttons above the section. Like the page's, they have no item.

### fallback

Takes a view name or a section. What to draw when this Ravenry does not know the view (a plugin that is not installed, or a view from a newer Ravenry): a core view name, which keeps the rest of the section, or a whole section.

```yaml
fallback: list
```

### item

Takes a mapping of slots. What each item shows. Every slot names a field; none holds text of its own.

```yaml
item:
  title: title
  badges: [project, device]
  image: picture
  time: modified
```

### group_by

Takes a field name, or a dotted path such as brief.goal. Group the items by a field: a heading per value. A board needs it, and it must be an enum field there: one lane per value, and dragging a card to a lane sets the field.

```yaml
group_by: status
```

### columns

Takes a list of columns. The table's columns, left to right: a field, or { field, label, align }. Defaults to the title.

```yaml
columns: [region, { field: tiles, align: end }, status]
```

### stats

Takes a list of numbers. The numbers, left to right.

```yaml
stats:
  - { label: Unpushed commits, sum: ahead }
  - { label: Repos with changes, count: { changed: { gt: 0 } } }
```

### with

Takes a mapping. Settings for a plugin's view, as that plugin documents them.

```yaml
with: { state: running }
```

## Views

How the items are drawn: list, cards, board, table, stats, document, or a plugin's view such as ravenry:plan. A view this Ravenry does not know draws the section's fallback, or a placeholder.

### list

Rows, one per item: title, a line under it, badges, time, buttons. With group_by, a heading per value.

```yaml
view: list
sort: [modified]
item: { title: title, subtitle: project, time: modified }
```

### cards

A grid of cards, with room for a picture and an excerpt.

```yaml
view: cards
item: { title: title, image: picture, excerpt: body }
```

### board

Lanes, one per value of an enum field (group_by), in the order of its values. Dragging a card to another lane sets that field in its file. Below about 240 px a lane, on a narrow window or the phone, it becomes a list grouped by lane, the last lane folded.

```yaml
view: board
group_by: status
item: { title: title, badges: [project] }
```

### table

Rows and columns: columns lists the fields, left to right. Numbers line up at the end.

```yaml
view: table
columns: [title, { field: tiles, align: end }, status]
```

### stats

A row of numbers over the items: count (all, or a filter) and sum, min or max of a number field.

```yaml
view: stats
stats:
  - { label: New notes, count: { status: new } }
  - { label: Tiles, sum: tiles }
```

### document

Each item's text (body) drawn as a document: headings, lists, checkboxes, code. Raw HTML is shown as text and web images are not loaded.

```yaml
view: document
source: { files: docs/ROADMAP.md }
item: { title: title }
```

### Plugin views

A view named `<plugin>:<name>` comes from a plugin, in a sandbox. When the plugin is not installed, the section draws its `fallback`, or a placeholder.

```yaml
view: tiles:map
fallback: table
```

## item

What each item shows. Every slot names a field; none holds text of its own.

### item.title

Takes a field name, or a dotted path such as brief.goal. The item's name. Defaults to title.

```yaml
title: title
```

### item.subtitle

Takes a field name, or a dotted path such as brief.goal. A line under the title.

```yaml
subtitle: brief.goal
```

### item.badges

Takes a list of fields. Small tags after the title, one per field that has a value.

```yaml
badges: [project, device]
```

### item.progress

Takes a number field, { done, total, style } or { list, style }. A bar or dots: a number field from 0 to 100, done of total, or a list whose entries have a state (done, now, you, wait, todo). style is bar, dots or count.

```yaml
progress: { done: done, total: total, style: bar }
```

### item.image

Takes a field name, or a dotted path such as brief.goal. A picture: an image field. Only files inside the page's folder are shown, never a web address.

```yaml
image: picture
```

### item.time

Takes a field name, or a dotted path such as brief.goal. A date field, shown as a time (16:52, Yesterday, Mon).

```yaml
time: modified
```

### item.checklist

Takes a field name, or a dotted path such as brief.goal. The checkboxes (- [ ] and - [x] lines) of a text field, usually body. They can be ticked when the item has a toggle button.

```yaml
checklist: body
```

### item.excerpt

Takes a field name, or a dotted path such as brief.goal. The first lines of a text field, usually body.

```yaml
excerpt: body
```

### item.place

Takes <plugin>:<name>, such as ravenry:plan. A plugin's view drawn inside the item, such as ravenry:plan-row.

```yaml
place: ravenry:plan-row
```

### item.detail

Takes <plugin>:<name>, such as ravenry:plan. A plugin's view shown when the item is opened, instead of its fields and text.

```yaml
detail: ravenry:plan
```

### item.actions

Takes a list of buttons. The item's buttons. Their text can use {field} from this item.

```yaml
actions: [{ label: Fixed, set: { status: fixed } }]
```

## filter

Which items to keep. Every line must hold. field: value keeps items whose field is that value; field: [a, b] keeps either; field: { gt: 0 } compares (gt, gte, lt, lte, not); has: field keeps items where the field is set and not empty; not: {filter} and any: [filters] combine. There are no formulas.

```yaml
where: { status: new }
```

```yaml
where: { has: brief }
```

```yaml
where: { state: [running, gate] }
```

```yaml
where: { ahead: { gt: 0 } }
```

```yaml
where: { not: { has: brief } }
```

## sort

The order of the items: by the first field, then the next. Dates go newest first and everything else A to Z or smallest first; a - in front reverses it.

```yaml
sort: [status, -modified]
```

## actions

A button. It does exactly one thing, from a closed list. One this Ravenry does not know draws its fallback, or a button that is off.

Every button has these keys, and exactly one of the kinds below.

### label

Takes text of 1 to 40 characters. The button's text. It never holds {field}, so a trust prompt can list it as written.

```yaml
label: Fixed
```

### icon

Takes an icon name such as flag. One of Ravenry's icons: target, plans, idea, rules, ship, flag, list, cards, board, table, chart, doc, check, star, bug, inbox, clock, folder, terminal, tag, heart, bolt, page. An unknown name draws the page icon.

```yaml
icon: flag
```

### confirm

Takes text. A question asked before the button does anything. Can use {field}.

```yaml
confirm: "Archive {title}?"
```

### when

Takes a filter (a mapping). Show the button only on items this filter keeps.

```yaml
when: { status: new }
```

### fallback

Takes a mapping with a label and one of open, set, create, toggle, copy, archive, ask, run or plugin. The button to show instead when this Ravenry does not know this one's kind (a plugin action that is not installed, or one from a newer Ravenry).

```yaml
fallback: { label: Fixed, set: { status: fixed } }
```

### open

Takes item, file, folder, or { page }, { link }, { project } or { session }. Opens something: item (the item, with its fields and text), file (its file in your editor), folder (its folder), { page: <id> } another page, { link: <field> } the address in a field (shown in full before it opens), { project: <text> } or { session: <text> } a project's or session's view.

```yaml
label: Open
open: item
```

### set

Takes a mapping of fields to values. Sets fields of the item's file, only to declared values: an enum field to one of its values, a bool field to true or false. The rest of the file stays as it is.

```yaml
label: Fixed
set: { status: fixed }
```

### create

Takes a mapping of fields to values. Opens the New form built from the fields, starting with these values. Saving writes a new file in the folder. Page and section buttons only.

```yaml
label: New note
create: { status: new }
```

### toggle

Takes body. Lets the item's checklist be ticked: each box flips its own line, after checking the line still says what the screen showed.

```yaml
label: Tick
toggle: body
```

### copy

Takes text. Copies text to the clipboard. Can use {field}.

```yaml
label: Copy
copy: "{title} on {device}"
```

### archive

Takes true. Moves the item's file into the folder's .archive/ folder. Undo moves it back.

```yaml
label: Archive
archive: true
confirm: "Archive {title}?"
```

### ask

Takes a mapping with prefill or background, and optionally session. Asks an agent. prefill types the text into a session's box and waits for you to press Enter. background runs it on its own: Ravenry asks you the first time, and again whenever the page file changes. session names the project or session; defaults to the item's project. All three can use {field}.

```yaml
label: Ask Claude to fix
ask:
  session: "{project}"
  prefill: "Fix this playtest note: {title}"
```

### run

Takes a mapping with argv, and optionally env and cwd. Runs a program, always through approve-and-run: you see the command and approve every run. argv is fixed, word by word, with no {field} and no shell. Item data goes in only as environment variables: env maps a variable name to a field. cwd is a folder inside the page's folder (the project's for a project page).

```yaml
label: Rebuild tiles
run: { argv: [npm, run, build:tiles], env: { REGION: region } }
```

### plugin

Takes <plugin>:<name>, such as ravenry:plan. A plugin's action, such as ravenry:save-rule. with holds its settings.

```yaml
label: Save
plugin: ravenry:save-rule
```

### with

Takes a mapping. With plugin only: the action's settings, as that plugin documents them.

## {field} in a button

Only a button's text can hold `{field}`: confirm, copy, ask (session, prefill, background), and open's project and session. It is filled from that item's own fields only, and the value goes in as data: never read as more template, a shell word or markup. Write `{{` and `}}` for a brace.

Labels, titles and every other text are shown as written. Page and section buttons have no item, so they cannot use it. `run` never takes `{field}` in argv: item data reaches a command only through `env`.

```yaml
label: Ask Claude to fix
ask:
  session: "{project}"
  prefill: "Fix this playtest note: {title}"
```

## Ravenry's own views and buttons

The parts of Ravenry that need real code (the plan flow, the session sheet, the idea thread) are plugins under the `ravenry:` name. A page places them like any plugin's.

### Views

- `ravenry:plan`: A plan's whole flow: its steps with their proofs, its gates, and the planning conversation. On a plans item, as item.detail.
- `ravenry:plan-row`: A running plan as one row: its dot strip, the step it is on and the question at a gate. On a projects item (its plan) or a plans item, as item.place.
- `ravenry:objective-rows`: A project's objectives as rows, each with its dot strip, N of M and what comes next, and the running plan's row among them. On a projects item, as item.place.
- `ravenry:session-sheet`: A project's sheet: its sessions, their screens and the hand-offs. On a projects item, as item.detail.
- `ravenry:sessions`: Every running session with its memory, and Close idle. On a section (view), with the sessions provider.
- `ravenry:idea-thread`: An idea's conversation with an agent, and Get 3 directions. On an ideas item, as item.detail.
- `ravenry:mockup-rounds`: An idea's mockup rounds, side by side. On an ideas item, as item.place.
- `ravenry:brainstorm`: The brainstorm box: a seed, Add idea and Get 3 directions. On a section (view), above the ideas.
- `ravenry:memory-rules`: Rules found in project memory that no rules file has, with Every project, This project and Not a rule. On a section (view).

### Buttons (with plugin:)

- `ravenry:save-rule`: Shows the change a suggested rule makes to its rules files, and saves it when you say so. On a repeats item.
- `ravenry:not-now`: Hides a suggested rule until you say it again. On a repeats item.
- `ravenry:write-brief`: Opens the form that writes a project's brief. On a projects item.

## What a page never does

- run script or raw HTML
- load a web image or anything else on its own (a link opens on click, with the full address shown first)
- read files outside its folder (the project's folder for a project page)
- type into a session without you seeing it, or run a command you did not approve
- restyle or imitate Ravenry's own screens; approval cards are drawn outside the page

A page that needs more is a plugin.

## Versions

`version: 1` never changes meaning: within it, things are only added. A key this Ravenry does not know is ignored with a warning; an unknown view or button kind draws its `fallback` or a placeholder; `requires` names the oldest Ravenry that can draw the page. A file for a newer format version is not drawn, and says so.

## Problem codes

Every problem has a code, the same in every Ravenry, for tools that read the checker's output.

- yaml-syntax, yaml-duplicate-key, yaml-multi-doc, empty, too-large, not-mapping: The file is not one readable YAML mapping.
- yaml-anchor, yaml-alias, yaml-tag: Anchors (&), aliases (*) and tags (!) are not allowed.
- version-missing, version-invalid, version-future: version is missing, is not 1, or is newer than this Ravenry reads.
- required, one-of, both, type, invalid, property-name: A key is missing, two keys that exclude each other are both there, or a value has the wrong shape.
- unknown-field, field-type, group-by-not-enum, filter-value, filter-compare: A slot, filter or button names a field the items do not have, or one of the wrong type.
- set-type, set-value, create-value, read-only-source, needs-item, create-in-item, no-action, with-without-plugin: A button cannot do what it says where it is.
- placeholder-syntax, placeholder-no-item, placeholder-not-allowed, run-placeholder: {field} is used where it cannot be filled, or is not a field name.
- path-outside, fields-without-folder, reserved-field, values-not-enum, duplicate-value, field-default, no-source, duplicate-tab, id-file-name, file-name: The source, a field or the file itself is set up wrong.
- unknown-key, unknown-view, unknown-action, unknown-provider, unknown-plugin, unknown-icon, unknown-type, unknown-value (warnings): Something this Ravenry does not know. The page still works: the key is ignored, and the view, button or source shows its fallback or a placeholder.
