// Phone alerts (docs/design/PhoneAlerts.dc.html, variant B), proved without
// reaching Telegram, Discord, Slack or ntfy.sh: every channel points at a
// local stub HTTP server that records each request.
//
// 1. Channels: the exact JSON each one sends (Telegram with its "Open on
//    the board" button, Discord, Slack, ntfy), Discord or Slack picked from
//    the URL, the masks, and error sentences that carry no secret.
// 2. Triggers, in process with crafted projects: question, hand-back,
//    permission (from the Notification type and from the screen), no alert
//    at start, dedupe per session and kind, the 10-minute cooldown per
//    project, no alert for mc-test workspaces, a failure and its one retry;
//    plan gates once per distinct gate (plan, step, question), outside the
//    cooldown, which still holds for the other kinds.
// 3. A test board on :4665 (RAVENRY_HOME under .tmp/alerts-test, the fake
//    cmux, the real events hook): set up through the API, then real state
//    transitions end to end, no session text in any request, a hung send
//    that does not hold the tick, alerts.json at mode 0600, no secret in the
//    log, the snapshot or /api/alerts, the ntfy QR decoded, and a phone
//    (the Mac's own Wi-Fi address) refused the secrets with 403 but allowed
//    the switch and Send a test.
//
// Usage: node tools/alerts-test.mjs [--real-ntfy]
//   --real-ntfy also publishes once to a throwaway random ntfy.sh topic
//   (never a saved one) and reads it back, to prove the request shape.
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'alerts-test');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };

// ------------------------------------------------------------ the stub

const TOKEN = '8412345678:AAHdQwErTyUiOpAsDfGhJkLzXcVbNm12345';
const BAD_TOKEN = '8412345678:AAHwrongwrongwrongwrongwrongwrong00';
const CHAT = '512345678942';
const reqs = [];
const stub = { failNext: 0, hangNextMs: 0, buttonInvalid: false, updates: true };
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', async () => {
    let json = null;
    try { json = JSON.parse(b); } catch { /* not JSON */ }
    const r = { method: req.method, url: req.url, headers: req.headers, body: b, json, at: Date.now() };
    reqs.push(r);
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
    const tg = /^\/tg\/bot([^/]+)\/(\w+)/.exec(req.url);
    if (tg) {
      if (tg[1] !== TOKEN) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' });
      if (tg[2] === 'getMe') return send(200, { ok: true, result: { id: 8412345678, is_bot: true, username: 'ravenry_test_bot' } });
      if (tg[2] === 'getUpdates') return send(200, { ok: true, result: stub.updates ? [{ update_id: 1, message: { message_id: 1, chat: { id: -100777, type: 'group' }, text: 'hi' } }, { update_id: 2, message: { message_id: 2, chat: { id: Number(CHAT), type: 'private' }, text: 'hello bot' } }] : [] });
      if (tg[2] === 'sendMessage') {
        if (stub.hangNextMs) { const ms = stub.hangNextMs; stub.hangNextMs = 0; await sleep(ms); }
        if (stub.failNext > 0) { stub.failNext--; return send(502, { ok: false, error_code: 502, description: 'Bad Gateway' }); }
        if (stub.buttonInvalid && json && json.reply_markup) return send(400, { ok: false, error_code: 400, description: 'Bad Request: BUTTON_URL_INVALID' });
        return send(200, { ok: true, result: { message_id: 9 } });
      }
    }
    if (/^\/api\/webhooks\/\d+\/[\w-]+$/.test(req.url)) return req.url.includes('gone') ? send(404, { message: 'Unknown Webhook' }) : (res.writeHead(204), res.end());
    if (/^\/services\//.test(req.url)) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (req.url === '/ntfy/' || req.url === '/') return send(200, { id: 'abc', event: 'message', topic: json && json.topic });
    send(404, { error: 'stub: no route' });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SP = server.address().port;
const STUB = `http://127.0.0.1:${SP}`;
const since = (n) => reqs.slice(n);
async function waitReqs(n, count, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (reqs.length >= n + count) return true; await sleep(20); }
  return false;
}

// ------------------------------------------------------------ 1. channels

process.env.RAVENRY_HOME = path.join(T, 'unit');
process.env.MC_TELEGRAM_API = STUB + '/tg';
process.env.MC_ALERT_RETRY_MS = '400';
process.env.MC_ALERT_PRIME_MS = '0';
fs.mkdirSync(process.env.RAVENRY_HOME, { recursive: true });
const ch = await import('../server/channels.mjs');
const al = await import('../server/alerts.mjs');
const { CHANNELS } = ch;

const A = { test: false, kind: 'question', title: 'Paper Boat needs you', body: 'Asked you a question', url: 'http://192.168.1.50:4600/#paper-boat' };
let n = reqs.length;
let r = await CHANNELS.telegram.send(A, { token: TOKEN, chatId: CHAT });
let q = since(n)[0];
check('Telegram: sendMessage with the bot token in the path', r.ok && q && q.url === `/tg/bot${TOKEN}/sendMessage` && q.method === 'POST', q && q.url.replace(TOKEN, '<token>'));
check('Telegram: exact payload, bold title, kind, HTML, the "Open on the board" button',
  q && JSON.stringify(q.json) === JSON.stringify({ chat_id: CHAT, text: '<b>Paper Boat needs you</b>\nAsked you a question', parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: 'Open on the board', url: 'http://192.168.1.50:4600/#paper-boat' }]] } }), q && q.body);
