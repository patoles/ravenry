// Turns raw signals (screen, title, transcript, cmux hook record, sidebar)
// into one honest state per session and per project. The rules are written
// up in docs/STATE-RULES.md; keep the two in step.

const H = 3600 * 1000;

export function plain(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function paragraphs(text) {
  return String(text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

function sentences(text) {
  return plain(text).replace(/\n+/g, ' ').match(/[^.!?]+(?:[.!?]+|$)/g)?.map((s) => s.trim()).filter(Boolean) || [];
}

// The question Claude ended on, if its last paragraph asks one.
export function endingQuestion(text) {
  const ps = paragraphs(text);
  if (!ps.length) return null;
  const last = ps[ps.length - 1];
  if (!/\?/.test(last)) return null;
  const qs = sentences(last).filter((s) => s.endsWith('?'));
  return qs.length ? qs[qs.length - 1] : null;
}

function isYesNo(q) {
  return /^(should|shall|do you want|want me|can i|could i|may i|is it ok|ok to|ready|go ahead|would you like|happy for me|all good|good to)/i.test(q.trim());
}

function age(now, iso) {
  return iso ? now - Date.parse(iso) : Infinity;
}

// One session = one Claude Code surface (or the remains of one).
// The reason line for a prompt that shows Claude's suggested reply.
function suggestionReason(sc) {
  const how = sc.prompt && sc.prompt.by === 'style' ? 'its text is dim'
    : sc.prompt && sc.prompt.kind === 'suggestion' ? 'it appeared as the turn ended'
      : 'not known to be typed';
  return `the prompt shows Claude's suggested reply (${how})`;
}

// `who` names the session's assistant in the reasons ("no Codex on screen").
export function sessionState({ screen, title, transcript: t, hook, who = 'Claude' }, settings, now) {
  const reasons = [];
  if (!screen.readable) reasons.push('screen unreadable');
  if (!screen.claudeLive) {
    if (!screen.readable && title.claude) {
      if (title.busy) return { state: 'working', since: null, reasons: [...reasons, 'title shows a spinner'] };
      return { state: 'unknown', since: t && t.lastTurnEndAt, reasons: [...reasons, `title says ${who}, screen not readable`] };
    }
    return { state: 'none', since: t && (t.lastTurnEndAt || t.lastTextAt), reasons: [...reasons, screen.exited ? `${who} exited, shell prompt below it` : `no ${who} on screen`] };
  }
  if (screen.dialog) return { state: 'dialog', since: (t && t.lastActivityAt) || null, reasons: ['a question or permission dialog is open'] };

  const tWorking = t && t.inTurn && age(now, t.lastActivityAt) < settings.workingMinutes * 60000;
  if (screen.working || screen.agentsRunning > 0 || title.busy || tWorking) {
    if (screen.working) reasons.push(screen.busyLine ? `spinner: ${screen.busyLine}` : 'footer offers esc to interrupt');
    if (screen.agentsRunning) reasons.push(`${screen.agentsRunning} background agent running`);
    if (title.busy) reasons.push('title shows a spinner');
    if (tWorking) reasons.push('transcript is mid-turn and fresh');
    return { state: 'working', since: (t && t.lastPromptAt) || null, reasons };
  }
  // `draft` holds only typed text: Claude's suggested reply is in
  // `suggestion` (server/suggestion.mjs), and a prompt holding one is at rest.
  if (screen.draft) return { state: 'draft', since: t && (t.lastTurnEndAt || t.lastTextAt), reasons: ['a reply is half typed in the prompt'] };

  // At an empty prompt after a finished turn.
  const endAt = t && (t.lastTurnEndAt || t.lastTextAt);
  reasons.push((screen.suggestion ? suggestionReason(screen) : 'empty prompt') + (screen.done ? `, done ${screen.done.when}` : ''));
  if (!t) {
    if (hook && hook.lifecycle === 'needsInput') return { state: 'handback', since: hook.updatedAt, reasons: [...reasons, 'cmux hook says needs input, no transcript'] };
    return { state: 'stale', since: null, reasons: [...reasons, 'no transcript found'] };
  }
  const q = endingQuestion(t.lastText);
  const a = age(now, endAt);
  if (q && a < settings.questionHours * H) return { state: 'asked', since: endAt, question: q, reasons: [...reasons, 'last message ends on a question'] };
  if (a < settings.handbackHours * H) return { state: 'handback', since: endAt, reasons: [...reasons, `finished ${Math.round(a / 60000)} min ago`] };
  return { state: 'stale', since: endAt, reasons: [...reasons, `finished more than ${settings.handbackHours} h ago`] };
}

// ---------------------------------------------------------------- events
// The state from Ravenry's own hook (hooks/events.mjs), checked
// before the screen. `ev` is server/events.mjs summarize() for the session;
// `screen` is what the terminal shows (parseScreen of null when there is no
// terminal adapter for it), read at `screenAt`. The screen only adds what
// the hooks cannot see: a dialog open before its Notification, a half-typed
// reply, and a missing event (no Stop after Esc, no SessionEnd after a crash).
// Returns null when the events say nothing usable, and the caller falls back
// to sessionState().

const NEEDS_YOU_TYPES = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
// The transcript can lag the hook by a moment (the last message lands just
// after Stop); activity later than this after an event is real.
const SKEW_MS = 10000;
// A turn the screen shows at rest this long after its prompt event ended
// without a Stop.
const SCREEN_GRACE_MS = 20000;

function ago(now, iso) {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (m < 1) return 'just now';
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function eventWords(e) {
  if (e.event === 'UserPromptSubmit') return 'prompt sent';
  if (e.event === 'Stop') return 'turn ended';
  if (e.event === 'SessionStart') return `session started (${e.source || 'startup'})`;
  if (e.event === 'SessionEnd') return `session ended (${e.reason || 'other'})`;
  if (e.event === 'Notification') return String(e.notification_type || 'notification').replace(/_/g, ' ');
  if (e.event === 'Interrupt') return 'turn interrupted';
  return e.event;
}

export function eventState({ ev, screen, screenAt, title, transcript: t }, settings, now) {
  if (!ev || !ev.last) return null;
  const L = ev.last;
  const at = Date.parse(L.at);
  const reasons = [`${eventWords(L)} ${ago(now, L.at)}`];
  const out = (state, since, extra = {}) => ({ state, since, reasons, source: 'events', ...extra });
  const sc = screen || { readable: false };
  const freshScreen = sc.readable && screenAt && screenAt > at + SCREEN_GRACE_MS;
  const activity = t && t.lastActivityAt ? Date.parse(t.lastActivityAt) : 0;
  const movedOn = activity > at + SKEW_MS;

  if (L.event === 'SessionEnd') return out('none', L.at);
  // A Claude that died without SessionEnd: its tab is a shell again.
  if (sc.readable && !sc.claudeLive && sc.exited && screenAt > at) {
    reasons.push('screen shows a shell, so the session exited without SessionEnd');
    return out('none', L.at);
  }
  if (sc.readable && sc.dialog) {
    reasons.push('screen shows a dialog open');
    return out('dialog', L.at, { message: L.event === 'Notification' ? L.message || null : null, ntype: L.event === 'Notification' ? L.notification_type || null : null });
  }

  // At rest: asked, half-typed, handed back or stale, by the age of `endAt`.
  const rest = (endAt, q) => {
    if (sc.readable && sc.draft) { reasons.push('screen shows a half-typed reply'); return out('draft', endAt); }
    if (sc.readable && sc.suggestion) reasons.push(suggestionReason(sc));
    const a = endAt ? now - Date.parse(endAt) : Infinity;
    if (q && a < settings.questionHours * H) { reasons.push('last message ends on a question'); return out('asked', endAt, { question: q }); }
    if (a < settings.handbackHours * H) return out('handback', endAt);
    reasons.push(`more than ${settings.handbackHours} h ago`);
    return out('stale', endAt);
  };
  const working = (why) => { if (why) reasons.push(why); return out('working', ev.lastPromptAt || L.at); };
  const transcriptQuestion = () => (t && t.lastText ? endingQuestion(t.lastText) : null);

  if (L.event === 'Notification' && NEEDS_YOU_TYPES.has(L.notification_type)) {
    if (movedOn) return working('transcript moved on after it, so it was answered');
    if (freshScreen && sc.claudeLive) {
      reasons.push('screen shows no dialog now');
      if (sc.working || sc.agentsRunning > 0) return working();
      return rest(L.at, null);
    }
    if (L.message) reasons.push(`"${L.message}"`);
    return out('dialog', L.at, { message: L.message || null, ntype: L.notification_type || null });
  }
  if (L.event === 'Notification') {
    // idle_prompt: Claude finished a while ago and nothing was typed since.
    if (movedOn) return working('transcript moved on after it');
    const stop = ev.lastStop;
    const endAt = stop ? stop.at : L.at;
    const q = stop && !stop.deferred ? stop.question || null : transcriptQuestion();
    if (L.message) reasons.push(`"${L.message}"`);
    return rest(endAt, q);
  }
  if (L.event === 'UserPromptSubmit') {
    if (t && t.lastInterruptAt && Date.parse(t.lastInterruptAt) >= at) {
      reasons.push('interrupted (transcript), no Stop came');
      return rest(t.lastInterruptAt, null);
    }
    if (freshScreen && sc.claudeLive && !sc.working && !(sc.agentsRunning > 0) && !(title && title.busy)) {
      reasons.push('screen shows it at rest, so the turn ended without a Stop');
      const end = t && t.lastTurnEndAt && Date.parse(t.lastTurnEndAt) >= at ? t.lastTurnEndAt : (t && t.lastActivityAt) || L.at;
      return rest(end, transcriptQuestion());
    }
    // No terminal to look at: a turn silent this long was cut off.
    const hours = settings.eventWorkingHours || 3;
    if (!sc.readable && now - Math.max(at, activity) > hours * H) {
      reasons.push(`no hook event or transcript activity for ${hours} h`);
      return out('stale', (t && t.lastActivityAt) || L.at);
    }
    return working();
  }
  if (L.event === 'Stop') {
    if (L.background_tasks > 0) return working(`waiting on ${L.background_tasks} background task${L.background_tasks > 1 ? 's' : ''}`);
    if (movedOn) return working('transcript moved on after it (a stop hook continued the turn)');
    return rest(L.at, L.deferred ? transcriptQuestion() : L.question || null);
  }
  // Codex's Interrupt (Esc, or a refused approval): at rest, nothing asked.
  if (L.event === 'Interrupt') {
    if (movedOn) return working('transcript moved on after it');
    return rest(L.at, null);
  }
  if (L.event === 'SessionStart') {
    if (movedOn) return working('transcript moved on after the start');
    const endAt = t && (t.lastTurnEndAt || t.lastTextAt);
    if (!endAt) { reasons.push('nothing asked yet'); return out('stale', L.at); }
    return rest(endAt, transcriptQuestion());
  }
  return null;
}

// handed: the session wrote its hand-off and a fresh one carries on.
const RANK = { dialog: 0, asked: 1, draft: 2, working: 3, handback: 4, stale: 5, handed: 6, unknown: 7, none: 8 };

export function projectState(sessions, waitingOn) {
  const by = (states) => sessions.filter((s) => states.includes(s.st.state))
    .sort((a, b) => (RANK[a.st.state] - RANK[b.st.state]) || (Date.parse(b.st.since || 0) - Date.parse(a.st.since || 0)));
  let pick;
  if ((pick = by(['dialog', 'asked', 'draft'])).length) return { state: 'you', primary: pick[0] };
  if ((pick = by(['working'])).length) return { state: 'work', primary: pick[0] };
  if (waitingOn) return { state: 'wait', primary: by(['handback', 'stale', 'unknown', 'none'])[0] || sessions[0] || null };
  if ((pick = by(['handback'])).length) return { state: 'you', primary: pick[0] };
  // A handed-off session is never the primary while another is open: its
  // hand-off time can be newer than the fresh session's last turn.
  const handed = (s) => (s.st.state === 'handed' ? 1 : 0);
  const rest = sessions.slice().sort((a, b) => (handed(a) - handed(b)) || (Date.parse(b.st.since || 0) - Date.parse(a.st.since || 0)));
  return { state: 'idle', primary: rest[0] || null };
}

// The words on the card and in the row, from the session that set the state.
export function describe(project, primary, state, now) {
  const t = primary && primary.transcript;
  const sc = primary && primary.screen;
  const st = primary && primary.st;
  const out = { line: '', headline: '', quick: [], question: null };
  const lastPara = t && t.lastText ? plain(paragraphs(t.lastText).slice(-1)[0]) : '';
  const recapNext = t && t.recap ? (sentences(t.recap).find((s) => /^next\b/i.test(s)) || null) : null;

  if (state === 'you' && st) {
    if (st.state === 'dialog') {
      // A dialog known only from a Notification has no options on screen.
      const d = sc && sc.dialog;
      const q = (d && d.question) || st.message || null;
      out.headline = q || 'A choice is open on screen.';
      out.line = q || 'A choice is open on screen';
      out.quick = d ? d.options.map((o) => ({ label: o.label, choice: o.n })) : [];
      out.dialog = d ? d.lines : null;
    } else if (st.state === 'asked') {
      out.question = st.question;
      out.headline = lastPara.length > 600 ? st.question : lastPara;
      out.line = st.question;
      if (isYesNo(st.question)) out.quick = [{ label: 'Yes' }, { label: 'No' }];
    } else if (st.state === 'draft') {
      out.headline = (t && t.recap) || lastPara || 'Your reply is half typed in the prompt.';
      out.line = 'Your reply is half typed in the prompt';
      out.draft = sc.draft;
    } else {
      out.headline = (t && t.recap) || lastPara;
      out.line = recapNext || sentences(lastPara)[0] || (t && t.title) || '';
    }
  } else if (state === 'work') {
    const tool = t && t.lastTool && t.lastTool.what && age(now, t.lastToolAt) < 15 * 60000 ? t.lastTool.what : null;
    out.headline = tool || (sc && sc.busyLine) || (t && t.title) || 'Working';
    out.line = (t && t.title) || tool || (sc && sc.busyLine) || '';
  } else if (state === 'wait') {
    out.headline = 'Waiting on ' + project.waitingOn;
    out.line = 'Waiting on ' + project.waitingOn;
  } else {
    const last = (t && t.recap) || lastPara;
    out.headline = last ? 'Last: ' + last : '';
    out.line = (t && t.title) || '';
  }
  for (const k of ['line', 'headline']) {
    out[k] = String(out[k] || '').replace(/\s+/g, ' ').trim();
  }
  if (out.headline.length > 700) out.headline = out.headline.slice(0, 697).replace(/\s+\S*$/, '') + '...';
  return out;
}
