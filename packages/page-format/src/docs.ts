// The agent-facing docs for page files, generated from the JSON Schema, the
// provider contract and the list of built-in pieces, so they cannot drift
// from what the checker accepts. tools/docs.ts writes them to docs/pages.md;
// `ravenry page docs [topic]` prints them, or one topic (docsTopic).

import { stringify } from 'yaml';
import { ACTION_KINDS, CORE_VIEWS, ICONS, PROVIDERS_FILE, RAVENRY_ACTIONS, RAVENRY_VIEWS, filesFields, folderBuiltins } from './builtins.ts';
import { PAGE_SCHEMA } from './check.ts';
import type { Schema } from './jsonschema.ts';

type S = Schema & { properties?: Record<string, S>; description?: string; title?: string; examples?: unknown[] };

const defs = (PAGE_SCHEMA.$defs ?? {}) as Record<string, S>;

function resolve(s: S): S {
  let cur = s;
  while (typeof cur.$ref === 'string') cur = defs[(cur.$ref as string).split('/').pop()!];
  return cur;
}
const descOf = (s: S): string => (typeof s.description === 'string' ? s.description : resolve(s).description ?? '');
const titleOf = (s: S): string => (typeof s.title === 'string' ? s.title : resolve(s).title ?? '');
const exampleOf = (s: S): unknown => (Array.isArray(s.examples) ? s.examples[0] : Array.isArray(resolve(s).examples) ? resolve(s).examples![0] : undefined);

const scalar = (v: unknown): string => {
  const s = stringify(v, { version: '1.2', lineWidth: 0 }).trimEnd();
  // Quote text holding braces, so {field} examples read as text.
  return typeof v === 'string' && /[{}]/.test(v) && !s.startsWith('"') && !s.startsWith("'") ? JSON.stringify(v) : s;
};
const isPlainObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Short YAML the way page files are written: lists of plain values and
 * small mappings inline, the rest as blocks. */
function flow(v: unknown): string | null {
  if (Array.isArray(v)) {
    const parts = v.map(flow);
    return parts.every((x) => x !== null) ? `[${parts.join(', ')}]` : null;
  }
  if (isPlainObj(v)) {
    const parts = Object.entries(v).map(([k, x]) => { const f = flow(x); return f === null ? null : `${k}: ${f}`; });
    return parts.every((x) => x !== null) ? `{ ${parts.join(', ')} }` : null;
  }
  return scalar(v);
}

function yaml(v: unknown, indent = ''): string {
  if (isPlainObj(v)) {
    return Object.entries(v).map(([k, x]) => {
      const f = flow(x);
      if (f !== null && f.length + indent.length + k.length < 64) return `${indent}${k}: ${f}`;
      if (Array.isArray(x)) return `${indent}${k}:\n` + x.map((e) => listItem(e, indent + '  ')).join('\n');
      return `${indent}${k}:\n` + yaml(x, indent + '  ');
    }).join('\n');
  }
  if (Array.isArray(v)) return v.map((e) => listItem(e, indent)).join('\n');
  return indent + scalar(v);
}

function listItem(e: unknown, indent: string): string {
  const f = flow(e);
  if (f !== null && f.length + indent.length < 70) return `${indent}- ${f}`;
  const inner = yaml(e, indent + '  ');
  return `${indent}- ${inner.slice(indent.length + 2)}`;
}

function block(v: unknown): string {
  return '```yaml\n' + yaml(v) + '\n```';
}

/** One key: its name, what it takes, what it does, an example. */
function keyDoc(name: string, s: S, level = '###'): string {
  const ex = exampleOf(s);
  const lines = [`${level} ${name}`, '', `Takes ${titleOf(s) || 'a value'}. ${descOf(s)}`.trim()];
  if (ex !== undefined) lines.push('', block({ [name.split('.').pop()!.replace(/^<name>$/, 'status')]: ex }));
  return lines.join('\n');
}

function propsOf(s: S): Record<string, S> {
  return (resolve(s).properties ?? {}) as Record<string, S>;
}

/** Properties added by the section's if/then branches, per view. */
function sectionBranchProps(): Record<string, S> {
  const out: Record<string, S> = {};
  for (const b of (defs.section.allOf ?? []) as S[]) {
    const then = (b as Record<string, unknown>).then as S | undefined;
    if (then?.properties) Object.assign(out, then.properties);
  }
  return out;
}

const SAMPLE_PAGE = `version: 1
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
  - { label: New note, create: { status: new } }`;

