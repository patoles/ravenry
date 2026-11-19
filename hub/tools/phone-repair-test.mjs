#!/usr/bin/env node
// The same device pairing again (server/phone.mjs pair and signIn,
// docs/PHONE.md section 3, "The same device again"), in process on a
// scratch RAVENRY_HOME under .tmp/phone-repair-test:
//
//   - an app that pairs again with its install id keeps one row (the same
//     id, the name the Mac gave it), and its old token stops working;
//   - an app from before install ids pairs again with the token it holds
//     (`previous`): that row is taken over the same way;
//   - two iPads of the same name, each with its own install id, stay two
//     rows, each signed in;
//   - a phone browser scanning the code again (its sign-in cookie dropped,
//     as a camera's cross-site link drops it; its mc_install cookie sent)
//     keeps one row, and its old cookie stops working; another browser is
//     a row of its own;
//   - the card's words: "iPad app" for the iOS app on an iPad, "iPhone
//     app" on an iPhone, an iPad named so from before the form too.
// Usage: node tools/phone-repair-test.mjs
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'phone-repair-test');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
process.env.RAVENRY_HOME = T;
process.env.MC_PHONE_LAN = 'none'; // the card with no Wi-Fi address: no QR of the real network

const phone = await import('../server/phone.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const bearer = (tok) => ({ headers: { authorization: `Bearer ${tok}` } });
const signedIn = (tok) => phone.check(bearer(tok)).ok;
const rows = () => phone.devices();
const pairNow = (body) => { phone._resetPairing(); const c = phone.pairingCode(); return phone.pair({ code: c.code, ...body }); };
const INSTALL_A = 'install-of-a-testers-phone-01';
const INSTALL_B = 'install-of-an-older-phone-02';

phone.setAccess(true);

// ------------------------------------------------------------ an app, by its install id
{
  const first = pairNow({ name: 'A tester\'s phone', platform: 'android', app: '0.1.0', install: INSTALL_A });
  phone.rename(first.device.id, 'Kitchen phone');
  const again = pairNow({ name: 'A tester\'s phone', platform: 'android', app: '0.1.1', install: INSTALL_A });
  const mine = rows().filter((d) => d.platform === 'android');
  check('the same app pairing again keeps one row', first.ok && again.ok && mine.length === 1, JSON.stringify(mine.map((d) => d.id)));
  check('the row keeps its id and the name the Mac gave it, with the new version', again.device.id === first.device.id && mine[0] && mine[0].name === 'Kitchen phone' && mine[0].app === '0.1.1', JSON.stringify(mine[0]));
  check('the old token stops working, the new one works', !signedIn(first.token) && signedIn(again.token));
}

// ------------------------------------------------------------ an app from before install ids, by the token it holds
{
  const before = pairNow({ name: 'Old phone', platform: 'android', app: '0.0.9' });
  const n = rows().length;
  const again = pairNow({ name: 'Old phone', platform: 'android', app: '0.1.1', install: INSTALL_B, previous: before.token });
  check('an app pairing again with the token it holds takes over that row', again.ok && again.device.id === before.device.id && rows().length === n, `${n} -> ${rows().length}`);
  check('and that old token stops working', !signedIn(before.token) && signedIn(again.token));
  const third = pairNow({ name: 'Old phone', platform: 'android', app: '0.1.2', install: INSTALL_B });
  check('after that its install id finds the row', third.device.id === before.device.id && rows().length === n && !signedIn(again.token) && signedIn(third.token));
}

// ------------------------------------------------------------ two devices of the same name
{
  const one = pairNow({ name: 'iPad', platform: 'ios', form: 'ipad', app: '0.1.69', install: 'install-of-the-first-ipad-0001' });
  const two = pairNow({ name: 'iPad', platform: 'ios', form: 'ipad', app: '0.1.69', install: 'install-of-the-second-ipad-002' });
  const ipads = rows().filter((d) => d.platform === 'ios');
  check('two iPads of the same name stay two rows, both signed in', ipads.length === 2 && one.device.id !== two.device.id && signedIn(one.token) && signedIn(two.token), JSON.stringify(ipads.map((d) => d.id)));
  const noId = pairNow({ name: 'iPad', platform: 'ios', app: '0.1.60' });
  check('an app with no install id and no token is a new row, never a same-named one', noId.ok && rows().filter((d) => d.platform === 'ios').length === 3 && signedIn(one.token) && signedIn(two.token));
  const other = pairNow({ name: 'A tester\'s phone', platform: 'android', install: 'install-of-the-first-ipad-0001' });
  check('another platform\'s app never takes an iPad\'s row, whatever it sends', other.device.id !== one.device.id && signedIn(one.token));
}

// ------------------------------------------------------------ a phone browser, by its cookie
{
  const key = JSON.parse(fs.readFileSync(phone.PHONE_FILE, 'utf8')).key;
  const UA = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
  const visit = (cookie = '') => {
    let head = null;
    const res = { writeHead: (status, h) => { head = { status, ...h }; }, end: () => {} };
    phone.signIn({ headers: { 'user-agent': UA, cookie } }, res, key);
    const set = [].concat(head['Set-Cookie'] || []);
    const val = (name) => { const c = set.find((x) => x.startsWith(`${name}=`)); return c ? c.slice(name.length + 1).split(';')[0] : null; };
    return { status: head.status, token: val(phone.COOKIE), install: val(phone.INSTALL_COOKIE), set };
  };
  const browsers = () => rows().filter((d) => d.platform === 'browser');
  const first = visit();
  check('a browser\'s sign-in sets its install cookie, Lax so a camera\'s link carries it', !!first.token && !!first.install && first.set.some((c) => c.startsWith(`${phone.INSTALL_COOKIE}=`) && /SameSite=Lax/.test(c) && /HttpOnly/.test(c)), first.set.join(' | '));
  const n = browsers().length;
  // The camera's link: a cross-site navigation, so the Strict sign-in cookie is not sent; the Lax one is.
  const again = visit(`${phone.INSTALL_COOKIE}=${first.install}`);
  check('the same browser scanning the code again keeps one row', !!again.token && browsers().length === n, `${n} -> ${browsers().length}`);
  check('its old sign-in stops working, the new one works', !phone.check({ headers: { cookie: `${phone.COOKIE}=${first.token}` } }).ok && phone.check({ headers: { cookie: `${phone.COOKIE}=${again.token}` } }).ok);
  const other = visit();
  check('another browser (no cookies of its own) is a row of its own', !!other.token && browsers().length === n + 1 && phone.check({ headers: { cookie: `${phone.COOKIE}=${again.token}` } }).ok);
}

// ------------------------------------------------------------ the card's words
{
  const line = (d) => phone.deviceLine({ lastSeen: new Date().toISOString(), ...d }).sub.split(',')[0];
  check('the iOS app on an iPad says iPad app, on an iPhone iPhone app', line({ platform: 'ios', form: 'ipad', name: 'iPad' }) === 'iPad app' && line({ platform: 'ios', form: 'iphone', name: 'iPhone' }) === 'iPhone app');
  check('a record from before the form: an iPad by its name, else iPhone', line({ platform: 'ios', name: 'iPad' }) === 'iPad app' && line({ platform: 'ios', name: 'Living room' }) === 'iPhone app' && line({ platform: 'android', name: 'iPad' }) === 'Android app');
  const card = phone.card(4600);
  const ipadRow = card.devices.find((d) => d.platform === 'ios' && d.form === 'ipad');
  check('the Mac\'s card says iPad app on an iPad\'s row', !!ipadRow && /^iPad app, seen now$/.test(ipadRow.line.sub), JSON.stringify(ipadRow && ipadRow.line));
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
