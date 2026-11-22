// Phone alerts (docs/design/PhoneAlerts.dc.html, variant B): when a project
// starts needing the user, one short alert goes to their phone through the
// channel they set up (server/channels.mjs).
//
// What triggers one: a project whose state moves into Needs you, from the
// board's own state, because its session asked a question, handed back, or
// waits on a permission prompt. One alert per transition:
// - nothing for states already Needs you when the board starts (the first
//   look at each project, and the first PRIME_MS, only record);
// - the same session, kind and moment seen again (a one-tick blip out of
//   Needs you and back) is not alerted twice;
// - at most one alert per project every COOLDOWN_MS (10 minutes);
// - nothing for the board's own test workspaces (mc-test-*).
// A plan gate is the exception to the cooldown: a gate always needs the user,
// so each distinct gate (its plan, step and question; gateKey) alerts once,
// however soon after the last alert, and never twice. Gates neither wait
// for the cooldown nor start it.
// The alert says "<Project> needs you" and the kind, never the session's
// text, and links to that session on the board over the Wi-Fi address
// (sessionUrl).
//
// Sending never blocks the tick: observe() starts the send and returns. A
// failed send is shown in the status and the log and tried once more after
// RETRY_MS (30 s).
//
// The phones (server/push.mjs, docs/PHONE.md) are a third, with their own
// trigger and state, on whenever a phone gets alerts: a paired app's alert
// carries the question and its buttons, encrypted for that phone; an
// iPhone through ntfy (set up here, "iPhones through ntfy" below) gets the
// same alert's title and fixed line on a topic of its own. One person may
// have them all at once, besides one channel: each gets an alert once.
//
// Mac notifications (the bell, server/desktop.mjs) are a second channel with
// the same triggers, wording and dedupe, run by their own trigger with its
// own state, and their own switch: on unless the user turns the bell off
// (alerts.json "desktop.enabled"). They need no phone setup.
//
// Secrets (bot token, chat id, webhook URL, ntfy topic) live in
// <RAVENRY_HOME>/alerts.json, mode 0600. status() carries none of them;
// setupView() carries them masked, and the server serves it to the Mac only.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { RAVENRY_HOME } from './home.mjs';
import * as desktop from './desktop.mjs';
import * as push from './push.mjs';
import * as phone from './phone.mjs';
import { t as words } from './strings.mjs';
import { KINDS, CHECKPOINT_KINDS, DRIVE_ACTIONS, PROGRAM_KINDS } from './alertwords.mjs';
import {
  CHANNELS, DEFAULT_NTFY, telegramTokenOk, telegramMe, telegramFindChat,
  webhookKind, maskWebhook, ntfySubscribeLink, maskTopic, ntfyServerOk,
} from './channels.mjs';

export const ALERTS_FILE = path.join(RAVENRY_HOME, 'alerts.json');
const env = process.env;
const num = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const COOLDOWN_MS = num(env.MC_ALERT_COOLDOWN_MS, 10 * 60 * 1000);
const RETRY_MS = num(env.MC_ALERT_RETRY_MS, 30 * 1000);
const PRIME_MS = num(env.MC_ALERT_PRIME_MS, 8000);

// The fixed words (server/alertwords.mjs), as this module has always exported them.
export { KINDS, CHECKPOINT_KINDS, DRIVE_ACTIONS, PROGRAM_KINDS };

// The alert's second line where it travels in clear (Telegram, a webhook,
// ntfy): a fixed phrase for every kind, never the session's text or a plan
// gate's question (tools/clear-alerts-test.mjs).
// A plain program that waits (kind 'program', SESS-056) says what for by
// the kind it gave (`p`, its project), never its own words.
export function kindText(kind, p = null) {
  if (kind === 'program') return PROGRAM_KINDS[programNeed(p)];
  return KINDS[kind];
}

