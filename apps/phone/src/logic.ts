// The phone board's own rules, as pure functions so they are tested without
// a page. What the hub decides (the sidebar, what a checkpoint says: its
// `words`, hub/server/cpwords.mjs) comes with its state instead.

import type { BoardGroup, Group, HubSession } from '../../desktop/src/renderer/model.ts';
import { sessionKey } from '../../desktop/src/renderer/model.ts';
import type { HubCheckpoint } from '../../desktop/src/renderer/checkpoints.ts';

/** The strip under the switch: one part per group, as wide as its sessions. */
export function strip(groups: BoardGroup[]): { group: Group; n: number }[] {
  return groups.filter((g) => g.count > 0).map((g) => ({ group: g.group, n: g.count }));
}

/** The open checkpoint a session waits on, if any. */
export function checkpointOf(cps: HubCheckpoint[], projectId: string, s: HubSession): HubCheckpoint | null {
  return cps.find((c) => c.state === 'open' && c.projectId === projectId && c.surfaceId === s.surfaceId) || null;
}

export { sessionKey };

/** The quick answers a session offers (its question's choices), at most four. */
export function quickAnswers(s: HubSession | null | undefined): { label: string; choice: number }[] {
  const q = (s && s.words && s.words.quick) || [];
  return q.filter((x) => x && x.label && Number.isInteger(x.choice) && !NOT_ANSWERS.test(x.label)).slice(0, 4).map((x) => ({ label: x.label, choice: x.choice as number }));
}

/** A menu's lines that open a field rather than answer: the reply field is for those. */
const NOT_ANSWERS = /^(type something|chat about this)/i;


/** The key bar: what each key sends to the pane. */
const CHEV = (d: string) => `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
export const KEYS: { label: string; icon?: string; bytes: string; red?: boolean; aria: string }[] = [
  { label: 'Esc', bytes: '\x1b', aria: 'Escape' },
  { label: 'Tab', bytes: '\t', aria: 'Tab' },
  { label: '', icon: CHEV('M10 3.5L5.5 8l4.5 4.5'), bytes: '\x1b[D', aria: 'Left' },
  { label: '', icon: CHEV('M3.5 10L8 5.5l4.5 4.5'), bytes: '\x1b[A', aria: 'Up' },
  { label: '', icon: CHEV('M3.5 6L8 10.5 12.5 6'), bytes: '\x1b[B', aria: 'Down' },
  { label: '', icon: CHEV('M6 3.5L10.5 8 6 12.5'), bytes: '\x1b[C', aria: 'Right' },
  { label: 'Enter', bytes: '\r', aria: 'Enter' },
  { label: 'Ctrl-C', bytes: '\x03', red: true, aria: 'Control C' },
];

/** The connection chip: this computer, then the machines it reaches. */
export function connLabel(hub: string, machines: { name: string; state: string }[]): string {
  const up = machines.filter((m) => m.state === 'connected').map((m) => m.name);
  return [hub, ...up].join(' + ');
}

/** "10:58". */
export function hhmm(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "0:07". */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** How long a checkpoint has waited and how much of its time is gone. */
export function waitOf(cp: HubCheckpoint, now: number): { label: string; until: string | null; pct: number } {
  const start = Date.parse(cp.created_at);
  const end = cp.expires_at ? Date.parse(cp.expires_at) : NaN;
  const m = Math.max(0, Math.floor((now - start) / 60000));
  const label = m < 1 ? 'Waiting since just now' : m < 60 ? `Waiting ${m} min` : `Waiting ${Math.floor(m / 60)} h ${m % 60} min`;
  const pct = Number.isFinite(end) && end > start ? Math.min(100, Math.max(2, ((now - start) / (end - start)) * 100)) : 0;
  return { label, until: Number.isFinite(end) ? hhmm(end) : null, pct };
}

/** What a photo or a voice note says when it lands in the session. */
export interface Drop { kind: 'photo' | 'voice'; name: string; path: string; ms?: number }

export function dropLine(o: { at: number; topic: string; answer: string | null; drops: Drop[]; note: string }): { head: string; lines: string[]; text: string } {
  const photos = o.drops.filter((d) => d.kind === 'photo');
  const voices = o.drops.filter((d) => d.kind === 'voice');
  const what = [photos.length ? (photos.length === 1 ? 'Photo' : `${photos.length} photos`) : null, voices.length ? (voices.length === 1 ? 'voice note' : `${voices.length} voice notes`) : null].filter(Boolean).join(' and ');
  const cap = what ? what.charAt(0).toUpperCase() + what.slice(1) : 'A note';
  const head = `${cap} from your phone, ${hhmm(o.at)}, sent to ${o.topic}`;
  const lines: string[] = [];
  if (o.answer) lines.push(`Answer: ${o.answer}`);
  const files = o.drops.map((d) => (d.kind === 'voice' ? `${d.name} (voice note ${mmss(d.ms || 0)})` : d.name));
  if (files.length) lines.push(files.join(', '));
  if (o.note.trim()) lines.push(o.note.trim());
  // What is typed into the session: one line, with the files' full paths so
  // the agent can open them.
  const parts = [head];
  if (o.answer) parts.push(`answer: ${o.answer}`);
  for (const d of o.drops) parts.push(d.kind === 'voice' ? `voice note ${mmss(d.ms || 0)} at ${d.path}` : `photo at ${d.path}`);
  if (o.note.trim()) parts.push(`note: ${o.note.trim()}`);
  return { head, lines, text: parts.join('; ') };
}

/** Back from a route: the parent route, or null at the top. */
export function parentOf(route: string): string | null {
  if (route === '' || route === '/') return null;
  if (route.startsWith('/fb/')) return `/cp/${route.slice(4)}`;
  return '/';
}

/** A distributor's package as people know it: io.heckel.ntfy is ntfy. */
export function distributorName(pkg: string | null | undefined): string | null {
  if (!pkg) return null;
  if (/ntfy/i.test(pkg)) return 'ntfy';
  if (/nextpush|nextcloud/i.test(pkg)) return 'NextPush';
  if (/sunup/i.test(pkg)) return 'Sunup';
  return pkg.split('.').pop() || pkg;
}

// ---------------------------------------------------------------- a pick

/** The part a finger drew around, as fractions of the picture (PROTOCOL.md section 4, pick): null when it is too small to mean a part. */
export function regionOf(points: [number, number][]): { x: number; y: number; w: number; h: number } | null {
  if (points.length < 2) return null;
  const c = (v: number) => Math.min(1, Math.max(0, v));
  const xs = points.map((p) => c(p[0]));
  const ys = points.map((p) => c(p[1]));
  const x = Math.min(...xs), y = Math.min(...ys);
  const w = Math.max(...xs) - x, h = Math.max(...ys) - y;
  if (w < 0.03 && h < 0.03) return null;
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return { x: r(x), y: r(y), w: r(Math.min(w, 1 - x)), h: r(Math.min(h, 1 - y)) };
}
