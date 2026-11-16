// Proves the hub's side of a pick (a `pick` checkpoint: 2 to 4 variants,
// answered with a label, a region and a note) and of a drive (an agent asks
// to type into a pane it did not start):
//   - a pick's pictures are kept in Ravenry's data with its project
//     (server/picks.mjs), as <n>.<ext> beside pick.json, which records the
//     variants and, once closed, the answer; a variant that is not a
//     picture, an HTML page or a video is not kept; a video is kept as a
//     video, and a page that holds one (a data: URI, a file beside it) has
//     its video kept beside it as <n>.video.<ext>;
//   - checkpoints.answer passes a pick (checked against the variants, the
//     region inside the picture, the note's size) and a drive's allow (once
//     or session, never always) to the daemon, and refuses what does not fit;
//   - the phone's alerts: a pick's variants with their URLs and a button
//     per label, a drive's Allow once and This session behind a
//     fingerprint;
//   - with RAVENRYD_BIN and a daemon that knows the pick kind, end to end:
//     GET /api/checkpoints/<id>/variants/<n> serves the kept copies with
//     their types, HTML and SVG sandboxed (CSP sandbox, nosniff), nothing
//     past the variants, the copies stay when the agent's files go, and the
//     person's pick through the hub lands in the record and reaches the
//     agent; a video in parts (Range, 206), a page's video with ?as=video,
//     each variant's video URL in the board's view, and a region's t (the
//     frame's second) reaches the agent.
// Usage: node tools/picks-test.mjs [RAVENRYD_BIN=../daemon/ravenryd]
import { withStubMachine } from './test-guard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, '.tmp', 'picks-')));
const MC = path.join(T, 'mc');
const HOME = path.join(T, 'home');
const FILES = path.join(T, 'agent-files');
for (const d of [MC, HOME, FILES]) fs.mkdirSync(d, { recursive: true });
process.env.RAVENRY_HOME = MC;
const picks = await import('../server/picks.mjs');
const checkpoints = await import('../server/checkpoints.mjs');
const { checkpointMessage } = await import('../server/push.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A tiny PNG, an SVG with a script, and an HTML page with one.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0000003010100c9fe92ef0000000049454e44ae426082', 'hex');
fs.writeFileSync(path.join(FILES, 'a.png'), PNG);
fs.writeFileSync(path.join(FILES, 'b.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="4" height="4"/></svg>');
fs.writeFileSync(path.join(FILES, 'c.html'), '<!doctype html><title>C</title><script>fetch("/api/state")</script><p>Variant C</p>');
fs.writeFileSync(path.join(FILES, 'd.txt'), 'not a picture');
const read = async (f) => { try { return { ok: true, data: fs.readFileSync(f) }; } catch { return { ok: false, error: 'gone' }; } };
// A video (its bytes are the hub's to keep and serve, never decoded here), a page with it as a data: URI, a page that names a file beside it.
const MP4 = Buffer.concat([Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2')]), Buffer.alloc(300000, 7)]);
fs.writeFileSync(path.join(FILES, 'e.mp4'), MP4);
fs.writeFileSync(path.join(FILES, 'f.html'), `<!doctype html><body><video src="data:video/mp4;base64,${MP4.toString('base64')}" controls autoplay muted loop playsinline></video></body>`);
fs.mkdirSync(path.join(FILES, 'clips'));
fs.writeFileSync(path.join(FILES, 'clips', 'g.webm'), Buffer.from('1a45dfa3', 'hex'));
fs.writeFileSync(path.join(FILES, 'g.html'), '<!doctype html><video controls muted><source src="clips/g.webm" type="video/webm"></video>');

// ------------------------------------------------------------ kept copies
const cp = {
  id: 'cpick001', kind: 'pick', state: 'open', title: 'Which header?', pane: 'pagent01', assistant: 'claude', created_at: '2026-11-07T10:00:00.000Z',
  variants: [{ label: 'A', path: path.join(FILES, 'a.png'), type: 'image', size: PNG.length, description: 'The hull stays flat.' }, { label: 'B', path: path.join(FILES, 'b.svg'), type: 'image' }, { label: 'C', path: path.join(FILES, 'c.html'), type: 'html' }, { label: 'D', path: path.join(FILES, 'd.txt'), type: 'image' }],
};
const rec = await picks.keep(cp, { projectId: 'game', machine: null, read });
const dir = path.join(MC, 'projects', 'game', 'picks', 'cpick001');
check('kept with the project in Ravenry\'s data: <n>.<ext> beside pick.json', rec.dir === dir && fs.readFileSync(path.join(dir, '0.png')).equals(PNG) && fs.existsSync(path.join(dir, '1.svg')) && fs.existsSync(path.join(dir, '2.html')) && fs.existsSync(path.join(dir, 'pick.json')), JSON.stringify(rec));
const pj = JSON.parse(fs.readFileSync(path.join(dir, 'pick.json'), 'utf8'));
check('the record: checkpoint, title, project, each variant\'s source and kept file', pj.checkpoint === 'cpick001' && pj.title === 'Which header?' && pj.project === 'game' && pj.variants[0].source === path.join(FILES, 'a.png') && pj.variants[0].file === '0.png' && pj.variants[2].type === 'html');
check('a variant\'s description is kept with it', pj.variants[0].description === 'The hull stays flat.' && !('description' in pj.variants[1]));
check('a variant that is not a picture or a page is not kept', pj.variants[3].file === null && !!pj.variants[3].error && !fs.existsSync(path.join(dir, '3.txt')));
check('the kept file of a variant; none for the others', picks.keptFile('cpick001', 0).file === path.join(dir, '0.png') && picks.keptFile('cpick001', 3) === null && picks.keptFile('cpick001', 9) === null && picks.keptFile('../x', 0) === null);
check('a pick with no project is kept under picks/', picks.dirFor('cnoproj1', null) === path.join(MC, 'picks', 'cnoproj1') && picks.dirFor('cbad', '../escape') === path.join(MC, 'picks', 'cbad'));
{
  const vcp = { id: 'cvideo01', kind: 'pick', state: 'open', title: 'Which take?', created_at: '2026-11-16T10:00:00.000Z', variants: [{ label: 'A', path: path.join(FILES, 'e.mp4'), type: 'video' }, { label: 'B', path: path.join(FILES, 'f.html'), type: 'html' }, { label: 'C', path: path.join(FILES, 'g.html'), type: 'html' }, { label: 'D', path: path.join(FILES, 'c.html'), type: 'html' }] };
  const vr = await picks.keep(vcp, { projectId: 'game', read });
  const vd = path.join(MC, 'projects', 'game', 'picks', 'cvideo01');
  check('a video is kept as a video', vr.variants[0].type === 'video' && vr.variants[0].file === '0.mp4' && fs.readFileSync(path.join(vd, '0.mp4')).equals(MP4), JSON.stringify(vr.variants[0]));
  check('a page that holds a video (a data: URI): its video kept beside it', vr.variants[1].video === '1.video.mp4' && fs.readFileSync(path.join(vd, '1.video.mp4')).equals(MP4), JSON.stringify(vr.variants[1]));
  check('a page whose video is a file beside it: read from the agent\'s machine and kept', vr.variants[2].video === '2.video.webm' && fs.readFileSync(path.join(vd, '2.video.webm')).toString('hex') === '1a45dfa3', JSON.stringify(vr.variants[2]));
  check('a page with no video plays none', !('video' in vr.variants[3]) && picks.videoUrl('cvideo01', vcp.variants[3], 3, vr) === null);
  const k0 = picks.keptFile('cvideo01', 0), k1 = picks.keptFile('cvideo01', 1);
  check('the kept files say what they play', k0.video === path.join(vd, '0.mp4') && k1.video === path.join(vd, '1.video.mp4') && k1.type === 'html' && !('video' in picks.keptFile('cvideo01', 3)));
  check('the URL each plays from', picks.videoUrl('cvideo01', vcp.variants[0], 0, vr) === '/api/checkpoints/cvideo01/variants/0' && picks.videoUrl('cvideo01', vcp.variants[1], 1, vr) === '/api/checkpoints/cvideo01/variants/1?as=video');
  check('a video named by its type but not its file is not kept', (await picks.keep({ ...vcp, id: 'cvideo02', variants: [{ label: 'A', path: path.join(FILES, 'a.png'), type: 'video' }, vcp.variants[0]] }, { projectId: 'game', read })).variants[0].file === null);
  check('the first <video>\'s src, or its first <source>\'s; none is none', picks.pageVideoSrc('<video src="a.mp4"></video><video src="b.mp4"></video>') === 'a.mp4' && picks.pageVideoSrc("<video controls><source src='x.webm'></video>") === 'x.webm' && picks.pageVideoSrc('<img src="a.png">') === null);
  check('a page\'s video on the web is never fetched', (await picks.pageVideo('<video src="https://example.com/a.mp4"></video>', '/x/p.html', async () => { throw new Error('read'); })) === null);
}
const done = picks.closed({ ...cp, state: 'answered', answer: { pick: { label: 'B', region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, note: 'this, but bigger' }, by: 'phone', at: '2026-11-07T10:05:00.000Z' } });
check('once closed, the answer is in the record', done.answer.label === 'B' && done.answer.note === 'this, but bigger' && done.answer.region.w === 0.3 && done.answer.by === 'phone' && JSON.parse(fs.readFileSync(path.join(dir, 'pick.json'), 'utf8')).answer.label === 'B');

// ------------------------------------------------------------ answers through the hub's checkpoints
const sent = [];
const send = async (_d, params) => { sent.push(params); return { checkpoint: { ...open, state: 'answered', answer: { at: 'x', ...(params.pick ? { pick: params.pick } : {}), ...(params.approve ? { approved: true, allow: params.allow } : {}) } } }; };
let open = { ...cp, id: 'cpick002', variants: cp.variants.slice(0, 3) };
checkpoints.take(open, { daemon: 'd1' });
check('the hub\'s view of a pick keeps each variant\'s description', checkpoints.get('cpick002').variants[0].description === 'The hull stays flat.' && !('description' in checkpoints.get('cpick002').variants[1]));
checkpoints.take({ id: 'cdrivewy', kind: 'drive', state: 'open', title: 't', created_at: '2026-11-07T10:00:00.000Z', drive: { pane: 'pb', agent: { kind: 'agent', pane: 'pa' }, action: 'input', reason: 'The game only listens on this Mac.' } }, { daemon: 'd1' });
check('the hub\'s view of a drive keeps its reason', checkpoints.get('cdrivewy').drive.reason === 'The game only listens on this Mac.');
const bad = [
  [{ id: 'cpick002', pick: { label: 'Z' } }, 'Pick one of the variants'],
  [{ id: 'cpick002', pick: { label: 'A', region: { x: 0.8, y: 0, w: 0.5, h: 0.5 } } }, 'inside'],
  [{ id: 'cpick002', pick: { label: 'A', note: 'x'.repeat(4001) } }, 'note'],
  [{ id: 'cpick002', pick: { label: 'A', colour: 'red' } }, 'does not know'],
  [{ id: 'cpick002', approve: true }, null],
];
for (const [b, want] of bad.slice(0, 4)) {
  const r = await checkpoints.answer(b, send);
  check(`a bad pick is refused (${want})`, !r.ok && r.status === 400 && r.error.includes(want), r.error);
}
const allowOnPick = await checkpoints.answer({ id: 'cpick002', approve: true, allow: 'once' }, send);
check('allow goes only with a drive', !allowOnPick.ok && allowOnPick.status === 400);
const good = await checkpoints.answer({ id: 'cpick002', pick: { label: 'C', region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, note: ' this, but with the logo on the left ' }, by: 'desktop' }, send);
check('a pick goes to the daemon with its region and note', good.ok && JSON.stringify(sent.at(-1)) === JSON.stringify({ checkpoint: 'cpick002', by: 'desktop', pick: { label: 'C', region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, note: 'this, but with the logo on the left' } }), JSON.stringify(sent.at(-1)));
checkpoints.take({ ...open, id: 'cpick005' }, { daemon: 'd1' });
for (const [r, want] of [[{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, t: -1 }, 'second'], [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, t: '3' }, 'second'], [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, z: 1 }, 'does not know']]) {
  const rb = await checkpoints.answer({ id: 'cpick005', pick: { label: 'A', region: r } }, send);
  check(`a bad region on a video is refused (${want})`, !rb.ok && rb.status === 400 && rb.error.includes(want), rb.error);
}
checkpoints.take({ ...open, id: 'cpick004' }, { daemon: 'd1' });
const timed = await checkpoints.answer({ id: 'cpick004', pick: { label: 'A', region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5, t: 3.20449 } }, by: 'phone' }, send);
check('a region on a video\'s frame goes to the daemon with its second', timed.ok && JSON.stringify(sent.at(-1).pick.region) === JSON.stringify({ x: 0.25, y: 0.25, w: 0.5, h: 0.5, t: 3.204 }), JSON.stringify(sent.at(-1)));
{
  // A ravenryd older than t refuses the field: the region goes again without it.
  const tries = [];
  const old = async (_d, params) => { tries.push(JSON.parse(JSON.stringify(params))); if (params.pick.region.t != null) { const e = new Error('json: unknown field "t"'); e.code = 'bad_request'; throw e; } return { checkpoint: { ...open, state: 'answered' } }; };
  checkpoints.take({ ...open, id: 'cpick003', state: 'open' }, { daemon: 'd1' });
  const ro = await checkpoints.answer({ id: 'cpick003', pick: { label: 'A', region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5, t: 1.5 } } }, old);
  check('an older ravenryd gets the region without its second', ro.ok && tries.length === 2 && tries[1].pick.region.t === undefined && tries[1].pick.region.w === 0.5, JSON.stringify(tries));
}
open = { id: 'cdrive01', kind: 'drive', state: 'open', title: 'Type into the server pane?', pane: 'pagent01', assistant: 'claude', drive: { pane: 'pserver1', agent: { kind: 'agent', pane: 'pagent01' }, input: 'npm run dev' }, created_at: 'x' };
checkpoints.take(open, { daemon: 'd1' });
const always = await checkpoints.answer({ id: 'cdrive01', approve: true, allow: 'always' }, send);
check('a drive cannot be allowed always', !always.ok && always.status === 400 && /once or session/.test(always.error), always.error);
const sess = await checkpoints.answer({ id: 'cdrive01', approve: true, allow: 'session' }, send);
check('a drive allowed for the session goes to the daemon', sess.ok && sent.at(-1).allow === 'session' && sent.at(-1).approve === true && checkpoints.get('cdrive01').drive.input === 'npm run dev', JSON.stringify(sent.at(-1)));

