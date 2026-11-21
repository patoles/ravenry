// What the phone board shows to start, continue and move a session
// (docs/FEATURES.md SESS-009, SESS-010, SESS-015 to SESS-018, MACH-007): the
// hub decides which choice a session or a project offers and words it, in
// the shared strings (shared/strings/en.json psess.*, pstart.*); the phone
// draws it and sends the person's pick back (POST /api/sessions/start,
// /api/sessions/resume, /api/sessions/move). Said for a device away from
// the computer: "on your Mac", "Move to Ravenry", never "here".
//
// Pure: every input is given.
import { t as word } from './strings.mjs';
import * as assistants from './assistants.mjs';

// The names are the assistant registry's (server/assistants.mjs).
const NAME = Object.fromEntries(assistants.IDS.map((k) => [k, assistants.nameOf(k)]));
const WHO = Object.fromEntries(assistants.IDS.map((k) => [k, assistants.chipOf(k)]));
const kindOf = (k) => (assistants.isId(k) ? k : assistants.DEFAULT);
// The registered assistant a session's kind names ("claude", "codex-..."), or null.
const known = (k) => assistants.IDS.find((id) => k.startsWith(id)) || null;

/** The computer the hub runs on, as a phone says it: "your Mac", else "your computer". */
export const computerWord = (platform = process.platform) => word(platform === 'darwin' ? 'psess.yourMac' : 'psess.yourComputer');

/** The words the phone strings use that need the computer: { computer }. */
const vars = (platform, x = {}) => ({ computer: computerWord(platform), ...x });

/**
 * What a session's page offers about where it runs, for the phone: null, or
 *   { kind: 'move', head, text, move }         in cmux, iTerm2 or Rex, open there (06a)
 *   { kind: 'waiting', text }                 a move waits for the turn to end (06b)
 *   { kind: 'also', head, text, keep, keepOther } open in Ravenry and in another terminal (07)
 *   { kind: 'wentOn', head, text, move }       its conversation went on in another terminal
 * `s` is the session as the state has it (outside, alsoOpen, moving, movedOn, working, assistant).
 */
export function moveView(s, { platform = process.platform } = {}) {
  if (!s || !s.sessionId || s.machine) return null;
  // Only an assistant that can resume a conversation can move.
  const k = known(String(s.assistant || 'claude'));
  if (!k || !assistants.can(k, 'resume')) return null;
  const who = WHO[k];
  const m = s.moving;
  if (m && m.waiting) {
    // Kept there: the other terminal's name (the move's own name is the copy it ends).
    const other = (s.alsoOpen && s.alsoOpen.name) || (s.outside && s.outside.name) || null;
    const where = (m.keep === 'outside' ? other || m.name : m.name || other) || 'the other terminal';
    return { kind: 'waiting', keep: m.keep === 'outside' ? 'outside' : 'ravenry', text: word(m.keep === 'outside' ? 'psess.keepsWhen' : 'psess.movesWhen', { who, where }) };
  }
  if (s.alsoOpen) {
    const where = s.alsoOpen.name || 'the other terminal';
    return { kind: 'also', head: word('psess.alsoOpen', { where }), text: word('psess.alsoOpenText', vars(platform, { where })), keep: word('psess.keepRavenry'), keepOther: word('psess.keepThere', { where }) };
  }
  if (s.movedOn) {
    const where = s.movedOn.name || 'another terminal';
    return { kind: 'wentOn', head: word('psess.wentOn', { where }), text: word('psess.wentOnText', vars(platform, { where })), move: word('psess.move') };
  }
  if (s.outside && s.outside.open) {
    const where = s.outside.name || 'another terminal';
    const text = word('psess.moveText', vars(platform, { where })) + (s.working ? ' ' + word('psess.moveWhenTurn', { who }) : '');
    return { kind: 'move', head: word('psess.runsIn', vars(platform, { where })), text, move: word('psess.move') };
  }
  return null;
}

/**
 * The Last conversation card of an idle project, for the phone (04, 05), from
 * GET /api/project/last's `last`: null when there is none, or it already
 * runs in a Ravenry pane (the page shows that session), else
 *   { action: 'continue' | 'move', words: { head, chip, you, who, stopped, continue?, note?, stillOpen?, moveText?, move?, newHere } }
 * `stopped` is a template ("Stopped {when}"): the time is said against the phone's clock.
 */
export function lastView(last, { platform = process.platform } = {}) {
  if (!last || !last.sessionId) return null;
  const open = last.openIn || null;
  if (open && open.ravenry) return null;
  const k = kindOf(last.assistant);
  const words = { head: word('psess.lastConversation'), chip: NAME[k], you: word('project.you'), who: WHO[k], stopped: word('project.stoppedAt'), newHere: word('project.newHere') };
  if (open) {
    const where = open.name || 'another terminal';
    return { action: 'move', words: { ...words, stillOpen: word('psess.stillOpenIn', vars(platform, { where })), moveText: word('psess.stillOpenText', vars(platform, { where })), move: word('psess.move'), moving: word('psess.moving') } };
  }
  return { action: 'continue', words: { ...words, continue: word('project.continue'), continuing: word('project.continuing'), note: word('psess.continueNote', vars(platform)) } };
}

/**
 * New session's words for the phone (02a to 02d): fixed text, and templates
 * the phone fills with the person's picks ({assistant}, {folder}, {machine},
 * {topic}, {project}).
 */
export function startWords({ platform = process.platform } = {}) {
  const v = vars(platform);
  return {
    title: word('start.title'), runsOn: word('start.where'), thisMac: word('start.thisMac'),
    project: word('pstart.project'), projectOn: word('pstart.projectOn'), allProjects: word('pstart.allProjects'), folderOnPh: word('pstart.folderOnPh'),
    ownCopyB: word('start.ownCopyB'), ownCopy: word('start.ownCopy'), inFolderLink: word('start.inFolderLink'),
    inFolderB: word('start.inFolderB'), inFolder: word('start.inFolder'), ownCopyLink: word('start.ownCopyLink'),
    assistant: word('start.assistant'), names: { ...NAME }, signedIn: word('pstart.signedIn'), notSignedIn: word('pstart.notSignedIn'), notFound: word('pstart.notFound', v), onMachine: word('start.onMachine'),
    model: word('start.model'), modelNote: word('start.modelNote'),
    firstMessage: word('pstart.firstMessage'), optional: word('pstart.optional'), firstMessagePh: word('pstart.firstMessagePh'),
    go: word('start.goAssistant'), goOn: word('start.goAssistantOnly'), starting: word('start.starting'), failed: word('start.failed'),
    loading: word('pstart.loading'), noProject: word('pstart.noProject'),
  };
}

/** What the hub says once a session started from the phone: "Started Claude Code in paper-boat, on its own branch." */
export function startedSay({ assistant, folder, machine = null, worktree = false } = {}) {
  const a = NAME[kindOf(assistant)];
  if (machine) return word('pstart.startedOn', { assistant: a, machine });
  return word(worktree ? 'pstart.startedOwnCopy' : 'pstart.started', { assistant: a, folder: folder || '' });
}

/** What the hub says once a conversation was continued or moved into a Ravenry pane. */
export const resumedSay = ({ moved = false, keep = 'ravenry', where = null, platform = process.platform } = {}) => (
  keep === 'outside' ? word('psess.kept', { where: where || 'the other terminal' }) : word(moved ? 'psess.moved' : 'pstart.continued', vars(platform)));
