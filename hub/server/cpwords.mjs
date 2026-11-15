// What a checkpoint says (PROTOCOL.md section 4), in words every client
// shows as they come: the one place that words a checkpoint. The hub
// attaches them to every checkpoint it hands out, as `words`: in its state
// (`checkpoints`), GET /api/checkpoints (with and without ?all), the answer
// responses, and POST /api/checkpoints/words, which words the copies a
// client holds from its own daemons. Pure functions, so they are tested
// without a hub (hub/tools/cpwords-test.mjs, hub/tools/sidebar-test.mjs).
//
// The shape (hub/docs/STATE-RULES.md, "What a checkpoint says"):
//
//   words: {
//     v: 1,
//     state,              // the checkpoint state these words describe; a
//                         // client holding a copy in another state asks again
//     kind,               // ask | approve | secret | drive | pick | other
//     who, whoMid,        // "Claude", "Codex", else "The agent" / "the agent"
//     head, body,         // the title's first line, and the rest or null
//     checks: { text, checks },   // body as prose and its numbered checks (2+)
//     heading,            // a card's top line: "Claude asks", "Map tiles: Rebuild"
//     top,                // the phone screen's top label: "Claude is waiting for you"
//     mark: { kind, text, code, label },   // a sidebar row's mark (as state.sidebar's)
//     machine: { remote, here, away, line },
//     runLabel,           // "Run on {machine}"
//     warnings: [{ from: 'agent' | 'ravenry', label, text }],  // for the proposed command
//     guess: { label, rules: [{ pattern, flags, text }] } | null,  // approve: for an edited one
//     secret: { noun, to } | null,
//     drive: { action, wants, once, session, sessionSub, row, title, pane,
//              phone: { title, what, yes: [{ allow, label, sub, said }] } } | null,
//     variants: [{ letter, name, says }],   // pick
//     after: { ok, head, at, small, big, command, edited, text, runPane,
//              where: { by, mine, other } } | null,  // running or closed
//   }
//
// Times stay ISO (`after.at`, the checkpoint's own created_at and
// expires_at): each client says them against its own clock. Words that
// depend on which client shows them carry a token, filled by a fixed rule:
//
//   {machine}  a client on the hub's own computer (the desktop app, the Mac
//              app) puts words.machine.here ("this Mac"); any other (the
//              phone) puts words.machine.away (the computer's name).
//   {ranOn}    (after.head) the same, but words.machine.awayAfter ("this
//              computer") for a client elsewhere.
//   {where}    (after.text) the client whose answers carry `by` equal to
//              after.where.by puts after.where.mine ("here"), any other
//              after.where.other ("on your phone", "from desktop").
//   {time}     (after.text) after.at as the client says a time of day.
//   {pane}     (drive) the name this client shows for that pane (its tab's),
//              else words.drive.pane.

/** "Claude", "Codex", else the kind with a capital, else null. */
export function assistantName(kind) {
  if (!kind) return null;
  if (kind === 'claude') return 'Claude';
  if (kind === 'codex') return 'Codex';
  return kind[0].toUpperCase() + kind.slice(1);
}

const KINDS = new Set(['ask', 'approve', 'secret', 'drive', 'pick']);

/** ask, approve, secret, drive, pick, else other. */
export const kindOf = (cp) => (KINDS.has(cp && cp.kind) ? cp.kind : 'other');

/** Who waits: "Claude", "Codex", else "The agent". */
export const who = (cp) => assistantName(cp && cp.assistant) || 'The agent';
/** Who waits, mid-sentence: "Claude", "Codex", else "the agent". */
export const whoMid = (cp) => assistantName(cp && cp.assistant) || 'the agent';

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** A title's first line is what the person reads first; the rest explains it. */
export function splitTitle(title) {
  const t = String(title || '').replace(/\r/g, '').trim();
  const i = t.indexOf('\n');
  if (i < 0) return { head: t, body: null };
  const body = t.slice(i + 1).trim();
  return { head: t.slice(0, i).trim(), body: body || null };
}

/**
 * A question's explanation split into its prose and its list: lines that
 * start with "1." or "-" become the numbered checks under "Check that".
 */
export function checksOf(body) {
  if (!body) return { text: null, checks: [] };
  const checks = [];
  const rest = [];
  for (const l of String(body).split('\n')) {
    const m = /^\s*(?:\d+[.)]|[-*])\s+(.+)$/.exec(l);
    if (m) checks.push(m[1].trim());
    else rest.push(l);
  }
  const text = rest.join('\n').replace(/\n{2,}/g, '\n').trim() || null;
  return { text, checks: checks.length >= 2 ? checks : [] };
}

