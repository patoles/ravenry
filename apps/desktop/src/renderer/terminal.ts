// The terminal in the middle of the window: one xterm.js, attached to the
// pane on screen. Tabs that are not on screen run no xterm.js at all: the
// daemon keeps their screens, and showing one subscribes again, which
// starts with a fresh snapshot of its screen and scrollback.

import { Terminal } from '@xterm/xterm';
import type { ILink, ILinkProvider } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import type { ISearchOptions } from '@xterm/addon-search';
import { macOptionIsMetaFor } from '../shared/settings.ts';
import type { TerminalSettings } from '../shared/settings.ts';
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
/** DEC mode 2026, synchronized output: nothing is drawn between the two. */
const SYNC_ON = '\x1b[?2026h';
const SYNC_OFF = '\x1b[?2026l';
const BSU = [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x68]; // ESC [ ? 2026 h
const ESU = [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x6c]; // ESC [ ? 2026 l
/** The longest a program's synchronized update is held before what came of it is shown (ms). */
const SYNC_MAX = 150;
/**
 * VS Code's terminal resize (TerminalResizeDebouncer): with this many lines
 * or more in the normal buffer a width change waits until the size has held
 * COLS_WAIT ms ("horizontal resize is expensive due to reflow"); rows change
 * at once.
 */
const DEBOUNCE_FROM_LINES = 200;
const COLS_WAIT = 100;
/**
 * A held update bigger than this is written in xterm.js's own time slices
 * (term.write), not in one task: Claude Code writes its whole transcript
 * again at each size, megabytes in a long session, and parsing that in one
 * go froze the window (2026-11-08, "a 1 second freeze on each resize").
 */
const SYNC_WRITE_MAX = 256 * 1024;
/** A held update written in slices goes in pieces this big: xterm.js yields between writes, not inside one. */
const SLICE = 16 * 1024;
/** A hidden terminal's new size waits for the size to hold this long, then for the window to be idle. */
const HIDDEN_WAIT = 500;

/** What the terminals did lately, for the line a long task writes in app.log (watchLongTasks). */
interface PerfNote { at: number; ms: number; what: 'resize' | 'write' | 'draw' | 'window'; pane?: string; size?: string; lines?: number; bytes?: number; sync?: boolean; hidden?: boolean }
const perfNotes: PerfNote[] = [];
function perfNote(n: PerfNote): void {
  perfNotes.push(n);
  if (perfNotes.length > 400) perfNotes.splice(0, 200);
}
let watching = false;

/**
 * Every task over `over` ms in this window writes one line to app.log:
 * whether the window was resized, each terminal resized (its pane, size,
 * buffer lines, ms in xterm.js), the bytes written in (and the ms when in
 * one go), the draws. Cheap: a few numbers kept for each resize and write.
 */
export function watchLongTasks(log: (line: string) => void, over = 100): void {
  if (watching) return;
  watching = true;
  window.addEventListener('resize', () => perfNote({ at: performance.now(), ms: 0, what: 'window', size: `${innerWidth}x${innerHeight}` }));
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < over) continue;
        const from = e.startTime - 1, to = e.startTime + e.duration + 1;
        const in_ = perfNotes.filter((n) => n.at >= from && n.at <= to);
        const win = perfNotes.some((n) => n.what === 'window' && n.at >= e.startTime - 1000 && n.at <= to);
        const r = in_.filter((n) => n.what === 'resize');
        const w = in_.filter((n) => n.what === 'write');
        const d = in_.filter((n) => n.what === 'draw');
        const ms = (x: number) => Math.round(x * 10) / 10;
        const sum = (xs: PerfNote[]) => ms(xs.reduce((a, n) => a + n.ms, 0));
        const known = sum(r) + sum(w) + sum(d);
        log(`perf: a ${Math.round(e.duration)} ms task; window resized in the last second: ${win ? 'yes' : 'no'}`
          + `; xterm.js resized: ${r.length ? r.map((n) => `${n.pane}${n.hidden ? ' (hidden)' : ''} ${n.size} ${n.lines} lines ${ms(n.ms)} ms`).join(', ') : 'none'}`
          + `; written in: ${w.length ? w.map((n) => `${n.pane} ${n.bytes} B${n.sync ? ` in one go ${ms(n.ms)} ms` : ' in slices'}`).join(', ') : 'none'}`
          + `; draws: ${d.length} ${sum(d)} ms; the rest: ${ms(Math.max(0, e.duration - known))} ms`);
      }
    }).observe({ type: 'longtask' });
  } catch { /* no long task timing here */ }
}

/** The last of BSU or ESU in b (from `from` on): 'on', 'off', or null. */
function lastSyncToken(b: Uint8Array, from = 0): 'on' | 'off' | null {
  for (let i = b.length - 8; i >= from; i--) {
    if (b[i] !== 0x1b || b[i + 1] !== 0x5b || b[i + 2] !== 0x3f) continue;
    let on = true, off = true;
    for (let k = 3; k < 8; k++) { if (b[i + k] !== BSU[k]) on = false; if (b[i + k] !== ESU[k]) off = false; }
    if (on) return 'on';
    if (off) return 'off';
  }
  return null;
}

