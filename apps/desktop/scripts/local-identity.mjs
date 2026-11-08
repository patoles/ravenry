// The maintainer's Apple Development identity, for builds made on the
// maintainer's Mac (scripts/pack.mjs signs with it, tools/release-check.mjs
// checks the result). macOS keys what it allowed an app (Documents, the
// microphone, ...) to its designated requirement: ad hoc, that is the
// build's own hash, new at every build, so it asked again each time; signed
// with this identity, it names the certificate, the same for every build.
//
// The keychain is only read (security find-identity), never changed. In CI,
// or on a Mac without it, there is none and builds are signed ad hoc.
// RAVENRY_LOCAL_IDENTITY=- forces ad hoc; =<SHA-1> names another identity.
import { execFileSync } from 'node:child_process';

// Its SHA-1, as security find-identity prints it (Apple Development, team 94C83QNSZ3).
export const LOCAL_IDENTITY = '246D315135A12E61820FB9BDD7793F6FA76726CE';
export const LOCAL_TEAM = '94C83QNSZ3';

/** { hash, name, team } when this Mac's keychain has the identity, valid for code signing; else null. */
export function localIdentity(env = process.env) {
  const named = env.RAVENRY_LOCAL_IDENTITY;
  const want = (named ?? LOCAL_IDENTITY).trim().toUpperCase();
  if (process.platform !== 'darwin' || !want || want === '-' || env.GITHUB_ACTIONS || env.CI) return null;
  let out = '';
  try { out = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }); } catch { return null; }
  const line = out.split('\n').find((l) => l.toUpperCase().includes(want));
  if (!line) return null;
  const name = (/"([^"]+)"/.exec(line) || [])[1] || want;
  return { hash: want, name, team: named ? null : LOCAL_TEAM };
}
