// Proves the decision ledger (server/decisions.mjs, docs/DECISIONS.md):
//   - entries keep the person's words verbatim with their time, project,
//     scope and overrides; an entry that replaces others takes them out of
//     the active view, and removing it brings them back; search and the
//     project filter (by id, name or a folder inside the project);
//   - the person edits, undoes (within the minute only) and removes;
//     agents' reads are counted per day (reads_today, reads_total);
//   - hand-offs, new sessions and briefs' prompts read it: the hand-off's
//     words carry the project's active decisions verbatim, and the first
//     prompt of a new session points at them;
//   - on a real board (no ravenryd here: every person row is the
//     person's), POST /api/decisions/record counts at once, from outside
//     every pane as by "client", refuses a body that names who recorded it,
//     and tells the board's stream "saved" with its undo time; the person's
//     add, edit, undo and remove; GET /api/decisions counts a read only
//     with agent=1.
// From inside a real pane, /record is marked with that pane and the person
// rows get 403: tools/person-routes-test.mjs (RAVENRYD_BIN).
// Usage: node tools/decisions-test.mjs
import './test-guard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'decisions-'));
const MC = path.join(T, 'mc');
const HOME = path.join(T, 'home');
const PROJ = path.join(T, 'proj');
const OTHER = path.join(T, 'other');
for (const d of [MC, HOME, PROJ, path.join(PROJ, 'src'), OTHER]) fs.mkdirSync(d, { recursive: true });
process.env.RAVENRY_HOME = MC;

