// Resume after a restart (SESS-053), the card in the middle of the window.
// The hub decides everything and sends the finished words in its state
// (`restart`, hub/server/restart.mjs cardView); this module only draws them
// (cardHtml), says what a click posts (postFor) and follows the card from
// one state to the next (RestartFollow): the tab of each session as it comes
// back, the first one in front once all are back, and the toast once.
// Pure: no DOM, so test/restart.test.ts runs it under node.

import { t } from '../shared/strings.ts';

export type RestartRowState = 'waiting' | 'next' | 'resuming' | 'back' | 'failed';
export type RestartPhase = 'offer' | 'resuming' | 'done';

export interface RestartRow {
  sessionId: string;
  projectId: string | null;
  project: string;
  topic: string | null;
  assistant: string;
  model: string | null;
  chip: string | null;
  ran: string | null;
  doing: string | null;
  midTurn: boolean;
  midTurnTag: string | null;
  midTurnNote: string | null;
  state: RestartRowState;
  stateWord: string | null;
  error: string | null;
  pane: string | null;
  surfaceId: string | null;
}

export interface RestartCard {
  id: string;
  phase: RestartPhase;
  count: number;
  back: number;
  title: string;
  body: string;
  bodyShort?: string;
  restartedAt?: string | null;
  rows: RestartRow[];
  resume: string;
  show: string;
  resumeAll: string;
  resumeAllBusy: boolean;
  dismiss: string;
  dismissNote: string | null;
  phoneNote?: string | null;
  toast: string | null;
  doneAt?: string | null;
}

/** The card from the hub's state, or null (none, or not one this client can draw). */
export function restartOf(state: unknown): RestartCard | null {
  const r = state && typeof state === 'object' ? (state as { restart?: unknown }).restart : null;
  if (!r || typeof r !== 'object') return null;
  const c = r as RestartCard;
  if (typeof c.id !== 'string' || !Array.isArray(c.rows) || !c.rows.length) return null;
  return c;
}

/** Whether the card is drawn: there is one and its sessions are not all back. */
export const cardShows = (r: RestartCard | null): r is RestartCard => !!r && r.phase !== 'done' && r.rows.length > 0;

/**
 * The card's sessions (their ids) that come to need the person without a
 * "needs you" toast: the card says them while it is on screen, and in the
 * state it goes (all back, the first in front and its own toast).
 */
export function quietSessions(prev: RestartCard | null, next: RestartCard | null): Set<string> {
  if (!cardShows(prev) && !cardShows(next)) return new Set();
  return new Set([...(prev?.rows || []), ...(next?.rows || [])].map((r) => r.sessionId));
}

const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// The icons, as the mockups draw them (currentColor: the CSS colours them).
const ICON = {
  restart: '<svg class="rc-i" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M11.6 1.8v2.9H8.7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  spin: '<svg class="rc-spin" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="2"/><path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.2 8.2l2 2 3.8-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  info: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 7.2v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="4.9" r="1" fill="currentColor"/></svg>',
};
export const CHECK_ICON = ICON.check;

/** A row's right side: Resume (waiting, failed with its error), Back + Show, Resuming..., Next. */
function rowRight(r: RestartRow, c: RestartCard): string {
  const sid = esc(r.sessionId);
  if (r.state === 'back') {
    return `<span class="rc-st ok">${ICON.check}${esc(r.stateWord)}</span>`
      + `<button class="rc-lk" data-act="show" data-sid="${sid}" aria-label="${esc(t('restart.showA11y', { project: r.project }))}">${esc(c.show)}</button>`;
  }
  if (r.state === 'resuming') return `<span class="rc-st run">${ICON.spin}${esc(r.stateWord)}</span>`;
  if (r.state === 'next') return `<span class="rc-st q">${esc(r.stateWord)}</span>`;
  return `<button class="btn sm rc-one" data-act="resume" data-sid="${sid}" aria-label="${esc(t('restart.resumeA11y', { project: r.project }))}">${esc(c.resume)}</button>`;
}

function rowHtml(r: RestartRow, c: RestartCard): string {
  const meta = [
    r.chip ? `<span class="rc-chip">${esc(r.chip)}</span>` : '',
    r.ran ? `<span>${esc(r.ran)}</span>` : '',
    r.ran && r.doing ? '<span class="rc-dot">·</span>' : '',
    r.doing ? `<span class="rc-doing">${esc(r.doing)}</span>` : '',
  ].join('');
  const note = r.midTurn && r.midTurnNote && r.state === 'waiting' ? `<div class="rc-note">${ICON.info}<span>${esc(r.midTurnNote)}</span></div>` : '';
  const err = r.state === 'failed' && r.error ? `<div class="rc-err">${esc(r.error)}</div>` : '';
  return `<div class="rc-row s-${esc(r.state)}" data-sid="${esc(r.sessionId)}">`
    + `<div class="rc-a"><span class="rc-pj">${esc(r.project)}</span>${r.topic ? `<span class="rc-tp">${esc(r.topic)}</span>` : ''}`
    + `${r.midTurn && r.midTurnTag ? `<span class="rc-tag">${esc(r.midTurnTag)}</span>` : ''}<span class="rc-sp"></span>${rowRight(r, c)}</div>`
    + `<div class="rc-b">${meta}</div>${note}${err}</div>`;
}

