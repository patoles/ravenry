#!/usr/bin/env node
// The App Store provisioning profile scripts/archive.sh exports with:
// "Ravenry App Store" for dev.ravenry.ios, made from the team's newest
// Apple Distribution certificate, fetched (or made, the first time and
// once a year when it expires) through the App Store Connect API and
// installed where Xcode looks for profiles. Prints the profile's name.
//
//   ASC_KEY_ID=... ASC_ISSUER_ID=... node scripts/profile.mjs
//
// ASC_KEY_PATH: the .p8 (default ~/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAME = 'Ravenry App Store';
const BUNDLE = 'dev.ravenry.ios';
const kid = process.env.ASC_KEY_ID;
const iss = process.env.ASC_ISSUER_ID;
if (!kid || !iss) { console.error('profile.mjs: set ASC_KEY_ID and ASC_ISSUER_ID'); process.exit(1); }
const keyPath = process.env.ASC_KEY_PATH || path.join(os.homedir(), '.appstoreconnect', 'private_keys', `AuthKey_${kid}.p8`);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const head = b64({ alg: 'ES256', kid, typ: 'JWT' }) + '.' + b64({ iss, iat: now, exp: now + 1100, aud: 'appstoreconnect-v1' });
const sig = crypto.sign('sha256', Buffer.from(head), { key: fs.readFileSync(keyPath), dsaEncoding: 'ieee-p1363' }).toString('base64url');
const jwt = `${head}.${sig}`;

async function api(p, opt = {}) {
  const r = await fetch('https://api.appstoreconnect.apple.com' + p, {
    ...opt, headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' },
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${opt.method || 'GET'} ${p}: ${r.status} ${JSON.stringify(body?.errors?.map((e) => e.detail) ?? body)}`);
  return body;
}

const enc = encodeURIComponent;
const profiles = await api(`/v1/profiles?filter[name]=${enc(NAME)}&filter[profileType]=IOS_APP_STORE&limit=20`);
let profile = profiles.data.find((p) => p.attributes.profileState === 'ACTIVE' && new Date(p.attributes.expirationDate) > new Date(Date.now() + 7 * 864e5));
if (!profile) {
  for (const old of profiles.data) await api(`/v1/profiles/${old.id}`, { method: 'DELETE' });
  const certs = await api('/v1/certificates?filter[certificateType]=DISTRIBUTION&limit=50');
  const cert = certs.data.sort((a, b) => b.attributes.expirationDate.localeCompare(a.attributes.expirationDate))[0];
  if (!cert) throw new Error('No Apple Distribution certificate on the team (docs/store/apple/UPLOAD.md)');
  const bundles = await api(`/v1/bundleIds?filter[identifier]=${enc(BUNDLE)}`);
  const bundle = bundles.data.find((b) => b.attributes.identifier === BUNDLE);
  if (!bundle) throw new Error(`No bundle ID ${BUNDLE} on the team`);
  profile = (await api('/v1/profiles', {
    method: 'POST',
    body: JSON.stringify({ data: { type: 'profiles', attributes: { name: NAME, profileType: 'IOS_APP_STORE' }, relationships: {
      bundleId: { data: { type: 'bundleIds', id: bundle.id } },
      certificates: { data: [{ type: 'certificates', id: cert.id }] },
    } } }),
  })).data;
}
const dir = path.join(os.homedir(), 'Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${profile.attributes.uuid}.mobileprovision`), Buffer.from(profile.attributes.profileContent, 'base64'));
console.log(NAME);
