// Proves the sidebar pages as files (server/pages.mjs, docs/PAGES.md):
//   - every built-in provider (server/providers.mjs) against fixtures: the
//     contract's field names and types only (schema/providers-1.json), the
//     Ship card's status line as git's status and status_text, the
//     shipped pages' numbers;
//   - the one-time move of ideas.json to one file per idea, on a copy of a
//     realistic fixture (tools/fixtures/ideas): every idea, thread, mockup
//     round and picture kept, ideas.json and the old pictures untouched, a
//     backup first, and a second run does nothing; the board's Ideas code
//     then reads and writes the files field by field;
//   - against a real board on scratch data: the pages in the state (order,
//     numbers, a project page with its project's name), a page's items,
//     item writes (set, a conflict, a re-applied patch, toggle, create,
//     archive and back), a page with a mistake keeping its last good
//     version, trust for a project page, Customize and "changed since your
//     copy", page check and docs, pictures, and a new page file showing up
//     in the state by itself.
// The person checks on the new routes, from inside a real pane, are in
// tools/person-routes-test.mjs.
// Usage: node tools/pages-test.mjs
import { GUARD_HOME } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as pf from '../server/vendor/page-format.mjs';
import * as providers from '../server/providers.mjs';
import * as ideasfiles from '../server/ideasfiles.mjs';
import { readBrief } from '../server/brief.mjs';
import { activePlan } from '../server/planfmt.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.dirname(ROOT);
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = path.join(ROOT, '.tmp', 'pages-test');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });

function png(file, rgb = [120, 170, 220]) {
  const W = 8, H = 6;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) raw.set(rgb, y * (W * 3 + 1) + 1 + x * 3);
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
const hashTree = (dir) => {
  const out = {};
  const walk = (d, rel) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const f = path.join(d, e.name); const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(f, r); else out[r] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } };
  walk(dir, '');
  return out;
};

// ------------------------------------------------------------ providers
// Each provider's items carry the contract's fields only, with values of
// their types; a field with no value is left out.
const CONTRACT = pf.PROVIDERS_FILE.providers;
function fieldsOk(id, items) {
  const bad = [];
  const spec = (fields, prefix, v) => {
    for (const [k, val] of Object.entries(v)) {
      if (k === '$ravenry') continue;
      const f = fields[k];
      if (!f) { bad.push(`${prefix}${k}: not in the contract`); continue; }
      if (val === null || val === undefined || val === '') { bad.push(`${prefix}${k}: an empty value is left out`); continue; }
      const t = f.type;
      const ok = t === 'string' || t === 'image' ? typeof val === 'string'
        : t === 'number' ? typeof val === 'number' && Number.isFinite(val)
          : t === 'bool' ? typeof val === 'boolean'
            : t === 'date' ? typeof val === 'string' && !Number.isNaN(Date.parse(val))
              : t === 'enum' ? f.values.includes(val)
                : t === 'object' ? typeof val === 'object' && !Array.isArray(val)
                  : t === 'list' ? Array.isArray(val) : false;
      if (!ok) { bad.push(`${prefix}${k}: ${JSON.stringify(val)} is not ${t}${f.values ? ` (${f.values.join(', ')})` : ''}`); continue; }
      if (t === 'object' && f.fields) spec(f.fields, `${prefix}${k}.`, val);
      if (t === 'list' && f.fields) for (const x of val) spec(f.fields, `${prefix}${k}[].`, x);
    }
  };
  for (const it of items) spec(CONTRACT[id].fields, '', it);
  const key = CONTRACT[id].key;
  if (items.some((it) => it[key] === undefined)) bad.push(`every item has its key, ${key}`);
  return bad;
}

