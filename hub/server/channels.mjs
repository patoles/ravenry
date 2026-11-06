// Phone alert channels (docs/design/PhoneAlerts.dc.html, variant B). One
// entry per channel, each with the same small surface:
//
//   label(cfg)            what the card calls it ("Telegram", "Discord", ...)
//   ready(cfg)            true when it has what send() needs
//   send(alert, cfg)      -> { ok: true } | { ok: false, error }   (never throws)
//
// `alert` is { title, body, url, test }: "<Project> needs you", the kind
// ("Asked you a question"), the board link, and whether it is a test. It
// never carries the session's text. `cfg` is that channel's own block of
// ~/.ravenry/alerts.json. The trigger logic in server/alerts.mjs only knows
// this surface, so a future channel (a native Ravenry app) is one more entry
// here and nothing else.
//
// Errors are short sentences for the card's status line. They never contain
// a token, a webhook URL or a topic, and neither does anything logged.

const TIMEOUT_MS = 10000;
const env = process.env;

// Telegram's API root; tests point it at a local stub.
const telegramApi = () => (env.MC_TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, '');

export const DEFAULT_NTFY = 'https://ntfy.sh';

// A request that ends in at most TIMEOUT_MS and reports a failure without
// the URL (Telegram's carries the token).
async function call(url, init, who) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, text, json };
  } catch (e) {
    const code = (e && e.cause && e.cause.code) || (e && e.name === 'TimeoutError' ? 'no answer in 10 s' : (e && e.name) || 'error');
    return { status: 0, ok: false, error: `Could not reach ${who} (${code})` };
  }
}

const isLoopbackHost = (h) => h === '127.0.0.1' || h === 'localhost' || h === '[::1]';

// ------------------------------------------------------------ Telegram

const tgEscape = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function telegramTokenOk(t) {
  return /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(String(t || ''));
}

function tgError(r) {
  if (r.error) return r.error;
  const d = String((r.json && r.json.description) || '');
  if (r.status === 401 || r.status === 404) return 'Telegram said the token is wrong';
  if (r.status === 403) return 'Telegram said the bot is blocked. Unblock it in Telegram';
  if (/chat not found/i.test(d)) return 'Telegram could not find the chat. Message your bot, then Find my chat';
  if (r.status === 409) return 'Telegram says this bot has a webhook set, so it cannot list messages';
  if (r.status === 429) return 'Telegram said too many messages. It will take the next one';
  return `Telegram answered ${r.status}${d ? ': ' + d.slice(0, 80) : ''}`;
}

// The bot's own name, which also proves the token.
export async function telegramMe(token) {
  const r = await call(`${telegramApi()}/bot${token}/getMe`, { method: 'GET' }, 'Telegram');
  if (r.ok && r.json && r.json.ok) return { ok: true, username: r.json.result && r.json.result.username || null };
  return { ok: false, error: tgError(r) };
}

// The chat of the newest message anyone sent the bot. A private chat (the user
// messaging their own bot) wins over a group.
export async function telegramFindChat(token) {
  const r = await call(`${telegramApi()}/bot${token}/getUpdates?limit=100&allowed_updates=${encodeURIComponent('["message"]')}`, { method: 'GET' }, 'Telegram');
  if (!(r.ok && r.json && r.json.ok)) return { ok: false, error: tgError(r) };
  const chats = (r.json.result || []).map((u) => (u.message || u.edited_message || u.channel_post || {}).chat).filter((c) => c && c.id != null);
  const pick = chats.filter((c) => c.type === 'private').pop() || chats.pop();
  if (!pick) return { ok: false, error: 'No message yet. Send your bot any message in Telegram, then Find my chat' };
  return { ok: true, chatId: String(pick.id) };
}

