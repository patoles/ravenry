// A pick, side by side (32, variant A): an agent shows 2 to 4 pictures and
// waits for the person's pick. Every picture at once with its letter and
// label, Pick A (or 1 to 4), Circle a part (drag a ring on the picture you
// pick, then say what you want there: the note is pinned to the ring),
// anything else for the agent, None of these, and Send B, with 1 note. The
// answer is { label, region (fractions of the picture), note }
// (PROTOCOL.md section 4, checkpoints, pick).

import type { CheckpointReply, Region } from '@ravenry/client';
import { h, replace, svg } from './dom.ts';
import * as I from './icons.ts';
import { isOpen, splitTitle, waiting, who } from './checkpoints.ts';
import type { Known } from './checkpoints.ts';

export interface PickerHost {
  now(): number;
  src(k: Known, n: number): string | null;
  /** "Tilting the hull, paper-boat". */
  where(k: Known): string | null;
  answer(k: Known, reply: CheckpointReply): Promise<void>;
  close(): void;
  canAnswer(k: Known): boolean;
}

interface State { id: string; picked: number | null; circling: boolean; region: Region | null; pin: string; editingPin: boolean; extra: string; busy: boolean; error: string | null }

const LETTERS = 'ABCD';

export class Picker {
  private st: State | null = null;
  k: Known | null = null;

  private el: HTMLElement;
  private host: PickerHost;
  constructor(el: HTMLElement, host: PickerHost) { this.el = el; this.host = host; }

  show(k: Known): void {
    if (!this.st || this.st.id !== k.cp.id) this.st = { id: k.cp.id, picked: null, circling: false, region: null, pin: '', editingPin: false, extra: '', busy: false, error: null };
    this.k = k;
    this.render();
  }

  /** A number key on the page picks that picture. */
  key(e: KeyboardEvent): boolean {
    if (!this.k || !this.st || e.metaKey || e.ctrlKey || e.altKey) return false;
    const t = e.target as HTMLElement | null;
    if (t && t.closest('input, textarea')) return false;
    const n = Number(e.key);
    if (n >= 1 && n <= (this.k.cp.variants || []).length) { this.pickN(n - 1); return true; }
    if (e.key === 'Escape') { this.host.close(); return true; }
    return false;
  }

  private pickN(n: number): void {
    const st = this.st!;
    if (st.picked !== n) { st.region = null; st.pin = ''; }
    st.picked = n;
    this.render();
  }

  private notes(): number { return this.st && this.st.region && this.st.pin.trim() ? 1 : 0; }

  private async send(decline = false): Promise<void> {
    const k = this.k!, st = this.st!;
    if (st.busy) return;
    if (!decline && st.picked === null) return;
    st.busy = true; st.error = null; this.render();
    try {
      if (decline) await this.host.answer(k, { decline: true, ...(st.extra.trim() ? { reason: st.extra.trim().slice(0, 1000) } : {}) });
      else {
        const label = (k.cp.variants || [])[st.picked!].label;
        const note = [st.region && st.pin.trim() ? st.pin.trim() : '', st.extra.trim()].filter(Boolean).join('\n\n').slice(0, 4000);
        await this.host.answer(k, { pick: { label, ...(st.region ? { region: st.region } : {}), ...(note ? { note } : {}) } });
      }
      this.host.close();
    } catch (e) {
      st.error = (e as Error).message;
    } finally {
      st.busy = false;
      if (this.k === k) this.render();
    }
  }