const PF = path.join(T, 'proj-fixture');
fs.mkdirSync(path.join(PF, 'docs'), { recursive: true });
const BRIEF = path.join(PF, 'BRIEF.md');
fs.writeFileSync(BRIEF, [
  '# Weather Widget', '', 'Goal: Rain radar on the home screen, updated every 5 minutes.', 'Done means: the radar updates on a phone left on the desk.', 'Kind: App', 'Stage: Build', 'Waiting on: tile licence', '',
  '## Plan', '### Radar tiles', 'Runs on its own. Started: 2026-11-05 09:00. Not in the plan: stop and ask.', 'Goal: "Tiles cached for an hour"', '',
  '- [x] Do: Fetch tiles', '- [x] Gate: Ask me before caching', '- [x] Do: Cache on disk', '- [ ] Do: Cache tiles for an hour', '- [ ] Gate: Ask me before release', '- [ ] Do: Release', '',
  '### Offline edits', '- [x] Store edits', '- [>] Merge two edits made offline', '- [ ] Conflicts', '',
  '## Ship', '- [x] Tests pass', '- [?] Publish 2.3.0', '',
  '## Notes', '- [ ] "the radar flickers"', '- [x] "old tiles" (fixed)', '',
  '## Next step', 'Cache tiles for an hour.', '',
].join('\n'));
const brief = readBrief(BRIEF);
const plan = activePlan(brief.plan, { working: true });
const SNAP_PROJECTS = [
  { id: 'weather-widget', name: 'weather-widget', state: 'work', since: null, line: 'Working: cache tiles', question: null, folder: PF, folderShort: '~/code/weather-widget', machine: 'gpu-box', sessions: [{ surfaceId: 'ravenry:p1', sessionId: 's1', machine: 'gpu-box' }],
    brief: { path: '~/code/weather-widget/BRIEF.md', file: BRIEF, draft: false, status: null, goal: brief.goal, doneMeans: brief.doneMeans, kind: brief.kind, stage: brief.stage, plan: brief.plan, next: brief.next, notes: brief.notes, pictures: [{ path: 'shots/radar.png', alt: 'Radar' }], parked: brief.parked, rules: brief.rules, ship: brief.ship, waitingOn: brief.waitingOn },
    plan, plans: [{ title: 'Checklist in TODO.md', done: 8, total: 11, source: 'TODO.md', updatedAt: '2026-11-06T10:00:00.000Z' }] },
  { id: 'trail-map', name: 'trail-map', state: 'idle', since: '2026-11-03T10:00:00.000Z', line: 'Idle', folder: '/x/trail-map', folderShort: '~/code/trail-map', machine: null, sessions: [], brief: null, plan: null, plans: [] },
  { id: 'loose-1', name: 'scratch', state: 'you', loose: true, sessions: [], brief: null, plans: [] },
];
const SHIP = { repos: [
  { top: '/x/a', topShort: '~/code/a', branch: 'main', upstream: 'origin/main', ahead: 3, behind: 0, changed: 2, lastCommit: { hash: 'abc1234', at: '2026-11-06T09:00:00+01:00', subject: 'Cache tiles' }, projects: [{ id: 'weather-widget', name: 'weather-widget', ship: brief.ship, shipCommand: 'npm publish', picture: { url: '/api/pic/weather-widget?p=shots%2Fradar.png' } }] },
  { top: '/x/b', topShort: '~/code/b', branch: 'main', upstream: 'origin/main', ahead: 0, behind: 2, changed: 1, lastCommit: null, projects: [{ id: 'b', name: 'b', ship: null }] },
  { top: '/x/c', topShort: '~/code/c', branch: null, upstream: null, ahead: null, behind: null, changed: 0, lastCommit: null, projects: [{ id: 'c', name: 'c', ship: null }] },
  { top: '/x/d', topShort: '~/code/d', branch: 'dev', upstream: 'origin/dev', ahead: 0, behind: 0, changed: 0, lastCommit: null, projects: [{ id: 'd', name: 'd', ship: null }, { id: 'd2', name: 'd2', ship: null }] },
], totals: {} };
const SCOPES = [
  { key: 'global', name: 'Every project', folder: null, claude: { path: '~/.claude/CLAUDE.md', exists: true, groups: [{ heading: 'Working', rules: ['Never use em dashes', 'Run the tests'] }], count: 2 }, codex: { path: '~/.codex/AGENTS.md', exists: false, groups: [], count: 0 } },
  { key: '/x/trail-map', name: 'trail-map', folder: '~/code/trail-map', claude: { path: 'CLAUDE.md', exists: true, groups: [], count: 0 }, codex: { path: 'AGENTS.md', exists: true, groups: [{ heading: 'AGENTS.md', rules: ['Keep tiles small'] }], count: 1 } },
];
const REPEATS = { seeded: true, rows: [
  { id: 'r1', rule: 'Never use em dashes', kind: 'every', button: 'Add to every project', messages: 4, sessions: 3, lastTs: '2026-11-05T10:00:00.000Z', last: '5 Nov', tail: 'Only trail-map knows this one.', assistants: ['claude', 'codex'], sessionsText: '3 sessions', targets: ['~/.claude/CLAUDE.md'], quote: { text: 'no em dashes please', project: 'trail-map', date: '5 Nov' }, preview: { lead: 'Adds' } },
  { id: 'r2', rule: 'Commit by pathspec', kind: 'add', button: 'Add rule', messages: 2, sessions: 2, lastTs: '2026-11-04T10:00:00.000Z', last: '4 Nov', tail: 'No rule says this yet.', assistants: ['claude'], sessionsText: '2 Claude Code sessions', targets: ['~/.claude/CLAUDE.md'], quote: null, preview: {} },
] };
const SESSIONS = { rows: [
  { sessionId: 's1', pid: 101, projectId: 'weather-widget', label: 'weather-widget', assistant: 'claude', state: 'working', group: 'use', line: 'Caching tiles', folder: '~/code/weather-widget', since: '2026-11-06T10:00:00.000Z', memKb: 612000, closable: false, blocked: 'It is in use.' },
  { sessionId: null, pid: 202, projectId: null, label: 'scratch', assistant: 'codex', state: 'unknown', group: 'unmapped', line: 'No session found for pid 202', folder: '~/scratch', since: '2026-11-06T09:00:00.000Z', memKb: 120000, closable: false, blocked: 'Not mapped to a session' },
] };
const ctx = { projects: SNAP_PROJECTS, ship: SHIP, scopes: SCOPES, repeats: REPEATS, sessions: SESSIONS, read: (p) => (p === '~/.claude/CLAUDE.md' ? '# Working\n- Never use em dashes\n' : null) };
const items = Object.fromEntries(Object.keys(providers.BUILDERS).map((id) => [id, providers.itemsOf(id, ctx)]));
check('there is one adapter for every provider in providers-1.json', JSON.stringify(Object.keys(providers.BUILDERS).sort()) === JSON.stringify(Object.keys(CONTRACT).sort()), Object.keys(providers.BUILDERS).join(', '));
for (const id of Object.keys(CONTRACT)) {
  const bad = fieldsOk(id, items[id]);
  check(`${id}: ${items[id].length} item${items[id].length === 1 ? '' : 's'}, the contract's fields only, each of its type`, items[id].length > 0 && bad.length === 0, bad.slice(0, 6).join('; '));
}
const ww = items.projects.find((x) => x.id === 'weather-widget');
check('projects: a loose session folder is not a project; the brief, its objectives and the running plan are there', items.projects.length === 2 && ww.brief.goal === brief.goal && ww.objectives.length === 2 && ww.objectives[0].plan === true && ww.plan.title === 'Radar tiles' && ww.plan.step === 4 && ww.plan.total === 6 && ww.plan_files[0].done === 8 && ww.machine === 'gpu-box', JSON.stringify({ plan: ww.plan, obj: ww.objectives.map((o) => [o.title, o.state, o.done, o.total]) }));
check('projects: Objectives\' rows for ravenry:objective-rows (the plan\'s dot strip, a task row, a plan file\'s bar)', ww.$ravenry.rows.map((r) => r.kind).join(',') === 'plan,tasks,file' && ww.$ravenry.rows[0].count === 'Step 4 of 6' && /^Running: cache tiles for an hour$/.test(ww.$ravenry.rows[0].next.text) && ww.$ravenry.rows[1].next === 'Next: merge two edits made offline' && ww.$ravenry.rows[2].count === '8 of 11', JSON.stringify(ww.$ravenry.rows.map((r) => [r.kind, r.count, r.next])));
const p0 = items.plans[0];
check('plans: through planfmt derive, with its row', items.plans.length === 1 && p0.id === 'weather-widget/Radar tiles' && p0.state === 'running' && p0.step === 4 && p0.done === 3 && p0.total === 6 && p0.$ravenry.row.dots.length === 6, JSON.stringify(p0));
check('brief: ship tasks, open notes, waiting on', items.brief[0].ship.length === 2 && items.brief[0].ship[1].state === 'you' && items.brief[0].open_notes === 1 && items.brief[0].waiting_on === 'tile licence', JSON.stringify(items.brief[0]));
const st = items.git.map((g) => [g.status, g.status_text]);
check('git: the Ship card\'s line as status and status_text, in its order', JSON.stringify(st) === JSON.stringify([['ahead', '3 commits to push'], ['changed', 'Uncommitted changes'], ['no_upstream', 'No upstream'], ['clean', 'Pushed and clean']]), JSON.stringify(st));
check('git: ship tasks, waiting on you, the ship command, the picture', items.git[0].ship_waiting === 1 && items.git[0].ship_command === 'npm publish' && items.git[0].picture.startsWith('/api/pic/') && items.git[3].projects.join() === 'd,d2' && items.git[1].ship_waiting === 0);
check('rule-files: every scope\'s two files, with the global one\'s text', items['rule-files'].length === 4 && items['rule-files'][0].body.includes('em dashes') && items['rule-files'][3].scope === '~/code/trail-map' && items['rule-files'][3].path === '~/code/trail-map/AGENTS.md');
check('repeats and sessions', items.repeats.length === 2 && items.repeats[0].sessions_text === '3 sessions' && items.sessions[1].id === 'pid:202' && items.sessions[0].machine === 'gpu-box');
// The shipped pages draw these: their numbers and the ship card's line.
const defaults = Object.fromEntries(fs.readdirSync(path.join(ROOT, 'pages', 'defaults')).map((f) => [f.replace('.page.yaml', ''), pf.checkPage(fs.readFileSync(path.join(ROOT, 'pages', 'defaults', f), 'utf8'), { fileName: f }).page]));
check('the shipped pages check', Object.values(defaults).every(Boolean) && Object.keys(defaults).length === 5);
check('the shipped Ship page shows the status line under each repo\'s name', defaults.ship.tabs[0].sections[1].item.subtitle === 'status_text');
check('their numbers: Plans "1 running", Rules 2, Ship 1, Objectives none', pf.navNumber(items.plans, defaults.plans.nav) === 1 && defaults.plans.nav.countLabel === 'running' && pf.navNumber(items.repeats, defaults.rules.nav) === 2 && pf.navNumber(items.git, defaults.ship.nav) === 1 && pf.navNumber(items.projects, defaults.objectives.nav) === null);

