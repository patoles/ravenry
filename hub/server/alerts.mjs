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
// text, and links to the project on the board over the Wi-Fi address.
//
// Sending never blocks the tick: observe() starts the send and returns. A
// failed send is shown in the status and the log and tried once more after
// RETRY_MS (30 s).
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

export const KINDS = { question: 'Asked you a question', handback: 'Handed back', permission: 'Waiting for permission', gate: 'Plan gate' };

// The alert's second line. A plan gate says its own short question (the
// plan wrote it, server/planfmt.mjs shortQuestion); every other kind is a
// fixed phrase, never the session's text.
export function kindText(kind, p) {
  if (kind === 'gate' && p && p.planGate && p.planGate.short) return `Plan gate: ${p.planGate.short}`;
  return KINDS[kind];
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
  };
}

function desktopStatus(d) {
  const l = d.desktop.last;
  return { enabled: d.desktop.enabled !== false, last: l ? { at: l.at, ok: !!l.ok, via: l.via || null, error: l.ok ? null : l.error || null } : null };
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
export function setupView(qrSvg) {
  const d = load();
  if (!d.ntfy.topic) { d.ntfy.topic = newTopicName(); save(); }
  const t = d.telegram, w = d.webhook, n = d.ntfy;
  return {
    ...status(),
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

// The topic onto the Mac's clipboard, for an iPhone (the ntfy iPhone app
// opens no links, and Universal Clipboard carries it across). The topic
// itself never goes to the page.
export function copyTopic() {
  const d = load();
  if (!d.ntfy.topic) return Promise.resolve(fail(409, 'There is no topic yet.'));
  const argv = env.MC_COPY_COMMAND ? JSON.parse(env.MC_COPY_COMMAND) : ['/usr/bin/pbcopy'];
  return new Promise((resolve) => {
    const p = execFile(argv[0], argv.slice(1), { timeout: 5000 }, (err) => resolve(err ? fail(500, 'Could not copy the topic.') : { ok: true }));
    p.stdin.end(d.ntfy.topic);
  });
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
  const d = load();
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
  if (s.state === 'asked') return 'question';
  if (s.state === 'handback') return 'handback';
  if (s.state !== 'dialog') return null;
  if (s.notificationType === 'permission_prompt') return 'permission';
  if (s.notificationType) return 'question';
  const w = s.words || {};
  return PERMISSION_WORDS.test([...(w.dialog || []), w.headline || ''].join('\n')) ? 'permission' : 'question';
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
      const alert = { test: false, kind, projectId: p.id, project: p.name, title: `${p.name} needs you`, body: kindText(kind, p), url: boardUrl ? `${boardUrl}#${encodeURIComponent(p.id)}` : null };
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

const desktopTrigger = makeTrigger({
  on: () => load().desktop.enabled !== false,
  start: (alert, p) => { deliverDesktop({ kind: alert.kind, projectId: alert.projectId, title: alert.title, body: alert.body, ...desktop.targetFor(p) }).catch((e) => console.error('desktop:', e.message)); },
});

async function deliverDesktop(alert) {
  const r = await desktop.send(alert);
  const d = load();
  d.desktop.last = { at: new Date().toISOString(), ok: r.ok, kind: alert.kind, via: r.via || null, error: r.ok ? null : r.error };
  console.log(`desktop: ${alert.title} (${alert.kind}) ${r.ok ? `shown by ${r.via}${r.fallbackFrom ? ` (${r.fallbackFrom})` : ''}` : 'failed: ' + r.error}`);
  try { save(); } catch (e) { console.error('desktop: could not save the status:', e.message); }
}

// Called with each tick's projects. Returns the phone alerts it started,
// with the Mac notifications it started as `.desktop` (tests).
export function observe(projects, opts = {}) {
  const out = phoneTrigger(projects, opts);
  out.desktop = desktopTrigger(projects, opts);
  return out;
}
