// The rest of the library: YAML rules, SHA-256, item writes, filters and
// sorting, resolution, Customize, trust, {field} and the docs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkPage, describePage, parseYaml, sha256, parseItem, readItem, patchItem, makeItem, fileNameFor, archivePath, toggle, yamlValue, boxCounts,
  matches, sortItems, groupItems, countItems, navNumber, statValue, parseTemplate, fillText,
  resolvePages, customize, defaultChanged, trustRecord, trustState, addTrust, explainActions, pageDocs, docsTopic, closest,
} from '../src/index.ts';
import type { Filter, Page, FieldSpec } from '../src/index.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const page = (text: string): Page => { const r = checkPage(text); assert.deepEqual(r.errors, []); return r.page!; };

test('YAML 1.2 core schema: yes, no, on and off stay text; octal and dates too', () => {
  const y = parseYaml('a: yes\nb: off\nc: 0o17\nd: 2026-11-06\ne: ~\n');
  assert.deepEqual(y.value, { a: 'yes', b: 'off', c: 15, d: '2026-11-06', e: null });
});

test('a page file over 256 KB is refused', () => {
  const r = checkPage('version: 1\n# ' + 'x'.repeat(256 * 1024) + '\n');
  assert.equal(r.errors[0].code, 'too-large');
});

test('locate gives line and column for keys and values', () => {
  const y = parseYaml('a:\n  b: [1, 2]\n  c: { d: x }\n');
  assert.deepEqual([y.locate(['a', 'b'], 'key').line, y.locate(['a', 'b'], 'key').column], [2, 3]);
  assert.deepEqual([y.locate(['a', 'b', 1]).line, y.locate(['a', 'b', 1]).column], [2, 10]);
  assert.deepEqual([y.locate(['a', 'c', 'd'], 'value').line, y.locate(['a', 'c', 'd'], 'value').column], [3, 11]);
  assert.equal(y.locate(['a', 'nope']).line, 1);
});

