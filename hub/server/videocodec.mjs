// A pick's video: its codec, read from the file's own headers (the webm
// round, 2026-11-17), as ravenryd reads it (cmd/ravenryd/videocodec.go).
// The board's view gives each video variant a `videoType`, the type a
// player is asked about (`canPlayType`): a client whose engine cannot
// decode it shows a still that says so at once, never a player that waits
// for ever (AV1 on a Mac or an iPhone with no AV1 decoder).

// { codec: 'h264' | 'hevc' | 'vp8' | 'vp9' | 'av1' | another entry's name | '', container: 'webm' | 'mp4' | '' }
export function videoCodec(b) {
  if (!b || b.length < 8) return { codec: '', container: '' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { codec: ebmlCodec(b), container: 'webm' };
  if (['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(b.toString('latin1', 4, 8))) return { codec: isoCodec(b), container: 'mp4' };
  return { codec: '', container: '' };
}

// The first video CodecID element (0x86) of a Matroska file.
function ebmlCodec(b) {
  const end = Math.min(b.length, 4 << 20);
  for (let i = 0; i + 2 < end; i++) {
    if (b[i] !== 0x86 || !(b[i + 1] & 0x80)) continue;
    const n = b[i + 1] & 0x7f;
    if (n < 3 || i + 2 + n > end || b[i + 2] !== 0x56 || b[i + 3] !== 0x5f) continue;
    const id = b.toString('latin1', i + 2, i + 2 + n);
    if (id === 'V_VP8') return 'vp8';
    if (id === 'V_VP9') return 'vp9';
    if (id === 'V_AV1') return 'av1';
    if (id.startsWith('V_MPEG4/ISO/AVC')) return 'h264';
    if (id.startsWith('V_MPEGH/ISO/HEVC')) return 'hevc';
    return id.slice(2).toLowerCase();
  }
  return '';
}

function* boxes(b, from = 0, to = b.length) {
  let at = from;
  while (to - at >= 8) {
    let size = b.readUInt32BE(at), head = 8;
    const type = b.toString('latin1', at + 4, at + 8);
    if (size === 0) size = to - at;
    else if (size === 1) { if (to - at < 16) return; size = Number(b.readBigUInt64BE(at + 8)); head = 16; }
    if (size < head || at + size > to) return;
    yield { type, start: at + head, end: at + size };
    at += size;
  }
}
const child = (b, x, want) => { if (!x) return null; for (const c of boxes(b, x.start, x.end)) if (c.type === want) return c; return null; };
const ENTRY = { avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', dvh1: 'hevc', dvhe: 'hevc', av01: 'av1', vp09: 'vp9', vp08: 'vp8' };

// The sample entry of the first track whose handler is video.
function isoCodec(b) {
  for (const moov of boxes(b)) {
    if (moov.type !== 'moov') continue;
    for (const trak of boxes(b, moov.start, moov.end)) {
      if (trak.type !== 'trak') continue;
      const mdia = child(b, trak, 'mdia');
      const hdlr = child(b, mdia, 'hdlr');
      if (!hdlr || hdlr.end - hdlr.start < 12 || b.toString('latin1', hdlr.start + 8, hdlr.start + 12) !== 'vide') continue;
      const stsd = child(b, child(b, child(b, mdia, 'minf'), 'stbl'), 'stsd');
      if (!stsd || stsd.end - stsd.start < 16) continue;
      const e = b.toString('latin1', stsd.start + 12, stsd.start + 16);
      return ENTRY[e] || e.trim();
    }
    return '';
  }
  return '';
}

// The type a player is asked about for a codec in its container, or null when there is none to ask.
const CODECS = { webm: { vp8: 'vp8', vp9: 'vp9', av1: 'av01.0.05M.08', h264: 'avc1.42E01E', hevc: 'hvc1.1.6.L93.B0' }, mp4: { h264: 'avc1.42E01E', hevc: 'hvc1.1.6.L93.B0', av1: 'av01.0.05M.08', vp9: 'vp09.00.10.08', vp8: 'vp8' } };
export function videoType(codec, container) {
  const c = CODECS[container] && CODECS[container][codec];
  return c ? `video/${container}; codecs="${c}"` : null;
}