/** What a drive asks to do, in the words its card and its row use. */
export function driveVerb(cp) {
  switch (cp && cp.drive && cp.drive.action) {
    case 'close': return { action: 'close', wants: 'wants to close', once: 'Let it close', session: null, row: 'Wants to close' };
    case 'restart': return { action: 'restart', wants: 'wants to restart', once: 'Let it restart', session: 'Let it restart it when it needs to', row: 'Wants to restart' };
    case 'override': return { action: 'change', wants: 'wants to change', once: 'Let it change this', session: 'Let it change it when it needs to', row: 'Wants to change' };
    default: return { action: 'type', wants: 'wants to type', once: 'Let it type this', session: 'Let it use this pane', row: 'Wants to type in' };
  }
}

/** A card's top line. */
export function heading(cp) {
  const pg = cp && cp.page;
  if (pg && kindOf(cp) === 'approve') return `${pg.title}: ${pg.label}`;
  const w = who(cp);
  switch (kindOf(cp)) {
    case 'ask': return `${w} asks`;
    case 'approve': return `${w} wants to run`;
    case 'secret': return `${w} needs a secret`;
    case 'pick': return `${w} asks you to pick`;
    case 'drive': return `${w} ${driveVerb(cp).wants}`;
    default: return `${w} is waiting`;
  }
}

/** The label at the top of the phone's checkpoint screen. */
export function topLabel(cp) {
  const w = who(cp);
  if (cp.kind === 'pick') return `${w} wants you to pick`;
  if (cp.kind === 'drive') return `${w} is asking first`;
  if (cp.page && kindOf(cp) === 'approve') return `${cp.page.title} wants to run a command`;
  switch (kindOf(cp)) {
    case 'ask': return `${w} is waiting for you`;
    case 'approve': return `${w} wants to run a command`;
    case 'secret': return `${w} needs a secret`;
    default: return `${w} is waiting`;
  }
}

/** The word before a mark's text on a session's row (the phone shows it). */
export function markLabel(kind) {
  switch (kind) {
    case 'approve': return 'Wants to run:';
    case 'secret': return 'Needs a secret:';
    case 'pick': return 'Pick one:';
    case 'drive': return 'Asks first:';
    default: return 'Checkpoint:';
  }
}

/** "Wants the mail service API key": the secret's name as the sidebar row says it. */
export function wantsLine(title) {
  const head = splitTitle(title).head;
  // A plain first word reads lower case mid-sentence; a name (GitHub,
  // OpenAI) or an acronym (AWS) keeps its case.
  const m = /^([A-Z][a-z]+)(\b.*)$/.exec(head);
  const name = m ? m[1].toLowerCase() + m[2] : head;
  return `Wants the ${name}`;
}

/**
 * The mark on a sidebar row: { kind, text, code, label }. A drive names the
 * pane it would act on (`paneName`, as the sidebar and the tabs name it).
 */
export function markOf(cp, paneName = null) {
  const k = kindOf(cp);
  const m = (text, code = false) => ({ kind: k, text, code, label: markLabel(k) });
  if (k === 'approve') return m(String(cp.command || '').split('\n')[0], true);
  if (k === 'secret') return m(wantsLine(cp.title));
  if (k === 'pick') return m(`Pick one of ${(cp.variants && cp.variants.length) || 'the'}: ${splitTitle(cp.title).head}`);
  if (k === 'drive' && cp.drive) return m(`${driveVerb(cp).row} ${paneName || 'a pane'}`);
  return m(splitTitle(cp.title).head);
}

// What can't be taken back once it ran. Only the clear cases: a warning on
// everything would be read as noise. Sent as data too (words.guess.rules),
// so a client says the guess for a command the person is editing at once.
export const RISKS = [
  [/\b(?:npm|pnpm|yarn)\s+(?:\S+\s+)*?publish\b/, 'Publishing to npm can\'t be undone'],
  [/\bcargo\s+publish\b/, 'Publishing to crates.io can\'t be undone'],
  [/\b(?:twine\s+upload|poetry\s+publish|uv\s+publish|flit\s+publish)\b/, 'Publishing to PyPI can\'t be undone'],
  [/\bgem\s+push\b/, 'Publishing a gem can\'t be undone'],
  [/\bgit\s+push\b[^;&|]*(?:\s--force\b|\s--force-with-lease\b|\s-f\b|\s\+\S)/, 'A force push can\'t be undone'],
  [/\bgit\s+push\b[^;&|]*\s--delete\b/, 'Deleting a remote branch can\'t be undone'],
  [/\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f)/, 'Throwing away changes can\'t be undone'],
  [/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/, 'Deleting with rm -rf can\'t be undone'],
  [/\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i, 'Dropping data can\'t be undone'],
  [/\b(?:terraform|tofu)\s+destroy\b/, 'Destroying the infrastructure can\'t be undone'],
  [/\bkubectl\s+delete\b/, 'Deleting from the cluster can\'t be undone'],
  [/\bgh\s+release\s+create\b/, 'Publishing a release can\'t be undone'],
];