// ------------------------------------------------------------ the move off ideas.json
const FIX = path.join(ROOT, 'tools', 'fixtures', 'ideas');
const H1 = path.join(T, 'move-home');
fs.mkdirSync(path.join(H1, 'ideas'), { recursive: true });
fs.copyFileSync(path.join(FIX, 'ideas.json'), path.join(H1, 'ideas.json'));
png(path.join(H1, 'ideas', 'mh9q1x2abc-mhk2a1.png'), [200, 120, 80]);
png(path.join(H1, 'ideas', 'mh7k3p9def-mh7k4b.png'), [60, 90, 160]);
png(path.join(H1, 'ideas', 'mh5b8c1ghi-mh5b9z.png'), [80, 160, 90]);
for (const n of [1, 2]) for (const k of ['a', 'b', 'c']) { png(path.join(H1, 'ideas', 'mh7k3p9def', 'mockups', `r${n}-${k}.png`), [n * 60, 40, 200]); fs.writeFileSync(path.join(H1, 'ideas', 'mh7k3p9def', 'mockups', `r${n}-${k}.html`), `<p>round ${n} ${k}</p>`); }
fs.writeFileSync(path.join(H1, 'ideas', 'mh7k3p9def', 'mockups', 'rounds.jsonl'), '{"round":1}\n{"round":2}\n');
const before = { json: fs.readFileSync(path.join(H1, 'ideas.json'), 'utf8'), dir: hashTree(path.join(H1, 'ideas')) };
const logs = [];
const m1 = ideasfiles.migrate(H1, { now: new Date('2026-11-06T12:00:00Z'), log: (s) => logs.push(s) });
const D = ideasfiles.dirsOf(H1);
const live = fs.readdirSync(D.dir).filter((f) => f.endsWith('.md')).sort();
const arch = fs.readdirSync(D.archive).filter((f) => f.endsWith('.md')).sort();
check('the move: 4 ideas as files and 2 archived ones, in ~/.ravenry/pages/ideas/', m1.done && m1.ideas === 4 && m1.archived === 2 && live.length === 4 && arch.length === 2, JSON.stringify({ m1, live, arch }));
const fileOf = (id) => [...live.map((f) => path.join(D.dir, f)), ...arch.map((f) => path.join(D.archive, f))].find((f) => pf.parseItem(fs.readFileSync(f, 'utf8')).fields.id === id);
const boat = pf.parseItem(fs.readFileSync(fileOf('mh7k3p9def'), 'utf8')).fields;
check('each file: title, stage in the page\'s words, pitch, status, picture, id', boat.title === 'Paper Boat' && boat.stage === 'mockup' && boat.pitch === 'Steer a paper boat down a gutter river without sinking.' && boat.picture === 'mockups/mh7k3p9def/r2-b.png' && boat.status === 'Two mockup rounds; B picked.', JSON.stringify(boat));
const stages = Object.fromEntries(['mh9q1x2abc', 'mh7k3p9def', 'mh5b8c1ghi', 'mh3z0q4jkl'].map((id) => [id, pf.parseItem(fs.readFileSync(fileOf(id), 'utf8')).fields.stage]));
check('stages: spark, mock, green, park become spark, mockup, greenlit, parked', JSON.stringify(Object.values(stages)) === JSON.stringify(['spark', 'mockup', 'greenlit', 'parked']), JSON.stringify(stages));
const tricky = pf.parseItem(fs.readFileSync(fileOf('mh1x6s6pqr'), 'utf8')).fields;
check('a title with a colon reads back as written', tricky.title === 'Notes: Sync, again' && tricky.pitch.endsWith('yes, another one.'), JSON.stringify(tricky));
const ownBoat = JSON.parse(fs.readFileSync(path.join(D.own, 'mh7k3p9def.json'), 'utf8'));
const ownTide = JSON.parse(fs.readFileSync(path.join(D.own, 'mh9q1x2abc.json'), 'utf8'));
const ownRadar = JSON.parse(fs.readFileSync(path.join(D.own, 'mh3z0q4jkl.json'), 'utf8'));
check('threads kept: messages, a picture in one, an error', ownTide.thread.length === 4 && ownTide.thread[2].images[0] === 'mh9q1x2abc-mhk2a1.png' && ownTide.thread[3].error === true && ownTide.created === '2026-11-04T17:58:00.000Z');
check('mockups kept: both rounds, B picked, the dropped picture, the round lines in the thread', ownBoat.mockups.rounds.length === 2 && ownBoat.mockups.rounds[1].picked === 'b' && ownBoat.dropped === 'mh7k3p9def-mh7k4b.png' && ownBoat.thread.filter((x) => x.mockupRound).length === 2);
check('a reply that was running is kept as it was (the board that loads it says it restarted)', ownRadar.pending && ownRadar.pending.who === 'codex' && ownRadar.thread.length === 1);
const board = JSON.parse(fs.readFileSync(D.board, 'utf8'));
check('the board\'s order, its last brainstorm and the one running are kept', board.order.length === 6 && board.order[0] === 'mh9q1x2abc' && board.lastBrainstorm.seed === 'a cosy co-op game for the TV' && board.brainstorm.seed === 'a calm puzzle game');
const promoted = JSON.parse(fs.readFileSync(path.join(D.own, 'mh2y7r5mno.json'), 'utf8'));
check('archived ones keep why (promoted to a project)', promoted.promotedTo === 'recipe-box' && promoted.archivedWhy === 'promoted');
check('pictures and mockup rounds copied: pictures/, mockups/<id>/', fs.existsSync(path.join(D.pictures, 'mh9q1x2abc-mhk2a1.png')) && fs.existsSync(path.join(D.pictures, 'mh7k3p9def-mh7k4b.png')) && fs.existsSync(path.join(D.mockups, 'mh7k3p9def', 'r2-b.png')) && fs.existsSync(path.join(D.mockups, 'mh7k3p9def', 'r1-c.html')) && fs.existsSync(path.join(D.mockups, 'mh7k3p9def', 'rounds.jsonl')));
check('ideas.json and ideas/ are exactly as they were', fs.readFileSync(path.join(H1, 'ideas.json'), 'utf8') === before.json && JSON.stringify(hashTree(path.join(H1, 'ideas'))) === JSON.stringify(before.dir));
const bk = path.join(H1, 'backups', 'ideas-2026-11-06T12-00-00-000Z');
check('a backup of both, first', fs.readFileSync(path.join(bk, 'ideas.json'), 'utf8') === before.json && JSON.stringify(hashTree(path.join(bk, 'ideas'))) === JSON.stringify(before.dir));
check('no half folder left, and the move says what it did', !fs.readdirSync(path.join(H1, 'pages')).some((f) => f.startsWith('.ideas-moving')) && /moved 4 ideas \(and 2 archived\)/.test(logs.join('\n')), logs.join(' | '));
const after1 = hashTree(path.join(H1, 'pages'));
const m2 = ideasfiles.migrate(H1, { log: () => {} });
check('a second run does nothing', !m2.done && m2.why === 'ran already' && JSON.stringify(hashTree(path.join(H1, 'pages'))) === JSON.stringify(after1));
// The shipped Ideas page reads the result: its board's lanes.
const ideasPage = defaults.ideas;
const src = ideasPage.tabs[0].sections[1].source;
const read = live.map((f) => pf.readItem(fs.readFileSync(path.join(D.dir, f), 'utf8'), { file: f, fields: src.fields }));
const lanes = pf.groupItems(read.map((r) => r.item), 'stage', src.fields.stage).map((g) => `${g.value} ${g.items.length}`);
check('the Ideas page reads them: Spark 1, Mockup 1, Greenlit 1, Parked 1, with no warnings', lanes.join(', ') === 'spark 1, mockup 1, greenlit 1, parked 1' && read.every((r) => r.problems.length === 0), lanes.join(', ') + JSON.stringify(read.flatMap((r) => r.problems)));
// A board that never had ideas: nothing to move.
const H0 = path.join(T, 'empty-home');
fs.mkdirSync(H0, { recursive: true });
check('a board without ideas.json has nothing to move', ideasfiles.migrate(H0, { log: () => {} }).why === 'no ideas.json' && !fs.existsSync(path.join(H0, 'pages')));
// A move into a folder made by hand meanwhile keeps that folder's ideas.
const H2 = path.join(T, 'merge-home');
fs.mkdirSync(path.join(H2, 'pages', 'ideas'), { recursive: true });
fs.copyFileSync(path.join(FIX, 'ideas.json'), path.join(H2, 'ideas.json'));
fs.writeFileSync(path.join(H2, 'pages', 'ideas', 'tide-pool.md'), '---\ntitle: Tide Pool, my version\nstage: greenlit\nid: mh9q1x2abc\n---\nMine.\n');
const m3 = ideasfiles.migrate(H2, { log: () => {} });
check('into a folder made by hand: its own ideas stay, the same id is not written twice', m3.done && m3.ideas === 3 && fs.readFileSync(path.join(H2, 'pages', 'ideas', 'tide-pool.md'), 'utf8').includes('my version') && !fs.existsSync(path.join(H2, 'pages', 'ideas', 'tide-pool-2.md')), JSON.stringify(m3));

