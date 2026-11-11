// The Settings window's page: two toolbar tabs, Appearance and Behavior.
// Every control writes through window.ravenrySettings (src/preload/
// settings-preload.ts) and draws again from the snapshot the main process
// sends back, so the window always shows what is saved.

import './settings.css';
import { FONT_FALLBACK, FONT_SIZE, SCROLLBACK } from '../shared/settings.ts';
import type { SettingsPatch, SettingsSetResult, SettingsSnapshot, SettingsTab } from '../shared/settings.ts';
import type { ThemeInfo } from '../shared/themes.ts';
import type { SkillRow, SkillsApi } from '../shared/skills.ts';

interface Bridge {
  get(): Promise<SettingsSnapshot>;
  set(patch: SettingsPatch): Promise<SettingsSetResult>;
  importTheme(): Promise<{ ok: true; theme: ThemeInfo; snapshot: SettingsSnapshot } | { ok: false; error?: string; canceled?: boolean }>;
  onChange(cb: (s: SettingsSnapshot) => void): () => void;
  onShowTab(cb: (tab: SettingsTab) => void): () => void;
  window(): Promise<{ platform: string; tab: SettingsTab; offscreen: boolean }>;
  size(height: number): void;
  tab(tab: SettingsTab): void;
  skills: SkillsApi;
}
const api = (window as unknown as { ravenrySettings: Bridge }).ravenrySettings;

const I = {
  APPEAR: '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="4" width="17" height="14" rx="2.5"/><path d="M6 9l2.5 2L6 13M10.5 13.5H15" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  SKILLS: '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 3l2.2 4.6 5 .7-3.6 3.5.9 5L11 14.4 6.5 16.8l.9-5L3.8 8.3l5-.7z"/></svg>',
  TERM: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2" width="11" height="10" rx="2"/><path d="M4 5.5l2 1.5-2 1.5M7.5 9H10"/></svg>',
  BEHAV: '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 6h9M17 6h1M4 11h3M11 11h7M4 16h7M15 16h3"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="11" r="2"/><circle cx="13" cy="16" r="2"/></svg>',
  CHEV: '<svg width="9" height="12" viewBox="0 0 9 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5l2.5-2.5 2.5 2.5M2 7.5l2.5 2.5 2.5-2.5"/></svg>',
  CHECK: '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5.2l2 2 4-4.4" stroke="#FFF" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// ------------------------------------------------------------------ DOM

type Kids = (Node | string | null | undefined | false)[];
function h<K extends keyof HTMLElementTagNameMap>(sel: K | `${K}.${string}`, attrs: Record<string, unknown> | null = null, ...kids: Kids): HTMLElementTagNameMap[K] {
  const [tag, ...cls] = sel.split('.');
  const el = document.createElement(tag as K);
  if (cls.length) el.className = cls.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
const svg = (s: string) => { const t = document.createElement('template'); t.innerHTML = s; return t.content.firstChild as Node; };

// ---------------------------------------------------------------- state

let snap: SettingsSnapshot;
let tab: SettingsTab = 'appearance';
let platform = 'darwin';
let fonts: string[] = [];
let note: { text: string; bad: boolean } | null = null;
const mac = () => platform === 'darwin';

async function set(patch: SettingsPatch): Promise<boolean> {
  const r = await api.set(patch);
  note = null;
  if (r.ok) { snap = r.snapshot; draw(); return true; }
  console.error('settings:', r.error);
  draw();
  return false;
}

// -------------------------------------------------------------- controls

function row(label: string, ctl: Node | Node[], opts: { hint?: string | Node; join?: boolean; id?: string } = {}): HTMLElement {
  return h('div.fr2', { class: `fr2${opts.join ? ' join' : ''}`, id: opts.id },
    h('span.lb', null, label),
    ...(Array.isArray(ctl) ? ctl : [ctl]),
    opts.hint ? h('span.hint', null, opts.hint) : null);
}
const ctl = (...kids: Kids) => h('div.ctl', null, ...kids);

function segm<T extends string>(name: string, value: T, items: [T, string][], onPick: (v: T) => void): HTMLElement {
  const g = h('div.segm', { role: 'radiogroup', 'aria-label': name });
  for (const [v, label] of items) {
    g.append(h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(v === value), 'data-value': v,
      onclick: () => { if (v !== value) onPick(v); },
    }, label));
  }
  return g;
}

