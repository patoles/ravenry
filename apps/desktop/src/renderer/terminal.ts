// The terminal in the middle of the window: one xterm.js, attached to the
// pane on screen. Tabs that are not on screen run no xterm.js at all: the
// daemon keeps their screens, and showing one subscribes again, which
// starts with a fresh snapshot of its screen and scrollback.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { suppressTerminalQueries } from '@ravenry/client';
import type { PaneStream, RavenryClient } from '@ravenry/client';

export const THEME = {
  background: '#0B0B0C',
  foreground: '#D1D1D6',
  cursor: '#E5E5EA',
  cursorAccent: '#0B0B0C',
  selectionBackground: 'rgba(64, 156, 255, 0.35)',
  scrollbarSliderBackground: 'rgba(255, 255, 255, 0.10)',
  scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.18)',
  scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.24)',
  black: '#1C1C1E', red: '#FF6961', green: '#30D158', yellow: '#FFD60A',
  blue: '#409CFF', magenta: '#BF5AF2', cyan: '#64D2FF', white: '#D1D1D6',
  brightBlack: '#636366', brightRed: '#FF8A80', brightGreen: '#4CE07A', brightYellow: '#FFE066',
  brightBlue: '#6BB5FF', brightMagenta: '#DA8FFF', brightCyan: '#8AE0FF', brightWhite: '#F2F2F4',
};

const enc = new TextEncoder();

export interface Attached { client: RavenryClient; pane: string }

// macOS's terminals (Terminal.app, iTerm2, Ghostty) where xterm.js does
// otherwise: Cmd+arrows to the line's start and end, Cmd+Backspace to
// delete to its start, Option+arrows by word (xterm.js sends CSI 1;3D/C);
// and what the window does on Cmd (clear the scrollback, copy, paste,
// select all).
type KeyAct = 'clear' | 'copy' | 'paste' | 'select-all';
const MAC_CMD_SEND: Record<string, string> = { ArrowLeft: '\x01', ArrowRight: '\x05', Backspace: '\x15' };
const MAC_OPT_SEND: Record<string, string> = { ArrowLeft: '\x1bb', ArrowRight: '\x1bf' };
// Shift+Enter, everywhere: a newline in Claude Code and Codex instead of
// submitting (xterm.js sends CR, as for Enter). LF (Ctrl+J) is the newline
// both document; a shell takes it as Enter.
const SHIFT_SEND: Record<string, string> = { Enter: '\n' };
const MAC_CMD_ACT: Record<string, KeyAct> = { k: 'clear', c: 'copy', v: 'paste', a: 'select-all' };

export class TerminalView {
  readonly term: Terminal;
  readonly el: HTMLElement;
  private fit = new FitAddon();
  private webgl: WebglAddon | null = null;
  private stream: PaneStream | null = null;
  private current: Attached | null = null;
  /** Keys typed while a pane is being attached, sent once its stream is up. */
  private early: (string | Uint8Array)[] = [];
  private gen = 0;
  private sizeSent = '';
  private resizeQueued = false;
  /** Called when the pane on screen ended (its program exited or it was closed). */
  onEnded: (a: Attached) => void = () => {};
  /** Called after Enter is typed in the pane on screen. */
  onEnter: (a: Attached) => void = () => {};
  /** Shortcuts the app handles; xterm.js lets them through. */
  isAppKey: (e: KeyboardEvent) => boolean = () => false;
  /** What the window does with Cmd+K, C, V, A on a Mac (MAC_CMD_ACT). */
  onKeyAct: (act: KeyAct) => void = () => {};
  mac = false;
  /**
   * A frame was written: the output position the cursor stands at now
   * (marks.ts places an input's echo from it). `fresh` is a new pane on
   * screen (a snapshot starts over).
   */
  onWritten: (a: Attached, mark: number, snapshot: boolean) => void = () => {};
  /** The pane on screen changed (or none). */
  onShown: (a: Attached | null) => void = () => {};

