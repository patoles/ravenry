// What an agent, or the hub, typed into the pane on screen, marked beside
// the line it shows on: a thin bar in the terminal's right gutter, in the
// agent's colour, and its name and the time on hover. Nothing is ever
// painted over the cells (2026-11-07: a box over an unrelated line, and the
// label drawn on the text at the right). The person's own input (the
// window's typing and pastes, the phone's) is never marked: the host says
// so (who() is null). Every input, the person's included, stays in the
// panel's "Typed here" list.
//
// Where an input shows: the daemon logs each input with `mark`, the output
// position just before it. The terminal notes, after each frame it writes,
// which output position its cursor stands at; the echo of an input starts
// at or after the last such point before its mark, so its text is looked
// for from there. A program that redraws its region (Claude Code's input
// box) may never show the echo where it was typed: after a few frames the
// mark goes on the line the cursor stood on when the input came. An input
// from before the screen was attached (its mark is older than the
// snapshot) is looked for backwards from the snapshot. The marks are
// xterm.js decorations on a marker, so they follow scrolling and reflow;
// on the alternate screen (a full-screen program) none are placed.

import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';
import type { InputRecord } from '@ravenry/client';
import { echoParts } from './panes.ts';

interface Point { mark: number; marker: IMarker; x: number }

export interface MarkHost {
  /** "Claude", "Codex", "a program", with its colour class; null for the person (never marked). */
  who(r: InputRecord): { name: string; cls: string } | null;
  /** A note after the time: "you let it once". */
  note(r: InputRecord): string | null;
  /** "17:41". */
  time(iso: string): string;
}

const MAX_POINTS = 4000;
const LOOK_AHEAD = 40;
/** Frames after an input before its mark goes on the cursor's line instead of its echo's. */
const ECHO_FRAMES = 3;

export class TerminalMarks {
  private points: Point[] = [];
  private snapshotAt: Point | null = null;
  private placed = new Map<number, { marker: IMarker; deco: IDecoration | null; r: InputRecord; text: string }>();
  /** Marks whose text a redraw took off the screen: not placed again. */
  private gone = new Set<number>();
  private tries = new Map<number, number>();
  private pending: InputRecord[] = [];
  private queued = false;
  private records: InputRecord[] = [];

  private term: Terminal;
  private host: MarkHost;
  constructor(term: Terminal, host: MarkHost) {
    this.term = term;
    this.host = host;
    // The gutter is right of the last column: a resize puts each mark there again.
    term.onResize(() => { for (const [seq, p] of this.placed) { p.deco?.dispose(); this.placed.set(seq, { ...p, deco: this.gutter(p.marker, p.r) }); } });
  }

  /** A new pane on screen: everything starts over. */
  reset(): void {
    for (const p of this.placed.values()) { p.deco?.dispose(); p.marker.dispose(); }
    this.placed.clear();
    this.tries.clear();
    this.gone.clear();
    for (const p of this.points) p.marker.dispose();
    this.points = [];
    this.snapshotAt = null;
    this.pending = [];
    this.records = [];
  }

  /** A frame was written; the cursor stands at output position `mark`. */
  written(mark: number, snapshot: boolean): void {
    const b = this.term.buffer.active;
    const marker = this.term.registerMarker(0);
    if (!marker) return;
    const p = { mark, marker, x: b.cursorX };
    if (snapshot) {
      const rec = this.records;
      this.reset();
      this.records = rec;
      this.pending = rec.filter((r) => this.host.who(r));
      this.snapshotAt = p;
    }
    this.points.push(p);
    if (this.points.length > MAX_POINTS) this.points.splice(0, this.points.length - MAX_POINTS).forEach((x) => x.marker.dispose());
    if (this.pending.length || this.placed.size || snapshot) this.queue();
  }