const telegram = {
  label: () => 'Telegram',
  ready: (c) => !!(c && telegramTokenOk(c.token) && c.chatId),
  async send(alert, c) {
    const text = `<b>${tgEscape(alert.title)}</b>\n${tgEscape(alert.body)}`;
    const body = { chat_id: c.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (alert.url) body.reply_markup = { inline_keyboard: [[{ text: 'Open on the board', url: alert.url }]] };
    const post = (b) => call(`${telegramApi()}/bot${c.token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }, 'Telegram');
    let r = await post(body);
    // Telegram refuses some button links (a private address, say). Then the
    // link goes in the text instead, so the alert still lands.
    if (!r.ok && r.status === 400 && /BUTTON_URL_INVALID|button url/i.test(String(r.json && r.json.description))) {
      delete body.reply_markup;
      body.text = `${text}\n${tgEscape(alert.url)}`;
      r = await post(body);
    }
    return r.ok && r.json && r.json.ok ? { ok: true } : { ok: false, error: tgError(r) };
  },
};

// ------------------------------------------------------------ Discord or Slack

// Which service a webhook URL belongs to, from its host (and, for a test
// stub on this Mac, its path). null when it is neither.
export function webhookKind(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const loop = isLoopbackHost(host) || host === '::1';
  if (u.protocol !== 'https:' && !(loop && u.protocol === 'http:')) return null;
  if (u.username || u.password) return null;
  const discordPath = /^\/api(\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/.test(u.pathname);
  const slackPath = /^\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+\/?$/.test(u.pathname);
  if (/^((ptb|canary)\.)?discord(app)?\.com$/.test(host)) return discordPath ? 'discord' : null;
  if (host === 'hooks.slack.com') return slackPath ? 'slack' : null;
  if (loop) return discordPath ? 'discord' : slackPath ? 'slack' : null;
  return null;
}

export function maskWebhook(raw) {
  const k = webhookKind(raw);
  if (!k) return null;
  const u = new URL(raw);
  const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  return k === 'discord' ? `${host}/api/webhooks/••••••/••••••••` : `${host}/services/••••/••••/••••••••`;
}

const mdDiscord = (s) => String(s).replace(/([\\*_~`|>[\]#-])/g, '\\$1');
const mdSlack = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// The JSON each service expects.
export function webhookPayload(kind, alert) {
  if (kind === 'discord') {
    const lines = [`**${mdDiscord(alert.title)}**`, mdDiscord(alert.body)];
    if (alert.url) lines.push(`[Open on the board](<${alert.url}>)`);
    return { username: 'Ravenry', content: lines.join('\n'), allowed_mentions: { parse: [] } };
  }
  const lines = [`*${mdSlack(alert.title)}*`, mdSlack(alert.body)];
  if (alert.url) lines.push(`<${alert.url}|Open on the board>`);
  return { text: lines.join('\n') };
}

const webhook = {
  label: (c) => (webhookKind(c && c.url) === 'slack' ? 'Slack' : 'Discord'),
  ready: (c) => !!(c && webhookKind(c.url)),
  async send(alert, c) {
    const kind = webhookKind(c.url);
    const who = kind === 'slack' ? 'Slack' : 'Discord';
    const r = await call(c.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(webhookPayload(kind, alert)) }, who);
    if (r.ok) return { ok: true };
    if (r.error) return { ok: false, error: r.error };
    if (r.status === 401 || r.status === 403 || r.status === 404 || r.status === 410) return { ok: false, error: `${who} said the webhook is gone or wrong` };
    if (r.status === 429) return { ok: false, error: `${who} said too many messages. It will take the next one` };
    return { ok: false, error: `${who} answered ${r.status}` };
  },
};

// ------------------------------------------------------------ ntfy

export function ntfyServerOk(s) {
  try {
    const u = new URL(String(s || ''));
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && !u.search && !u.hash;
  } catch { return false; }
}

const ntfyBase = (c) => String((c && c.server) || DEFAULT_NTFY).replace(/\/+$/, '');
const ntfyHostPath = (c) => ntfyBase(c).replace(/^https?:\/\//, '');

export const topicOk = (t) => /^[-_A-Za-z0-9]{1,64}$/.test(String(t || ''));

// What the QR code holds: the ntfy app's own subscribe link. On Android it
// opens the ntfy app on the topic and subscribes to it (docs.ntfy.sh,
// "ntfy:// links"); `secure=false` only for a plain-http server.
export function ntfySubscribeLink(c) {
  const base = ntfyBase(c);
  const params = new URLSearchParams({ display: 'Ravenry' });
  if (base.startsWith('http://')) params.set('secure', 'false');
  return `ntfy://${ntfyHostPath(c)}/${c.topic}?${params}`;
}

export function maskTopic(c) {
  const t = String(c.topic || '');
  const m = /^(ravenry-)/.exec(t);
  return `${ntfyHostPath(c)}/${m ? m[1] : t.slice(0, 2)}••••••`;
}

const ntfy = {
  label: () => 'ntfy',
  ready: (c) => !!(c && topicOk(c.topic) && ntfyServerOk(ntfyBase(c))),
  async send(alert, c) {
    // Published as JSON to the server root, so a project name in any
    // language survives (headers would not carry it).
    const body = { topic: c.topic, title: alert.title, message: alert.body, priority: alert.test ? 3 : 4 };
    if (alert.url) body.click = alert.url;
    const r = await call(ntfyBase(c) + '/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'ntfy');
    if (r.ok) return { ok: true };
    if (r.error) return { ok: false, error: r.error };
    if (r.status === 429) return { ok: false, error: 'ntfy said too many messages. It will take the next one' };
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'ntfy refused the topic. Press New topic' };
    return { ok: false, error: `ntfy answered ${r.status}` };
  },
};

// The channels, by the id alerts.json stores. A native app channel later is
// one more line here.
export const CHANNELS = { telegram, webhook, ntfy };