test('sha256 matches node:crypto for text of every length up to 300 and for any characters', () => {
  for (let n = 0; n < 300; n++) {
    const s = Array.from({ length: n }, (_, i) => String.fromCodePoint(32 + ((i * 7919 + n) % 2000))).join('');
    assert.equal(sha256(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'), `length ${n}`);
  }
  const emoji = 'boat \u{1F6A3} dock \u00E9';
  assert.equal(sha256(emoji), crypto.createHash('sha256').update(emoji, 'utf8').digest('hex'));
});

test('did you mean: close words only', () => {
  assert.equal(closest('stauts', ['status', 'project']), 'status');
  assert.equal(closest('gruop_by', ['group_by', 'item']), 'group_by');
  assert.equal(closest('Status', ['status']), 'status');
  assert.equal(closest('stat', ['status', 'project']), 'status');
  assert.equal(closest('zebra', ['status', 'project']), null);
});

test('a value round-trips through yamlValue', () => {
  for (const v of ['fixed', 'yes', 'No', 'null', '12', '1.5', '0x10', 'a: b', 'a #b', ' lead', '[x]', 'Pixel 8', 'it\'s', 'say "hi"', 'line\nbreak', '', true, 3, -2.5, ['a', 'b c', 'yes']]) {
    const y = parseYaml(`k: ${yamlValue(v)}\n`);
    assert.deepEqual((y.value as Record<string, unknown>).k, v === '' ? '' : v, JSON.stringify(v));
  }
});

test('item writes keep CRLF files CRLF, and a patch only touches its lines', () => {
  const text = '---\r\ntitle: A\r\nstatus: new # keep me\r\n---\r\nbody\r\n';
  const r = patchItem(text, { status: 'fixed', due: '2026-11-07' }, { hash: parseItem(text).hash });
  assert.ok(r.ok);
  assert.equal(r.text, '---\r\ntitle: A\r\nstatus: fixed # keep me\r\ndue: 2026-11-07\r\n---\r\nbody\r\n');
  const t = toggle('- [ ] a\r\n- [x] b\r\n', { line: 2, text: 'b' });
  assert.ok(t.ok && t.text === '- [ ] a\r\n- [ ] b\r\n');
});

test('a patch removing a multi-line field removes all its lines', () => {
  const text = '---\ntitle: A\ntags:\n  - one\n  - two\nstatus: new\n---\n';
  const r = patchItem(text, { tags: null }, { hash: parseItem(text).hash });
  assert.ok(r.ok);
  assert.equal(r.text, '---\ntitle: A\nstatus: new\n---\n');
  const r2 = patchItem(text, { tags: ['three'] }, { hash: parseItem(text).hash });
  assert.ok(r2.ok);
  assert.deepEqual(parseItem(r2.text).fields.tags, ['three']);
  assert.equal(parseItem(r2.text).fields.status, 'new');
});

test('frontmatter that cannot be read stops a patch, and an unclosed one is said', () => {
  assert.equal(parseItem('---\ntitle: A\nbody\n').problems[0].code, 'frontmatter-unclosed');
  const bad = '---\ntitle: [A\n---\n';
  const r = patchItem(bad, { status: 'x' }, { hash: parseItem(bad).hash });
  assert.ok(!r.ok && 'problems' in r);
  assert.equal(parseItem('---\nx: &a 1\n---\n').problems[0].code, 'yaml-anchor');
});

test('readItem warns about values that do not fit their field', () => {
  const fields: Record<string, FieldSpec> = { status: { name: 'status', type: 'enum', values: ['new'], label: 'Status', required: false, builtin: false, writable: true } };
  const r = readItem('---\nstatus: old\n---\n', { file: 'a.md', fields });
  assert.equal(r.problems[0].code, 'item-value');
  assert.equal(r.problems[0].message, 'status should be one of new.');
});

test('new items: makeItem, file names, archive', () => {
  const t = makeItem({ title: 'Boat: clips', status: 'new', project: 'paper-boat', empty: '' }, 'Notes', ['status']);
  assert.equal(t, '---\ntitle: "Boat: clips"\nstatus: new\nproject: paper-boat\n---\nNotes\n');
  assert.deepEqual(parseItem(t).fields, { title: 'Boat: clips', status: 'new', project: 'paper-boat' });
  assert.equal(fileNameFor('Boat clips through the dock!'), 'boat-clips-through-the-dock.md');
  assert.equal(fileNameFor('Café', ['cafe.md']), 'cafe-2.md');
  assert.equal(fileNameFor('???'), 'item.md');
  assert.equal(archivePath('a.md'), '.archive/a.md');
  assert.deepEqual(boxCounts('- [x] a\n- [ ] b\n```\n- [ ] c\n```\n'), { done: 1, total: 2 });
});

const items = [
  { title: 'A', status: 'new', points: 3, due: '2026-11-01', tags: ['x'], brief: { goal: 'g' } },
  { title: 'B', status: 'fixed', points: 1, due: '2026-11-05' },
  { title: 'C', status: 'fixing', points: 2 },
  { title: 'D', status: 'new', points: 5, due: '2026-10-01', tags: [] },
];
const f = (o: unknown): Filter => {
  const r = checkPage(`version: 1\nid: t\ntitle: T\nsource: { provider: projects }\nsections: [{ view: list }]\nnav: { count: ${JSON.stringify(o)} }\n`);
  return r.page?.nav.count as Filter ?? (() => { throw new Error(JSON.stringify(r.errors)); })();
};

test('filters: equals, lists, has, not, any, comparisons', () => {
  const pick = (o: unknown) => items.filter((i) => matches(f(o), i)).map((i) => i.title).join('');
  assert.equal(pick({ name: 'A' }), '');
  const ok = (filter: Filter) => items.filter((i) => matches(filter, i)).map((i) => i.title).join('');
  const F = (all: Filter['all']): Filter => ({ all });
  assert.equal(ok(F([{ op: 'eq', field: 'status', value: 'new' }])), 'AD');
  assert.equal(ok(F([{ op: 'in', field: 'status', values: ['new', 'fixing'] }])), 'ACD');
  assert.equal(ok(F([{ op: 'has', field: 'tags' }])), 'A');
  assert.equal(ok(F([{ op: 'has', field: 'brief.goal' }])), 'A');
  assert.equal(ok(F([{ op: 'not', filter: F([{ op: 'has', field: 'due' }]) }])), 'C');
  assert.equal(ok(F([{ op: 'any', filters: [F([{ op: 'eq', field: 'status', value: 'fixed' }]), F([{ op: 'gt', field: 'points', value: 4 }])] }])), 'BD');
  assert.equal(ok(F([{ op: 'gte', field: 'due', value: '2026-11-01' }])), 'AB');
  assert.equal(ok(F([{ op: 'ne', field: 'status', values: ['new'] }])), 'BC');
  assert.equal(ok(F([{ op: 'eq', field: 'tags', value: 'x' }])), 'A');
});

test('sort: dates newest first, - reverses, enums in their order, no value last', () => {
  const fields = { status: { name: 'status', type: 'enum', values: ['new', 'fixing', 'fixed'], label: 'S', required: false, builtin: false, writable: true } } as Record<string, FieldSpec>;
  assert.equal(sortItems(items, [{ field: 'due', desc: false }]).map((i) => i.title).join(''), 'BADC');
  assert.equal(sortItems(items, [{ field: 'points', desc: true }]).map((i) => i.title).join(''), 'DACB');
  assert.equal(sortItems(items, [{ field: 'status', desc: false }, { field: 'points', desc: false }], fields).map((i) => i.title).join(''), 'ADCB');
});

test('groups: an enum gives every lane in order, even empty ones', () => {
  const spec = { name: 'status', type: 'enum', values: ['new', 'fixing', 'fixed', 'wontfix'], label: 'S', required: false, builtin: false, writable: true } as FieldSpec;
  assert.deepEqual(groupItems(items, 'status', spec).map((g) => [g.value, g.items.length]), [['new', 2], ['fixing', 1], ['fixed', 1], ['wontfix', 0]]);
  assert.deepEqual(groupItems(items, 'due').map((g) => [g.value, g.items.length]), [['2026-11-01', 1], ['2026-11-05', 1], ['2026-10-01', 1], [null, 1]]);
});

test('counts and numbers', () => {
  assert.equal(countItems(items, true), 4);
  assert.equal(countItems(items, null), null);
  assert.equal(navNumber(items, { count: null, sum: 'points' }), 11);
  assert.equal(statValue(items, { label: '', note: null, kind: 'sum', field: 'points' }), 11);
  assert.equal(statValue(items, { label: '', note: null, kind: 'max', field: 'points' }), 5);
  assert.equal(statValue(items, { label: '', note: null, kind: 'min', field: 'due' }), '2026-10-01');
  assert.equal(statValue(items, { label: '', note: null, kind: 'count', where: { all: [{ op: 'eq', field: 'status', value: 'new' }] } }), 2);
});

test('{field}: filled from the item as data, braces escaped, bad ones reported', () => {
  const t = parseTemplate('Fix {title} on {device} {{not a field}} {brief.goal}');
  assert.deepEqual(t.bad, []);
  assert.equal(fillText(t.parts, { title: 'Boat {device}', device: '; rm -rf ~', brief: { goal: 'g' } }), 'Fix Boat {device} on ; rm -rf ~ {not a field} g');
  assert.deepEqual(parseTemplate('{Title} and {').bad, ['{Title}', '{']);
  assert.equal(fillText(parseTemplate('{tags}').parts, { tags: ['a', 'b'] }), 'a, b');
});

test('the Playtest notes fixture: every note fits the page, and check says what it shows', () => {
  const r = checkPage(read('fixtures/playtest/playtest.page.yaml'), { fileName: 'playtest.page.yaml' });
  const p = r.page!;
  const src = p.source!;
  assert.equal(src.kind, 'folder');
  const dir = path.join(ROOT, 'fixtures', 'playtest', 'playtest');
  const notes = fs.readdirSync(dir).filter((x) => x.endsWith('.md')).map((file) => {
    const it = readItem(fs.readFileSync(path.join(dir, file), 'utf8'), { file, fields: src.fields });
    assert.deepEqual(it.problems, [], file);
    if (typeof it.item.picture === 'string') assert.ok(fs.existsSync(path.join(dir, it.item.picture)), `${file}: ${it.item.picture}`);
    return it.item;
  });
  const sec = p.tabs[0].sections[0];
  assert.ok(sec.kind === 'core');
  const groups = groupItems(notes, sec.groupBy!, src.fields.status).map((g) => ({ value: g.value, count: g.items.length }));
  assert.equal(describePage(p, [groups]), 'board by status: New 4, Fixing 2, Fixed 3. 3 buttons.');
  assert.equal(countItems(notes, p.nav.count), 4);
});

test('resolution: project, then global, then default, by id; copies keep their place; broken files still win', () => {
  const def = (id: string, extra = '') => ({ origin: 'default' as const, path: `defaults/${id}.page.yaml`, text: `version: 1\nid: ${id}\nrevision: 2\ntitle: ${id}\nsource: { folder: x/ }\nsections: [{ view: list }]\n${extra}` });
  const files = [
    def('objectives'), def('plans'), def('ideas'),
    { origin: 'global' as const, path: '~/.ravenry/pages/plans.page.yaml', text: customize(def('plans').text).replace('from: ravenry/plans@2', 'from: ravenry/plans@1') },
    { origin: 'project' as const, path: 'p/.ravenry/pages/ideas.page.yaml', text: 'version: 1\nid: ideas\ntitle: [broken\n' },
    { origin: 'global' as const, path: '~/.ravenry/pages/zeta.page.yaml', text: def('zeta').text.replace('revision: 2\n', ''), created: '2026-11-01' },
    { origin: 'global' as const, path: '~/.ravenry/pages/alpha.page.yaml', text: def('alpha').text.replace('revision: 2\n', ''), created: '2026-11-03' },
    { origin: 'global' as const, path: '~/.ravenry/pages/notes.md', text: '' },
  ];
  const r = resolvePages(files);
  assert.deepEqual(r.map((x) => `${x.id}:${x.origin}`), ['objectives:default', 'plans:global', 'ideas:project', 'zeta:global', 'alpha:global']);
  const plans = r[1];
  assert.equal(plans.defaultChanged, true);
  assert.deepEqual(plans.replaces, [{ origin: 'default', path: 'defaults/plans.page.yaml' }]);
  const ideas = r[2];
  assert.equal(ideas.result.ok, false);
  assert.equal(ideas.needsTrust, true);
  assert.equal(r[0].needsTrust, false);
});

test('Customize stamps from: and drops revision, keeping every comment', () => {
  const text = read('defaults/objectives.page.yaml');
  const copy = customize(text);
  assert.ok(copy.includes('id: objectives\nfrom: ravenry/objectives@1\n'));
  assert.ok(!/^revision:/m.test(copy));
  for (const l of text.split('\n').filter((x) => x.startsWith('#'))) assert.ok(copy.includes(l));
  const cp = page(copy);
  const def = page(text);
  assert.equal(defaultChanged(cp, def), false);
  assert.equal(defaultChanged(cp, { ...def, revision: 2 }), true);
});

test('trust: pinned to path and content', () => {
  const recs = [trustRecord('/r/.ravenry/pages/tiles.page.yaml', 'v1', '2026-11-06T10:00:00Z')];
  assert.equal(trustState('/r/.ravenry/pages/tiles.page.yaml', 'v1', recs), 'trusted');
  assert.equal(trustState('/r/.ravenry/pages/tiles.page.yaml', 'v2', recs), 'changed');
  assert.equal(trustState('/s/.ravenry/pages/tiles.page.yaml', 'v1', recs), 'untrusted');
  const next = addTrust(recs, trustRecord('/r/.ravenry/pages/tiles.page.yaml', 'v2'));
  assert.equal(next.length, 1);
  assert.equal(trustState('/r/.ravenry/pages/tiles.page.yaml', 'v2', next), 'trusted');
});

test('the trust prompt says what each button would do', () => {
  const p = page(`version: 1
id: tiles
title: Map tiles
source:
  folder: regions/
  fields:
    region: { type: string }
    status: { type: enum, values: [checked, needs a look, out of date] }
sections:
  - view: table
    item:
      actions:
        - { label: Rebuild tiles, run: { argv: [npm, run, "build:tiles"], env: { REGION: region } } }
        - { label: Mark checked, set: { status: checked } }
actions:
  - { label: Ask Claude about tiles, ask: { session: trail-map, prefill: "About the tiles" } }
`);
  assert.deepEqual(explainActions(p, '~/code/trail-map'), [
    { label: 'Ask Claude about tiles', does: 'Types a message into the box of a trail-map session: "About the tiles". You choose whether to send it.' },
    { label: 'Rebuild tiles', does: 'Runs npm run build:tiles in ~/code/trail-map, with REGION set to the item\'s region. You approve each run first.' },
    { label: 'Mark checked', does: "Sets status to checked in the item's file." },
  ]);
});

test('the trust prompt names a session or project taken from the item as named by it, never "a the item\'s project session"', () => {
  const p = page(`version: 1
id: tiles
title: Map tiles
source:
  folder: regions/
  fields:
    project: { type: string }
sections:
  - view: list
    item:
      actions:
        - { label: Ask its project, ask: { session: "{project}", background: "Check the tiles" } }
        - { label: Tell its project, ask: { session: "{project}", prefill: "About the tiles" } }
        - { label: Its project, open: { project: "{project}" } }
`);
  const does = explainActions(p, '~/code/trail-map').map((a) => a.does);
  assert.deepEqual(does, [
    'Asks an agent in the session named by the item\'s project to work on its own: "Check the tiles". You approve it the first time, and again whenever the page changes.',
    'Types a message into the box of the session named by the item\'s project: "About the tiles". You choose whether to send it.',
    'Opens the project named by the item\'s project.',
  ]);
  assert.ok(does.every((d) => !/\ba the\b/.test(d)));
});

test('the shipped defaults: five pages, each valid with no warnings, with a revision, under their routes', () => {
  const ids = ['objectives', 'plans', 'ideas', 'rules', 'ship'];
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'defaults')).sort(), ids.map((i) => `${i}.page.yaml`).sort());
  for (const id of ids) {
    const r = checkPage(read(`defaults/${id}.page.yaml`), { fileName: `${id}.page.yaml`, plugins: { views: [], actions: [], providers: [] } });
    assert.deepEqual(r.problems, [], id);
    assert.ok(r.page!.revision! >= 1);
    assert.equal(r.page!.nav.route, id);
    const kinds = r.page!.tabs.flatMap((t) => t.sections.map((s) => s.kind));
    assert.ok(!kinds.includes('placeholder'), `${id} draws no placeholder`);
  }
});

test('docs/pages.md is current, and names every key, view, action and provider field', () => {
  const docs = pageDocs();
  assert.equal(read('docs/pages.md'), docs, 'run npm run docs');
  for (const w of ['### board', '### table', '### stats', '### document', '### run', '### ask', '### set', '### toggle', '### archive', '### copy', '### create', '### open', '### plugin', 'group_by', 'nav.count', 'source.folder', 'item.checklist', '`ship_waiting`', '`brief.goal`', 'ravenry:plan-row', 'x-']) {
    assert.ok(docs.includes(w), w);
  }
  assert.ok(docsTopic(docs, 'board')!.startsWith('Page files, version 1.\n\n### board\n'));
  assert.ok(docsTopic(docs, 'actions')!.includes('### run'));
  assert.equal(docsTopic(docs, 'nonsense'), null);
});