// The board's Ideas code on the moved folder: the test guard's own home.
fs.cpSync(H1, GUARD_HOME, { recursive: true });
const ideas = await import('../server/ideas.mjs');
const v = ideas.view();
const vb = v.ideas.find((x) => x.id === 'mh7k3p9def');
check('the Ideas code reads the files: 4 live ideas, stages, pictures, threads, mockups', v.ideas.length === 4 && v.archived === 2 && vb.stage === 'mock' && vb.img === '/api/ideas/img/mh7k3p9def%2Fmockups%2Fr2-b.png' && vb.mockups.rounds.length === 2 && vb.mockups.dropped === '/api/ideas/img/mh7k3p9def-mh7k4b.png' && v.ideas.find((x) => x.id === 'mh9q1x2abc').thread.length === 4, JSON.stringify(vb && { stage: vb.stage, img: vb.img, dropped: vb.mockups && vb.mockups.dropped }));
const radar = v.ideas.find((x) => x.id === 'mh3z0q4jkl');
check('loaded, a reply and a brainstorm that were running say the board restarted, under who was answering', !radar.pending && radar.thread.slice(-1)[0].error && radar.thread.slice(-1)[0].who === 'codex' && /The board restarted before Codex answered/.test(radar.thread.slice(-1)[0].text) && /restarted before the directions came back/.test(v.brainstormError || ''), JSON.stringify([radar.thread.slice(-1)[0], v.brainstormError]));
check('its pictures are served from the new folder', ideas.picturePath('mh7k3p9def/mockups/r1-a.png') === path.join(GUARD_HOME, 'pages', 'ideas', 'mockups', 'mh7k3p9def', 'r1-a.png') && ideas.picturePath('mh9q1x2abc-mhk2a1.png') === path.join(GUARD_HOME, 'pages', 'ideas', 'pictures', 'mh9q1x2abc-mhk2a1.png'));
// A comment someone added stays when the board moves an idea.
const gp = path.join(GUARD_HOME, 'pages', 'ideas', fs.readdirSync(path.join(GUARD_HOME, 'pages', 'ideas')).find((f) => f.startsWith('garden-planner')));
fs.writeFileSync(gp, fs.readFileSync(gp, 'utf8').replace('---\ntitle:', '---\n# my note: keep this\ntitle:'));
await sleep(20);
ideas.update('mh5b8c1ghi', { stage: 'park' });
const gpText = fs.readFileSync(gp, 'utf8');
check('moving an idea writes its stage field by field: the comment stays, the stage reads parked', gpText.includes('# my note: keep this') && /\nstage: parked\n/.test(gpText) && gpText.includes('pitch: "A planting calendar'), gpText);
// An agent edits a file: the board sees it.
const tp = path.join(GUARD_HOME, 'pages', 'ideas', fs.readdirSync(path.join(GUARD_HOME, 'pages', 'ideas')).find((f) => f.startsWith('tide-pool')));
fs.writeFileSync(tp, fs.readFileSync(tp, 'utf8').replace('stage: spark', 'stage: greenlit'));
check('an idea file changed by someone else is read again', ideas.view().ideas.find((x) => x.id === 'mh9q1x2abc').stage === 'green');
const added = ideas.add({ name: 'Kite Mail', pitch: 'Letters on kites.' });
const kite = path.join(GUARD_HOME, 'pages', 'ideas', 'kite-mail.md');
check('a new idea is a new file', fs.existsSync(kite) && pf.parseItem(fs.readFileSync(kite, 'utf8')).fields.id === added.id && ideas.view().ideas[0].id === added.id);
ideas.kill(added.id);
check('dropping an idea moves its file into .archive/', !fs.existsSync(kite) && fs.existsSync(path.join(GUARD_HOME, 'pages', 'ideas', '.archive', 'kite-mail.md')) && ideas.count() === 4);

