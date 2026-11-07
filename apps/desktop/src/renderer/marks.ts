// What an agent typed into the pane on screen, marked where it shows (6,
// variant B): the exact keys it pressed are tinted in its colour, and its
// name and the time sit at the end of that line, with "you let it once"
// when a drive let that input through. The person's own typing stays
// plain. Nothing moves: the marks are xterm.js decorations over the cells,
// so the terminal keeps its width and its columns.
//
// Where an input shows: the daemon logs each input with `mark`, the output
// position just before it. The terminal notes, after each frame it writes,
// which output position its cursor stands at; the echo of an input starts
// at or after the last such point before its mark, so its text is looked
// for from there. An input from before the screen was attached (its mark
// is older than the snapshot) is looked for backwards from the snapshot.

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

export class TerminalMarks {
  private points: Point[] = [];
  private snapshotAt: Point | null = null;
  private placed = new Map<number, IDecoration[]>();
  private pending: InputRecord[] = [];
  private queued = false;
  private records: InputRecord[] = [];

  private term: Terminal;
  private host: MarkHost;
  constructor(term: Terminal, host: MarkHost) { this.term = term; this.host = host; }

  /** A new pane on screen: everything starts over. */
  reset(): void {
    for (const ds of this.placed.values()) for (const d of ds) d.dispose();
    this.placed.clear();
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
    if (this.pending.length || snapshot) this.queue();
  }

  /** The pane's input log, oldest first: the agents' inputs get marked. */
  show(records: InputRecord[]): void {
    this.records = records;
    this.pending = records.filter((r) => !this.placed.has(r.seq) && this.host.who(r));
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
      if (found.length === parts.length) this.decorate(r, found);
      else left.push(r); // its echo has not come yet
    }
    this.pending = left;
  }

  private decorate(r: InputRecord, found: { y: number; x: number; n: number }[]): void {
    const w = this.host.who(r);
    if (!w) return;
    const b = this.term.buffer.active;
    const here = b.baseY + b.cursorY;
    const ds: IDecoration[] = [];
    for (const f of found) {
      const m = this.term.registerMarker(f.y - here);
      if (!m) continue;
      const d = this.term.registerDecoration({ marker: m, x: f.x, width: Math.max(1, f.n), layer: 'top' });
      if (d) { d.onRender((el) => { el.classList.add('am', 'am-tint', w.cls); }); ds.push(d); }
    }
    // The name and the time at the end of the last line it shows on.
    const last = found[found.length - 1];
    const note = this.host.note(r);
    const label = `${w.name} ${this.host.time(r.at)}${note ? `, ${note}` : ''}`;
    const used = this.lineText(last.y).replace(/\s+$/, '').length;
    const cols = this.term.cols;
    const width = Math.min(cols - used - 1, Math.ceil(label.length * 0.86) + 1);
    if (width > 6) {
      const m = this.term.registerMarker(last.y - here);
      const d = m ? this.term.registerDecoration({ marker: m, x: cols - width, width, layer: 'top' }) : undefined;
      if (d) {
        d.onRender((el) => {
          el.classList.add('am', 'am-say');
          if (!el.firstChild) {
            const name = document.createElement('b');
            name.className = w.cls;
            name.textContent = w.name;
            el.append(name, `${this.host.time(r.at)}${note ? `, ${note}` : ''}`);
          }
        });
        ds.push(d);
      }
    }
    this.placed.set(r.seq, ds);
  }

  /** What it holds, for tests. */
  debug(): unknown {
    return { points: this.points.length, snapshot: this.snapshotAt ? { mark: this.snapshotAt.mark, line: this.snapshotAt.marker.line, x: this.snapshotAt.x } : null, pending: this.pending.map((r) => [r.seq, r.mark, r.text]), records: this.records.map((r) => [r.seq, r.mark, r.source.kind, r.text]), placed: this.marked };
  }

  /** The records shown now, for tests. */
  get marked(): number[] { return [...this.placed.keys()]; }
  get known(): InputRecord[] { return this.records; }
}
