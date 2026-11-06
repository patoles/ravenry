// Binary frames (PROTOCOL.md section 5): a 14-byte header, then terminal
// bytes. Byte 0 the frame version, byte 1 the kind, bytes 2 to 5 the
// channel and 6 to 13 the mark, both unsigned big-endian.

export const FRAME_VERSION = 1;
export const HEADER_BYTES = 14;

export const KIND_OUTPUT = 1;
export const KIND_SNAPSHOT = 2;
export const KIND_INPUT = 3;

export interface Frame {
  version: number;
  kind: number;
  channel: number;
  mark: number;
  payload: Uint8Array;
}

/** Reads a frame, or returns null when it is too short to be one. The payload is a view, not a copy. */
export function decodeFrame(buf: Uint8Array): Frame | null {
  if (buf.byteLength < HEADER_BYTES) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const hi = dv.getUint32(6);
  const lo = dv.getUint32(10);
  return {
    version: dv.getUint8(0),
    kind: dv.getUint8(1),
    channel: dv.getUint32(2),
    // Marks stay below 2^53 in practice (8 PiB of output).
    mark: hi * 0x100000000 + lo,
    payload: buf.subarray(HEADER_BYTES),
  };
}

export function encodeFrame(kind: number, channel: number, mark: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + payload.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, FRAME_VERSION);
  dv.setUint8(1, kind);
  dv.setUint32(2, channel);
  dv.setUint32(6, Math.floor(mark / 0x100000000));
  dv.setUint32(10, mark >>> 0);
  out.set(payload, HEADER_BYTES);
  return out;
}

/** An input frame: bytes for the pane, as they are (the mark is ignored). */
export function inputFrame(channel: number, payload: Uint8Array): Uint8Array {
  return encodeFrame(KIND_INPUT, channel, 0, payload);
}