// ------------------------------------------------------------ a real board
const MC = path.join(T, 'mc');
const HOME = path.join(T, 'home');
const PROJ = path.join(T, 'trail-map');
const DEF = path.join(T, 'defaults');
for (const d of [MC, HOME, PROJ, path.join(HOME, '.claude'), path.join(MC, 'pages'), DEF]) fs.mkdirSync(d, { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'pages', 'defaults'))) fs.copyFileSync(path.join(ROOT, 'pages', 'defaults', f), path.join(DEF, f));
// The playtest page and its notes, as an agent writes them.
const PT = path.join(REPO, 'packages', 'page-format', 'fixtures', 'playtest');
fs.copyFileSync(path.join(PT, 'playtest.page.yaml'), path.join(MC, 'pages', 'playtest.page.yaml'));
fs.cpSync(path.join(PT, 'playtest'), path.join(MC, 'pages', 'playtest'), { recursive: true });
fs.appendFileSync(path.join(MC, 'pages', 'playtest', 'splash-plays-twice.md'), '\n- [ ] Mute the second splash\n- [x] Find where it plays\n');
// A project page from a cloned repo.
fs.mkdirSync(path.join(PROJ, '.ravenry', 'pages', 'regions'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'packages', 'page-format', 'fixtures', 'valid', 'tiles.page.yaml'), path.join(PROJ, '.ravenry', 'pages', 'tiles.page.yaml'));
for (const [n, r, tiles, st] of [['lake', 'Lake District', 1204, 'checked'], ['peak', 'Peak District', 986, 'needs a look']]) fs.writeFileSync(path.join(PROJ, '.ravenry', 'pages', 'regions', `${n}.md`), `---\nregion: ${r}\ntiles: ${tiles}\nbuilt: 2026-10-30\nstatus: ${st}\n---\n`);
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [{ id: 'trail-map', name: 'trail-map', folder: PROJ, workspaces: [], brief: null }] }, null, 2));
const PORT = 4795;
let boardLog = '';
const env = {
  HOME, PATH: process.env.PATH, LANG: 'en_US.UTF-8', RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_TERMINAL: 'iterm', RAVENRY_DAEMON_BIN: 'none',
  RAVENRY_PAGE_DEFAULTS: DEF, MC_NO_EVENTS: '1', MC_NO_AUTOSTART: '1', MC_CODEX: '0', TEST_RAVENRY: '1', MC_TEST: '1',
  MC_CLAUDE_SETTINGS: path.join(T, 'settings.json'), MC_CLAUDE_PROJECTS: path.join(HOME, '.claude', 'projects'), MC_GLOBAL_CLAUDE_MD: path.join(HOME, '.claude', 'CLAUDE.md'),
  ITERM_OSASCRIPT_BIN: path.join(ROOT, 'tools', 'stub-osascript.mjs'), MC_OSASCRIPT_BIN: path.join(ROOT, 'tools', 'stub-osascript.mjs'), STUB_OSASCRIPT_LOG: path.join(T, 'osascript.jsonl'),
  MC_PS_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), MC_LSOF_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), STUB_PS_STATE: path.join(T, 'ps.json'),
};
fs.writeFileSync(path.join(T, 'ps.json'), '[]');
const boardProc = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
boardProc.stdout.on('data', (d) => { boardLog += d; });
boardProc.stderr.on('data', (d) => { boardLog += d; });
process.on('exit', () => boardProc.kill('SIGTERM'));
const base = `http://localhost:${PORT}`;
const get = async (p) => { const r = await fetch(base + p); const t = await r.text(); let b = null; try { b = JSON.parse(t); } catch { /* bytes */ } return { status: r.status, body: b, text: t, type: r.headers.get('content-type') }; };
const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) }); const t = await r.text(); let b = null; try { b = JSON.parse(t); } catch { /* not JSON */ } return { status: r.status, body: b, text: t }; };
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const x = await fn().catch(() => null); if (x || Date.now() > end) return x; await sleep(100); } }
const rows = async () => ((await get('/api/state')).body || {}).pages || [];
const s0 = await until(async () => { const r = await rows(); return r.length >= 7 ? r : null; }, 20000);
check('the board lists the pages: the shipped five, then added ones, then a project\'s with its name', !!s0 && s0.map((r) => r.label).join(',') === 'Objectives,Plans,Ideas,Rules,Ship,Playtest notes,Map tiles' && s0[6].project === 'trail-map' && s0[6].trust === 'untrusted' && s0[5].origin === 'global', JSON.stringify(s0 && s0.map((r) => [r.label, r.origin, r.project])) + boardLog.slice(-1500));
check('the Playtest row counts its new notes, as its nav line asks', s0 && s0[5].number === 4 && s0[5].icon === 'flag', JSON.stringify(s0 && s0[5]));
const pg = (await get('/api/pages/page?key=playtest')).body.page;
const board0 = pg.items.sections[0][0];
check('a page: its model and its items, newest change first, with each one\'s hash', pg.ok && pg.model.title === 'Playtest notes' && board0.length === 9 && board0.every((it) => /^[0-9a-f]{64}$/.test(it.$hash) && it.$base === 'playtest/'), JSON.stringify(pg.problems));
const groups = pf.groupItems(board0, 'status', pg.model.source.fields.status).map((g) => `${g.value} ${g.items.length}`);
check('its board: new 4, fixing 2, fixed 3', groups.join(', ') === 'new 4, fixing 2, fixed 3', groups.join(', '));
// The drawn page (server/pagedraw.mjs): the hub's lanes, which the app and the phone draw.
const dsec = pg.drawn && pg.drawn.sections[0];
const dlanes = dsec ? dsec.groups.map((g) => `${g.value} ${g.count}`).join(', ') : '';
check('the page as drawn: its board\'s lanes as the format groups them, each row with the buttons that apply', pg.drawn.tab === 0 && pg.drawn.tabs.length === 1 && dlanes === groups.join(', ') && dsec.rows.length === 9 && dsec.groups[0].rows.every((i) => dsec.rows[i].status === 'new') && dsec.rows.every((r) => JSON.stringify(r.$actions) === '[0,1]'), dlanes);
const rules1 = (await get('/api/pages/page?key=rules&tab=1')).body.page;
const rules9 = (await get('/api/pages/page?key=rules&tab=9')).body.page;
check('the tab asked for is the one drawn (?tab=), with every tab\'s count; one past the last is the last', rules1.drawn.tab === 1 && rules1.drawn.tabs.map((t) => t.label).join('|') === 'Your rules|Suggested' && rules1.drawn.tabs[1].count === rules1.drawn.sections[0].count && rules1.drawn.sections.length === 2 && rules9.drawn.tab === 1, JSON.stringify(rules1.drawn.tabs));
const pic = await get('/api/pages/img?key=playtest&path=playtest/shots/dock-clip.png');
check('its pictures are served from its folder, and nothing else', pic.status === 200 && pic.type === 'image/png' && (await get('/api/pages/img?key=playtest&path=../projects.json')).status === 404 && (await get('/api/pages/img?key=playtest&path=playtest/boat-clips-the-dock.md')).status === 404);

