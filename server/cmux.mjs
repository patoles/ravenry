// The cmux adapter. This is the ONLY module that runs the cmux CLI.
//
// Reads (tree, sessions, sidebar state, screens, resume bindings) are safe to
// call on any workspace. Writes (send text, press Enter, select a workspace)
// go through the guarded functions at the bottom, which the server calls only
// after its own checks (see server/index.mjs, sendMessage).

import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';

export const DEFAULT_CMUX_BIN = '/Applications/cmux.app/Contents/Resources/bin/cmux';
export const CMUX_BIN = process.env.CMUX_BIN || DEFAULT_CMUX_BIN;
const ENV = { ...process.env, CMUX_QUIET: '1' };

function run(args, { timeout = 6000, env = ENV } = {}) {
  return new Promise((resolve) => {
    execFile(CMUX_BIN, args, { env, timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, out: stdout || '', err: (stderr || err.message || '').trim() });
      else resolve({ ok: true, out: stdout, err: (stderr || '').trim() });
    });
  });
}

async function runJson(args) {
  const r = await run(args);
  if (!r.ok) throw new Error(`cmux ${args.join(' ')}: ${r.err}`);
  return JSON.parse(r.out);
}

// A small pool so one tick does not spawn 50 processes at once.
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------- reads

// Every window, workspace, pane and surface, flattened. UUIDs are the stable
// ids; refs (workspace:2, surface:9) can change when things are reordered.
export async function listWorkspaces() {
  const t = await runJson(['--json', 'tree', '--all', '--id-format', 'both']);
  const out = [];
  for (const win of t.windows || []) {
    for (const ws of win.workspaces || []) {
      const surfaces = [];
      for (const p of ws.panes || []) {
        for (const s of p.surfaces || []) {
          surfaces.push({
            id: s.id, ref: s.ref, title: s.title || '', type: s.type,
            paneId: p.id, selected: !!s.selected_in_pane || !!s.selected, focused: !!s.focused, tty: s.tty || null,
          });
        }
      }
      out.push({ id: ws.id, ref: ws.ref, title: ws.title || '', windowId: win.id, selected: !!ws.selected, surfaces });
    }
  }
  return out;
}

// Claude Code hook records cmux keeps per surface: session id, lifecycle.
export async function listHookSessions() {
  try {
    const j = await runJson(['sessions', '--json', '--all']);
    return (j.sessions || []).map((s) => ({
      agent: s.agent, sessionId: s.session_id, surfaceId: s.surface_id || null, workspaceId: s.workspace_id || null,
      lifecycle: s.agent_lifecycle || 'unknown', active: !!s.active_for_surface, cwd: s.cwd || null,
      transcriptPath: s.transcript_path || null, updatedAt: s.updated_at || null, pid: s.pid || null, pidAlive: !!s.stored_pid_exists,
    }));
  } catch {
    return [];
  }
}

// Sidebar metadata for one workspace: cwd, branch, status lines.
export async function sidebarState(workspaceId) {
  const r = await run(['sidebar-state', '--workspace', workspaceId]);
  if (!r.ok) return null;
  const txt = r.out;
  const get = (k) => { const m = txt.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : null; };
  const statuses = {};
  for (const m of txt.matchAll(/^\s+([\w.-]+)=(.*?)(?:\s+icon=\S+)?(?:\s+color=\S+)?\s*$/gm)) statuses[m[1]] = m[2].trim();
  const branch = get('git_branch');
  return {
    cwd: get('cwd'), focusedCwd: get('focused_cwd'),
    branch: branch && branch !== 'none' ? branch.replace(/\s+dirty$/, '') : null,
    dirty: !!(branch && /\sdirty$/.test(branch)),
    claudeStatus: statuses.claude_code || null,
  };
}

// The last `lines` lines of a terminal surface, as plain text.
export async function readScreen(workspaceId, surfaceId, lines = 40) {
  const r = await run(['read-screen', '--workspace', workspaceId, '--surface', surfaceId, '--lines', String(lines)], { timeout: 4000 });
  if (!r.ok) return null;
  return r.out;
}

// How cmux would resume this surface: for Claude it names the session id.
export async function resumeBinding(workspaceId, surfaceId) {
  const r = await run(['surface', 'resume', 'show', '--json', '--workspace', workspaceId, '--surface', surfaceId]);
  if (!r.ok) return null;
  try {
    const b = JSON.parse(r.out).resume_binding;
    if (!b) return null;
    return { kind: b.kind || null, sessionId: b.checkpoint_id || null, cwd: b.cwd || null, source: b.source || null, updatedAt: b.updated_at || null };
  } catch {
    return null;
  }
}

// Newline-delimited JSON events. Used only as a hint to refresh sooner.
export function watchEvents(onEvent) {
  let child = null;
  let stopped = false;
  const start = () => {
    if (stopped) return;
    child = spawn(CMUX_BIN, ['events', '--reconnect', '--no-heartbeat', '--no-ack'], { env: ENV, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k); buf = buf.slice(k + 1);
        try { onEvent(JSON.parse(line)); } catch { /* ignore */ }
      }
    });
    child.on('exit', () => { child = null; if (!stopped) setTimeout(start, 5000); });
    child.on('error', () => {});
  };
  start();
  return () => { stopped = true; if (child) child.kill(); };
}

