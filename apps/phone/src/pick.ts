// A pick on the phone (the Phase 2 picture's phone frames, 32c): the agent
// shows 2 to 4 variants and waits for the person's choice.
//
//   swipe    one picture at a time, full width, with its letter ("B, 2 of
//            3"), its name and the agent's words under it; Circle a part,
//            None of these, and Pick B, which names the one on screen
//   circle   the chosen picture alone: a finger draws around a part, then
//            "Circled. Say what you want there." and a note (typed or
//            spoken), Circle again, and Send B, with the note
//
// The pictures are the hub's copies in Ravenry's data (GET
// /api/checkpoints/<id>/variants/<n>, through the shell with the device
// token), never the agent's own files. The answer is the person's:
// POST /api/checkpoints/answer { id, pick: { label, region?, note? } }, or a
// decline for None of these.

import { h, replace, svg } from '../../desktop/src/renderer/dom.ts';
import { splitTitle, who } from '../../desktop/src/renderer/checkpoints.ts';
import type { HubCheckpoint } from '../../desktop/src/renderer/checkpoints.ts';
import * as I from './icons.ts';
import { current, hubUrl } from './shell.ts';
import { regionOf, variantOf } from './logic.ts';

export interface PickUI {
  /** The picture on screen. */
  i: number;
  mode: 'swipe' | 'circle' | 'circled';
  /** The finger's path, in fractions of the picture. */
  path: [number, number][];
  note: string;
  busy: boolean;
  error: string | null;
}

export const newPick = (): PickUI => ({ i: 0, mode: 'swipe', path: [], note: '', busy: false, error: null });

export interface PickCtx {
  topBar(cp: HubCheckpoint, icon: string): HTMLElement;
  fromLine(cp: HubCheckpoint): HTMLElement[];
  answer(cp: HubCheckpoint, reply: Record<string, unknown>): Promise<void>;
  repaint(): void;
  done(said: string): void;
}

const variantUrl = (cp: HubCheckpoint, n: number): string => hubUrl(`/api/checkpoints/${encodeURIComponent(cp.id)}/variants/${n}`);

/** The circle as drawn: the finger's path, closed smoothly, over the picture. */
function circleSvg(path: [number, number][]): SVGElement {
  const pts = path.map(([x, y]) => `${(x * 1000).toFixed(1)},${(y * 1000).toFixed(1)}`).join(' ');
  return svg(`<svg class="ov" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">${path.length > 1 ? `<polyline points="${pts}" fill="none" stroke="#FF9F0A" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` : ''}</svg>`) as unknown as SVGElement;
}

/** One variant's picture, with its letter; an HTML variant runs sandboxed, with no scripts. */
function slide(cp: HubCheckpoint, n: number, total: number, extra: (Node | null)[] = []): HTMLElement {
  const v = (cp.variants || [])[n];
  const { letter } = variantOf(v, n, '');
  const missing = h('div.pmiss', 'The picture is not on the computer yet.');
  missing.hidden = true;
  const media = v && v.type === 'html'
    ? h('iframe.phtml', { src: variantUrl(cp, n), sandbox: '', title: v.label, loading: 'lazy' })
    : h('img', { src: variantUrl(cp, n), alt: v ? v.label : '', draggable: 'false', on: { error: () => { missing.hidden = false; } } });
  return h('div.pimg', { 'data-n': String(n) }, media, missing, ...extra, h('span.lt', `${letter}, ${n + 1} of ${total}`));
}