const SAMPLE_NOTE = `---
title: Boat clips through the dock on the left turn
status: new
project: paper-boat
device: Pixel 8
picture: shots/dock-clip.png
---
Third run, turning left past the dock at about half speed.
The bow goes inside the planks for a moment, then pops
back out. Every time on the left side, never on the right.`;

const VIEW_EXAMPLES: Record<string, unknown> = {
  list: { view: 'list', sort: ['modified'], item: { title: 'title', subtitle: 'project', time: 'modified' } },
  cards: { view: 'cards', item: { title: 'title', image: 'picture', excerpt: 'body' } },
  board: { view: 'board', group_by: 'status', item: { title: 'title', badges: ['project'] } },
  table: { view: 'table', columns: ['title', { field: 'tiles', align: 'end' }, 'status'] },
  stats: { view: 'stats', stats: [{ label: 'New notes', count: { status: 'new' } }, { label: 'Tiles', sum: 'tiles' }] },
  document: { view: 'document', source: { files: 'docs/ROADMAP.md' }, item: { title: 'title' } },
};

const VIEW_WORDS: Record<string, string> = {
  list: 'Rows, one per item: title, a line under it, badges, time, buttons. With group_by, a heading per value.',
  cards: 'A grid of cards, with room for a picture and an excerpt.',
  board: 'Lanes, one per value of an enum field (group_by), in the order of its values. Dragging a card to another lane sets that field in its file. Below about 240 px a lane, on a narrow window or the phone, it becomes a list grouped by lane, the last lane folded.',
  table: 'Rows and columns: columns lists the fields, left to right. Numbers line up at the end.',
  stats: 'A row of numbers over the items: count (all, or a filter) and sum, min or max of a number field.',
  document: "Each item's text (body) drawn as a document: headings, lists, checkboxes, code. Raw HTML is shown as text and web images are not loaded.",
};

const ACTION_EXAMPLES: Record<string, unknown> = {
  open: { label: 'Open', open: 'item' },
  set: { label: 'Fixed', set: { status: 'fixed' } },
  create: { label: 'New note', create: { status: 'new' } },
  toggle: { label: 'Tick', toggle: 'body' },
  copy: { label: 'Copy', copy: '{title} on {device}' },
  archive: { label: 'Archive', archive: true, confirm: 'Archive {title}?' },
  ask: { label: 'Ask Claude to fix', ask: { session: '{project}', prefill: 'Fix this playtest note: {title}' } },
  run: { label: 'Rebuild tiles', run: { argv: ['npm', 'run', 'build:tiles'], env: { REGION: 'region' } } },
  plugin: { label: 'Save', plugin: 'ravenry:save-rule' },
};

const CODES: [string, string][] = [
  ['yaml-syntax, yaml-duplicate-key, yaml-multi-doc, empty, too-large, not-mapping', 'The file is not one readable YAML mapping.'],
  ['yaml-anchor, yaml-alias, yaml-tag', 'Anchors (&), aliases (*) and tags (!) are not allowed.'],
  ['version-missing, version-invalid, version-future', 'version is missing, is not 1, or is newer than this Ravenry reads.'],
  ['required, one-of, both, type, invalid, property-name', 'A key is missing, two keys that exclude each other are both there, or a value has the wrong shape.'],
  ['unknown-field, field-type, group-by-not-enum, filter-value, filter-compare', 'A slot, filter or button names a field the items do not have, or one of the wrong type.'],
  ['set-type, set-value, create-value, read-only-source, needs-item, create-in-item, no-action, with-without-plugin', 'A button cannot do what it says where it is.'],
  ['placeholder-syntax, placeholder-no-item, placeholder-not-allowed, run-placeholder', '{field} is used where it cannot be filled, or is not a field name.'],
  ['path-outside, fields-without-folder, reserved-field, values-not-enum, duplicate-value, field-default, no-source, duplicate-tab, id-file-name, file-name', 'The source, a field or the file itself is set up wrong.'],
  ['unknown-key, unknown-view, unknown-action, unknown-provider, unknown-plugin, unknown-icon, unknown-type, unknown-value (warnings)', 'Something this Ravenry does not know. The page still works: the key is ignored, and the view, button or source shows its fallback or a placeholder.'],
];