n = reqs.length;
await CHANNELS.telegram.send({ ...A, title: 'R&D <tools> needs you' }, { token: TOKEN, chatId: CHAT });
check('Telegram: a project name is HTML-escaped', since(n)[0] && since(n)[0].json.text.startsWith('<b>R&amp;D &lt;tools&gt; needs you</b>'), since(n)[0] && since(n)[0].json.text);
stub.buttonInvalid = true;
n = reqs.length;
r = await CHANNELS.telegram.send(A, { token: TOKEN, chatId: CHAT });
stub.buttonInvalid = false;
check('Telegram: a refused button link goes in the text instead, and the alert lands', r.ok && since(n).length === 2 && !since(n)[1].json.reply_markup && since(n)[1].json.text.endsWith('\nhttp://192.168.1.50:4600/#paper-boat'), JSON.stringify(since(n).map((x) => x.json.text)));
r = await CHANNELS.telegram.send(A, { token: BAD_TOKEN, chatId: CHAT });
check('Telegram: a wrong token says so, without the token', !r.ok && r.error === 'Telegram said the token is wrong' && !r.error.includes('AAH'), r.error);

const DISCORD = `${STUB}/api/webhooks/123456789/abcDEF_secret-token`;
const SLACK = `${STUB}/services/T0123/B0456/XyZsecret789`;
check('Discord or Slack: detected from the URL (real hosts and local stubs)',
  ch.webhookKind('https://discord.com/api/webhooks/1/x-y') === 'discord' && ch.webhookKind('https://discordapp.com/api/webhooks/1/x') === 'discord'
  && ch.webhookKind('https://hooks.slack.com/services/T1/B2/abc') === 'slack' && ch.webhookKind(DISCORD) === 'discord' && ch.webhookKind(SLACK) === 'slack'
  && ch.webhookKind('http://discord.com/api/webhooks/1/x') === null && ch.webhookKind('https://example.com/api/webhooks/1/x') === null && ch.webhookKind('https://hooks.slack.com/triggers/x') === null);
n = reqs.length;
r = await CHANNELS.webhook.send(A, { url: DISCORD });
q = since(n)[0];
check('Discord: exact payload (bold title, kind, link, no mentions)', r.ok && q && q.url === '/api/webhooks/123456789/abcDEF_secret-token'
  && JSON.stringify(q.json) === JSON.stringify({ username: 'Ravenry', content: '**Paper Boat needs you**\nAsked you a question\n[Open on the board](<http://192.168.1.50:4600/#paper-boat>)', allowed_mentions: { parse: [] } }), q && q.body);
n = reqs.length;
r = await CHANNELS.webhook.send(A, { url: SLACK });
q = since(n)[0];
check('Slack: exact payload (mrkdwn bold, kind, link)', r.ok && q && JSON.stringify(q.json) === JSON.stringify({ text: '*Paper Boat needs you*\nAsked you a question\n<http://192.168.1.50:4600/#paper-boat|Open on the board>' }), q && q.body);
check('Discord or Slack: the card names which one', CHANNELS.webhook.label({ url: SLACK }) === 'Slack' && CHANNELS.webhook.label({ url: DISCORD }) === 'Discord');
r = await CHANNELS.webhook.send(A, { url: `${STUB}/api/webhooks/1/gone` });
check('Discord: a deleted webhook says so', !r.ok && r.error === 'Discord said the webhook is gone or wrong', r.error);
check('masks: token, chat, webhooks, topic', al.maskToken(TOKEN) === '84••••••:AAH••••••••••••••••' && al.maskChat(CHAT) === '51•••••42'
  && ch.maskWebhook('https://discord.com/api/webhooks/123/abc') === 'discord.com/api/webhooks/••••••/••••••••'
  && ch.maskWebhook('https://hooks.slack.com/services/T1/B2/abc') === 'hooks.slack.com/services/••••/••••/••••••••'
  && ch.maskTopic({ server: 'https://ntfy.sh', topic: 'ravenry-abcdefghij0123456789' }) === 'ntfy.sh/ravenry-••••••',
  `${al.maskToken(TOKEN)} ${al.maskChat(CHAT)}`);

n = reqs.length;
r = await CHANNELS.ntfy.send(A, { server: STUB + '/ntfy', topic: 'ravenry-stubtopic000000000000' });
q = since(n)[0];
check('ntfy: JSON to the server root, title, message, click, high priority', r.ok && q && q.url === '/ntfy/' && q.headers['content-type'] === 'application/json'
  && JSON.stringify(q.json) === JSON.stringify({ topic: 'ravenry-stubtopic000000000000', title: 'Paper Boat needs you', message: 'Asked you a question', priority: 4, click: 'http://192.168.1.50:4600/#paper-boat' }), q && q.body);
check('ntfy: the subscribe link the QR holds', ch.ntfySubscribeLink({ server: 'https://ntfy.sh', topic: 'ravenry-x' }) === 'ntfy://ntfy.sh/ravenry-x?display=Ravenry'
  && ch.ntfySubscribeLink({ server: 'http://10.0.0.2:8080', topic: 'ravenry-x' }) === 'ntfy://10.0.0.2:8080/ravenry-x?display=Ravenry&secure=false');
