// The filmstrip (16, variant B): a sheet under the pane with its last
// seconds (the daemon keeps about 20 s of screens for every pane,
// PROTOCOL.md section 3), the frames along a track from "20 s ago" to
// "now", the ones that look wrong marked (a blank screen; a frame replaced
// within a moment of being drawn, so it was seen half drawn; a stretch the
// screen did not change while it was busy), step and play, Send to the
// agent that owns the pane, and Save as GIF. A clicked frame fills the pane
// with a "Showing hh:mm:ss" strip above it; the pane runs on underneath.

import type { FilmFrame, RavenryClient } from '@ravenry/client';
import { h, replace, svg } from './dom.ts';
import * as I from './icons.ts';

export interface FilmHost {
  now(): number;
  /** The client of the daemon that holds the pane. */
  client(pane: string): Promise<RavenryClient | null>;
  /** The agent to send it to ("Codex") and how, or null. */
  sendTo(pane: string): { who: string; send: (lastMs: number) => Promise<void> } | null;
  /** Saves a GIF the person can keep. */
  save(name: string, gifBase64: string): void;
  paneName(pane: string): string;
  toast(text: string): void;
  /** The sheet opened or closed, or a frame is shown: the middle redraws its strip. */
  changed(): void;
}

export interface Frame { at: number; png: string; mark: number; tag: 'blank' | 'half' | null; still: number; box: Box | null; bg: string }
/** Where a picture has something drawn, in fractions of it. */
export interface Box { x: number; y: number; w: number; h: number }

const LAST_MS = 20000;
/** A frame replaced sooner than this was seen half drawn. */
const HALF_MS = 130;
/** The screen not changing this long between changes is a stall. */
const STALL_MS = 2000;

/** Marks the frames that look wrong (pure, for tests): blank ones, half drawn ones, and stalls between changes. */
export function analyse(frames: { at: number; blank: boolean }[], end: number): { tag: 'blank' | 'half' | null; still: number }[] {
  return frames.map((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].at : null;
    const lasted = (next ?? end) - f.at;
    const tag = f.blank && i > 0 ? 'blank' as const : next !== null && lasted < HALF_MS ? 'half' as const : null;
    return { tag, still: next !== null && lasted >= STALL_MS ? lasted : 0 };
  });
}

export function summary(fs: { tag: string | null; still: number }[]): string {
  const half = fs.filter((f) => f.tag === 'half' || f.tag === 'blank').length;
  const stalls = fs.filter((f) => f.still);
  const parts: string[] = [];
  if (half) parts.push(`${half} frame${half > 1 ? 's' : ''} half drawn`);
  if (stalls.length) parts.push(stalls.length === 1 ? `1 stall of ${Math.round(stalls[0].still / 1000)} s` : `${stalls.length} stalls, the longest ${Math.round(Math.max(...stalls.map((s) => s.still)) / 1000)} s`);
  return parts.length ? parts.join(', ') : 'Nothing looks wrong';
}

const mmss = (t: number) => { const d = new Date(t); return `${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };
const hhmmss = (t: number) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${mmss(t)}`; };

export class Filmstrip {
  pane: string | null = null;
  frames: Frame[] = [];
  /** The frame on screen instead of the pane, or null for live. */
  shown: number | null = null;
  private sel = 0;
  private from = 0;
  private to = 0;
  private loading = false;
  private error: string | null = null;
  private playing: number | null = null;
  private area: Box | null = null;

  private sheet: HTMLElement;
  private strip: HTMLElement;
  private stage: HTMLElement;
  private host: FilmHost;
  constructor(sheet: HTMLElement, strip: HTMLElement, stage: HTMLElement, host: FilmHost) { this.sheet = sheet; this.strip = strip; this.stage = stage; this.host = host; }

  get open(): boolean { return !!this.pane; }

  async toggle(pane: string): Promise<void> {
    if (this.pane === pane) { this.close(); return; }
    await this.load(pane);
  }

  close(): void {
    this.stop();
    this.pane = null;
    this.frames = [];
    this.shown = null;
    this.paint();
    this.host.changed();
  }

  /** The pane on screen changed: the sheet belongs to the one it was opened on. */
  follow(pane: string | null): void { if (this.pane && pane !== this.pane) this.close(); }

  async load(pane: string): Promise<void> {
    this.stop();
    this.pane = pane;
    this.loading = true;
    this.error = null;
    this.shown = null;
    this.paint();
    this.host.changed();
    try {
      const c = await this.host.client(pane);
      if (!c) throw new Error('No daemon here holds that pane.');
      const r = await c.request('pane.frames', { pane, last_ms: LAST_MS, format: 'png', max_frames: 120, font_size: 13 });
      if (this.pane !== pane) return;
      const end = this.host.now();
      const raw = (r.frames || []).filter((f): f is FilmFrame & { png: string } => !!f.png);
      const looks = await Promise.all(raw.map((f) => look(f.png)));
      const marks = analyse(raw.map((f, i) => ({ at: Date.parse(f.at), blank: !looks[i].box })), end);
      this.frames = raw.map((f, i) => ({ at: Date.parse(f.at), png: f.png, mark: f.mark, ...marks[i], box: looks[i].box, bg: looks[i].bg }));
      // Thumbnails show the part of the pane where anything was drawn.
      this.area = union(this.frames.map((f) => f.box));
      this.from = end - LAST_MS;
      this.to = end;
      this.sel = Math.max(0, this.frames.findIndex((f) => f.tag) >= 0 ? this.frames.findIndex((f) => f.tag) : this.frames.length - 1);
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
      this.paint();
    }
  }