  constructor(el: HTMLElement) {
    this.el = el;
    this.term = new Terminal({
      fontFamily: 'Menlo, "SF Mono", "DejaVu Sans Mono", "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: false,
      scrollback: 10000,
      allowProposedApi: true,
      theme: THEME,
      macOptionClickForcesSelection: true,
      drawBoldTextInBrightColors: false,
    });
    this.term.loadAddon(this.fit);
    const u = new Unicode11Addon();
    this.term.loadAddon(u);
    this.term.unicode.activeVersion = '11';
    // The daemon answers terminal queries; xterm.js must not answer them too.
    suppressTerminalQueries(this.term.parser);
    this.term.open(el);
    this.useWebgl();
    // xterm.js sends the keys itself, macOS's Option+arrows and
    // Option+Backspace included; the app's shortcuts go on to the menu
    // (isAppKey), except the few Cmd keys of macOS's terminals xterm.js
    // does not do (docs in apps/desktop/README.md, Keys).
    this.term.attachCustomKeyEventHandler((e) => {
      const only = this.mac && !e.ctrlKey && !e.shiftKey;
      const cmd = only && e.metaKey && !e.altKey;
      const shift = e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey;
      const send = cmd ? MAC_CMD_SEND[e.key] : only && e.altKey && !e.metaKey ? MAC_OPT_SEND[e.key] : shift ? SHIFT_SEND[e.key] : undefined;
      const act = cmd ? MAC_CMD_ACT[e.key.toLowerCase()] : undefined;
      if (!send && !act) return !this.isAppKey(e);
      if (e.type === 'keydown') { e.preventDefault(); if (send) this.input(send); else this.onKeyAct(act!); }
      return false;
    });
    this.term.onData((d) => {
      this.input(d);
      if (d.includes('\r') && this.current) this.onEnter(this.current);
    });
    this.term.onBinary((d) => {
      const b = new Uint8Array(d.length);
      for (let i = 0; i < d.length; i++) b[i] = d.charCodeAt(i) & 255;
      this.input(b);
    });
    // Paste goes through the daemon as one paste, so it is bracketed when
    // the program asked for that (it knows the program's modes), and unsafe
    // control characters are made harmless.
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const text = e.clipboardData?.getData('text/plain') || '';
      const a = this.current;
      if (text && a) void a.client.paste(a.pane, text).catch(() => {});
    }, true);
    new ResizeObserver(() => this.queueResize()).observe(el);
  }

  private useWebgl(): void {
    try {
      const w = new WebglAddon();
      w.onContextLoss(() => { w.dispose(); this.webgl = null; });
      this.term.loadAddon(w);
      this.webgl = w;
    } catch {
      this.webgl = null; // the DOM renderer draws instead
    }
  }

  private input(d: string | Uint8Array): void {
    if (this.stream) this.stream.input(d);
    else if (this.current) this.early.push(d);
  }

  get renderer(): string { return this.webgl ? 'webgl' : 'dom'; }
  /** True once the pane on screen streams (keys go straight to it). */
  get ready(): boolean { return !!this.stream && !this.stream.ended; }
  get attached(): Attached | null { return this.current; }

  focus(): void { this.term.focus(); }

  /** Shows a pane: drops the one on screen, then subscribes to this one at the terminal's size. */
  async show(a: Attached): Promise<void> {
    if (this.current && this.current.pane === a.pane && this.current.client === a.client && this.stream && !this.stream.ended) {
      this.focus();
      return;
    }
    const gen = ++this.gen;
    this.detachStream();
    this.early = [];
    this.current = a;
    this.term.reset();
    this.onShown(a);
    this.fitNow();
    const { cols, rows } = this.term;
    this.sizeSent = '';
    try {
      await a.client.request('pane.resize', { pane: a.pane, cols, rows });
      this.sizeSent = `${a.pane}:${cols}x${rows}`;
    } catch { /* an exited pane cannot resize; its screen still shows */ }
    if (gen !== this.gen) return;
    const s = await a.client.subscribe(a.pane, {
      data: (d, info) => {
        // Frames can come before this call returns; a stale stream's are dropped.
        if (gen !== this.gen) { info.ack(); return; }
        const end = info.snapshot ? info.mark : info.mark + d.byteLength;
        this.term.write(d, () => { info.ack(); if (gen === this.gen) this.onWritten(a, end, info.snapshot); });
      },
      end: () => { if (gen === this.gen) this.onEnded(a); },
    });
    if (gen !== this.gen) { void s.unsubscribe().catch(() => {}); return; }
    this.stream = s;
    for (const d of this.early.splice(0)) s.input(d);
    this.queueResize();
    this.focus();
  }

  /** Shows nothing: unsubscribes, so no xterm.js work runs for any pane. */
  hide(): void {
    this.gen++;
    this.detachStream();
    this.early = [];
    this.current = null;
    this.term.reset();
    this.onShown(null);
  }

  private detachStream(): void {
    const s = this.stream;
    this.stream = null;
    if (s && !s.ended) void s.unsubscribe().catch(() => {});
  }

  private fitNow(): void {
    if (!this.el.offsetWidth || !this.el.offsetHeight) return;
    try { this.fit.fit(); } catch { /* not laid out yet */ }
  }

  private queueResize(): void {
    if (this.resizeQueued) return;
    this.resizeQueued = true;
    requestAnimationFrame(() => {
      this.resizeQueued = false;
      this.fitNow();
      const a = this.current;
      if (!a || !this.stream) return;
      const key = `${a.pane}:${this.term.cols}x${this.term.rows}`;
      if (key === this.sizeSent) return;
      this.sizeSent = key;
      void a.client.request('pane.resize', { pane: a.pane, cols: this.term.cols, rows: this.term.rows }).catch(() => {});
    });
  }

  /** Bytes for the pane on screen, as if typed. */
  type(text: string): void { this.stream?.input(enc.encode(text)); }
}
