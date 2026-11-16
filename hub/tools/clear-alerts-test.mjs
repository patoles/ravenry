// Alerts that travel in clear carry no agent words (server/alertwords.mjs,
// the privacy page site/privacy.html): the iPhone through ntfy, and the
// Telegram, Discord, Slack and ntfy channels. Each may say the project's
// name, what it waits for (the kind), a tab's name, the Mac's name, the
// fixed lines and the board's link; never the question, the command, a
// plan gate's question (its short form included), the agent's reason or
// what it would type, a variant's words, or the session's text.
//
// In process, against a local stub that records every request (nothing
// reaches ntfy.sh, Telegram, Discord or Slack): for each of the four
// channels in turn, with an iPhone through ntfy alerted every round, every
// kind of alert is triggered with agent words in every field they could
// come from: a project moving into Needs you (question, hand-back,
// permission, a plan gate) and each kind of checkpoint (ask, approve,
// secret, drive, pick). Each path's published payloads must arrive, say
// what they should, and carry none of those words. The Android app's
// alerts are encrypted for the phone and may carry them (tools/
// iphone-ntfy-test.mjs proves that side).
//
// Usage: node tools/clear-alerts-test.mjs
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'clear-alerts-test');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(path.join(T, 'home'), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (ok) passes++; else fails++; };

// ------------------------------------------------------------ the stub