// The kind a project's waiting program said it waits for (auth,
// permission, question), else other.
function programNeed(p) {
  const s = p && (p.sessions || []).find((x) => x.surfaceId === p.primary);
  const k = s && s.program && s.program.kind;
  return PROGRAM_KINDS[k] ? k : 'other';
}

// The same line for the Mac's own notifications, which stay on this Mac: a
// plan gate says its short question there (the plan wrote it,
// server/planfmt.mjs shortQuestion).
export function localKindText(kind, p) {
  if (kind === 'gate' && p && p.planGate && p.planGate.short) return `Plan gate: ${p.planGate.short}`;
  return kindText(kind, p);
}
export const PHONE_REFUSED = 'Tokens are set up on the Mac only. From this phone you can turn alerts on or off and send a test.';

// ------------------------------------------------------------ the file

let data = null;
let mtime = 0;
let changed = () => {};
export function onChange(fn) { changed = fn; }

function fresh() {
  return { enabled: false, channel: null, telegram: {}, webhook: {}, ntfy: { server: DEFAULT_NTFY }, last: null, desktop: { enabled: true, last: null } };
}

// Read again when the file changed on disk (the user may set ntfy.server by hand).
function load() {
  let st = null;
  try { st = fs.statSync(ALERTS_FILE); } catch { /* none yet */ }
  // Unchanged on disk (or still never written): the copy in memory. A file
  // removed by hand reads as not set up.
  if (data && (st ? st.mtimeMs === mtime : mtime === 0)) return data;
  let d = null;
  if (st) { try { d = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); } catch { d = null; } }
  const f = fresh();
  data = d && typeof d === 'object' ? {
    ...f, ...d,
    telegram: { ...(d.telegram || {}) }, webhook: { ...(d.webhook || {}) }, ntfy: { ...f.ntfy, ...(d.ntfy || {}) },
    desktop: { ...f.desktop, ...(d.desktop && typeof d.desktop === 'object' ? d.desktop : {}) },
  } : f;
  data.desktop.enabled = data.desktop.enabled !== false;
  if (!CHANNELS[data.channel]) data.channel = null;
  mtime = st ? st.mtimeMs : 0;
  if (st && (st.mode & 0o077)) { try { fs.chmodSync(ALERTS_FILE, 0o600); } catch { /* ignore */ } }
  return data;
}

function save() {
  fs.mkdirSync(RAVENRY_HOME, { recursive: true });
  const tmp = ALERTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, ALERTS_FILE);
  try { mtime = fs.statSync(ALERTS_FILE).mtimeMs; } catch { /* ignore */ }
  changed();
}

const ready = (d, id) => !!(id && CHANNELS[id] && CHANNELS[id].ready(d[id]));
const label = (d, id) => (id && CHANNELS[id] ? CHANNELS[id].label(d[id]) : null);

// ------------------------------------------------------------ views

// For every client, phones included: no secret, masked or not.
export function status() {
  const d = load();
  const l = d.last;
  return {
    enabled: !!d.enabled,
    configured: ready(d, d.channel),
    channel: d.channel,
    channelLabel: label(d, d.channel),
    last: l ? { at: l.at, ok: !!l.ok, error: l.ok ? null : l.error || null, retrying: !!l.retrying, channelLabel: l.channelLabel || null } : null,
    desktop: desktopStatus(d),
    // The phones whose Ravenry app gets alerts (server/push.mjs), by name.
    apps: push.appNames(),
    // Every phone alerts reach, with how: 'app' (the Ravenry app) or 'ntfy'
    // (an iPhone through ntfy). No id, topic or endpoint.
    phones: push.phones().map((x) => ({ name: x.name, transport: x.transport })),
  };
}

function desktopStatus(d) {
  const l = d.desktop.last;
  return { enabled: d.desktop.enabled !== false, last: l ? { at: l.at, ok: !!l.ok, via: l.via || null, error: l.ok ? null : l.error || null, denied: !!l.denied, unconfirmed: !!l.unconfirmed } : null };
}

