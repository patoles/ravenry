// One way to say a folder (public/homepath.mjs): the home folder of the
// machine it is on as ~, everywhere Ravenry shows one.
//   - the helper: this computer's home, a machine's own home, a folder
//     outside its home, a home that only starts the same, an unknown home;
//   - the phone's alert for a command on devbox says its folder against
//     devbox's home (from that ravenryd's hello), not this computer's;
//   - no other code says a folder its own way: every hub module, the web
//     board, the desktop app and the phone board leave "~" to the helper.
// Usage: node tools/homepath-test.mjs
import './test-guard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeOf, sayPath, sayPathOn } from '../public/homepath.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.dirname(ROOT);
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };

// ------------------------------------------------------------ the helper
check('a folder in the home is said with ~', sayPath('/srv/dev/code/app', '/srv/dev') === '~/code/app');
check('the home itself is ~', sayPath('/srv/dev', '/srv/dev') === '~' && sayPath('/srv/dev', '/srv/dev/') === '~');
check('a folder outside the home is said in full', sayPath('/srv/app', '/srv/dev') === '/srv/app');
check('a home that only starts the same is not the home', sayPath('/srv/devbox/app', '/srv/dev') === '/srv/devbox/app');
check('an unknown home says the folder in full', sayPath('/srv/dev/app', null) === '/srv/dev/app' && sayPath('', '/srv/dev') === '');
const homes = { '': '/var/someone', devbox: '/srv/dev' };
check('a machine\'s folder is said against its own home', sayPathOn('/srv/dev/code/recipe-box', 'devbox', homes) === '~/code/recipe-box');
check('this computer\'s folder against this computer\'s home', sayPathOn('/var/someone/code/x', null, homes) === '~/code/x' && sayPathOn('/var/someone/code/x', 'local', homes) === '~/code/x');
check('never another machine\'s home', sayPathOn('/var/someone/code/x', 'devbox', homes) === '/var/someone/code/x' && sayPathOn('/srv/dev/x', null, homes) === '/srv/dev/x');
check('a machine with no known home', homeOf(homes, 'gpu') === null && sayPathOn('/srv/gpu/x', 'gpu', homes) === '/srv/gpu/x');

// ------------------------------------------------------------ the phone's alerts
const push = await import('../server/push.mjs');
push.setHomes({ devbox: '/srv/dev' });
const cp = { id: 'cabcdefg', kind: 'approve', state: 'open', title: 'Publish', command: 'npm publish', cwd: '/srv/dev/code/recipe-box', created_at: new Date().toISOString() };
const remote = push.checkpointMessage(cp, { machine: 'devbox' });
check('the alert for a command on devbox says devbox\'s ~', /in ~\/code\/recipe-box$/.test(remote.detail), remote.detail);
const local = push.checkpointMessage({ ...cp, cwd: path.join(os.homedir(), 'code', 'x') }, {});
check('the alert for a command here says this computer\'s ~', /in ~\/code\/x$/.test(local.detail), local.detail);

// ------------------------------------------------------------ one helper
// Code that builds "~" + a path itself says folders its own way.
const OWN = /['"`]~['"`]\s*\+|`~\$\{/;
const roots = [path.join(ROOT, 'server'), path.join(ROOT, 'public'), path.join(ROOT, 'bin'), path.join(REPO, 'apps', 'desktop', 'src'), path.join(REPO, 'apps', 'phone', 'src')];
const files = [];
const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'node_modules') walk(p); } else if (/\.(m?js|ts)$/.test(e.name)) files.push(p); } };
roots.forEach(walk);
const own = files.filter((f) => !f.endsWith('homepath.mjs') && fs.readFileSync(f, 'utf8').split('\n').some((l) => OWN.test(l) && !/^\s*\/\//.test(l)));
check(`no code says a folder with ~ its own way (${files.length} files)`, own.length === 0, own.map((f) => path.relative(REPO, f)).join(', '));
const users = files.filter((f) => /homepath\.mjs['"]/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(REPO, f));
check('the hub, the desktop app and the phone board use the helper', ['hub/server/index.mjs', 'hub/server/pages.mjs', 'hub/server/push.mjs', 'apps/desktop/src/renderer/app.ts', 'apps/desktop/src/main/local.ts', 'apps/phone/src/checkpoint.ts'].every((u) => users.includes(u)), users.join(', '));

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