  /** The pane's input log, oldest first: the agents' inputs get marked. */
  show(records: InputRecord[]): void {
    this.records = records;
    this.pending = records.filter((r) => !this.placed.has(r.seq) && !this.gone.has(r.seq) && this.host.who(r));
    this.queue();
  }

  private queue(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.place(); });
  }

  private lineText(y: number): string {
    return this.term.buffer.active.getLine(y)?.translateToString(true) || '';
  }

  /** Finds `text` from (y, x) on, within a few lines. */
  private findFrom(text: string, y: number, x: number): { y: number; x: number } | null {
    const b = this.term.buffer.active;
    for (let yy = y; yy < Math.min(b.length, y + LOOK_AHEAD); yy++) {
      const i = this.lineText(yy).indexOf(text, yy === y ? x : 0);
      if (i >= 0) return { y: yy, x: i };
    }
    return null;
  }

  /** Finds `text` before (y, x), nearest first. */
  private findBefore(text: string, y: number, x: number): { y: number; x: number } | null {
    for (let yy = y; yy >= 0; yy--) {
      const t = this.lineText(yy);
      const i = t.lastIndexOf(text, yy === y ? Math.max(0, x - text.length) : t.length);
      if (i >= 0) return { y: yy, x: i };
    }
    return null;
  }

  private place(): void {
    if (!this.snapshotAt) return;
    // A full-screen program owns the screen: nothing is marked on it.
    if (this.term.buffer.active.type === 'alternate') return;
    this.follow();
    const snap = this.snapshotAt;
    const left: InputRecord[] = [];
    // Before the snapshot: backwards, each before the one after it.
    let limit = { y: snap.marker.line, x: snap.x };
    const old = this.pending.filter((r) => r.mark < snap.mark).sort((a, b) => b.seq - a.seq);
    for (const r of old) {
      const parts = echoParts(r.text);
      if (!parts.length) continue;
      const found: { y: number; x: number; n: number }[] = [];
      let at = limit;
      for (const part of [...parts].reverse()) {
        const f = this.findBefore(part, at.y, at.x);
        if (!f) break;
        found.unshift({ ...f, n: part.length });
        at = f;
      }
      if (found.length === parts.length) { this.decorate(r, found); limit = found[0]; }
    }
    // After it: from the last point at or before its mark.
    for (const r of this.pending.filter((x) => x.mark >= snap.mark)) {
      const parts = echoParts(r.text);
      if (!parts.length) continue;
      let from: Point | null = null;
      for (const p of this.points) if (p.mark <= r.mark && !p.marker.isDisposed) from = p;
      if (!from) { left.push(r); continue; }
      const found: { y: number; x: number; n: number }[] = [];
      let at = { y: from.marker.line, x: from.x };
      for (const part of parts) {
        const f = this.findFrom(part, at.y, at.x);
        if (!f) break;
        found.push({ ...f, n: part.length });
        at = { y: f.y, x: f.x + part.length };
      }
      if (found.length === parts.length) { this.decorate(r, found); continue; }
      // A program that redraws may have put it above where it came (Claude
      // Code moves a sent line from its input box up into the transcript).
      const lastPart = parts[parts.length - 1];
      const b = this.term.buffer.active;
      const up = lastPart.length > 1 ? this.findBefore(lastPart, b.baseY + b.cursorY, b.cursorX + 1) : null;
      if (up && up.y >= from.marker.line - LOOK_AHEAD) { this.decorate(r, [{ ...up, n: lastPart.length }]); continue; }
      // Its echo has not come yet, or the program redrew it away: after a
      // few frames, the line the cursor stood on when it came.
      const n = (this.tries.get(r.seq) || 0) + 1;
      this.tries.set(r.seq, n);
      if (n >= ECHO_FRAMES && this.points.some((p) => p.mark > r.mark)) this.decorate(r, [{ y: from.marker.line, x: from.x, n: 1 }]);
      else left.push(r);
    }
    this.pending = left;
  }

  private decorate(r: InputRecord, found: { y: number; x: number; n: number }[]): void {
    if (!this.host.who(r)) return;
    const b = this.term.buffer.active;
    const here = b.baseY + b.cursorY;
    // Anchored to the last line it shows on.
    const last = found[found.length - 1];
    const marker = this.term.registerMarker(last.y - here);
    if (!marker) return;
    this.tries.delete(r.seq);
    const parts = echoParts(r.text);
    // What must stay on that line: its echo (none when placed by the cursor).
    const text = found.length === parts.length && last.n > 1 ? parts[parts.length - 1] : '';
    this.placed.set(r.seq, { marker, deco: this.gutter(marker, r), r, text });
  }

  /**
   * A program that redraws (Claude Code's input box) moves or wipes what
   * was typed: a mark follows its text to the nearest line that shows it,
   * and goes when no line does (the panel's "Typed here" keeps it).
   */
  private follow(): void {
    const b = this.term.buffer.active;
    const bottom = b.length;
    for (const [seq, p] of this.placed) {
      if (!p.text || p.marker.isDisposed) continue;
      const y = p.marker.line;
      if (y < bottom - 400) continue; // long scrolled away: nothing redraws there
      if (this.lineText(y).includes(p.text)) continue;
      let best = -1;
      for (let yy = Math.max(0, y - LOOK_AHEAD); yy < Math.min(bottom, y + LOOK_AHEAD); yy++) {
        if (this.lineText(yy).includes(p.text) && (best < 0 || Math.abs(yy - y) < Math.abs(best - y))) best = yy;
      }
      p.deco?.dispose();
      p.marker.dispose();
      this.placed.delete(seq);
      if (best < 0) { this.gone.add(seq); continue; }
      const marker = this.term.registerMarker(best - (b.baseY + b.cursorY));
      if (!marker) { this.gone.add(seq); continue; }
      this.placed.set(seq, { ...p, marker, deco: this.gutter(marker, p.r) });
    }
  }

  /** The bar in the right gutter beside the marker's line, and its label on hover. */
  private gutter(marker: IMarker, r: InputRecord): IDecoration | null {
    const w = this.host.who(r);
    if (!w || marker.isDisposed) return null;
    // A cell-wide decoration on the last column that paints nothing itself:
    // its children sit outside it, in the gutter (app.css .am-gut).
    const d = this.term.registerDecoration({ marker, x: this.term.cols - 1, width: 1, layer: 'top' });
    if (!d) return null;
    const note = this.host.note(r);
    d.onRender((el) => {
      el.classList.add('am');
      if (el.firstChild) return;
      const bar = document.createElement('i');
      bar.className = `am-gut ${w.cls}`;
      const label = document.createElement('span');
      label.className = 'am-lbl';
      const name = document.createElement('b');
      name.className = w.cls;
      name.textContent = w.name;
      label.append(name, ` ${this.host.time(r.at)}${note ? `, ${note}` : ''}`);
      bar.append(label);
      el.append(bar);
    });
    return d;
  }

  /** What it holds, for tests. */
  debug(): unknown {
    return { points: this.points.length, snapshot: this.snapshotAt ? { mark: this.snapshotAt.mark, line: this.snapshotAt.marker.line, x: this.snapshotAt.x } : null, pending: this.pending.map((r) => [r.seq, r.mark, r.text]), records: this.records.map((r) => [r.seq, r.mark, r.source.kind, r.text]), placed: this.marked };
  }

  /** Each mark's line as the screen shows it now, for tests. */
  lines(): { seq: number; line: number; text: string }[] {
    return [...this.placed].filter(([, p]) => !p.marker.isDisposed).map(([seq, p]) => ({ seq, line: p.marker.line, text: this.lineText(p.marker.line) }));
  }

  /** The records shown now, for tests. */
  get marked(): number[] { return [...this.placed.keys()]; }
  get known(): InputRecord[] { return this.records; }
}
