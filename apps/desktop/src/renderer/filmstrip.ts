// The filmstrip (16, variant B): a sheet under the pane with its last
// seconds (the daemon keeps about 20 s of screens for every pane,
// PROTOCOL.md section 3), the frames along a track from "20 s ago" to
// "now", the ones that look wrong marked (a blank screen; a frame replaced
// within a moment of being drawn, so it was seen half drawn; a stretch the
// screen did not change while it was busy), step and play, Send to the
// agent that owns the pane, and Save as GIF. A clicked frame fills the pane
// with a "Showing hh:mm:ss" strip above it; the pane runs on underneath.

import type { FilmFrame, RavenryClient, Theme } from '@ravenry/client';
import { h, replace, svg } from './dom.ts';
import * as I from './icons.ts';

export interface FilmHost {
  now(): number;
  /** The terminal's colours and font size: frames look as the pane does live. */
  theme(): { theme: Theme; fontSize: number; scale: number };
  /** The live terminal's cell width, in CSS pixels. */
  cellWidth(): number | null;
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

export interface Frame { at: number; png: string; mark: number; tag: 'blank' | 'half' | null; still: number; box: Box | null; bg: string; change: Box | null; w: number; h: number }
/** Where a picture has something drawn, in fractions of it. */
export interface Box { x: number; y: number; w: number; h: number }

const LAST_MS = 20000;
/** A frame replaced sooner than this was seen half drawn. */
const HALF_MS = 130;
/** The screen not changing this long between changes is a stall. */
const STALL_MS = 2000;

/**
 * Marks the frames that look wrong (pure, for tests): blank ones, half drawn ones, and stalls between changes.
 * Half drawn: rows missing that the screens around it have drawn (the daemon's missing_rows), so a spinner
 * redrawn ten times a second is not; from an older daemon, which does not count them, replaced within 130 ms.
 */
export function analyse(frames: { at: number; blank: boolean; missing?: number }[], end: number): { tag: 'blank' | 'half' | null; still: number }[] {
  return frames.map((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].at : null;
    const lasted = (next ?? end) - f.at;
    const half = f.missing !== undefined ? f.missing > 0 : next !== null && lasted < HALF_MS;
    const tag = f.blank && i > 0 ? 'blank' as const : half ? 'half' as const : null;
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
  private scale = 1;
  /** The font size the frames were drawn at, in their pixels. */
  private drawnAt = 13;

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
      const look0 = this.host.theme();
      // Drawn at the screen's pixel ratio and shown at half (on a 2x
      // screen), so a frame is as large and as sharp as the pane's text.
      this.scale = Math.max(1, Math.min(3, look0.scale));
      this.drawnAt = Math.min(48, look0.fontSize * this.scale);
      const r = await c.request('pane.frames', { pane, last_ms: LAST_MS, format: 'png', max_frames: 120, font_size: this.drawnAt, theme: look0.theme });
      if (this.pane !== pane) return;
      const end = this.host.now();
      const raw = (r.frames || []).filter((f): f is FilmFrame & { png: string } => !!f.png);
      const looks = await lookAll(raw.map((f) => f.png));
      const marks = analyse(raw.map((f, i) => ({ at: Date.parse(f.at), blank: !looks[i].box, missing: f.missing_rows })), end);
      this.frames = raw.map((f, i) => ({ at: Date.parse(f.at), png: f.png, mark: f.mark, ...marks[i], ...looks[i] }));
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
      // At the live text's size: each of the frame's cells (Go Mono's,
      // 0.6 em rounded, at the size the frames were drawn) as wide as the
      // terminal's, its 8 px margin taken off.
      const live = this.host.cellWidth();
      const cellPx = Math.round(0.6 * this.drawnAt);
      const k = live && cellPx ? live / (cellPx / this.scale) : 1;
      const natural = shown.w / this.scale;
      replace(over, h('img', { src: `data:image/png;base64,${shown.png}`, alt: `The pane at ${hhmmss(shown.at)}`, style: shown.w ? { width: `${natural * k}px`, maxWidth: 'none', margin: `${(-8 / this.scale) * k}px 0 0 ${(-8 / this.scale) * k}px` } : undefined }));
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
        h('div.fi2', { style: { background: f.bg } }, thumbImg(f, this.scale)),
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

const TW = 196, TH = 104;
/** A thumbnail shows its frame at this scale, so its text reads as the pane's does. */
const TSCALE = 0.8;

/**
 * A thumbnail: its frame at a readable scale, cropped to where it changed
 * from the frame before (the first: where anything is drawn), so each one
 * shows what happened then.
 */
function thumbImg(f: Frame, scale: number): HTMLElement {
  const img = h('img', { src: `data:image/png;base64,${f.png}`, alt: '' }) as HTMLImageElement;
  const at = f.change || f.box;
  if (!at || !f.w) return img;
  // In CSS pixels: the picture was drawn at the screen's pixel ratio.
  const W = f.w / scale, H = f.h / scale;
  const cw = TW / TSCALE, ch = TH / TSCALE;
  // The window around the change, kept inside the picture.
  const cx = (at.x + at.w / 2) * W, cy = (at.y + at.h / 2) * H;
  const left = Math.max(0, Math.min(W - cw, Math.min(at.x * W - 8, cx - cw / 2)));
  const top = Math.max(0, Math.min(H - ch, cy - ch / 2));
  Object.assign(img.style, { width: `${W * TSCALE}px`, height: `${H * TSCALE}px`, maxWidth: 'none', objectFit: 'fill', marginLeft: `${-left * TSCALE}px`, marginTop: `${-top * TSCALE}px` });
  return img;
}

interface Look { box: Box | null; bg: string; change: Box | null; w: number; h: number }

/**
 * What each frame holds, in order: the box where anything is drawn (null:
 * a blank screen), its background, and the box where it differs from the
 * frame before. One frame's pixels at a time beside the one before.
 */
async function lookAll(pngs: string[]): Promise<Look[]> {
  const out: Look[] = [];
  let prev: Uint8ClampedArray | null = null;
  let pw = 0, ph = 0;
  for (const png of pngs) {
    const img = await loadImage(png);
    if (!img) { out.push({ box: { x: 0, y: 0, w: 1, h: 1 }, bg: '#0B0B0C', change: null, w: 0, h: 0 }); prev = null; continue; }
    const w = img.width, hh = img.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = hh;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) { out.push({ box: { x: 0, y: 0, w: 1, h: 1 }, bg: '#0B0B0C', change: null, w, h: hh }); continue; }
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, w, hh).data;
    const [r, gg, b] = [d[0], d[1], d[2]];
    let x0 = w, y0 = hh, x1 = -1, y1 = -1, lit = 0;
    let cx0 = w, cy0 = hh, cx1 = -1, cy1 = -1;
    const same = prev && pw === w && ph === hh;
    for (let y = 0; y < hh; y += 2) for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - gg) + Math.abs(d[i + 2] - b) > 40) { lit++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (same && (Math.abs(d[i] - prev![i]) + Math.abs(d[i + 1] - prev![i + 1]) + Math.abs(d[i + 2] - prev![i + 2]) > 40)) { if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; if (y < cy0) cy0 = y; if (y > cy1) cy1 = y; }
    }
    // A lone cursor is not a drawing.
    const box = lit > 6 ? { x: x0 / w, y: y0 / hh, w: (x1 - x0 + 2) / w, h: (y1 - y0 + 2) / hh } : null;
    const change = cx1 >= 0 ? { x: cx0 / w, y: cy0 / hh, w: (cx1 - cx0 + 2) / w, h: (cy1 - cy0 + 2) / hh } : null;
    out.push({ box, bg: `rgb(${r}, ${gg}, ${b})`, change, w, h: hh });
    prev = d; pw = w; ph = hh;
  }
  return out;
}

function loadImage(png: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `data:image/png;base64,${png}`;
  });
}
