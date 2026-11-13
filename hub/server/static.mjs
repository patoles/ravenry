// The board's own files (hub/public) as a reload needs them: compressed
// (brotli or gzip, whichever the client takes) and with an ETag from their
// content, under `Cache-Control: no-cache`. A reload then asks "still this
// one?" for every file and gets a 304 with no body while the file is the
// same; a file that changed (an update) has a new ETag, so the new code is
// sent at once and never runs stale. Each file is read and compressed once
// per version (its size and modification time), on its first request.
import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const ZIP = /^(text\/|image\/svg\+xml|application\/(json|javascript))/;
const files = new Map(); // abs -> { mtimeMs, size, etag, raw, gz, br, zip }

function load(abs, type) {
  const st = fs.statSync(abs);
  const c = files.get(abs);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c;
  const raw = fs.readFileSync(abs);
  const etag = `"${crypto.createHash('sha256').update(raw).digest('base64url').slice(0, 22)}"`;
  const f = { mtimeMs: st.mtimeMs, size: st.size, etag, raw, gz: null, br: null, zip: ZIP.test(type) && raw.length >= 1024 };
  files.set(abs, f);
  return f;
}

/** Whether an If-None-Match header names this ETag (weak or strong, or *). */
export function matches(header, etag) {
  if (!header) return false;
  const want = String(etag).replace(/^W\//, '');
  return String(header).split(',').some((t) => { const v = t.trim().replace(/^W\//, ''); return v === '*' || v === want; });
}

/**
 * Answers a GET (or HEAD) of one of the board's files: 304 when the client
 * has this version, else the file, compressed when it is text and the
 * client takes brotli or gzip. `type` is its Content-Type.
 */
export function send(req, res, abs, type) {
  const f = load(abs, type);
  const h = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: f.etag, Vary: 'Accept-Encoding', 'X-Content-Type-Options': 'nosniff' };
  if (matches(req.headers['if-none-match'], f.etag)) { res.writeHead(304, h); res.end(); return 304; }
  const ae = String(req.headers['accept-encoding'] || '');
  let body = f.raw;
  if (f.zip && /\bbr\b/.test(ae)) {
    if (!f.br) f.br = zlib.brotliCompressSync(f.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: f.raw.length } });
    body = f.br; h['Content-Encoding'] = 'br';
  } else if (f.zip && /\bgzip\b/.test(ae)) {
    if (!f.gz) f.gz = zlib.gzipSync(f.raw, { level: 9 });
    body = f.gz; h['Content-Encoding'] = 'gzip';
  }
  h['Content-Length'] = body.length;
  res.writeHead(200, h);
  res.end(req.method === 'HEAD' ? undefined : body);
  return 200;
}

/**
 * A picture on disk (a brief's, a plan's, a page's) the same way, without
 * reading it to hash it: an ETag from its size and modification time, a
 * 304 when the client has it, else the file streamed. Pictures go as they
 * are (PNG, JPEG and WebP are compressed already).
 */
export function sendPicture(req, res, abs, type) {
  let st;
  try { st = fs.statSync(abs); } catch { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"error":"not found"}'); return 404; }
  const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const h = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag };
  if (matches(req.headers['if-none-match'], etag)) { res.writeHead(304, h); res.end(); return 304; }
  h['Content-Length'] = st.size;
  res.writeHead(200, h);
  if (req.method === 'HEAD') { res.end(); return 200; }
  fs.createReadStream(abs).on('error', () => res.end()).pipe(res);
  return 200;
}

/**
 * A live stream (text/event-stream) gzipped as it goes, for a phone that
 * takes gzip: every write is flushed at once (Z_SYNC_FLUSH), so an event
 * arrives as soon as it is written, and the state's full snapshot (100 KB
 * and more) goes as a fraction of it over Tailscale. Call before the first
 * write, with `Content-Encoding: gzip` in the head; res.write and res.end
 * then go through it.
 */
export function gzipStream(res, level = 4) {
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  const z = zlib.createGzip({ level });
  z.on('data', (d) => write(d));
  z.on('error', () => { /* the client went */ });
  res.write = (chunk) => { if (!z.destroyed) { z.write(chunk); z.flush(zlib.constants.Z_SYNC_FLUSH); } return true; };
  res.end = (chunk) => { if (chunk) z.write(chunk); z.end(); z.once('end', () => end()); return res; };
  res.on('close', () => z.destroy());
  return res;
}