// Writes.
const NOTE = path.join(MC, 'pages', 'playtest', 'boat-clips-the-dock.md');
const note = board0.find((x) => x.file === 'boat-clips-the-dock.md');
const noteBefore = fs.readFileSync(NOTE, 'utf8');
const w1 = await post('/api/pages/item/set', { key: 'playtest', file: note.file, hash: note.$hash, fields: { status: note.status }, patch: { status: 'fixed' } });
const noteAfter = fs.readFileSync(NOTE, 'utf8');
check('Fixed sets status in the note: that line only', w1.status === 200 && noteAfter === noteBefore.replace('status: new', 'status: fixed') && w1.body.item.status === 'fixed', w1.text);
const stale = await post('/api/pages/item/set', { key: 'playtest', file: note.file, hash: note.$hash, fields: { status: 'new' }, patch: { status: 'fixing' } });
check('a write against what the screen showed before: a conflict, with what is in the file now, and nothing written', stale.status === 409 && stale.body.conflict[0].field === 'status' && stale.body.conflict[0].current === 'fixed' && stale.body.item.status === 'fixed' && fs.readFileSync(NOTE, 'utf8') === noteAfter, stale.text);
const rebased = await post('/api/pages/item/set', { key: 'playtest', file: note.file, hash: note.$hash, fields: { device: note.device, status: note.status }, patch: { device: 'Pixel 9' } });
check('a change to another field meanwhile: the patch is made again on the new file', rebased.status === 200 && rebased.body.rebased === true && /status: fixed\n/.test(fs.readFileSync(NOTE, 'utf8')) && /device: Pixel 9\n/.test(fs.readFileSync(NOTE, 'utf8')), rebased.text);
const badVal = await post('/api/pages/item/set', { key: 'playtest', file: note.file, hash: rebased.body.item.$hash, patch: { status: 'wontfix' } });
const badField = await post('/api/pages/item/set', { key: 'playtest', file: note.file, hash: rebased.body.item.$hash, patch: { owner: 'x' } });
const badFile = await post('/api/pages/item/set', { key: 'playtest', file: '../../projects.json', hash: 'x', patch: { status: 'new' } });
check('a value not declared, a field not declared and a file outside the folder are refused', badVal.status === 400 && badField.status === 400 && badFile.status === 400, [badVal.text, badField.text, badFile.text].join(' | '));
const sp = (await get('/api/pages/page?key=playtest')).body.page.items.sections[0][0].find((x) => x.file === 'splash-plays-twice.md');
const box = sp.$boxes.find((b) => b.text === 'Mute the second splash');
const tg = await post('/api/pages/item/toggle', { key: 'playtest', file: sp.file, line: box.line, text: box.text });
check('toggle ticks the box it was shown, by its text', tg.status === 200 && tg.body.done === true && fs.readFileSync(path.join(MC, 'pages', 'playtest', 'splash-plays-twice.md'), 'utf8').includes('- [x] Mute the second splash'), tg.text);
const tg2 = await post('/api/pages/item/toggle', { key: 'playtest', file: sp.file, line: box.line, text: 'Mute the splash' });
check('a box whose text changed is not ticked', tg2.status === 409, tg2.text);
const cr = await post('/api/pages/item/create', { key: 'playtest', action: { scope: 'page', index: 0 }, fields: { title: 'Wake looks square', project: 'paper-boat', device: 'Pixel 8' }, body: 'Behind the boat, on the left turn.' });
const crText = cr.body && fs.readFileSync(path.join(MC, 'pages', 'playtest', cr.body.file), 'utf8');
check('New note makes a file named after it, with the default fields', cr.status === 200 && cr.body.file === 'wake-looks-square.md' && /^---\ntitle: Wake looks square\nstatus: new\nproject: paper-boat\ndevice: Pixel 8\n---\nBehind the boat/.test(crText), cr.text + crText);
const cr2 = await post('/api/pages/item/create', { key: 'playtest', action: { scope: 'page', index: 0 }, fields: { title: 'Wake looks square' } });
check('a second one with the same title gets -2, never replacing the first', cr2.status === 200 && cr2.body.file === 'wake-looks-square-2.md');
const ar = await post('/api/pages/item/archive', { key: 'playtest', file: 'wake-looks-square-2.md' });
check('archive moves the file into .archive/', ar.status === 200 && fs.existsSync(path.join(MC, 'pages', 'playtest', '.archive', 'wake-looks-square-2.md')) && !fs.existsSync(path.join(MC, 'pages', 'playtest', 'wake-looks-square-2.md')));
const rs = await post('/api/pages/item/restore', { key: 'playtest', file: 'wake-looks-square-2.md' });
check('and undo brings it back', rs.status === 200 && fs.existsSync(path.join(MC, 'pages', 'playtest', 'wake-looks-square-2.md')));
const prov = await post('/api/pages/item/set', { key: 'objectives', file: 'x.md', hash: 'x', patch: { name: 'y' } });
check('a provider\'s items cannot be written', prov.status === 409, prov.text);
check('the Playtest row\'s number follows the files', await until(async () => (await rows()).find((r) => r.key === 'playtest').number === 5, 6000));

