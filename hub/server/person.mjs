// Who acts as the person (packages/protocol/PROTOCOL.md section 4, Who acts
// as the person, and docs/PERSON.md). A checkpoint exists so that a person
// answers it, and the same goes for every other write that stands for a
// person's decision (ROUTES below), so:
//
// - The HTTP API refuses those writes to a program on this machine that
//   runs inside a ravenryd pane (an agent, or anything it started) or in
//   an ssh session. A request from the phone (another address, with its
//   device token: server/phone.mjs, on the board's port or the phone
//   port of server/phonetls.mjs) is the person, and so is a pairing on the
//   phone port from another address, which its one-time code proves. A request from this
//   machine, on localhost or on one of its own addresses (a phone token
//   used from here proves nothing), is judged by `ravenryd peer --tcp
//   <its port> --to <ours>`: the daemon's own code finds the process that
//   holds the connection and reads where it comes from, so the hub and
//   the daemon judge alike.
//   The board page in a browser and the desktop app pass: their processes
//   run outside every pane.
// - The hub's answer key goes in hello on every daemon connection. Over
//   ssh (`ssh host ravenryd proxy`) a daemon cannot see this machine, so
//   it lets a connection act as the person only with the key it trusts:
//   the first one it was given. The key lives in <RAVENRY_HOME>/answer-key
//   (mode 0600) and is made on first use.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { RAVENRY_HOME, assertDataWrite } from './home.mjs';

export const KEY_FILE = path.join(RAVENRY_HOME, 'answer-key');

let key = null;

// The hub's answer key, made on first use.
export function answerKey() {
  if (key) return key;
  try {
    const k = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{43,}$/.test(k)) { key = k; return key; }
  } catch { /* none yet */ }
  const k = crypto.randomBytes(32).toString('base64url');
  try {
    assertDataWrite(KEY_FILE);
    fs.mkdirSync(RAVENRY_HOME, { recursive: true });
    const tmp = KEY_FILE + '.tmp';
    fs.writeFileSync(tmp, k + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, KEY_FILE);
  } catch (e) { console.error('answer key:', e.message); }
  key = k;
  return key;
}

export const REFUSED = 'Only a person can answer a checkpoint, in the Ravenry app or on the phone.';

