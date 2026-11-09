// Checkpoints as the window shows them (PROTOCOL.md section 4): an agent
// waits for a person to answer a question (ask), approve a command
// (approve) or type a secret (secret). The window hears of them from the
// daemons it holds (checkpoint.* events) and from the hub (every daemon's,
// remote ones too, in its state), and answers through the daemon when it
// holds one, else through the hub.
//
// Pure functions and a small store, so they are tested without a window.
// The cards themselves are drawn in cards.ts.
//
// A secret never passes through here except in SecretField.take(), whose
// caller hands it straight to the one answer call.

import type { Checkpoint, CheckpointReply } from '@ravenry/client';

/**
 * What a checkpoint says, worded by the hub (hub/server/cpwords.mjs, whose
 * header gives the shape and the rules for the tokens; hub/docs/
 * STATE-RULES.md, "What a checkpoint says"). The window draws them as they
 * come.
 */
export interface CheckpointWords {
  v: number;
  /** The checkpoint state these words describe. */
  state: string;
  kind: CardKind;
  who: string;
  whoMid: string;
  head: string;
  body: string | null;
  checks: { text: string | null; checks: string[] };
  heading: string;
  top: string;
  mark: { kind: CardKind; text: string; code: boolean; label: string };
  machine: { remote: boolean; here: string; away: string; line: string };
  runLabel: string;
  warnings: Warning[];
  guess: { label: string; rules: { pattern: string; flags: string; text: string }[] } | null;
  secret: { noun: string; to: string | null } | null;
  drive: {
    action: string; wants: string; once: string; session: string | null; sessionSub: string | null; row: string; title: string; pane: string;
    phone: { title: string; what: string | null; yes: { allow: 'once' | 'session'; label: string; sub: string | null; said: string }[] };
  } | null;
  variants: { letter: string; name: string; says: string | null }[];
  after: After | null;
}

/** A checkpoint as the hub lists it: the daemon's, plus where it runs, whose session asked, and its words. */
export interface HubCheckpoint extends Checkpoint {
  /** A page's run button opened it: the person pressed it, no agent asked. */
  page?: { title: string; label: string } | null;
  machine?: string | null;
  projectId?: string | null;
  project?: string | null;
  surfaceId?: string | null;
  /** The hub's words for it; a daemon's copy has none, or ones made for an earlier state. */
  words?: CheckpointWords;
}

export type CardKind = 'ask' | 'approve' | 'secret' | 'drive' | 'pick' | 'other';

export const OPEN_STATES = new Set(['open', 'running']);
export const isOpen = (cp: Checkpoint): boolean => OPEN_STATES.has(cp.state);
const STAGE = (cp: Checkpoint): number => (cp.state === 'open' ? 0 : cp.state === 'running' ? 1 : 2);

export function kindOf(cp: Checkpoint): CardKind {
  return cp.kind === 'ask' || cp.kind === 'approve' || cp.kind === 'secret' || cp.kind === 'drive' || cp.kind === 'pick' ? cp.kind : 'other';
}

/** The hub's words, when they were made for the checkpoint's state as this window holds it; else null (they are asked for). */
export function wordsOf(cp: HubCheckpoint): CheckpointWords | null {
  return cp.words && cp.words.state === cp.state ? cp.words : null;
}

/** "waiting 2 min", "waiting 1 h", "just now". */
export function waiting(cp: Checkpoint, now: number): string {
  const ms = now - Date.parse(cp.created_at);
  if (!(ms >= 60000)) return 'just now';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `waiting ${m} min`;
  const h = Math.floor(m / 60);
  return `waiting ${h} h`;
}

