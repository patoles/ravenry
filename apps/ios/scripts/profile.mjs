#!/usr/bin/env node
// The App Store provisioning profiles scripts/archive.sh exports with,
// made from the team's newest Apple Distribution certificate, fetched (or
// made, the first time, once a year when one expires, and when one lacks
// a capability its app now has) through the App Store Connect API and
// installed where Xcode looks for profiles:
// - "Ravenry App Store" for dev.ravenry.ios, the app, with Push
//   Notifications (alerts through APNs, docs/PHONE.md section 4, "apns");
// - "Ravenry Notify App Store" for dev.ravenry.ios.notify, its
//   Notification Service Extension (the bundle ID is registered the first
//   time).
// Prints a JSON object, bundle ID to profile name (ExportOptions.plist).
//
//   ASC_KEY_ID=... ASC_ISSUER_ID=... node scripts/profile.mjs [--check]
//
// --check only reads: what is there and what a run would make or change.
//
// ASC_KEY_PATH: the .p8 (default ~/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROFILES = [
  { bundle: 'dev.ravenry.ios', name: 'Ravenry App Store', push: true },
  { bundle: 'dev.ravenry.ios.notify', name: 'Ravenry Notify App Store', register: 'Ravenry Notify', push: false },
];
const CHECK = process.argv.includes('--check');
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
const say = (s) => console.error(`profile.mjs: ${s}`);
let cert = null;
async function distribution() {
  if (cert) return cert;
  const certs = await api('/v1/certificates?filter[certificateType]=DISTRIBUTION&limit=50');
  cert = certs.data.sort((a, b) => b.attributes.expirationDate.localeCompare(a.attributes.expirationDate))[0];
  if (!cert) throw new Error('No Apple Distribution certificate on the team (docs/store/apple/UPLOAD.md)');
  return cert;
}

// The bundle ID (registered when it is the extension's and missing), with Push Notifications on when asked.
async function bundleOf(p) {
  const bundles = await api(`/v1/bundleIds?filter[identifier]=${enc(p.bundle)}`);
  let bundle = bundles.data.find((b) => b.attributes.identifier === p.bundle);
  if (!bundle) {
    if (!p.register) throw new Error(`No bundle ID ${p.bundle} on the team`);
    say(`${p.bundle} is not registered${CHECK ? ': a run registers it' : '; registering it'}`);
    if (CHECK) return null;
    bundle = (await api('/v1/bundleIds', { method: 'POST', body: JSON.stringify({ data: { type: 'bundleIds', attributes: { identifier: p.bundle, name: p.register, platform: 'IOS' } } }) })).data;
  }
  if (p.push) {
    const caps = (await api(`/v1/bundleIds/${bundle.id}/bundleIdCapabilities`)).data.map((c) => c.attributes.capabilityType);
    if (!caps.includes('PUSH_NOTIFICATIONS')) {
      say(`${p.bundle} has no Push Notifications${CHECK ? ': a run turns it on' : '; turning it on'}`);
      if (!CHECK) await api('/v1/bundleIdCapabilities', { method: 'POST', body: JSON.stringify({ data: { type: 'bundleIdCapabilities', attributes: { capabilityType: 'PUSH_NOTIFICATIONS' }, relationships: { bundleId: { data: { type: 'bundleIds', id: bundle.id } } } } }) });
    }
  }
  return bundle;
}

const dir = path.join(os.homedir(), 'Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles');
const out = {};
for (const p of PROFILES) {
  const bundle = await bundleOf(p);
  const profiles = await api(`/v1/profiles?filter[name]=${enc(p.name)}&filter[profileType]=IOS_APP_STORE&limit=20`);
  // A profile made before the app had push lacks aps-environment: made again.
  const fits = (x) => !p.push || Buffer.from(x.attributes.profileContent || '', 'base64').includes('aps-environment');
  let profile = profiles.data.find((x) => x.attributes.profileState === 'ACTIVE' && new Date(x.attributes.expirationDate) > new Date(Date.now() + 7 * 864e5) && fits(x));
  if (!profile) {
    say(`${p.name}: ${profiles.data.length ? 'expiring or without push' : 'none yet'}${CHECK ? ': a run makes it' : '; making it'}`);
    if (CHECK) continue;
    for (const old of profiles.data) await api(`/v1/profiles/${old.id}`, { method: 'DELETE' });
    profile = (await api('/v1/profiles', {
      method: 'POST',
      body: JSON.stringify({ data: { type: 'profiles', attributes: { name: p.name, profileType: 'IOS_APP_STORE' }, relationships: {
        bundleId: { data: { type: 'bundleIds', id: bundle.id } },
        certificates: { data: [{ type: 'certificates', id: (await distribution()).id }] },
      } } }),
    })).data;
  } else if (CHECK) say(`${p.name}: fine, until ${profile.attributes.expirationDate.slice(0, 10)}`);
  if (CHECK) continue;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${profile.attributes.uuid}.mobileprovision`), Buffer.from(profile.attributes.profileContent, 'base64'));
  out[p.bundle] = p.name;
}
if (!CHECK) console.log(JSON.stringify(out));