// ------------------------------------------------------------ the phone's alerts
const pm = checkpointMessage({ ...cp, variants: cp.variants.slice(0, 4) });
check('a pick\'s alert carries each variant\'s description', pm.checkpoint.variants[0].description === 'The hull stays flat.' && !('description' in pm.checkpoint.variants[1]));
check('a pick\'s alert: the variants with their URLs, buttons by label (the fourth behind Open)', pm.kind === 'pick' && pm.checkpoint.variants.length === 4 && pm.checkpoint.variants[2].url === '/api/checkpoints/cpick001/variants/2' && pm.checkpoint.variants[2].type === 'html' && pm.actions.map((x) => x.id).join() === 'pick:0,pick:1,open', JSON.stringify(pm));
const vm = checkpointMessage({ ...cp, id: 'cvideo01', variants: [{ label: 'A', path: '/x/e.mp4', type: 'video' }, cp.variants[0]] });
check('a pick\'s alert says a video is a video (never a picture to draw)', vm.checkpoint.variants[0].type === 'video' && vm.checkpoint.variants[1].type === 'image', JSON.stringify(vm.checkpoint.variants));
const dm = checkpointMessage(open);
check('a drive\'s alert: what it would type, Allow once and This session behind a fingerprint, Refuse', dm.kind === 'drive' && dm.body === 'npm run dev' && dm.actions.map((x) => `${x.id}${x.biometric ? '+bio' : ''}`).join() === 'allow:once+bio,allow:session+bio,refuse', JSON.stringify(dm));
const closeOpen = { ...open, id: 'cdrive02', drive: { ...open.drive, action: 'close', input: undefined } };
checkpoints.take(closeOpen, { daemon: 'd1' });
const boat = { id: 'paper-boat', name: 'paper-boat', sessions: [{ surfaceId: 'ravenry:pagent01', topic: 'Tilting the hull', assistant: 'claude' }] };
const cm = checkpointMessage(closeOpen, { project: boat, paneName: 'dev server' });
check('a drive to close a tab names the asker by its project (never its session) and the pane as the sidebar does, keeps its action, and takes a fingerprint the same way', cm.title === 'Claude, in paper-boat, wants to close dev server' && cm.checkpoint.drive.action === 'close' && cm.checkpoint.drive.name === 'dev server' && cm.checkpoint.drive.session === 'paper-boat' && checkpoints.get('cdrive02').drive.action === 'close' && cm.actions.map((x) => `${x.id}${x.biometric ? '+bio' : ''}`).join() === 'allow:once+bio,allow:session+bio,refuse' && !/p[a-z2-7]{7}/.test(cm.title + cm.body + cm.detail), JSON.stringify(cm));
const why = checkpointMessage({ ...open, id: 'cdrive03', drive: { ...open.drive, reason: 'The game only listens on this Mac.' } }, { project: boat, paneName: 'dev server' });
check('a drive with the agent\'s words: "Claude says: ..." as its body, what it would type below, the words for the phone', why.title === 'Claude, in paper-boat, wants to type in dev server' && why.body === 'Claude says: The game only listens on this Mac.' && why.detail === 'It would type: npm run dev' && why.checkpoint.drive.reason === 'The game only listens on this Mac.', JSON.stringify(why));
const keyed = checkpointMessage({ ...open, id: 'cdrive06', drive: { ...open.drive, input: '<Ctrl+C>npm run dev -- --host<Enter>', reason: 'The game only listens on this Mac.' } }, { project: boat, paneName: 'dev server' });
check('a drive\'s keys read as people say them, never as tokens, and their parts go to the app for chips', keyed.detail === 'It would type: [Ctrl C] npm run dev -- --host [Enter]' && !/<[A-Za-z+]+>/.test(keyed.title + keyed.body + keyed.detail) && JSON.stringify(keyed.checkpoint.drive.keys) === JSON.stringify([{ kind: 'key', text: 'Ctrl C' }, { kind: 'text', text: 'npm run dev -- --host' }, { kind: 'key', text: 'Enter' }]), JSON.stringify(keyed));
const keyedBare = checkpointMessage({ ...open, id: 'cdrive07', drive: { ...open.drive, input: 'h<Enter>' } }, { project: boat, paneName: 'dev server' });
check('a drive without the agent\'s words says what it would type in its body, keys as people read them', keyedBare.body === 'h [Enter]', keyedBare.body);
const plain = checkpointMessage({ ...open, id: 'cdrive05' }, { paneName: 'dev server', askerName: 'scratch shell' });
check('a drive between plain panes (no session on the board) names both by their panes', plain.title === 'Claude, in scratch shell, wants to type in dev server' && plain.checkpoint.drive.name === 'dev server' && plain.checkpoint.drive.session === 'scratch shell', JSON.stringify(plain));
const bare = checkpointMessage({ ...open, id: 'cdrive04' });
// Fixed words, never the checkpoint's own title (an iPhone through ntfy gets the title in clear: docs/PHONE.md section 5).
check('a drive whose pane is not known says so in fixed words, never the checkpoint\'s own title', bare.title === 'Claude wants to use another tab', bare.title);

