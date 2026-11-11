// The phone card's app code (src/renderer/phonepair.ts): no code when the
// pairing has nowhere to reach this computer (PHONE-011).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairable } from '../src/renderer/phonepair.ts';

test('a pairing with addresses is shown while phone access is on', () => {
  const app = { hosts: ['192.168.1.20', '100.101.102.103'], svg: '<svg/>' };
  assert.equal(pairable(true, app), app);
  assert.equal(pairable(false, app), null);
});

test('a pairing with no Wi-Fi or Tailscale address is not shown', () => {
  assert.equal(pairable(true, { hosts: [], svg: '<svg/>' }), null);
  assert.equal(pairable(true, null), null);
});