// ---------------------------------------------------------------- writes
// Callers must have checked the target (see index.mjs). Nothing here decides.

// Types text into a surface through the paste path so newlines and
// backslashes arrive as written (plain `cmux send` turns "\n" into Enter).
export async function pasteText(workspaceId, surfaceId, text) {
  const name = 'mc-' + Math.random().toString(36).slice(2, 10);
  const a = await run(['set-buffer', '--name', name, '--', text]);
  if (!a.ok) return a;
  return run(['paste-buffer', '--name', name, '--workspace', workspaceId, '--surface', surfaceId]);
}

// One named key: enter, up, down (server/choose.mjs moves a menu's
// selection with the arrows, since some menus ignore digit keys).
export async function pressKey(workspaceId, surfaceId, key) {
  return run(['send-key', '--workspace', workspaceId, '--surface', surfaceId, '--', key]);
}

// "Open in cmux": switch cmux to the workspace, then focus the surface.
export async function focusSurface(workspaceId, surfaceId) {
  const a = await run(['select-workspace', '--workspace', workspaceId]);
  if (!a.ok) return a;
  if (!surfaceId) return a;
  return run(['focus-panel', '--panel', surfaceId, '--workspace', workspaceId]);
}

// The hand-off's fresh session: a NEW terminal tab in the workspace (next to
// the old tab when its pane is known). It is not focused, and the old tab is
// never touched. Returns { ok, surfaceId, surfaceRef } or { ok: false, err }.
export async function newTerminalSurface({ workspaceId, paneId, cwd }) {
  const args = ['--json', '--id-format', 'both', 'new-surface', '--type', 'terminal', '--workspace', workspaceId, '--focus', 'false'];
  if (paneId) args.push('--pane', paneId);
  if (cwd) args.push('--working-directory', cwd);
  const r = await run(args);
  if (!r.ok) return r;
  try {
    const j = JSON.parse(r.out);
    if (!j.surface_id && !j.surface_ref) return { ok: false, err: 'cmux did not name the new tab' };
    return { ok: true, surfaceId: j.surface_id || j.surface_ref, surfaceRef: j.surface_ref || null };
  } catch {
    return { ok: false, err: 'cmux answered: ' + r.out.trim().slice(0, 200) };
  }
}

// A NEW workspace (New project, Revive without a workspace, and the tests).
// cmux answers "OK workspace:N"; the caller resolves the ref to its UUID.
export async function newWorkspace({ name, cwd, command, focus = false }) {
  const args = ['new-workspace', '--name', name, '--focus', focus ? 'true' : 'false'];
  if (cwd) args.push('--cwd', cwd);
  if (command) args.push('--command', command);
  return run(args);
}

// The workspace cmux shows now (Reopen's fallback when the closed
// session's own workspace is gone). Returns { id, ref } or null.
export async function currentWorkspace() {
  const r = await run(['--json', '--id-format', 'both', 'current-workspace']);
  if (!r.ok) return null;
  try {
    const w = JSON.parse(r.out).workspace;
    return w && w.id ? { id: w.id, ref: w.ref || null } : null;
  } catch {
    return null;
  }
}

// Close idle sessions: closes ONE terminal tab, which ends the Claude in it
// and keeps its transcript. Both ids are required and passed explicitly,
// and cmux's own CMUX_* variables are left out of its environment: without
// --surface, cmux closes $CMUX_SURFACE_ID or the focused tab, and this board
// itself runs in a cmux terminal. The caller re-checks the session first
// (server/index.mjs, closeOne).
export async function closeSurface(workspaceId, surfaceId) {
  const ok = (x) => typeof x === 'string' && /^[0-9A-Fa-f-]{36}$/.test(x);
  if (!ok(workspaceId) || !ok(surfaceId)) return { ok: false, out: '', err: 'no tab named, nothing closed' };
  return run(['close-surface', '--workspace', workspaceId, '--surface', surfaceId], { env: envWithoutTab() });
}

// cmux's environment minus the variables that name the caller's own tab
// (the board's terminal), so a command acts on the ids passed and nothing else.
function envWithoutTab() {
  return Object.fromEntries(Object.entries(ENV).filter(([k]) => !/^CMUX_(WORKSPACE|SURFACE|PANEL|PANE|TAB|WINDOW)_(ID|REF)$/.test(k)));
}

export async function closeWorkspace(workspaceId) {
  return run(['close-workspace', '--workspace', workspaceId]);
}

// A Mac notification from cmux, tied to a workspace (and the session's tab
// when known) so clicking it opens that workspace (server/desktop.mjs). It
// types nothing into any tab.
// The board itself runs in a cmux terminal, whose CMUX_WORKSPACE_ID and
// CMUX_SURFACE_ID name the board's own tab, and cmux files a notification
// under the caller's surface from those over --workspace: the one real send
// (2026-11-03) landed on the calling tab's workspace, not the one named. So
// they are left out of this call's environment, and the session's surface
// UUID (which cmux resolves globally) is passed when there is one.
const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
export async function notify({ title, body, workspaceId, surfaceId = null }) {
  const args = ['notify', '--title', String(title), '--body', String(body), '--workspace', workspaceId];
  if (surfaceId && UUID.test(surfaceId)) args.push('--surface', surfaceId);
  return run(args, { timeout: 10000, env: envWithoutTab() });
}
