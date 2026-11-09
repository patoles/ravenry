// Checks server/machineview.mjs, what the Machines page shows of each
// machine, against what the desktop's renderer/machines.ts draws for the
// same machine (the words, the colour, the buttons and the steps).
//
// Usage: node tools/machineview-test.mjs
import { machineCard, words } from '../server/machineview.mjs';
import { SHAPES } from './machine-shapes.mjs';

let failed = 0;
const ok = (name, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : `: ${detail}`}`); if (!cond) failed++; };
const by = Object.fromEntries(SHAPES.map((m) => [m.name, machineCard(m)]));
const text = (runs) => (runs || []).map((r) => r.text).join('');
const labels = (c) => c.actions.map((a) => a.label).join(',');

ok('connected: word and buttons', by.devbox.word === 'Connected' && by.devbox.tone === 'ok' && labels(by.devbox) === 'Uninstall,Run install again' && by.devbox.actions[0].confirm === true, labels(by.devbox));
ok('connected: facts', by.devbox.facts.map(text).join('|') === 'Linux, x86-64|ravenryd 0.1.24|Answers from here', by.devbox.facts.map(text).join('|'));
ok('connected: needs nothing, sorts last', !by.devbox.needs && by.devbox.order === 3 && by.devbox.tag === '');
ok('older: words and Update', by['gpu-box'].word === 'Older ravenryd' && by['gpu-box'].tone === 'you' && text(by['gpu-box'].msg) === 'gpu-box runs ravenryd 0.1.21; this app carries 0.1.24. Its sessions keep running on 0.1.21 until they end; new sessions start on 0.1.24.'
  && labels(by['gpu-box']) === 'Update gpu-box' && by['gpu-box'].actions[0].style === 'pri' && by['gpu-box'].actions[0].route === '/api/machines/install', text(by['gpu-box'].msg));
ok('older: needs you, tag att, sessions on the old one', by['gpu-box'].needs && by['gpu-box'].order === 1 && by['gpu-box'].tag === 'att' && by['gpu-box'].facts.map(text).includes('Sessions on 0.1.21 until they end'));
ok('newer: words, Install ours there, att', by.studio.word === 'Newer ravenryd' && labels(by.studio) === 'Install 0.1.24 there' && by.studio.tag === 'att' && !by.studio.needs && by.studio.facts.map(text).join('|') === 'macOS, arm64|Another board takes its answers');
ok('protocol: words and Update', by['old-nas'].word === 'Cannot talk to it' && by['old-nas'].tone === 'bad' && text(by['old-nas'].msg) === 'old-nas runs ravenryd 0.0.9, which speaks protocol 0; this app speaks protocol 1. Update it there: its sessions keep running on the old daemon until they end.' && labels(by['old-nas']) === 'Update old-nas' && by['old-nas'].tag === 'bad', text(by['old-nas'].msg));
ok('missing: words, path mono, Remove and Install', by.pi.word === 'Not installed' && by.pi.tone === 'off' && by.pi.msg.some((r) => r.mono && r.text === '~/.ravenry/bin') && labels(by.pi) === 'Remove,Install' && by.pi.actions[0].route === '/api/machines/remove');
ok('down: why with paths mono, the fix a command, Try again', by['build-server'].word === 'Cannot connect' && by['build-server'].msg.some((r) => r.mono && r.text === '~/.ssh/id_ed25519') && by['build-server'].msg.some((r) => r.cmd && r.text === 'ssh-copy-id deploy@buildbox')
  && labels(by['build-server']) === 'Remove,Try again' && by['build-server'].actions[1].route === '/api/machines/retry', JSON.stringify(by['build-server'].msg));
const r1 = by['render-1'];
ok('running: Installing, first, no buttons, the bar and amount', r1.word === 'Installing' && r1.tone === 'work' && r1.order === 0 && r1.actions.length === 0 && r1.job.steps[1].bar === 48 && r1.job.steps[1].time === '4.2 of 8.8 MB' && r1.job.steps[0].time === '1.2 s' && r1.job.steps[2].icon === 'pending', JSON.stringify(r1.job.steps[1]));
const bsd = by['bsd-box'];
ok('failed: Install stopped, Remove and Try again, fix with its words', bsd.word === 'Install stopped' && bsd.tone === 'bad' && labels(bsd) === 'Remove,Try again' && bsd.job.canHide && bsd.job.steps[2].fix.cmd === 'df -h ~' && bsd.job.steps[2].fix.what === 'See what takes the room:' && bsd.job.steps[2].detail.some((r) => r.mono && r.text === '~/.ravenry/bin'));
ok('failed, folded: needs nothing more', bsd.needs && !bsd.needsFolded && bsd.orderFolded === 3 && bsd.tagFolded === '');
const lab = by.lab;
ok('done with a warning: its word and Use Ravenry\'s instead', lab.word === 'Installed, hooks left as they were' && lab.job.factsWithSteps && lab.job.steps[1].action.buttons[0].body.replaceHooks === true && lab.job.steps[1].action.hint === 'Uninstall puts yours back.');
const ol = by['old-laptop'];
ok('needs: End them and uninstall, Cancel folds', ol.word === 'Sessions still run there' && ol.actions.length === 0 && ol.job.steps[0].action.buttons[0].label === 'End them and uninstall' && ol.job.steps[0].action.buttons[0].body.endSessions === true && ol.job.steps[0].action.buttons[1].fold === true && !ol.job.canHide);
ok('confirm words for a connected machine', text(by.devbox.confirm.words).startsWith('Uninstall from devbox? Ravenry removes what it installed there: ~/.ravenry/bin/ravenryd, the ravenry link') && by.devbox.confirm.yes.style === 'danger' && by.pi.confirm === null);
ok('words(): plain text stays one run', words('no paths here').length === 1 && words(null).length === 0);
console.log(failed ? `machineview-test: ${failed} failed` : 'machineview-test: all passed');
process.exit(failed ? 1 : 0);