r = await CHANNELS.ntfy.send(A, { server: 'http://127.0.0.1:59999', topic: 'ravenry-x' });
check('a server that does not answer: one sentence, no URL', !r.ok && /^Could not reach ntfy \(/.test(r.error) && !r.error.includes('127.0.0.1'), r.error);

if (process.argv.includes('--real-ntfy')) {
  // One real publish to a random topic nobody else has, then read it back.
  const topic = 'ravenry-selftest-' + crypto.randomBytes(12).toString('hex');
  r = await CHANNELS.ntfy.send({ test: true, kind: 'test', title: 'Ravenry self test', body: 'Request shape check', url: 'http://192.168.1.50:4600/' }, { server: 'https://ntfy.sh', topic });
  // ntfy.sh answers polls from more than one node and a node may not have
  // the message yet (measured: 3 of 5 identical polls had it), so poll a few
  // times; `since=1h` because a bare poll=1 came back empty.
  let got = null;
  for (let k = 0; k < 8 && !(got && got.id); k++) {
    try { got = (await (await fetch(`https://ntfy.sh/${topic}/json?poll=1&since=1h`)).text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.event === 'message') || null; } catch (e) { got = { error: e.message }; }
    if (!(got && got.id)) await sleep(700);
  }
  check('real ntfy.sh: publish accepted and read back with title, message, click and priority', r.ok && got && got.title === 'Ravenry self test' && got.message === 'Request shape check' && got.click === 'http://192.168.1.50:4600/' && got.priority === 3,
    `topic ${topic}: ${JSON.stringify(got)}`);
}

// ------------------------------------------------------------ 2. triggers, in process

const AF = path.join(process.env.RAVENRY_HOME, 'alerts.json');
const save = (o) => fs.writeFileSync(AF, JSON.stringify(o), { mode: 0o600 });
save({ enabled: true, channel: 'telegram', telegram: { token: TOKEN, chatId: CHAT }, webhook: {}, ntfy: { server: 'https://ntfy.sh' } });
const SECRET_TEXT = 'SESSIONTEXT-do-not-leak';
const sess = (sid, state, extra = {}) => ({ surfaceId: 'sf-' + sid, sessionId: sid, state, since: extra.since || '2026-11-03T10:00:00.000Z', notificationType: extra.nt || null, words: { headline: `${SECRET_TEXT} ${extra.headline || ''}`, dialog: extra.dialog || null, line: SECRET_TEXT } });
const proj = (id, state, s, extra = {}) => ({ id, name: extra.name || id.toUpperCase(), state, primary: s ? s.surfaceId : null, sessions: s ? [s] : [], workspaces: [{ id: 'ws-' + id, title: extra.ws || id }], line: SECRET_TEXT, headline: SECRET_TEXT });
const T0 = Date.parse('2026-11-03T10:00:00Z');
const obs = (ps, min) => al.observe(ps, { now: T0 + min * 60000, boardUrl: 'http://192.168.1.50:4600/' });
const sendsSince = (k) => since(k).filter((x) => /sendMessage$/.test(x.url));

n = reqs.length;
let out = obs([proj('a', 'you', sess('sa', 'handback')), proj('b', 'work', sess('sb', 'working')), proj('t', 'work', sess('st', 'working'), { ws: 'mc-test-alerts' })], 0);
check('no alert at start for a project already in Needs you', out.length === 0);
out = obs([proj('a', 'you', sess('sa', 'handback')), proj('b', 'you', sess('sb', 'asked')), proj('t', 'you', sess('st', 'handback'), { ws: 'mc-test-alerts' })], 1);
check('question: one alert, "<Project> needs you" + "Asked you a question", the project link', out.length === 1 && out[0].title === 'B needs you' && out[0].body === 'Asked you a question' && out[0].url === 'http://192.168.1.50:4600/#b', JSON.stringify(out));
check('no alert for the board\'s own test workspaces (mc-test-*)', !out.some((x) => x.projectId === 't'));
await waitReqs(n, 1);
check('the alert went out once, with no session text', sendsSince(n).length === 1 && !sendsSince(n)[0].body.includes(SECRET_TEXT) && sendsSince(n)[0].json.text === '<b>B needs you</b>\nAsked you a question', sendsSince(n).map((x) => x.body).join(' | '));
// A blip out of Needs you and back, same session, kind and moment.
obs([proj('b', 'work', sess('sb', 'working'))], 20);
out = obs([proj('b', 'you', sess('sb', 'asked'))], 21);
check('dedupe: the same session, kind and moment again is not alerted twice (even past the cooldown)', out.length === 0);
// A new question from the same session inside 10 minutes of the last alert.
obs([proj('b', 'work', sess('sb', 'working'))], 22);
out = obs([proj('b', 'you', sess('sb', 'asked', { since: '2026-11-03T10:22:30.000Z' }))], 22.5);
check('a new question from the same session, 21 min on, is a new moment: alerted', out.length === 1);
obs([proj('b', 'work', sess('sb', 'working'))], 23);
out = obs([proj('b', 'you', sess('sb', 'handback', { since: '2026-11-03T10:24:00.000Z' }))], 24);
check('cooldown: another move into Needs you 1.5 min later is not alerted', out.length === 0);
obs([proj('b', 'work', sess('sb', 'working'))], 31);
out = obs([proj('b', 'you', sess('sb', 'handback', { since: '2026-11-03T10:32:00.000Z' }))], 32.6);
check('hand-back: alerted with "Handed back" once the 10 minutes are past', out.length === 1 && out[0].body === 'Handed back', JSON.stringify(out));
obs([proj('c', 'work', sess('sc', 'working')), proj('d', 'work', sess('sd', 'working')), proj('e', 'work', sess('se', 'working')), proj('f', 'work', sess('sf', 'working'))], 40);
out = obs([
  proj('c', 'you', sess('sc', 'dialog', { nt: 'permission_prompt' })),
  proj('d', 'you', sess('sd', 'dialog', { dialog: ['Bash command', 'rm -rf build', 'Do you want to proceed?', '❯ 1. Yes', "2. Yes, and don't ask again", '3. No, and tell Claude what to do differently'] })),
  proj('e', 'you', sess('se', 'dialog', { dialog: ['Which board size?', '❯ 1. 60 cm', '2. 80 cm'] })),
  proj('f', 'you', sess('sf', 'draft')),
], 41);
const byId = Object.fromEntries(out.map((x) => [x.projectId, x.body]));
check('permission: from a permission_prompt Notification', byId.c === 'Waiting for permission', JSON.stringify(byId));
check('permission: from a permission dialog on screen with no Notification yet', byId.d === 'Waiting for permission');
check('a question dialog on screen reads as a question', byId.e === 'Asked you a question');
check('a half-typed reply (draft) is the user\'s own, so no alert', !('f' in byId));
// Disabled: still tracked, nothing sent, and no alert when it is turned back on.
save({ enabled: false, channel: 'telegram', telegram: { token: TOKEN, chatId: CHAT }, webhook: {}, ntfy: { server: 'https://ntfy.sh' } });
obs([proj('g', 'work', sess('sg', 'working'))], 50);
out = obs([proj('g', 'you', sess('sg', 'asked'))], 51);
check('switched off: nothing sent', out.length === 0);
save({ enabled: true, channel: 'telegram', telegram: { token: TOKEN, chatId: CHAT }, webhook: {}, ntfy: { server: 'https://ntfy.sh' } });
out = obs([proj('g', 'you', sess('sg', 'asked'))], 52);
check('switched on again: a state that was already Needs you sends nothing', out.length === 0);
// A failure, its status, and the one retry.
await sleep(300);
n = reqs.length;
stub.failNext = 1;
obs([proj('h', 'work', sess('sh', 'working'))], 60);
out = obs([proj('h', 'you', sess('sh', 'asked'))], 61);
await waitReqs(n, 1);
await sleep(80);
let st = al.status();
check('failure: the status line has it, with the retry pending', st.last && st.last.ok === false && st.last.retrying === true && /^Telegram answered 502/.test(st.last.error), JSON.stringify(st.last));
const okRetry = await waitReqs(n, 2, 3000);
await sleep(80);
st = al.status();
check('retry: tried once more after the retry delay, and the status is ok again', okRetry && sendsSince(n).length === 2 && sendsSince(n)[1].at - sendsSince(n)[0].at >= 380 && st.last.ok === true, `gap ${sendsSince(n)[1] ? sendsSince(n)[1].at - sendsSince(n)[0].at : '?'} ms`);
n = reqs.length;
stub.failNext = 2;
obs([proj('i', 'work', sess('si', 'working'))], 70);
obs([proj('i', 'you', sess('si', 'asked'))], 71);
await waitReqs(n, 2, 3000);
await sleep(600);
st = al.status();
check('two failures: exactly one retry, then the failure stays on the status line', sendsSince(n).length === 2 && st.last.ok === false && st.last.retrying === false, `${sendsSince(n).length} sends, ${JSON.stringify(st.last)}`);
check('status carries no secret', !JSON.stringify(al.status()).match(/AAH|5123456789|ravenry-/));

// Plan gates: each distinct gate (plan, step, question) alerts once, never
// held back by the 10-minute cooldown, which still holds for the other kinds.
await sleep(50);
const gateP = (id, state, g, extra = {}) => {
  const s = sess('s' + id, g ? 'idle' : state === 'work' ? 'working' : 'asked', { since: extra.since });
  const p = proj(id, state, s);
  if (g) {
    p.plan = { title: extra.title || 'Long notes', started: extra.started || '2026-11-03 09:00' };
    p.planGate = { n: g.n, question: g.q, short: g.q.toLowerCase(), choices: ['Go ahead', 'Not yet'] };
  }
  return p;
};
const G2 = { n: 2, q: 'Show me a picture?' };
const G4 = { n: 4, q: 'Install it on the headset?' };
n = reqs.length;
obs([gateP('pg', 'work', null)], 80);
out = obs([gateP('pg', 'you', G2)], 81);
check('gate: the first plan gate alerts, "Plan gate: <short question>"', out.length === 1 && out[0].kind === 'gate' && out[0].body === 'Plan gate: show me a picture?', JSON.stringify(out));
obs([gateP('pg', 'work', null)], 81.5);
out = obs([gateP('pg', 'you', G4)], 83);
check('gate: a second gate in the same run 2 min later alerts too (no cooldown for gates)', out.length === 1 && out[0].body === 'Plan gate: install it on the headset?', JSON.stringify(out));
obs([gateP('pg', 'work', null)], 84);
out = obs([gateP('pg', 'you', G4)], 95);
check('gate: the same gate seen again (a blip, even past 10 min) is not alerted twice', out.length === 0);
out = obs([gateP('pg', 'you', { n: 4, q: 'Install it on the headset now?' })], 95.2);
check('gate: the same step asking a new question is a new gate, alerted even straight from Needs you', out.length === 1, JSON.stringify(out));
out = obs([gateP('pg', 'you', { n: 5, q: 'Ship it?' })], 95.4);
check('gate: a next gate straight from the last one (no working tick between) is alerted', out.length === 1);
out = obs([gateP('pg', 'you', G2, { started: '2026-11-03 11:00' })], 95.6);
check('gate: the same step and question in a plan started again is a new gate', out.length === 1);
out = obs([gateP('pg', 'you', G2, { title: 'Other plan' })], 95.8);
check('gate: the same step and question in another plan is a new gate', out.length === 1);
await waitReqs(n, 6);
await sleep(80);
check('gate: each of the six gate alerts went out, one send each', sendsSince(n).length === 6 && sendsSince(n).every((x) => x.json.text.startsWith('<b>PG needs you</b>\nPlan gate: ')), sendsSince(n).map((x) => x.json.text).join(' | '));
// The cooldown is unchanged for the other kinds, and gates neither wait for it nor start it.
obs([gateP('pq', 'work', null)], 100);
out = obs([gateP('pq', 'you', null, { since: '2026-11-03T11:40:00.000Z' })], 100.5);
check('cooldown kinds: a question alerts', out.length === 1 && out[0].kind === 'question');
obs([gateP('pq', 'work', null)], 101);
out = obs([gateP('pq', 'you', G2)], 101.5);
check('gate: alerted 1 min after a question alert from the same project', out.length === 1 && out[0].kind === 'gate');
obs([gateP('pq', 'work', null)], 102);
out = obs([gateP('pq', 'you', null, { since: '2026-11-03T11:43:00.000Z' })], 103);
check('cooldown kinds: a new question 2.5 min after the first question is still held by the cooldown', out.length === 0);
obs([gateP('pq', 'work', null)], 109);
out = obs([gateP('pq', 'you', null, { since: '2026-11-03T11:51:00.000Z' })], 111);
check('cooldown kinds: a new question 10.5 min after the first question alerts (the gate did not restart the cooldown)', out.length === 1 && out[0].kind === 'question');
// A gate there at the first look, and a gate seen while alerts are off.
out = obs([gateP('pf', 'you', G2)], 120);
check('gate: a gate already open at the first look is not alerted', out.length === 0);
obs([gateP('pf', 'work', null)], 121);
out = obs([gateP('pf', 'you', G2)], 122);
check('gate: nor after a blip, since it was seen', out.length === 0);
obs([gateP('po', 'work', null)], 123);
save({ enabled: false, channel: 'telegram', telegram: { token: TOKEN, chatId: CHAT }, webhook: {}, ntfy: { server: 'https://ntfy.sh' } });
out = obs([gateP('po', 'you', G2)], 124);
check('gate: alerts off, nothing sent', out.length === 0);
save({ enabled: true, channel: 'telegram', telegram: { token: TOKEN, chatId: CHAT }, webhook: {}, ntfy: { server: 'https://ntfy.sh' } });
obs([gateP('po', 'work', null)], 125);
out = obs([gateP('po', 'you', G2)], 126);
check('gate: a gate first seen while alerts were off is not alerted later', out.length === 0);
out = obs([gateP('mc-test-gates', 'work', null)], 127).concat(obs([gateP('mc-test-gates', 'you', G4)], 128));
check('gate: no alert for the board\'s own test workspaces', out.length === 0);
await sleep(100);

// ------------------------------------------------------------ 3. the test board

const PORT = 4665;
const BASE = `http://127.0.0.1:${PORT}`;
const MC = path.join(T, 'mc');
const CLAUDE = path.join(T, 'claude-projects');
const FAKE = path.join(T, 'fake-cmux.json');
fs.mkdirSync(MC, { recursive: true });
const IDS = ['alpha', 'beta', 'gamma', 'delta', 'eps', 'mc-test-alerts'];
const NAMES = { alpha: 'Alpha', beta: 'Beta Game', gamma: 'Gamma', delta: 'Delta', eps: 'Epsilon', 'mc-test-alerts': 'mc-test alerts' };
const folder = (id) => path.join(T, 'projs', id);
for (const id of IDS) fs.mkdirSync(folder(id), { recursive: true });
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({
  version: 1,
  settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: path.join(T, 'root'), repeatsAuto: false },
  projects: IDS.map((id) => ({ id, name: NAMES[id], folder: folder(id), workspaces: ['ws-' + id], brief: null })),
}, null, 2));
const W = 100;
const RULE = '─'.repeat(W);
const atRest = `\n⏺ ${SECRET_TEXT}\n\n✻ Worked for 2m 3s · done 9:41 PM\n\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n`;
fs.writeFileSync(FAKE, JSON.stringify({
  workspaces: IDS.map((id, k) => ({ id: 'ws-' + id, ref: 'workspace:' + (k + 1), title: id === 'mc-test-alerts' ? 'mc-test-alerts' : NAMES[id], cwd: folder(id), surfaces: [{ id: 'sf-' + id, ref: 'surface:' + (k + 1), title: '✳ ' + NAMES[id] }] })),
  screens: Object.fromEntries(IDS.map((id) => ['sf-' + id, atRest])),
}));
const SID = Object.fromEntries(IDS.map((id, k) => [id, `a1e7${String(k).padStart(4, '0')}-0000-4000-8000-00000000000${k}`]));
const TR = {};
const iso = (m) => new Date(Date.now() - m * 60000).toISOString();
const rec = (sid, cwd, type, extra, at) => JSON.stringify({ type, cwd, sessionId: sid, timestamp: at, ...extra });
for (const id of IDS) {
  const d = path.join(CLAUDE, folder(id).replace(/[^A-Za-z0-9-]/g, '-'));
  fs.mkdirSync(d, { recursive: true });
  TR[id] = path.join(d, SID[id] + '.jsonl');
  fs.writeFileSync(TR[id], [rec(SID[id], folder(id), 'user', { message: { role: 'user', content: 'Go.' } }, iso(6)),
    rec(SID[id], folder(id), 'assistant', { message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: `${SECRET_TEXT} Done with the first part.` }], usage: { input_tokens: 6, cache_creation_input_tokens: 2000, cache_read_input_tokens: 100000, output_tokens: 300 } } }, iso(5)),
    rec(SID[id], folder(id), 'system', { subtype: 'turn_duration' }, iso(5))].join('\n') + '\n');
}
function hook(id, input) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'hooks', 'events.mjs')], { env: { ...process.env, RAVENRY_HOME: MC, MC_BOARD_URL: BASE, CMUX_WORKSPACE_ID: 'ws-' + id, CMUX_SURFACE_ID: 'sf-' + id } });
    c.on('close', resolve);
    c.stdin.end(JSON.stringify({ transcript_path: TR[id], cwd: folder(id), permission_mode: 'auto', session_id: SID[id], ...input }));
  });
}
// Before the board starts: Alpha has handed back (Needs you at start), the
// others are working.
await hook('alpha', { hook_event_name: 'SessionStart', source: 'startup' });
for (const id of IDS.slice(1)) await hook(id, { hook_event_name: 'UserPromptSubmit' });