// Trust for the project page.
const tiles = (await get('/api/pages/page?key=trail-map%2Ftiles')).body.page;
check('a project page shows, read-only, with what its buttons would do', tiles.ok && tiles.trust.state === 'untrusted' && tiles.trust.actions.map((a) => a.label).join(',') === 'Ask Claude about tiles,Rebuild tiles,Mark checked' && /Runs npm run build:tiles in ~?.*trail-map, with REGION set to the item's region\. You approve each run first\./.test(tiles.trust.actions[1].does), JSON.stringify(tiles.trust));
const lake = tiles.items.sections[0][0].find((x) => x.file === 'lake.md');
const peak = tiles.items.sections[0][0].find((x) => x.file === 'peak.md');
const off = await post('/api/pages/item/set', { key: 'trail-map/tiles', file: 'peak.md', hash: peak.$hash, patch: { status: 'checked' } });
const offRun = await post('/api/pages/run', { key: 'trail-map/tiles', at: { scope: 'item', tab: 0, section: 0, index: 0 }, item: { file: 'lake.md' } });
check('its buttons are off until it is trusted: a write and a run are refused', off.status === 403 && offRun.status === 403 && /trust/.test(off.body.error), off.text + offRun.text);
const tr = await post('/api/pages/trust', { key: 'trail-map/tiles', hash: crypto.createHash('sha256').update(fs.readFileSync(path.join(PROJ, '.ravenry', 'pages', 'tiles.page.yaml'), 'utf8')).digest('hex') });
const on = await post('/api/pages/item/set', { key: 'trail-map/tiles', file: 'peak.md', hash: peak.$hash, patch: { status: 'checked' } });
check('trusted, for this exact file: Mark checked writes', tr.status === 200 && on.status === 200 && !!(await until(async () => (await rows()).find((r) => r.key === 'trail-map/tiles').trust === 'trusted', 6000)), tr.text + on.text);
const run = await post('/api/pages/run', { key: 'trail-map/tiles', at: { scope: 'item', tab: 0, section: 0, index: 0 }, item: { file: 'lake.md' } });
check('a trusted run button still goes through approve-and-run (no ravenryd here: refused, nothing ran)', [409, 502].includes(run.status) && /ravenryd/.test(run.body.error), run.text);
fs.appendFileSync(path.join(PROJ, '.ravenry', 'pages', 'tiles.page.yaml'), '# pulled a change\n');
const changed = await until(async () => { const r = (await rows()).find((x) => x.key === 'trail-map/tiles'); return r && r.trust === 'changed' ? r : null; }, 6000);
const off2 = await post('/api/pages/item/set', { key: 'trail-map/tiles', file: 'lake.md', hash: lake.$hash, patch: { status: 'out of date' } });
check('the file changed (a pull): read-only again, and the bar asks again', !!changed && off2.status === 403, off2.text);
const trustRec = JSON.parse(fs.readFileSync(path.join(MC, 'pages.json'), 'utf8'));
check('trust is kept in the hub\'s record, pinned to path and content', trustRec.trust.length === 1 && trustRec.trust[0].path === path.join(PROJ, '.ravenry', 'pages', 'tiles.page.yaml') && /^[0-9a-f]{64}$/.test(trustRec.trust[0].hash));

// A page file with a mistake keeps its last good version.
const PFILE = path.join(MC, 'pages', 'playtest.page.yaml');
const good = fs.readFileSync(PFILE, 'utf8');
fs.writeFileSync(PFILE, good.replace('    group_by: status', '    group_by: stauts').replace('values: [new, fixing, fixed]', 'values: [new, fixing, fixed, wontfix]'));
const broken = await until(async () => { const r = (await rows()).find((x) => x.key === 'playtest'); return r && r.error ? r : null; }, 6000);
const bv = (await get('/api/pages/page?key=playtest')).body.page;
const err = bv.problems.find((p) => p.severity === 'error');
check('a mistake: the row has the red dot, the page keeps its last good version under the problem', !!broken && broken.number === 5 && !bv.ok && bv.stale && bv.model.tabs[0].sections[0].groupBy === 'status' && err.line === 14 && err.text === "playtest.page.yaml line 14: 'stauts' is not a field. Did you mean status?" && err.lineText === '    group_by: stauts', JSON.stringify(err));
const brokenNote = bv.items.sections[0][0].find((x) => x.file === 'splash-plays-twice.md');
const onBroken = await post('/api/pages/item/set', { key: 'playtest', file: brokenNote.file, hash: brokenNote.$hash, patch: { device: 'Pixel 8a' } });
check('and its last good version\'s buttons keep working (a page of the person\'s own)', onBroken.status === 200, onBroken.text);
fs.writeFileSync(PFILE, good);
check('fixed: the dot goes', !!(await until(async () => { const r = (await rows()).find((x) => x.key === 'playtest'); return r && !r.error ? r : null; }, 6000)));

// Customize, and "changed since your copy".
const cu = await post('/api/pages/customize', { key: 'objectives' });
const copy = path.join(MC, 'pages', 'objectives.page.yaml');
const cuRows = await until(async () => { const r = await rows(); return r.find((x) => x.key === 'objectives' && x.origin === 'global') ? r : null; }, 6000);
check('Customize copies the page to ~/.ravenry/pages/, stamped, and the copy takes its place', cu.status === 200 && /\nid: objectives\nfrom: ravenry\/objectives@1\n/.test(fs.readFileSync(copy, 'utf8')) && !/\nrevision:/.test(fs.readFileSync(copy, 'utf8')) && !!cuRows && cuRows[0].key === 'objectives' && cuRows[0].origin === 'global', cu.text);
check('a second Customize does not replace the copy', (await post('/api/pages/customize', { key: 'objectives' })).status === 409);
fs.mkdirSync(path.join(T, 'history'), { recursive: true });
fs.copyFileSync(path.join(DEF, 'objectives.page.yaml'), path.join(T, 'history', 'objectives-r1.page.yaml'));
fs.writeFileSync(path.join(DEF, 'objectives.page.yaml'), fs.readFileSync(path.join(DEF, 'objectives.page.yaml'), 'utf8').replace('revision: 1', 'revision: 2').replace('      badges: [machine]\n', '      badges: [machine]\n      time: updated\n'));
const ch = await until(async () => { const r = (await rows()).find((x) => x.key === 'objectives'); return r && r.defaultChanged ? r : null; }, 6000);
const chv = (await get('/api/pages/page?key=objectives')).body.page;
check('the default changed since the copy: the row and the page say so, with both versions of the default', !!ch && chv.defaultChanged.from === 1 && chv.defaultChanged.to === 2 && /revision: 2/.test(chv.defaultText) && /revision: 1/.test(chv.historyText), JSON.stringify(chv.defaultChanged));
check('See what changed comes drawn: the line the default added, marked, with its number', Array.isArray(chv.changed) && chv.changed.some((l) => l.add && /time: updated/.test(l.text) && l.n > 1) && !chv.changed.some((l) => l.add && /^revision:/.test(l.text)), JSON.stringify(chv.changed));
const dm = await post('/api/pages/dismiss', { key: 'objectives' });
check('dismissed, it goes until the next revision', dm.status === 200 && !!(await until(async () => { const r = (await rows()).find((x) => x.key === 'objectives'); return r && !r.defaultChanged ? r : null; }, 6000)));

// Check and docs, as `ravenry page check` and `ravenry page docs` ask them.
const ck = await post('/api/pages/check', { path: PFILE, text: good });
check('page check: OK and what it draws, with the folder\'s items counted', ck.status === 200 && ck.body.ok && ck.body.summary === 'board by status: New 5, Fixing 2, Fixed 4. 3 buttons.', ck.text);
const ck2 = await post('/api/pages/check', { path: PFILE, text: good.replace('group_by: status', 'group_by: stauts') });
check('page check: the problem by line, with Did you mean', ck2.status === 200 && !ck2.body.ok && ck2.body.problems[0].text === "playtest.page.yaml line 14: 'stauts' is not a field. Did you mean status?", ck2.text);
const dc = await get('/api/pages/docs?topic=board');
check('page docs: a topic, from the generated docs', dc.status === 200 && /^Page files, version 1\.\n\n### board\n/.test(dc.body.text) && (await get('/api/pages/docs?topic=nothing-like-this')).status === 404, dc.text.slice(0, 200));
// The two commands agents run: npm's board's, and the app's ravenry binary
// (when RAVENRYD_BIN names one), which asks this board.
const npm = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'ravenry.mjs'), 'page', 'check', PFILE], { env: { ...env }, encoding: 'utf8' });
check('npm\'s ravenry page check: OK and what it draws', npm.status === 0 && npm.stdout.trim() === 'OK  board by status: New 5, Fixing 2, Fixed 4. 3 buttons.', npm.stdout + npm.stderr);
const BIN = process.env.RAVENRYD_BIN && path.resolve(process.env.RAVENRYD_BIN);
if (BIN) {
  const cliEnv = { HOME, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', RAVENRY_HUB_URL: base, RAVENRY_RUNTIME_DIR: path.join(T, 'rt'), RAVENRY_STATE_DIR: path.join(T, 'state') };
  const ok = spawnSync(BIN, ['page', 'check', PFILE], { env: cliEnv, encoding: 'utf8' });
  const BAD = path.join(MC, 'pages', 'bad.page.yaml');
  fs.writeFileSync(BAD, good.replace('id: playtest', 'id: bad').replace('group_by: status', 'group_by: stauts'));
  const bad = spawnSync(BIN, ['page', 'check', BAD], { env: cliEnv, encoding: 'utf8' });
  fs.rmSync(BAD);
  const docs = spawnSync(BIN, ['page', 'docs', 'board'], { env: cliEnv, encoding: 'utf8' });
  check('the ravenry binary\'s page check asks the board: OK, or each problem by line and exit 1; page docs from the binary', ok.status === 0 && ok.stdout.startsWith('OK  board by status: New 5') && bad.status === 1 && bad.stdout.trim() === "bad.page.yaml line 14: 'stauts' is not a field. Did you mean status?" && /^Page files, version 1\.\n\n### board\n/.test(docs.stdout), JSON.stringify([ok.stdout, ok.stderr, bad.stdout, bad.stderr]));
  const gone = spawnSync(BIN, ['page', 'check', PFILE], { env: { ...cliEnv, RAVENRY_HUB_URL: 'http://127.0.0.1:9' }, encoding: 'utf8' });
  check('with no board running, it says so', gone.status === 1 && /board is not running/.test(gone.stderr), gone.stderr);
} else console.log('SKIP  the ravenry binary\'s page commands: set RAVENRYD_BIN');
// Ask and run need a session and a daemon: said plainly.
const ask = await post('/api/pages/ask', { key: 'playtest', at: { scope: 'item', tab: 0, section: 0, index: 1 }, item: { file: 'boat-clips-the-dock.md' } });
check('Ask Claude to fix with no paper-boat project on this board: said plainly, nothing typed', ask.status === 404 && /No project called paper-boat/.test(ask.body.error), ask.text);

// A page file made by an agent shows by itself.
fs.writeFileSync(path.join(MC, 'pages', 'reading.page.yaml'), 'version: 1\nid: reading\ntitle: Reading list\nnav: { icon: doc, count: true }\nsource:\n  folder: reading/\n  fields:\n    author: { type: string }\nsections:\n  - view: list\n    item: { title: title, subtitle: author }\n');
fs.mkdirSync(path.join(MC, 'pages', 'reading'), { recursive: true });
fs.writeFileSync(path.join(MC, 'pages', 'reading', 'dune.md'), '---\ntitle: Dune\nauthor: Frank Herbert\n---\n');
const t0 = Date.now();
const fresh = await until(async () => { const r = await rows(); return r.find((x) => x.key === 'reading' && x.number === 1) ? r : null; }, 6000);
check('a new page file is in the board\'s state by itself, after the other added pages', !!fresh && fresh.map((r) => r.key).join(',') === 'objectives,plans,ideas,rules,ship,playtest,reading,trail-map/tiles', JSON.stringify(fresh && fresh.map((r) => r.key)));
console.log(`MEASURE  a new page file reached the board's state in ${Date.now() - t0} ms`);

// The web board (and the phone): its tabs from the page files.
let pw = null;
try { pw = await import('playwright'); } catch { /* not installed (Linux CI) */ }
if (pw) {
  const b = await pw.chromium.launch();
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + '/#/objectives');
  await page.waitForFunction(() => document.querySelectorAll('#views .seg').length >= 6, null, { timeout: 15000 });
  const tabs = await page.$$eval('#views .seg', (xs) => xs.map((x) => x.textContent));
  check('the web board\'s tabs come from the page files: Projects, the shipped four it draws itself (a copy\'s label), then the added and project pages', tabs.join('|') === 'Projects|Objectives|Ideas|Rules|Ship|Playtest notes5|Reading list1|Map tiles', tabs.join('|'));
  // (A first-run card covers the page on a board with no projects root: the tab by its address.)
  await page.evaluate(() => { location.hash = '#/page/playtest'; });
  await page.waitForFunction(() => document.querySelectorAll('#pv-b .card').length === 3, null, { timeout: 10000 });
  const cards = await page.$$eval('#pv-b .card h2', (xs) => xs.map((x) => x.textContent));
  check('an added page on the web board: its items, grouped as its board groups them, read-only', cards.join('|') === 'New5|Fixing2|Fixed4' && errs.length === 0, cards.join('|') + errs.join(' '));
  await b.close();
} else console.log('SKIP  the web board\'s tabs: no Playwright here');

console.log(fails ? `\n${fails} failed  (scratch: ${T})` : `\nall passed  (scratch: ${T})`);
process.exit(fails ? 1 : 0);