export function maskToken(t) {
  const m = /^(\d+):(.+)$/.exec(String(t || ''));
  return m ? `${m[1].slice(0, 2)}••••••:${m[2].slice(0, 3)}••••••••••••••••` : null;
}
export function maskChat(c) {
  const s = String(c ?? '');
  if (!s) return null;
  return s.length <= 5 ? '•••••' : `${s.slice(0, 2)}•••••${s.slice(-2)}`;
}

// The setup sheet, for the Mac only. Everything secret is masked; the ntfy
// subscribe link reaches the page only inside its QR picture, like the
// phone sign-in key.
// `iphone.link`: the board's Safari sign-in link (server/phone.mjs
// signInLink), which the Add an iPhone QR opens on its #iphone page.
export function setupView(qrSvg, { iphoneLink = null, iphoneQr = null } = {}) {
  const d = load();
  if (!d.ntfy.topic) { d.ntfy.topic = newTopicName(); save(); }
  const t = d.telegram, w = d.webhook, n = d.ntfy;
  const access = phone.access();
  const mine = pending('mac');
  return {
    ...status(),
    // The phones list, with what the Mac's rows need (ids, the last send).
    phones: push.phones().map((x) => ({ id: x.id, name: x.name, platform: x.platform, form: x.form, transport: x.transport, last: x.last, moved: x.moved, gone: x.gone, ntfyBack: x.ntfyBack })),
    // Add an iPhone: the QR (the sign-in link + #iphone) only while phone
    // access is on, else the person copies the code instead; the code this
    // Mac copied and has not confirmed yet.
    // `storeQr`: the Ravenry app's App Store page (shared strings alerts.appStoreUrl), always.
    iphone: { access, qr: access && iphoneLink && iphoneQr ? iphoneQr(`${iphoneLink}#iphone`) : null, storeQr: phone.qrSvg(words('alerts.appStoreUrl'), 96, words('alerts.iphoneStoreQr'), 2), server: ntfyServerOf(d), pending: mine ? { id: mine.id } : null },
    ready: Object.fromEntries(Object.keys(CHANNELS).map((id) => [id, ready(d, id)])),
    telegram: { token: maskToken(t.token), bot: t.bot || null, chat: maskChat(t.chatId) },
    webhook: { url: w.url ? maskWebhook(w.url) : null, kind: w.url ? webhookKind(w.url) : null },
    ntfy: { server: String(n.server || DEFAULT_NTFY).replace(/\/+$/, ''), topic: maskTopic(n), qr: qrSvg(ntfySubscribeLink(n)) },
  };
}

// ------------------------------------------------------------ setup writes

const fail = (status, error) => ({ ok: false, status, error });

export function setEnabled(on) {
  const d = load();
  if (on && !ready(d, d.channel)) return fail(409, 'Set up where alerts go first.');
  d.enabled = !!on;
  save();
  return { ok: true };
}

// The bell: Mac notifications on or off, for every page (a phone too).
export function setDesktop(on) {
  const d = load();
  d.desktop.enabled = !!on;
  save();
  return { ok: true };
}

export async function saveTelegramToken(raw) {
  const token = String(raw || '').trim();
  if (!telegramTokenOk(token)) return fail(400, 'That is not a bot token. BotFather sends one like 123456789:AAH...');
  const me = await telegramMe(token);
  if (!me.ok && !/^Could not reach/.test(me.error)) return fail(400, me.error + '.');
  const d = load();
  if (d.telegram.token !== token) d.telegram = { token };
  d.telegram.bot = me.ok ? me.username : d.telegram.bot || null;
  save();
  return { ok: true, note: me.ok ? null : `Saved. ${me.error}, so the token is not checked yet.` };
}

