// The pages self-test's extra demo data (sidetest.mjs --screen pages): a
// hard-wrapped ~/.claude/CLAUDE.md as people write them (paragraphs and
// bullets broken at 80 columns, a numbered list, code, a link), ideas with
// pictures of three shapes (a red frame and yellow corners, so a crop
// shows), and in paper-boat's brief a finished plan and an objective of
// plain tasks to tick.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** A W by H PNG: a gradient, a red frame 12 wide, yellow corners, a white disc in the middle. */
export function png(file, W, H, hue) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      let c = [Math.floor(40 + 120 * x / W), Math.floor(60 + 100 * y / H), hue];
      const edge = Math.min(x, y, W - 1 - x, H - 1 - y);
      if (edge < 12) c = [230, 60, 60];
      const corner = (x < 80 || x > W - 80) && (y < 80 || y > H - 80);
      if (corner && edge >= 12) c = [250, 210, 60];
      const dx = x - W / 2, dy = y - H / 2;
      if (dx * dx + dy * dy < (Math.min(W, H) / 5) ** 2) c = [240, 240, 240];
      raw.set(c, y * (W * 3 + 1) + 1 + x * 3);
    }
  }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// 15 paragraphs once drawn: the title, the intro (3 lines), 3 headings, 3 + 2
// bullets (2 lines each, some), 3 numbered, the code block, the last line.
export const RULES = `# Working rules

Gathered from three projects. Each rule names the note that holds its story. A
project's own rules win where they are more specific. Design decisions from one
project never carry over to another; only process lessons do.

## Doing what was asked
- A look note changes exactly the element named, in the words used.
  Leave siblings alone; report a sibling issue in one line.
- A bug from a class already reported gets fixed at its root, everywhere,
  not one instance at a time.
- When a direction is stated, even as "I'm thinking...", it is the decision.
  Never turn it back into a multiple-choice question.

## Pictures first
- Any change to what the screen looks like gets a picture within minutes before
  anyone builds it: variants side by side, each element whole and uncluttered.
- What the player sees is the truth. A screenshot beats internal correctness.

## Pace and verification
1. With an approved plan, keep going: no milestone stops.
2. A playtest note is a 10 to 15 minute fix: the fix, one relevant check, one
   screenshot, deliver.
3. If a round produces no visible change, change the method, not the test count.

\`\`\`
npm run check && npm run shots
\`\`\`

Read [the long notes](https://example.com/rules) for the stories behind each rule.
`;
export const RULES_PARAGRAPHS = 15;

export function pagesPrepare({ HOME, ROOT, MC }) {
  fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.claude', 'CLAUDE.md'), RULES);
  const I = path.join(MC, 'pages', 'ideas');
  fs.mkdirSync(I, { recursive: true });
  png(path.join(I, 'wide.png'), 1600, 700, 180);
  png(path.join(I, 'square.png'), 800, 600, 90);
  png(path.join(I, 'tall.png'), 600, 900, 40);
  const idea = (id, title, stage, pitch, pic) => fs.writeFileSync(path.join(I, `${id}.md`), `---\ntitle: ${title}\nstage: ${stage}\npitch: ${pitch}\nstatus: Added today.\n${pic ? `picture: ${pic}\n` : ''}---\n`);
  idea('harbour-race', 'Harbour race', 'mockup', 'Paper boats raced across a harbour you fold yourself.', 'wide.png');
  idea('night-garden', 'Night garden', 'greenlit', 'A garden that only grows while you sleep.', 'square.png');
  idea('lantern-tower', 'Lantern tower', 'mockup', 'Stack lanterns as high as the wind allows.', 'tall.png');
  const bf = path.join(ROOT, 'paper-boat', 'BRIEF.md');
  if (fs.existsSync(bf)) {
    fs.appendFileSync(bf, '\n## Plan\n### Rig the sail\n- [x] Cut the cloth\n- [>] Sew the hem\n- [ ] Fit the mast\n\n'
      + '### Find why the hull leaks\nRuns on its own. Started: 2026-11-04 09:00. Not in the plan: stop and ask.\nGoal: "The hull floats for a full minute"\n\n'
      + '- [x] Do: Float the hull for a minute and time the leak\n  - Proof: leak.txt says 41 s (09:20)\n- [x] Do: Seal the seam at the bow\n  - Proof: the hull floats 60 s (10:05)\n');
  }
}