function checkbox(label: string, checked: boolean, onSet: (on: boolean) => void, opts: { disabled?: boolean; id?: string } = {}): HTMLElement {
  return h('label.cbx', { class: `cbx${opts.disabled ? ' off' : ''}` },
    h('input', { type: 'checkbox', checked, disabled: !!opts.disabled, id: opts.id, onchange: (e: Event) => onSet((e.target as HTMLInputElement).checked) }),
    h('i', null, svg(I.CHECK)),
    label);
}

function fontPopup(): HTMLElement {
  const cur = snap.settings.fontFamily;
  const list = [...new Set([...fonts, cur])].sort((a, b) => a.localeCompare(b));
  const sel = h('select', { 'aria-label': 'Font', onchange: (e: Event) => void set({ fontFamily: (e.target as HTMLSelectElement).value }) },
    ...list.map((f) => h('option', { value: f, selected: f === cur }, f)));
  return h('span.pop', null, cur, svg(I.CHEV), sel);
}

function stepper(): HTMLElement {
  const n = snap.settings.fontSize;
  return h('span.stp', null,
    h('button', { type: 'button', 'aria-label': 'Smaller', disabled: n <= FONT_SIZE.min, onclick: () => void set({ fontSize: n - 1 }) }, '\u2212'),
    h('span.v', { 'aria-label': 'Font size' }, String(n)),
    h('button', { type: 'button', 'aria-label': 'Bigger', disabled: n >= FONT_SIZE.max, onclick: () => void set({ fontSize: n + 1 }) }, '+'));
}

function preview(): HTMLElement {
  const t = snap.terminal.xterm.theme;
  const s = snap.settings;
  const c = (color: string, text: string) => h('span', { style: `color:${color}` }, text);
  const cur = h('span', { class: `cu ${s.cursorStyle}${s.cursorBlink ? ' blink' : ''}`, style: `background:${t.cursor}` });
  return h('div.prev', { style: `background:${t.background};color:${t.foreground};font-family:${snap.terminal.xterm.fontFamily.replace(/"/g, "'")};font-size:${s.fontSize}px`, 'aria-label': `Preview in ${snap.terminal.themeName}` },
    c(t.blue, '~/code/landing-page'), ' ', c(t.magenta, 'main'), ' $ npm test\n',
    ' ', c(t.green, '\u2713'), ' src/nav.test.tsx ', c(t.brightBlack, '(6)'), '   ', c(t.red, '\u2717'), ' src/header.test.tsx ', c(t.brightBlack, '(4)'), '\n',
    ' ', c(t.yellow, 'warn'), ' 0O il1 {}[] => != 23:59 ', cur);
}

function card(th: ThemeInfo, on: boolean, onPick: () => void): HTMLElement {
  const t = th.theme;
  return h('button.th', { type: 'button', role: 'radio', 'aria-checked': String(on), 'data-theme': th.id, title: th.credit || th.name, onclick: onPick },
    h('span.sw2', { style: `display:block;background:${t.background};color:${t.foreground}` },
      h('span', { style: `color:${t.blue}` }, '~/code'), ' $ ls\n', h('span', { style: `color:${t.green}` }, 'src'), '  README.md'),
    h('span.nm2', null, th.name));
}

function themeGrid(label: string, ids: ThemeInfo[], current: string, key: 'themeDark' | 'themeLight' | 'themeAlways'): HTMLElement {
  const g = h('div.thg', { role: 'radiogroup', 'aria-label': label });
  for (const th of ids) g.append(card(th, th.id === current, () => void set({ [key]: th.id })));
  return row(label, g, { join: true });
}

// ---------------------------------------------------------------- panes

