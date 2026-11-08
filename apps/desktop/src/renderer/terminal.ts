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
  private resizeQueued = false;
  /** A size was sent to the pane in this frame; a newer one waits for the next (sizeLater). */
  private sizeThisFrame = false;
  private sizeLater = false;
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
  /** A bell rang in the pane on screen. */
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
    // underlines it with a pointer (a plain click selects, as in iTerm2),
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
      const act = cmd ? MAC_CMD_ACT[e.key.toLowerCase()] : undefined;
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
      const a = this.current;
      if (text && a) void a.client.paste(a.pane, text).catch(() => {});
    }, true);
    // A file dropped on the terminal: its path, quoted, as if pasted (as
    // Terminal.app and iTerm2 do), several separated by spaces.
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
    // ResizeObserver runs after layout, before paint, once a frame), and
    // drawn in that callback too (fitNow), so a resize never shows a pane
    // blank or a frame late.
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
   * handler draws at once instead.
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
    if (this.stream) this.stream.input(d);
    else if (this.current) this.early.push(d);
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
    this.queueResize();
    if (focus) this.focus();
  }

  /**
   * A program's output, as it comes. Claude Code draws its whole screen
   * again at each size, between BSU and ESU (synchronized output, mode
   * 2026: ravenryd answers that it has it, as Ghostty does). Its update
   * comes in more than one read of its terminal. xterm.js would hold its
   * drawing until ESU itself, but a resize in between clears its canvas
   * and it draws nothing until ESU: a blank pane at each step of a drag
   * (2026-11-08, a screen recording). So xterm.js never sees a pair open:
   * an update is kept here from its BSU to its ESU (at most SYNC_MAX ms)
   * and then written in one go, the pane meanwhile showing the drawing
   * before it, which a resize can always draw again.
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
    const wb = (this.term as unknown as { _core?: { _writeBuffer?: { writeSync?: (d: Uint8Array | string) => void } } })._core?._writeBuffer;
    if (wb && typeof wb.writeSync === 'function') {
      for (const it of h.items) wb.writeSync(it.d);
      if (late) wb.writeSync(SYNC_OFF);
      for (const it of h.items) it.after();
    } else {
      for (const it of h.items) this.term.write(it.d, it.after);
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

  /** Draws every row now, in this task (xterm.js's own draw waits for the next frame). */
  private drawNow(): void {
    const rs = (this.term as unknown as { _core?: { _renderService?: { _renderRows?: (s: number, e: number) => void } } })._core?._renderService;
    if (!rs || typeof rs._renderRows !== 'function' || this.term.rows < 1) return;
    try { rs._renderRows(0, this.term.rows - 1); } catch { /* drawn on the next frame instead */ }
  }

  private queueResize(): void {
    if (this.resizeQueued) return;
    this.resizeQueued = true;
    requestAnimationFrame(() => { this.resizeQueued = false; this.fitNow(); });
  }

  /**
   * Fits the terminal to its element: from the ResizeObserver (after
   * layout, before paint, once a frame) or a frame after a font change.
   * A new size clears xterm.js's WebGL canvas at once (setting its width
   * does) while xterm.js draws on its next animation frame, so the frame
   * between showed the pane blank; it is drawn here, in the same callback,
   * so the frame that shows the new size shows the text reflowed to it.
   * The program learns the size too (sendSize).
   */
  private fitNow(): void {
    if (!this.el.offsetWidth || !this.el.offsetHeight) return;
    const before = `${this.term.cols}x${this.term.rows}`;
    try { this.fit.fit(); } catch { /* not laid out yet */ }
    if (`${this.term.cols}x${this.term.rows}` !== before) this.drawNow();
    this.sendSize();
  }

  /**
   * The pane's program learns the terminal's size (the daemon resizes its
   * PTY, which signals it): at most one size a frame, and the last one
   * always, a frame later at most.
   */
  private sendSize(): void {
    if (this.sizeThisFrame) { this.sizeLater = true; return; }
    const a = this.current;
    if (!a || !this.stream) return;
    const { cols, rows } = this.term;
    const key = `${a.pane}:${cols}x${rows}`;
    if (key === this.sizeSent) return;
    this.sizeSent = key;
    void a.client.request('pane.resize', { pane: a.pane, cols, rows }).catch(() => {});
    this.sizeThisFrame = true;
    requestAnimationFrame(() => {
      this.sizeThisFrame = false;
      if (this.sizeLater) { this.sizeLater = false; this.sendSize(); }
    });
  }

  /** Bytes for the pane on screen, as if typed. */
  type(text: string): void { this.stream?.input(enc.encode(text)); }
}
