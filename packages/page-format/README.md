# @ravenry/page-format

Ravenry page files (`*.page.yaml`), version 1: the sidebar pages as files.
Ravenry ships five (objectives, plans, ideas, rules, ship); a person or
their agent copies one to change it, or writes a new one. The data lives
in plain files, one markdown file per item.

Licence: Apache-2.0 (LICENSE), so tools and plugins written against the
format may use any licence.

## What is here

- **[schema/page-1.json](schema/page-1.json):** the JSON Schema (draft
  2020-12) for page files. Editors use it for checking and completion.
  Every pattern is RE2-compatible, so a Go checker can use it as is.
- **[schema/providers-1.json](schema/providers-1.json):** the provider
  contract: the built-in read-only data a page can name in
  `source.provider`, and the field names of each provider's items. These
  names freeze at the public launch, with the rest of the format.
- **[src/](src):** the TypeScript library. No Node-only API, so it also
  runs in a browser and the phone's WebView (a test checks it).
- **[defaults/](defaults):** the five shipped pages, as page files.
- **[docs/pages.md](docs/pages.md):** the docs for agents, generated from
  the schema (`npm run docs`; CI fails when they are not current).
- **[fixtures/](fixtures):** the conformance cases
  ([conformance.json](fixtures/conformance.json)) and the sample custom
  page, Playtest notes, with its notes folder.

## Using it

```ts
import { checkPage, formatProblem, describePage } from '@ravenry/page-format';

const r = checkPage(text, { fileName: 'playtest.page.yaml', ravenryVersion: '0.6.0' });
if (!r.ok) for (const p of r.problems) console.log(formatProblem('playtest.page.yaml', p));
// playtest.page.yaml line 14: 'stauts' is not a field. Did you mean status?
else console.log('OK', describePage(r.page!));
```

- `checkPage` reads YAML 1.2 (core schema; anchors, aliases and tags
  refused), checks the version, the schema and what a schema cannot (every
  field a page names exists, `set` only uses declared values, `{field}`
  only fills a button's text from its own item), and returns the typed
  model (`Page`, in src/model.ts) with defaults filled in and unknown views
  and buttons already replaced by their fallback or a placeholder. Errors
  carry a code, line, column, a plain sentence and, for a typo, "Did you
  mean". Unknown keys, views, buttons, providers, icons and field types
  are warnings.
- Item files: `readItem`, `patchItem` (field by field, against the hash
  the screen was drawn from; re-applied when its fields did not change
  meanwhile, else a conflict), `toggle` (one checkbox, checked against
  its text), `makeItem`, `fileNameFor`, `archivePath`, `checklist`.
- `resolvePages`: project, then global, then default, matched by id, in
  sidebar order. `customize` and `defaultChanged` for Customize.
- Trust for project pages: `trustRecord`, `trustState` (trusted, changed,
  untrusted, pinned to path and content), `explainActions` for the prompt.
- `matches`, `sortItems`, `groupItems`, `navNumber`, `statValue`, `fillText`,
  so every host shows the same thing.
- `npm run build` writes `dist/` (JavaScript and types) for publishing:
  Node does not strip types inside node_modules, so the npm package and the
  hub use the build.

## Conformance

`fixtures/conformance.json` lists every page fixture with its exact errors
and warnings (code, line, column, message, hint), values in its model, and
item operations (read, patch, toggle, checklist) with the file each result
must equal byte for byte. `test/conformance.test.ts` runs them here; the Go
checker and the apps run the same file.

## Where it plugs in (not wired yet)

Nothing uses this package yet: the hub, the daemon and the app are wired
after the work in progress there lands.

- **The hub (hub/server):**
  - Providers: one function per provider id building its items, in the
    field names of providers-1.json, from what the hub already computes:
    `projects` from `buildProject` (snapshot.projects), `brief` from
    `readBrief`, `plans` from each brief's plan objectives through
    planfmt's `derive`, `plan-files` from plans.mjs `plansFor`, `git` from
    ship.mjs `shipView`, `rule-files` from rulefiles.mjs `scopes`, `repeats`
    from repeats.mjs `view`, `sessions` from `buildSessions`' rows.
  - Pages: read `~/.ravenry/pages/`, each project's `.ravenry/pages/` and
    `defaults/`, `resolvePages`, read each folder source's items with
    `readItem`, and serve the model and items to the app and the phone.
    Writes go through `patchItem`, `toggle`, `makeItem` and `archivePath`,
    then a temp file and a rename. A default page's folder resolves against
    `~/.ravenry/pages/`.
  - Ideas move off `~/.ravenry/ideas.json` to `~/.ravenry/pages/ideas/`,
    one file per idea (name to title; stage mock, green and park to
    mockup, greenlit and parked; img to picture), with a one-time migration.
  - `run` buttons go through approve-and-run; `ask` in the background asks
    the first time and again when the page file's hash changes.
- **The app (apps/desktop renderer, and the phone):** the sidebar rows come
  from each resolved page's `nav` and `navNumber` (today five fixed
  `navRow` calls in app.ts); the page draws the typed model; a page with
  errors keeps its last good render under a bar built from
  `formatProblem`, with a red dot on its row; a project page shows the
  trust bar from `trustState` and `explainActions`; Customize writes
  `customize(defaultText)` to `~/.ravenry/pages/`, and `defaultChanged`
  shows "changed since your copy".
- **`ravenry page check` and `ravenry page docs` (hub/bin/ravenry.mjs):**
  `checkPage` with the file name, each problem through `formatProblem`,
  `OK` and `describePage` when it passes, exit 1 on errors; `docs` prints
  docs/pages.md or `docsTopic(docs, topic)`.
