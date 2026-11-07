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
import { assistantName } from './model.ts';

/** A checkpoint as the hub lists it: the daemon's, plus where it runs and whose session asked. */
export interface HubCheckpoint extends Checkpoint {
  /** A page's run button opened it: the person pressed it, no agent asked. */
  page?: { title: string; label: string } | null;
  machine?: string | null;
  projectId?: string | null;
  project?: string | null;
  surfaceId?: string | null;
}

export type CardKind = 'ask' | 'approve' | 'secret' | 'drive' | 'pick' | 'other';

export const OPEN_STATES = new Set(['open', 'running']);
export const isOpen = (cp: Checkpoint): boolean => OPEN_STATES.has(cp.state);
const STAGE = (cp: Checkpoint): number => (cp.state === 'open' ? 0 : cp.state === 'running' ? 1 : 2);

export function kindOf(cp: Checkpoint): CardKind {
  return cp.kind === 'ask' || cp.kind === 'approve' || cp.kind === 'secret' || cp.kind === 'drive' || cp.kind === 'pick' ? cp.kind : 'other';
}

/** Who waits: "Claude", "Codex", else "The agent". */
export function who(cp: Checkpoint): string {
  return assistantName(cp.assistant) || 'The agent';
}

/** Who waits, mid-sentence: "Claude", "Codex", else "the agent". */
export function whoMid(cp: Checkpoint): string {
  return assistantName(cp.assistant) || 'the agent';
}

/** A title's first line is what the person reads first; the rest explains it. */
export function splitTitle(title: string): { head: string; body: string | null } {
  const t = String(title || '').replace(/\r/g, '').trim();
  const i = t.indexOf('\n');
  if (i < 0) return { head: t, body: null };
  const body = t.slice(i + 1).trim();
  return { head: t.slice(0, i).trim(), body: body || null };
}

