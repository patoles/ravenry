#!/usr/bin/env node
// Screenshots of a session that runs in a terminal outside Ravenry, never on
// screen: the app on a demo board in Ravenry mode (as the app's own hub
// runs, RAVENRY_TERMINAL=ravenry) whose sessions run in cmux, with the
// hub's tools/fake-cmux.mjs as cmux and stand-ins for ps and lsof. The
// session's brief has a long Goal and Next, so the panel's brief card
// shows its fold.
//
//   node build.mjs && node tools/outside-shots.mjs <outDir>
//
// Each frame in dark and light, 1440x900, as <outDir>/<frame>-dark.png and
// -light.png:
//   outside-live       still open in cmux, which lets Ravenry read it: its
//                      discussion live, Open in cmux, Move here
//                      off with the line that says why
//   outside-refused    still open in cmux, which lets only programs it
//                      started read its tabs: one line says so, and the
//                      conversation comes from its transcript
//   outside-closed     its process ended in cmux: Move here
//   brief-open         the brief's Next unfolded (Show less)
//
// Needs ravenryd: RAVENRYD, else ../../daemon/ravenryd.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startDemoHub } from './demo-hub.mjs';
import { APP, runApp, stopDaemons } from './run-app.mjs';

guardSpawns();

const OUT = path.resolve(process.argv[2] || path.join(APP, '.tmp', 'outside-shots'));
const WORK = path.join(OUT, '.work');
const BIN = process.env.RAVENRYD || path.resolve(APP, '..', '..', 'daemon', 'ravenryd');
if (!fs.existsSync(BIN)) { console.error(`no ravenryd at ${BIN}; build it (daemon/README.md) or set RAVENRYD`); process.exit(1); }
fs.mkdirSync(WORK, { recursive: true });
for (const f of fs.readdirSync(WORK)) if (/\.(signal|go)$/.test(f)) fs.rmSync(path.join(WORK, f));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RT = fs.mkdtempSync(path.join(process.env.RAVENRY_SHORT_TMP || os.tmpdir(), 'rvo-'));
fs.chmodSync(RT, 0o700);
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const SID = 'a1a1a1a1-0000-4000-8000-000000000001';
const MIN = 60000;
const ago = (m) => new Date(Date.now() - m * MIN).toISOString();
const GOAL = 'A planting calendar that says what to sow and when, bed by bed, from the frost dates of the garden\'s own town, so nobody has to keep a spreadsheet of sowing windows by hand or remember which bed was rotated last spring.';
const NEXT = 'Pick which reminder goes out first, then wire the reminders to the calendar: each bed gets a sowing window from its crop and the last frost date, the reminder lands a week before that window opens, a second one on the first frost-free day if nothing was marked sown, and the phone gets a quiet summary every Sunday evening with what to sow that week. Keep the old manual list working until the reminders have run for a full month, and write down in the brief which beds were left out of the first run and why, so the next session can add them without asking again.';

// The session's conversation, three turns, the last one a question.
function transcript(folder) {
  const rec = (type, extra, at) => JSON.stringify({ type, cwd: folder, sessionId: SID, timestamp: at, ...extra });
  const say = (text, at, ctx) => rec('assistant', { message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 8, cache_creation_input_tokens: 3000, cache_read_input_tokens: ctx, output_tokens: 400 } } }, at);
  const ask = (text, at) => rec('user', { message: { role: 'user', content: text } }, at);
  const end = (at) => rec('system', { subtype: 'turn_duration' }, at);
  return [
    ask('Load the frost dates for the garden\'s town and give each bed its sowing window', ago(31)),
    say('Each bed now has a sowing window from its crop and the town\'s last frost date (April 14 this year). Beds 3 and 5 have no crop yet, so they have no window.', ago(28), 240000),
    end(ago(28)),
    ask('Good. Leave 3 and 5 out for now. Add reminders to the planting calendar', ago(6)),
    say('The calendar knows each bed\'s sowing window, and two kinds of reminder fit it: a week before sowing, or on the first frost-free day.\n\nShould the first reminder go out a week before sowing, or on the first frost-free day?', ago(2), 309000),
    end(ago(2)),
  ].join('\n') + '\n';
}

