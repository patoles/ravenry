// The sessions (picture 2): the top bar with the connection chip, the
// switch between Sessions and the sidebar's pages, the strip, then the same
// groups and rows as the desktop's sidebar, Needs you first, from every
// machine. A session waiting on a checkpoint opens the checkpoint.

import { h, replace, svg } from '../../desktop/src/renderer/dom.ts';
import * as DI from '../../desktop/src/renderer/icons.ts';
import { board, sessionKey } from '../../desktop/src/renderer/model.ts';
import type { BoardGroup, Group, ProjectRow, Row } from '../../desktop/src/renderer/model.ts';
import type { NavRow } from '../../desktop/src/renderer/pages.ts';
import * as I from './icons.ts';
import * as hub from './hub.ts';
import { current } from './shell.ts';
import { checkpointOf, connLabel, markLabel, marksOf, strip } from './logic.ts';
import { go } from './main.ts';
import type { Screen } from './main.ts';

const RING: Record<Group, string> = { you: DI.RING_YOU, work: DI.RING_WORK, wait: DI.RING_WAIT, idle: DI.RING_IDLE };
const COLOR: Record<Group, string> = { you: 'var(--you)', work: 'var(--work)', wait: 'var(--wait)', idle: 'var(--idle)' };

/** The app bar every top-level screen shares. */
export function appBar(): HTMLElement {
  const sh = current();
  const up = hub.live.link === 'up';
  const label = connLabel(sh.hello.hub.name, hub.live.machines);
  return h('header.ab',
    svg(I.LOGO), h('span.ab-t', 'Ravenry'), h('span.sp'),
    h('span.conn', { title: up ? 'Connected' : hub.live.error || 'Not connected' }, h(`span.sd${up ? '' : '.off'}`), label),
    h('button.icon-btn', { 'aria-label': 'Settings', on: { click: () => go('/settings') } }, svg(I.GEAR)));
}

/**
 * The switch: Sessions, then Plans and Ideas as the picture has them, then
 * every other page of the sidebar in its order (the board's own switch, as
 * it is today). More than fit scroll sideways.
 */
export function switchRows(): NavRow[] {
  const rows = ((hub.live.state as unknown as { pages?: NavRow[] } | null)?.pages || []);
  const first = ['plans', 'ideas'].map((id) => rows.find((r) => r.id === id && r.origin !== 'project')).filter((r): r is NavRow => !!r);
  return [...first, ...rows.filter((r) => !first.includes(r))];
}

export function views(on: string): HTMLElement {
  const seg = (key: string, label: string, n: number | null, to: string, err = false) =>
    h(`button.seg${on === key ? '.on' : ''}`, { 'data-key': key, on: { click: () => go(to, { replace: true }) } }, label, err ? h('span.errdot') : null, n ? h('span.c.num', String(n)) : null);
  const segs = h('div.segs', seg('sessions', 'Sessions', null, '/'),
    switchRows().map((r) => seg(r.key, r.label, r.number, `/p/${encodeURIComponent(r.key)}`, r.error)));
  // The page on screen in view, without scrolling anything else.
  requestAnimationFrame(() => { const el = segs.querySelector('.seg.on') as HTMLElement | null; if (el && segs.scrollWidth > segs.clientWidth) segs.scrollLeft = Math.max(0, el.offsetLeft + el.offsetWidth - segs.clientWidth + 3); });
  return h('div.views', segs);
}

function rowEl(p: ProjectRow, r: Row): HTMLElement {
  const cp = checkpointOf(hub.checkpoints(), p.project.id, r.session);
  const open = () => go(cp ? `/cp/${encodeURIComponent(cp.id)}` : `/s/${encodeURIComponent(sessionKey(p.project.id, r.session))}`);
  const q = r.mark
    ? h('div.ss-q', h('b', markLabel(r.mark.kind)), ' ', r.mark.code ? h('span.mono', r.mark.text) : r.mark.text)
    : r.line ? h('div.ss-q', r.line) : null;
  return h('button.ss', { on: { click: open } },
    h('div.ss-r', h('span.sd', { style: { background: COLOR[r.group] } }), h('span.n', r.name), r.assistant ? h('span.as-tag', r.assistant) : null,
      r.pct !== null ? h(`span.pc.num${r.pctWarn ? '.warn' : ''}`, `${r.pct}%`) : h('span.pc')),
    q);
}

function machineTag(m: string | null): HTMLElement | null {
  return m ? h('span.mt', svg(DI.MACHINE), m) : null;
}

function groupEl(g: BoardGroup): HTMLElement {
  const cnt = g.group === 'you' ? { background: 'var(--you)', color: '#1D1D1F' } : g.group === 'work' ? { background: 'var(--work)', color: '#FFFFFF' } : { background: 'var(--card2)', color: 'var(--tx2)' };
  const head = h('div.grp-h', { style: { color: g.group === 'idle' ? 'var(--tx2)' : COLOR[g.group] } }, svg(RING[g.group]), h('span.gt', g.title), h('span.cnt.num', { style: cnt }, String(g.count)));
  if (g.group === 'idle') {
    return h('section.grp.idle', head, g.projects.map((p) => {
      const s = p.project.sessions.find((x) => x.surfaceId === p.project.primary) || p.project.sessions[0];
      return h('button.idl', { on: { click: () => { if (s) go(`/s/${encodeURIComponent(sessionKey(p.project.id, s))}`); } } },
        h('span.n', p.project.name), machineTag(p.machine), h('span.tm.num', p.time));
    }));
  }
  return h(`section.grp.${g.group}`, head, g.projects.map((p) => [
    h('div.pj', h('span.n', p.project.name), machineTag(p.machine), h('span.tm.num', p.time)),
    p.rows.map((r) => rowEl(p, r)),
  ]));
}

export function sessionsScreen(): Screen {
  const el = h('div.scr.sessions');
  const update = () => {
    const st = hub.live.state;
    const groups = board(st, Date.now(), marksOf(hub.checkpoints()));
    const parts = strip(groups);
    const body = !st
      ? h('div.empty', hub.live.link === 'down' ? h('p', hub.live.error || 'The computer does not answer.') : h('p.t2', 'Reaching the computer...'))
      : !groups.length ? h('div.empty', h('p', 'No sessions yet.'), h('p.t2', 'Start one in Ravenry on the computer, and it shows here.'))
      : h('div.list', groups.map(groupEl));
    const top = el.querySelector('.scroll')?.scrollTop || 0;
    const scroll = h('div.scroll', body);
    replace(el, appBar(), views('sessions'),
      parts.length ? h('div.mix', parts.map((x) => h('span', { style: { flex: String(x.n), background: COLOR[x.group] } }))) : null,
      scroll);
    scroll.scrollTop = top;
  };
  update();
  return { el, update, dispose: () => {} };
}