/** The card's top line. */
export function heading(cp: Checkpoint): string {
  const pg = (cp as HubCheckpoint).page;
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

/** What a drive asks to do, in the words its card and its row use. */
export function driveVerb(cp: Checkpoint): { action: string; wants: string; once: string; session: string | null; row: string } {
  switch (cp.drive?.action) {
    case 'close': return { action: 'close', wants: 'wants to close', once: 'Let it close', session: null, row: 'Wants to close' };
    case 'restart': return { action: 'restart', wants: 'wants to restart', once: 'Let it restart', session: 'Let it restart it when it needs to', row: 'Wants to restart' };
    case 'override': return { action: 'change', wants: 'wants to change', once: 'Let it change this', session: 'Let it change it when it needs to', row: 'Wants to change' };
    default: return { action: 'type', wants: 'wants to type', once: 'Let it type this', session: 'Let it use this pane', row: 'Wants to type in' };
  }
}

/**
 * A pick's variant label as a name and the agent's words about it: the
 * label up to its first ": " or ". " (as the phone board splits it), so
 * "Level: The hull stays flat" reads as Level, then Claude's words.
 */
export function variantLabel(label: string): { name: string; words: string | null } {
  const m = /^(.+?)(?::|\.)\s+(.+)$/.exec(String(label || '').trim());
  return m ? { name: m[1].trim(), words: m[2].trim() } : { name: String(label || '').trim(), words: null };
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

/** The machine a checkpoint runs on, for people: its name, or this computer. */
export function machineName(machine: string | null | undefined, platform: string): string {
  const m = machine && machine !== 'local' ? machine : null;
  return m || (platform === 'darwin' ? 'this Mac' : 'this computer');
}

export const isRemote = (machine: string | null | undefined): boolean => !!machine && machine !== 'local';

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function runLabel(machine: string | null | undefined, platform: string): string {
  return `Run on ${machineName(machine, platform)}`;
}

export function machineLine(machine: string | null | undefined, platform: string): string {
  return cap(machineName(machine, platform));
}

// What can't be taken back once it ran. Only the clear cases: a warning on
// everything would be read as noise.
const RISKS: [RegExp, string][] = [
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

/** A warning when the command does something that can't be taken back, else null. */
export function riskOf(command: string | null | undefined): string | null {
  const c = String(command || '');
  for (const [re, text] of RISKS) if (re.test(c)) return text;
  return null;
}

/** One warning line on an approve card, with whose words it is. */
export interface Warning { from: 'agent' | 'ravenry'; label: string; text: string }

/**
 * The warnings an approve card shows: the agent's own (`warning`, its
 * words, labelled as its), then Ravenry's guess from the command (labelled
 * as Ravenry's). Both show when both exist, so an agent's reassuring
 * "warning" never hides Ravenry's guess. `command` is the text that would
 * run (the edited one while the person edits it).
 */
export function warningsOf(cp: Checkpoint, command: string | null | undefined = cp.command): Warning[] {
  const out: Warning[] = [];
  const mine = String(cp.warning || '').trim();
  if (mine) out.push({ from: 'agent', label: `${who(cp)} warns:`, text: mine });
  const guess = riskOf(command);
  if (guess) out.push({ from: 'ravenry', label: 'Ravenry\'s guess:', text: guess });
  return out;
}

/** The command that ran (or runs): the person's edit when they made one, else the proposed one. */
export function ranCommand(cp: Checkpoint): string | null {
  return cp.answer?.command || cp.command || null;
}

/** The program a command runs and its plain words, for "Sent to wrangler secret put". */
export function shortCommand(command: string | null | undefined): string {
  const words = String(command || '').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && /^(?:npx|bunx|sudo|env|exec|command)$/.test(words[0])) words.shift();
  if (words.length > 1 && words[0] === 'pnpm' && words[1] === 'dlx') words.splice(0, 2);
  const out: string[] = [];
  for (const w of words) {
    if (out.length && !/^[a-z][a-z0-9:._-]*$/.test(w)) break;
    out.push(w);
    if (out.length === 3) break;
  }
  return out.join(' ');
}

/** "Wants the mail service API key": the secret's name as the sidebar row says it. */
export function wantsLine(title: string): string {
  const head = splitTitle(title).head;
  // A plain first word reads lower case mid-sentence; a name (GitHub,
  // OpenAI) or an acronym (AWS) keeps its case.
  const m = /^([A-Z][a-z]+)(\b.*)$/.exec(head);
  const name = m ? m[1].toLowerCase() + m[2] : head;
  return `Wants the ${name}`;
}

/** The mark on a sidebar row: what kind of answer waits, and its words. */
export interface Mark { kind: CardKind; text: string; code: boolean }

export function markOf(cp: Checkpoint): Mark {
  const k = kindOf(cp);
  if (k === 'approve') return { kind: k, text: String(cp.command || '').split('\n')[0], code: true };
  if (k === 'secret') return { kind: k, text: wantsLine(cp.title), code: false };
  if (k === 'pick') return { kind: k, text: `Pick one of ${cp.variants?.length || 'the'}: ${splitTitle(cp.title).head}`, code: false };
  return { kind: k, text: splitTitle(cp.title).head, code: false };
}

/** "6 s", "1 min 20 s", "12 min". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 10 && r) return `${m} min ${r} s`;
  return `${m} min`;
}

const byText = (by: string | undefined, here: string): string =>
  by === here ? 'here' : by === 'phone' ? 'on your phone' : by ? `from ${by}` : 'here';

/** What a closed (or running) checkpoint's card says afterwards. */
export interface After {
  /** ok: green check; else grey. */
  ok: boolean;
  head: string;
  time: string;
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
}

export function afterOf(cp: HubCheckpoint, now: number, platform: string, here = 'desktop'): After {
  const w = who(cp);
  const a = cp.answer;
  const time = timeOf(cp.closed_at || a?.at || null, now);
  const base: After = { ok: false, head: '', time, small: null, big: null, command: null, edited: false, text: '', runPane: null };
  const where = machineName(cp.machine, platform);
  if (cp.state === 'cancelled') return { ...base, head: 'Withdrawn', text: `${w} withdrew it${cp.reason ? `: ${cp.reason}` : '.'}` };
  if (cp.state === 'expired') return { ...base, head: 'Nobody answered', text: `${w} gave up waiting at ${time || timeOf(cp.expires_at, now)}.` };
  if (cp.state === 'declined' || a?.declined) {
    const why = a?.reason ? `: "${a.reason}"` : '';
    return { ...base, head: 'Refused', small: kindOf(cp) === 'ask' ? splitTitle(cp.title).head : null, command: kindOf(cp) === 'approve' ? cp.command || null : null, text: `You said no ${byText(a?.by, here)}${why}. ${w} was told.` };
  }
  const k = kindOf(cp);
  if (k === 'ask') {
    const answer = a?.option ?? a?.text ?? (a?.choice != null && cp.options ? cp.options[a.choice] : null);
    return { ...base, ok: true, head: 'Answered', small: splitTitle(cp.title).head, big: answer ?? null, text: `You answered ${byText(a?.by, here)}.` };
  }
  if (k === 'approve') {
    const edited = !!a?.command;
    const approved = edited ? `You edited it and approved it ${byText(a?.by, here)}` : `You approved it ${byText(a?.by, here)}`;
    if (cp.state === 'running') {
      return { ...base, ok: true, head: `Running on ${where}`, time: timeOf(a?.at, now), command: ranCommand(cp), edited, text: `${approved}. ${w} gets the output when it ends${edited ? ', and is told you changed it' : ''}.`, runPane: cp.run?.pane || null };
    }
    const exit = cp.run?.exit;
    const took = a?.at && cp.closed_at ? duration(Date.parse(cp.closed_at) - Date.parse(a.at)) : null;
    const how = !exit ? (cp.reason ? `It did not run: ${cp.reason}.` : 'It ended.')
      : exit.code === 0 ? `Finished${took ? ` in ${took}` : ''} with no errors.`
        : exit.signal ? `Stopped by ${exit.signal}${took ? ` after ${took}` : ''}.`
          : `Ended with exit code ${exit.code}${took ? ` after ${took}` : ''}.`;
    return { ...base, ok: !!exit && exit.code === 0, head: `Ran on ${where}`, command: ranCommand(cp), edited, text: `${how} ${approved}; ${whoMid(cp)} has the output${edited ? ' and knows you changed it' : ''}.`, runPane: cp.run?.pane || null };
  }
  if (k === 'secret') {
    const to = cp.secret?.to === 'input' ? 'the program in its pane' : shortCommand(cp.command) || 'its command';
    return { ...base, ok: true, head: 'Secret sent', big: splitTitle(cp.title).head, text: `Sent to ${to}. Ravenry didn't keep a copy, so it can't be shown again. To change it, ${whoMid(cp)} has to ask again.` };
  }
  if (k === 'drive') {
    const v = driveVerb(cp);
    const session = a?.allow === 'session';
    const did = v.action === 'type' ? (session ? 'You let it use the pane until its session ends' : 'You let it type this, once') : `You let it ${v.action} it${session ? ' when it needs to, until its session ends' : ', once'}`;
    return { ...base, ok: true, head: 'Allowed', text: `${did} ${byText(a?.by, here)}.` };
  }
  if (k === 'pick') {
    const pk = (a as { pick?: { label?: string; note?: string; region?: unknown } } | null)?.pick;
    return { ...base, ok: true, head: 'Picked', small: splitTitle(cp.title).head, big: pk?.label ? `${pk.label}${pk.note ? `, with a note: "${pk.note}"` : ''}` : null, text: `You picked ${byText(a?.by, here)}.` };
  }
  return { ...base, ok: true, head: 'Answered', small: splitTitle(cp.title).head, text: `You answered ${byText(a?.by, here)}.` };
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
    for (const [id, k] of this.items) if (!isOpen(k.cp) && (k.closedSeen === null || now - k.closedSeen > keepMs)) this.items.delete(id);
  }
}