/** "18:04" today, else "Sat 18:04". */
export function timeOf(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === new Date(now).toDateString()) return hm;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm}`;
}

export function givesUp(cp: Checkpoint, now: number): string {
  const t = timeOf(cp.expires_at, now);
  return t ? `Gives up at ${t}` : '';
}

/** How a client fills the words' tokens (hub/server/cpwords.mjs): who it is and where it runs. */
export interface Reader {
  /** The `by` its answers carry ("desktop", "phone"). */
  me: string;
  /** It runs on the hub's computer. */
  onHub: boolean;
  /** Says an ISO time against its own clock. */
  time(iso: string | null): string;
  /** The pane's name as it shows it, for {pane}. */
  pane?: string | null;
}

/** The words with their tokens filled, by the hub's fixed rule. */
export function fill(text: string, w: CheckpointWords, r: Reader): string {
  return String(text || '')
    .replace(/\{machine\}/g, r.onHub ? w.machine.here : w.machine.away)
    .replace(/\{where\}/g, w.after ? (w.after.where.by === r.me ? w.after.where.mine : w.after.where.other) : '')
    .replace(/\{time\}/g, w.after ? r.time(w.after.at) : '')
    .replace(/\{pane\}/g, r.pane || (w.drive ? w.drive.pane : ''));
}

/** One warning line on an approve card, with whose words it is. */
export interface Warning { from: 'agent' | 'ravenry'; label: string; text: string }

/**
 * The warnings for the command that would run: the hub's for the proposed
 * one; for the person's edit, the agent's own and the first of the hub's
 * guess rules that matches the edited text (words.guess), so the guess
 * follows each keystroke at once.
 */
export function warningsFor(cp: HubCheckpoint, w: CheckpointWords, command: string | null | undefined): Warning[] {
  if (command == null || command === cp.command || !w.guess) return w.warnings;
  const out = w.warnings.filter((x) => x.from === 'agent');
  const c = String(command);
  for (const r of w.guess.rules) {
    let re: RegExp | null = null;
    try { re = new RegExp(r.pattern, r.flags); } catch { re = null; }
    if (re && re.test(c)) { out.push({ from: 'ravenry', label: w.guess.label, text: r.text }); break; }
  }
  return out;
}

/** What a closed (or running) checkpoint's card says afterwards (words.after; tokens in head and text). */
export interface After {
  /** ok: green check; else grey. */
  ok: boolean;
  head: string;
  /** The time its header shows (ISO), said against the window's clock. */
  at: string | null;
  /** The question, small, above the answer (ask). */
  small: string | null;
  /** The answer or the secret's name, large. */
  big: string | null;
  /** The command, greyed (approve): the one that ran, edited or not. */
  command: string | null;
  /** The person edited the command before it ran. */
  edited: boolean;
  text: string;
  /** The pane the command ran in, to show it. */
  runPane: string | null;
  where: { by: string | null; mine: string; other: string };
}

/** The option a number key picks (1 is the first), or null. */
export function digitChoice(key: string, cp: Checkpoint): number | null {
  if (kindOf(cp) !== 'ask' || !/^[1-9]$/.test(key)) return null;
  const i = Number(key) - 1;
  return cp.options && i < cp.options.length ? i : null;
}

/** Where an edited command differs from the proposed one: [start, end) in the edited text, or null. */
export function changedRange(orig: string, edited: string): [number, number] | null {
  if (orig === edited) return null;
  let s = 0;
  while (s < orig.length && s < edited.length && orig[s] === edited[s]) s++;
  let e = 0;
  while (e < orig.length - s && e < edited.length - s && orig[orig.length - 1 - e] === edited[edited.length - 1 - e]) e++;
  return [s, edited.length - e];
}

/** Whether a typed secret can be sent: 4 to 4096 bytes on one line (PROTOCOL.md, checkpoint.answer). */
export function secretProblem(value: string): string | null {
  if (/[\r\n]/.test(value)) return 'A secret is one line.';
  const n = new TextEncoder().encode(value).length;
  if (n === 0) return 'Type or paste it first.';
  if (n < 4) return 'That is too short for a secret.';
  if (n > 4096) return 'That is longer than a secret can be (4 KiB).';
  return null;
}

export const characters = (n: number): string => `${n} character${n === 1 ? '' : 's'}`;

/**
 * The secret's field. The secret lives only in the input element: this
 * keeps no copy, clears the element when focus leaves it, and take() hands
 * the value to the one answer call and clears the element at once.
 */
export interface FieldLike {
  value: string;
  addEventListener(type: string, fn: () => void): void;
}

export class SecretField {
  readonly input: FieldLike;
  private onChange: () => void;

  constructor(input: FieldLike, onChange: () => void = () => {}) {
    this.input = input;
    this.onChange = onChange;
    // Focus left the field (another part of the window, another app, the
    // panel closed): what was typed goes.
    input.addEventListener('blur', () => this.clear());
    input.addEventListener('input', () => {
      // A paste with a line break at the end keeps the key, not the break.
      if (/[\r\n]+$/.test(input.value)) input.value = input.value.replace(/[\r\n]+$/, '');
      this.onChange();
    });
  }

  /** How many characters are in the field (never which). */
  get count(): number { return [...this.input.value].length; }

  get problem(): string | null { return secretProblem(this.input.value); }

  clear(): void {
    if (!this.input.value) return;
    this.input.value = '';
    this.onChange();
  }

  /** The secret, for the answer call only; the field is empty when this returns. */
  take(): string {
    const v = this.input.value;
    this.input.value = '';
    this.onChange();
    return v;
  }
}

/** POST /api/checkpoints/words's body: the copies as this window holds them, without their old words or any secret. */
export function wordsBody(cps: HubCheckpoint[]): { checkpoints: HubCheckpoint[] } {
  return {
    checkpoints: cps.map((cp) => {
      const { words: _w, ...rest } = cp;
      const a = rest.answer as (Record<string, unknown> & { secret?: unknown }) | null | undefined;
      if (a && 'secret' in a) { const { secret: _s, ...clean } = a; rest.answer = clean as never; }
      return rest;
    }),
  };
}

/** checkpoint.answer's params for the daemon (by: where the person answered). */
export function daemonAnswer(id: string, reply: CheckpointReply, by = 'desktop'): { checkpoint: string; by: string } & CheckpointReply {
  return { checkpoint: id, by, ...reply };
}

/** The hub's POST /api/checkpoints/answer body. */
export function hubAnswer(id: string, reply: CheckpointReply, by = 'desktop'): Record<string, unknown> {
  return { id, by, ...reply };
}

// ---------------------------------------------------------------- the store

/** One checkpoint the window knows, and how to answer it. */
export interface Known {
  cp: HubCheckpoint;
  /** The daemon this window holds it on (answered there), or null. */
  socket: string | null;
  /** The hub lists it (it alerts the phone, and can answer it). */
  hub: boolean;
  /** When this window saw it close (the card says so for a while). */
  closedSeen: number | null;
}

/**
 * The checkpoints this window knows: from its daemons' events and lists,
 * and from the hub's state. One entry per id; the hub adds where it runs
 * and whose session asked, a daemon adds the way to answer it directly.
 */
export class Checkpoints {
  readonly items = new Map<string, Known>();

  private put(cp: HubCheckpoint, from: { socket?: string; hub?: boolean }, now: number): { opened: boolean; closed: boolean } {
    const had = this.items.get(cp.id);
    // A checkpoint only moves on (open, running, closed): a late copy (the
    // hub's state from before the answer reached it) never reopens one.
    if (had && STAGE(cp) < STAGE(had.cp)) return { opened: false, closed: false };
    const merged: HubCheckpoint = had ? { ...had.cp, ...cp } : { ...cp };
    // The hub's extras survive a daemon event that lacks them.
    if (had) for (const k of ['machine', 'projectId', 'project', 'surfaceId'] as const) if (cp[k] === undefined && had.cp[k] !== undefined) merged[k] = had.cp[k] as never;
    const k: Known = {
      cp: merged,
      socket: from.socket ?? had?.socket ?? null,
      hub: !!from.hub || !!had?.hub,
      closedSeen: had?.closedSeen ?? null,
    };
    const wasOpen = had ? isOpen(had.cp) : false;
    if (!isOpen(merged) && k.closedSeen === null) k.closedSeen = now;
    // A drive or a pick has nothing more to say once answered: what the
    // agent then typed shows in the pane and its log, and a pick's answer is
    // the person's own. Its card leaves the panel at once.
    if (!isOpen(merged) && (merged.kind === 'drive' || merged.kind === 'pick')) k.closedSeen = -Infinity;
    this.items.set(cp.id, k);
    return { opened: !had && isOpen(merged), closed: !!had && wasOpen && !isOpen(merged) };
  }

  /** A checkpoint a daemon this window holds reported (an event or its list). */
  fromDaemon(socket: string, cp: Checkpoint, now = Date.now()): { opened: boolean; closed: boolean } {
    return this.put(cp, { socket }, now);
  }

  /** A closed checkpoint an answer returned. */
  update(cp: HubCheckpoint, now = Date.now()): void {
    this.put(cp, {}, now);
  }

  /**
   * The hub's open checkpoints (its state's `checkpoints`). Returns the ids
   * that are new, and those it listed before and no longer does while no
   * daemon of this window told how they ended (ask the hub).
   */
  fromHub(list: HubCheckpoint[] | null | undefined, now = Date.now()): { opened: string[]; gone: string[] } {
    const opened: string[] = [];
    const ids = new Set<string>();
    for (const cp of list || []) {
      if (!cp || typeof cp.id !== 'string') continue;
      ids.add(cp.id);
      if (this.put(cp, { hub: true }, now).opened) opened.push(cp.id);
    }
    const gone: string[] = [];
    for (const [id, k] of this.items) if (k.hub && isOpen(k.cp) && !ids.has(id) && !k.socket) gone.push(id);
    return { opened, gone };
  }

  /** A daemon went away: what was only known through it is forgotten. */
  dropDaemon(socket: string): void {
    for (const [id, k] of this.items) if (k.socket === socket) { if (k.hub) k.socket = null; else this.items.delete(id); }
  }

  get(id: string): Known | null { return this.items.get(id) || null; }

  // The words this window asked the hub for: id -> the state asked for and
  // until when not to ask again (Infinity while the ask is out).
  private asked = new Map<string, { state: string; until: number }>();

  /**
   * The checkpoints whose words this window lacks (a daemon's copy, or one
   * that moved on since its words were made), not asked for yet: the caller
   * asks the hub (POST /api/checkpoints/words, with wordsBody) and hands the
   * answer to setWords, or wordsFailed. Each is asked once per state.
   */
  wordsWanted(now = Date.now()): HubCheckpoint[] {
    const out: HubCheckpoint[] = [];
    for (const [id, k] of this.items) {
      if (wordsOf(k.cp)) continue;
      const a = this.asked.get(id);
      if (a && a.state === k.cp.state && now < a.until) continue;
      this.asked.set(id, { state: k.cp.state, until: Infinity });
      out.push(k.cp);
    }
    return out;
  }

  /** The hub's words, by id. Kept only for the state they describe; true when any was. */
  setWords(words: Record<string, CheckpointWords> | null | undefined): boolean {
    let any = false;
    for (const [id, w] of Object.entries(words || {})) {
      const k = this.items.get(id);
      const a = this.asked.get(id);
      if (a && w && a.state === w.state) this.asked.delete(id);
      if (!k || !w || w.state !== k.cp.state) continue;
      k.cp = { ...k.cp, words: w };
      any = true;
    }
    return any;
  }

  /** The hub did not answer: asked again after `retryMs`. */
  wordsFailed(cps: HubCheckpoint[], now = Date.now(), retryMs = 2000): void {
    for (const cp of cps) { const a = this.asked.get(cp.id); if (a) a.until = now + retryMs; }
  }

  /** Open ones, oldest first. */
  open(): Known[] {
    return [...this.items.values()].filter((k) => isOpen(k.cp)).sort((a, b) => (a.cp.created_at < b.cp.created_at ? -1 : 1));
  }

  /**
   * The checkpoint a pane's card shows: the open one (oldest first), else
   * the last one that closed while this window watched, until another
   * opens or `keepMs` passed.
   */
  forPane(pane: string, machine: string | null = null, now = Date.now(), keepMs = 30 * 60000): Known | null {
    const mine = [...this.items.values()].filter((k) => k.cp.pane === pane && (k.cp.machine || null) === (machine || null));
    const open = mine.filter((k) => isOpen(k.cp)).sort((a, b) => (a.cp.created_at < b.cp.created_at ? -1 : 1));
    if (open.length) return open[0];
    const closed = mine.filter((k) => k.closedSeen !== null && now - k.closedSeen < keepMs).sort((a, b) => (a.closedSeen! < b.closedSeen! ? 1 : -1));
    return closed[0] || null;
  }

  /** A closed card stops showing once its session moved on: called when the pane's agent reports again. */
  settle(pane: string, since: number): void {
    for (const k of this.items.values()) if (k.cp.pane === pane && !isOpen(k.cp) && k.closedSeen !== null && k.closedSeen < since) k.closedSeen = -Infinity;
  }

  /** Closed ones the window no longer needs. */
  prune(now = Date.now(), keepMs = 30 * 60000): void {
    for (const [id, k] of this.items) if (!isOpen(k.cp) && (k.closedSeen === null || now - k.closedSeen > keepMs)) { this.items.delete(id); this.asked.delete(id); }
  }
}
