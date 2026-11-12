// A phone on the Mac's Wi-Fi, for the tests, over loopback only: a test board
// started with phoneEnv(port) also listens on 127.0.0.1:<port>, where every
// caller is seen as a phone (server/testphone.mjs), and the board's real
// checks decide what it gets. Nothing listens on the Wi-Fi's address.
//
// A phone addresses the board as http://<the Mac's Wi-Fi address>:<board
// port>/, so that is the Host it sends: phoneRequest() and phoneFetch() send
// it to the stand-in port, and a Playwright context with phoneProxy(port)
// sends a browser's requests there too.
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';

// The Mac's Wi-Fi address, picked the way the board picks it
// (server/phone.mjs lanAddresses), or null. Only named in the Host header.
export function lanAddress() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
    if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push({ name, address: a.address });
  }
  out.sort((a, b) => (b.name === 'en0') - (a.name === 'en0'));
  return (out[0] && out[0].address) || null;
}

// A port the system gives on 127.0.0.1.
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// What a test board's environment takes to have the stand-in on `port`.
export const phoneEnv = (port) => ({ MC_TEST_PHONE_PORT: String(port) });

// A Playwright context's proxy: the browser's requests to the Wi-Fi address
// reach the stand-in (loopback addresses bypass it and stay the Mac's).
export const phoneProxy = (port) => ({ server: `http://127.0.0.1:${port}` });

// A raw request as a phone: to the stand-in port, with `url`'s host as Host
// (any Host when `host` is given). Resolves { status, headers, body }, or
// with `stream` { status, headers, res, req } once the headers are in.
export function phoneRequest(port, url, { method = 'GET', host, headers = {}, body = null, stream = false } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: u.pathname + u.search, headers: { Host: host || u.host, ...headers } }, (res) => {
      if (stream) return resolve({ status: res.statusCode, headers: res.headers, res, req: r });
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

// fetch() as a phone: a Response, never following a redirect.
export async function phoneFetch(port, url, init = {}) {
  const r = await phoneRequest(port, url, { method: init.method || 'GET', headers: init.headers || {}, body: init.body ?? null });
  const h = new Headers();
  for (const [k, v] of Object.entries(r.headers)) for (const x of [].concat(v)) h.append(k, x);
  return new Response(r.status === 204 || r.status === 304 ? null : r.body, { status: r.status, headers: h });
}
