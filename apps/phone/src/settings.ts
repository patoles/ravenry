// The app's settings, behind the gear (the approved mock, frame b): the
// computer this phone is paired with and whether it answers, alerts by push
// (UnifiedPush) on or off, the held connection on or off, that Run always
// asks for a fingerprint (said, not a switch), the privacy page, the open
// source licences, and Sign out.
//
// Wired to the hub (GET /api/phone/me) and to the shell (push.status,
// push.set, connection.get, connection.set, pair.reset).

import { h, replace, svg } from '../../desktop/src/renderer/dom.ts';
import * as I from './icons.ts';
import * as hub from './hub.ts';
import { current } from './shell.ts';
import { back, go, sheet, toast } from './main.ts';
import { distributorName } from './logic.ts';
import type { Screen } from './main.ts';
import { bioWord, deviceWord, t } from './strings.ts';

interface Me { device?: { id: string; name: string; push?: string | null } | null; hub?: { name: string } | null; access?: boolean }
interface PushStatus { distributors: string[]; current: string | null; off: boolean }

export function settingsScreen(): Screen {
  const el = h('div.scr.settings');
  const sh = current();
  const st: { me: Me | null; push: PushStatus | null; conn: boolean | null; alerts: boolean | null; busy: boolean } = { me: null, push: null, conn: null, alerts: null, busy: false };

  const toggle = (on: boolean, enabled: boolean, flip: () => void, label: string) =>
    h(`button.tg${on ? '' : '.off'}`, { role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label, disabled: !enabled || st.busy, on: { click: flip } });

  async function load(): Promise<void> {
    const r = await hub.call('GET', '/api/phone/me').catch(() => null);
    if (r && r.status === 200) st.me = r.body as Me;
    st.push = await sh.call<PushStatus>('push.status').catch(() => null);
    st.conn = await sh.call<{ on: boolean }>('connection.get').then((x) => x.on, () => null);
    st.alerts = await sh.call<{ on: boolean }>('alerts.state').then((x) => x.on, () => null);
    paint();
  }

  async function setPush(on: boolean): Promise<void> {
    st.busy = true; paint();
    try { st.push = await sh.call<PushStatus>('push.set', { on }); } catch (e) { toast((e as Error).message); }
    st.busy = false;
    await load();
  }

  async function setConn(on: boolean): Promise<void> {
    st.busy = true; paint();
    try { st.conn = (await sh.call<{ on: boolean }>('connection.set', { on })).on; } catch (e) { toast((e as Error).message); }
    st.busy = false; paint();
  }

  async function signOut(name: string): Promise<void> {
    const me = deviceWord(sh.hello.form);
    const i = await sheet(`Sign out of ${name}? ${t('device.this', { device: me })} forgets the computer, and the computer forgets this ${me}.`, [{ label: `Sign out of ${name}`, danger: true }, { label: 'Keep it' }]);
    if (i !== 0) return;
    try { await sh.call('pair.reset'); } catch (e) { toast((e as Error).message); }
  }

  function paint(): void {
    const name = st.me?.hub?.name || sh.hello.hub.name;
    // An iPhone has no UnifiedPush and no held connection: its alerts are iOS's own, on the live stream while the app is open and through APNs while it is closed (docs/PHONE.md section 9, PHONE-042).
    const ios = sh.hello.platform === 'ios';
    const up = hub.live.link === 'up';
    const me = deviceWord(sh.hello.form);
    const device = st.me?.device?.name || sh.hello.device?.name || `this ${me}`;
    const dist = st.push ? distributorName(st.push.current || st.push.distributors[0]) : null;
    const pushOn = !!st.push && !st.push.off && st.me?.device?.push === 'unifiedpush';
    const pushSub = !st.push ? 'Not available here'
      : !st.push.distributors.length ? 'No UnifiedPush app on this phone (ntfy, for one): alerts come while Ravenry is connected'
        : st.push.off ? `Off: ${dist} sends nothing. Alerts come while Ravenry is connected`
          : `Through ${dist} (UnifiedPush), encrypted for this phone`;
    // The demo (src/demo.ts): a sample Mac, nothing paired, no push to set; leaving it is the way out.
    const demo = !!sh.hello.demo;
    replace(el,
      h('header.sh.pgtop', h('button.icon-btn.fg', { 'aria-label': 'Back', on: { click: back } }, svg(I.BACK)), h('span.pgt', 'Settings')),
      h('div.scroll', h('div.setgs',
        demo ? h('div.setg', h('div.setr', h('div.tx', h('div', name), h('div.s', t('demo.settings.mac'))), h('span.r', t('demo.bar.lead').replace(/\.$/, '')))) : h('div.setg',
          h('div.setr', h('div.tx', h('div', name), h('div.s', `Paired as ${device}`)), h(`span.r${up ? '.ok' : ''}`, up ? 'Connected' : 'Not connected')),
          ...(ios ? [h('div.setr', h('div.tx', h('div', 'Alerts'), h('div.s', 'As iOS allows them, even with Ravenry closed')), h('span.r', st.alerts ? 'On' : 'Off'))] : [
            h('div.setr', h('div.tx', h('div', 'Alerts'), h('div.s', pushSub)), toggle(pushOn, !!st.push && st.push.distributors.length > 0, () => void setPush(!pushOn), 'Alerts by push')),
            h('div.setr', h('div.tx', h('div', 'Stay connected'), h('div.s', 'Shows alerts at once without push; a silent notification says so')), toggle(!!st.conn, st.conn !== null, () => void setConn(!st.conn), 'Stay connected'))])),
        h('div.setg',
          h('div.setr', h('div.tx', h('div', t('phone.runAsks', { bio: bioWord(sh.hello.platform) })), h('div.s', 'Always, from the alert and in the app')), h('span.r', 'Always'))),
        // The privacy page, in the browser (the shells send a link that leaves the app there).
        h('div.setg', h('a.setr.link', { href: t('privacy.url'), target: '_blank', rel: 'noopener', 'data-k': 'privacy' }, h('div.tx', h('div', t('privacy.title')), h('div.s', t('privacy.sub'))), h('span.r', '\u2197')),
          // The projects the app is built with and their licences, in the app (src/licences.ts).
          h('button.setr', { 'data-k': 'licences', on: { click: () => go('/licences') } }, h('div.tx', h('div', t('licences.phone')), h('div.s', t('licences.sub'))), h('span.r', '\u203a'))),
        demo ? h('div.setg', h('button.setr', { on: { click: () => void sh.call('demo.leave').catch(() => {}) } }, t('demo.settings.leave')))
          : h('div.setg', h('button.setr.red', { on: { click: () => void signOut(name) } }, `Sign out of ${name}`)),
        h('p.setn', demo ? t('demo.settings.note') : `${name} can sign this ${me} out too, from its phone button.`))));
  }

  paint();
  void load();
  return { el, update: paint, dispose: () => {} };
}