export const GUESS_LABEL = 'Ravenry\'s guess:';

/** The rules as data: the first whose pattern matches the command gives the guess. */
export const guessRules = () => RISKS.map(([re, text]) => ({ pattern: re.source, flags: re.flags, text }));

/** A warning when the command does something that can't be taken back, else null. */
export function riskOf(command) {
  const c = String(command || '');
  for (const [re, text] of RISKS) if (re.test(c)) return text;
  return null;
}

/**
 * The warnings an approve card shows: the agent's own (`warning`, its
 * words, labelled as its), then Ravenry's guess from the command (labelled
 * as Ravenry's). Both show when both exist, so an agent's reassuring
 * "warning" never hides Ravenry's guess.
 */
export function warningsOf(cp, command = cp.command) {
  const out = [];
  const mine = String(cp.warning || '').trim();
  if (mine) out.push({ from: 'agent', label: `${who(cp)} warns:`, text: mine });
  const guess = riskOf(command);
  if (guess) out.push({ from: 'ravenry', label: GUESS_LABEL, text: guess });
  return out;
}

/** The program a command runs and its plain words, for "Sent to wrangler secret put". */
export function shortCommand(command) {
  const words = String(command || '').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && /^(?:npx|bunx|sudo|env|exec|command)$/.test(words[0])) words.shift();
  if (words.length > 1 && words[0] === 'pnpm' && words[1] === 'dlx') words.splice(0, 2);
  const out = [];
  for (const w of words) {
    if (out.length && !/^[a-z][a-z0-9:._-]*$/.test(w)) break;
    out.push(w);
    if (out.length === 3) break;
  }
  return out.join(' ');
}

/** What a secret is called in its field: token, password, key, else secret. */
export function secretNoun(title) {
  const t = String(title || '');
  if (/\btoken\b/i.test(t)) return 'token';
  if (/\bpassword\b|\bpassphrase\b/i.test(t)) return 'password';
  if (/\bkey\b/i.test(t)) return 'key';
  return 'secret';
}

/** "6 s", "1 min 20 s", "12 min". */
export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 10 && r) return `${m} min ${r} s`;
  return `${m} min`;
}

const isRemote = (machine) => !!machine && machine !== 'local';

/**
 * The machine a checkpoint runs on, for people (`{machine}`): `here` for a
 * client on the hub's computer ("this Mac", "this computer"), `away` for any
 * other (the computer's name); a remote machine is its name for both.
 * `line` is `here` at the start of a line. `{ranOn}` (a card's after head)
 * is `here` on the hub's computer, else `awayAfter`.
 */
export function machineWords(machine, { platform = process.platform, hubName = null } = {}) {
  const remote = isRemote(machine);
  const here = remote ? machine : platform === 'darwin' ? 'this Mac' : 'this computer';
  const away = remote ? machine : hubName || 'this computer';
  // What a closed card says it ran on: `here` on the hub's computer, else
  // "this computer" (the phone's done screen said so before the hub worded it).
  const awayAfter = remote ? machine : 'this computer';
  return { remote, here, away, awayAfter, line: cap(here) };
}

/** The pane a daemon's drive title names ('Let Claude close "dev server" (pane pabc)?'), without its id. */
export function paneInTitle(title) {
  const m = /"([^"]+)" \(pane [a-z0-9]+\)/.exec(String(title || ''));
  return m ? m[1] : null;
}

/**
 * A drive's words: the verb's, the card's question, and the phone's screen
 * (its title, what it means, the yes buttons and what each says once sent).
 * `{pane}` stands for the pane's name; `pane` is the hub's name for it.
 */