export async function findTelegramChat() {
  const d = load();
  if (!telegramTokenOk(d.telegram.token)) return fail(409, 'Paste the bot token first.');
  const r = await telegramFindChat(d.telegram.token);
  if (!r.ok) return fail(409, r.error + '.');
  d.telegram.chatId = r.chatId;
  save();
  return { ok: true };
}

export function saveWebhook(raw) {
  const url = String(raw || '').trim();
  if (!webhookKind(url)) return fail(400, 'That is not a Discord or Slack webhook URL.');
  const d = load();
  d.webhook = { url };
  save();
  return { ok: true };
}

function newTopicName() {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const b = crypto.randomBytes(20);
  let s = '';
  for (const x of b) s += abc[x % abc.length];
  return 'ravenry-' + s;
}

export function newTopic() {
  const d = load();
  d.ntfy.topic = newTopicName();
  save();
  return { ok: true };
}

export function setNtfyServer(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!ntfyServerOk(s)) return fail(400, 'That is not a server address like https://ntfy.sh.');
  const d = load();
  d.ntfy.server = s;
  save();
  return { ok: true };
}

// Text onto the Mac's clipboard (MC_COPY_COMMAND in tests).
function copyText(text, what) {
  const argv = env.MC_COPY_COMMAND ? JSON.parse(env.MC_COPY_COMMAND) : ['/usr/bin/pbcopy'];
  return new Promise((resolve) => {
    const p = execFile(argv[0], argv.slice(1), { timeout: 5000 }, (err) => resolve(err ? fail(500, `Could not copy the ${what}.`) : { ok: true }));
    p.stdin.end(text);
  });
}

// The topic onto the Mac's clipboard, for an iPhone (the ntfy iPhone app
// opens no links, and Universal Clipboard carries it across). The topic
// itself never goes to the page.
export function copyTopic() {
  const d = load();
  if (!d.ntfy.topic) return Promise.resolve(fail(409, 'There is no topic yet.'));
  return copyText(d.ntfy.topic, 'topic');
}

// ------------------------------------------------------------ iPhones through ntfy

// An iPhone is a phone in the phones list, not a channel (docs/PHONE.md
// section 4, "An iPhone through ntfy"): a device record with no sign-in,
// { id, name: "iPhone", platform: "ios", app: null, hash: null, push: {
// kind: "ntfy", server, topic, confirmed } }, made by its setup, alerted by
// server/push.mjs with every other phone. Its topic is its own, never the
// ntfy channel's; Remove forgets it.
//
// The setup: the iPhone's own Safari page (the board's #iphone, signed in
// by the QR) or this Mac (Copy the code instead) asks for a code (start),
// the person subscribes to it in ntfy, Send a test sends one there, It
// arrived confirms, and from then on it gets alerts. `by` is who asked:
// the browser's device id, or 'mac'; each has at most one code waiting,
// and a code nobody confirmed in an hour goes.
const PENDING_MS = 60 * 60 * 1000;
const ntfyServerOf = (d) => String((d.ntfy && d.ntfy.server) || DEFAULT_NTFY).replace(/\/+$/, '');
// An iPhone through ntfy: one with no sign-in, or one the iPhone app took
// over (phone.takeover), which keeps its ntfy target until the app has its own.
const isNtfyIphone = (r) => !!(r && r.push && r.push.kind === 'ntfy' && (r.hash === null || r.platform === 'ios'));

function pending(by) {
  return phone.unsignedRecords().find((r) => isNtfyIphone(r) && !r.push.confirmed && r.by === by && Date.now() - Date.parse(r.created) < PENDING_MS) || null;
}

// A code for this iPhone: { ok, id, topic, server, mac }.
export function iphoneStart(by) {
  if (!by) return fail(401, 'Sign in first.');
  for (const r of phone.unsignedRecords()) if (isNtfyIphone(r) && !r.push.confirmed && Date.now() - Date.parse(r.created) >= PENDING_MS) phone.revoke(r.id);
  const rec = pending(by) || phone.addUnsigned({ name: 'iPhone', platform: 'ios', by, push: { kind: 'ntfy', server: ntfyServerOf(load()), topic: newTopicName(), confirmed: null } });
  return { ok: true, id: rec.id, topic: rec.push.topic, server: rec.push.server, mac: phone.hubName() };
}

