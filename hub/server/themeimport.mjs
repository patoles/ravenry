// Theme import, every client's: an iTerm2 colour preset (.itermcolors, a
// plist XML file) or a Ghostty theme file (key = value lines) made into a
// Ravenry theme file (shared/themes/, shared/README.md). Pure: the file's
// text in, a theme or the reason it is not one out. Moved from the
// desktop's src/main/themeimport.ts, which now re-exports it; the hub
// answers POST /api/settings/theme-import with it (the native Mac app).
// Each client saves the theme in its own data folder's themes/.

/** The 16 colours' keys of a theme, in palette order. */
export const ANSI_KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

/** "#rgb", "#rrggbb" or "#rrggbbaa" as [r, g, b], else null. */
export function parseHex(c) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(c).trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export const toHex = (rgb) =>
  '#' + rgb.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();

/** Dark or light, from the background's relative luminance. */
export function appearanceOf(background) {
  const rgb = parseHex(background);
  if (!rgb) return 'dark';
  const l3 = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  const l = 0.2126 * l3[0] + 0.7152 * l3[1] + 0.0722 * l3[2];
  return l > 0.4 ? 'light' : 'dark';
}

const CSS_COLOUR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/i;

/** A theme file as shared/themes/ holds them: a name, dark or light, and every colour a CSS colour. */
export function isThemeFile(v) {
  if (!v || typeof v !== 'object') return false;
  if (typeof v.name !== 'string' || !v.name.trim() || (v.appearance !== 'dark' && v.appearance !== 'light')) return false;
  if (!v.theme || typeof v.theme !== 'object') return false;
  const t = v.theme;
  for (const k of ['background', 'foreground', 'cursor', 'cursorAccent', ...ANSI_KEYS]) {
    if (typeof t[k] !== 'string' || !CSS_COLOUR.test(t[k])) return false;
  }
  for (const c of Object.values(t)) if (typeof c !== 'string' || !CSS_COLOUR.test(c)) return false;
  return true;
}

/** A theme name made into a file and id slug: "Tokyo Night (Storm)" is "tokyo-night-storm". */
export function slug(name) {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'theme';
}

/** A name from a file's name: "Tokyo Night.itermcolors" is "Tokyo Night". */
export function nameFromFile(file) {
  const base = file.split(/[\\/]/).pop() || '';
  return base.replace(/\.(itermcolors|conf|theme|txt)$/i, '').replace(/[_]+/g, ' ').trim().slice(0, 60) || 'Imported theme';
}

/** Either format, told apart by the text: a plist is XML. */
export function importTheme(text, fileName) {
  if (text.length > 1024 * 1024) return { ok: false, error: 'The file is too big for a theme (over 1 MB).' };
  const name = nameFromFile(fileName);
  return /^\s*(<\?xml|<!DOCTYPE plist|<plist)/i.test(text) ? fromItermcolors(text, name) : fromGhostty(text, name);
}

// ------------------------------------------------------------- .itermcolors

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');