export function driveWords(cp, paneName = null) {
  if (kindOf(cp) !== 'drive') return null;
  const v = driveVerb(cp);
  const w = who(cp);
  const pane = (cp.drive && cp.drive.name) || paneName || paneInTitle(cp.title) || 'another tab';
  const title = v.action === 'type' ? 'Let it type in {pane}?' : v.action === 'change' ? 'Let it change how {pane} runs?' : `Let it ${v.action} {pane}?`;
  const sessionSub = v.session ? (v.action === 'type' ? 'Until its session ends or you take it back' : 'Until its session ends') : null;
  let phone;
  switch (cp.drive && cp.drive.action) {
    case 'close': phone = { title: `${w} wants to close {pane}`, what: 'Whatever runs there stops.', yes: [{ allow: 'once', label: 'Let it close', sub: null, said: `${w} closes {pane} now.` }] }; break;
    case 'restart': phone = { title: `${w} wants to restart {pane}`, what: 'What runs there stops and starts again.', yes: [{ allow: 'once', label: 'Let it restart', sub: null, said: `${w} restarts {pane} now.` }] }; break;
    case 'override': phone = { title: `${w} wants to change how {pane} runs`, what: null, yes: [{ allow: 'once', label: 'Let it change it', sub: null, said: `${w} changes how {pane} runs.` }] }; break;
    default: phone = { title: `${w} wants to type in {pane}`, what: null, yes: [
      { allow: 'once', label: 'Allow once', sub: null, said: `${w} types it now.` },
      { allow: 'session', label: 'This session', sub: 'Until its session ends', said: `${w} may type in {pane} until its session ends.` },
    ] };
  }
  return { ...v, sessionSub, title, pane, phone };
}

/** A pick's variants as people read them: a letter (A, B...), the label whole as the name, the agent's words about it as its. */
export function variantsOf(cp) {
  const w = who(cp);
  return (Array.isArray(cp.variants) ? cp.variants : []).map((v, i) => {
    const name = String((v && v.label) || '').trim();
    const d = String((v && v.description) || '').trim();
    return { letter: String.fromCharCode(65 + i), name, says: d ? `${w}: ${d}` : null };
  });
}

/** Where an answer came from, for `{where}`: the client that sent `by` says mine, any other says other. */
function whereOf(by) {
  return { by: by || null, mine: 'here', other: by === 'phone' ? 'on your phone' : by ? `from ${by}` : 'here' };
}

/**
 * What a running or closed checkpoint says afterwards, or null while it is
 * open. `at` is the time its header shows (ISO, or null); `text` may hold
 * {where}, {time} and {machine}, `head` {machine}.
 */