let hub;
const S = 'window.__ravenry.S';
const sig = (n) => path.join(WORK, `${n}.signal`);
const go = (n) => path.join(WORK, `${n}.go`);
const pause = (n) => [{ signal: sig(n) }, { wait: go(n), timeout: 120000 }];
const at = async (n) => { const t0 = Date.now(); while (!fs.existsSync(sig(n))) { if (Date.now() - t0 > 240000) throw new Error(`the app never reached ${n}`); await sleep(100); } };
const resume = (n) => fs.writeFileSync(go(n), '1');
const shot = (name) => [
  { theme: 'dark' }, { js: 'void 0' }, { shot: path.join(OUT, `${name}-dark.png`), settle: 500 },
  { theme: 'light' }, { shot: path.join(OUT, `${name}-light.png`), settle: 500 },
  { theme: 'dark' },
];
const view = `document.getElementById('elsewhere')`;

try {
  const port = await freePort();
  hub = await startDemoHub({
    dir: path.join(WORK, 'demo'), port, cmuxIds: true,
    env: { RAVENRY_TERMINAL: 'ravenry', MC_APPS: 'cmux,ravenry' },
    prepare: ({ ROOT, HOME }) => {
      const folder = path.join(ROOT, 'garden-planner');
      fs.writeFileSync(path.join(folder, 'BRIEF.md'), `# Garden Planner\n\nGoal: ${GOAL}\nKind: Web app\nStage: Build\n\n## Next step\n${NEXT}\n\n## Hand-off\n- 2026-11-05 18:20 Sowing windows and frost dates are in. Next: the reminders.\n`);
      fs.writeFileSync(path.join(HOME, '.claude', 'projects', folder.replace(/[^A-Za-z0-9-]/g, '-'), SID + '.jsonl'), transcript(folder));
    },
  });
  const fake = () => JSON.parse(fs.readFileSync(hub.fake, 'utf8'));
  const setFake = (x) => fs.writeFileSync(hub.fake, JSON.stringify(x));
  const garden = `(() => { for (const p of ${S}.hub.projects) for (const s of p.sessions) if (s.sessionId === '${SID}') return s; })()`;
  const steps = [
    { ready: true },
    { until: `${S}.hub && ${S}.hub.projects && ${S}.hub.projects.length === 5`, timeout: 20000 },
    { until: `(${garden}) && (${garden}).surfaceId.startsWith('5F') && (${garden}).outside && (${garden}).outside.open === true`, timeout: 20000 },
    { js: `[...document.querySelectorAll('.ss')].find((e) => e.textContent.includes('Planting')).click()` },
    { until: `!${view}.hidden && ${view}.querySelector('.dr.c')`, timeout: 15000 },
    { until: `document.querySelector('#panel .bv.clamp')`, timeout: 10000 },
    ...shot('outside-live'),
    ...pause('refuse'),
    { until: `${view}.textContent.includes('only to programs it started') && ${view}.textContent.includes('From its transcript')`, timeout: 40000 },
    ...shot('outside-refused'),
    ...pause('close'),
    { until: `${view}.textContent.includes('It ended there') && !${view}.querySelector('.else-acts .btn.pri').disabled`, timeout: 20000 },
    ...shot('outside-closed'),
    { js: `[...document.querySelectorAll('#panel .bv-more')].find((b) => !b.hidden && b.closest('.bv-cell').textContent.includes('Sunday')).click()` },
    { until: `[...document.querySelectorAll('#panel .bv-more')].some((b) => b.textContent === 'Show less')` },
    { js: `document.querySelector('#panel .p-b').scrollTop = 10000` },
    ...shot('brief-open'),
    { save: { expr: `({ panelFont: getComputedStyle(document.querySelector('#panel .bv')).fontSize, panelP: getComputedStyle(document.querySelector('#panel .sec p') || document.querySelector('#panel .bv')).fontSize })`, out: path.join(WORK, 'fonts.json') } },
  ];
  const app = runApp({ name: 'outside', work: WORK, rt: RT, bin: BIN, home: hub.home, hubUrl: hub.url, steps });
  const feed = (async () => {
    // cmux stops answering this board (its socket's default mode).
    await at('refuse');
    setFake({ ...fake(), denied: true });
    resume('refuse');
    // The session's process ends in cmux (the person quit it there).
    await at('close');
    const ps = JSON.parse(fs.readFileSync(hub.ps, 'utf8'));
    fs.writeFileSync(hub.ps, JSON.stringify(ps.filter((p) => !p.command.includes(SID))));
    resume('close');
  })();
  await Promise.race([app, feed.then(() => app)]);
  await app;
  console.log('wrote', fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).join(', '));
  console.log('fonts', fs.readFileSync(path.join(WORK, 'fonts.json'), 'utf8'));
} finally {
  stopDaemons(BIN, RT);
  hub?.stop();
  fs.rmSync(RT, { recursive: true, force: true });
}