  render(): void {
    const k = this.k, st = this.st;
    if (!k || !st) { replace(this.el); return; }
    const cp = k.cp;
    const vs = cp.variants || [];
    const { head, body } = splitTitle(cp.title);
    const open = isOpen(cp) && this.host.canAnswer(k);
    const where = this.host.where(k);
    const cols = Math.min(vs.length, 3) || 1;
    const items = vs.map((v, n) => {
      const on = st.picked === n;
      const src = this.host.src(k, n);
      const img = h(`div.pv-img${st.circling ? '.drawing' : ''}`,
        src ? (v.type === 'html' ? h('div.t3', { style: { padding: '20px' } }, 'A page: open it from the board to see it.') : h('img', { src, alt: v.label, draggable: 'false' })) : h('div.t3', { style: { padding: '20px' } }, 'This picture is on another machine.'),
        h('span.plab', LETTERS[n] || String(n + 1)));
      if (on && st.region) {
        const r = st.region;
        img.append(h('div.ring-r', { style: { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` } }));
        const left = Math.min(r.x + r.w + 0.02, 0.98);
        const pinStyle: Record<string, string> = left > 0.62 ? { right: `${(1 - r.x + 0.02) * 100}%`, top: `${Math.max(2, r.y * 100 - 6)}%` } : { left: `${left * 100}%`, top: `${Math.max(2, r.y * 100 - 6)}%` };
        if (st.editingPin) {
          const inp = h('input', { type: 'text', placeholder: 'What do you want here?', value: st.pin, style: { background: 'none', border: '0', outline: '0', color: '#F2F2F4', font: 'inherit', width: '150px' } }) as HTMLInputElement;
          inp.addEventListener('input', () => { st.pin = inp.value; this.footer(); });
          inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); st.editingPin = false; this.render(); } e.stopPropagation(); });
          inp.addEventListener('blur', () => { if (st.editingPin) { st.editingPin = false; this.render(); } });
          img.append(h('div.note-pin', { style: pinStyle }, h('i', '1'), inp));
          requestAnimationFrame(() => inp.focus());
        } else if (st.pin.trim()) {
          img.append(h('div.note-pin', { style: { ...pinStyle, pointerEvents: 'auto' }, on: { click: () => { st.editingPin = true; this.render(); } } }, h('i', '1'), h('span', st.pin)));
        }
      }
      this.drawable(img, n);
      return h(`div.pv${on ? '.on' : ''}`,
        img,
        h('div.pv-t', v.label, on ? h('span.yp', 'Your pick') : null),
        v.description ? h('div.pv-w', `${who(cp)}: ${v.description}`) : null,
        h('div.pv-a',
          on ? h('button.btn.sm.pri', { disabled: !open }, svg(I.CHECK_C), 'Picked') : h('button.btn.sm', { disabled: !open, on: { click: () => this.pickN(n) } }, `Pick ${LETTERS[n] || n + 1}`),
          h('span.kb', String(n + 1))));
    });
    replace(this.el,
      h('div.pk-h',
        h('div.tt',
          h('div.pk-k', svg(I.PICK), h('b', `${who(cp)} asks you to pick`), where ? h('span', where) : null),
          h('h2', head),
          body ? h('div.t2', { style: { fontSize: '13px' } }, body) : null),
        h('span.t3.small.num', { style: { marginTop: '2px' } }, waiting(cp, this.host.now())),
        h('button.icon-btn.sm', { title: 'Close (Esc)', 'aria-label': 'Close', on: { click: () => this.host.close() } }, svg(I.CLOSE))),
      h('div.pk-row', { style: { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } }, items),
      st.error ? h('p.cp-err', { style: { padding: '0 22px' } }, st.error) : null,
      this.footerEl = h('div.pk-f'));
    this.footer();
  }

  private footerEl: HTMLElement | null = null;

  /** The bar at the bottom, redrawn alone while the note is typed. */
  private footer(): void {
    const k = this.k!, st = this.st!, f = this.footerEl!;
    const open = isOpen(k.cp) && this.host.canAnswer(k);
    const n = this.notes();
    const letter = st.picked !== null ? LETTERS[st.picked] || String(st.picked + 1) : null;
    const extra = h('input.note', { type: 'text', placeholder: `Anything else for ${who(k.cp)} (optional)`, value: st.extra, 'aria-label': `Anything else for ${who(k.cp)}` }) as HTMLInputElement;
    extra.addEventListener('input', () => { st.extra = extra.value; });
    extra.addEventListener('keydown', (e) => { if (e.key === 'Enter' && st.picked !== null) { e.preventDefault(); void this.send(); } e.stopPropagation(); });
    const had = document.activeElement === f.querySelector('input.note');
    replace(f,
      h(`button.btn.sm.circ${st.circling ? '.on' : ''}`, { disabled: !open, title: 'Drag a ring around a part of a picture', on: { click: () => { st.circling = !st.circling; this.render(); } } }, svg(I.CIRCLE), st.circling ? 'Drag on a picture' : 'Circle a part'),
      extra,
      h('button.btn.ghost', { disabled: !open || st.busy, on: { click: () => void this.send(true) } }, 'None of these'),
      h('button.btn.pri', { disabled: !open || st.busy || st.picked === null, on: { click: () => void this.send() } }, letter ? `Send ${letter}${n ? `, with ${n} note` : ''}` : 'Pick one first'));
    if (had) { const i = f.querySelector('input.note') as HTMLInputElement; i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  }

  /** Dragging on a picture while circling draws the ring (and picks it). */
  private drawable(img: HTMLElement, n: number): void {
    img.addEventListener('mousedown', (e) => {
      const st = this.st!;
      if (!st.circling || e.button !== 0) return;
      e.preventDefault();
      const box = img.getBoundingClientRect();
      const x0 = (e.clientX - box.left) / box.width, y0 = (e.clientY - box.top) / box.height;
      const ring = h('div.ring-r');
      img.append(ring);
      const at = (ev: MouseEvent): Region => {
        const x1 = Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width)), y1 = Math.min(1, Math.max(0, (ev.clientY - box.top) / box.height));
        return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      };
      const move = (ev: MouseEvent) => { const r = at(ev); Object.assign(ring.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }); };
      const up = (ev: MouseEvent) => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        const r = at(ev);
        if (r.w < 0.02 || r.h < 0.02) { ring.remove(); return; }
        st.picked = n; st.region = round(r); st.circling = false; st.editingPin = true;
        this.render();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  /** For tests and screenshots: a ring and its note, as a drag would leave them. */
  circle(n: number, r: Region, note: string): void {
    if (!this.st) return;
    this.st.picked = n; this.st.region = round(r); this.st.pin = note; this.st.editingPin = false; this.st.circling = false;
    this.render();
  }
}

const round = (r: Region): Region => ({ x: +r.x.toFixed(4), y: +r.y.toFixed(4), w: +r.w.toFixed(4), h: +r.h.toFixed(4) });