// An iPhone's record, for `by` (the Mac may act on any).
function iphoneFor(id, by) {
  const r = phone.deviceRecord(String(id || ''));
  if (!isNtfyIphone(r) || (by !== 'mac' && r.by !== by)) return null;
  return r;
}

// Send a test: one test alert on that iPhone's topic, confirmed or not.
export async function iphoneTest(id, by, boardUrl) {
  const r = iphoneFor(id, by);
  if (!r) return fail(404, 'No such iPhone. Start again.');
  const x = await push.sendTo(r.id, push.testMessage(), { click: boardUrl || null });
  console.log(`alerts: iPhone test ${x.ok ? 'sent' : 'failed: ' + x.error}`);
  return x.ok ? { ok: true } : fail(502, `${x.error}.`);
}

// It arrived: the iPhone joins the phones list and gets every alert.
export function iphoneConfirm(id, by) {
  const r = iphoneFor(id, by);
  if (!r) return fail(404, 'No such iPhone. Start again.');
  if (!r.push.confirmed) {
    const taken = new Set(phone.alertRecords().map((x) => x.name));
    let name = 'iPhone';
    for (let k = 2; taken.has(name); k++) name = `iPhone ${k}`;
    phone.updateRecord(r.id, (t) => { t.push = { ...t.push, confirmed: new Date().toISOString() }; t.name = name; });
    console.log(`alerts: ${name} gets alerts through ntfy (${r.id})`);
  }
  return { ok: true, id: r.id };
}

// Copy the code instead: this Mac's code onto its clipboard (Universal
// Clipboard carries it to the iPhone). The code never goes to the page.
export async function iphoneCopy() {
  const s = iphoneStart('mac');
  const r = await copyText(s.topic, 'code');
  return r.ok ? { ok: true, id: s.id } : r;
}

// Remove: the iPhone's record and its topic are forgotten.
export function iphoneRemove(id) {
  const r = iphoneFor(id, 'mac');
  if (!r) return fail(404, 'No such iPhone.');
  phone.forget(r.id);
  console.log(`alerts: ${r.name} removed (${r.id})`);
  return { ok: true };
}

// Send a test to one phone of the list (an app or an iPhone).
export async function phoneTest(id, boardUrl) {
  const rec = phone.deviceRecord(String(id || ''));
  if (!rec || !phone.alertRecords().includes(rec)) return fail(404, 'No such phone.');
  const x = await push.sendTo(rec.id, push.testMessage(), { click: boardUrl || null });
  return x.ok ? { ok: true, held: !!x.held } : fail(502, `${x.error}.`);
}

// Done in the sheet: the channel shown becomes the one alerts use, and a
// sheet whose test went through turns alerts on.
export function choose(id, enable) {
  const d = load();
  if (!CHANNELS[id]) return fail(400, 'No such channel.');
  if (!ready(d, id)) return { ok: true, changed: false };
  d.channel = id;
  if (enable) d.enabled = true;
  save();
  return { ok: true, changed: true };
}

// ------------------------------------------------------------ sending

function testAlert(boardUrl) {
  return { test: true, kind: 'test', project: null, title: 'Ravenry test', body: 'Alerts from the board will land here.', url: boardUrl || null };
}

