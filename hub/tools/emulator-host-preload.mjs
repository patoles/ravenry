// Test only, never loaded by the product: tools/push-ntfy-e2e.mjs starts its
// hub with `node --import=<this file> server/index.mjs`.
//
// The Android emulator reaches this computer at 10.0.2.2, so the ntfy app
// on it writes 10.0.2.2 into the UnifiedPush endpoint it hands the Ravenry
// app, and the Ravenry app hands that endpoint to the hub. This computer
// has no 10.0.2.2. Here every fetch() to 10.0.2.2 goes to 127.0.0.1 instead,
// where the test's ntfy server listens; nothing else changes. server/push.mjs
// still checks and posts the endpoint exactly as the phone gave it.

const EMULATOR_HOST = '10.0.2.2';
const realFetch = globalThis.fetch;

function mapped(u) {
  let x;
  try { x = new URL(String(u)); } catch { return null; }
  if (x.hostname !== EMULATOR_HOST) return null;
  x.hostname = '127.0.0.1';
  return x;
}

globalThis.fetch = function fetchThroughEmulatorHost(input, init) {
  if (input instanceof Request) {
    const to = mapped(input.url);
    return realFetch(to ? new Request(to, input) : input, init);
  }
  const to = mapped(input instanceof URL ? input.href : input);
  return realFetch(to || input, init);
};