function appearancePane(): Node[] {
  const s = snap.settings;
  const themes = snap.themes;
  const dark = themes.filter((t) => t.appearance === 'dark');
  const light = themes.filter((t) => t.appearance === 'light');
  const sys = mac() ? 'macOS' : 'the system';
  const out: Node[] = [
    row('Font', ctl(fontPopup(), stepper(), h('span.t3.small.line', null, `${mac() ? 'Cmd' : 'Ctrl'}+= and ${mac() ? 'Cmd' : 'Ctrl'}+- change it for the open terminals`))),
    row('', preview(), { join: true }),
    row('Theme', ctl(checkbox('Follow the system', s.themeFollowsSystem, (on) => void set({ themeFollowsSystem: on }), { id: 'follow' })),
      { hint: s.themeFollowsSystem ? `Light when ${sys} is light, dark when it is dark.` : `One theme, whatever ${sys} shows.` }),
  ];
  if (s.themeFollowsSystem) {
    out.push(themeGrid('For dark', dark, s.themeDark, 'themeDark'), themeGrid('For light', light, s.themeLight, 'themeLight'));
  } else {
    out.push(themeGrid('Use', [...dark, ...light], s.themeAlways, 'themeAlways'));
  }
  out.push(row('', ctl(
    h('button.btn', { type: 'button', id: 'import', onclick: () => void importTheme() }, 'Import iTerm2 or Ghostty theme\u2026'),
    note ? h('span', { class: `small ${note.bad ? 'err' : 'okmsg'}`, id: 'import-note' }, note.text) : h('span.t3.small', null, '.itermcolors, or a Ghostty theme file'),
  ), { join: true }));
  out.push(row('Cursor', ctl(
    segm('Cursor', s.cursorStyle, [['block', 'Block'], ['bar', 'Bar'], ['underline', 'Underline']], (v) => void set({ cursorStyle: v })),
    checkbox('Blink', s.cursorBlink, (on) => void set({ cursorBlink: on })),
  ), { hint: 'Programs like vim can still change it while they run.' }));
  return out;
}

const META_HINT: Record<string, string> = {
  off: 'Option types \u00e9, \u00fc and \u2022 on both sides, as on a Mac anywhere else.',
  left: 'The Option key you pick sends Esc+key, for Emacs and shell shortcuts. The other one still types \u00e9, \u00fc and \u2022.',
  right: 'The Option key you pick sends Esc+key, for Emacs and shell shortcuts. The other one still types \u00e9, \u00fc and \u2022.',
  both: 'Both Option keys send Esc+key, for Emacs and shell shortcuts. Neither types \u00e9, \u00fc or \u2022.',
};

