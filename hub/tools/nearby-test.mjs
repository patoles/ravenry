#!/usr/bin/env node
// The Mac on the Wi-Fi by Bonjour (server/nearby.mjs, docs/PHONE.md,
// Finding the Mac on the Wi-Fi), with a stand-in for dns-sd that writes
// down what it was asked and stays up until it is stopped:
//
//   - the id is the one the phone apps compute (the same vector as
//     Android's PinTest and iOS's PinTests), and the record says only the
//     service, the port, v=1 and that id: no name;
//   - start advertises, stop ends it, a start again with the same key does
//     not start a second one; one that ends by itself is started again;
//   - a test's board (bound to 127.0.0.1) and RAVENRY_NEARBY=0 never advertise.
// Usage: node tools/nearby-test.mjs
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'nearby-test');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The stand-in: appends its pid and arguments to calls.log, then waits (or exits at once when told).
const LOG = path.join(T, 'calls.log');
const BIN = path.join(T, 'dns-sd');
fs.writeFileSync(BIN, `#!/bin/sh\necho "$$ $*" >> '${LOG}'\nif [ -f '${T}/die' ]; then rm -f '${T}/die'; exit 1; fi\nexec sleep 600\n`, { mode: 0o755 });
process.env.RAVENRY_NEARBY_BIN = BIN;
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) : []);
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };

const nearby = await import('../server/nearby.mjs');

const PIN = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
check('the id is the phone apps\' (the shared vector)', nearby.hubId(PIN) === 'Yw3NKWbEM2aRElRI', nearby.hubId(PIN));
const a = nearby.args(PIN, 4601);
check('the record: the service, the port, v=1 and the id', JSON.stringify(a) === JSON.stringify(['-R', 'Ravenry Yw3NKW', '_ravenry._tcp', 'local', '4601', 'v=1', 'id=Yw3NKWbEM2aRElRI']), a.join(' '));

check('a test board is never advertised', nearby.start({ pin: PIN, port: 4601, bind: '127.0.0.1' }) === false && !nearby.running());
check('RAVENRY_NEARBY=0 is never advertised', nearby.start({ pin: PIN, port: 4601, env: { RAVENRY_NEARBY: '0' } }) === false && !nearby.running());

nearby.start({ pin: PIN, port: 4601 });
await sleep(400);
let c = calls();
check('phone access on: advertised', nearby.running() && c.length === 1 && c[0].endsWith('-R Ravenry Yw3NKW _ravenry._tcp local 4601 v=1 id=Yw3NKWbEM2aRElRI'), c.join(' | '));
nearby.start({ pin: PIN, port: 4601 });
await sleep(300);
check('on again with the same key: still one', calls().length === 1);

// It ends by itself (mDNSResponder restarted): started again.
const first = calls()[0].split(' ')[0];
process.kill(Number(first), 'SIGTERM');
await sleep(2600);
c = calls();
check('one that ended by itself is started again', c.length === 2 && nearby.running() && alive(c[1].split(' ')[0]), c.join(' | '));

nearby.stop();
await sleep(300);
check('phone access off: no longer advertised', !nearby.running() && !alive(calls()[1].split(' ')[0]));
await sleep(2500);
check('and not started again after off', calls().length === 2);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
