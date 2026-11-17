// The open source licences, from Settings: THIRD_PARTY_NOTICES.txt, which
// build.mjs copies into the app as licences.txt, shown as it is.

import { h, replace, svg } from '../../desktop/src/renderer/dom.ts';
import * as I from './icons.ts';
import { back } from './main.ts';
import type { Screen } from './main.ts';
import { t } from './strings.ts';

export function licencesScreen(): Screen {
  const body = h('pre.lic', '');
  const el = h('div.scr.licences',
    h('header.sh.pgtop', h('button.icon-btn.fg', { 'aria-label': 'Back', on: { click: back } }, svg(I.BACK)), h('span.pgt', t('licences.phone'))),
    h('div.scroll', body));
  void fetch('licences.txt').then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status))))).then(
    (text) => { body.textContent = text; },
    () => { replace(body, t('licences.missing')); });
  return { el, update: () => {}, dispose: () => {} };
}