// ------------------------------------------------------------ end to end
const BIN = process.env.RAVENRYD_BIN && path.resolve(process.env.RAVENRYD_BIN);
if (!BIN) {
  console.log('SKIP  end to end: set RAVENRYD_BIN to a ravenryd binary');
  console.log(fails ? `\n${fails} failed` : `\nall passed  (scratch: ${T})`);
  process.exit(fails ? 1 : 0);
}
const MC2 = path.join(T, 'mc2');
fs.mkdirSync(MC2);
fs.writeFileSync(path.join(MC2, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [] }, null, 2));
const DD = fs.mkdtempSync(path.join(os.tmpdir(), 'rvk-'));
const RUN = path.join(DD, 'run');
const DENV = { HOME, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: path.join(DD, 'state') };
const daemon = spawn(BIN, ['serve'], { env: DENV, stdio: 'ignore' });
const PORT = 4798;
let boardLog = '';
const board = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env: withStubMachine({ ...DENV, PATH: process.env.PATH, RAVENRY_HOME: MC2, PORT: String(PORT), RAVENRY_TERMINAL: 'ravenry', RAVENRY_DAEMON_BIN: BIN, MC_CLAUDE_SETTINGS: path.join(T, 's.json'), MC_CODEX: '0', TEST_RAVENRY: '1', MC_TEST: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
board.stdout.on('data', (x) => { boardLog += x; });
board.stderr.on('data', (x) => { boardLog += x; });
process.on('exit', () => { board.kill('SIGTERM'); daemon.kill('SIGTERM'); try { fs.rmSync(DD, { recursive: true, force: true }); } catch { /* gone */ } });
const base = `http://localhost:${PORT}`;
const raw = async (p) => { const r = await fetch(base + p); return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) }; };
const getj = async (p) => { const r = await raw(p); try { return { status: r.status, body: JSON.parse(r.body.toString('utf8')) }; } catch { return { status: r.status, body: null }; } };
const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not JSON */ } return { status: r.status, body: j, text: t }; };
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const x = await fn().catch(() => null); if (x || Date.now() > end) return x; await sleep(100); } }
check('the board answers', !!(await until(async () => { const r = await getj('/api/state'); return r.body && r.body.generatedAt; }, 20000)), boardLog.slice(-600));
const { connectSocket } = await import('../../packages/node-client/index.mjs');
const SOCK = await until(async () => { const n = fs.existsSync(RUN) && fs.readdirSync(RUN).find((x) => x.endsWith('.sock')); return n ? path.join(RUN, n) : null; });
const dc = await connectSocket(SOCK, { name: 'picks-test' });
let made = null;
try {
  made = (await dc.request('checkpoint.new', { kind: 'pick', title: 'Which header?', variants: cp.variants.slice(0, 3).map((v) => ({ label: v.label, path: v.path })) })).checkpoint;
} catch (e) {
  console.log(`SKIP  end to end: this ravenryd does not open a pick yet (${e.code}: ${e.message})`);
}
if (made) {
  const kept = await until(async () => { const c = (await getj('/api/checkpoints')).body.checkpoints.find((x) => x.id === made.id); return c && c.pick_record && c.pick_record.variants.every((v) => v.kept) ? c : null; });
  check('the pick shows with its record and kept variants', !!kept && kept.kind === 'pick' && kept.pick_record.file.startsWith(path.join(MC2, 'picks', made.id)) && kept.pick_record.variants.length === 3, JSON.stringify(kept));
  const v0 = await raw(`/api/checkpoints/${made.id}/variants/0`);
  check('a PNG with its type, no store, nosniff', v0.status === 200 && v0.headers.get('content-type') === 'image/png' && v0.body.equals(PNG) && v0.headers.get('x-content-type-options') === 'nosniff' && v0.headers.get('cache-control') === 'no-store', `${v0.status} ${v0.headers.get('content-type')}`);
  const v1 = await raw(`/api/checkpoints/${made.id}/variants/1`);
  const v2 = await raw(`/api/checkpoints/${made.id}/variants/2`);
  check('SVG and HTML sandboxed: CSP sandbox, so their scripts never run on the hub\'s origin', v1.headers.get('content-type') === 'image/svg+xml' && v1.headers.get('content-security-policy') === 'sandbox' && v2.headers.get('content-type') === 'text/html; charset=utf-8' && v2.headers.get('content-security-policy') === 'sandbox' && v2.body.toString().includes('Variant C'), `${v1.headers.get('content-security-policy')} ${v2.headers.get('content-security-policy')}`);
  check('nothing past the variants, and nothing for another checkpoint', (await raw(`/api/checkpoints/${made.id}/variants/3`)).status === 404 && (await raw('/api/checkpoints/cnotapick/variants/0')).status === 404);
  fs.rmSync(path.join(FILES, 'a.png'));
  check('the kept copy outlives the agent\'s file', (await raw(`/api/checkpoints/${made.id}/variants/0`)).body.equals(PNG));
  const waiter = dc.request('checkpoint.wait', { checkpoint: made.id, timeout_ms: 15000 });
  const ans = await post('/api/checkpoints/answer', { id: made.id, pick: { label: 'C', region: { x: 0.1, y: 0.1, w: 0.5, h: 0.2 }, note: 'this, but darker' } });
  const w = await waiter;
  check('the person\'s pick through the hub reaches the agent', ans.status === 200 && w.checkpoint.state === 'answered' && w.checkpoint.answer.pick.label === 'C' && w.checkpoint.answer.pick.note === 'this, but darker', ans.text + JSON.stringify(w.checkpoint.answer));
  const rj = await until(async () => { const r = picks.record(made.id, MC2); return r && r.answer ? r : null; });
  check('and lands in the pick\'s record', !!rj && rj.answer.label === 'C' && rj.answer.region.h === 0.2, JSON.stringify(rj));
}
let vmade = null;
try {
  vmade = (await dc.request('checkpoint.new', { kind: 'pick', title: 'Which take?', variants: [{ label: 'A', path: path.join(FILES, 'e.mp4') }, { label: 'B', path: path.join(FILES, 'f.html') }, { label: 'C', path: path.join(FILES, 'c.html') }] })).checkpoint;
} catch (e) {
  check('this ravenryd opens a pick with a video', false, `${e.code}: ${e.message}`);
}
if (vmade) {
  const kv = await until(async () => { const c = (await getj('/api/checkpoints')).body.checkpoints.find((x) => x.id === vmade.id); return c && c.variants[1].video ? c : null; });
  check('the board\'s view: each variant\'s video URL (a video\'s own, a page\'s ?as=video), none for a page with no video', !!kv && kv.variants[0].type === 'video' && kv.variants[0].video === `/api/checkpoints/${vmade.id}/variants/0` && kv.variants[1].video === `/api/checkpoints/${vmade.id}/variants/1?as=video` && !('video' in kv.variants[2]), JSON.stringify(kv && kv.variants));
  const full = await raw(`/api/checkpoints/${vmade.id}/variants/0`);
  check('a video with its type, whole, and that it takes parts', full.status === 200 && full.headers.get('content-type') === 'video/mp4' && full.headers.get('accept-ranges') === 'bytes' && full.body.equals(MP4), `${full.status} ${full.headers.get('content-type')} ${full.body.length}`);
  const part = await fetch(`${base}/api/checkpoints/${vmade.id}/variants/0`, { headers: { Range: 'bytes=100-199' } });
  const pb = Buffer.from(await part.arrayBuffer());
  check('a part of it (Range): 206, its place, its bytes', part.status === 206 && part.headers.get('content-range') === `bytes 100-199/${MP4.length}` && pb.equals(MP4.subarray(100, 200)), `${part.status} ${part.headers.get('content-range')} ${pb.length}`);
  const tail = await fetch(`${base}/api/checkpoints/${vmade.id}/variants/0`, { headers: { Range: 'bytes=-10' } });
  const past = await fetch(`${base}/api/checkpoints/${vmade.id}/variants/0`, { headers: { Range: `bytes=${MP4.length}-` } });
  check('its last bytes, and nothing past its end (416)', tail.status === 206 && Buffer.from(await tail.arrayBuffer()).equals(MP4.subarray(-10)) && past.status === 416 && past.headers.get('content-range') === `bytes */${MP4.length}`, `${tail.status} ${past.status}`);
  const pv = await raw(`/api/checkpoints/${vmade.id}/variants/1?as=video`);
  check('a page\'s video (?as=video): the video, not the page, not sandboxed', pv.status === 200 && pv.headers.get('content-type') === 'video/mp4' && pv.body.equals(MP4) && pv.headers.get('content-security-policy') !== 'sandbox', `${pv.status} ${pv.headers.get('content-type')}`);
  check('a page with no video has none to play (404); a video is no picture to draw (415)', (await raw(`/api/checkpoints/${vmade.id}/variants/2?as=video`)).status === 404 && (await raw(`/api/checkpoints/${vmade.id}/variants/0?as=png`)).status === 415);
  const waiter = dc.request('checkpoint.wait', { checkpoint: vmade.id, timeout_ms: 15000 });
  const ans = await post('/api/checkpoints/answer', { id: vmade.id, pick: { label: 'B', region: { x: 0.1, y: 0.1, w: 0.5, h: 0.2, t: 2.5 }, note: 'this frame' } });
  const w = await waiter;
  check('a ring on a video\'s paused frame reaches the agent with its second', ans.status === 200 && w.checkpoint.answer.pick.label === 'B' && w.checkpoint.answer.pick.region.t === 2.5, ans.text + JSON.stringify(w.checkpoint.answer));
}
// drive.name for a plain pane: the person's "dev server", started with
// ravenryd new --name, is no session, and an agent in another plain pane
// asks to type there. The board names both from the daemon, never by id.
{
  const CLI = fs.existsSync(path.join(path.dirname(BIN), 'ravenry')) ? path.join(path.dirname(BIN), 'ravenry') : BIN;
  const dev = (await dc.request('pane.new', { command: ['/bin/cat'], name: 'dev server', cwd: HOME })).pane;
  const agent = (await dc.request('pane.new', { command: ['/bin/sh', '-c', `'${CLI}' send ${dev.id} --paste 'npm run dev -- --host' --key Enter --reason 'Your phone needs --host'; exec sleep 60`], name: 'scratch shell', cwd: HOME })).pane;
  const dv = await until(async () => { const c = (await getj('/api/checkpoints')).body.checkpoints.find((x) => x.kind === 'drive' && x.drive && x.drive.pane === dev.id); return c && c.drive.name ? c : null; }, 15000);
  check('drive.name for a plain pane: the board names the pane and the asker from the daemon', !!dv && dv.drive.name === 'dev server' && dv.drive.session === 'scratch shell' && dv.pane === agent.id, JSON.stringify(dv && dv.drive));
  if (dv) {
    const pm2 = checkpointMessage(dv, { paneName: dv.drive.name, askerName: dv.drive.session });
    check('and its phone alert says them, never an id', /wants to type in dev server$/.test(pm2.title) && /in scratch shell/.test(pm2.title) && !/p[a-z2-7]{7}/.test(pm2.title) && (!dv.drive.reason || pm2.body === `${pm2.title.split(',')[0]} says: Your phone needs --host`), JSON.stringify(pm2));
    await dc.request('checkpoint.answer', { checkpoint: dv.id, decline: true }).catch(() => {});
  }
  for (const x of [agent, dev]) await dc.request('pane.close', { pane: x.id }).catch(() => {});
}
dc.close();
console.log(fails ? `\n${fails} failed\n${boardLog.slice(-2000)}` : `\nall passed  (scratch: ${T})`);
process.exit(fails ? 1 : 0);