const COPY_LOG = path.join(T, 'copied.txt');
const env = {
  ...process.env, RAVENRY_HOME: MC, PORT: String(PORT), MC_NO_EVENTS: '1', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0',
  CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE, MC_CLAUDE_PROJECTS: CLAUDE,
  MC_PROJECTS_ROOT: path.join(T, 'root'), MC_GLOBAL_CLAUDE_MD: path.join(T, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, 'backups'),
  MC_TELEGRAM_API: STUB + '/tg', MC_ALERT_BOARD_URL: 'http://192.168.1.50:4665/', MC_ALERT_PRIME_MS: '1500', MC_ALERT_RETRY_MS: '1500',
  MC_COPY_COMMAND: JSON.stringify(['/bin/sh', '-c', `cat > ${COPY_LOG}`]),
};
delete env.MC_ALERT_COOLDOWN_MS;
const board = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
board.stdout.on('data', (d) => { log += d; });
board.stderr.on('data', (d) => { log += d; });
const H = { 'Content-Type': 'application/json', 'X-Ravenry': '1' };
const api = async (p, body, base = BASE, extra = {}) => {
  const res = await fetch(base + p, body === undefined ? { headers: extra } : { method: 'POST', headers: { ...H, ...extra }, body: JSON.stringify(body) });
  let j = null;
  try { j = await res.json(); } catch { /* none */ }
  return { status: res.status, j };
};
const stateOf = async () => (await fetch(BASE + '/api/state')).json();
async function until(cond, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const s = await stateOf(); if (cond(s)) return s; } catch { /* starting */ } await sleep(40); }
  return null;
}
const ps = (s, id) => s && s.projects.find((p) => p.id === id);
try {
  let s0 = await until((s) => s.cmuxOk && ps(s, 'alpha') && ps(s, 'alpha').sessions.length && ps(s, 'beta') && ps(s, 'beta').state === 'work', 15000);
  check('test board on :4665 is up: Alpha already Needs you, the rest working', s0 && ps(s0, 'alpha').state === 'you' && IDS.slice(1).every((id) => ps(s0, id).state === 'work'), s0 ? IDS.map((id) => `${id}=${ps(s0, id).state}`).join(' ') : log.slice(-500));

  // Set up through the API, as the sheet does.
  let x = await api('/api/alerts');
  check('GET /api/alerts: not set up', x.status === 200 && x.j.configured === false && x.j.enabled === false && x.j.local === true);
  x = await api('/api/alerts/switch', { enabled: true });
  check('the switch refuses to turn on before a channel is set up', x.status === 409, x.j && x.j.error);
  x = await api('/api/alerts/telegram', { token: BAD_TOKEN });
  check('a wrong token is refused with Telegram\'s answer', x.status === 400 && /token is wrong/.test(x.j.error), x.j && x.j.error);
  x = await api('/api/alerts/telegram', { token: 'hello' });
  check('something that is not a token is refused', x.status === 400 && /not a bot token/.test(x.j.error));
  x = await api('/api/alerts/telegram', { token: TOKEN });
  check('the token is checked with getMe and saved', x.status === 200);
  stub.updates = false;
  x = await api('/api/alerts/telegram/find-chat', {});
  check('Find my chat before any message says what to do', x.status === 409 && /Send your bot any message/.test(x.j.error), x.j && x.j.error);
  stub.updates = true;
  x = await api('/api/alerts/telegram/find-chat', {});
  check('Find my chat: getUpdates, the private chat is saved', x.status === 200 && JSON.parse(fs.readFileSync(path.join(MC, 'alerts.json'), 'utf8')).telegram.chatId === CHAT);
  x = await api('/api/alerts/setup');
  check('the sheet\'s data on the Mac is masked', x.status === 200 && x.j.telegram.token === '84••••••:AAH••••••••••••••••' && x.j.telegram.chat === '51•••••42' && x.j.telegram.bot === 'ravenry_test_bot' && !JSON.stringify(x.j).includes(TOKEN.split(':')[1]), JSON.stringify(x.j.telegram));
  const topic = JSON.parse(fs.readFileSync(path.join(MC, 'alerts.json'), 'utf8')).ntfy.topic;
  check('a private random ntfy topic is made on first look, and only masked in the data', /^ravenry-[a-z0-9]{20}$/.test(topic) && x.j.ntfy.topic === 'ntfy.sh/ravenry-••••••' && !JSON.stringify({ ...x.j, ntfy: { ...x.j.ntfy, qr: '' } }).includes(topic));
  const qrSvg = x.j.ntfy.qr;
  n = reqs.length;
  x = await api('/api/alerts/test', { channel: 'telegram' });
  q = sendsSince(n)[0];
  check('Send a test: lands, with the board link', x.status === 200 && q && q.json.text === '<b>Ravenry test</b>\nAlerts from the board will land here.' && q.json.reply_markup.inline_keyboard[0][0].url === 'http://192.168.1.50:4665/', q && q.body);
  x = await api('/api/alerts/done', { channel: 'telegram', enable: true });
  check('Done after a test that went through: on, Telegram', x.status === 200 && x.j.enabled === true && x.j.channelLabel === 'Telegram');
  const mode = fs.statSync(path.join(MC, 'alerts.json')).mode & 0o777;
  check('alerts.json is mode 0600', mode === 0o600, mode.toString(8));

  // Real transitions through the real hook.
  await sleep(1600); // past the start window
  n = reqs.length;
  await hook('beta', { hook_event_name: 'Stop', last_assistant_message: `${SECRET_TEXT} I can wire the installer now. Should I go ahead?` });
  let ok = await waitReqs(n, 1);
  q = sendsSince(n)[0];
  check('board: a question sends "Beta Game needs you / Asked you a question" with the project link', ok && q && q.json.text === '<b>Beta Game needs you</b>\nAsked you a question' && q.json.reply_markup.inline_keyboard[0][0].url === 'http://192.168.1.50:4665/#beta', q && q.body);
  n = reqs.length;
  await hook('delta', { hook_event_name: 'Stop', last_assistant_message: `${SECRET_TEXT} The installer is in.` });
  ok = await waitReqs(n, 1);
  q = sendsSince(n)[0];
  check('board: a hand-back sends "Delta needs you / Handed back"', ok && q && q.json.text === '<b>Delta needs you</b>\nHanded back', q && q.body);
  n = reqs.length;
  await hook('gamma', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: `Claude needs your permission to use Bash ${SECRET_TEXT}`, title: 'Claude Code' });
  ok = await waitReqs(n, 1);
  q = sendsSince(n)[0];
  check('board: a permission prompt sends "Gamma needs you / Waiting for permission"', ok && q && q.json.text === '<b>Gamma needs you</b>\nWaiting for permission', q && q.body);
  n = reqs.length;
  await hook('mc-test-alerts', { hook_event_name: 'Stop', last_assistant_message: 'Should I?' });
  await until((s) => ps(s, 'mc-test-alerts').state === 'you');
  await sleep(500);
  check('board: no alert for the mc-test workspace', sendsSince(n).length === 0);
  await sleep(2600);
  const sNow = await stateOf();
  check('board: Alpha, Needs you since before the start, was never alerted', !reqs.some((x2) => x2.body.includes('Alpha')) && ps(sNow, 'alpha').state === 'you');
  n = reqs.length;
  await hook('beta', { hook_event_name: 'UserPromptSubmit' });
  await until((s) => ps(s, 'beta').state === 'work');
  await hook('beta', { hook_event_name: 'Stop', last_assistant_message: 'Done. Want the tests too?' });
  await until((s) => ps(s, 'beta').state === 'you');
  await sleep(600);
  check('board: Beta needing you again within 10 minutes is not alerted (cooldown)', sendsSince(n).length === 0);
  check('board: no request ever carried session text', !reqs.some((x2) => x2.body.includes(SECRET_TEXT)));

  // A send that hangs does not hold the tick; a failure is retried once.
  n = reqs.length;
  stub.hangNextMs = 2500;
  stub.failNext = 1;
  const g0 = Date.parse((await stateOf()).generatedAt);
  await hook('eps', { hook_event_name: 'Stop', last_assistant_message: 'All set.' });
  await sleep(1800);
  const g1 = Date.parse((await stateOf()).generatedAt);
  check('a send hanging 2.5 s: the board kept ticking meanwhile', g1 - g0 >= 1500 && reqs.length === n + 1, `snapshot moved ${g1 - g0} ms while the send hung`);
  const sFail = await until((s) => s.alerts && s.alerts.last && s.alerts.last.ok === false, 4000);
  check('the failure shows in the snapshot\'s status, retry pending', sFail && sFail.alerts.last.retrying && /Telegram answered 502/.test(sFail.alerts.last.error), sFail && JSON.stringify(sFail.alerts.last));
  check('the failure is in the board\'s log', /alerts: Epsilon needs you \(handback\) failed by Telegram: Telegram answered 502[^\n]*trying again in 2 s/.test(log), (log.match(/alerts: Epsilon[^\n]*/) || [''])[0]);
  const sOk = await until((s) => s.alerts && s.alerts.last && s.alerts.last.ok === true, 5000);
  check('the retry 1.5 s later lands, and the status is ok again', sOk && sendsSince(n).length === 2 && /sent by Telegram on the retry/.test(log));

  // The ntfy QR decodes to the subscribe link.
  const { chromium } = await import('playwright');
  const jsQR = (await import('jsqr')).default;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 300, height: 300 } });
  await page.setContent(`<body style="margin:0;background:#fff;padding:20px">${qrSvg.replace('width="144" height="144"', 'width="240" height="240"')}</body>`);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 280, height: 280 } });
  const img = await page.evaluate(async (b64) => {
    const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    return { w: im.width, h: im.height, d: Array.from(g.getImageData(0, 0, im.width, im.height).data) };
  }, png.toString('base64'));
  const code = jsQR(Uint8ClampedArray.from(img.d), img.w, img.h);
  check('the ntfy QR decodes to ntfy://ntfy.sh/<the saved topic>?display=Ravenry', code && code.data === `ntfy://ntfy.sh/${topic}?display=Ravenry`, code ? code.data.replace(topic, '<topic>') : 'no QR found');
  await browser.close();

  x = await api('/api/alerts/ntfy/copy', {});
  check('Copy topic puts the topic on the Mac\'s clipboard, not in the page', x.status === 200 && fs.readFileSync(COPY_LOG, 'utf8') === topic && !JSON.stringify(x.j).includes(topic));
  x = await api('/api/alerts/ntfy/new-topic', {});
  const topic2 = JSON.parse(fs.readFileSync(path.join(MC, 'alerts.json'), 'utf8')).ntfy.topic;
  check('New topic replaces the topic', x.status === 200 && topic2 !== topic && /^ravenry-[a-z0-9]{20}$/.test(topic2));
  x = await api('/api/alerts/webhook', { url: 'https://example.com/hook' });
  check('a URL that is neither Discord nor Slack is refused', x.status === 400 && /not a Discord or Slack/.test(x.j.error));
  x = await api('/api/alerts/telegram', { token: TOKEN }, BASE, { 'X-Ravenry': '' });
  check('the write guard: no X-Ravenry header, 403', x.status === 403);
  x = await api('/api/alerts/telegram', { token: TOKEN }, BASE, { Origin: 'http://evil.example' });
  check('the write guard: another origin, 403', x.status === 403);

  // A phone: the Mac's own Wi-Fi address, signed in with the phone key.
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address));
  if (!lan) check('a phone: this Mac has no private LAN address to test from', false);
  else {
    const PB = `http://${lan.address}:${PORT}`;
    await fetch(BASE + '/api/phone');
    const key = JSON.parse(fs.readFileSync(path.join(MC, 'phone.json'), 'utf8')).key;
    const si = await fetch(`${PB}/?k=${encodeURIComponent(key)}`, { redirect: 'manual' });
    const cookie = (si.headers.get('set-cookie') || '').split(/,(?=\s*mc_)/).map((c) => c.split(';')[0].trim()).filter((c) => c.startsWith('mc_phone=')).join('; ');
    const PH = { Cookie: cookie };
    x = await api('/api/alerts', undefined, PB, PH);
    check('a phone sees the status (not local), with no secret', x.status === 200 && x.j.local === false && x.j.channelLabel === 'Telegram' && !JSON.stringify(x.j).match(/AAH|512345|ravenry-/), JSON.stringify(x.j));
    x = await api('/api/alerts/setup', undefined, PB, PH);
    check('a phone asking for the sheet\'s data: 403 with the sentence the sheet shows', x.status === 403 && x.j.error === 'Tokens are set up on the Mac only. From this phone you can turn alerts on or off and send a test.', `${x.status} ${x.j && x.j.error}`);
    for (const [p, b] of [['/api/alerts/telegram', { token: TOKEN }], ['/api/alerts/telegram/find-chat', {}], ['/api/alerts/webhook', { url: DISCORD }], ['/api/alerts/ntfy/new-topic', {}], ['/api/alerts/ntfy/copy', {}], ['/api/alerts/ntfy', { server: 'https://ntfy.sh' }], ['/api/alerts/done', { channel: 'ntfy', enable: true }]]) {
      x = await api(p, b, PB, { ...PH, Origin: PB });
      check(`a phone changing secrets: POST ${p} is 403`, x.status === 403, String(x.status));
    }
    n = reqs.length;
    x = await api('/api/alerts/test', { channel: 'ntfy' }, PB, { ...PH, Origin: PB });
    check('a phone may press Send a test (the active channel, whatever it names)', x.status === 200 && sendsSince(n).length === 1);
    x = await api('/api/alerts/switch', { enabled: false }, PB, { ...PH, Origin: PB });
    check('a phone may turn alerts off with the switch', x.status === 200 && x.j.enabled === false);
    await api('/api/alerts/switch', { enabled: true });
  }

  const snap = JSON.stringify(await stateOf());
  const leaks = [TOKEN, TOKEN.split(':')[1], CHAT, topic, topic2, 'abcDEF_secret-token'];
  check('no secret in the snapshot', !leaks.some((k) => snap.includes(k)));
  check('no secret in the board\'s log', !leaks.some((k) => log.includes(k)), leaks.filter((k) => log.includes(k)).join(', '));
} finally {
  board.kill();
  server.close();
}
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