// Send a test now through `id` (the sheet's channel) or the active one. A
// test that goes through makes that channel the active one.
export async function sendTest(id, boardUrl) {
  // Paired apps get a test too (server/push.mjs), whatever the channel.
  const apps = push.ready() ? push.send(push.testMessage(), { click: boardUrl || null }) : 0;
  const d = load();
  if (apps && !CHANNELS[id || d.channel]) return { ok: true, apps };
  const ch = id || d.channel;
  if (!CHANNELS[ch]) return fail(409, 'Set up where alerts go first.');
  if (!ready(d, ch)) return fail(409, ch === 'telegram' ? 'Paste the token and find your chat first.' : ch === 'webhook' ? 'Paste a webhook URL first.' : 'Make a topic first.');
  const r = await safeSend(CHANNELS[ch], testAlert(boardUrl), d[ch]);
  const name = label(d, ch);
  console.log(`alerts: test by ${name} ${r.ok ? 'sent' : 'failed: ' + r.error}`);
  if (r.ok && d.channel !== ch) { d.channel = ch; save(); }
  return r.ok ? { ok: true } : fail(502, r.error + '.');
}

async function safeSend(ch, alert, cfg) {
  try { return await ch.send(alert, cfg); } catch { return { ok: false, error: 'The send failed on this Mac' }; }
}

const timers = new Set();

async function deliver(alert, attempt = 1) {
  const d = load();
  const id = d.channel;
  if (!d.enabled || !ready(d, id)) return;
  const ch = CHANNELS[id];
  const name = label(d, id);
  const r = await safeSend(ch, alert, d[id]);
  const at = new Date().toISOString();
  const d2 = load();
  if (r.ok) {
    d2.last = { at, ok: true, kind: alert.kind, channelLabel: name };
    console.log(`alerts: ${alert.title} (${alert.kind}) sent by ${name}${attempt > 1 ? ' on the retry' : ''}`);
  } else {
    const again = attempt === 1;
    d2.last = { at, ok: false, kind: alert.kind, channelLabel: name, error: r.error, retrying: again };
    console.log(`alerts: ${alert.title} (${alert.kind}) failed by ${name}: ${r.error}${again ? `; trying again in ${Math.round(RETRY_MS / 1000)} s` : ''}`);
    if (again) {
      const t = setTimeout(() => { timers.delete(t); deliver(alert, 2); }, RETRY_MS);
      if (t.unref) t.unref();
      timers.add(t);
    }
  }
  try { save(); } catch (e) { console.error('alerts: could not save the status:', e.message); }
}

// ------------------------------------------------------------ triggers

// One plan gate: the project, the plan (its title and when it started, so a
// plan run again is a new plan), the step and the question it asks.
export function gateKey(p) {
  const g = p.planGate || {};
  const plan = p.plan || {};
  return [p.id, plan.title || '', plan.started || '', g.n ?? '', g.question || ''].join('|');
}

const PERMISSION_WORDS = /don't ask again|tell Claude what to do differently|Do you want to (proceed|make this edit|create|run|allow|fetch|use)/i;

// What the session that put the project in Needs you is waiting for, or
// null when it is not one of the three kinds (a half-typed reply is the user's own).
export function kindOf(p) {
  if (!p || p.state !== 'you') return null;
  // A plan waiting at a gate (docs/design/Plans.dc.html): the gate is why.
  if (p.planGate) return 'gate';
  const s = (p.sessions || []).find((x) => x.surfaceId === p.primary);
  if (!s) return null;
  // A plain program in its pane that waits (SESS-056).
  if (s.state === 'blocked' && s.program) return 'program';
  if (s.state === 'asked') return 'question';
  if (s.state === 'handback') return 'handback';
  if (s.state !== 'dialog') return null;
  if (s.notificationType === 'permission_prompt') return 'permission';
  if (s.notificationType) return 'question';
  const w = s.words || {};
  return PERMISSION_WORDS.test([...(w.dialog || []), w.headline || ''].join('\n')) ? 'permission' : 'question';
}