/** The whole docs text. */
export function pageDocs(): string {
  const root = PAGE_SCHEMA as S;
  const top = root.properties as Record<string, S>;
  const out: string[] = [];
  const p = (...xs: string[]) => { for (const x of xs) out.push(x, ''); };

  p('# Page files, version 1',
    'A Ravenry page is one `*.page.yaml` file: where its items come from, how they are drawn, and which buttons they have. Ravenry ships five (objectives, plans, ideas, rules, ship); you or your agent can copy one to change it, or write a new one.',
    'This text is generated from the page format\'s JSON Schema (`schema/page-1.json`) and provider contract (`schema/providers-1.json`). Print it with `ravenry page docs`, or one topic with `ravenry page docs <topic>` (board, actions, filter, providers...).');

  p('## Where page files live',
    '- A project\'s pages: `<project>/.ravenry/pages/<id>.page.yaml`.',
    '- Your pages, in every project: `~/.ravenry/pages/<id>.page.yaml`.',
    '- The pages Ravenry ships.',
    'Ravenry uses the first it finds for each id, in that order. The file name must be `<id>.page.yaml`. A page\'s data folder sits next to its file: `source: { folder: playtest/ }` beside `playtest.page.yaml`.',
    'Customize on a shipped page copies it to `~/.ravenry/pages/` and stamps `from:`. Ravenry never rewrites a page file; when the shipped page changes, the app says so.',
    'A page that came with a project (a cloned repository) shows its items read-only until you trust it, and asks again whenever the file changes.');

  p('## Check a page',
    'Run `ravenry page check <file>` after every change. It prints `OK` and what the page shows, or each problem with its line, a plain sentence and, for a typo, "Did you mean". Errors stop the page: the app keeps showing the last version that worked, with the problem on top. Warnings never stop it.',
    '```\nplaytest.page.yaml line 14: \'stauts\' is not a field. Did you mean status?\n```');

  p('## A whole page', 'The Playtest notes page: a board of notes grouped by status, two buttons on each card and New note at the top.', '```yaml\n' + SAMPLE_PAGE + '\n```',
    'One note in its folder, `playtest/boat-clips-the-dock.md`: the fields in the frontmatter, the text after it.', '```markdown\n' + SAMPLE_NOTE + '\n```');

  p('## The top of the file');
  for (const [k, s] of Object.entries(top)) {
    if (k === 'nav' || k === 'source' || k === 'sections' || k === 'tabs' || k === 'actions') continue;
    p(keyDoc(k, s));
  }
  p(keyDoc('sections', top.sections), keyDoc('tabs', top.tabs), keyDoc('actions', top.actions));
  p('A page has `sections` or `tabs`, not both. Keys starting with `x-` are yours: Ravenry keeps them and never reads them.');

  p('## nav', descOf(defs.nav), block({ nav: exampleOf(defs.nav) }));
  for (const [k, s] of Object.entries(propsOf(defs.nav))) p(keyDoc(`nav.${k}`, s));
  p(`Icons: ${ICONS.join(', ')}.`);

  p('## source', descOf(defs.source));
  for (const [k, s] of Object.entries(propsOf(defs.source))) p(keyDoc(`source.${k}`, s));

  p('## Field types', 'Each field of a folder\'s items has a type, and optionally a label, values (for enum), a default and required.');
  for (const [k, s] of Object.entries(propsOf(defs.field))) p(keyDoc(`fields.<name>.${k}`, s));
  p('### Fields every folder item has', ...Object.values(folderBuiltins()).map((f) => `- \`${f.name}\` (${f.type}): ${f.description}`));
  p('`title` can also be declared, to make the New form ask for it. The others cannot be field names, and neither can has, not and any (filters use them).');
  p('### Fields of a files source', ...Object.values(filesFields()).map((f) => `- \`${f.name}\` (${f.type}): ${f.description}`));

  p('## providers', PROVIDERS_FILE.description, 'A provider\'s items are read-only: set, create, toggle and archive need a folder.');
  for (const [id, prov] of Object.entries(PROVIDERS_FILE.providers)) {
    const fieldLines: string[] = [];
    const walk = (fields: Record<string, { type: string; description: string; values?: string[]; fields?: Record<string, unknown> }>, base: string, depth: number) => {
      for (const [k, f] of Object.entries(fields)) {
        const t = f.values ? `enum: ${f.values.join(', ')}` : f.type;
        fieldLines.push(`${'  '.repeat(depth)}- \`${base}${k}\` (${t}): ${f.description}`);
        if (f.fields) walk(f.fields as never, f.type === 'object' ? `${base}${k}.` : '', depth + 1);
      }
    };
    walk(prov.fields as never, '', 0);
    p(`### ${id}`, prov.description, ...fieldLines);
  }

  p('## sections', descOf(defs.section));
  const sectionProps = { ...propsOf(defs.section), ...sectionBranchProps() };
  for (const [k, s] of Object.entries(sectionProps)) {
    if (k === 'view') continue;
    p(keyDoc(k, s));
  }

  p('## Views', descOf(sectionProps.view));
  for (const v of CORE_VIEWS) p(`### ${v}`, VIEW_WORDS[v], block(VIEW_EXAMPLES[v]));
  p('### Plugin views', 'A view named `<plugin>:<name>` comes from a plugin, in a sandbox. When the plugin is not installed, the section draws its `fallback`, or a placeholder.', block({ view: 'tiles:map', fallback: 'table' }));

  p('## item', descOf(defs.item));
  for (const [k, s] of Object.entries(propsOf(defs.item))) p(keyDoc(`item.${k}`, s));

  p('## filter', descOf(defs.filter));
  for (const ex of (defs.filter.examples ?? []) as unknown[]) p(block({ where: ex }));

  p('## sort', descOf(sectionProps.sort), block({ sort: ['status', '-modified'] }));

  p('## actions', descOf(defs.action), 'Every button has these keys, and exactly one of the kinds below.');
  const actionProps = propsOf(defs.action);
  for (const k of ['label', 'icon', 'confirm', 'when', 'fallback']) p(keyDoc(k, actionProps[k]));
  for (const k of ACTION_KINDS) {
    const s = actionProps[k];
    p(`### ${k}`, `Takes ${titleOf(s)}. ${descOf(s)}`, block(ACTION_EXAMPLES[k]));
  }
  p(keyDoc('with', actionProps.with));

  p('## {field} in a button',
    'Only a button\'s text can hold `{field}`: confirm, copy, ask (session, prefill, background), and open\'s project and session. It is filled from that item\'s own fields only, and the value goes in as data: never read as more template, a shell word or markup. Write `{{` and `}}` for a brace.',
    'Labels, titles and every other text are shown as written. Page and section buttons have no item, so they cannot use it. `run` never takes `{field}` in argv: item data reaches a command only through `env`.',
    block({ label: 'Ask Claude to fix', ask: { session: '{project}', prefill: 'Fix this playtest note: {title}' } }));

  p('## Ravenry\'s own views and buttons',
    'The parts of Ravenry that need real code (the plan flow, the session sheet, the idea thread) are plugins under the `ravenry:` name. A page places them like any plugin\'s.');
  p('### Views', ...RAVENRY_VIEWS.map((b) => `- \`${b.name}\`: ${b.description} On ${b.on}.`));
  p('### Buttons (with plugin:)', ...RAVENRY_ACTIONS.map((b) => `- \`${b.name}\`: ${b.description} On ${b.on}.`));

  p('## What a page never does',
    '- run script or raw HTML',
    '- load a web image or anything else on its own (a link opens on click, with the full address shown first)',
    '- read files outside its folder (the project\'s folder for a project page)',
    '- type into a session without you seeing it, or run a command you did not approve',
    '- restyle or imitate Ravenry\'s own screens; approval cards are drawn outside the page',
    'A page that needs more is a plugin.');

  p('## Versions',
    '`version: 1` never changes meaning: within it, things are only added. A key this Ravenry does not know is ignored with a warning; an unknown view or button kind draws its `fallback` or a placeholder; `requires` names the oldest Ravenry that can draw the page. A file for a newer format version is not drawn, and says so.');

  p('## Problem codes', 'Every problem has a code, the same in every Ravenry, for tools that read the checker\'s output.', ...CODES.map(([c, w]) => `- ${c}: ${w}`));
  let text = out.join('\n').replace(/\n{3,}/g, '\n\n');
  // Bullet lines of one list sit together.
  for (let i = 0; i < 3; i++) text = text.replace(/(\n *- [^\n]*)\n\n(?= *- )/g, '$1\n');
  return text.trimEnd() + '\n';
}

/** One topic of the docs: the heading whose name is the topic (board,
 * actions, filter, providers, set...), with what is under it. The whole
 * text when the topic is empty; null when nothing matches. */
export function docsTopic(docs: string, topic?: string): string | null {
  if (!topic) return docs;
  const t = topic.toLowerCase().trim();
  const lines = docs.split('\n');
  const heads = lines.map((l, i) => ({ i, m: l.match(/^(#{2,3}) (.*)$/) })).filter((h) => h.m);
  const exact = heads.filter((h) => h.m![2].toLowerCase() === t).sort((a, b) => a.m![1].length - b.m![1].length);
  const hit = exact[0] ?? heads.find((h) => h.m![2].toLowerCase().split(/[\s.]+/).includes(t));
  if (!hit) return null;
  const level = hit.m![1].length;
  const end = heads.find((h) => h.i > hit.i && h.m![1].length <= level);
  const body = lines.slice(hit.i, end ? end.i : lines.length).join('\n').trimEnd();
  return `Page files, version 1.\n\n${body}\n`;
}
