#!/usr/bin/env python3
# Makes the fallback fonts of ravenryd's pictures (internal/render/fonts):
# what Go Mono has no glyph for, so a picture of a pane shows what the live
# pane shows (Claude Code's ⏺ and ⎿, Codex's ▸, ⏎, ✓, arrows, maths,
# symbols, emoji) instead of hollow boxes.
#
# Sources, in order (the first that has a character draws it), all under
# the SIL Open Font License 1.1 (internal/render/fonts/OFL.txt): Noto Sans
# Mono, Noto Sans Symbols 2, Noto Sans Math, Noto Sans Symbols (the four
# the phone's glyph font is made from, checked against the same SHA-256)
# and Noto Emoji (monochrome outlines, at weight 400). Each keeps only the
# characters Go Mono and the fonts before it lack; box drawing, block
# elements and braille stay drawn by the renderer. The renderer fits each
# glyph to its cell, so the fonts keep their own shapes.
#
#   pip install fonttools
#   python3 tools/fallback-fonts.py <folder with the five .ttf files>
#
# The files: https://github.com/notofonts/notofonts.github.io (fonts/<family>
# /hinted/ttf/<file>) and https://github.com/google/fonts (ofl/notoemoji/
# NotoEmoji[wght].ttf, saved as NotoEmoji.ttf).
import base64, hashlib, os, subprocess, sys
from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.varLib import instancer

SOURCES = [
    ('NotoSansMono-Regular.ttf', 'ZbXissSh-6mui-HwJss1sD3LiIbZsqQUcFT94S9-dn0'),
    ('NotoSansSymbols2-Regular.ttf', 'xKCoDwBBzkvoHiR4-q0id20j7bmK4_DRm9NwRIIOz50'),
    ('NotoSansMath-Regular.ttf', '1Rr9VznHumxE_Ks1qIFg4l37aaLUrQvZlTP42JSvH5Y'),
    ('NotoSansSymbols-Regular.ttf', '0OmOmiwEZZTFAhQ3JzlDvn554P2YD94SUnniIwIhJZU'),
    ('NotoEmoji.ttf', '3mwYgyk4r8mcrxMrOdajChm6x_LoEuKNslNbRgjSdVE'),
]
# Drawn by the renderer itself (glyphs.go), never from a font.
PROCEDURAL = [(0x2500, 0x259F), (0x2800, 0x28FF)]
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'internal', 'render', 'fonts')

def b64sha(path):
    return base64.urlsafe_b64encode(hashlib.sha256(open(path, 'rb').read()).digest()).decode().rstrip('=')

def go_mono():
    root = subprocess.check_output(['go', 'list', '-m', '-f', '{{.Dir}}', 'golang.org/x/image'], cwd=os.path.join(HERE, '..'), text=True).strip()
    return set(TTFont(os.path.join(root, 'font', 'gofont', 'ttfs', 'Go-Mono.ttf')).getBestCmap())

def main(folder):
    taken = go_mono()
    taken.update(c for a, b in PROCEDURAL for c in range(a, b + 1))
    os.makedirs(OUT, exist_ok=True)
    total = 0
    for i, (f, h) in enumerate(SOURCES):
        p = os.path.join(folder, f)
        if not os.path.exists(p) or b64sha(p) != h:
            sys.exit(f'{p} is missing or not the file these fonts are made from')
        font = TTFont(p)
        if 'fvar' in font:
            font = instancer.instantiateVariableFont(font, {'wght': 400})
        mine = sorted(c for c in font.getBestCmap() if c not in taken and c > 0x20)
        taken.update(mine)
        opts = subset.Options()
        opts.layout_features = []
        opts.hinting = False
        opts.notdef_outline = False
        opts.name_IDs = [0, 1, 2, 13, 14]
        sub = subset.Subsetter(opts)
        sub.populate(unicodes=mine)
        sub.subset(font)
        out = os.path.join(OUT, f'{i + 1}-' + f.replace('-Regular', ''))
        font.save(out)
        total += len(mine)
        print(f'{os.path.basename(out)}: {len(mine)} characters, {os.path.getsize(out) // 1024} KB')
    print(f'{total} characters past Go Mono')

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '.')
