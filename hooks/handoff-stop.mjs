#!/usr/bin/env node
// Claude Code Stop hook: the clean context hand-off. See docs/HANDOFF.md.
//
// Runs at every stop of every session it is installed for, so the common
// path (context below the line, nothing asked for) reads only the tail of
// the transcript and exits 0 with no output. With handoffEnabled false the
// line is never reached, so only a manual request ("Hand off now") asks. Past the line, once per stop
// and never while stop_hook_active is set, it blocks the stop with a reason
// that asks Claude to hand off if (and only if) it is at a clean point.
//
// It never fails a stop: any error means exit 0, silently.

import * as h from '../server/handoff.mjs';
import { assistantOf, codexDaemon } from '../server/assistanthook.mjs';
import { lastUsage as codexUsage } from '../server/codexrollout.mjs';

// Claude Code's Stop hook, or Codex's (`--assistant=codex` in the command
// Codex's hooks.json names): Codex's Stop hook blocks a stop the same way,
// {"decision":"block","reason":...}, and Codex carries on with the reason
// as its next prompt (measured on 0.166.0, docs/ASSISTANTS.md).
const ASSISTANT = assistantOf();

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

function done(out) {
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}

const RANK = (s) => h.stateRank(s);
const atLeast = (prev, s) => (prev && RANK(prev) > RANK(s) ? prev : s);

async function main() {
  let input;
  try { input = JSON.parse(await readStdin()); } catch { return done(); }
  const sid = input && input.session_id;
  if (!h.markerPath(sid)) return done();

  const marker = h.readMarker(sid);
  // One hand-off per session: once written, this session is finished with.
  if (marker && (marker.state === 'written' || marker.state === 'resumed')) return done();

  const { settings, projects } = h.loadSettings();
  let window = Number(settings.contextWindow) || 1000000;
  // Hand-off off (the board's Settings card): no line asks on its own, so
  // the threshold and ceiling count as never reached. Hand off now still does.
  const enabled = settings.handoffEnabled !== false;
  const threshold = enabled ? Number(settings.handoffThreshold) || 50 : Infinity;
  const ceiling = enabled ? Number(settings.handoffCeiling) || 70 : Infinity;
  const u = input.transcript_path ? (ASSISTANT === 'codex' ? codexUsage(input.transcript_path) : h.lastUsage(input.transcript_path)) : null;
  // A Codex rollout records its model's own window.
  if (u && u.window) window = u.window;
  const tokens = u && u.tokens != null ? u.tokens : null;
  const pct = tokens != null ? (tokens / window) * 100 : null;
  const now = new Date().toISOString();

  // Asked earlier, and the hand-off is now on disk: record it, let it stop.
  if (marker && marker.state === 'requested' && h.handoffWritten(marker)) {
    h.writeMarker(sid, { state: 'written', writtenAt: now, writtenSeenBy: 'hook', pct, tokens });
    return done();
  }
  // Written while still queued (on its own, or asked by hand). The hash
  // check above cannot see it: the base below is taken afresh at every
  // queued stop, so the stop after the write swallows the change.
  if (marker && marker.state === 'queued' && h.writtenWhileQueued(marker, input.transcript_path || marker.transcriptPath)) {
    h.writeMarker(sid, { state: 'written', writtenAt: now, writtenSeenBy: 'hook', pct, tokens });
    return done();
  }

  const manual = !!(marker && marker.manualAt);
  if (!manual && (pct == null || pct < threshold)) return done();

  // Past the line, or the user asked. Everything below runs at most a few
  // times per session, so it can afford a git call.
  // Codex's daemon carries another terminal's variables (server/assistanthook.mjs).
  const envTab = !(ASSISTANT === 'codex' && await codexDaemon());
  const workspaceId = (marker && marker.workspaceId) || (envTab && process.env.CMUX_WORKSPACE_ID) || null;
  const surfaceId = (marker && marker.surfaceId) || (envTab && process.env.CMUX_SURFACE_ID) || null;
  const cwd = input.cwd || (marker && marker.cwd) || process.cwd();
  // Resolved afresh at every stop, never read back from the marker: the
  // registry can gain a brief after the first stop past the line, and the
  // marker's projectId (from an earlier stop) is only a hint for which
  // project this session belongs to.
  const target = h.resolveHandoffFile({ cwd, workspaceId, surfaceId, transcriptPath: input.transcript_path, projectId: (marker && marker.projectId) || null, projects, root: process.env.MC_PROJECTS_ROOT || settings.projectsRoot || null });
  const common = {
    cwd, transcriptPath: input.transcript_path || null, workspaceId, surfaceId,
    ...(ASSISTANT !== 'claude' ? { assistant: ASSISTANT } : {}),
    // The file and its section's hash, together: any change after this is the hand-off.
    ...h.targetFields(target),
    pct, tokens, window, threshold, ceiling, lastStopAt: now,
  };
  if (!marker || !marker.queuedAt) common.queuedAt = now;

  const queue = (why) => {
    h.writeMarker(sid, { ...common, state: atLeast(marker && marker.state, 'queued'), lastCheck: { at: now, clean: false, why } });
    return done();
  };

  // Never loop: Claude is already answering a block from a stop hook.
  if (input.stop_hook_active) return queue('Claude was already continuing for a stop hook');

  // Clean-point checks the hook can see for itself.
  const tasks = h.runningTasks(input);
  if (tasks.length) return queue(`${tasks.length} background task${tasks.length > 1 ? 's' : ''} running`);
  const crons = Array.isArray(input.session_crons) ? input.session_crons : [];
  if (crons.length) return queue(`${crons.length} scheduled loop${crons.length > 1 ? 's' : ''} set in this session`);
  const last = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : (u && u.lastText);
  if (last && !last.startsWith(h.DEFERRED) && h.endsOnQuestion(last)) return queue('waiting on your answer to a question');

  const reason = h.reasonText({
    pct, tokens, window, threshold, ceiling, manual,
    file: target.file, autoStart: settings.handoffAutoStart !== false,
    ...(ASSISTANT === 'codex' ? { name: 'Codex', short: 'Codex' } : {}),
  });
  h.writeMarker(sid, {
    ...common, state: 'requested',
    requestedAt: (marker && marker.requestedAt) || now,
    asks: ((marker && marker.asks) || 0) + 1, lastAskAt: now,
    over: pct != null && pct >= ceiling,
    lastCheck: { at: now, clean: true, why: 'no background tasks, not waiting on you' },
  });
  return done({ decision: 'block', reason });
}

main().catch(() => done());
