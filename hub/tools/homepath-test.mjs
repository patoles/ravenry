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
(await import('../server/homes.mjs')).setHomes({ devbox: '/srv/dev' });
const cp = { id: 'cabcdefg', kind: 'approve', state: 'open', title: 'Publish', command: 'npm publish', cwd: '/srv/dev/code/recipe-box', created_at: new Date().toISOString() };
const remote = push.checkpointMessage(cp, { machine: 'devbox' });
check('the alert for a command on devbox says devbox\'s ~', /in ~\/code\/recipe-box$/.test(remote.detail), remote.detail);
const local = push.checkpointMessage({ ...cp, cwd: path.join(os.homedir(), 'code', 'x') }, {});
check('the alert for a command here says this computer\'s ~', /in ~\/code\/x$/.test(local.detail), local.detail);

// ------------------------------------------------------------ remote folders
// A folder on devbox is said against devbox's home on every screen the hub
// feeds: rows outside a project, and (below) every project, brief, session
// and page folder the hub sends goes through homes.mjs with its machine.
const homesMod = await import('../server/homes.mjs');
const sessions = await import('../server/sessions.mjs');
homesMod.setHomes({ devbox: '/srv/dev' });
check('a remote folder is said against its machine\'s home', homesMod.sayFolder('/srv/dev/code/x', 'devbox') === '~/code/x');
check('a remote folder is never said against this computer\'s home', homesMod.sayFolder(path.join(os.homedir(), 'code', 'x'), 'devbox') === path.join(os.homedir(), 'code', 'x'));
check('a session row outside a project, on devbox', sessions.folderLabel('/srv/dev/code/x', 'devbox') === '~/code/x' && sessions.folderLabel('/srv/dev', 'devbox') === '~ (home folder)');
check('the same folder name here is not devbox\'s', !sessions.folderLabel('/srv/dev/code/x', null).startsWith('~'));
// No hub module says a folder that can be on another machine (a project's,
// a brief's, a session's, a page's, a checkpoint's) with this computer's
// home: those go through homes.sayFolder with their machine.
const REMOTE = /\b(short|shortPath|sayPath)\(([^()]*\b(project|p|s|e|x|r|info|cp)\.(folder|cwd|top)\b|[^()]*brief\.path|[^()]*briefPath\(|[^()]*\.real\.folder)/;
const hubFiles = fs.readdirSync(path.join(ROOT, 'server')).filter((f) => f.endsWith('.mjs')).map((f) => path.join(ROOT, 'server', f));
const localSaid = hubFiles.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').map((l, i) => [f, i + 1, l]).filter(([, , l]) => REMOTE.test(l)));
check('no remote folder is said against this computer\'s home in the hub', localSaid.length === 0, localSaid.map(([f, n]) => `${path.basename(f)}:${n}`).join(', '));
const uses = ['index.mjs', 'ship.mjs', 'pages.mjs', 'providers.mjs', 'sessions.mjs', 'push.mjs'].filter((f) => !/homes\.mjs['"]/.test(fs.readFileSync(path.join(ROOT, 'server', f), 'utf8')));
check('the project, Ship, pages, sessions and alert code use the machines\' homes', uses.length === 0, uses.join(', '));

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
check('the hub, the desktop app and the phone board use the helper', ['hub/server/index.mjs', 'hub/server/pages.mjs', 'hub/server/homes.mjs', 'apps/desktop/src/renderer/app.ts', 'apps/desktop/src/main/local.ts', 'apps/phone/src/checkpoint.ts'].every((u) => users.includes(u)), users.join(', '));

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
