// The first import of a test that has no guard of its own (packages/*/test,
// run with node --test): the twin of hub/tools/test-guard.mjs, without the
// board's data folder. From here on the test, and every child it starts,
// is held to tools/test-env.mjs (guardSpawns): no folder of the real user's,
// no assistant of theirs, and nothing of their own running daemon or board.
// On 2026-11-21 packages/client's node test, run from a shell in a Ravenry
// pane, opened a pane in the person's daemon through the RAVENRY_SOCKET it
// inherited.
//
//   import '../../../tools/test-guard.mjs';   (first, before anything else)
import { guardSpawns } from './test-env.mjs';

guardSpawns();