const D = await import('../server/decisions.mjs');
const { reasonText } = await import('../server/handoff.mjs');
const { plan } = await import('../server/sessionstart.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ the record
const F = path.join(T, 'unit.json');
const projects = [{ id: 'proj', name: 'Proj', folder: PROJ }, { id: 'other', name: 'Other', folder: OTHER }];
const a = D.add({ quote: 'The tabs stay on the left.\nAlways.', projectId: 'proj', scope: 'the sidebar' }, { file: F });
check('add keeps the quote verbatim, its time, project, scope and by', a.ok && a.entry.quote === 'The tabs stay on the left.\nAlways.' && a.entry.project === 'proj' && a.entry.scope === 'the sidebar' && a.entry.by === 'person' && /^d[a-z2-7]{7}$/.test(a.entry.id) && !Number.isNaN(Date.parse(a.entry.at)) && Array.isArray(a.entry.overrides), JSON.stringify(a));
const g = D.add({ quote: 'No em dashes anywhere.', projectId: null }, { file: F });
const o = D.add({ quote: 'Ship builds on Fridays only.', projectId: 'other' }, { file: F });
check('bad entries are refused', !D.add({ quote: '  ' }, { file: F }).ok && !D.add({ quote: 'x'.repeat(4001) }, { file: F }).ok && !D.add({ quote: 'ok', scope: 'two\nlines' }, { file: F }).ok && D.add({ quote: 'ok', overrides: ['dzzzzzzz'] }, { file: F }).status === 404);
const b = D.add({ quote: 'The tabs go on the right after all.', projectId: 'proj', overrides: [a.entry.id] }, { file: F });
const active = D.query({ projectId: 'proj' }, { file: F });
check('an override takes the old entry out of the active view, newest first, with the global ones', b.ok && active.map((x) => x.id).join() === [b.entry.id, g.entry.id].join() && D.load(F).find((x) => x.id === a.entry.id).overridden_by === b.entry.id, JSON.stringify(active.map((x) => x.quote)));
check('all shows the overridden one too', D.query({ projectId: 'proj', all: true }, { file: F }).length === 3);
check('the project filter leaves other projects out', !D.query({ projectId: 'proj' }, { file: F }).some((x) => x.id === o.entry.id) && D.query({}, { file: F }).length === 3);
check('search: every word, any case, in the quote or the scope', D.query({ search: 'TABS right' }, { file: F }).map((x) => x.id).join() === b.entry.id && D.query({ search: 'sidebar', all: true }, { file: F }).map((x) => x.id).join() === a.entry.id && D.query({ search: 'nothing-like-it' }, { file: F }).length === 0);
const rm = D.remove(b.entry.id, { file: F });
check('removing the override brings the old entry back', rm.ok && !D.load(F).find((x) => x.id === a.entry.id).overridden_by && D.query({ projectId: 'proj' }, { file: F }).some((x) => x.id === a.entry.id));
check('the file is private', (fs.statSync(F).mode & 0o777) === 0o600);
check('a project by id, by name, by a folder inside it, by a worktree folder', D.resolveProject('proj', projects).id === 'proj' && D.resolveProject('other', projects).id === 'other' && D.resolveProject('PROJ', projects).id === 'proj' && D.resolveProject(path.join(PROJ, 'src'), projects).id === 'proj' && D.resolveProject(path.join(T, 'proj-wt', 'a'), projects, [{ folder: path.join(T, 'proj-wt'), projectId: 'proj' }]).id === 'proj' && D.resolveProject('nope', projects) === null && D.resolveProject(T, projects) === null);

// ------------------------------------------------------------ the page's view
{
  const P = path.join(T, 'page.json');
  const now = new Date();
  const ago = (ms) => new Date(now.getTime() - ms).toISOString();
  const old = D.add({ quote: 'The menu opens on the right.', projectId: 'proj', at: ago(3 * 86400000) }, { file: P });
  const nu = D.add({ quote: 'The menu opens on the left.', projectId: 'proj', scope: 'menus', overrides: [old.entry.id], by: 'agent', recordedBy: { pane: 'pqwertyu', session: 's-1' }, at: ago(2 * 86400000) }, { file: P });
  const every = D.add({ quote: 'No em dashes anywhere.', projectId: null, at: ago(20000) }, { file: P });
  const names = { proj: 'Proj' };
  const where = (rb) => (rb && rb.session === 's-1' ? 'Menus pass' : null);
  const v = D.page({ names, where, now }, { file: P });
  const flat = v.days.flatMap((d) => d.items);
  const n = flat.find((x) => x.id === nu.entry.id);
  check('page: active ones newest first in days, today first, with counts', v.total === 3 && v.active === 2 && v.replaced === 1 && flat.map((x) => x.id).join() === `${every.entry.id},${nu.entry.id}` && v.days[0].rel === 'today' && v.days[1].rel === '' && v.days.length === 2, JSON.stringify(v.days.map((d) => [d.day, d.rel, d.items.length])));
  check('page: an item says its project\'s name (null for every project), where it was said, and what it replaced verbatim', !!n && n.project_name === 'Proj' && flat[0].project_name === null && n.where === 'Menus pass' && n.replaces.length === 1 && n.replaces[0].quote === 'The menu opens on the right.' && n.gone === false, JSON.stringify(n));
  check('page: undo_until and undoable while the newest is in its minute', !!flat[0].undo_until && v.undoable && !n.undo_until);
  const r = D.page({ show: 'replaced', names, where, now }, { file: P }).days.flatMap((d) => d.items);
  check('page: Replaced shows the replaced one, gone, with when it was replaced and nothing it replaces', r.length === 1 && r[0].id === old.entry.id && r[0].gone && r[0].replaced_at === nu.entry.at && r[0].replaces.length === 0);
  check('page: All shows every one', D.page({ show: 'all', now }, { file: P }).days.flatMap((d) => d.items).length === 3);
  const only = D.page({ only: 'proj', now }, { file: P });
  check('page: a project picked shows its own only (not the ones for every project); the menu lists the ledger\'s projects', only.days.flatMap((d) => d.items).map((x) => x.id).join() === nu.entry.id && JSON.stringify(only.projects) === JSON.stringify([{ id: 'proj', name: 'proj' }]));
  const s = D.page({ search: 'MENUS left', now }, { file: P });
  check('page: search, every word in the quote or the scope; nothing matching says nomatch, an empty ledger none', s.days.flatMap((d) => d.items).map((x) => x.id).join() === nu.entry.id && D.page({ search: 'zebra', now }, { file: P }).empty === 'nomatch' && D.page({ now }, { file: path.join(T, 'none.json') }).empty === 'none' && v.empty === null);
}

// ------------------------------------------------------------ edit, undo, reads
const e1 = D.add({ quote: 'Use the phone width for every test shot.', projectId: 'proj', scope: 'tests', by: 'agent', recordedBy: { pane: 'pqwertyu', session: 's-1', assistant: 'claude', extra: 'dropped' } }, { file: F });
check('an agent\'s entry keeps who recorded it, and only those fields', e1.ok && e1.entry.by === 'agent' && JSON.stringify(e1.entry.recorded_by) === JSON.stringify({ pane: 'pqwertyu', session: 's-1', assistant: 'claude' }), JSON.stringify(e1.entry));
const ed = D.edit(e1.entry.id, { quote: 'Use the phone width for every test shot, 390 px.', scope: '' }, { file: F });
check('edit: the quote and the scope, with edited_at', ed.ok && ed.entry.quote.endsWith('390 px.') && !('scope' in ed.entry) && !!ed.entry.edited_at && !D.edit(e1.entry.id, { quote: '' }, { file: F }).ok && D.edit('dzzzzzzz', { quote: 'x' }, { file: F }).status === 404);
const e2 = D.add({ quote: 'Keep the brief short.', projectId: 'other', by: 'agent', recordedBy: { pane: 'pqwertyu' } }, { file: F });
const late = D.undo(e2.entry.id, { file: F, now: Date.parse(e2.entry.at) + 61000 });
check('undo after the minute is refused', !late.ok && late.status === 409 && D.load(F).some((x) => x.id === e2.entry.id));
check('undo within the minute takes it back', D.undo(e2.entry.id, { file: F, now: Date.parse(e2.entry.at) + 5000 }).ok && !D.load(F).some((x) => x.id === e2.entry.id));
D.countReads([e1.entry.id, a.entry.id], { file: F, now: new Date('2026-11-06T10:00:00.000Z') });
D.countReads([e1.entry.id], { file: F, now: new Date('2026-11-07T09:00:00.000Z') });
D.countReads([e1.entry.id], { file: F, now: new Date('2026-11-07T10:00:00.000Z') });
const ve = D.view(D.load(F).find((x) => x.id === e1.entry.id), { now: new Date('2026-11-07T11:00:00.000Z') });
check('reads per day: reads_today and reads_total, last_read_at', ve.reads_today === 2 && ve.reads_total === 3 && ve.last_read_at === '2026-11-07T10:00:00.000Z' && D.view(D.load(F).find((x) => x.id === a.entry.id), { now: new Date('2026-11-07T11:00:00.000Z') }).reads_today === 0, JSON.stringify(ve));
D.countReads([e1.entry.id], { file: F, now: new Date('2026-12-20T10:00:00.000Z') });
check('reads older than 30 days are dropped', Object.keys(D.load(F).find((x) => x.id === e1.entry.id).reads).join() === '2026-12-20');
const fresh = D.view({ ...e1.entry, at: new Date().toISOString() });
check('undo_until while the minute lasts', !!fresh.undo_until && !D.view(e1.entry, { now: new Date(Date.parse(e1.entry.at) + 70000) }).undo_until);
const { decisionMessage } = await import('../server/push.mjs');
const dm = decisionMessage(D.load(F).find((x) => x.id === e1.entry.id), { project: { id: 'proj', name: 'Proj' } });
check('the phone\'s alert: "Saved your decision", the quote, Undo', dm.id === `dec:${e1.entry.id}` && dm.kind === 'decision' && dm.title === 'Saved your decision' && dm.body.endsWith('390 px.') && dm.actions.length === 1 && dm.actions[0].id === 'undo' && !!dm.decision.undo_until, JSON.stringify(dm));

// ------------------------------------------------------------ checked before an ask
{
  const now = new Date(2026, 10, 7, 15, 0);
  const asked = new Date(2026, 10, 7, 14, 40).toISOString();
  const e = (id, quote, project, at, read) => ({ id, quote, project, at: at.toISOString(), by: 'person', ...(read ? { last_read_at: read.toISOString() } : {}) });
  const list = [
    e('daaaaaaa', 'Keep the old import format working until the beta ends', 'kite', new Date(2026, 10, 7, 9, 5), new Date(2026, 10, 7, 14, 31)),
    e('dbbbbbbb', 'Use metric units', null, new Date(2026, 10, 5, 10, 0), new Date(2026, 10, 7, 14, 38)),
    e('dccccccc', 'Never ship on Fridays', 'other', new Date(2026, 10, 6, 10, 0), new Date(2026, 10, 7, 14, 39)),
    e('ddddddda', 'Read long ago', 'kite', new Date(2026, 10, 6, 11, 0), new Date(2026, 10, 7, 14, 0)),
    e('deeeeeee', 'Read after it asked', 'kite', new Date(2026, 10, 6, 12, 0), new Date(2026, 10, 7, 14, 41)),
    e('dfffffff', 'Never read', 'kite', new Date(2026, 10, 6, 13, 0), null),
  ];
  const c = D.checkedBefore('kite', asked, { list, now });
  check('checkedBefore: the project\'s and every project\'s read in the 15 minutes before, newest said first', JSON.stringify(c.map((x) => x.id)) === JSON.stringify(['daaaaaaa', 'dbbbbbbb']), JSON.stringify(c));
  check('checkedBefore: a long quote cut at a word, when said today with its time, else the date', c[0].quote === 'Keep the old import format working until the beta...' && c[0].when === 'today 09:05' && c[1].when === 'Nov 5', JSON.stringify(c));
  check('checkedBefore: no project counts every read; a bad time none', D.checkedBefore(null, asked, { list, now }).length === 3 && D.checkedBefore('kite', 'nope', { list, now }).length === 0);
}

// ------------------------------------------------------------ prompts read it
const block = D.promptBlock('proj', { file: F });
check('the hand-off block: the project\'s active decisions, newest first, verbatim, with the global ones', block.includes('"Use the phone width for every test shot, 390 px."') && block.includes('"The tabs stay on the left. Always."') && block.includes('No em dashes') && !block.includes('Fridays') && block.indexOf('phone width') < block.indexOf('tabs stay'), block);
const many = path.join(T, 'many.json');
for (let i = 0; i < 14; i++) D.add({ quote: `Decision number ${i}`, projectId: 'proj', at: `2026-11-0${1 + (i % 6)}T0${i % 10}:00:00.000Z` }, { file: many });
check('capped, saying how many more', /- and 4 more/.test(D.promptBlock('proj', { file: many })) && D.promptBlock('nothing', { file: many }) === '');
const rt = reasonText({ pct: 75, tokens: 150000, window: 200000, threshold: 70, ceiling: 85, manual: false, file: path.join(PROJ, 'BRIEF.md'), autoStart: true, decisions: block });
check('the hand-off\'s words carry them, and say not to copy them', rt.includes('390 px.') && /do not copy them into the hand-off/.test(rt));
check('without decisions, the hand-off\'s words are as before', !reasonText({ pct: 75, tokens: 1, window: 2, threshold: 70, ceiling: 85, file: null, autoStart: true }).includes('decisions on record'));
const line = D.promptLine('proj', { file: F });
const pl = plan({ projectId: 'proj' }, { project: { id: 'proj', name: 'Proj', folder: PROJ }, launch: () => ({ kind: 'claude', command: 'claude' }), briefPath: () => path.join(PROJ, 'BRIEF.md'), briefExists: () => true, decisions: line });
check('a new session\'s first prompt points at them, on one line', pl.ok && /check their 3 decisions on record: ravenry decisions --project proj\./.test(pl.line) && !pl.line.includes('\n'), pl.line);
const own = plan({ projectId: 'proj', text: 'Fix the login bug' }, { project: { id: 'proj', name: 'Proj', folder: PROJ }, launch: () => ({ kind: 'claude', command: 'claude' }), decisions: line });
check('a first message of the person\'s own stays as written', own.ok && !own.line.includes('decisions'), own.line);

// ------------------------------------------------------------ on a real board
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [{ id: 'proj', name: 'Proj', folder: PROJ, workspaces: [], brief: null }] }, null, 2));
const DD = fs.mkdtempSync(path.join(os.tmpdir(), 'rvd-'));
const RUN = path.join(DD, 'run');
const DENV = { HOME, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: path.join(DD, 'state') };
const PORT = 4796;
let boardLog = '';
const env = {
  ...DENV, PATH: process.env.PATH, RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_TERMINAL: 'iterm', RAVENRY_DAEMON_BIN: 'none',
  MC_NO_EVENTS: '1', MC_NO_AUTOSTART: '1', MC_CODEX: '0', TEST_RAVENRY: '1', MC_TEST: '1',
  MC_CLAUDE_SETTINGS: path.join(T, 'settings.json'), MC_CLAUDE_PROJECTS: path.join(HOME, '.claude', 'projects'), MC_GLOBAL_CLAUDE_MD: path.join(HOME, '.claude', 'CLAUDE.md'),
  ITERM_OSASCRIPT_BIN: path.join(ROOT, 'tools', 'stub-osascript.mjs'), MC_OSASCRIPT_BIN: path.join(ROOT, 'tools', 'stub-osascript.mjs'), STUB_OSASCRIPT_LOG: path.join(T, 'osascript.jsonl'),
  MC_PS_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), MC_LSOF_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), STUB_PS_STATE: path.join(T, 'ps.json'),
};
fs.writeFileSync(path.join(T, 'ps.json'), '[]');
fs.writeFileSync(path.join(T, 'settings.json'), '{}');
const board = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
board.stdout.on('data', (d) => { boardLog += d; });
board.stderr.on('data', (d) => { boardLog += d; });
process.on('exit', () => { board.kill('SIGTERM'); try { fs.rmSync(DD, { recursive: true, force: true }); } catch { /* gone */ } });
const base = `http://localhost:${PORT}`;
const get = async (p) => { const r = await fetch(base + p); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not JSON */ } return { status: r.status, body: j, text: t }; };
const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not JSON */ } return { status: r.status, body: j, text: t }; };
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const x = await fn().catch(() => null); if (x || Date.now() > end) return x; await sleep(100); } }
const up = await until(async () => { const r = await get('/api/state'); return r.body && r.body.generatedAt ? r : null; }, 20000);
check('the board answers', !!up, boardLog.slice(-600));
const empty = await get('/api/decisions?project=proj');
check('GET /api/decisions: none yet', empty.status === 200 && empty.body.decisions.length === 0 && empty.body.project === 'proj', empty.text);
const add1 = await post('/api/decisions/add', { quote: 'Every test runs with a throwaway HOME.', project: 'Proj', scope: 'tests' });
const add2 = await post('/api/decisions/add', { quote: 'Every test runs with a throwaway HOME and a scratch daemon.', project: PROJ, overrides: [add1.body && add1.body.decision.id] });
check('POST /api/decisions/add, by the project\'s name and by its folder, with an override', add1.status === 200 && add2.status === 200 && add1.body.decision.project === 'proj' && add2.body.decision.project === 'proj' && add2.body.decision.overrides[0] === add1.body.decision.id, add1.text + add2.text);
check('a bad add is refused', (await post('/api/decisions/add', { quote: '' })).status === 400 && (await post('/api/decisions/add', { quote: 'x', project: 'nope' })).status === 404);
const listed = await get(`/api/decisions?project=${encodeURIComponent(path.join(PROJ, 'src'))}&search=scratch`);
check('GET by a folder inside the project, with a search', listed.status === 200 && listed.body.decisions.length === 1 && listed.body.decisions[0].id === add2.body.decision.id, listed.text);
check('GET with all shows the overridden one', (await get('/api/decisions?project=proj&all=1')).body.decisions.length === 2);
check('GET for an unknown project is 404', (await get('/api/decisions?project=nope')).status === 404);
const rem = await post('/api/decisions/remove', { id: add2.body.decision.id });
check('POST /api/decisions/remove takes it off; the old one is active again', rem.status === 200 && (await get('/api/decisions?project=proj')).body.decisions.map((x) => x.id).join() === add1.body.decision.id, rem.text);
check('the ledger lives in the hub\'s data folder', JSON.parse(fs.readFileSync(path.join(MC, 'decisions.json'), 'utf8')).decisions.length === 1);

