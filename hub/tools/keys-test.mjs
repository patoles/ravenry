// The one formatter of typed keys (public/keys.mjs).
import './test-guard.mjs'; // first, as every test: keeps it off the real ~/.ravenry
import assert from 'node:assert/strict';
import { keyLabel, keyLine, keyParts } from '../public/keys.mjs';

assert.deepEqual(keyParts('<Ctrl+C>npm run dev -- --host<Enter>'), [
  { kind: 'key', text: 'Ctrl C' }, { kind: 'text', text: 'npm run dev -- --host' }, { kind: 'key', text: 'Enter' },
]);
assert.deepEqual(keyParts(''), []);
assert.deepEqual(keyParts('a < b'), [{ kind: 'text', text: 'a < b' }]);
assert.equal(keyLabel('<Shift+Tab>'), 'Shift Tab');
assert.equal(keyLine('<Ctrl+C>npm run dev -- --host<Enter>'), '[Ctrl C] npm run dev -- --host [Enter]');
assert.ok(!/</.test(keyLine('<Up><Up><Enter>')));
console.log('keys: all passed');