const reqs = [];
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', () => {
    let json = null;
    try { json = JSON.parse(b); } catch { /* not JSON */ }
    reqs.push({ url: req.url, body: b, json });
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (/^\/tg\/bot[^/]+\/sendMessage$/.test(req.url)) return send(200, { ok: true, result: { message_id: 1 } });
    if (/^\/api\/webhooks\//.test(req.url)) { res.writeHead(204); return res.end(); }
    if (/^\/services\//.test(req.url)) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (req.url === '/ntfy/') return send(200, { id: 'x', event: 'message' });
    send(404, { error: 'stub: no route' });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${server.address().port}`;

process.env.RAVENRY_HOME = path.join(T, 'home');
process.env.RAVENRY_HUB_NAME = 'Test Mac';
process.env.MC_TELEGRAM_API = STUB + '/tg';
process.env.MC_ALERT_PRIME_MS = '0';
process.env.MC_ALERT_COOLDOWN_MS = '0';
process.env.MC_ALERT_RETRY_MS = '60000';
process.env.MC_PUSH_RETRY_MS = '60000';
const al = await import('../server/alerts.mjs');

// ------------------------------------------------------------ the set-up

// An iPhone through ntfy, on the stub; the ntfy channel's own topic too.
al.setNtfyServer(STUB + '/ntfy');
al.newTopic();
const AF = path.join(process.env.RAVENRY_HOME, 'alerts.json');
const chanTopic = JSON.parse(fs.readFileSync(AF, 'utf8')).ntfy.topic;
const iphone = al.iphoneStart('mac');
check('set-up: an iPhone through ntfy on the stub, confirmed', al.iphoneConfirm(iphone.id, 'mac').ok && iphone.topic !== chanTopic);

// One channel on: alerts.json as the Mac's setup writes it (a new mtime, so it is read again).
let bump = 0;
function useChannel(channel, cfg) {
  const d = JSON.parse(fs.readFileSync(AF, 'utf8'));
  Object.assign(d, { enabled: true, channel }, cfg);
  fs.writeFileSync(AF, JSON.stringify(d), { mode: 0o600 });
  const t = new Date(Date.now() + (++bump) * 2000);
  fs.utimesSync(AF, t, t);
}

// Agent words in every field they could come from. A tab's name and the
// Mac's name may be said; these may not. Letters and digits only, so no
// channel's escaping (Discord's markdown escapes "-") can hide them.
const W = 'AGENTWORDSZ9';
const BU = 'http://192.168.1.50:4600/';
const sess = (id, state, extra = {}) => ({
  surfaceId: 'sf-' + id, sessionId: 'sid-' + id, state, since: '2026-11-16T10:00:00.000Z', assistant: 'claude', notificationType: extra.nt || null,
  words: { headline: `${W} headline`, question: `${W} question?`, line: `${W} line`, dialog: extra.dialog || null, quick: [{ label: `${W} quick`, text: `${W} quick` }] },
});
const proj = (id, state, s, extra = {}) => ({
  id, name: id, state, primary: s.surfaceId, sessions: [s], workspaces: [{ id: 'ws-' + id, title: id }],
  question: `${W} question?`, headline: `${W} headline`, line: `${W} line`, quick: [{ label: `${W} quick`, text: `${W} quick` }], ...extra,
});
function projects(round, state) {
  const gate = state === 'you' ? { planGate: { n: 2, question: `${W} long gate question?`, short: `${W} gate?`, choices: ['Go ahead', 'Not yet'] }, plan: { title: `Plan ${round}`, started: '2026-11-16 09:00' } } : {};
  return [
    proj(`question-${round}`, state, sess(`q${round}`, state === 'you' ? 'asked' : 'working')),
    proj(`handback-${round}`, state, sess(`h${round}`, state === 'you' ? 'handback' : 'working')),
    proj(`permission-${round}`, state, sess(`p${round}`, state === 'you' ? 'dialog' : 'working', { nt: state === 'you' ? 'permission_prompt' : null, dialog: state === 'you' ? [`${W} Bash command`, `rm -rf ${W}`, 'Do you want to proceed?'] : null })),
    proj(`gate-${round}`, state, sess(`g${round}`, state === 'you' ? 'idle' : 'working'), gate),
  ];
}
const cpProject = (round) => ({ id: `cp-${round}`, name: `cp-${round}`, sessions: [{ surfaceId: `ravenry:pane${round}`, sessionId: `sid-cp${round}`, assistant: 'claude' }] });
const checkpoints = (round) => [
  { id: `ask${round}`, kind: 'ask', title: `${W} ask title\n${W} more`, options: [`${W} option`], free_text: true },
  { id: `appr${round}`, kind: 'approve', title: `${W} approve`, command: `npm publish --otp ${W}`, cwd: `/x/${W}`, warning: `${W} warning` },
  { id: `sec${round}`, kind: 'secret', title: `${W} secret label`, command: `wrangler ${W}`, secret: { to: 'env', env: 'TOKEN' } },
  { id: `drv${round}`, kind: 'drive', title: `${W} drive`, drive: { pane: 'pz', action: 'input', reason: `${W} reason`, input: `${W} typed\r` } },
  { id: `pick${round}`, kind: 'pick', title: `${W} pick`, variants: [{ label: `${W} variant`, description: `${W} description` }, { label: 'B' }] },
].map((cp) => ({ ...cp, pane: `pane${round}`, assistant: 'claude', created_at: new Date().toISOString() }));

// The paths: each channel's requests, and the iPhone's topic.
const PATHS = [
  { name: 'Telegram', channel: 'telegram', cfg: { telegram: { token: '123456789:YOUR_BOT_TOKEN_FOR_THE_LOCAL_TEST', chatId: '512345678942' } }, mine: (q) => /\/sendMessage$/.test(q.url), text: (q) => q.json.text },
  { name: 'Discord', channel: 'webhook', cfg: { webhook: { url: `${STUB}/api/webhooks/123456789/stub-token` } }, mine: (q) => q.url.startsWith('/api/webhooks/'), text: (q) => q.json.content.replace(/\\(.)/g, '$1') },
  { name: 'Slack', channel: 'webhook', cfg: { webhook: { url: `${STUB}/services/T0123/B0456/StubToken789` } }, mine: (q) => q.url.startsWith('/services/'), text: (q) => q.json.text },
  { name: 'the ntfy channel', channel: 'ntfy', cfg: {}, mine: (q) => q.url === '/ntfy/' && q.json && q.json.topic === chanTopic, text: (q) => `${q.json.title}\n${q.json.message}` },
];
const toIphone = (q) => q.url === '/ntfy/' && q.json && q.json.topic === iphone.topic;

async function settle(from, count, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && reqs.length < from + count) await sleep(20);
  await sleep(150);
  return reqs.slice(from);
}

// ------------------------------------------------------------ the rounds

const iphoneSeen = [];
let now = Date.parse('2026-11-16T10:00:00Z');
for (const [round, p] of PATHS.entries()) {
  useChannel(p.channel, p.cfg);
  const from = reqs.length;
  al.observe(projects(round, 'work'), { now: (now += 60000), boardUrl: BU });
  al.observe(projects(round, 'you'), { now: (now += 60000), boardUrl: BU });
  const cpp = cpProject(round);
  for (const cp of checkpoints(round)) al.checkpointAlert(cp, { project: cpp, machine: 'Test Mac', boardUrl: BU, paneName: 'build tab', askerName: 'notes tab' });
  // 4 project alerts and 5 checkpoints, to the channel and to the iPhone.
  const got = await settle(from, 18);
  const sent = got.filter(p.mine);
  const texts = sent.map(p.text);
  iphoneSeen.push(...got.filter(toIphone));
  check(`${p.name}: every alert arrived (4 project alerts, 5 checkpoints)`, sent.length === 9, `${sent.length}: ${JSON.stringify(texts)}`);
  check(`${p.name}: each names its project and what it waits for`, texts.some((t) => /gate-\d+ needs you/.test(t) && /Plan gate/.test(t)) && texts.some((t) => /question-\d+ needs you/.test(t) && /Asked you a question/.test(t)) && texts.filter((t) => /cp-\d+ needs you/.test(t)).length === 5, JSON.stringify(texts));
  const leaks = sent.filter((q) => q.body.includes(W));
  check(`${p.name}: no payload carries the question, the command, the plan's question or any agent words`, leaks.length === 0, leaks.map((q) => q.body).join(' | '));
}

const ipTitles = iphoneSeen.map((q) => `${q.json.title} / ${q.json.message}`);
check('the iPhone through ntfy: every alert arrived, each round (4 project alerts, 5 checkpoints, 4 rounds)', iphoneSeen.length === 36, `${iphoneSeen.length}: ${JSON.stringify(ipTitles.slice(0, 9))}`);
check('the iPhone through ntfy: a plan gate says the project and "Plan gate", fixed words', ipTitles.filter((t) => /^gate-\d+: plan gate \/ Plan gate$/.test(t)).length === 4, JSON.stringify(ipTitles.filter((t) => t.startsWith('gate-'))));
check('the iPhone through ntfy: a drive names the tab, not what it would type', ipTitles.some((t) => t.startsWith('Claude, in cp-0, wants to type in build tab /')), JSON.stringify(ipTitles.filter((t) => t.includes('tab'))));
const ipLeaks = iphoneSeen.filter((q) => q.body.includes(W));
check('the iPhone through ntfy: no payload carries the question, the command, the plan\'s question or any agent words', ipLeaks.length === 0, ipLeaks.map((q) => q.body).join(' | '));

server.close();
console.log(`\n${passes} passed, ${fails} failed`);
fs.rmSync(T, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
