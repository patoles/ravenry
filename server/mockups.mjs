// Quick mockups on idea cards (docs/design/IdeaMockups.dc.html, variant A):
// the prompt for one round, reading Claude's answer, and drawing each
// variant to a PNG. ideas.mjs runs the round; this module has no state.
//
// One round is one `claude -p --model sonnet --output-format json` call in
// ~/.ravenry/ideas (the Ideas thread's command, queue and 3-minute stop).
// Claude writes no files: it answers with a JSON array of 3
// {title, note, html}, and the board writes <id>/mockups/r<N>-<a|b|c>.html
// and renders each in headless Chromium with JavaScript off and the network
// blocked.

import fs from 'node:fs';
import path from 'node:path';

export const KEYS = ['a', 'b', 'c'];
export const W = 800;
export const H = 500;
// Asked for under 6 KB; a little over is still a picture worth drawing.
const MAX_HTML = 40 * 1024;

const noDash = (s) => String(s ?? '').replace(/\s*\u2014\s*/g, ', ');

// The idea's thread context (what the thread already sends), then the
// round's ask. `from` is the variant the next round builds on.
export function prompt({ idea, picturePath, thread, from, note }) {
  const lines = [
    "You are making a quick visual mockup for an idea on the user's Ideas board. This is a first look in minutes, not a build.",
    '',
    `Idea: ${idea.name}`,
    `Stage: ${idea.stageName}`,
    `Pitch: ${idea.pitch || '(none yet)'}`,
    `Where it stands: ${idea.status || '(nothing written)'}`,
  ];
  if (picturePath) lines.push(`Its picture: ${picturePath} (read it if it helps)`);
  if (thread && thread.length) {
    lines.push('', 'What the user and Claude said about it so far:');
    for (const m of thread.slice(-12)) lines.push(`${m.who}: ${m.text}`);
  }
  lines.push('');
  if (from) {
    lines.push(`Round ${from.round} made 3 variants. The user ${from.picked ? 'picked' : 'was looking at'} "${from.title}". Its HTML:`, from.html, '');
  }
  if (note) lines.push(`The user's note for this round: "${note}"`, '');
  if (from || note) lines.push(`Make 3 new variants${note ? ' that follow the note and' : ' that'} differ from each other in one real choice.`);
  else lines.push('Make 3 variants that differ in a real design choice (camera, layout or mood), each a picture of one moment of play as the player would see it.');
  lines.push(
    `Each variant is ONE self-contained HTML document drawn at exactly ${W}x${H} CSS pixels: inline CSS and inline SVG only, no scripts, no external fonts, images or links. Keep each under 6 KB.`,
    '',
    'Answer with ONLY a JSON array, no prose, no code fence:',
    '[{"title": "2 to 4 words", "note": "one sentence on what this variant tries", "html": "<!doctype html>..."}, x3]',
    'No em dashes.',
  );
  return lines.join('\n');
}

// claude -p --output-format json prints one object: the answer in `result`,
// usage and cost beside it. Returns { text, usage } or { error }.
export function unwrap(stdout) {
  const s = String(stdout || '').trim();
  let j;
  try { j = JSON.parse(s); } catch { return { text: s, usage: null }; }
  if (Array.isArray(j)) return { text: s, usage: null };
  if (!j || typeof j !== 'object') return { text: s, usage: null };
  if (j.is_error) return { error: `Claude reported an error: ${String(j.result || j.subtype || 'no detail').slice(0, 200)}` };
  const u = j.usage || {};
  const usage = {
    input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
    output: u.output_tokens || 0,
    thinking: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0,
    costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
    model: j.modelUsage ? Object.keys(j.modelUsage)[0] || null : null,
    turns: typeof j.num_turns === 'number' ? j.num_turns : null,
  };
  return { text: String(j.result ?? ''), usage };
}

// The 3 variants out of the answer, checked. null when it is not 3 pictures
// the board can read.
export function parseVariants(text) {
  let s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let arr = null;
  try { arr = JSON.parse(s); } catch {
    const a = s.indexOf('[');
    const b = s.lastIndexOf(']');
    if (a >= 0 && b > a) { try { arr = JSON.parse(s.slice(a, b + 1)); } catch { arr = null; } }
  }
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue;
    const title = noDash(x.title).replace(/\s+/g, ' ').trim().slice(0, 60);
    const note = noDash(x.note).replace(/\s+/g, ' ').trim().slice(0, 300);
    let html = typeof x.html === 'string' ? x.html : '';
    // Scripts never run (JavaScript is off when it is drawn); they are not kept either.
    html = html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '').replace(/<script\b[^>]*>/gi, '');
    if (!title || !/<(svg|div|body|html|!doctype)/i.test(html) || html.length > MAX_HTML) continue;
    out.push({ title, note, html });
    if (out.length === 3) break;
  }
  return out.length === 3 ? out : null;
}

// Draws each HTML file to a PNG next to it. JavaScript off, every network
// request refused, 800x500. Playwright is optional: without it the round
// fails with one sentence that says how to install it (a global install is
// found from a global Ravenry, since Node looks up the folders above it).
export async function render(files) {
  let pw;
  try { pw = await import('playwright'); } catch {
    throw new Error('Mockup pictures need Playwright, which is not installed. Install it with: npm i -g playwright && npx playwright install chromium');
  }
  let browser;
  try {
    browser = await pw.chromium.launch({ headless: true });
  } catch (e) {
    throw new Error(`headless Chromium did not start (${String(e.message).split('\n')[0].slice(0, 120)})`);
  }
  try {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, javaScriptEnabled: false, offline: true });
    await ctx.route('**/*', (r) => (r.request().url().startsWith('data:') ? r.continue() : r.abort()));
    const out = [];
    for (const f of files) {
      const page = await ctx.newPage();
      await page.setContent(fs.readFileSync(f, 'utf8'), { waitUntil: 'load', timeout: 15000 });
      const png = f.replace(/\.html$/, '.png');
      await page.screenshot({ path: png, clip: { x: 0, y: 0, width: W, height: H } });
      await page.close();
      out.push(png);
    }
    return out;
  } finally {
    await browser.close().catch(() => {});
  }
}

export function dir(ideasDir, id) {
  return path.join(ideasDir, id, 'mockups');
}

// "1 min 4 s", "41 s"
export function took(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
