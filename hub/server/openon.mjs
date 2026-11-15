// Where every client opens (2026-11-15, the maintainer: "on all platforms: it often
// opens for example on agent flow instead of the most recent session"):
// the project of the session the person used last, on any device. One rule,
// here; the Mac app, the board in a browser, the phone and the iPad only
// draw it. Sent in the state as `openOn`:
//
//   openOn: {
//     projectId,                 // a project in state.projects
//     surfaceId: string | null,  // its session, when that session is still there
//     key: string | null,        // "<projectId>/<surfaceId>", the sidebar's key
//     at: ISO,                   // when the person used it
//     why: 'typed' | 'answered' | 'opened' | 'active',
//     device: string | null,     // where it was opened ('mac', 'browser', 'phone', 'ipad')
//   } | null
//
// Used means, newest wins:
//   typed     the person wrote to the session (its transcript's last prompt
//             that was not a card's answer Ravenry typed: terminalanswer.personAt),
//             in any terminal or from the board's message box;
//   answered  the person answered one of its cards (the checkpoint's
//             answer.at), on the Mac, the board or the phone;
//   opened    a client said the person opened that project or session there
//             (POST /api/opened: a click in the sidebar, a tab, an alert tapped).
// When none is known: the session active last (its last hook event, else
// its state's time), why 'active'. A project that merely sorts first, or
// waits on someone, is never chosen for that.
//
// What clients do with it (docs/FEATURES.md NAV-012): at open (a launch, a
// window opened again, a page loaded or reloaded, the app back in front
// after a while) and when nothing more specific was asked (an alert tapped,
// a link to a project or card), they show openOn. A pick the person made
// on that device that the hub has not heard of (its POST failed) and that
// is newer than openOn.at wins on that device; nothing else of a device's
// own memory does.

import fs from 'node:fs';
import path from 'node:path';
import { RAVENRY_HOME, assertDataWrite } from './home.mjs';

export const FILE = path.join(RAVENRY_HOME, 'opened.json');
const DEVICE = /^[a-z][a-z0-9-]{0,31}$/;

let last; // { projectId, surfaceId, at, device } | null

function load() {
  if (last !== undefined) return;
  last = null;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (j && typeof j.projectId === 'string' && Number.isFinite(Date.parse(j.at))) last = { projectId: j.projectId, surfaceId: typeof j.surfaceId === 'string' ? j.surfaceId : null, at: j.at, device: typeof j.device === 'string' ? j.device : null };
  } catch { /* none yet */ }
}

/** The last open a client reported, or null. */
export function lastOpened() { load(); return last; }

/**
 * A client says the person opened a project (or one of its sessions) there.
 * `body`: { projectId, surfaceId?, device? }; `known(projectId)` says
 * whether the board has that project. Returns { ok, opened } or
 * { ok: false, status, error }.
 */
export function noteOpened(body, known, now = Date.now()) {
  load();
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.projectId !== 'string' || !b.projectId || b.projectId.length > 200) return { ok: false, status: 400, error: 'Send { projectId, surfaceId?, device? }.' };
  if (known && !known(b.projectId)) return { ok: false, status: 404, error: 'No such project on the board.' };
  const surfaceId = typeof b.surfaceId === 'string' && b.surfaceId && b.surfaceId.length <= 200 ? b.surfaceId : null;
  const device = typeof b.device === 'string' && DEVICE.test(b.device) ? b.device : null;
  last = { projectId: b.projectId, surfaceId, at: new Date(now).toISOString(), device };
  try {
    assertDataWrite(FILE);
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(last) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('opened:', e.message); }
  return { ok: true, opened: last };
}

const ms = (x) => (x == null ? NaN : typeof x === 'number' ? x : Date.parse(x));

/**
 * The project to open on, from the board's projects (state.projects).
 *   typedAt(project, session)  ms or ISO the person last wrote to it, or null
 *   activeAt(project, session) ms or ISO it was last active, or null
 *   checkpoints                every checkpoint the hub knows, closed ones too
 *   tabOf(checkpoint)          the surfaceId of the session that asked, or null
 *   opened                     lastOpened()
 */
export function pick(projects, { typedAt = () => null, activeAt = () => null, checkpoints = [], tabOf = () => null, opened = null } = {}) {
  const ps = (projects || []).filter((p) => p && p.id);
  const bySurface = new Map();
  for (const p of ps) for (const s of p.sessions || []) if (s && s.surfaceId && !bySurface.has(s.surfaceId)) bySurface.set(s.surfaceId, p);
  let best = null;
  const offer = (p, surfaceId, at, why, device = null) => {
    const t = ms(at);
    if (!p || !Number.isFinite(t)) return;
    if (best && best.t >= t) return;
    const has = surfaceId && (p.sessions || []).some((s) => s.surfaceId === surfaceId);
    best = { t, projectId: p.id, surfaceId: has ? surfaceId : null, why, device };
  };
  for (const p of ps) for (const s of p.sessions || []) offer(p, s.surfaceId, typedAt(p, s), 'typed');
  for (const cp of checkpoints || []) {
    const a = cp && cp.answer;
    if (!a || !a.at) continue;
    const sf = tabOf(cp);
    if (sf) offer(bySurface.get(sf), sf, a.at, 'answered');
  }
  if (opened && opened.projectId) offer(ps.find((p) => p.id === opened.projectId), opened.surfaceId, opened.at, 'opened', opened.device || null);
  if (!best) for (const p of ps) for (const s of p.sessions || []) offer(p, s.surfaceId, activeAt(p, s), 'active');
  if (!best) return null;
  return { projectId: best.projectId, surfaceId: best.surfaceId, key: best.surfaceId ? `${best.projectId}/${best.surfaceId}` : null, at: new Date(best.t).toISOString(), why: best.why, device: best.device };
}

// For tests.
export function _reset() { last = undefined; }
