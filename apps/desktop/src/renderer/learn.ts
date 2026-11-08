// Learn Ravenry (E): a page the person opens when they want, from the ? in
// the sidebar's bottom row or Help, Learn Ravenry. It never opens by
// itself. Seven cards, each a still with a play mark, one line and an
// action; a card is ticked once the person used that part of Ravenry
// (used(), from where it happens), and there is no progress bar.
//
// "Try it" opens a session in the last folder used with a message ready in
// its input: nothing is sent until the person sends it.

import { h, replace, svg } from './dom.ts';

export type LearnKey = 'panes' | 'needs' | 'phone' | 'pick' | 'review' | 'film' | 'decisions';

export interface LearnCard {
  key: LearnKey;
  title: string;
  line: string;
  /** The message Try it puts in the new session's input, or null for an action of its own. */
  message: string | null;
  action: string;
  /** The session gets its own copy of the code (Review and merge). */
  worktree?: boolean;
}

export const LEARN_CARDS: LearnCard[] = [
  { key: 'panes', title: 'Panes beside your agent', line: 'Claude opens a terminal next to its own to run a server or a build, and you can watch or type in it.', message: 'Start this project in a Ravenry pane beside you and tell me what you see.', action: 'Try it' },
  { key: 'needs', title: 'Needs you', line: 'When an agent waits on you, it goes to the top with its question; answer here or on your phone.', message: 'Ask me through Ravenry which of this project’s open TODOs to look at first, with two or three options.', action: 'Try it' },
  { key: 'phone', title: 'Your phone', line: 'Pair it once and questions, picks and approvals reach you away from the desk.', message: null, action: 'Pair your phone' },
  { key: 'pick', title: 'Pick between pictures', line: 'An agent shows two to four looks side by side; pick one or circle the part you mean.', message: 'Sketch three quick ideas for this project as pictures in a scratch folder, don’t touch the code, and let me pick one in Ravenry.', action: 'Try it' },
  { key: 'review', title: 'Review and merge', line: 'A session working on its own copy of the code shows what it changed, and you merge it when it is right.', message: 'Work on your own copy of this project and fix one small thing you find. I’ll review it in Ravenry before it’s merged.', action: 'Try it', worktree: true },
  { key: 'film', title: 'The filmstrip', line: 'Scrub back through what a terminal showed, to see what happened while you were away.', message: null, action: 'Try it' },
  { key: 'decisions', title: 'Decisions', line: 'What you told an agent is kept word for word, so the next session follows it too.', message: 'From now on, keep commit messages to one line. Record that as my decision in Ravenry.', action: 'Try it' },
];

export interface LearnHost {
  used(): Partial<Record<LearnKey, boolean>>;
  tryIt(card: LearnCard): void;
  close(): void;
}

const PLAY = '<svg width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="11" fill="rgba(0,0,0,.72)"/><path d="M9 7l6 4-6 4z" fill="#FFF"/></svg>';
const QMARK = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="7" cy="7" r="5.8"/><path d="M5.4 5.4a1.7 1.7 0 0 1 3.2.6c0 1.1-1.6 1.3-1.6 2.3" stroke-linecap="round"/><circle cx="7" cy="10.2" r=".5" fill="currentColor" stroke="none"/></svg>';
const CLOSE = '<svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2 2l6 6M8 2l-6 6"/></svg>';
const TICK = '<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="6" fill="var(--ok)"/><path d="M3.4 6.2l1.8 1.8 3.4-3.6" stroke="#FFF" stroke-width="1.5" fill="none"/></svg>';

/** The still for a card: drawn, as in the design (docs/design: the onboarding round 3). */
function still(key: LearnKey): HTMLElement {
  const b = (cls: string, ...kids: (HTMLElement | null)[]) => h(`div.${cls}`, ...kids);
  switch (key) {
    case 'panes': return b('ln-s.panes', b('ln-t', b('ln-l.w60'), b('ln-l.w80'), b('ln-l.w40.or')), b('ln-t', h('span.ln-tag', 'Claude'), b('ln-l.w50.gr'), b('ln-l.w70')));
    case 'needs': return b('ln-s.needs', b('ln-side', b('ln-l.w30.or'), b('ln-l.w60'), b('ln-l.w50')), b('ln-card', b('ln-l.w70.hi'), b('ln-bar'), b('ln-bar'), b('ln-bar')), b('ln-ph', b('ln-dot.or')));
    case 'phone': return b('ln-s.phone', b('ln-qr'), b('ln-ph', b('ln-pill.or'), b('ln-pill.gr')));
    case 'pick': return b('ln-s.pick', b('ln-p.a'), b('ln-p.b.on'), b('ln-p.c'));
    case 'review': return b('ln-s.review', h('span.ln-tag.blue', 'Merge'), b('ln-l.w80.gr'), b('ln-l.w60.gr'), b('ln-l.w70'), b('ln-l.w50.rd'), b('ln-l.w65.gr'));
    case 'film': return b('ln-s.film', b('ln-fr', b('ln-f'), b('ln-f.on'), b('ln-f'), b('ln-f')), b('ln-scrub', b('ln-knob')));
    case 'decisions': return b('ln-s.dec', b('ln-dl'), b('ln-dl'), b('ln-dl'));
  }
}

export function renderLearn(el: HTMLElement, host: LearnHost, lit: LearnKey | null): void {
  const used = host.used();
  replace(el,
    h('div.ln-strip', h('div.ln-tab', svg(QMARK), h('span', 'Learn Ravenry'), h('button.x', { title: 'Close', 'aria-label': 'Close Learn Ravenry', on: { click: () => host.close() } }, svg(CLOSE)))),
    h('div.pg-b.ln-b',
      h('div.ln-h', h('h2', 'Learn Ravenry'), h('p', 'Short looks at what Ravenry adds to a session. “Try it” opens a session with a message ready for you to send; nothing runs until you do.')),
      h('div.ln-grid', LEARN_CARDS.map((c) => h(`div.ln-c${lit === c.key ? '.lit' : ''}`, { 'data-card': c.key },
        h('div.ln-pic', still(c.key), h('span.ln-play', svg(PLAY))),
        h('div.ln-txt',
          h('div.ln-ti', h('b', c.title), used[c.key] ? h('span.ln-used', svg(TICK), 'Used') : null),
          h('p', c.line),
          h('button.btn.sm', { 'data-try': c.key, on: { click: () => host.tryIt(c) } }, c.action)))))));
  if (lit) requestAnimationFrame(() => el.querySelector(`[data-card="${lit}"]`)?.scrollIntoView({ block: 'nearest' }));
}