  /** Shows a frame in place of the pane. */
  showFrame(i: number): void {
    if (!this.frames[i]) return;
    this.sel = i;
    this.shown = i;
    this.paint();
    this.host.changed();
  }

  live(): void { this.stop(); this.shown = null; this.paint(); this.host.changed(); }

  private step(d: number): void { this.stop(); this.showFrame(Math.min(this.frames.length - 1, Math.max(0, (this.shown ?? this.sel) + d))); }

  private play(): void {
    if (this.playing !== null) { this.stop(); this.paint(); return; }
    let i = this.shown !== null && this.shown < this.frames.length - 1 ? this.shown : 0;
    const next = () => {
      this.showFrame(i);
      const f = this.frames[i], n = this.frames[i + 1];
      if (!n) { this.playing = null; this.paint(); return; }
      i++;
      this.playing = window.setTimeout(next, Math.min(1500, Math.max(60, n.at - f.at)));
    };
    this.playing = 0;
    next();
  }

  private stop(): void { if (this.playing) clearTimeout(this.playing); this.playing = null; }

  private async saveGif(): Promise<void> {
    const pane = this.pane!;
    try {
      const c = await this.host.client(pane);
      const r = await c!.request('pane.frames', { pane, last_ms: LAST_MS, format: 'gif', max_frames: 200 });
      if (!r.data) throw new Error('the daemon sent no animation');
      this.host.save(`${this.host.paneName(pane).replace(/[^\w.-]+/g, '-')}-${hhmmss(this.to).replace(/:/g, '')}.gif`, r.data);
    } catch (e) { this.host.toast(`Could not make the GIF: ${(e as Error).message}`); }
  }

  /** Draws the sheet, the "Showing" strip and the frame over the pane. */
  paint(): void {
    const pane = this.pane;
    this.sheet.hidden = !pane;
    const shown = this.shown !== null ? this.frames[this.shown] : null;
    this.strip.hidden = !shown;
    let over = this.stage.querySelector(':scope > .frame-view') as HTMLElement | null;
    if (shown) {
      if (!over) { over = h('div.frame-view'); this.stage.append(over); }
      over.style.background = shown.bg;
      replace(over, h('img', { src: `data:image/png;base64,${shown.png}`, alt: `The pane at ${hhmmss(shown.at)}` }));
      replace(this.strip, h('div.showing', svg(I.FILM), h('span', 'Showing ', h('b.num', hhmmss(shown.at)), `, ${Math.max(0, Math.round((this.host.now() - shown.at) / 1000))} s ago. The pane is still running underneath.`),
        h('button.btn.sm', { on: { click: () => this.live() } }, 'Back to live')));
    } else {
      over?.remove();
      replace(this.strip);
    }
    if (!pane) { replace(this.sheet); return; }
    const send = this.host.sendTo(pane);
    const head = h('div.fs-h', svg(I.FILM), h('b', 'Last 20 seconds'),
      h('span.t3', this.loading ? 'Reading the frames...' : this.error ? this.error : this.frames.length ? summary(this.frames) : 'It drew nothing new in that time.'),
      h('span.sp'),
      h('button.icon-btn.sm', { title: 'Previous frame', 'aria-label': 'Previous frame', on: { click: () => this.step(-1) } }, svg(I.LEFT)),
      h('button.icon-btn.sm.play', { title: this.playing !== null ? 'Pause' : 'Play', 'aria-label': 'Play', on: { click: () => this.play() } }, svg(this.playing !== null ? I.PAUSE : I.PLAY)),
      h('button.icon-btn.sm', { title: 'Next frame', 'aria-label': 'Next frame', on: { click: () => this.step(1) } }, svg(I.CHEVRON)),
      send ? h('button.btn.sm.pri', { disabled: !this.frames.length, on: { click: () => { void send.send(LAST_MS).then(() => this.host.toast(`Sent to ${send.who}.`), (e: Error) => this.host.toast(`Could not send it: ${e.message}`)); } } }, `Send to ${send.who}`) : null,
      h('button.btn.sm', { disabled: !this.frames.length, on: { click: () => void this.saveGif() } }, svg(I.DOWNLOAD), 'Save as GIF'),
      h('button.icon-btn.sm', { title: 'Close', 'aria-label': 'Close the filmstrip', on: { click: () => this.close() } }, svg(I.CLOSE)));
    const span = Math.max(1, this.to - this.from);
    const pos = (t: number) => `${Math.min(100, Math.max(0, ((t - this.from) / span) * 100))}%`;
    const cur = this.frames[this.shown ?? this.sel];
    const track = h('div.track',
      h('div.rail'),
      this.frames.filter((f) => f.still).map((f) => h('div.stall', { style: { left: pos(f.at), width: `${(f.still / span) * 100}%` } })),
      this.frames.filter((f) => f.tag).map((f) => h('div.bad', { style: { left: pos(f.at) } })),
      cur ? h('div.knob', { style: { left: pos(cur.at) } }) : null);
    const pick = pickThumbs(this.frames, 6, this.shown ?? this.sel);
    const thumbs = h('div.fstrip', pick.map((i) => {
      const f = this.frames[i];
      const tag = f.tag === 'blank' ? 'Blank' : f.tag === 'half' ? 'Half drawn' : f.still ? `Same ${Math.round(f.still / 1000)} s` : null;
      return h(`button.fthumb${(this.shown ?? this.sel) === i && this.shown !== null ? '.on' : ''}`, { title: `Show the pane at ${hhmmss(f.at)}`, on: { click: () => { this.stop(); this.showFrame(i); } } },
        h('div.fi2', { style: { background: f.bg } }, thumbImg(f.png, this.area)),
        h('div.fl2', h('span.num', mmss(f.at)), tag ? h('b', tag) : null));
    }));
    replace(this.sheet, h('div.fsheet', head, track, h('div.track-l', h('span', '20 s ago'), h('span', 'now')), thumbs));
  }
}

