// The Machines page: the computers the hub reaches over ssh, each with its
// state, its ravenryd beside the one this app carries, and the installer
// (hub/server/remoteinstall.mjs): Add a machine, Install, Update, Uninstall,
// each step shown with what it did or why it stopped. It takes the middle
// and right columns, as a page does, and opens from the server mark in the
// sidebar's foot, which carries a dot while a machine needs the person.

import './machines.css';
import { h, replace, svg } from './dom.ts';

// The steps' marks, drawn as the checkpoint cards' are, and the sidebar's
// server mark at the foot's size.
const ICON = {
  done: '<svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="var(--ok)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="5.8"/><path d="M4.4 7.2l1.8 1.8 3.4-3.6"/></svg>',
  failed: '<svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="var(--bad)" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="5.8"/><path d="M5 5l4 4M9 5l-4 4"/></svg>',
  warn: '<svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="var(--you)" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M7 1.8l5.6 10H1.4z"/><path d="M7 5.6v2.8M7 10.2v.01" stroke-linecap="round"/></svg>',
  pending: '<svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="var(--idle)" stroke-width="1.5" aria-hidden="true"><circle cx="7" cy="7" r="5.5"/></svg>',
  running: '<svg class="spin" width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="var(--work)" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="5.5" stroke-dasharray="3 2"/><circle cx="7" cy="7" r="2" fill="var(--work)" stroke="none"/></svg>',
};
export const MACHINES_ICON = '<svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="1.5" y="2" width="11" height="4" rx="1.2"/><rect x="1.5" y="8" width="11" height="4" rx="1.2"/><path d="M4 4h.01M4 10h.01" stroke-width="2" stroke-linecap="round"/></svg>';

export interface JobStep {
  id: string; title: string; state: 'pending' | 'running' | 'done' | 'failed' | 'warn' | 'skipped';
  detail: string | null; fix?: string | null; fixWhat?: string | null; action?: string | null;
  progress?: { done: number; total: number } | null; ms?: number;
}
export interface Job { kind: 'install' | 'uninstall'; state: 'running' | 'done' | 'failed' | 'needs'; steps: JobStep[]; startedAt: string; endedAt: string | null; needs: { kind: string; count: number } | null; version: string | null }
export interface MachineView {
  name: string; host: string; command: string; state: string; error: string | null; version: string | null; answers: boolean | null;
  os: string | null; arch: string | null; protocol: number | null; older: string[]; missing: boolean;
  remote: { version: string; protocol: number | null; os: string | null; arch: string | null } | null;
  ours: string | null; compare: 'older' | 'same' | 'newer' | 'protocol' | 'missing' | null; job: Job | null;
  /** Why ssh failed, in plain words, and the command that fixes it. */
  explain: { why: string; fix?: string | null; fixWhat?: string | null } | null;
}
interface Listing { machines?: MachineView[]; hosts?: string[]; builds?: { version: string; systems: string[]; source: string } | null }

