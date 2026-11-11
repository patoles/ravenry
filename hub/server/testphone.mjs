// A test's stand-in for the Wi-Fi: MC_TEST_PHONE_PORT=<port> opens one more
// listener, on 127.0.0.1:<port> only, where every caller is seen as a phone
// on the home Wi-Fi (PHONE_ADDRESS), not as this Mac. Its requests go through
// the board's own request and upgrade handlers unchanged, so the checks a
// phone meets are the real ones: the Host check, phone.isLoopback (whoami's
// local, the Mac-only routes), phone access off or on, the key's sign-in and
// its cookie, and person.fromPerson (a phone acts as the person, a program
// on this Mac does not). A browser reaches it as its proxy: the phone's own
// address in the bar (http://<Wi-Fi address>:<board port>/), the request
// line in absolute form, made the path a phone sends here.
//
// No test board opens anything on the Wi-Fi for this (home.mjs hubBind keeps
// them on 127.0.0.1). The switch is a test's only:
//   - this board refuses it (exit 2, before it listens) unless its data is a
//     test's (home.mjs testData: a test process, the repo's .tmp, a temp
//     folder), so the person's board never takes it, whoever starts it;
//   - a release of the Mac app run as Node (the hub service) quits on it
//     before the hub starts (apps/macos Gate.swift), and the app drops MC_*
//     from its own environment, as the Electron app's gate does
//     (apps/desktop/src/main/gate.ts); apps/macos/scripts/gatecheck.mjs
//     checks both on the packaged release and its twin.
import http from 'node:http';

export const SWITCH = 'MC_TEST_PHONE_PORT';
// TEST-NET-1 (RFC 5737): documentation only, so never one of this Mac's
// addresses (person.fromThisMachine) and never a real device's.
export const PHONE_ADDRESS = '192.0.2.10';

// The port asked for, or null when the switch is not set. Exits 2 when it
// is set on a board whose data is not a test's, or is not a port.
export function portFrom(env, testData) {
  const v = env[SWITCH];
  if (v === undefined || v === '') return null;
  if (!testData) {
    console.error(`Refused: ${SWITCH} is a test switch (callers on this Mac would pass as a phone), and this board's data is not a test's. Quitting.`);
    process.exit(2);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`Refused: ${SWITCH}=${JSON.stringify(v)} is not a port. Quitting.`);
    process.exit(2);
  }
  return n;
}

// A proxy's request line (`GET http://host:port/path HTTP/1.1`) as the path
// a phone sends to the board itself; the Host header stays the browser's.
function asPath(req) {
  if (!/^[a-z]+:\/\//i.test(req.url || '')) return;
  try { const u = new URL(req.url); req.url = u.pathname + u.search; } catch { /* left as sent */ }
}

export function listen(port, onRequest, onUpgrade) {
  const server = http.createServer((req, res) => { asPath(req); onRequest(req, res); });
  server.on('upgrade', (req, sock, head) => { asPath(req); onUpgrade(req, sock, head); });
  // Before any handler reads it: the caller's address is the phone's.
  server.on('connection', (sock) => {
    Object.defineProperty(sock, 'remoteAddress', { value: PHONE_ADDRESS, configurable: true });
    Object.defineProperty(sock, 'remoteFamily', { value: 'IPv4', configurable: true });
  });
  server.on('error', (e) => { console.error(`${SWITCH}: could not listen on 127.0.0.1:${port}: ${e.message}`); process.exit(1); });
  server.listen(port, '127.0.0.1', () => console.log(`test: callers on 127.0.0.1:${port} are seen as a phone at ${PHONE_ADDRESS} (${SWITCH})`));
  return server;
}
