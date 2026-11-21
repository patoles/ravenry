// ravenry-opencode-plugin: installed by Ravenry. Remove it in Ravenry
// (Settings, Hooks), or with `ravenry uninstall`.
//
// Ravenry's plugin for OpenCode (docs/ASSISTANTS.md, "OpenCode"). OpenCode
// loads it from its plugins folder; inside a Ravenry pane (RAVENRY_PANE and
// RAVENRY_SOCKET set) it reports each session's state to the pane's daemon
// with `ravenryd hook --assistant opencode --state ...`, the way Claude
// Code's and Codex's hooks do; anywhere else it does nothing.
//
//   a session seen first        SessionStart, idle
//   a turn going on             working (session.status busy)
//   a permission asked          needs_you, permission; then it waits for
//                               the board's answer (PermissionWait, decided
//                               by the hub) and replies through OpenCode's
//                               own API, never with keystrokes
//   a permission replied        working again
//   the turn's end              Stop, idle; the hub may answer it with the
//                               hand-off's reason, sent as the next prompt
//   a session deleted           ended
//
// What the board reads of a session (its model, context, last message,
// prompts) goes to one small JSON file per session, named in every report
// as transcript_path: <XDG_STATE_HOME or ~/.local/state>/ravenry/opencode/
// <session id>.json. Nothing else is written. Every call is bounded and
// never throws into OpenCode.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RAVENRYD = '__RAVENRYD__';
const ID = 'opencode';
const REPLIES = new Set(['once', 'always', 'reject']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const oneLine = (s, n = 300) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 3) + '...' : t;
};

