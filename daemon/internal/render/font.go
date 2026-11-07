package render

import (
	"image"
	"math"
	"sync"

	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gomono"
	"golang.org/x/image/font/gofont/gomonobold"
	"golang.org/x/image/font/gofont/gomonobolditalic"
	"golang.org/x/image/font/gofont/gomonoitalic"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/font/sfnt"
	"golang.org/x/image/math/fixed"
)

// The Go Mono fonts (golang.org/x/image/font/gofont, BSD-3-Clause, see
// NOTICE), in the four faces a terminal uses. They cover Latin, Greek and
// Cyrillic text and the usual symbols; box drawing, block elements and
// braille are drawn by glyphs.go instead, and a character none of them has
// (emoji, CJK) is drawn as a hollow box.

var (
	fontsOnce sync.Once
	fonts     [4]*sfnt.Font // regular, bold, italic, bold italic
	fontsErr  error
)

func loadFonts() error {
	fontsOnce.Do(func() {
		for i, ttf := range [][]byte{gomono.TTF, gomonobold.TTF, gomonoitalic.TTF, gomonobolditalic.TTF} {
			f, err := opentype.Parse(ttf)
			if err != nil {
				fontsErr = err
				return
			}
			fonts[i] = f
		}
	})
	return fontsErr
}

// faceSet is the four faces at one size, and the cell they make. A face is
// not safe for concurrent use, so drawing holds mu.
type faceSet struct {
	mu     sync.Mutex
	faces  [4]font.Face
	cellW  int
	cellH  int
	ascent int
	buf    sfnt.Buffer
	// masks caches each glyph drawn once, as coverage the size of its
	// cells (glyphKey), so a screen draws each character once.
	masks map[glyphKey]*image.Alpha
}

type glyphKey struct {
	face int
	span int
	text string
}

// maxMasks bounds the glyph cache of one size.
const maxMasks = 4096

// mask returns the coverage of text in face, drawn in a box span cells
// wide. fs.mu is held.
func (fs *faceSet) mask(face, span int, text string) *image.Alpha {
	k := glyphKey{face, span, text}
	if m := fs.masks[k]; m != nil {
		return m
	}
	if len(fs.masks) >= maxMasks {
		clear(fs.masks)
	}
	m := image.NewAlpha(image.Rect(0, 0, span*fs.cellW, fs.cellH))
	d := font.Drawer{Dst: m, Src: image.Opaque, Face: fs.faces[face], Dot: fixed.P(0, fs.ascent)}
	d.DrawString(text)
	fs.masks[k] = m
	return m
}

var (
	facesMu sync.Mutex
	faces   = map[float64]*faceSet{}
)

const (
	defaultFontSize = 14
	minFontSize     = 4
	maxFontSize     = 96
)

func fontSize(o Options) float64 {
	s := o.FontSize
	if s <= 0 || math.IsNaN(s) {
		return defaultFontSize
	}
	return math.Min(math.Max(s, minFontSize), maxFontSize)
}

// facesFor returns the faces at the options' size, made once per size.
func facesFor(o Options) (*faceSet, error) {
	if err := loadFonts(); err != nil {
		return nil, err
	}
	size := fontSize(o)
	facesMu.Lock()
	defer facesMu.Unlock()
	if fs := faces[size]; fs != nil {
		return fs, nil
	}
	fs := &faceSet{masks: map[glyphKey]*image.Alpha{}}
	for i, f := range fonts {
		face, err := opentype.NewFace(f, &opentype.FaceOptions{Size: size, DPI: 72, Hinting: font.HintingFull})
		if err != nil {
			return nil, err
		}
		fs.faces[i] = face
	}
	m := fs.faces[0].Metrics()
	adv, _ := fs.faces[0].GlyphAdvance('M')
	fs.cellW = max(1, int(math.Round(float64(adv)/64)))
	fs.ascent = m.Ascent.Ceil()
	fs.cellH = max(1, fs.ascent+m.Descent.Ceil())
	faces[size] = fs
	return fs, nil
}

// has reports whether the regular face has a glyph for r. fs.mu is held.
func (fs *faceSet) has(r rune) bool {
	i, err := fonts[0].GlyphIndex(&fs.buf, r)
	return err == nil && i != 0
}

// CellSize is the size of one cell in pixels at the options' font size.
func CellSize(o Options) (w, h int) {
	fs, err := facesFor(o)
	if err != nil {
		return 0, 0
	}
	return fs.cellW, fs.cellH
}
