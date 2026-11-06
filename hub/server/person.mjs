// Who acts as the person (packages/protocol/PROTOCOL.md section 4, Who acts
// as the person). A checkpoint exists so that a person answers it, so:
//
// - The HTTP API refuses an answer from a program on this machine that
//   runs inside a ravenryd pane (an agent, or anything it started) or in
//   an ssh session. A request from the phone (another address, with its
//   device token: server/phone.mjs) is the person. A request from this
//   machine, on localhost or on one of its own addresses (a phone token
//   used from here proves nothing), is judged by `ravenryd peer --tcp
//   <its port> --to <ours>`: the daemon's own code finds the process that
//   holds the connection and reads where it comes from, so the hub and
//   the daemon judge alike.
//   The board page in a browser and the desktop app pass: their processes
//   run outside every pane.
// - The hub's answer key goes in hello on every daemon connection. Over
//   ssh (`ssh host ravenryd proxy`) a daemon cannot see this machine, so
//   it lets a connection act as the person only with the key it trusts:
//   the first one it was given. The key lives in <RAVENRY_HOME>/answer-key
//   (mode 0600) and is made on first use.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { RAVENRY_HOME, assertDataWrite } from './home.mjs';

export const KEY_FILE = path.join(RAVENRY_HOME, 'answer-key');

let key = null;

// The hub's answer key, made on first use.
export function answerKey() {
  if (key) return key;
  try {
    const k = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{43,}$/.test(k)) { key = k; return key; }
  } catch { /* none yet */ }
  const k = crypto.randomBytes(32).toString('base64url');
  try {
    assertDataWrite(KEY_FILE);
    fs.mkdirSync(RAVENRY_HOME, { recursive: true });
    const tmp = KEY_FILE + '.tmp';
    fs.writeFileSync(tmp, k + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, KEY_FILE);
  } catch (e) { console.error('answer key:', e.message); }
  key = k;
  return key;
}

export const REFUSED = 'Only a person can answer a checkpoint, in the Ravenry app or on the phone.';

// Whether the request came from the person. `bin` is ravenryd (null when
// none is installed: nothing can be judged, so it is refused). Resolves
// to { ok, why }.
export function fromPerson(req, bin) {
  const s = req.socket;
  if (req.mcPhone && !fromThisMachine(s && s.remoteAddress)) return Promise.resolve({ ok: true });
  if (!bin) return Promise.resolve({ ok: false, why: 'ravenryd is not installed, so the board cannot tell who sent it' });
  if (!s || !s.remotePort || !s.localPort) return Promise.resolve({ ok: false, why: 'the board cannot tell who sent it' });
  return new Promise((resolve) => {
    execFile(bin, ['peer', '--tcp', String(s.remotePort), '--to', String(s.localPort), '--json'], { timeout: 10000, maxBuffer: 1 << 20 }, (err, stdout) => {
      let r = null;
      try { r = JSON.parse(stdout); } catch { /* below */ }
      if (err || !r) return resolve({ ok: false, why: `the board cannot tell who sent it (ravenryd peer: ${err ? err.message.split('\n')[0] : 'no answer'})` });
      resolve(r.person ? { ok: true } : { ok: false, why: r.why || 'it did not come from a person' });
    });
  });
}

// Whether an address is one of this machine's own.
export function fromThisMachine(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '');
  if (!a || a === '127.0.0.1' || a === '::1' || a.startsWith('127.')) return true;
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.address === a) return true;
  return false;
}
