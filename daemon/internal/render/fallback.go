package render

import (
	"embed"
	"image"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"

	"golang.org/x/image/font"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/font/sfnt"
	"golang.org/x/image/math/fixed"
)

// The fallback fonts: what Go Mono has no glyph for, so a picture shows
// what the live pane shows instead of a hollow box. First the fonts
// embedded here (subsets of Noto Sans Mono, Noto Sans Symbols 2, Noto Sans
// Math, Noto Sans Symbols and Noto Emoji, made by tools/fallback-fonts.py,
// under the SIL Open Font License 1.1, fonts/OFL.txt), then the system's
// own fonts for the rest (CJK and other scripts), read the first time a
// character is in none of them. Each fallback glyph is fitted to its cells
// (scaled down when wider or taller, centred), so the cell size never
// changes.

//go:embed fonts/*.ttf
var embeddedFonts embed.FS

var (
	fallbackOnce sync.Once
	fallbacks    []*sfnt.Font
	systemOnce   sync.Once
	systemFonts  []*sfnt.Font
)

func loadFallbacks() {
	fallbackOnce.Do(func() {
		names, _ := fs.Glob(embeddedFonts, "fonts/*.ttf")
		sort.Strings(names) // "1-...", "2-...": the order they are tried in
		for _, n := range names {
			b, err := embeddedFonts.ReadFile(n)
			if err != nil {
				continue
			}
			if f, err := opentype.Parse(b); err == nil {
				fallbacks = append(fallbacks, f)
			}
		}
	})
}

// systemFontFiles are the fonts of this machine that cover the most of
// what the embedded ones do not: CJK and other scripts.
func systemFontFiles() []string {
	var cands []string
	switch runtime.GOOS {
	case "darwin":
		cands = []string{
			"/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
			"/Library/Fonts/Arial Unicode.ttf",
			"/System/Library/Fonts/Apple Symbols.ttf",
			"/System/Library/Fonts/Hiragino Sans GB.ttc",
		}
	default:
		for _, dir := range []string{"/usr/share/fonts", "/usr/local/share/fonts"} {
			_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
				if err != nil || d.IsDir() {
					return nil
				}
				n := strings.ToLower(d.Name())
				if (strings.HasSuffix(n, ".ttf") || strings.HasSuffix(n, ".ttc") || strings.HasSuffix(n, ".otf")) &&
					(strings.Contains(n, "cjk") || strings.Contains(n, "droidsansfallback") || strings.Contains(n, "unifont") || strings.Contains(n, "wqy") || n == "dejavusans.ttf") {
					cands = append(cands, p)
				}
				return nil
			})
		}
	}
	return cands
}

func loadSystemFonts() {
	systemOnce.Do(func() {
		for _, p := range systemFontFiles() {
			b, err := os.ReadFile(p)
			if err != nil {
				continue
			}
			if c, err := opentype.ParseCollection(b); err == nil && c.NumFonts() > 0 {
				if f, err := c.Font(0); err == nil {
					systemFonts = append(systemFonts, f)
				}
				continue
			}
			if f, err := opentype.Parse(b); err == nil {
				systemFonts = append(systemFonts, f)
			}
		}
	})
}

// fallbackFor is the first fallback font with a glyph for r, or nil.
// fs.mu is held.
func (fs *faceSet) fallbackFor(r rune) *sfnt.Font {
	loadFallbacks()
	for _, f := range fallbacks {
		if i, err := f.GlyphIndex(&fs.buf, r); err == nil && i != 0 {
			return f
		}
	}
	loadSystemFonts()
	for _, f := range systemFonts {
		if i, err := f.GlyphIndex(&fs.buf, r); err == nil && i != 0 {
			return f
		}
	}
	return nil
}

// fallbackMask draws text in font f, fitted to a box span cells wide and
// one cell high: at the cell's size, scaled down when the glyph is wider
// or taller than the box, centred across it and on the cell's baseline
// when it fits. fs.mu is held.
func (fs *faceSet) fallbackMask(f *sfnt.Font, span int, text string) *image.Alpha {
	k := glyphKey{face: -1 - fontIndex(f), span: span, text: text}
	if m := fs.masks[k]; m != nil {
		return m
	}
	if len(fs.masks) >= maxMasks {
		clear(fs.masks)
	}
	w, h := span*fs.cellW, fs.cellH
	m := image.NewAlpha(image.Rect(0, 0, w, h))
	face, err := opentype.NewFace(f, &opentype.FaceOptions{Size: fs.size, DPI: 72, Hinting: font.HintingNone})
	if err == nil {
		b, adv := font.BoundString(face, text)
		gw := math.Max(float64(adv)/64, float64(b.Max.X-b.Min.X)/64)
		gh := float64(b.Max.Y-b.Min.Y) / 64
		scale := 1.0
		if gw > float64(w) {
			scale = float64(w) / gw
		}
		if gh*scale > float64(h) {
			scale = float64(h) / gh
		}
		if scale < 1 {
			face.Close()
			face, err = opentype.NewFace(f, &opentype.FaceOptions{Size: fs.size * scale * 0.97, DPI: 72, Hinting: font.HintingNone})
			if err == nil {
				b, adv = font.BoundString(face, text)
			}
		}
		if err == nil {
			defer face.Close()
			// Across: the ink centred in the box. Down: on the cell's
			// baseline, moved only as far as keeps the ink inside.
			inkW := (b.Max.X - b.Min.X)
			x := (fixed.I(w)-inkW)/2 - b.Min.X
			base := fixed.I(fs.ascent)
			if top := base + b.Min.Y; top < 0 {
				base -= top
			}
			if bottom := base + b.Max.Y; bottom > fixed.I(h) {
				base -= bottom - fixed.I(h)
			}
			_ = adv
			d := font.Drawer{Dst: m, Src: image.Opaque, Face: face, Dot: fixed.Point26_6{X: x, Y: base}}
			d.DrawString(text)
		}
	}
	fs.masks[k] = m
	return m
}

// fontIndex numbers a fallback font for the glyph cache.
func fontIndex(f *sfnt.Font) int {
	for i, x := range fallbacks {
		if x == f {
			return i
		}
	}
	for i, x := range systemFonts {
		if x == f {
			return len(fallbacks) + i
		}
	}
	return 999
}
