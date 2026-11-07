// A page with one real xterm.js in a shipped theme (?theme=<id>), showing a
// Claude Code turn as F6 of the terminal-basics picture draws it, in plain
// SGR. tools/settings-shots.mjs builds it and tools/settings-driver.cjs
// captures it offscreen. Never part of the app.
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { BUILT_IN_THEMES } from '../src/shared/themes.ts';
import { fontStack } from '../src/shared/settings.ts';

const id = new URLSearchParams(location.search).get('theme') || 'ravenry-light';
const t = BUILT_IN_THEMES.find((x) => x.id === id) || BUILT_IN_THEMES[0];
const light = t.appearance === 'light';
document.body.style.cssText = `margin:0;background:${t.theme.background};padding:14px 18px 10px;height:100vh;box-sizing:border-box`;
const el = document.createElement('div');
el.style.height = '100%';
document.body.append(el);

const term = new Terminal({ fontFamily: fontStack('Menlo'), fontSize: 13, lineHeight: 1.15, theme: t.theme, cols: 150, rows: 40, cursorStyle: 'block' });
term.open(el);

const E = '\x1b[';
const rgb = (r: number, g: number, b: number) => `${E}48;2;${r};${g};${b}m`;
// Claude Code's own diff tints (truecolor), as it draws them on a light or a dark terminal.
const add = light ? rgb(224, 238, 222) : rgb(26, 58, 36);
const del = light ? rgb(246, 227, 224) : rgb(58, 30, 30);
const pad = (s: string) => s + ' '.repeat(Math.max(0, 148 - s.length));
const lines = [
  '', '', '', '', '', '', '', '', '', '',
  `${E}48;2;${light ? '239;237;232' : '30;30;33'}m${pad(' > The header wraps onto two lines on a phone. Fix it and check it at 390 px.')}${E}0m`,
  '',
  '● The nav links don\'t shrink below 600 px. Here is the fix:',
  '',
  `${E}32m●${E}0m ${E}1mUpdate${E}0m(src/components/Header.css)`,
  `${E}90m  ⎿  Updated src/components/Header.css with 4 additions and 1 removal${E}0m`,
  `${E}90m      12   .nav {${E}0m`,
  `${del}${E}31m${pad('      13 -   gap: 32px;')}${E}0m`,
  `${add}${E}32m${pad('      13 +   gap: clamp(12px, 4vw, 32px);')}${E}0m`,
  `${add}${E}32m${pad('      14 +   flex-wrap: nowrap;')}${E}0m`,
  `${add}${E}32m${pad('      15 +   min-width: 0;')}${E}0m`,
  `${add}${E}32m${pad('      16 +   font-size: clamp(13px, 3.6vw, 15px);')}${E}0m`,
  `${E}90m      17   }${E}0m`,
  '',
  `${E}32m●${E}0m ${E}1mBash${E}0m(npx vitest run src/header.test.tsx)`,
  `  ${E}90m⎿${E}0m  ${E}32m✓ 4 passed${E}0m`,
  '',
  `${E}38;2;${light ? '194;94;43' : '217;119;87'}m✳ Checking at 390 px...${E}0m ${E}90m(12s)${E}0m`,
  '',
  `${E}33mwarn${E}0m ${E}34m~/code/landing-page${E}0m ${E}35mmain${E}0m ${E}36mcyan${E}0m ${E}37mwhite${E}0m ${E}91mbr-red${E}0m ${E}92mbr-green${E}0m ${E}93mbr-yellow${E}0m ${E}94mbr-blue${E}0m ${E}95mbr-magenta${E}0m ${E}96mbr-cyan${E}0m ${E}97mbr-white${E}0m`,
  `${E}90m  ? for shortcuts${E}0m`,
  '> ',
];
term.write(lines.join('\r\n'), () => { setTimeout(() => { document.body.dataset.ready = '1'; }, 200); });