/** The card, as HTML (every word escaped, every word the hub's). */
export function cardHtml(c: RestartCard): string {
  const all = `<button class="btn pri rc-all" data-act="resume-all"${c.resumeAllBusy ? ' disabled' : ''}>${c.resumeAllBusy ? ICON.spin : ''}${esc(c.resumeAll)}</button>`;
  return `<section class="rc-card" role="region" aria-label="${esc(t('restart.a11y'))}" data-card="${esc(c.id)}" data-phase="${esc(c.phase)}">`
    + `<div class="rc-hd"><div class="rc-ic">${ICON.restart}</div><div class="rc-hx"><h2>${esc(c.title)}</h2><div class="rc-sub">${esc(c.body)}</div></div></div>`
    + `<div class="rc-rows">${c.rows.map((r) => rowHtml(r, c)).join('')}</div>`
    + `<div class="rc-acts">${all}<button class="btn rc-dis" data-act="dismiss">${esc(c.dismiss)}</button>${c.dismissNote ? `<span class="rc-fn">${esc(c.dismissNote)}</span>` : ''}</div>`
    + '</section>';
}

export type RestartAct = { act: 'resume-all' } | { act: 'resume'; sessionId: string } | { act: 'dismiss' } | { act: 'show'; sessionId: string };

/** What a click on the card's element with data-act (and data-sid) does; null when it is not one. */
export function actOf(act: string | null | undefined, sid: string | null | undefined): RestartAct | null {
  if (act === 'resume-all') return { act };
  if (act === 'dismiss') return { act };
  if ((act === 'resume' || act === 'show') && sid) return { act, sessionId: sid };
  return null;
}

/** The hub call a click makes (with the size a new pane gets), or null (Show posts nothing). */
export function postFor(a: RestartAct, size: { cols: number; rows: number }): { path: string; body: Record<string, unknown> } | null {
  if (a.act === 'resume-all') return { path: '/api/restart/resume', body: { cols: size.cols, rows: size.rows } };
  if (a.act === 'resume') return { path: '/api/restart/resume', body: { sessionId: a.sessionId, cols: size.cols, rows: size.rows } };
  if (a.act === 'dismiss') return { path: '/api/restart/dismiss', body: {} };
  return null;
}

/** Where a session that came back is: its board key (project/surface) and its ravenryd pane. */
export interface Back { sessionId: string; key: string; pane: string | null }

export function backOf(r: RestartRow): Back | null {
  if (r.state !== 'back' || (!r.pane && !r.surfaceId)) return null;
  const surface = r.surfaceId || (r.pane ? `ravenry:${r.pane}` : null);
  return { sessionId: r.sessionId, key: r.projectId && surface ? `${r.projectId}/${surface}` : '', pane: r.pane || (surface && surface.startsWith('ravenry:') ? surface.slice(8) : null) };
}

/**
 * Follows the card from one hub state to the next. Only a card this window
 * saw before its sessions were all back acts here (one already done when the
 * window opened has nothing to say): each session that comes back opens as
 * a tab, once (closed, it stays closed); when all are back, the first one
 * comes to the front and the toast is said, once per card.
 */
export class RestartFollow {
  private seen = new Set<string>();
  private opened = new Set<string>();
  private told = new Set<string>();

  step(r: RestartCard | null): { open: Back[]; front: Back | null; toast: string | null } {
    const out: { open: Back[]; front: Back | null; toast: string | null } = { open: [], front: null, toast: null };
    if (!r) return out;
    if (r.phase !== 'done') this.seen.add(r.id);
    if (!this.seen.has(r.id)) return out;
    for (const row of r.rows) {
      const b = backOf(row);
      const k = `${r.id}|${row.sessionId}`;
      if (!b || this.opened.has(k)) continue;
      this.opened.add(k);
      out.open.push(b);
    }
    if (r.phase === 'done' && !this.told.has(r.id)) {
      this.told.add(r.id);
      out.front = r.rows.map(backOf).find((b): b is Back => !!b) || null;
      out.toast = r.toast || null;
    }
    return out;
  }
}