// ------------------------------------------------------------ /record, read counts, the stream
const events = [];
const ac = new AbortController();
fetch(base + '/api/events', { signal: ac.signal }).then(async (r) => { for await (const ch of r.body) events.push(Buffer.from(ch).toString('utf8')); }).catch(() => {});
await sleep(300);
const forged = await post('/api/decisions/record', { quote: 'x', recorded_by: { pane: 'pforged1' } });
check('/record refuses a body that names who recorded it', forged.status === 400 && /recorded_by/.test(forged.body.error), forged.text);
const rec = await post('/api/decisions/record', { quote: 'The menu opens on the left.', project: 'proj', replaces: add1.body.decision.id });
check('/record counts at once; from outside every pane it is by "client", with no pane', rec.status === 200 && rec.body.decision.by === 'client' && !rec.body.decision.recorded_by && rec.body.decision.overrides[0] === add1.body.decision.id && !!rec.body.decision.undo_until && (await get('/api/decisions?project=proj')).body.decisions.map((x) => x.id).join() === rec.body.decision.id, rec.text);
const said = await until(async () => events.join('').includes(rec.body.decision.id) && events.join(''));
check('the board\'s stream says it was saved, with the undo time', !!said && /event: decision\ndata: \{"type":"saved"/.test(said) && said.includes('"undo_until"'), (said || '').slice(-400));
const noCount = await get('/api/decisions?project=proj');
const counted = await get('/api/decisions?project=proj&agent=1');
const pg = await get('/api/decisions?page=1&show=all');
const pg2 = await get('/api/decisions?page=1&show=all');
const reads = (x) => JSON.stringify(x.body.days.flatMap((d) => d.items).map((i) => i.reads_total));
check('GET page=1 answers the page\'s view (days, counts, projects) and is never counted as a read', pg.status === 200 && Array.isArray(pg.body.days) && pg.body.total > 0 && pg.body.days.flatMap((d) => d.items).length === pg.body.total && Array.isArray(pg.body.projects) && reads(pg) === reads(pg2), pg.text.slice(0, 300));
check('GET counts a read only for an agent (agent=1); the board\'s own look does not', noCount.body.decisions[0].reads_today === 0 && counted.body.decisions[0].reads_today === 1 && counted.body.decisions[0].reads_total === 1, counted.text);
const edt = await post('/api/decisions/edit', { id: rec.body.decision.id, scope: 'menus' });
check('the person edits it', edt.status === 200 && edt.body.decision.scope === 'menus', edt.text);
const und = await post('/api/decisions/undo', { id: rec.body.decision.id });
check('the person undoes it within the minute; the one it replaced is active again', und.status === 200 && (await get('/api/decisions?project=proj')).body.decisions.map((x) => x.id).join() === add1.body.decision.id, und.text);
check('and the stream says so', !!(await until(async () => events.join('').includes(`"type":"removed","id":"${rec.body.decision.id}"`))));
ac.abort();

console.log(fails ? `\n${fails} failed\n${boardLog.slice(-2000)}` : `\nall passed  (scratch: ${T})`);
process.exit(fails ? 1 : 0);