export interface Attached { client: RavenryClient; pane: string }

// The Mac's usual terminal keys where xterm.js does
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
/**
 * Ctrl+Shift+C, V and A off the Mac: what Cmd+C, V and A do on one, done
 * here too. Left to the menu's copy, paste and select-all roles they acted
 * on xterm.js's hidden text field: select all never selected the
 * terminal's text, and a copy or paste went around the window's own
 * clipboard path (2026-11-16, the keys test on Linux).
 */
const CTRL_SHIFT_ACT: Record<string, KeyAct> = { c: 'copy', v: 'paste', a: 'select-all' };

/** Find's tints, for a dark terminal and a light one: every match, the current one amber, both on the scroll bar. */
const FIND_DECOR = {
  dark: { matchBackground: '#5A4A1C', matchOverviewRuler: '#C9A227', activeMatchBackground: '#FF9F0A', activeMatchColorOverviewRuler: '#FF9F0A' },
  light: { matchBackground: '#FFE9A8', matchOverviewRuler: '#C9A227', activeMatchBackground: '#FFB340', activeMatchColorOverviewRuler: '#FF9F0A' },
};

/** The terminal's text size (Cmd+= / Cmd+- / Cmd+0 change it, the window's stays). */
export const FONT_SIZE = { base: 13, min: 8, max: 32 };