// ------------------------------------------------------------ the routes
// Every write of the HTTP API, and the reads that hand out a pairing
// secret, with its class: `person` (a person's decision: refused to a
// program inside a pane or in an ssh session) or `open` (fine for agents
// too: it adds something the person reads later, runs nothing, removes
// nothing and decides nothing). A POST under /api/ that no row names is a
// person's: a new endpoint is closed until it is classed here.
// docs/PERSON.md is this table for people; tools/person-routes-test.mjs
// checks that every route the server has is in it and proves each person
// row from inside a real pane.
// `what` finishes "Only a person can ..." in the refusal.
const P = 'person', O = 'open';
export const ROUTES = [
  // The decision ledger (server/decisions.mjs)
  { m: 'POST', p: '/api/decisions/add', c: P, what: 'record a decision', why: 'A decision the person adds is their own word, which every agent then follows (an agent records one through /api/decisions/record instead, marked as its own).' },
  { m: 'POST', p: '/api/decisions/record', c: O, why: 'An agent records the person\'s words verbatim (`ravenry decide`): it counts at once, marked with the pane and session that recorded it, and the person is told at once and can undo it for a minute, or edit or remove it any time.' },
  { m: 'POST', p: '/api/decisions/undo', c: P, what: 'undo a decision', why: 'Taking a decision back is the person\'s call; an agent would undo the person\'s words.' },
  { m: 'POST', p: '/api/decisions/edit', c: P, what: 'edit a decision', why: 'Rewriting a decision changes what every agent follows.' },
  { m: 'POST', p: '/api/decisions/remove', c: P, what: 'remove a decision', why: 'Taking a decision off the record changes what every agent follows.' },
  // Checkpoints and plans
  { m: 'POST', p: '/api/checkpoints/answer', c: P, what: 'answer a checkpoint', why: 'Answering a checkpoint is the person\'s answer to an agent.', strict: true },
  { m: 'POST', p: '/api/plan/answer', c: P, what: 'answer a plan\'s gate or question', why: 'Passing a gate is the person\'s answer; an agent would pass its own gate.' },
  { m: 'POST', p: '/api/plan/confirm', c: P, what: 'confirm a plan\'s gate', why: 'It passes a gate the file alone marked passed; an agent would confirm its own.' },
  { m: 'POST', p: '/api/plan/reopen', c: P, what: 'reopen a plan\'s gate', why: 'It reopens a gate the file alone marked passed and stops the session at it.' },
  { m: 'POST', p: '/api/plan/start', c: P, what: 'start a plan', why: 'Starting a plan writes it into the brief and sends it to the session to run on its own.' },
  { m: 'POST', p: '/api/plan/pause', c: P, what: 'pause a plan', why: 'Pausing a plan is the person\'s call.' },
  { m: 'POST', p: '/api/plan/resume', c: P, what: 'resume a plan', why: 'Resuming lets a paused plan run on its own again.' },
  { m: 'POST', p: '/api/plan/stop', c: P, what: 'stop a plan', why: 'Stopping a plan is the person\'s call.' },
  { m: 'POST', p: '/api/plan/change', c: P, what: 'change a running plan', why: 'It opens the running plan for changes that Start then sends to the session.' },
  { m: 'POST', p: '/api/plan/draft', c: P, what: 'draft a plan', why: 'Ambiguous, so the safer class: it runs the planning model on the person\'s account for a plan they then start.' },
  { m: 'POST', p: '/api/plan/own', c: P, what: 'draft a plan', why: 'Ambiguous, so the safer class: as draft, from the person\'s own words.' },
  { m: 'POST', p: '/api/plan/revise', c: P, what: 'revise a plan draft', why: 'Ambiguous, so the safer class: it runs the planning model again on the person\'s comment.' },
  { m: 'POST', p: '/api/plan/edit', c: P, what: 'edit a plan draft', why: 'It answers the planner\'s questions and reorders or removes steps of the person\'s draft.' },
  { m: 'POST', p: '/api/plan/halt', c: P, what: 'halt a plan draft', why: 'It stops the planning run the person started.' },
  { m: 'POST', p: '/api/plan/discard', c: P, what: 'discard a plan draft', why: 'It throws the person\'s draft away.' },
  // Sessions
  { m: 'POST', p: '/api/send', c: P, what: 'type into a session from the board', why: 'The composer types the person\'s words into a session; an agent would answer its own prompts.' },
  { m: 'POST', p: '/api/sessions/start', c: P, what: 'start a session', why: 'Ambiguous, so the safer class: it starts an assistant on the person\'s account, with a first prompt.' },
  { m: 'POST', p: '/api/sessions/close', c: P, what: 'close sessions', why: 'Closing a session ends the assistant in it.' },
  { m: 'POST', p: /^\/api\/sessions\/[^/]+\/comment$/, eg: '/api/sessions/x/comment', doc: '/api/sessions/<id>/comment', c: P, what: 'comment on a session\'s work', why: 'It types the person\'s review comment into the session, as the composer does; an agent would steer another agent in the person\'s name.' },
  { m: 'POST', p: /^\/api\/sessions\/[^/]+\/merge$/, eg: '/api/sessions/x/merge', doc: '/api/sessions/<id>/merge', c: P, what: 'merge a session\'s work', why: 'Merging a session\'s branch into the project\'s is the person\'s call; an agent would merge its own work unreviewed.' },
  { m: 'POST', p: /^\/api\/sessions\/[^/]+\/discard$/, eg: '/api/sessions/x/discard', doc: '/api/sessions/<id>/discard', c: P, what: 'throw a session\'s work away', why: 'It deletes the session\'s worktree and branch, uncommitted changes included.' },
  { m: 'POST', p: /^\/api\/sessions\/[^/]+\/unmerge$/, eg: '/api/sessions/x/unmerge', doc: '/api/sessions/<id>/unmerge', c: P, what: 'undo a merge', why: 'It moves the project\'s branch back to before the merge and opens the session\'s work again: the person\'s call, as the merge was.' },
  { m: 'POST', p: /^\/api\/sessions\/[^/]+\/delete-branch$/, eg: '/api/sessions/x/delete-branch', doc: '/api/sessions/<id>/delete-branch', c: P, what: 'delete a session\'s branch', why: 'It deletes the branch a merged session kept, which ends the way to undo the merge.' },
  { m: 'POST', p: /^\/api\/sessions\/[^/]+\/review\/comment$/, eg: '/api/sessions/x/review/comment', doc: '/api/sessions/<id>/review/comment', c: P, what: 'comment on a session\'s work', why: 'A review comment is the person\'s word on an agent\'s work, which the session is then told; an agent would review its own work in the person\'s name.' },
  { m: 'POST', p: /^\/api\/sessions\/[^/]+\/review\/remove$/, eg: '/api/sessions/x/review/remove', doc: '/api/sessions/<id>/review/remove', c: P, what: 'take a review comment back', why: 'Ambiguous, so the safer class: it takes back what the person wrote before it was sent.' },
  { m: 'POST', p: /^\/api\/sessions\/[^/]+\/review\/send$/, eg: '/api/sessions/x/review/send', doc: '/api/sessions/<id>/review/send', c: P, what: 'send review comments', why: 'It types the person\'s review comments into the session, as the composer does; an agent would steer another agent in the person\'s name.' },
  { m: 'POST', p: /^\/api\/sessions\/[^/]+\/filmstrip$/, eg: '/api/sessions/x/filmstrip', doc: '/api/sessions/<id>/filmstrip', c: P, what: 'send a pane\'s last seconds to a session', why: 'It types into the session, as the composer does, and puts a file in the project\'s inbox; an agent would steer another agent in the person\'s name.' },
  { m: 'POST', p: '/api/sessions/reopen', c: P, what: 'reopen a session', why: 'Reopening starts an assistant again.' },
  { m: 'POST', p: '/api/project/revive', c: P, what: 'start a session', why: 'Revive and New session start an assistant, with the person\'s first message.' },
  { m: 'POST', p: '/api/handoff', c: P, what: 'decide a hand-off', why: 'A hand-off decision is the person\'s.' },
  { m: 'POST', p: '/api/handoff/start', c: P, what: 'start a hand-off', why: 'It ends a session\'s turn and starts the fresh session now.' },
  { m: 'POST', p: '/api/open', c: P, what: 'bring a tab forward', why: 'Ambiguous, so the safer class: it moves windows on the person\'s screen.' },
  // Rules
  { m: 'POST', p: /^\/api\/rules\/[\w.-]+$/, eg: '/api/rules/x', doc: '/api/rules/<id>', c: P, what: 'decide on a suggested rule', why: 'Saving a rule into CLAUDE.md or AGENTS.md changes what every session is told.' },
  { m: 'POST', p: /^\/api\/repeats\/[\w.-]+$/, eg: '/api/repeats/x', doc: '/api/repeats/<id>', c: P, what: 'decide on a suggested rule', why: 'Saving a repeated instruction as a rule changes CLAUDE.md or AGENTS.md.' },
  // Projects
  { m: 'POST', p: '/api/project/new', c: P, what: 'create a project', why: 'It makes a folder and a brief and starts a session.' },
  { m: 'POST', p: '/api/project/brief', c: P, what: 'write a brief', why: 'It writes the project\'s BRIEF.md from the sheet, the plan included.' },
  { m: 'POST', p: '/api/project/assistant', c: P, what: 'choose a project\'s assistant', why: 'A setting: which assistant the next sessions start.' },
  { m: 'POST', p: '/api/project/add-workspace', c: P, what: 'move a session into a project', why: 'Ambiguous, so the safer class: it changes which project a session belongs to.' },
  { m: 'POST', p: '/api/project/open-folder', c: P, what: 'open a folder in Finder', why: 'It opens a window on the person\'s screen.' },
  { m: 'POST', p: '/api/project/reveal-picture', c: P, what: 'show a picture in Finder', why: 'It opens a window on the person\'s screen.' },
  { m: 'POST', p: '/api/project/choose-folder', c: P, what: 'open the folder dialog', why: 'It opens a dialog on the person\'s screen.' },
  // Machines, setup, settings
  { m: 'POST', p: '/api/machines/add', c: P, what: 'add a machine', why: 'Adding a machine pairs this hub with it over ssh.' },
  { m: 'POST', p: '/api/machines/remove', c: P, what: 'remove a machine', why: 'Removing a machine is the person\'s call.' },
  { m: 'POST', p: '/api/machines/retry', c: P, what: 'reconnect a machine', why: 'Ambiguous, so the safer class: it runs ssh with the person\'s keys.' },
  { m: 'POST', p: '/api/machines/install', c: P, what: 'install Ravenry on a machine', why: 'It runs ssh with the person\'s keys and puts ravenryd and its hooks in Claude Code\'s and Codex\'s settings on another machine.' },
  { m: 'POST', p: '/api/machines/uninstall', c: P, what: 'uninstall Ravenry from a machine', why: 'It stops ravenryd on another machine, which can end the sessions there, and takes its files and hooks off.' },
  { m: 'POST', p: '/api/setup/hooks', c: P, what: 'install the hooks', why: 'It changes Claude Code\'s and Codex\'s settings.' },
  { m: 'POST', p: '/api/settings/handoff', c: P, what: 'change the hand-off settings', why: 'A setting the person chose; an agent could turn its own hand-off off.' },
  { m: 'POST', p: '/api/settings/assistant', c: P, what: 'change which assistant starts', why: 'A setting the person chose.' },
  { m: 'POST', p: '/api/settings/projects-root', c: P, what: 'change where projects go', why: 'A setting the person chose.' },
  // Phone and alerts
  { m: 'GET', p: '/api/phone', c: P, what: 'see the phone\'s pairing code', why: 'The code holds the phone\'s sign-in key: whoever has it acts as the phone.' },
  { m: 'POST', p: '/api/phone/new-key', c: P, what: 'pair the phone again', why: 'A new key signs the phone out.' },
  // The phone apps (docs/PHONE.md)
  { m: 'POST', p: '/api/phone/pair', c: P, what: 'pair a phone', why: 'Pairing gives a device the person\'s power. On the phone port the one-time code from the computer proves it is the person\'s phone; from this machine it is judged like every person row.' },
  { m: 'POST', p: '/api/phone/unpair', c: P, what: 'sign a phone out', why: 'It signs the device out, so its alerts stop: an agent could cut the person off.' },
  { m: 'POST', p: '/api/phone/push', c: P, what: 'change where a phone\'s alerts go', why: 'It sets where the device\'s alerts go: an agent could send the person\'s alerts to itself.' },
  { m: 'POST', p: '/api/phone/devices/rename', c: P, what: 'rename a phone', why: 'Ambiguous, so the safer class: it changes the name the person reads on the phone card and on the phone itself, which an agent could use to pass one device off as another.' },
  { m: 'POST', p: '/api/phone/devices/revoke', c: P, what: 'sign a phone out', why: 'Signing a device out is the person\'s call; an agent could cut the person off.' },
  { m: 'POST', p: '/api/phone/access', c: P, what: 'turn phone access on or off', why: 'Phone access opens a port on the home Wi-Fi and Tailscale for paired phones.' },
  { m: 'GET', p: '/api/term', c: P, what: 'open a terminal through the hub', why: 'It types into panes and reads their screens through the hub, which the daemons take as the person.' },
  { m: 'GET', p: '/api/alerts/setup', c: P, what: 'see the alert setup', why: 'It shows the alert channels\' tokens and topic.' },
  { m: 'POST', p: '/api/alerts/switch', c: P, what: 'turn phone alerts on or off', why: 'Ambiguous, so the safer class: an agent could silence the alerts that call the person.' },
  { m: 'POST', p: '/api/alerts/desktop', c: P, what: 'turn Mac notifications on or off', why: 'Ambiguous, so the safer class: as the switch.' },
  { m: 'POST', p: '/api/alerts/test', c: P, what: 'send a test alert', why: 'Ambiguous, so the safer class: it sends to the person\'s phone.' },
  { m: 'POST', p: /^\/api\/alerts\/(telegram|telegram\/find-chat|webhook|ntfy|ntfy\/new-topic|ntfy\/copy|done)$/, eg: '/api/alerts/webhook', doc: '/api/alerts/{telegram,telegram/find-chat,webhook,ntfy,ntfy/new-topic,ntfy/copy,done}', c: P, what: 'change where alerts go', why: 'An agent could send the person\'s alerts to itself.' },
  // Ideas
  { m: 'POST', p: '/api/ideas/add', c: O, why: 'Adding an idea: the person sees it on the Ideas page and decides.' },
  { m: 'POST', p: /^\/api\/ideas\/[\w-]+\/ref$/, eg: '/api/ideas/x/ref', doc: '/api/ideas/<id>/ref', c: O, why: 'Adds a reference picture to an idea; nothing is replaced.' },
  { m: 'POST', p: /^\/api\/ideas\/[\w-]+\/image$/, eg: '/api/ideas/x/image', doc: '/api/ideas/<id>/image', c: P, what: 'change an idea\'s picture', why: 'Ambiguous, so the safer class: it replaces the idea\'s picture.' },
  { m: 'POST', p: /^\/api\/ideas\/[\w-]+\/update$/, eg: '/api/ideas/x/update', doc: '/api/ideas/<id>/update', c: P, what: 'change an idea', why: 'Ambiguous, so the safer class: it rewrites what the person wrote. Adding one stays open.' },
  { m: 'POST', p: /^\/api\/ideas\/[\w-]+\/kill$/, eg: '/api/ideas/x/kill', doc: '/api/ideas/<id>/kill', c: P, what: 'drop an idea', why: 'Dropping an idea is the person\'s call.' },
  { m: 'POST', p: /^\/api\/ideas\/[\w-]+\/say$/, eg: '/api/ideas/x/say', doc: '/api/ideas/<id>/say', c: P, what: 'talk to an idea', why: 'Ambiguous, so the safer class: it runs a model on the person\'s account.' },
  { m: 'POST', p: '/api/ideas/brainstorm', c: P, what: 'start a brainstorm', why: 'Ambiguous, so the safer class: it runs a model on the person\'s account.' },
  { m: 'POST', p: '/api/ideas/brainstorm/clear', c: P, what: 'clear a brainstorm error', why: 'Ambiguous, so the safer class: it hides an error shown to the person.' },
  { m: 'POST', p: /^\/api\/ideas\/[\w-]+\/mockups$/, eg: '/api/ideas/x/mockups', doc: '/api/ideas/<id>/mockups', c: P, what: 'start mockups', why: 'Ambiguous, so the safer class: it runs a model on the person\'s account.' },
  { m: 'POST', p: /^\/api\/ideas\/[\w-]+\/mockups\/stop$/, eg: '/api/ideas/x/mockups/stop', doc: '/api/ideas/<id>/mockups/stop', c: P, what: 'stop mockups', why: 'It stops a run the person started.' },
  { m: 'POST', p: /^\/api\/ideas\/[\w-]+\/mockups\/pick$/, eg: '/api/ideas/x/mockups/pick', doc: '/api/ideas/<id>/mockups/pick', c: P, what: 'pick a mockup', why: 'Picking a variant is the person\'s taste.' },
  // Pages (server/pages.mjs, docs/PAGES.md)
  { m: 'POST', p: '/api/pages/check', c: O, why: 'Checks a page file\'s text and says what is wrong with it; writes nothing. Agents run it through `ravenry page check`.' },
  { m: 'POST', p: '/api/pages/item/create', c: O, why: 'Adds a new item file to a page\'s folder from its form; nothing is replaced (a taken name gets -2), and the person sees it on the page. An agent can write the same file itself.' },
  { m: 'POST', p: '/api/pages/item/set', c: P, what: 'change an item on a page', why: 'Ambiguous, so the safer class: it rewrites a field the person or their agent wrote (a status set to fixed is a decision), as an idea\'s update is.' },
  { m: 'POST', p: '/api/pages/item/toggle', c: P, what: 'tick a box on a page', why: 'Ticking a box says the thing is done: the person\'s call.' },
  { m: 'POST', p: '/api/pages/item/archive', c: P, what: 'archive an item on a page', why: 'It takes an item off the page (into .archive/), as dropping an idea is.' },
  { m: 'POST', p: '/api/pages/item/restore', c: P, what: 'bring an archived item back', why: 'Ambiguous, so the safer class: it undoes the person\'s archive.' },
  { m: 'POST', p: '/api/pages/trust', c: P, what: 'trust a page that came with a project', why: 'Trust turns on buttons someone else wrote; an agent would trust its own page.' },
  { m: 'POST', p: '/api/pages/approve', c: P, what: 'let a page ask an agent to work on its own', why: 'It lets a page type into a session and send it without the person seeing it first.' },
  { m: 'POST', p: '/api/pages/dismiss', c: P, what: 'hide a notice about a page', why: 'Ambiguous, so the safer class: it hides "changed since your copy", shown to the person.' },
  { m: 'POST', p: '/api/pages/customize', c: P, what: 'customize a page', why: 'Ambiguous, so the safer class: the copy takes the shipped page\'s place in the sidebar. An agent can write a page file itself.' },
  { m: 'POST', p: '/api/pages/ask', c: P, what: 'press a page\'s ask button', why: 'It types into a session, and a background ask sends it: what the composer does.' },
  { m: 'POST', p: '/api/pages/run', c: P, what: 'press a page\'s run button', why: 'Ambiguous, so the safer class: it puts a command in front of the person to approve as if they pressed the button (an agent asks with `ravenry approve` instead).' },
  // Notes, files, hooks
  { m: 'POST', p: '/api/review/reply', c: O, why: 'An agent answers a review comment (`ravenry review reply`): its words join the comment\'s thread for the person to read, and nothing runs. Only the pane of the session the comment is on may reply (403 otherwise).' },
  { m: 'POST', p: '/api/note', c: O, why: 'Adds a line under Notes in the brief.' },
  { m: 'POST', p: /^\/api\/inbox\/.+$/, eg: '/api/inbox/x', doc: '/api/inbox/<project>', c: O, why: 'Puts a file in the project\'s inbox folder; nothing is sent or run.' },
  { m: 'POST', p: '/api/hook-event', c: O, why: 'The hooks inside every session post it: it only makes the board look at events already on disk.' },
];