export function afterOf(cp) {
  if (cp.state === 'open') return null;
  const k = kindOf(cp);
  // A page's run: the person pressed its button and no agent asked, so the page speaks and nobody "has the output".
  const pg = cp.page && k === 'approve' ? cp.page : null;
  const w = pg ? pg.title : who(cp);
  const a = cp.answer || null;
  const head0 = splitTitle(cp.title).head;
  const base = { ok: false, head: '', at: cp.closed_at || (a && a.at) || null, small: null, big: null, command: null, edited: false, text: '', runPane: null, where: whereOf(a && a.by) };
  const ran = () => (a && a.command) || cp.command || null;
  if (cp.state === 'lost') return { ...base, head: 'Not reachable', small: head0, text: `${cp.machine ? `ravenryd on ${cp.machine}` : 'The daemon that asked'} is not reachable any more, so this cannot be answered. If it comes back, so does the question.` };
  // The person wrote to the session instead (server/terminalanswer.mjs): their words stay there.
  if (cp.state === 'cancelled' && cp.answered_in === 'terminal') return { ...base, head: 'Answered in the terminal', small: k === 'ask' || k === 'pick' ? head0 : null, command: k === 'approve' ? cp.command || null : null, text: `You answered ${whoMid(cp)} in the terminal, so this card was withdrawn.` };
  if (cp.state === 'cancelled') return { ...base, head: 'Withdrawn', text: `${w} withdrew it${cp.reason ? `: ${cp.reason}` : '.'}` };
  if (cp.state === 'expired') return { ...base, at: base.at || cp.expires_at || null, head: 'Nobody answered', text: `${w} gave up waiting at {time}.` };
  if (cp.state === 'declined' || (a && a.declined)) {
    const why = a && a.reason ? `: "${a.reason}"` : '';
    return { ...base, head: 'Refused', small: k === 'ask' ? head0 : null, command: k === 'approve' ? cp.command || null : null, text: pg ? `You said no {where}${why}. Nothing ran.` : `You said no {where}${why}. ${w} was told.` };
  }
  if (k === 'ask') {
    const answer = a ? a.option ?? a.text ?? (a.choice != null && cp.options ? cp.options[a.choice] : null) : null;
    return { ...base, ok: true, head: 'Answered', small: head0, big: answer ?? null, text: 'You answered {where}.' };
  }
  if (k === 'approve') {
    const edited = !!(a && a.command);
    const approved = edited ? 'You edited it and approved it {where}' : 'You approved it {where}';
    const runPane = (cp.run && cp.run.pane) || null;
    if (cp.state === 'running') {
      return { ...base, ok: true, head: 'Running on {ranOn}', at: (a && a.at) || null, command: ran(), edited, text: pg ? `${approved}. Its output is in its pane.` : `${approved}. ${w} gets the output when it ends${edited ? ', and is told you changed it' : ''}.`, runPane };
    }
    const exit = cp.run && cp.run.exit;
    const took = a && a.at && cp.closed_at ? duration(Date.parse(cp.closed_at) - Date.parse(a.at)) : null;
    const how = !exit ? (cp.reason ? `It did not run: ${cp.reason}.` : 'It ended.')
      : exit.code === 0 ? `Finished${took ? ` in ${took}` : ''} with no errors.`
        : exit.signal ? `Stopped by ${exit.signal}${took ? ` after ${took}` : ''}.`
          : `Ended with exit code ${exit.code}${took ? ` after ${took}` : ''}.`;
    return { ...base, ok: !!exit && exit.code === 0, head: 'Ran on {ranOn}', command: ran(), edited, text: pg ? `${how} ${approved}.` : `${how} ${approved}; ${whoMid(cp)} has the output${edited ? ' and knows you changed it' : ''}.`, runPane };
  }
  if (k === 'secret') {
    const to = cp.secret && cp.secret.to === 'input' ? 'the program in its pane' : shortCommand(cp.command) || 'its command';
    return { ...base, ok: true, head: 'Secret sent', big: head0, text: `Sent to ${to}. Ravenry didn't keep a copy, so it can't be shown again. To change it, ${whoMid(cp)} has to ask again.` };
  }
  if (k === 'drive') {
    const v = driveVerb(cp);
    const session = a && a.allow === 'session';
    const did = v.action === 'type' ? (session ? 'You let it use the pane until its session ends' : 'You let it type this, once') : `You let it ${v.action} it${session ? ' when it needs to, until its session ends' : ', once'}`;
    return { ...base, ok: true, head: 'Allowed', text: `${did} {where}.` };
  }
  if (k === 'pick') {
    const pk = a && a.pick;
    return { ...base, ok: true, head: 'Picked', small: head0, big: pk && pk.label ? `${pk.label}${pk.note ? `, with a note: "${pk.note}"` : ''}` : null, text: 'You picked {where}.' };
  }
  return { ...base, ok: true, head: 'Answered', small: head0, text: 'You answered {where}.' };
}

/**
 * Every word of a checkpoint (the shape at the top). ctx: the hub's
 * `platform` and `hubName` (for {machine}), and `paneName(pane)`, the
 * name the sidebar gives a pane (a drive's).
 */
export function wordsOf(cp, { platform = process.platform, hubName = null, paneName = () => null } = {}) {
  const k = kindOf(cp);
  const { head, body } = splitTitle(cp.title);
  // A drive's pane by the sidebar's name for it (the row's mark says it as the sidebar does).
  const named = k === 'drive' && cp.drive ? cp.drive.name || paneName(cp.drive.pane) || null : null;
  const drive = k === 'drive' ? driveWords(cp, named) : null;
  return {
    v: 1,
    state: cp.state,
    kind: k,
    who: who(cp),
    whoMid: whoMid(cp),
    head,
    body,
    checks: checksOf(body),
    heading: heading(cp),
    top: topLabel(cp),
    mark: markOf(cp, named),
    machine: machineWords(cp.machine, { platform, hubName }),
    runLabel: 'Run on {machine}',
    warnings: k === 'approve' ? warningsOf(cp) : [],
    guess: k === 'approve' ? { label: GUESS_LABEL, rules: guessRules() } : null,
    secret: k === 'secret' ? { noun: secretNoun(cp.title), to: (cp.secret && cp.secret.to) || null } : null,
    drive,
    variants: k === 'pick' ? variantsOf(cp) : [],
    after: afterOf(cp),
  };
}

/** The checkpoint with its words (any it carried are made again), for every place the hub hands one out. */
export function withWords(cp, ctx) {
  if (!cp || typeof cp !== 'object') return cp;
  const { words: _w, ...rest } = cp;
  return { ...rest, words: wordsOf(rest, ctx) };
}