/** A path as a shell reads it back: quoted when it needs to be. */
export function shellQuote(p: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Links open on Cmd+click (Ctrl+click off the Mac), and only these kinds. */
export function openableLink(uri: string): boolean {
  return /^(https?|file):\/\//i.test(uri);
}

export class TerminalView {
  readonly term: Terminal;
  readonly el: HTMLElement;
  private fit = new FitAddon();
  private search = new SearchAddon();
  /** The settings applied (docs/SETTINGS.md), null before the first. */
  private ts: TerminalSettings | null = null;
  /** The link under the pointer (for the right-click menu). */
  private hoverLink: string | null = null;
  /** The link under the pointer as xterm.js has it (its decorations change live), and the tip that says how to open it. */
  private hovered: ILink | null = null;
  private tip: HTMLElement;
  /** Cmd (Ctrl off the Mac) is held: links show as links, underlined, with a pointer. */
  private modHeld = false;
  private lastPointer: MouseEvent | null = null;
  private webgl: WebglAddon | null = null;
  private stream: PaneStream | null = null;
  private current: Attached | null = null;
  /** Keys typed while a pane is being attached, sent once its stream is up. */
  private early: (string | Uint8Array)[] = [];
  private gen = 0;
  private sizeSent = '';
  /** When the pane's program was last told a new size (performance.now()): what it prints just after is its redraw, not news. */
  sizedAt = 0;
  private resizeQueued = false;
  /** The width waiting for the size to hold (COLS_WAIT), and the latest size proposed. */
  private colsTimer: ReturnType<typeof setTimeout> | undefined;
  private proposed: { cols: number; rows: number } | null = null;
  /** Hidden (a pooled terminal, or the split hidden), its new size waits for it to show or the window to be idle, as VS Code does. */
  private fitPending = false;
  /** Shown in this frame or the next (shown()): a resize then is the layout of the view it came with, not a drag, so its columns do not wait. */
  private justShown = false;
  private shownSeq = 0;
  private idleFit = 0;
  /** Called when the pane on screen ended (its program exited or it was closed). */
  onEnded: (a: Attached) => void = () => {};
  /** Called after Enter is typed in the pane on screen. */
  onEnter: (a: Attached) => void = () => {};
  /** Shortcuts the app handles; xterm.js lets them through. */
  isAppKey: (e: KeyboardEvent) => boolean = () => false;
  /** What the window does with Cmd+K, C, V, A on a Mac (MAC_CMD_ACT), Ctrl+Shift+C, V, A elsewhere (CTRL_SHIFT_ACT). */
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
  /** A bell rang in the pane (on screen, or hidden in its pool). */
  onBell: () => void = () => {};
  /** The selection to copy (copy on select). */
  onCopy: (text: string) => void = () => {};
  /** A right click: the link under the pointer, if any. */
  onContextMenu: (link: string | null) => void = () => {};
  /** Find's count: the current match (0 with none) of how many. */
  onFindResults: (index: number, count: number) => void = () => {};
  /** A link was Cmd+clicked (an OSC 8 link or a URL in the text). */
  onOpenLink: (uri: string) => void = () => {};
  /** The path of a file dropped on the terminal (Electron's webUtils), or ''. */
  pathOf: (f: File) => string = () => '';
  /** Where each pane's view stood when it was last on screen: its first line, or the bottom. */
  private scrolls = new Map<string, number | 'bottom'>();
  /** A scroll to put back once the pane's snapshot is written (and, for a line, once the buffer reaches it). */
  private restoreTo: number | 'bottom' | null = null;
  private restoreUntil = 0;
  /** What moved the view lately (for tests: a restore that did not hold). */
  readonly scrollTrace: { t: number; what: string; y: number; base: number }[] = [];
  private trace(what: string): void {
    const b = this.term.buffer.active;
    this.scrollTrace.push({ t: Date.now(), what, y: b.viewportY, base: b.baseY });
    if (this.scrollTrace.length > 60) this.scrollTrace.shift();
  }

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
      // A right click opens the menu and selects nothing (Copy is off with no selection, as in Terminal.app).
      rightClickSelectsWord: false,
      drawBoldTextInBrightColors: false,
      // OSC 8 links (a program names the link): opened on Cmd+click.
      linkHandler: {
        activate: (e, uri) => this.link(e, uri),
        hover: (_e, uri) => { this.hoverLink = uri; },
        leave: () => { this.hoverLink = null; },
        allowNonHttpProtocols: true,
      },
    });
    // Plain URLs in the text: the same.
    this.term.loadAddon(new WebLinksAddon((e, uri) => this.link(e, uri), { hover: (_e, uri) => { this.hoverLink = uri; }, leave: () => { this.hoverLink = null; } }));
    this.term.loadAddon(this.search);
    this.search.onDidChangeResults((r) => this.onFindResults(r.resultCount ? r.resultIndex + 1 : 0, r.resultCount));
    this.term.onBell(() => this.onBell());
    this.term.onScroll(() => this.trace('scroll'));
    // Copy on select (a setting): the selection as soon as it is made.
    this.term.onSelectionChange(() => { if (this.ts?.copyOnSelect && this.term.hasSelection()) this.onCopy(this.term.getSelection()); });
    this.term.loadAddon(this.fit);
    const u = new Unicode11Addon();
    this.term.loadAddon(u);
    this.term.unicode.activeVersion = '11';
    // The daemon answers terminal queries; xterm.js must not answer them too.
    suppressTerminalQueries(this.term.parser);
    this.term.open(el);
    this.useWebgl();
    // Links are found out: hovering one says how it opens, holding Cmd
    // underlines it with a pointer (a plain click selects),
    // and a setting opens them on a plain click.
    this.tip = document.createElement('div');
    this.tip.className = 'link-tip';
    this.tip.hidden = true;
    el.appendChild(this.tip);
    this.decorateLinks();
    const mod = (e: KeyboardEvent | MouseEvent) => this.setModHeld(this.mac ? e.metaKey : e.ctrlKey);
    window.addEventListener('keydown', mod, true);
    window.addEventListener('keyup', mod, true);
    // In the capture phase, so the key's state is known before xterm.js
    // finds the link under the pointer.
    el.addEventListener('mousemove', (e) => { this.lastPointer = e; mod(e); }, true);
    window.addEventListener('blur', () => this.setModHeld(false));
    // xterm.js sends the keys itself, macOS's Option+arrows and
    // Option+Backspace included; the app's shortcuts go on to the menu
    // (isAppKey), except the few Cmd keys of macOS's terminals xterm.js
    // does not do (docs in apps/desktop/README.md, Keys).
    this.term.attachCustomKeyEventHandler((e) => {
      // Option as Meta, one side only (a setting): xterm.js reads one switch
      // on each key, so it is set from the side of each Option keydown.
      if (this.mac && e.type === 'keydown' && (e.code === 'AltLeft' || e.code === 'AltRight') && this.ts && (this.ts.optionAsMeta === 'left' || this.ts.optionAsMeta === 'right')) {
        this.term.options.macOptionIsMeta = macOptionIsMetaFor(this.ts.optionAsMeta, e.code);
      }
      const only = this.mac && !e.ctrlKey && !e.shiftKey;
      const cmd = only && e.metaKey && !e.altKey;
      const shift = e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey;
      const send = cmd ? MAC_CMD_SEND[e.key] : only && e.altKey && !e.metaKey ? MAC_OPT_SEND[e.key] : shift ? SHIFT_SEND[e.key] : undefined;
      const ctrlShift = !this.mac && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
      const act = cmd ? MAC_CMD_ACT[e.key.toLowerCase()] : ctrlShift ? CTRL_SHIFT_ACT[e.key.toLowerCase()] : undefined;
      // Cmd+Home and Cmd+End: the top and the bottom of the scrollback.
      if (cmd && (e.key === 'Home' || e.key === 'End')) {
        if (e.type === 'keydown') { e.preventDefault(); if (e.key === 'Home') this.term.scrollToTop(); else this.term.scrollToBottom(); }
        return false;
      }
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
      if (text && this.keysTo) { this.keysTo.view.take(this.keysTo.pane, { paste: text }); return; }
      const a = this.current;
      if (text && a) void a.client.paste(a.pane, text).catch(() => {});
    }, true);
    // A file dropped on the terminal: its path, quoted, as if pasted,
    // several separated by spaces.
    el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    el.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      const paths = files.map((f) => this.pathOf(f)).filter(Boolean);
      const a = this.current;
      if (paths.length && a) void a.client.paste(a.pane, paths.map(shellQuote).join(' ') + ' ').catch(() => {});
      this.focus();
    });
    // A right click: the system's own menu (app.ts asks the main process).
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.onContextMenu(this.hoverLink); });
    // Fitted in the same frame as the layout that changed its size (a
    // ResizeObserver runs after layout, before paint, once a frame), as VS
    // Code lays its terminal out from the window's resize.
    new ResizeObserver(() => this.fitNow()).observe(el);
  }

  /** The settings' terminal (docs/SETTINGS.md): font, size, cursor, theme, Option as Meta, scrollback (the daemon keeps as many for the pane: app.ts paneScrollback). */
  applySettings(ts: TerminalSettings): void {
    this.ts = ts;
    Object.assign(this.term.options, ts.xterm);
    this.queueResize();
  }

  /** Finds `query` from the current match on (dir 1) or back (dir -1); '' clears. */
  find(query: string, opts: { caseSensitive: boolean; regex: boolean }, dir: 1 | -1 = 1, incremental = false): boolean {
    if (!query) { this.clearFind(); return false; }
    const o: ISearchOptions = { caseSensitive: opts.caseSensitive, regex: opts.regex, incremental, decorations: FIND_DECOR[this.ts?.appearance === 'light' ? 'light' : 'dark'] };
    try { return dir === 1 ? this.search.findNext(query, o) : this.search.findPrevious(query, o); } catch { return false; }
  }

  clearFind(): void {
    this.search.clearDecorations();
    this.term.clearSelection();
    this.onFindResults(0, 0);
  }

  /** What the pane has selected now, '' for nothing. */
  get selection(): string { return this.term.hasSelection() ? this.term.getSelection() : ''; }

  private useWebgl(): void {
    try {
      const w = new WebglAddon();
      w.onContextLoss(() => { w.dispose(); this.webgl = null; });
      this.term.loadAddon(w);
      this.webgl = w;
      this.drawWhenRefitted();
    } catch {
      this.webgl = null; // the DOM renderer draws instead
    }
  }

  /**
   * On a Retina screen the canvas's size in device pixels often comes out
   * a pixel off what xterm.js set (an odd width or height halved, or the
   * canvas's place on the pixel grid). The WebGL addon then sets it again
   * from its own ResizeObserver, which clears the canvas, and only asks for
   * a draw on the next frame: the frame in between showed the pane empty
   * (2026-11-08, a plain zsh pane, a screen recording). The addon's own
   * handler draws at once instead, as addon-webgl 0.20 (xterm.js 6.1, VS
   * Code's) does itself: its redraw request there is `sync: true`.
   */
  private drawWhenRefitted(): void {
    const r = (this.term as unknown as { _core?: { _renderService?: { _renderer?: { value?: { _canvas?: HTMLCanvasElement; _setCanvasDevicePixelDimensions?: (w: number, h: number) => void } } } } })._core?._renderService?._renderer?.value;
    const own = r?._setCanvasDevicePixelDimensions;
    if (!r || !r._canvas || typeof own !== 'function') return;
    const canvas = r._canvas;
    r._setCanvasDevicePixelDimensions = (w: number, h: number) => {
      const before = canvas.width + 'x' + canvas.height;
      own.call(r, w, h);
      if (canvas.width + 'x' + canvas.height !== before) this.drawNow();
    };
  }

  private link(e: MouseEvent, uri: string): void {
    if (!(this.ts?.openLinksSingleClick || (this.mac ? e.metaKey : e.ctrlKey)) || !openableLink(uri)) return;
    this.onOpenLink(uri);
  }

  /** Links look like links (underline, pointer) only when a click would open them. */
  private linkLive(): boolean { return !!this.ts?.openLinksSingleClick || this.modHeld; }

  /**
   * Every link xterm.js finds (the OSC 8 ones a program names, and plain
   * URLs in the text) gets its decorations from linkLive, and a tip while
   * the pointer is on it. xterm.js keeps its link providers in one list
   * (its own OSC 8 one among them); each is wrapped where it stands.
   */
  private decorateLinks(): void {
    const svc = (this.term as unknown as { _core?: { _linkProviderService?: { linkProviders?: ILinkProvider[] } } })._core?._linkProviderService;
    const list = svc?.linkProviders;
    if (!Array.isArray(list)) return;
    list.forEach((p, i) => {
      list[i] = { provideLinks: (y, cb) => p.provideLinks(y, (links) => cb(links ? links.map((l) => this.decorate(l)) : links)) };
    });
  }

  private decorate(l: ILink): ILink {
    const live = this.linkLive();
    l.decorations = { underline: live, pointerCursor: live };
    const hover = l.hover, leave = l.leave;
    l.hover = (e, text) => { this.hovered = l; this.showTip(e, l.text); hover?.call(l, e, text); };
    l.leave = (e, text) => { if (this.hovered === l) { this.hovered = null; this.tip.hidden = true; } leave?.call(l, e, text); };
    return l;
  }

  private showTip(e: MouseEvent, uri: string): void {
    if (this.linkLive() || !openableLink(uri)) { this.tip.hidden = true; return; }
    this.tip.textContent = `${this.mac ? 'Cmd' : 'Ctrl'}+click to open`;
    const r = this.el.getBoundingClientRect();
    this.tip.style.left = `${Math.max(0, Math.min(e.clientX - r.left + 10, r.width - 150))}px`;
    this.tip.style.top = `${Math.max(0, e.clientY - r.top + 18)}px`;
    this.tip.hidden = false;
  }

  private setModHeld(on: boolean): void {
    if (on === this.modHeld) return;
    this.modHeld = on;
    const l = this.hovered;
    if (!l) return;
    const live = this.linkLive();
    if (l.decorations) { l.decorations.underline = live; l.decorations.pointerCursor = live; }
    if (live) this.tip.hidden = true;
    else if (this.lastPointer) this.showTip(this.lastPointer, l.text);
  }

  /** For tests: the link under the pointer, how it shows, and the tip. */
  get linkState(): { text: string | null; underline: boolean; pointer: boolean; tip: string | null } {
    const l = this.hovered;
    return { text: l ? l.text : null, underline: !!l?.decorations?.underline, pointer: !!l?.decorations?.pointerCursor, tip: this.tip.hidden ? null : this.tip.textContent };
  }

  /** The text size: n, or a step up (+1) or down (-1) from now, or the base (0). */
  zoom(step: 1 | -1 | 0): number {
    const now = this.term.options.fontSize || FONT_SIZE.base;
    return this.setFontSize(step === 0 ? FONT_SIZE.base : now + step);
  }

  setFontSize(n: number): number {
    const size = Math.max(FONT_SIZE.min, Math.min(FONT_SIZE.max, Math.round(n)));
    if (this.term.options.fontSize !== size) {
      this.term.options.fontSize = size;
      this.queueResize();
    }
    return size;
  }

  /**
   * Where the view stands now, for the pane on screen. Only once its
   * snapshot is written: a view left (or hidden) before that holds an empty
   * buffer, which would read as "at the bottom" and lose the line kept
   * (the release check's step 14, one time in five). A restore still
   * waiting keeps its line.
   */
  private keepScroll(): void {
    const a = this.current;
    if (!a) return;
    if (this.restoreTo !== null) { this.scrolls.set(a.pane, this.restoreTo); return; }
    if (!this.snapshotIn) return;
    const b = this.term.buffer.active;
    this.scrolls.set(a.pane, b.viewportY >= b.baseY ? 'bottom' : b.viewportY);
  }
  /** The pane on screen has had its snapshot written. */
  private snapshotIn = false;

  private input(d: string | Uint8Array): void {
    if (this.keysTo) this.keysTo.view.take(this.keysTo.pane, { keys: d });
    else if (this.stream) this.stream.input(d);
    else if (this.current) this.early.push(d);
  }

  /**
   * While another terminal is attached to a pane hidden, to come in front
   * of this one (a new tab, a switch: app.ts showPane), what is typed and
   * pasted here is that pane's: the keyboard stays with this terminal
   * until the other shows (a hidden one cannot take it), and its keys
   * went to the pane before, the one leaving (2026-11-16: a command typed
   * at once after a new shell ran in the previous tab's shell). null: this
   * terminal's own pane again.
   */
  handKeysTo(view: TerminalView | null, pane = ''): void {
    this.keysTo = view && view !== this ? { view, pane } : null;
  }
  private keysTo: { view: TerminalView; pane: string } | null = null;
  /** Keys and pastes handed over for a pane this terminal is being attached to, sent once its stream is up. */
  private handed: { pane: string; keys?: string | Uint8Array; paste?: string }[] = [];

  /** Input handed over by the terminal in front (handKeysTo) for pane: sent now when this terminal streams it, else once it does. */
  take(pane: string, x: { keys?: string | Uint8Array; paste?: string }): void {
    const a = this.current;
    if (a && a.pane === pane && this.stream && !this.stream.ended) this.send(a, x);
    else this.handed.push({ pane, ...x });
  }

  private send(a: Attached, x: { keys?: string | Uint8Array; paste?: string }): void {
    if (x.keys !== undefined) this.stream?.input(x.keys);
    if (x.paste !== undefined) void a.client.paste(a.pane, x.paste).catch(() => {});
  }

  get renderer(): string { return this.webgl ? 'webgl' : 'dom'; }
  /** True once the pane on screen streams (keys go straight to it). */
  get ready(): boolean { return !!this.stream && !this.stream.ended; }
  get attached(): Attached | null { return this.current; }

  focus(): void { this.term.focus(); }

  /** Shows a pane: drops the one on screen, then subscribes to this one at the terminal's size. `focus`: it takes the keyboard (a split's other pane does not). */
  async show(a: Attached, focus = true): Promise<void> {
    if (this.current && this.current.pane === a.pane && this.current.client === a.client && this.stream && !this.stream.ended) {
      if (focus) this.focus();
      return;
    }
    const gen = ++this.gen;
    this.keepScroll();
    this.detachStream();
    this.early = [];
    this.current = a;
    this.restoreTo = this.scrolls.get(a.pane) ?? null;
    this.restoreUntil = 0;
    this.snapshotIn = false;
    // What it showed stays until the new pane's screen is written, then
    // goes in the same frame (a pane blank for a moment, then filled, was
    // a flash at every tab switch).
    this.resetPending = true;
    this.drawnYes = false;
    this.drawnDone();
    this.drawnNow = new Promise<void>((r) => { this.drawnDone = r; });
    this.onShown(a);
    this.fitNow(true);
    const { cols, rows } = this.term;
    this.sizeSent = '';
    try {
      this.sizedAt = performance.now();
      await a.client.request('pane.resize', { pane: a.pane, cols, rows });
      this.sizeSent = `${a.pane}:${cols}x${rows}`;
    } catch { /* an exited pane cannot resize; its screen still shows */ }
    if (gen !== this.gen) return;
    const s = await a.client.subscribe(a.pane, {
      data: (d, info) => {
        // Frames can come before this call returns; a stale stream's are dropped.
        if (gen !== this.gen) { info.ack(); return; }
        const end = info.snapshot ? info.mark : info.mark + d.byteLength;
        // The first frame: the screen before goes, and the new one is drawn
        // whole (synchronized output: nothing shows until it is all written).
        const first = this.resetPending;
        if (first) { this.dropHold(); this.resetPending = false; this.term.reset(); this.term.write(SYNC_ON); }
        // Acknowledged once: at once when the frame is held (the daemon sends
        // no more until it is, and the rest of an update was kept back).
        let acked = false;
        const ack = () => { if (!acked) { acked = true; info.ack(); } };
        const after = () => {
          if (first && gen === this.gen) { this.term.write(SYNC_OFF, () => { if (gen === this.gen) this.drawnYes = true; this.drawnDone(); }); }
          ack();
          if (gen !== this.gen) return;
          // Back where the view stood when the pane was last on screen. A
          // snapshot can come in more than one write: a line past what is
          // written so far waits for the rest (at most 1.5 s), so the view
          // is not left at the bottom, following it.
          if (info.snapshot) { this.trace(`snapshot ${d.byteLength}`); this.snapshotIn = true; }
          if (info.snapshot && this.restoreTo !== null) this.restoreUntil = Date.now() + 1500;
          if (this.restoreTo !== null && this.restoreUntil) {
            const to = this.restoreTo;
            const base = this.term.buffer.active.baseY;
            if (to === 'bottom') { this.term.scrollToBottom(); this.restoreTo = null; }
            else if (base >= to || Date.now() > this.restoreUntil) { this.term.scrollToLine(Math.min(to, base)); this.restoreTo = null; }
            else this.term.scrollToLine(base);
            if (this.restoreTo === null) { this.restoreUntil = 0; this.trace('restored'); }
          }
          this.onWritten(a, end, info.snapshot);
        };
        if (first) this.term.write(d, after);
        else this.output(d, after, ack);
      },
      end: () => { if (gen === this.gen) this.onEnded(a); },
    });
    if (gen !== this.gen) { void s.unsubscribe().catch(() => {}); return; }
    this.stream = s;
    for (const d of this.early.splice(0)) s.input(d);
    for (const x of this.handed.splice(0)) if (x.pane === a.pane) this.send(a, x);
    this.queueResize();
    if (focus) this.focus();
  }

  /**
   * A program's output, as it comes. Claude Code draws its whole screen
   * again at each size, between BSU and ESU (synchronized output, mode
   * 2026: ravenryd answers that it has it). Its update
   * comes in more than one read of its terminal. xterm.js would hold its
   * drawing until ESU itself, but a resize in between clears its canvas
   * and it draws nothing until ESU: a blank pane at each step of a drag
   * (2026-11-08, a screen recording). So xterm.js never sees a pair open:
   * an update is kept here from its BSU to its ESU (at most SYNC_MAX ms)
   * and then written in one go, the pane meanwhile showing the drawing
   * before it, which a resize can always draw again. VS Code needs none of
   * this: its pty host gathers a program's output for 5 ms
   * (TerminalDataBufferer) before xterm.js sees it, so an update comes
   * whole; the daemon's frames can cut one.
   */
  private hold: { items: { d: Uint8Array; after: () => void }[]; timer: ReturnType<typeof setTimeout> } | null = null;
  /** The last bytes of the frame before, for a BSU or ESU cut between two frames. */
  private tail: Uint8Array = new Uint8Array(0);

  private output(d: Uint8Array | ArrayBuffer, after: () => void, ack: () => void): void {
    const b = d instanceof Uint8Array ? d : new Uint8Array(d);
    const t = this.tail;
    const joined = t.length ? (() => { const j = new Uint8Array(t.length + b.length); j.set(t); j.set(b, t.length); return j; })() : b;
    this.tail = joined.slice(Math.max(0, joined.length - 7));
    const tok = lastSyncToken(joined);
    if (this.hold) {
      this.hold.items.push({ d: b, after });
      if (tok === 'off') this.flush(false); else ack();
      return;
    }
    if (tok === 'on') {
      this.hold = { items: [{ d: b, after }], timer: setTimeout(() => this.flush(true), SYNC_MAX) };
      ack();
      return;
    }
    perfNote({ at: performance.now(), ms: 0, what: 'write', pane: this.current?.pane, bytes: b.byteLength, sync: false });
    this.term.write(b, after);
  }

  /**
   * Writes the held update, all in this task, so no frame shows part of
   * it. One cut short (its ESU late) is shown as it stands and the pair
   * closed, so xterm.js is not left holding its drawing.
   */
  private flush(late: boolean): void {
    const h = this.hold;
    this.hold = null;
    if (!h) return;
    clearTimeout(h.timer);
    const bytes = h.items.reduce((n, it) => n + it.d.byteLength, 0);
    const wb = (this.term as unknown as { _core?: { _writeBuffer?: { writeSync?: (d: Uint8Array | string) => void } } })._core?._writeBuffer;
    // In one go only when it is small and shown: a hidden terminal is not
    // seen half-written, and a big update in one task freezes the window
    // (SYNC_WRITE_MAX); xterm.js draws nothing until its ESU meanwhile.
    if (wb && typeof wb.writeSync === 'function' && bytes <= SYNC_WRITE_MAX && !this.hidden()) {
      const t = performance.now();
      for (const it of h.items) wb.writeSync(it.d);
      if (late) wb.writeSync(SYNC_OFF);
      perfNote({ at: t, ms: performance.now() - t, what: 'write', pane: this.current?.pane, bytes, sync: true });
      for (const it of h.items) it.after();
    } else {
      perfNote({ at: performance.now(), ms: 0, what: 'write', pane: this.current?.pane, bytes, sync: false });
      for (const it of h.items) {
        const d = it.d;
        for (let i = 0; i + SLICE < d.byteLength; i += SLICE) this.term.write(d.subarray(i, i + SLICE));
        this.term.write(d.byteLength > SLICE ? d.subarray(Math.floor((d.byteLength - 1) / SLICE) * SLICE) : d, it.after);
      }
      if (late) this.term.write(SYNC_OFF);
    }
  }
  private dropHold(): void {
    if (this.hold) clearTimeout(this.hold.timer);
    this.hold = null;
    this.tail = new Uint8Array(0);
  }

  /** Resolves once the pane on screen has its screen written (or right away with none being attached). */
  get drawn(): Promise<void> { return this.drawnNow; }
  /** True once the pane attached has its screen written. */
  get isDrawn(): boolean { return this.drawnYes; }
  private drawnYes = false;
  private drawnNow: Promise<void> = Promise.resolve();
  private drawnDone: () => void = () => {};
  private resetPending = false;

  /** Shows nothing: unsubscribes, so no xterm.js work runs for any pane. */
  hide(): void {
    this.keepScroll();
    this.resetPending = false;
    this.dropHold();
    this.drawnYes = false;
    this.drawnDone();
    this.gen++;
    this.detachStream();
    this.early = [];
    this.handed = [];
    this.keysTo = null;
    this.current = null;
    this.snapshotIn = false;
    this.restoreTo = null;
    this.term.reset();
    this.onShown(null);
  }

  private detachStream(): void {
    const s = this.stream;
    this.stream = null;
    if (s && !s.ended) void s.unsubscribe().catch(() => {});
  }

  /**
   * Draws every row now, in this task: xterm.js 6.0 draws a resize on its
   * next frame, after the canvas was cleared; 6.1 (VS Code's) draws it at
   * once, and this does the same.
   */
  private drawNow(): void {
    const rs = (this.term as unknown as { _core?: { _renderService?: { _renderRows?: (s: number, e: number) => void } } })._core?._renderService;
    if (!rs || typeof rs._renderRows !== 'function' || this.term.rows < 1) return;
    // Not halfway through a program's synchronized update (a big one is
    // parsed in slices): xterm.js draws it whole at its ESU.
    if (this.term.modes.synchronizedOutputMode) return;
    const t = performance.now();
    try { rs._renderRows(0, this.term.rows - 1); } catch { /* drawn on the next frame instead */ }
    perfNote({ at: t, ms: performance.now() - t, what: 'draw', pane: this.current?.pane });
  }

  private queueResize(): void {
    if (this.resizeQueued) return;
    this.resizeQueued = true;
    requestAnimationFrame(() => { this.resizeQueued = false; this.fitNow(true); });
  }

  /**
   * Fits the terminal to its element, as VS Code does
   * (terminalResizeDebouncer.ts): with a short buffer, or `now` (a pane
   * shown, a font change), rows and columns at once; else the rows at once
   * and the columns once the size has held COLS_WAIT ms, so a drag does
   * not reflow the text, nor make its program draw itself again at a new
   * width, at every step.
   */
  private fitNow(now = false): void {
    if (!this.el.offsetWidth || !this.el.offsetHeight) return;
    // Just shown, the layout that comes with it (the panel back, the split
    // shown) is applied at once: its columns waiting 100 ms showed the
    // text cut at the old width for that long (2026-11-10, flash-check).
    if (this.justShown) now = true;
    // Hidden: no work in the resize's path (VS Code resizes a hidden
    // terminal when it shows or the window is idle). Four kept alive, each
    // reflowing its scrollback and its program writing its screen again,
    // all at once when the size settled, froze the window.
    if (!now && this.hidden()) { this.fitLater(); return; }
    this.fitPending = false;
    this.redrawAfterResize();
    let d: { cols: number; rows: number } | undefined;
    try { d = this.fit.proposeDimensions(); } catch { d = undefined; }
    if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return;
    this.proposed = d;
    if (now || this.term.buffer.normal.length < DEBOUNCE_FROM_LINES) {
      clearTimeout(this.colsTimer);
      this.colsTimer = undefined;
      if (!this.resizeTo(d.cols, d.rows)) this.drawNow();
      return;
    }
    if (!this.resizeTo(this.term.cols, d.rows)) this.drawNow();
    clearTimeout(this.colsTimer);
    this.colsTimer = setTimeout(() => {
      this.colsTimer = undefined;
      if (this.proposed) this.resizeTo(this.proposed.cols, this.term.rows);
    }, COLS_WAIT);
  }

  /**
   * A window resized shows a WebGL canvas blank from the frame after the
   * one it was drawn in, until it is drawn again, even when its size stayed
   * (measured 2026-11-08, offscreen: the canvas untouched, its pane blank in
   * every frame of a 100 ms wait for the columns, and at the drag's turn).
   * A resize that changes the canvas draws it at each step anyway; one that
   * keeps it (the columns waiting) draws it here, in this callback and on
   * the next two frames.
   */
  private redrawFrames = 0;
  private redrawAfterResize(): void {
    const going = this.redrawFrames > 0;
    this.redrawFrames = 2;
    if (going) return;
    const tick = () => {
      if (this.redrawFrames <= 0) return;
      this.redrawFrames--;
      this.drawNow();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** Hidden from view: a pooled terminal (.term-host.pooled) or the split hidden (#split[hidden]); both keep it laid out. */
  private hidden(): boolean { return getComputedStyle(this.el).visibility === 'hidden'; }

  /** Once the size has held HIDDEN_WAIT ms, at the window's next idle moment. */
  private fitLater(): void {
    this.fitPending = true;
    this.cancelIdleFit();
    this.idleFit = window.setTimeout(() => {
      const run = (): void => {
        this.idleFit = 0;
        this.idleKind = '';
        if (this.fitPending) this.fitNow(true);
      };
      if (typeof requestIdleCallback === 'function') { this.idleKind = 'idle'; this.idleFit = requestIdleCallback(run, { timeout: 5000 }); } else run();
    }, HIDDEN_WAIT);
    this.idleKind = 'timer';
  }
  private idleKind: '' | 'timer' | 'idle' = '';
  private cancelIdleFit(): void {
    if (this.idleKind === 'timer') clearTimeout(this.idleFit);
    else if (this.idleKind === 'idle') cancelIdleCallback(this.idleFit);
    this.idleFit = 0;
    this.idleKind = '';
  }

  /** It shows now (app.ts, as it comes to the front): a size it waited for while hidden is applied before the frame. */
  shown(fresh = true): void {
    // Only when it was hidden until now: a view drawn again keeps the wait.
    if (fresh) {
      const n = ++this.shownSeq;
      this.justShown = true;
      requestAnimationFrame(() => requestAnimationFrame(() => { if (this.shownSeq === n) this.justShown = false; }));
    }
    if (!this.fitPending) return;
    this.cancelIdleFit();
    this.fitNow(true);
  }

  /** xterm.js resized, drawn in this task (drawNow), and the pane's program told (sendSize); false when its size stayed. */
  private resizeTo(cols: number, rows: number): boolean {
    const changed = cols !== this.term.cols || rows !== this.term.rows;
    if (changed) {
      const t = performance.now();
      this.term.resize(cols, rows);
      perfNote({ at: t, ms: performance.now() - t, what: 'resize', pane: this.current?.pane, size: `${cols}x${rows}`, lines: this.term.buffer.normal.length, hidden: this.hidden() });
      this.drawNow();
    }
    this.sendSize();
    return changed;
  }

  /** The pane's program learns the terminal's size at each resize (the daemon resizes its PTY, which signals it). */
  private sendSize(): void {
    const a = this.current;
    if (!a || !this.stream) return;
    const { cols, rows } = this.term;
    const key = `${a.pane}:${cols}x${rows}`;
    if (key === this.sizeSent) return;
    this.sizeSent = key;
    this.sizedAt = performance.now();
    void a.client.request('pane.resize', { pane: a.pane, cols, rows }).catch(() => {});
  }

  /** Bytes for the pane on screen, as if typed. */
  type(text: string): void { this.stream?.input(enc.encode(text)); }
}