/** Up to n frames to show as thumbnails: the marked ones and the selected one first, then evenly between, in order. */
export function pickThumbs(frames: { tag: string | null; still: number }[], n: number, sel: number): number[] {
  if (frames.length <= n) return frames.map((_, i) => i);
  const want = new Set<number>([sel]);
  // The ones worth a look first: half drawn, a stall, then one blank.
  frames.forEach((f, i) => { if (f.tag === 'half' && want.size < n - 2) want.add(i); });
  frames.forEach((f, i) => { if (f.still && want.size < n - 1) want.add(i); });
  const blank = frames.findIndex((f) => f.tag === 'blank');
  if (blank >= 0 && want.size < n) want.add(blank);
  for (let k = 0; want.size < n && k < n * 4; k++) want.add(Math.round((k * (frames.length - 1)) / (n * 4 - 1)));
  return [...want].sort((a, b) => a - b).slice(0, n);
}

const TW = 124, TH = 78;

/** A thumbnail's picture, cropped to the area drawn in and scaled to fit. */
function thumbImg(png: string, area: Box | null): HTMLElement {
  const img = h('img', { src: `data:image/png;base64,${png}`, alt: '' }) as HTMLImageElement;
  if (!area) return img;
  img.addEventListener('load', () => {
    const W = img.naturalWidth, H = img.naturalHeight;
    const bw = Math.max(1, area.w * W), bh = Math.max(1, area.h * H);
    const k = Math.min(TW / bw, TH / bh);
    Object.assign(img.style, { width: `${W * k}px`, height: `${H * k}px`, maxWidth: 'none', objectFit: 'fill', marginLeft: `${-area.x * W * k}px`, marginTop: `${-area.y * H * k}px` });
  });
  return img;
}

function union(boxes: (Box | null)[]): Box | null {
  const bs = boxes.filter((b): b is Box => !!b);
  if (!bs.length) return null;
  const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y));
  const x1 = Math.max(...bs.map((b) => b.x + b.w)), y1 = Math.max(...bs.map((b) => b.y + b.h));
  const pad = 0.01;
  return { x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad), w: Math.min(1, x1 - x0 + 2 * pad), h: Math.min(1, y1 - y0 + 2 * pad) };
}

/** What a frame's picture holds: the box where anything is drawn (null: nothing, a blank screen) and its background colour. */
function look(png: string): Promise<{ box: Box | null; bg: string }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = Math.min(320, img.width), hh = Math.max(8, Math.round((img.height / img.width) * w));
      const c = document.createElement('canvas');
      c.width = w; c.height = hh;
      const g = c.getContext('2d');
      if (!g) { resolve({ box: { x: 0, y: 0, w: 1, h: 1 }, bg: '#0B0B0C' }); return; }
      g.drawImage(img, 0, 0, w, hh);
      const d = g.getImageData(0, 0, w, hh).data;
      const [r, gg, b] = [d[0], d[1], d[2]];
      let x0 = w, y0 = hh, x1 = -1, y1 = -1, lit = 0;
      for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - gg) + Math.abs(d[i + 2] - b) > 40) { lit++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      // A lone cursor is not a drawing.
      const box = lit > 12 ? { x: x0 / w, y: y0 / hh, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / hh } : null;
      resolve({ box, bg: `rgb(${r}, ${gg}, ${b})` });
    };
    img.onerror = () => resolve({ box: { x: 0, y: 0, w: 1, h: 1 }, bg: '#0B0B0C' });
    img.src = `data:image/png;base64,${png}`;
  });
}
