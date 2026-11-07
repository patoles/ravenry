// A program that redraws its region as Claude Code does (Ink), for
// tools/marks-test.mjs: a transcript, and under it an input box it repaints
// at every key by moving the cursor up over its old lines and clearing
// them. Enter puts "❯ <text>" in the transcript and answers "Reading 1
// file… (ctrl+o to expand)"; a pasted path to an image shows as
// "[Image #N]", as Claude Code shows it. A line "MORE <n>" prints n lines.
import process from 'node:process';

const out = (s) => process.stdout.write(s);
const cols = () => process.stdout.columns || 80;
let input = '';
let images = 0;
let boxLines = 0;

function box() {
  const w = Math.max(20, cols() - 2);
  const shown = input.length > w - 4 ? input.slice(input.length - (w - 4)) : input;
  return [`╭${'─'.repeat(w - 2)}╮`, `│ ${(shown + ' '.repeat(w)).slice(0, w - 4)} │`, `╰${'─'.repeat(w - 2)}╯`, '  ? for shortcuts'];
}

// Repaint: up over the box's lines, clear each, draw `above` then the box.
function paint(above = []) {
  if (boxLines) out(`\r\x1b[${boxLines - 1}A`);
  else out('\r');
  const lines = [...above, ...box()];
  out(lines.map((l) => `\x1b[2K${l}`).join('\r\n'));
  boxLines = box().length;
}

process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
paint(['Claude Code (stand-in)', '']);
process.stdin.on('data', (d) => {
  // A bracketed paste, or keys.
  const text = d.replace(/\x1b\[20[01]~/g, '');
  for (const ch of text.length > 1 && !/\r/.test(text) ? [text] : [...text]) {
    if (ch === '\r' || ch === '\n') {
      const line = input;
      input = '';
      const m = /^MORE (\d+)$/.exec(line.trim());
      if (m) {
        const n = Number(m[1]);
        paint(Array.from({ length: n }, (_, i) => `  output line ${i + 1} of ${n}: ${'lorem ipsum dolor sit amet '.repeat(2)}`));
      } else paint([`❯ ${line}`, '', '⏺ Reading 1 file… (ctrl+o to expand)', '']);
    } else if (ch === '\x7f') { input = input.slice(0, -1); paint(); }
    else if (ch === '\x03') process.exit(0);
    else if (/\.(png|jpe?g|gif)\s*$/i.test(ch.trim()) && ch.length > 1) { images++; input += `[Image #${images}] `; paint(); }
    else { input += ch; paint(); }
  }
});