function scrollbackInput(): HTMLElement {
  const fmt = (n: number) => n.toLocaleString('en-US');
  const inp = h('input.inp', { type: 'text', inputMode: 'numeric', value: fmt(snap.settings.scrollback), 'aria-label': 'Scrollback lines', id: 'scrollback' });
  const commit = async () => {
    const n = Number(inp.value.replace(/[\s,._']/g, ''));
    if (!Number.isInteger(n) || n < SCROLLBACK.min || n > SCROLLBACK.max) { inp.classList.add('bad'); inp.title = `From ${fmt(SCROLLBACK.min)} to ${fmt(SCROLLBACK.max)} lines`; return; }
    inp.classList.remove('bad');
    if (n !== snap.settings.scrollback) await set({ scrollback: n }); else inp.value = fmt(n);
  };
  inp.addEventListener('change', () => void commit());
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') { inp.value = fmt(snap.settings.scrollback); inp.classList.remove('bad'); } });
  return inp;
}

function behaviorPane(): Node[] {
  const s = snap.settings;
  const out: Node[] = [h('div.sec', null, 'Keyboard and mouse')];
  if (mac()) {
    out.push(row('Use Option as Meta', ctl(segm('Use Option as Meta', s.optionAsMeta, [['off', 'Off'], ['left', 'Left'], ['right', 'Right'], ['both', 'Both']], (v) => void set({ optionAsMeta: v }))),
      { hint: META_HINT[s.optionAsMeta] }));
  }
  out.push(
    row('Copy on select', ctl(checkbox('Copy text as soon as it is selected', s.copyOnSelect, (on) => void set({ copyOnSelect: on })))),
    row('Links', ctl(checkbox('Open links with a single click', s.openLinksSingleClick, (on) => void set({ openLinksSingleClick: on }))),
      { hint: s.openLinksSingleClick ? 'A click on a link opens it.' : `${mac() ? 'Cmd' : 'Ctrl'}+click opens a link; a plain click selects, as in other terminals.` }),
    h('div.sec', null, 'Terminal'),
    row('Scrollback', ctl(scrollbackInput(), h('span', null, 'lines')), { hint: 'Kept by Ravenry\u2019s daemon, so it survives a tab switch and a relaunch.' }),
    row('Bell', ctl(
      segm('Bell', s.bell, [['visual', 'Visual'], ['sound', 'Sound'], ['off', 'Off']], (v) => void set({ bell: v })),
      mac() ? h('span.line', null, checkbox('Bounce the Dock icon when Ravenry is behind', s.bellBounceDock, (on) => void set({ bellBounceDock: on }), { disabled: s.bell === 'off' })) : null,
    )),
    row('Closing a tab', ctl(checkbox('Ask first when something is running in it', s.confirmCloseBusy, (on) => void set({ confirmCloseBusy: on }))),
      { hint: 'An idle shell always closes at once.' }),
  );
  return out;
}

// The Ravenry skill, one line per assistant: Install or Remove (the hub's
// hub/server/skills.mjs, through src/main/main.ts). No rows: the board is not up.
let skills: SkillRow[] = [];
let skillBusy: string | null = null;
let skillErr: string | null = null;

function skillsPane(): Node[] {
  const line = (r: SkillRow) => {
    const status = !r.found ? `Not on ${mac() ? 'this Mac' : 'this computer'}`
      : r.ours ? `Installed${r.version ? `, reads ravenry skill ${r.version}` : ''}`
        : r.installed ? 'A ravenry skill of someone else\u2019s is there; Ravenry leaves it alone' : 'Not installed';
    const act = !r.found || (r.installed && !r.ours) ? null
      : h('button.btn', { type: 'button', 'data-skill': r.kind, disabled: skillBusy === r.kind, onclick: () => void setSkill(r.kind, !r.ours) }, r.ours ? 'Remove' : 'Install');
    return h('div.sk-r', { 'data-kind': r.kind },
      h('span.sk-i', null, svg(I.TERM)),
      h('span.sk-t', null, h('span.sk-n', null, r.name), h(`span.sk-s${r.ours ? '.ok' : ''}`, null, status)),
      act);
  };
  // Its hooks, the other half of the first-launch step.
  const hookLine = (r: SkillRow) => {
    const status = !r.found ? `Not on ${mac() ? 'this Mac' : 'this computer'}`
      : r.hooks === 'on' ? 'On' : r.hooks === 'off' ? 'Off' : 'Needs Ravenry\u2019s board running';
    const act = !r.found || r.hooks === 'unavailable' ? null
      : h('button.btn', { type: 'button', 'data-hooks': r.kind, disabled: skillBusy === `h:${r.kind}`, onclick: () => void setHooks(r.kind, r.hooks !== 'on') }, r.hooks === 'on' ? 'Remove' : 'Set up');
    return h('div.sk-r', { 'data-hooks-kind': r.kind },
      h('span.sk-i', null, svg(I.TERM)),
      h('span.sk-t', null, h('span.sk-n', null, r.name), h(`span.sk-s${r.hooks === 'on' && r.found ? '.ok' : ''}`, null, status)),
      act);
  };
  return [
    h('div.sec', null, 'Skills', h('span.sec-s', null, mac() ? 'this Mac' : 'this computer')),
    skills.length ? null : h('p.sk-hint', null, 'Needs Ravenry\u2019s board running.'),
    ...skills.map(line),
    h('p.sk-hint', null, 'Lets the assistant open panes beside it, read their screens, show you pictures to pick from and ask you through the board and your phone. Remove puts the folder back as it was.'),
    h('div.sec', null, 'Know when a session waits for you'),
    ...skills.map(hookLine),
    h('p.sk-hint', null, 'Claude Code and Codex tell Ravenry when a session asks you something, finishes or hands off, so it moves to Needs you and can alert you, here and on your phone. It adds a line to the assistant\u2019s hooks; each file is backed up first, and Remove puts it back.'),
    skillErr ? h('p.sk-err', null, skillErr) : null,
  ].filter(Boolean) as Node[];
}

async function setHooks(kind: 'claude' | 'codex', on: boolean): Promise<void> {
  skillBusy = `h:${kind}`; skillErr = null; draw();
  const r = await api.skills.setHooks(kind, on);
  skillBusy = null;
  if (r.ok) skills = r.skills; else skillErr = r.error;
  draw();
}

async function setSkill(kind: 'claude' | 'codex', on: boolean): Promise<void> {
  skillBusy = kind; skillErr = null; draw();
  const r = await api.skills.set(kind, on);
  skillBusy = null;
  if (r.ok) skills = r.skills; else skillErr = r.error;
  draw();
}

async function importTheme(): Promise<void> {
  const r = await api.importTheme();
  if (!r.ok) {
    if (r.canceled) return;
    note = { text: r.error || 'That file is not a theme Ravenry can read.', bad: true };
    draw();
    return;
  }
  snap = r.snapshot;
  note = { text: `Imported \u201c${r.theme.name}\u201d, under For ${r.theme.appearance}.`, bad: false };
  draw();
}

// ----------------------------------------------------------------- draw

const TABS: [SettingsTab, string, string][] = [['appearance', 'Appearance', I.APPEAR], ['behavior', 'Behavior', I.BEHAV], ['skills', 'Skills', I.SKILLS]];

function draw(): void {
  const title = TABS.find((t) => t[0] === tab)![1];
  document.getElementById('ttl')!.textContent = title;
  document.title = title;
  const tabs = document.getElementById('tabs')!;
  tabs.replaceChildren(...TABS.map(([id, label, icon]) => h('button.sw-t', {
    type: 'button', role: 'tab', 'aria-selected': String(id === tab), 'data-tab': id,
    onclick: () => showTab(id),
  }, svg(icon), label)));
  const panes: Record<SettingsTab, () => Node[]> = { appearance: appearancePane, behavior: behaviorPane, skills: skillsPane };
  // Keep the focus where it was across a redraw (a checkbox, a segment).
  const focusKey = focusPath();
  for (const t of Object.keys(panes) as SettingsTab[]) {
    const el = document.getElementById(`pane-${t}`)!;
    el.hidden = tab !== t;
    if (tab === t) el.replaceChildren(...panes[t]());
  }
  restoreFocus(focusKey);
  fit();
}

function focusPath(): string | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return null;
  if (el.id) return `#${el.id}`;
  const v = el.getAttribute('data-value') || el.getAttribute('data-theme') || el.getAttribute('data-tab');
  const group = el.closest('[aria-label]')?.getAttribute('aria-label');
  if (v && group) return `[aria-label="${group}"] [data-value="${v}"], [aria-label="${group}"] [data-theme="${v}"]`;
  if (el.getAttribute('data-tab')) return `[data-tab="${el.getAttribute('data-tab')}"]`;
  return null;
}
function restoreFocus(sel: string | null): void {
  if (!sel) return;
  try { (document.querySelector(sel) as HTMLElement | null)?.focus({ preventScroll: true }); } catch { /* gone */ }
}

let lastHeight = 0;
function fit(): void {
  const hgt = Math.ceil(document.getElementById('sw')!.getBoundingClientRect().height);
  if (hgt && hgt !== lastHeight) { lastHeight = hgt; api.size(hgt); }
}

function showTab(t: SettingsTab): void {
  if (t === tab) return;
  tab = t;
  note = null;
  api.tab(t);
  draw();
}

// ---------------------------------------------------------------- fonts

/**
 * The installed monospace families: the Local Font Access API lists the
 * families, and a family is monospace when i, W and m are the same width.
 * Hidden system families (a leading dot) and symbol fonts are left out.
 */
async function monospaceFonts(): Promise<string[]> {
  const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
  let families: string[] = [];
  try { if (q) families = [...new Set((await q.call(window)).map((f) => f.family))]; } catch { /* not allowed */ }
  if (!families.length) families = [...FONT_FALLBACK, 'Monaco', 'Courier New', 'Andale Mono', 'PT Mono', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Source Code Pro', 'Ubuntu Mono'];
  const ctx = document.createElement('canvas').getContext('2d')!;
  const width = (fam: string, s: string) => { ctx.font = `40px "${fam}", serif`; return ctx.measureText(s).width; };
  const serif = (s: string) => { ctx.font = '40px serif'; return ctx.measureText(s).width; };
  const SYMBOL = /^(wingdings|webdings|symbol|zapf dingbats|bodoni ornaments|apple symbols)/i;
  return families.filter((f) => {
    if (f.startsWith('.') || SYMBOL.test(f) || /["\\]/.test(f)) return false;
    const a = width(f, 'iiiiiiiiii'), b = width(f, 'WWWWWWWWWW'), m = width(f, 'mmmmmmmmmm');
    // Not installed: the measure is serif's, which is not monospace anyway.
    if (Math.abs(a - serif('iiiiiiiiii')) < 0.01 && Math.abs(b - serif('WWWWWWWWWW')) < 0.01) return false;
    return Math.abs(a - b) < 0.5 && Math.abs(a - m) < 0.5;
  });
}

// ---------------------------------------------------------------- start

async function start(): Promise<void> {
  const w = await api.window();
  platform = w.platform;
  tab = w.tab;
  document.body.dataset.platform = platform;
  snap = await api.get();
  skills = await api.skills.get();
  api.skills.onChange((rows) => { skills = rows; draw(); });
  api.onChange((s) => { snap = s as SettingsSnapshot; draw(); });
  api.onShowTab((t) => showTab(t as SettingsTab));
  api.tab(tab);
  draw();
  fonts = await monospaceFonts();
  draw();
  document.body.dataset.ready = '1';
}

void start();