export const RavenryPlugin = async ({ client, directory }) => {
  const env = process.env;
  if (!env.RAVENRY_PANE || !env.RAVENRY_SOCKET) return {};
  const bin = fs.existsSync(RAVENRYD) ? RAVENRYD : 'ravenryd';
  const dir = path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'ravenry', ID);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* reports go on without the file */ }

  // One `ravenryd hook` run: { code, stdout, ms }.
  const hook = (args, input, waitMs = 4000) => new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    let done = false;
    const end = (code) => { if (!done) { done = true; resolve({ code, stdout: out, ms: Date.now() - t0 }); } };
    let p;
    try { p = spawn(bin, ['hook', '--assistant', ID, ...args], { stdio: ['pipe', 'pipe', 'ignore'] }); } catch { return end(-1); }
    const kill = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } end(-1); }, waitMs + 5000);
    p.on('error', () => { clearTimeout(kill); end(-1); });
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => { clearTimeout(kill); end(code); });
    try { p.stdin.end(JSON.stringify(input)); } catch { /* closed */ }
  });
  // Reports go out in order; a wait for the board never holds them.
  let chain = Promise.resolve();
  const report = (args, input, waitMs) => {
    const go = chain.then(() => hook(args, input, waitMs)).catch(() => ({ code: -1, stdout: '' }));
    chain = go.then(() => null);
    return go;
  };

  const sessions = new Map();
  const children = new Set();
  const roles = new Map();
  const windows = new Map();

  const fileOf = (id) => path.join(dir, `${String(id).replace(/[^\w-]/g, '_')}.json`);
  const write = (s) => {
    const v = {
      v: 1, assistant: ID, sessionId: s.id, cwd: s.cwd, model: s.model, modelName: s.modelName,
      contextTokens: s.tokens, contextWindow: s.window,
      lastText: s.lastText, lastTextAt: s.lastTextAt,
      lastPrompt: s.lastPrompt, lastPromptAt: s.lastPromptAt, lastPersonPromptAt: s.lastPersonPromptAt,
      firstPrompt: s.firstPrompt, lastTurnEndAt: s.lastTurnEndAt, lastActivityAt: s.lastActivityAt,
      lastTool: s.lastTool, lastToolAt: s.lastToolAt, title: s.title, inTurn: s.busy,
      // The board's last answer to a permission, and the API route it went by.
      lastAnswer: s.lastAnswer || null,
      turns: s.turns.slice(-12), updatedAt: now(),
    };
    try {
      const f = fileOf(s.id);
      fs.writeFileSync(`${f}.tmp`, JSON.stringify(v) + '\n');
      fs.renameSync(`${f}.tmp`, f);
    } catch { /* the board reads what it can */ }
  };
  const base = (s, event) => ({ hook_event_name: event, session_id: s.id, cwd: s.cwd, transcript_path: fileOf(s.id), ...(s.model ? { model: s.model } : {}) });

  // The model's context window, from OpenCode's own provider list.
  async function windowOf(providerID, modelID) {
    const k = `${providerID}/${modelID}`;
    if (windows.has(k)) return windows.get(k);
    windows.set(k, null);
    try {
      const r = await client.config.providers();
      const ps = (r && (r.data || r).providers) || [];
      const p = ps.find((x) => x.id === providerID);
      const m = p && p.models && p.models[modelID];
      windows.set(k, { window: (m && m.limit && m.limit.context) || null, name: (m && m.name) || null });
    } catch { /* unknown */ }
    return windows.get(k);
  }
  async function setModel(s, providerID, modelID) {
    if (!providerID || !modelID) return;
    s.model = `${providerID}/${modelID}`;
    const w = await windowOf(providerID, modelID);
    if (w) { s.window = w.window || s.window; s.modelName = w.name || s.modelName; }
    s.providerID = providerID; s.modelID = modelID;
  }

  // A session of this TUI (never a subagent's): reported once as started.
  function ensure(id, cwd) {
    if (!id || children.has(id)) return null;
    let s = sessions.get(id);
    if (!s) {
      s = { id, cwd: cwd || directory, busy: false, texts: new Map(), turns: [], tokens: null, window: null, model: null, modelName: null, lastText: null, lastTextAt: null, lastPrompt: null, lastPromptAt: null, lastPersonPromptAt: null, firstPrompt: null, lastTurnEndAt: null, lastActivityAt: null, lastTool: null, lastToolAt: null, title: null, perms: [], waiting: false, stopHookActive: false, hookPrompts: new Set() };
      sessions.set(id, s);
      write(s);
      report(['--state', 'idle', '--event', 'SessionStart'], { ...base(s, 'SessionStart'), source: 'startup' });
    }
    if (cwd) s.cwd = cwd;
    return s;
  }

  // The board's answers to a session's permissions, one at a time, the
  // oldest first (OpenCode shows them in the order they were asked; two
  // tool calls at once ask two): each asked of the hub until it gives one,
  // the person answers in OpenCode itself, or the session moves on.
  async function waitForBoard(s) {
    if (s.waiting) return;
    s.waiting = true;
    try {
      while (s.perms.length) {
        const head = s.perms[0];
        const r = await hook(['--event', 'PermissionWait', '--decide', '--timeout', '25s'], { ...base(s, 'PermissionWait') }, 25000);
        if (s.perms[0] !== head) continue;
        const ans = String(r.stdout || '').trim();
        if (REPLIES.has(ans)) {
          await replyTo(s, head.id, ans);
          // Its permission.replied takes it off the list.
          for (let i = 0; i < 50 && s.perms[0] === head; i++) await sleep(100);
          if (s.perms[0] === head) s.perms.shift();
          continue;
        }
        // No hub, or none that waits: ask again in a while, not in a loop.
        if (r.ms < 1500) await sleep(3000);
      }
    } finally { s.waiting = false; }
  }
  const askBoard = (s, head) => report(['--state', 'needs_you', '--need', 'permission', '--event', 'Notification'], { ...base(s, 'Notification'), notification_type: 'permission_prompt', message: head.what, title: head.title });
  async function replyTo(s, perm, reply) {
    // OpenCode's permission.reply (POST /permission/<id>/reply); an older
    // server's per-session route when that one is missing.
    try {
      const raw = client.client || client._client;
      if (raw && typeof raw.post === 'function') {
        const r = await raw.post({ url: '/permission/{requestID}/reply', path: { requestID: perm }, body: { reply }, headers: { 'Content-Type': 'application/json' } });
        if (r && !r.error && r.response && r.response.ok) { s.lastAnswer = { route: 'permission.reply', reply, at: now() }; write(s); return true; }
      }
    } catch { /* try the other route */ }
    try {
      const r = await client.postSessionIdPermissionsPermissionId({ path: { id: s.id, permissionID: perm }, body: { response: reply } });
      if (r && !r.error) { s.lastAnswer = { route: 'permission.respond', reply, at: now() }; write(s); return true; }
      return false;
    } catch { return false; }
  }

  // The turn's end: the hub may hold it for the hand-off, whose reason
  // becomes the next prompt, as a Stop hook's block does elsewhere.
  async function stopped(s) {
    s.busy = false;
    s.lastTurnEndAt = now();
    const text = s.turnText;
    if (text) s.turns.push({ at: s.lastTurnEndAt, text });
    s.turnText = null;
    write(s);
    const active = s.stopHookActive;
    s.stopHookActive = false;
    const r = await report(['--state', 'idle', '--event', 'Stop', '--decide', '--timeout', '8s'], { ...base(s, 'Stop'), stop_hook_active: active, last_assistant_message: s.lastText || '' }, 8000);
    let out = null;
    try { out = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch { out = null; }
    if (out && out.decision === 'block' && typeof out.reason === 'string' && out.reason) {
      s.stopHookActive = true;
      s.hookPrompts.add(out.reason.trim());
      try {
        await client.session.promptAsync({ path: { id: s.id }, body: { ...(s.providerID ? { model: { providerID: s.providerID, modelID: s.modelID } } : {}), parts: [{ type: 'text', text: out.reason }] } });
      } catch { s.stopHookActive = false; }
    }
  }

  // Started on a session (`opencode --session <id>`): it is this pane's at
  // once. The plugin runs in a worker of the interface's process, whose own
  // argv is not the command's, so the command is read from the process list.
  try {
    const ps = spawn('/bin/ps', ['-o', 'command=', '-p', String(process.pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
    let cmd = '';
    ps.stdout.on('data', (d) => { cmd += d; });
    ps.on('close', () => {
      const m = /\s(?:--session|-s)(?:=|\s+)(ses_[A-Za-z0-9]{8,64})\b/.exec(cmd);
      if (m) ensure(m[1], directory);
    });
    ps.on('error', () => {});
  } catch { /* not resumed, or no ps */ }

  const on = async (event) => {
    const p = (event && event.properties) || {};
    switch (event && event.type) {
      case 'session.created':
      case 'session.updated': {
        const info = p.info || {};
        if (info.parentID) { children.add(info.id); return; }
        const s = ensure(info.id, info.directory);
        if (s && info.title && !/^New session - /.test(info.title)) s.title = info.title;
        return;
      }
      case 'session.deleted': {
        const info = p.info || {};
        const s = sessions.get(info.id);
        if (s) { report(['--state', 'ended', '--event', 'SessionEnd'], { ...base(s, 'SessionEnd'), reason: 'deleted' }); sessions.delete(info.id); }
        return;
      }
      case 'message.updated': {
        const info = p.info || {};
        if (children.has(info.sessionID)) return;
        const s = ensure(info.sessionID);
        if (!s) return;
        roles.set(info.id, info.role);
        if (info.role === 'user' && info.model) await setModel(s, info.model.providerID, info.model.modelID);
        if (info.role === 'assistant') {
          if (info.providerID && info.modelID) await setModel(s, info.providerID, info.modelID);
          const t = info.tokens;
          if (t && (info.finish || (info.time && info.time.completed))) {
            const sum = (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + ((t.cache && t.cache.read) || 0) + ((t.cache && t.cache.write) || 0);
            const total = t.total != null ? t.total : sum;
            if (total > 0) s.tokens = total;
          }
          s.lastActivityAt = now();
        }
        return;
      }
      case 'message.part.updated': {
        const part = p.part || {};
        const s = sessions.get(part.sessionID);
        if (!s) return;
        const role = roles.get(part.messageID);
        s.lastActivityAt = now();
        if (part.type === 'text' && typeof part.text === 'string' && !part.synthetic) {
          const t = part.text.trim();
          if (!t) return;
          if (role === 'assistant') { s.lastText = t; s.lastTextAt = now(); s.turnText = t; }
          else if (role === 'user' && s.lastUserPart !== part.id) {
            s.lastUserPart = part.id;
            s.lastPrompt = t; s.lastPromptAt = now();
            if (!s.firstPrompt) s.firstPrompt = t;
            if (s.hookPrompts.has(t)) s.hookPrompts.delete(t);
            else s.lastPersonPromptAt = s.lastPromptAt;
          }
        } else if (part.type === 'tool' && part.tool) {
          const input = (part.state && part.state.input) || {};
          s.lastTool = { name: part.tool, what: oneLine(input.command || input.filePath || input.path || input.pattern || '', 200) || null };
          s.lastToolAt = now();
        }
        return;
      }
      case 'session.status': {
        const s = sessions.get(p.sessionID);
        if (!s) return;
        if (p.status && p.status.type === 'busy' && !s.busy && !s.perms.length) {
          s.busy = true;
          s.lastActivityAt = now();
          write(s);
          report(['--state', 'working', '--event', 'UserPromptSubmit'], base(s, 'UserPromptSubmit'));
        }
        return;
      }
      case 'session.idle': {
        const s = sessions.get(p.sessionID);
        if (!s) return;
        s.perms = [];
        // Not awaited: the hub may take a few seconds to say whether to hand off.
        stopped(s).catch(() => {});
        return;
      }
      case 'permission.asked': {
        const s = sessions.get(p.sessionID);
        if (!s) return;
        const md = p.metadata || {};
        const what = p.permission === 'bash' && md.command ? `Run ${md.command}`
          : `${p.permission || 'A tool'}${Array.isArray(p.patterns) && p.patterns.length ? ': ' + p.patterns.join(' ') : ''}`;
        if (s.perms.some((x) => x.id === p.id)) return;
        s.perms.push({ id: p.id, what: oneLine(what), title: oneLine(p.permission || '', 100) });
        write(s);
        if (s.perms.length === 1) askBoard(s, s.perms[0]);
        waitForBoard(s).catch(() => {});
        return;
      }
      case 'permission.replied': {
        const s = sessions.get(p.sessionID);
        if (!s) return;
        const id = p.requestID || p.permissionID;
        const was = s.perms[0];
        s.perms = s.perms.filter((x) => x.id !== id);
        const reply = p.reply || p.response;
        // The next one asked is on screen now: Needs you again, for it.
        if (s.perms.length) { if (s.perms[0] !== was) askBoard(s, s.perms[0]); return; }
        // Refused: the turn ends (session.idle follows); else it goes on.
        if (reply !== 'reject') { s.busy = true; report(['--state', 'working', '--event', 'PermissionReplied'], base(s, 'PermissionReplied')); }
        return;
      }
      case 'question.asked': {
        const s = sessions.get(p.sessionID);
        if (!s) return;
        const q = Array.isArray(p.questions) && p.questions[0] ? p.questions[0].question : p.question;
        report(['--state', 'needs_you', '--need', 'question', '--event', 'Notification'], { ...base(s, 'Notification'), notification_type: 'agent_needs_input', message: oneLine(q || 'OpenCode asks a question') });
        return;
      }
      default:
    }
  };

  return {
    event: async ({ event }) => { try { await on(event); } catch { /* never into OpenCode */ } },
  };
};