// The board's address for an alert about a session: the phone page opens
// the project with that session chosen (#<project>/<session>, public/app.js
// sessionFromHash), by its Claude session id, which a move or a Continue
// keeps, else its tab. A ravenry:// link would do nothing on a phone. No
// session: the project; no project: the board.
export function sessionUrl(boardUrl, p, s) {
  if (!boardUrl) return null;
  if (!p) return boardUrl;
  const key = s && (s.sessionId || s.surfaceId);
  return `${boardUrl}#${encodeURIComponent(p.id)}${key ? `/${encodeURIComponent(key)}` : ''}`;
}

export function isTestProject(p) {
  // A test board that proves alerts on its own mc-test workspace says so.
  if (env.MC_ALERT_ALLOW_TEST === '1') return false;
  const t = /^mc-test/i;
  return t.test(p.id || '') || t.test(p.name || '') || (p.workspaces || []).some((w) => t.test(w.title || ''));
}

// One channel's trigger: its own memory of what it saw and sent, so the
// phone and the Mac each get exactly one alert per transition and per gate,
// whichever of them is switched on. `on()` says whether the channel sends
// now; `start(alert, p)` starts a send without waiting for it.
function makeTrigger({ on, start }) {
  const prev = new Map();      // projectId -> its state at the last look
  const seen = new Map();      // `${session}|${kind}` -> the moment last alerted
  const cooled = new Map();    // projectId -> when it was last alerted
  const gates = new Set();     // gateKey of every plan gate seen (alerted, or there before)
  let firstAt = null;
  return (projects, { now = Date.now(), boardUrl = null } = {}) => {
    if (firstAt == null) firstAt = now;
    const priming = now - firstAt < PRIME_MS;
    const out = [];
    for (const p of projects) {
      const before = prev.get(p.id);
      prev.set(p.id, p.state);
      let kind;
      if (p.state === 'you' && p.planGate) {
        // A plan gate: once per distinct gate, by its key alone. A gate there
        // at the first look, or while this channel is off, counts as seen.
        const gk = gateKey(p);
        const fresh = !gates.has(gk);
        gates.add(gk);
        if (priming || before === undefined || !fresh || isTestProject(p)) continue;
        if (!on()) continue;
        kind = 'gate';
      } else {
        if (priming || before === undefined || before === 'you' || p.state !== 'you') continue;
        if (isTestProject(p)) continue;
        kind = kindOf(p);
        if (!kind) continue;
        const s = p.sessions.find((x) => x.surfaceId === p.primary);
        const key = `${s.sessionId || s.surfaceId}|${kind}`;
        const moment = s.since || '';
        if (seen.has(key) && seen.get(key) === moment) continue;
        if (now - (cooled.get(p.id) ?? -Infinity) < COOLDOWN_MS) continue;
        if (!on()) continue;
        seen.set(key, moment);
        cooled.set(p.id, now);
      }
      const alert = { test: false, kind, projectId: p.id, project: p.name, title: `${p.name} needs you`, body: kindText(kind, p), url: sessionUrl(boardUrl, p, (p.sessions || []).find((x) => x.surfaceId === p.primary)) };
      out.push(alert);
      start(alert, p);
    }
    return out;
  };
}

const phoneTrigger = makeTrigger({
  on: () => { const d = load(); return !!d.enabled && ready(d, d.channel); },
  start: (alert) => { deliver(alert).catch((e) => console.error('alerts:', e.message)); },
});

// The phone apps' trigger: on whenever an app is paired; its alert is
// drawn by server/push.mjs from the project, with the question and buttons.
const appTrigger = makeTrigger({
  on: () => push.ready(),
  start: (alert, p) => { push.fromProject({ ...alert, gateKey: alert.kind === 'gate' ? gateKey(p) : null }, p); },
});

const desktopTrigger = makeTrigger({
  on: () => load().desktop.enabled !== false,
  start: (alert, p) => { deliverDesktop({ kind: alert.kind, projectId: alert.projectId, title: alert.title, body: localKindText(alert.kind, p), ...desktop.targetFor(p) }).catch((e) => console.error('desktop:', e.message)); },
});