export interface MachinesCtx {
  call(method: 'GET' | 'POST', p: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  toast(text: string): void;
  copy(text: string): void;
}

const SYSTEM: Record<string, string> = { darwin: 'macOS', linux: 'Linux' };
const ARCH: Record<string, string> = { amd64: 'x86-64', x64: 'x86-64', arm64: 'arm64' };
const systemOf = (os: string | null, arch: string | null) => (os ? `${SYSTEM[os] || os}${arch ? `, ${ARCH[arch] || arch}` : ''}` : null);
const mb = (n: number) => `${(n / 1048576).toFixed(1)}`;

/** A machine needs the person: older or another protocol, not installed, or an install that stopped. */
export function needsYou(m: MachineView): boolean {
  if (m.job && (m.job.state === 'failed' || m.job.state === 'needs')) return true;
  return m.compare === 'older' || m.compare === 'protocol' || m.compare === 'missing';
}

// Paths in a step's words, set in the monospace face.
function words(text: string | null): (string | HTMLElement)[] {
  if (!text) return [];
  const out: (string | HTMLElement)[] = [];
  const re = /((?:~|\/)[\w.@+-]*(?:\/[\w.@+-]+)+|ssh-copy-id \S+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('span.mono', m[1]));
    last = m.index + m[1].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const STEP_ICON: Record<string, string> = { ...ICON, skipped: ICON.pending };

export class Machines {
  private el: HTMLElement;
  private ctx: MachinesCtx;
  list: MachineView[] = [];
  private hosts: string[] = [];
  private builds: Listing['builds'] = null;
  private adding = false;
  private form = { host: '', name: '' };
  private addError: string | null = null;
  private busy = new Set<string>();
  private confirm: string | null = null;
  /** Jobs whose steps the person folded away, by machine and start. */
  private folded = new Set<string>();
  private errors = new Map<string, string>();
  private timer: number | null = null;
  private visible = false;
  private loaded = false;

  constructor(el: HTMLElement, ctx: MachinesCtx) {
    this.el = el;
    this.ctx = ctx;
  }

  /** Whether any machine needs the person (the dot on the sidebar's mark). */
  attention(): boolean { return this.list.some((m) => this.needs(m)); }

  /** needsYou, less a stopped job whose steps the person put away. */
  private needs(m: MachineView): boolean {
    const j = m.job;
    if (j && j.state === 'running') return false;
    if (j && j.state !== 'running' && this.folded.has(`${m.name}|${j.startedAt}`)) return needsYou({ ...m, job: null });
    return needsYou(m);
  }

  /** The machines as the hub's state lists them, between the page's own reads. */
  update(list: MachineView[] | undefined): void {
    if (!Array.isArray(list)) return;
    this.list = list;
    if (this.visible) this.render();
  }

  show(): void {
    this.visible = true;
    this.render();
    void this.load();
  }

  hide(): void {
    this.visible = false;
    this.confirm = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** Opens the Add card (the page's own button, or a test). */
  openAdd(host = ''): void {
    this.adding = true;
    this.form = { host, name: '' };
    this.addError = null;
    this.render();
    requestAnimationFrame(() => (this.el.querySelector('#m-host') as HTMLInputElement | null)?.focus());
  }

  private async load(): Promise<void> {
    try {
      const r = await this.ctx.call('GET', '/api/machines');
      const b = r.body as Listing;
      if (r.status === 200 && b) {
        this.list = b.machines || [];
        this.hosts = b.hosts || [];
        this.builds = b.builds ?? null;
        this.loaded = true;
      }
    } catch { /* the board is away: the last list stays */ }
    if (!this.visible) return;
    this.render();
    const running = this.list.some((m) => m.job && m.job.state === 'running') || this.list.some((m) => m.state === 'connecting');
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.load(), running ? 500 : 4000);
  }

  private async post(p: string, body: unknown, name: string): Promise<boolean> {
    this.busy.add(name);
    this.errors.delete(name);
    this.render();
    try {
      const r = await this.ctx.call('POST', p, body);
      const b = r.body as { error?: string; machines?: MachineView[] };
      if (r.status !== 200) { this.errors.set(name, b && b.error ? b.error : `The board answered ${r.status}.`); return false; }
      if (b && Array.isArray(b.machines)) this.list = b.machines;
      return true;
    } catch (e) {
      this.errors.set(name, (e as Error).message);
      return false;
    } finally {
      this.busy.delete(name);
      this.render();
      void this.load();
    }
  }

  install(name: string, replaceHooks = false): Promise<boolean> { this.confirm = null; return this.post('/api/machines/install', { name, ...(replaceHooks ? { replaceHooks: true } : {}) }, name); }
  uninstall(name: string, endSessions = false): Promise<boolean> { this.confirm = null; return this.post('/api/machines/uninstall', { name, ...(endSessions ? { endSessions: true } : {}) }, name); }
  private retry(name: string): Promise<boolean> { return this.post('/api/machines/retry', { name }, name); }
  private remove(name: string): Promise<boolean> { return this.post('/api/machines/remove', { name }, name); }

  async add(install: boolean): Promise<void> {
    const host = this.form.host.trim();
    if (!host) { this.addError = 'Type a host first: a name from ~/.ssh/config, or user@host.'; this.render(); return; }
    const name = this.form.name.trim() || host.replace(/^.*@/, '');
    this.busy.add('+add');
    this.addError = null;
    this.render();
    try {
      const r = await this.ctx.call('POST', '/api/machines/add', { host, ...(this.form.name.trim() ? { name } : {}) });
      const b = r.body as { error?: string; machines?: MachineView[] };
      if (r.status !== 200) { this.addError = b && b.error ? b.error : `The board answered ${r.status}.`; return; }
      if (b && Array.isArray(b.machines)) this.list = b.machines;
      this.adding = false;
      if (install) await this.install(name);
    } catch (e) {
      this.addError = (e as Error).message;
    } finally {
      this.busy.delete('+add');
      this.render();
    }
  }

  // ---------------------------------------------------------------- render

  render(): void {
    if (!this.visible) return;
    const head = h('div.pg-h',
      h('div.tt', h('h2', 'Machines'), h('div.pg-src', 'Sessions on other computers, reached over ssh with your keys')),
      this.adding ? null : h('button.btn.sm.pri', { on: { click: () => this.openAdd() } }, 'Add a machine'));
    const order = (m: MachineView) => (m.job && m.job.state === 'running' ? 0 : this.needs(m) ? 1 : m.state === 'connected' ? 3 : 2);
    const rows = [...this.list].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name)).map((m) => this.card(m));
    const empty = !this.list.length && !this.adding && this.loaded
      ? h('div.m-empty', h('p', 'No machines yet. Add one to start sessions on another computer: a server, a desktop at home, a box with a GPU.'), h('button.btn.pri', { on: { click: () => this.openAdd() } }, 'Add a machine'))
      : null;
    // Keep the field the person types in.
    const focused = document.activeElement && this.el.contains(document.activeElement) ? (document.activeElement as HTMLElement).id : null;
    const sel = focused ? (document.activeElement as HTMLInputElement).selectionStart : null;
    // A render every half second must not move the page under the person.
    const top = (this.el.querySelector('.pg-b') as HTMLElement | null)?.scrollTop || 0;
    replace(this.el, head, h('div.pg-b.m-b', this.adding ? this.addCard() : null, empty, rows));
    if (top) (this.el.querySelector('.pg-b') as HTMLElement).scrollTop = top;
    if (focused) {
      const f = document.getElementById(focused) as HTMLInputElement | null;
      if (f) { f.focus(); if (sel != null && typeof f.setSelectionRange === 'function') f.setSelectionRange(sel, sel); }
    }
  }

  private addCard(): HTMLElement {
    const busy = this.busy.has('+add');
    const noBuilds = !this.builds;
    const input = (id: string, key: 'host' | 'name', ph: string) => h('input.m-inp', {
      id, value: this.form[key], placeholder: ph, spellcheck: 'false', autocomplete: 'off',
      on: {
        input: (e: Event) => { this.form[key] = (e.target as HTMLInputElement).value; },
        keydown: (e: Event) => { const k = e as KeyboardEvent; if (k.key === 'Enter') void this.add(!noBuilds); if (k.key === 'Escape') { this.adding = false; this.render(); } },
      },
    });
    const chips = this.hosts.length
      ? h('div.m-chips', h('span.m-hint', 'From ~/.ssh/config:'), this.hosts.slice(0, 12).map((x) => h(`button.m-chip${this.form.host === x ? '.on' : ''}`, { on: { click: () => { this.form.host = x; this.render(); } } }, x)))
      : null;
    return h('div.m-add',
      h('span.m-add-h', 'Add a machine'),
      h('div.m-fields',
        h('label.m-fl.grow', h('span', 'Host'), input('m-host', 'host', 'devbox, or user@host')),
        h('label.m-fl.nm', h('span', 'Name on the board'), input('m-name', 'name', this.form.host.replace(/^.*@/, '') || 'devbox'))),
      chips,
      h('p.m-hint', noBuilds
        ? 'ssh uses your keys and ~/.ssh/config, and never asks for a password. This copy of Ravenry carries no ravenryd to install, so add a machine that has it already.'
        : `ssh uses your keys and ~/.ssh/config, and never asks for a password. Ravenry puts ravenryd ${this.builds!.version} in that machine's home folder and adds its hooks for Claude Code and Codex; nothing needs sudo.`),
      this.addError ? h('p.m-err', this.addError) : null,
      h('div.m-acts',
        noBuilds ? null : h('button.btn.pri', { disabled: busy, on: { click: () => void this.add(true) } }, 'Add and install'),
        h(`button.btn${noBuilds ? '.pri' : '.ghost'}`, { disabled: busy, on: { click: () => void this.add(false) } }, noBuilds ? 'Add' : 'Add only, it is installed'),
        h('span.sp'),
        h('button.btn.ghost', { disabled: busy, on: { click: () => { this.adding = false; this.render(); } } }, 'Cancel')));
  }

  /** The state word beside a machine's name, and its colour. */
  private status(m: MachineView): [string, string] {
    const j = m.job;
    if (j && j.state === 'running') return [j.kind === 'install' ? (m.compare === 'older' || m.version ? 'Updating' : 'Installing') : 'Uninstalling', 'work'];
    if (j && j.state === 'needs') return ['Sessions still run there', 'bad'];
    if (j && j.state === 'failed') return [j.kind === 'install' ? 'Install stopped' : 'Uninstall stopped', 'bad'];
    if (m.compare === 'protocol') return ['Cannot talk to it', 'bad'];
    if (m.state === 'connected') {
      if (m.compare === 'older') return ['Older ravenryd', 'you'];
      if (m.compare === 'newer') return ['Newer ravenryd', 'you'];
      if (j && j.state === 'done' && j.steps.some((s) => s.state === 'warn')) return ['Installed, hooks left as they were', 'you'];
      return ['Connected', 'ok'];
    }
    if (m.missing) return ['Not installed', 'off'];
    if (m.state === 'held') return ['Paused', 'off'];
    if (m.state === 'connecting' || m.state === 'off') return ['Connecting', 'off'];
    return ['Cannot connect', 'bad'];
  }

  private card(m: MachineView): HTMLElement {
    const [word, tone] = this.status(m);
    const j = m.job;
    const busy = this.busy.has(m.name);
    const running = !!(j && j.state === 'running');
    const ours = m.ours;
    const btn = (label: string, run: () => void, cls = '') => h(`button.btn.sm${cls}`, { disabled: busy || running, on: { click: run } }, label);

    // What to do: one main action, and the quiet ones.
    let right: (HTMLElement | null)[] = [];
    let msg: (string | HTMLElement)[] | null = null;
    if (running) right = [];
    else if (j && j.state === 'failed') right = [btn('Remove', () => void this.remove(m.name), '.ghost'), btn('Try again', () => void (j.kind === 'install' ? this.install(m.name) : this.uninstall(m.name)))];
    else if (j && j.state === 'needs') right = [];
    else if (m.compare === 'protocol') {
      const r = m.remote;
      const newerProto = r && r.protocol != null && r.protocol > 1;
      msg = [`${m.name} runs ravenryd `, h('b', r ? r.version : 'of another protocol'), r && r.protocol != null ? `, which speaks protocol ${r.protocol}` : '', `; this app speaks protocol 1. `,
        newerProto ? `Update this app to use it${ours ? `, or install ${ours} there` : ''}.` : 'Update it there: its sessions keep running on the old daemon until they end.'];
      right = ours ? [btn(newerProto ? `Install ${ours} there` : `Update ${m.name}`, () => void this.install(m.name), newerProto ? '' : '.pri')] : [];
    } else if (m.state === 'connected' && m.compare === 'older') {
      msg = [`${m.name} runs ravenryd `, h('b', m.version || '?'), '; this app carries ', h('b', ours || '?'), '. Its sessions keep running on ', m.version || 'it', ' until they end; new sessions start on ', ours || 'the new one', '.'];
      right = [btn(`Update ${m.name}`, () => void this.install(m.name), '.pri')];
    } else if (m.state === 'connected' && m.compare === 'newer') {
      msg = [`${m.name} runs ravenryd `, h('b', m.version || '?'), ', newer than this app\'s ', h('b', ours || '?'), '. It works: the protocol is the same. Update this app to use what is new there.'];
      right = [btn(`Install ${ours} there`, () => void this.install(m.name))];
    } else if (m.state === 'connected') {
      right = [ours ? btn('Uninstall', () => { this.confirm = m.name; this.render(); }, '.ghost') : null, ours ? btn('Run install again', () => void this.install(m.name)) : null];
    } else if (m.missing) {
      msg = [`ssh reaches ${m.name}, but ravenryd is not there yet. Install puts it in `, h('span.mono', '~/.ravenry/bin'), ' and adds the hooks; no sudo.'];
      right = [btn('Remove', () => void this.remove(m.name), '.ghost'), ours ? btn('Install', () => void this.install(m.name), '.pri') : null];
    } else if (m.state === 'down') {
      const x = m.explain;
      msg = [...words(x ? x.why : m.error || 'ssh closed the connection.'), ...(x && x.fix ? [' ', x.fixWhat || '', ' ', h('span.m-cmd', x.fix)] : [])];
      right = [btn('Remove', () => void this.remove(m.name), '.ghost'), btn('Try again', () => void this.retry(m.name))];
    }

    const facts: (string | HTMLElement)[] = [];
    const sys = systemOf(m.os, m.arch);
    if (m.state === 'connected') {
      if (sys) facts.push(h('span', sys));
      if (m.version && m.compare !== 'older' && m.compare !== 'newer') facts.push(h('span', 'ravenryd ', h('b', m.version)));
      for (const v of m.older || []) facts.push(h('span', `Sessions on ${v} until they end`));
      if (m.answers) facts.push(h('span', 'Answers from here'));
      else facts.push(h('span', 'Another board takes its answers'));
    }

    const confirm = this.confirm === m.name && !running ? h('div.m-confirm',
      h('p.m-msg', h('b', `Uninstall from ${m.name}?`), ' Ravenry removes what it installed there: ', h('span.mono', '~/.ravenry/bin/ravenryd'), ', the ', h('span.mono', 'ravenry'), ' link beside it, and its hook lines in Claude Code\'s and Codex\'s settings (each backed up first). ', `${m.name} then leaves this list. Its pane logs stay.`),
      h('div.m-acts', h('button.btn.sm.danger', { disabled: busy, on: { click: () => void this.uninstall(m.name) } }, 'Uninstall'), h('button.btn.sm.ghost', { on: { click: () => { this.confirm = null; this.render(); } } }, 'Cancel'))) : null;

    const fold = j ? `${m.name}|${j.startedAt}` : '';
    const showSteps = !!j && (j.state === 'running' || !this.folded.has(fold));
    const err = this.errors.get(m.name);
    const tag = confirm ? '.bad' : this.needs(m) || (m.state === 'connected' && m.compare === 'newer') ? (tone === 'bad' ? '.bad' : '.att') : '';
    if (confirm) right = [];
    return h(`div.m-card${tag}`, { 'data-machine': m.name },
      h('div.m-h',
        h('span.m-nm', m.name),
        h('span.m-ho.mono', m.host),
        h(`span.m-st.${tone}`, h('i'), word),
        h('span.sp'),
        j && (j.state === 'done' || j.state === 'failed') && showSteps ? h('button.btn.sm.ghost', { on: { click: () => { this.folded.add(fold); this.render(); } } }, 'Hide steps') : null,
        ...right),
      msg && !showSteps ? h('p.m-msg', msg) : null,
      facts.length && !(showSteps && j && j.state !== 'done') ? h('div.m-facts', facts) : null,
      showSteps ? this.steps(m, j!) : null,
      confirm,
      err ? h('p.m-err', err) : null);
  }

  private steps(m: MachineView, j: Job): HTMLElement {
    return h('div.m-steps', j.steps.map((s) => {
      const bar = s.state === 'running' && s.progress && s.progress.total ? h('div.m-bar', h('i', { style: { width: `${Math.round((100 * s.progress.done) / s.progress.total)}%` } })) : null;
      const amount = s.state === 'running' && s.progress && s.progress.total ? `${mb(s.progress.done)} of ${mb(s.progress.total)} MB` : null;
      const fix = s.fix ? h('div.m-fix', s.fixWhat ? h('span', s.fixWhat) : null, h('span.m-cmd', s.fix), h('button.btn.sm.ghost', { on: { click: () => { this.ctx.copy(s.fix!); this.ctx.toast('Copied.'); } } }, 'Copy')) : null;
      let act: HTMLElement | null = null;
      if (s.action === 'replaceHooks' && j.state === 'done') act = h('div.m-fix', h('button.btn.sm', { disabled: this.busy.has(m.name), on: { click: () => void this.install(m.name, true) } }, 'Use Ravenry\'s instead'), h('span.m-hint', 'Uninstall puts yours back.'));
      if (s.action === 'endSessions' && j.state === 'needs') act = h('div.m-fix', h('button.btn.sm.danger', { disabled: this.busy.has(m.name), on: { click: () => void this.uninstall(m.name, true) } }, `End ${j.needs && j.needs.count === 1 ? 'it' : 'them'} and uninstall`), h('button.btn.sm.ghost', { on: { click: () => void this.dismiss(m) } }, 'Cancel'));
      return h(`div.m-step.${s.state}`, { 'data-step': s.id },
        h('span.ic', svg(STEP_ICON[s.state] || ICON.pending)),
        h('div.bd', h('span.h', s.title), s.detail ? h('span.d', words(s.detail)) : null, bar, fix, act),
        amount ? h('span.tm.num', amount) : s.ms != null && s.state === 'done' && s.ms >= 1000 ? h('span.tm.num', `${(s.ms / 1000).toFixed(1)} s`) : null);
    }));
  }

  /** Cancel on "sessions still run": the steps go, nothing was changed. */
  private dismiss(m: MachineView): void {
    if (m.job) this.folded.add(`${m.name}|${m.job.startedAt}`);
    this.render();
  }
}
