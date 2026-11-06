// The clean context hand-off's decision at a Stop (docs/HANDOFF.md): what
// hooks/handoff-stop.mjs answers Claude Code or Codex, and what the hub
// answers through a ravenryd pane's daemon when `ravenryd hook` asks
// (server/ravenryd.mjs). Returns the hook's output object
// ({ decision: 'block', reason }) or null to let the stop happen.
//
// Runs at every stop of every session it is installed for, so the common
// path (context below the line, nothing asked for) reads only the tail of
// the transcript. With handoffEnabled false the line is never reached, so
// only a manual request ("Hand off now") asks. Past the line, once per stop
// and never while stop_hook_active is set, it blocks the stop with a reason
// that asks the assistant to hand off if (and only if) it is at a clean
// point. When it defers, it does not ask again until the user types a new
// prompt, presses Hand off now, the context crosses the ceiling, or 10
// minutes pass (h.deferralHold).

import * as h from './handoff.mjs';
import { lastUsage as codexUsage } from './codexrollout.mjs';

const RANK = (s) => h.stateRank(s);
const atLeast = (prev, s) => (prev && RANK(prev) > RANK(s) ? prev : s);

export async function decideStop(input, { assistant = 'claude', tab = null, env = process.env, codexDaemon = async () => false } = {}) {
  const ASSISTANT = assistant;
  const done = (out) => out || null;
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
  // The tab the session runs in: given (a ravenryd pane), else from the
  // hook's environment, except under Codex's daemon, which carries another
  // terminal's variables (server/assistanthook.mjs).
  const envTab = !tab && !(ASSISTANT === 'codex' && await codexDaemon());
  const workspaceId = (marker && marker.workspaceId) || (tab && tab.workspaceId) || (envTab && env.CMUX_WORKSPACE_ID) || null;
  const surfaceId = (marker && marker.surfaceId) || (tab && tab.surfaceId) || (envTab && env.CMUX_SURFACE_ID) || null;
  const cwd = input.cwd || (marker && marker.cwd) || process.cwd();
  // Resolved afresh at every stop, never read back from the marker: the
  // registry can gain a brief after the first stop past the line, and the
  // marker's projectId (from an earlier stop) is only a hint for which
  // project this session belongs to.
  const target = h.resolveHandoffFile({ cwd, workspaceId, surfaceId, transcriptPath: input.transcript_path, projectId: (marker && marker.projectId) || null, projects, root: env.MC_PROJECTS_ROOT || settings.projectsRoot || null });
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

  // A deferral: the first stop after an ask that did not bring the hand-off
  // (written is caught above). Either Claude answered with the DEFERRED
  // line, or it carried on and stopped again without a hand-off (the stop
  // that answers a block comes with stop_hook_active; past the ceiling the
  // words offer no DEFERRED line, so this is how a ceiling ask is deferred).
  // Recorded once per ask, so a later stop that still shows the DEFERRED
  // line never pushes the cooldown on.
  const over = pct != null && pct >= ceiling;
  const last = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : (u && u.lastText);
  const askAt = marker && Date.parse(marker.lastAskAt);
  const deferAt = marker && Date.parse(marker.deferredAt);
  const unanswered = !!askAt && !isNaN(askAt) && (!deferAt || isNaN(deferAt) || askAt > deferAt);
  if (unanswered && ((last && last.trim().startsWith(h.DEFERRED)) || input.stop_hook_active)) {
    Object.assign(common, { deferredAt: now, deferredOver: over, deferrals: ((marker && marker.deferrals) || 0) + 1 });
  }

  // After a deferral, ask again only once something changed: a prompt the
  // user typed since (Claude Code: from the transcript's tail; Codex: from
  // the rollout, where a hook's reason is a <hook_prompt>), Hand off now
  // pressed since, the ceiling crossed since, or 10 minutes gone by.
  const held = { ...(marker || {}), ...common };
  let hold = h.deferralHold(held, { over });
  if (hold) {
    const promptAt = ASSISTANT === 'codex'
      ? (u && u.lastPromptAt && !h.hasTag(u.lastPrompt) ? u.lastPromptAt : null)
      : (input.transcript_path ? h.lastPromptAt(input.transcript_path, held.deferredAt) : null);
    hold = h.deferralHold(held, { over, promptAt });
  }

  // Never loop: Claude is already answering a block from a stop hook.
  if (input.stop_hook_active) return queue(hold || `${ASSISTANT === 'codex' ? 'Codex' : 'Claude'} was already continuing for a stop hook`);
  if (hold) return queue(hold);

  // Clean-point checks the hook can see for itself. A question to the user
  // does not hold the hand-off back: the hand-off carries it in its open items.
  const tasks = h.runningTasks(input);
  if (tasks.length) return queue(`${tasks.length} background task${tasks.length > 1 ? 's' : ''} running`);
  const crons = Array.isArray(input.session_crons) ? input.session_crons : [];
  if (crons.length) return queue(`${crons.length} scheduled loop${crons.length > 1 ? 's' : ''} set in this session`);

  const reason = h.reasonText({
    pct, tokens, window, threshold, ceiling, manual,
    file: target.file, autoStart: settings.handoffAutoStart !== false,
    ...(ASSISTANT === 'codex' ? { name: 'Codex', short: 'Codex' } : {}),
  });
  h.writeMarker(sid, {
    ...common, state: 'requested',
    requestedAt: (marker && marker.requestedAt) || now,
    asks: ((marker && marker.asks) || 0) + 1, lastAskAt: now,
    over,
    lastCheck: { at: now, clean: true, why: 'no background tasks running' },
  });
  return done({ decision: 'block', reason });
}