async function deliverDesktop(alert) {
  const r = await desktop.send(alert);
  const d = load();
  d.desktop.last = { at: new Date().toISOString(), ok: r.ok, kind: alert.kind, via: r.via || null, error: r.ok ? null : r.error, denied: !!r.denied, unconfirmed: !!r.unconfirmed };
  // "shown" only when the app said macOS showed it; osascript only says it ran.
  console.log(`desktop: ${alert.title} (${alert.kind}) ${r.ok ? (r.unconfirmed ? `sent by ${r.via}, not confirmed (${r.fallbackFrom || 'no answer from macOS'})` : `shown by ${r.via}`) : `not shown${r.via ? ` by ${r.via}` : ''}: ${r.error}`}`);
  try { save(); } catch (e) { console.error('desktop: could not save the status:', e.message); }
}

// Alerts' Send a test for Mac notifications: one notification, by the same
// path a real one takes, and its result as the status shows it.
export async function testDesktop() {
  await deliverDesktop({ kind: 'test', projectId: null, title: 'Ravenry', body: 'A test: Mac notifications reach you.', workspaceId: null, surfaceId: null });
  const l = load().desktop.last;
  if (l && l.ok) return { ok: true, via: l.via, unconfirmed: !!l.unconfirmed };
  return fail(502, l && l.denied ? 'macOS has not allowed Ravenry\'s notifications. Turn them on in System Settings > Notifications.' : (l && l.error) || 'It was not shown.');
}

// Called with each tick's projects. Returns the phone alerts it started,
// with the Mac notifications it started as `.desktop` (tests).
export function observe(projects, opts = {}) {
  const out = phoneTrigger(projects, opts);
  out.desktop = desktopTrigger(projects, opts);
  out.apps = appTrigger(projects, opts);
  try { push.syncProjects(projects); } catch (e) { console.error('push:', e.message); }
  return out;
}

// ------------------------------------------------------------ checkpoints

// A checkpoint that opened (server/checkpoints.mjs): an agent waits for the
// person, so it alerts at once, once per checkpoint, through the same
// channel and the Mac's notifications, with no cooldown (the agent is
// blocked until someone answers). Like every alert it says who and what
// kind, never the agent's text: the question, the command and the secret's
// label stay on the board.
// (CHECKPOINT_KINDS and DRIVE_ACTIONS: server/alertwords.mjs.)

export function checkpointAlert(cp, { project = null, machine = null, boardUrl = null, paneName = null, askerName = null } = {}) {
  const who = project ? project.name : machine ? `An agent on ${machine}` : 'An agent';
  const kind = cp.kind === 'drive' ? DRIVE_ACTIONS[(cp.drive && cp.drive.action) || 'input'] || CHECKPOINT_KINDS.drive : CHECKPOINT_KINDS[cp.kind];
  const body = (kind || 'Waits for you') + (machine && project ? ` (on ${machine})` : '');
  // The session that asks, when it is one of the project's (its pane's tab).
  const s = project && cp.pane ? (project.sessions || []).find((x) => x.surfaceId === `ravenry:${cp.pane}`) || null : null;
  const alert = { test: false, kind: 'checkpoint', projectId: project ? project.id : null, project: project ? project.name : null, title: `${who} needs you`, body, url: sessionUrl(boardUrl, project, s) };
  const d = load();
  if (d.enabled && ready(d, d.channel)) deliver(alert).catch((e) => console.error('alerts:', e.message));
  if (d.desktop.enabled !== false) deliverDesktop({ kind: 'checkpoint', projectId: alert.projectId, title: alert.title, body: alert.body, surfaceId: s ? s.surfaceId : null }).catch((e) => console.error('desktop:', e.message));
  try { push.fromCheckpoint(cp, { project, machine, paneName, askerName, click: alert.url }); } catch (e) { console.error('push:', e.message); }
  return alert;
}
