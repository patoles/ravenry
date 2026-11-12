// The board's own port (docs/PHONE.md section 2). The person's board listens
// on this Mac (127.0.0.1 and ::1) always, and on the network (every other
// address: the Wi-Fi, Tailscale) only while phone access is on: sync(on)
// opens or closes that listener at once, when the switch moves, without a
// restart. The Mac's own connections (the apps, the hooks, `ravenry`) come
// on loopback, which the system gives to the loopback listeners over the
// network's (the more specific address wins), so they never drop when it
// closes; a connection the network's listener took is closed with it.
//
// A fixed address (a test's board: 127.0.0.1; RAVENRY_HUB_BIND) is that one
// listener only, never switched (home.mjs hubBind).
//
// A listener on 127.0.0.1 alone does not collide with an older board
// listening on every address (macOS lets the more specific bind beside it),
// so before it listens the port is tried on loopback: an answer there means
// it is taken, said as EADDRINUSE as before.
import net from 'node:net';

const tryConnect = (host, port, ms = 400) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const done = (v) => { clearTimeout(t); s.destroy(); resolve(v); };
  const t = setTimeout(() => done(false), ms);
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});

// make(): a new http.Server with the board's handlers. onTaken(err): the
// port is someone else's (index.mjs says who and exits).
export function boardListeners({ port, bind, make, onTaken, log = console.log }) {
  const fixed = typeof bind === 'string' && bind ? bind : null;
  const loop = [];
  let network = null;
  let want = false;
  const netSockets = new Set();

  function openNetwork() {
    const s = make();
    network = s;
    s.on('connection', (sock) => { netSockets.add(sock); sock.on('close', () => netSockets.delete(sock)); });
    let host = '::';
    s.on('error', (e) => {
      if (!s.listening && host === '::' && (e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL')) { host = '0.0.0.0'; s.listen({ port, host }); return; }
      log(`board: the network's port :${port} ${s.listening ? 'failed' : 'did not open'} (${e.code || e.message}); phones cannot reach the board`);
      if (!s.listening && network === s) network = null;
    });
    s.on('listening', () => { if (network === s) log(`phone access on: the board listens on every address too, :${port}`); else s.close(); });
    s.listen({ port, host });
  }

  function closeNetwork() {
    const s = network;
    network = null;
    if (!s) return;
    s.close();
    for (const sock of netSockets) sock.destroy();
    netSockets.clear();
    log(`phone access off: the board listens on this Mac only, :${port}`);
  }

  return {
    fixed,
    // Listens on loopback (or the fixed address); cb once the board answers there.
    async start(cb) {
      if (fixed) {
        const s = make();
        loop.push(s);
        s.on('error', onTaken);
        s.listen(port, fixed, cb);
        return;
      }
      if (await tryConnect('127.0.0.1', port) || await tryConnect('::1', port)) {
        const e = new Error(`listen EADDRINUSE: address already in use :${port}`);
        e.code = 'EADDRINUSE';
        onTaken(e);
        return;
      }
      const v4 = make();
      loop.push(v4);
      v4.on('error', onTaken);
      v4.listen(port, '127.0.0.1', () => {
        const v6 = make();
        v6.on('error', (e) => log(`board: ::1 :${port} ${v6.listening ? 'failed' : 'did not open'} (${e.code || e.message}); this Mac reaches the board on 127.0.0.1`));
        v6.listen(port, '::1', () => loop.push(v6));
        cb();
      });
    },
    // Phone access on: the network's listener too; off: this Mac only.
    sync(on) {
      want = !!on;
      if (fixed) return;
      if (want && !network) openNetwork();
      else if (!want && network) closeNetwork();
    },
    // Where it listens now, for the logs and the checks.
    addresses() {
      return [...loop, ...(network ? [network] : [])].map((s) => s.address()).filter(Boolean).map((a) => `${a.family === 'IPv6' ? `[${a.address}]` : a.address}:${a.port}`);
    },
  };
}
