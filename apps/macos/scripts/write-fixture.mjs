// The writing self-test's board (sidetest.mjs --screen write,
// SelfTestWrite.swift): what the native app writes that only the hub's
// browser board wrote before (BRIEF-005, BRIEF-006, PLAN-003, PLAN-005,
// PLAN-006, PANEL-008, IDEA-004 to IDEA-006), each checked where it lands.
//
// The demo hub runs in Ravenry mode on the test's own daemon
// (RAVENRY_TERMINAL=ravenry, RAVENRY_DAEMON_BIN, its runtime folder), so a
// plan's words that need a new session (an answer, a reopen, a start) open
// one in a pane of that daemon, a stand-in of Claude, and the hub answers
// 2xx; with the fake cmux every such route answered 500. Its projects, none
// with a session:
//
//   lighthouse  a plan waiting at a gate with choices (the panel's Plan card)
//   harbour     a plan whose gate the "agent" ticks in the file (arrivals 1
//               and 2 tick it): the plan page's Reopen, then Confirm
//   quay        a plan that stopped to ask, answered in words, then stops
//               again at the next step (the self-test marks it [?], as the
//               session would)
//   beacon      a running plan to change, and a brief to add a note to
//   sandbar     a brief with a goal and no plan: Write the plan yourself
//   old-notes   a folder with no brief: Write the brief
//
// The app talks to the hub through a logging proxy (trafficProxy), so each
// check reads the hub's own answer (its status) to what the app sent:
// Hub.post records a request whatever the answer.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { png } from './pages-fixture.mjs';

const plan = (title, steps, started = '2026-11-10 09:00') => `\n## Plan\n### ${title}\nRuns on its own. Started: ${started}.\nGoal: "${title}"\n\n${steps.join('\n')}\n`;
export const BRIEFS = {
  lighthouse: '# Lighthouse\n\nGoal: A lighthouse model whose lamp turns at the real speed.\n'
    + plan('Fit the lamp', ['- [x] Do: Print the lamp housing', '- [?] Gate: Pick the beam colour', '  - Choices: Warm white | Cold blue', '- [ ] Do: Fit the lamp']),
  harbour: '# Harbour\n\nGoal: A harbour model with a mast that stands.\n'
    + plan('Rig the mast', ['- [x] Do: Cut the mast', '- [ ] Gate: Pick the wood', '  - Choices: Oak | Pine', '- [ ] Do: Raise it']),
  quay: '# Quay\n\nGoal: A quay for the boats.\n'
    + plan('Name the boats', ['- [?] Do: Name the first boat', '  - Question: What is the first boat called?', '- [ ] Do: Name the second boat', '- [ ] Do: Paint the names']),
  beacon: '# Beacon\n\nGoal: A beacon that lights at dusk.\n\n## Notes\n- [ ] The oil smells (added 2026-11-09 10:00)\n'
    + plan('Light the beacon', ['- [x] Do: Fill the oil', '- [ ] Do: Trim the wick', '- [ ] Do: Light it at dusk']),
  sandbar: '# Sandbar\n\nGoal: A chart of the sandbar at low tide.\n',
};

/** The demo hub's options for --screen write (to Object.assign over sidetest's). */
export function writeHub({ APP, run, tmp }) {
  const stand = path.join(tmp, 'claude-stand-in');
  fs.writeFileSync(stand, "#!/bin/sh\nprintf 'Claude Code (a stand-in): %s\\n\\n> ' \"$*\"\nexec sleep 100000\n", { mode: 0o755 });
  return {
    plan: false, ideas: true, runtime: run, settings: { launchCommand: stand },
    env: {
      RAVENRY_DAEMON_BIN: path.join(APP, 'Contents', 'MacOS', 'ravenryd'), RAVENRY_TERMINAL: 'ravenry', MC_PHONE_LAN: 'none', RAVENRY_SSH: '/usr/bin/false',
      // The mockup rounds' pictures: Playwright's own headless Chromium, from where this
      // Mac keeps it (only read): the hub's HOME is the test's, where Playwright finds none.
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    },
    extra: ['lighthouse', 'harbour', 'quay', 'beacon', 'sandbar', 'old-notes'].map((id) => ({ id, name: id })),
    prepare: ({ ROOT }) => {
      for (const [id, text] of Object.entries(BRIEFS)) { fs.mkdirSync(path.join(ROOT, id), { recursive: true }); fs.writeFileSync(path.join(ROOT, id, 'BRIEF.md'), text); }
      fs.mkdirSync(path.join(ROOT, 'old-notes'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'old-notes', 'notes.txt'), 'Some old notes.\n');
    },
  };
}

/** What the app reads (RAVENRY_MAC_WRITE): where the hub keeps things, its answers, a picture to add. */
export function writeEnv(hub, OUT, traffic) {
  const pic = path.join(OUT, 'write-reference.png');
  png(pic, 320, 200, 200);
  const f = path.join(OUT, 'write-env.json');
  fs.writeFileSync(f, JSON.stringify({ root: hub.root, mc: path.join(hub.home, '.ravenry'), traffic, picture: pic }));
  return f;
}

/** Arrival N: the agent ticks harbour's gate in the file, never through the hub (a gate passed in the file alone). */
export function writeArrive(hub, n) {
  const f = path.join(hub.root, 'harbour', 'BRIEF.md');
  const s = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, s.replace(/- \[[ ?>]\] Gate: Pick the wood/, '- [x] Gate: Pick the wood'));
  return n;
}

/** A proxy in front of the hub that logs each request with the hub's answer (JSON lines in `file`). */
export async function trafficProxy(url, file) {
  fs.writeFileSync(file, '');
  const to = new URL(url);
  const proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const up = http.request({ host: to.hostname, port: to.port, path: req.url, method: req.method, headers: { ...req.headers, host: to.host } }, (ur) => {
        res.writeHead(ur.statusCode, ur.headers);
        if (req.url.startsWith('/api/events')) { ur.pipe(res); return; }
        const rc = [];
        ur.on('data', (c) => { rc.push(c); res.write(c); });
        ur.on('end', () => {
          res.end();
          if (req.method === 'GET') return;
          const rb = Buffer.concat(rc), ct = String(ur.headers['content-type'] || '');
          const sent = /json/.test(String(req.headers['content-type'] || '')) ? body.toString('utf8').slice(0, 2000) : `(${body.length} bytes)`;
          fs.appendFileSync(file, JSON.stringify({ t: Date.now(), m: req.method, u: req.url, req: sent, s: ur.statusCode, res: /json|text/.test(ct) ? rb.toString('utf8').slice(0, 2000) : `(${rb.length} bytes)` }) + '\n');
        });
      });
      up.on('error', (e) => { fs.appendFileSync(file, JSON.stringify({ t: Date.now(), m: req.method, u: req.url, err: String(e) }) + '\n'); try { res.writeHead(502); res.end(); } catch { /* gone */ } });
      up.end(body);
    });
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${proxy.address().port}`, close: () => proxy.close() };
}