/** A small plist XML reader: dict, array, key, string, real, integer, true, false, date and data. */
export function parsePlist(xml) {
  const body = xml.replace(/<\?xml[^>]*\?>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const re = /<(\/?)([a-zA-Z]+)\s*(\/?)>|([^<]+)/g;
  const toks = [];
  for (let m; (m = re.exec(body));) {
    if (m[4] !== undefined) { toks.push({ close: false, tag: '#text', empty: false, text: m[4] }); continue; }
    toks.push({ close: m[1] === '/', tag: m[2], empty: m[3] === '/' });
  }
  let i = 0;
  const text = (tag) => {
    let s = '';
    while (i < toks.length && toks[i].tag === '#text') s += toks[i++].text;
    if (!(toks[i] && toks[i].close && toks[i].tag === tag)) throw new Error(`<${tag}> is not closed`);
    i++;
    return unescape(s);
  };
  const value = () => {
    while (toks[i] && toks[i].tag === '#text') i++;
    const t = toks[i++];
    if (!t || t.close) throw new Error('a value is missing');
    switch (t.tag) {
      case 'plist': { const v = value(); while (toks[i] && toks[i].tag === '#text') i++; if (toks[i] && toks[i].close && toks[i].tag === 'plist') i++; return v; }
      case 'dict': {
        const o = {};
        if (t.empty) return o;
        for (;;) {
          while (toks[i] && toks[i].tag === '#text') i++;
          const k = toks[i];
          if (!k) throw new Error('<dict> is not closed');
          if (k.close && k.tag === 'dict') { i++; return o; }
          if (k.tag !== 'key' || k.close) throw new Error(`<${k.tag}> where a <key> should be`);
          i++;
          const key = k.empty ? '' : text('key');
          o[key] = value();
        }
      }
      case 'array': {
        const a = [];
        if (t.empty) return a;
        for (;;) {
          while (toks[i] && toks[i].tag === '#text') i++;
          if (!toks[i]) throw new Error('<array> is not closed');
          if (toks[i].close && toks[i].tag === 'array') { i++; return a; }
          a.push(value());
        }
      }
      case 'string': case 'date': case 'data': return t.empty ? '' : text(t.tag);
      case 'real': case 'integer': { const n = Number(text(t.tag).trim()); if (!Number.isFinite(n)) throw new Error(`<${t.tag}> is not a number`); return n; }
      case 'true': if (!t.empty) text('true'); return true;
      case 'false': if (!t.empty) text('false'); return false;
      default: throw new Error(`<${t.tag}> is not plist`);
    }
  };
  return value();
}

// Display P3 to sRGB, for colours iTerm2 saved in the P3 colour space.
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function p3ToSrgb([r, g, b]) {
  const [R, G, B] = [r, g, b].map(lin);
  return [
    1.2249401 * R - 0.2249404 * G + 0.0000001 * B,
    -0.0420569 * R + 1.0420571 * G - 0.0000001 * B,
    -0.0196376 * R - 0.0786361 * G + 1.0982735 * B,
  ].map((c) => gam(Math.max(0, Math.min(1, c))));
}

function itermColour(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const c = (k) => (typeof d[`${k} Component`] === 'number' ? d[`${k} Component`] : NaN);
  let rgb = [c('Red'), c('Green'), c('Blue')];
  if (rgb.some((v) => !Number.isFinite(v))) return null;
  rgb = rgb.map((v) => Math.max(0, Math.min(1, v)));
  if (d['Color Space'] === 'P3') rgb = p3ToSrgb(rgb);
  // sRGB and Calibrated (generic RGB, close to sRGB) are taken as they are.
  return toHex(rgb.map((v) => v * 255));
}

export function fromItermcolors(xml, name) {
  let root;
  try { root = parsePlist(xml); } catch (e) { return { ok: false, error: `This is not a readable .itermcolors file: ${e.message}.` }; }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return { ok: false, error: 'This .itermcolors file holds no colours.' };
  const dict = root;
  // iTerm2 3.4+ can save a light and a dark variant ("Ansi 0 Color (Dark)");
  // the plain key wins, then the dark variant.
  const get = (k) => itermColour(dict[k]) || itermColour(dict[`${k} (Dark)`]) || itermColour(dict[`${k} (Light)`]);
  const palette = [];
  for (let n = 0; n < 16; n++) {
    const c = get(`Ansi ${n} Color`);
    if (!c) return { ok: false, error: `This .itermcolors file has no Ansi ${n} Color.` };
    palette.push(c);
  }
  const background = get('Background Color');
  const foreground = get('Foreground Color');
  if (!background || !foreground) return { ok: false, error: 'This .itermcolors file has no background or foreground colour.' };
  const theme = buildTheme(palette, background, foreground, {
    cursor: get('Cursor Color'), cursorAccent: get('Cursor Text Color'),
    selectionBackground: get('Selection Color'), selectionForeground: get('Selected Text Color'),
  });
  return done({ name, appearance: appearanceOf(background), theme });
}

// ------------------------------------------------------------------ Ghostty

// The X11 names Ghostty's bundled themes and most hand-written ones use.
const NAMED = {
  black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#00FF00', blue: '#0000FF', yellow: '#FFFF00',
  cyan: '#00FFFF', magenta: '#FF00FF', gray: '#BEBEBE', grey: '#BEBEBE', orange: '#FFA500', purple: '#A020F0',
};

function ghosttyColour(v) {
  const s = v.trim().replace(/^["']|["']$/g, '');
  const rgb = parseHex(s);
  if (rgb && !/^#?[0-9a-f]{8}$/i.test(s)) return toHex(rgb);
  return NAMED[s.toLowerCase()] || null;
}

export function fromGhostty(text, name) {
  const palette = Array(16).fill(null);
  const v = {};
  let lines = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) return { ok: false, error: `This is not a Ghostty theme file: "${line.slice(0, 40)}" is not key = value.` };
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    lines++;
    if (key === 'palette') {
      const m = /^(\d+)\s*=\s*(.+)$/.exec(val);
      if (!m) return { ok: false, error: `This Ghostty theme has a palette line Ravenry cannot read: "${val}".` };
      const n = Number(m[1]);
      const c = ghosttyColour(m[2]);
      if (!c) return { ok: false, error: `This Ghostty theme has a colour Ravenry cannot read: "${m[2]}".` };
      if (n < 16) palette[n] = c;
    } else if (['background', 'foreground', 'cursor-color', 'cursor-text', 'selection-background', 'selection-foreground'].includes(key)) {
      const c = ghosttyColour(val);
      // Ghostty's own values ("cell-foreground") are left to the defaults.
      if (c) v[key] = c;
    }
  }
  if (!lines) return { ok: false, error: 'This file is empty: a Ghostty theme has key = value lines.' };
  if (!v.background || !v.foreground) return { ok: false, error: 'This Ghostty theme has no background or foreground.' };
  const missing = palette.findIndex((c) => !c);
  if (missing >= 0) return { ok: false, error: `This Ghostty theme has no palette = ${missing}.` };
  const theme = buildTheme(palette, v.background, v.foreground, {
    cursor: v['cursor-color'] || null, cursorAccent: v['cursor-text'] || null,
    selectionBackground: v['selection-background'] || null, selectionForeground: v['selection-foreground'] || null,
  });
  return done({ name, appearance: appearanceOf(v.background), theme });
}

// ------------------------------------------------------------------- shared

function buildTheme(palette, background, foreground, o) {
  const light = appearanceOf(background) === 'light';
  const t = {
    background, foreground,
    cursor: o.cursor || foreground,
    cursorAccent: o.cursorAccent || background,
    selectionBackground: o.selectionBackground || (light ? 'rgba(0, 0, 0, 0.15)' : 'rgba(255, 255, 255, 0.20)'),
    scrollbarSliderBackground: light ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.10)',
    scrollbarSliderHoverBackground: light ? 'rgba(0, 0, 0, 0.20)' : 'rgba(255, 255, 255, 0.18)',
    scrollbarSliderActiveBackground: light ? 'rgba(0, 0, 0, 0.28)' : 'rgba(255, 255, 255, 0.24)',
  };
  if (o.selectionForeground) t.selectionForeground = o.selectionForeground;
  ANSI_KEYS.forEach((k, n) => { t[k] = palette[n]; });
  return t;
}

function done(f) {
  return isThemeFile(f) ? { ok: true, theme: f } : { ok: false, error: 'The theme has a colour Ravenry cannot use.' };
}