export function pickView(cp: HubCheckpoint, ui: PickUI, x: PickCtx): HTMLElement {
  const sh = current();
  const vs = cp.variants || [];
  const n = vs.length;
  if (ui.i >= n) ui.i = 0;
  const t = splitTitle(cp.title);
  const nameOf = (i: number) => variantOf(vs[i], i, who(cp));

  const send = async (reply: Record<string, unknown>, said: string) => {
    if (ui.busy) return;
    ui.busy = true; ui.error = null; x.repaint();
    try { await x.answer(cp, reply); x.done(said); } catch (e) { ui.busy = false; ui.error = (e as Error).message; x.repaint(); }
  };
  const pickNow = () => {
    const v = vs[ui.i];
    if (!v) return;
    const region = ui.mode === 'circled' ? regionOf(ui.path) : null;
    const note = ui.mode === 'circled' ? ui.note.trim().slice(0, 4000) : '';
    const { letter, name } = nameOf(ui.i);
    void send({ pick: { label: v.label, ...(region ? { region } : {}), ...(note ? { note } : {}) } }, `Sent: ${letter}, ${name}${note ? ', with your note' : region ? ', with the part you circled' : ''}.`);
  };

  // ------------------------------------------------ swipe
  if (ui.mode === 'swipe') {
    const cap = h('p.pcap');
    const dots = h('div.dots3');
    const pickLabel = h('span');
    const paintCap = () => {
      const { name, says, letter } = nameOf(ui.i);
      replace(cap, h('b', /[.!?]$/.test(name) ? name : `${name}.`), says ? ` ${says}` : null);
      replace(dots, vs.map((_, i) => h(`i${i === ui.i ? '.on' : ''}`)), n > 1 ? h('span', 'Swipe for the others') : null);
      pickLabel.textContent = `Pick ${letter}`;
    };
    const track = h('div.ptrack', vs.map((_, i) => slide(cp, i, n)));
    // The picture on screen follows the swipe; only its words change, so the
    // track keeps scrolling under the finger.
    track.addEventListener('scroll', () => {
      const w = track.clientWidth;
      if (!w) return;
      const i = Math.max(0, Math.min(n - 1, Math.round(track.scrollLeft / w)));
      if (i !== ui.i) { ui.i = i; paintCap(); }
    }, { passive: true });
    requestAnimationFrame(() => { track.scrollLeft = ui.i * track.clientWidth; });
    paintCap();
    return h('div.pcp.ppick',
      x.topBar(cp, I.PICS), ...x.fromLine(cp),
      h('h2.sm', t.head),
      track, cap, dots,
      ui.error ? h('p.err', ui.error) : null,
      h('div.pcp-b',
        h('div.two',
          h('button.btn', { disabled: ui.busy, on: { click: () => { ui.mode = 'circle'; ui.path = []; ui.error = null; x.repaint(); } } }, svg(I.CIRCLE), 'Circle a part'),
          h('button.btn', { disabled: ui.busy, on: { click: () => void send({ decline: true }, 'Sent: none of these.') } }, 'None of these')),
        h('button.btn.pri.big', { disabled: ui.busy, on: { click: pickNow } }, pickLabel)));
  }

  // ------------------------------------------------ circle, and the note
  const { letter } = nameOf(ui.i);
  const ov = circleSvg(ui.path);
  const pad = h('div.pdraw');
  const pic = slide(cp, ui.i, n, [ov, ui.mode === 'circle' ? pad : null]);
  if (ui.mode === 'circle') {
    let path: [number, number][] = [];
    const at = (e: PointerEvent): [number, number] => {
      const r = pad.getBoundingClientRect();
      return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
    };
    const draw = () => { const o = circleSvg(path); pic.replaceChild(o, pic.querySelector('svg.ov')!); };
    pad.addEventListener('pointerdown', (e) => { pad.setPointerCapture(e.pointerId); path = [at(e)]; draw(); });
    pad.addEventListener('pointermove', (e) => { if (!path.length || !pad.hasPointerCapture(e.pointerId)) return; path.push(at(e)); draw(); });
    pad.addEventListener('pointerup', () => {
      if (!regionOf(path)) { path = []; draw(); return; }
      // Closed into a loop, as a circle drawn with a finger reads.
      ui.path = [...path, path[0]]; ui.mode = 'circled'; x.repaint();
    });
  }
  let field: HTMLTextAreaElement | null = null;
  let sendLabel: HTMLElement | null = null;
  const paintSend = () => { if (sendLabel) sendLabel.textContent = ui.note.trim() ? `Send ${letter}, with the note` : `Send ${letter}, with the circle`; };
  if (ui.mode === 'circled') {
    field = h('textarea.f.pnote', { rows: '2', placeholder: 'This, but...', 'aria-label': 'What you want there', enterkeyhint: 'send', autocomplete: 'off', spellcheck: 'true' }) as HTMLTextAreaElement;
    field.value = ui.note;
    const fit = () => { field!.style.height = 'auto'; field!.style.height = `${Math.min(field!.scrollHeight, 140)}px`; };
    field.addEventListener('input', () => { ui.note = field!.value; fit(); paintSend(); });
    field.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter' && !(e as KeyboardEvent).shiftKey) { e.preventDefault(); pickNow(); } });
    requestAnimationFrame(fit);
  }
  const mic = sh.has('speech') && field ? h('button.mic', { 'aria-label': 'Speak', on: { click: async () => {
    try { const r = await sh.call<{ text: string }>('speech'); if (r && r.text && field) { field.value = (field.value ? field.value.trimEnd() + ' ' : '') + r.text; ui.note = field.value; paintSend(); } } catch (e) { ui.error = (e as Error).message; x.repaint(); }
  } } }, svg(I.MIC)) : null;
  sendLabel = h('span');
  paintSend();
  return h('div.pcp.ppick',
    x.topBar(cp, I.PICS), ...x.fromLine(cp),
    h('div.ptrack.one', pic),
    h('p.pcap', ui.mode === 'circle' ? 'Draw around the part you mean with a finger.' : 'Circled. Say what you want there.'),
    field ? h('div.pfield.pnf', field, mic) : null,
    ui.error ? h('p.err', ui.error) : null,
    h('div.pcp-b',
      ui.mode === 'circle'
        ? [h('button.btn.sm2', { disabled: ui.busy, on: { click: () => { ui.mode = 'swipe'; ui.path = []; x.repaint(); } } }, 'Back to the pictures'),
          h('button.btn.pri.big', { disabled: ui.busy, on: { click: pickNow } }, `Pick ${letter}`)]
        : [h('button.btn.sm2', { disabled: ui.busy, on: { click: () => { ui.mode = 'circle'; ui.path = []; x.repaint(); } } }, 'Circle again'),
          h('button.btn.pri.big', { disabled: ui.busy, on: { click: pickNow } }, sendLabel)]));
}