const matches = (r, method, p) => r.m === method && (typeof r.p === 'string' ? r.p === p : r.p.test(p));

// The row for a request, or null.
export function routeOf(method, p) {
  return ROUTES.find((r) => matches(r, method, p)) || null;
}

// The row a request must pass as the person, or null when it is open to
// every program. Any POST under /api/ that no row names is a person's.
export function personRoute(method, p) {
  const r = routeOf(method, p);
  if (r) return r.c === P ? r : null;
  if (method === 'POST' && p.startsWith('/api/')) return { m: method, p, c: P, what: 'do this', why: 'Not classed yet, so a person\'s.' };
  return null;
}

export const refusal = (r) => (r.p === '/api/checkpoints/answer' ? REFUSED : `Only a person can ${r.what}, in the Ravenry app or on the phone.`);

// Whether the request came from the person. `bin` is ravenryd. Without
// one nothing can be judged: `strict` (a checkpoint answer) refuses, and
// otherwise the request is taken when no ravenryd runs here either
// (`daemons()` lists the sockets of the board's runtime folder), since
// then no process of this machine is inside a pane: a board that drives
// cmux, iTerm2 or Rex only. Resolves to { ok, why }.
export async function fromPerson(req, bin, { strict = false, daemons = null } = {}) {
  const s = req.socket;
  if (req.mcPhone && !fromThisMachine(s && s.remoteAddress)) return { ok: true };
  // A pairing on the phone port from another address: its one-time code,
  // which the route checks, proves it (docs/PHONE.md section 3).
  if (req.mcTls && req.mcPairing && !fromThisMachine(s && s.remoteAddress)) return { ok: true };
  if (!bin) {
    if (strict || !daemons) return { ok: false, why: 'ravenryd is not installed, so the board cannot tell who sent it' };
    if ((await daemons()).length === 0) return { ok: true };
    return { ok: false, why: 'ravenryd runs here but the board cannot find its command, so it cannot tell who sent it' };
  }
  if (!s || !s.remotePort || !s.localPort) return { ok: false, why: 'the board cannot tell who sent it' };
  return new Promise((resolve) => {
    execFile(bin, ['peer', '--tcp', String(s.remotePort), '--to', String(s.localPort), '--json'], { timeout: 10000, maxBuffer: 1 << 20 }, (err, stdout) => {
      let r = null;
      try { r = JSON.parse(stdout); } catch { /* below */ }
      if (err || !r) return resolve({ ok: false, why: `the board cannot tell who sent it (ravenryd peer: ${err ? err.message.split('\n')[0] : 'no answer'})` });
      resolve(r.person ? { ok: true } : { ok: false, why: r.why || 'it did not come from a person' });
    });
  });
}

// The pane a request on this machine comes from, as `ravenryd peer` judges
// the process that holds the connection: { pane } (a pane id, or "?" when
// the daemon saw it in a pane it could not name), or { pane: null } for a
// process outside every pane, another machine, or nothing to judge with.
// Never from the request's body: a program cannot claim another pane.
export async function callerPane(req, bin) {
  const s = req.socket;
  if (!bin || !s || !s.remotePort || !s.localPort || !fromThisMachine(s.remoteAddress)) return { pane: null };
  return new Promise((resolve) => {
    execFile(bin, ['peer', '--tcp', String(s.remotePort), '--to', String(s.localPort), '--json'], { timeout: 10000, maxBuffer: 1 << 20 }, (err, stdout) => {
      let r = null;
      try { r = JSON.parse(stdout); } catch { /* below */ }
      resolve({ pane: !err && r && typeof r.pane === 'string' && r.pane ? r.pane : null });
    });
  });
}

// Whether an address is one of this machine's own.
export function fromThisMachine(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '');
  if (!a || a === '127.0.0.1' || a === '::1' || a.startsWith('127.')) return true;
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.address === a) return true;
  return false;
}
