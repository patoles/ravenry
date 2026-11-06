#!/usr/bin/env python3
# Makes the phone terminal's glyph font, src/glyphs.css: "Ravenry Glyphs",
# the symbols coding agents print (Claude Code's bullets and spinner, Codex's
# braille spinner, check marks, warnings, stars, arrows, box and block
# characters) drawn as text, each one cell wide.
#
# Why: Android has no text font for many of them, so a WebView falls back
# to the colour emoji font and Claude's "⏺" becomes an orange box. The
# terminal's font stack puts this font ahead of the system fallback.
#
# The class: every character of the ranges below that Unicode does not show
# as an emoji by default (emoji-data.txt, Emoji_Presentation=No). Characters
# that are emoji by default (✅ ❌ ⭐ ⚡ ...) stay emoji: an agent that prints
# them means the emoji.
#
# Sources, in order (the first that has a character draws it), all under
# the SIL Open Font License 1.1 (NOTICE): Noto Sans Mono, Noto Sans Symbols
# 2, Noto Sans Math, Noto Sans Symbols. Every glyph is made one terminal
# cell wide (600 of 1000 units, Noto Sans Mono's advance): narrower ones are
# centred, wider ones scaled down.
#
#   pip install fonttools brotli
#   python3 tools/glyph-font.py <folder with the four .ttf and emoji-data.txt>
#
# It checks each file against the SHA-256 below (base64url) before use.
import base64, hashlib, os, sys
from fontTools.ttLib import TTFont
from fontTools import subset

SOURCES = [
    ('NotoSansMono-Regular.ttf', 'ZbXissSh-6mui-HwJss1sD3LiIbZsqQUcFT94S9-dn0'),
    ('NotoSansSymbols2-Regular.ttf', 'xKCoDwBBzkvoHiR4-q0id20j7bmK4_DRm9NwRIIOz50'),
    ('NotoSansMath-Regular.ttf', '1Rr9VznHumxE_Ks1qIFg4l37aaLUrQvZlTP42JSvH5Y'),
    ('NotoSansSymbols-Regular.ttf', '0OmOmiwEZZTFAhQ3JzlDvn554P2YD94SUnniIwIhJZU'),
]
EMOJI_DATA = ('emoji-data.txt', '8TZaUXPu4Y4fmLJAzcSS6Eol8c5-DJ0QlOspxBoiaWo')  # Unicode 16.0
URL = 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/{}/hinted/ttf/{}'
RANGES = [
    (0x00B7, 0x00B7), (0x2022, 0x2022), (0x2026, 0x2026),
    (0x2190, 0x21FF),  # arrows
    (0x2300, 0x23FF),  # miscellaneous technical: ⏺ ⏵ ⎿ ⏸
    (0x2500, 0x257F),  # box drawing
    (0x2580, 0x259F),  # block elements
    (0x25A0, 0x25FF),  # geometric shapes
    (0x2600, 0x26FF),  # miscellaneous symbols: ★ ⚠
    (0x2700, 0x27BF),  # dingbats: ✓ ✗ ✢ ✳ ✶ ✻ ✽
    (0x27F0, 0x27FF), (0x2900, 0x297F), (0x2B00, 0x2BFF),  # more arrows
    (0x2800, 0x28FF),  # braille: Codex's spinner
]
CELL = 600

def b64sha(path):
    return base64.urlsafe_b64encode(hashlib.sha256(open(path, 'rb').read()).digest()).decode().rstrip('=')

def emoji_presentation(path):
    out = set()
    for line in open(path, encoding='utf-8'):
        line = line.split('#')[0].strip()
        if not line or 'Emoji_Presentation' not in line:
            continue
        cps = line.split(';')[0].strip()
        a, _, b = cps.partition('..')
        for c in range(int(a, 16), int(b or a, 16) + 1):
            out.add(c)
    return out

def one_cell(font):
    glyf, hmtx = font['glyf'], font['hmtx']
    for name in font.getGlyphOrder():
        if name == '.notdef':
            continue
        g = glyf[name]
        adv, lsb = hmtx[name]
        if g.isComposite():
            # Rare in these fonts: kept as drawn, at one cell's advance.
            hmtx[name] = (CELL, lsb)
            continue
        if adv > CELL and g.numberOfContours > 0:
            s = CELL / adv
            g.coordinates.scale((s, s))
            g.recalcBounds(glyf)
            adv = CELL
        if g.numberOfContours > 0:
            g.recalcBounds(glyf)
            w = g.xMax - g.xMin
            shift = round((CELL - w) / 2 - g.xMin)
            g.coordinates.translate((shift, 0))
            g.recalcBounds(glyf)
            hmtx[name] = (CELL, g.xMin)
        else:
            hmtx[name] = (CELL, 0)

def main(folder):
    for f, h in SOURCES + [EMOJI_DATA]:
        p = os.path.join(folder, f)
        if not os.path.exists(p):
            sys.exit(f'missing {p}: download {URL.format(f.split("-")[0], f) if f.endswith(".ttf") else "https://www.unicode.org/Public/16.0.0/ucd/emoji/emoji-data.txt"}')
        if b64sha(p) != h:
            sys.exit(f'{f} is not the file this font was made from')
    emoji = emoji_presentation(os.path.join(folder, EMOJI_DATA[0]))
    want = [c for a, b in RANGES for c in range(a, b + 1) if c not in emoji]
    faces, taken = [], set()
    for f, _ in SOURCES:
        font = TTFont(os.path.join(folder, f))
        cmap = font.getBestCmap()
        mine = [c for c in want if c in cmap and c not in taken]
        if not mine:
            continue
        taken.update(mine)
        opts = subset.Options()
        opts.flavor = 'woff2'
        opts.layout_features = []
        opts.hinting = False
        opts.notdef_outline = False
        opts.name_IDs = [0, 1, 2, 13, 14]
        sub = subset.Subsetter(opts)
        sub.populate(unicodes=mine)
        sub.subset(font)
        if f != 'NotoSansMono-Regular.ttf':
            one_cell(font)
        out = os.path.join(folder, 'glyphs-' + f.replace('-Regular.ttf', '.woff2'))
        font.flavor = 'woff2'
        font.save(out)
        faces.append((f, mine, out))
    missing = [c for c in want if c not in taken]
    css = ['/* Generated by tools/glyph-font.py: do not edit. "Ravenry Glyphs", the',
           '   symbols coding agents print, as text one terminal cell wide, from the',
           '   Noto fonts under the SIL Open Font License 1.1 (NOTICE). */']
    for f, mine, out in faces:
        data = base64.b64encode(open(out, 'rb').read()).decode()
        ranges = ','.join(f'U+{c:04X}' for c in mine)
        css.append(f"@font-face {{ font-family: 'Ravenry Glyphs'; src: url(data:font/woff2;base64,{data}) format('woff2'); unicode-range: {ranges}; font-display: block; }}")
    dest = os.path.join(os.path.dirname(__file__), '..', 'src', 'glyphs.css')
    open(dest, 'w').write('\n'.join(css) + '\n')
    print(f'{len(taken)} characters in {len(faces)} faces, {len(missing)} of the class in no source font; wrote src/glyphs.css ({os.path.getsize(dest) // 1024} KB)')
    if missing:
        print('not drawn:', ''.join(chr(c) for c in missing))

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '.')
