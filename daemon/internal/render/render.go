// Package render draws a picture of a terminal screen (a vt.Grid): a PNG
// of a pane, and the frames of a filmstrip as an animated GIF or APNG.
// It reads only the grid, never libghostty: package vt resolves every
// colour, and this package lays out cells and draws glyphs.
package render

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"time"
	"unicode/utf8"

	"ravenryd/internal/vt"
)

// Options says how a grid is drawn.
type Options struct {
	// FontSize is in points at 72 dpi, so in pixels; 0 means 14. It is
	// kept between 4 and 96.
	FontSize float64
	// Cursor draws the cursor when the grid's cursor is visible.
	Cursor bool
	// Padding is the margin around the grid in pixels; 0 means 8, and a
	// negative value means none.
	Padding int
	// Theme draws it in a window's colours, as that window shows the pane
	// live: its default colours and cursor where the program set none, and
	// its 16 palette colours for entries the program did not change. Nil:
	// the screen's own.
	Theme *Theme
}

// Theme is a window's terminal colours.
type Theme struct {
	Fg, Bg vt.RGB
	// Cursor: nil means Fg.
	Cursor *vt.RGB
	// Palette: 0 or 16 colours.
	Palette []vt.RGB
}

// colours gives a cell's colours: the grid's, or the theme's where the
// program set none.
func (o Options) colours(g *vt.Grid, c vt.Cell, defFg, defBg color.RGBA) (fg, bg color.RGBA) {
	fg, bg = defFg, defBg
	if c.HasFg {
		fg = rgba(c.Fg)
		if t := o.Theme; t != nil && len(t.Palette) == 16 && c.FgIndex >= 0 && c.FgIndex < 16 && !g.PaletteSet[c.FgIndex] {
			fg = rgba(t.Palette[c.FgIndex])
		}
	}
	if c.HasBg {
		bg = rgba(c.Bg)
		if t := o.Theme; t != nil && len(t.Palette) == 16 && c.BgIndex >= 0 && c.BgIndex < 16 && !g.PaletteSet[c.BgIndex] {
			bg = rgba(t.Palette[c.BgIndex])
		}
	}
	return fg, bg
}

// defaults gives a grid's default colours and cursor colour in o's theme.
func (o Options) defaults(g *vt.Grid) (fg, bg, cursor color.RGBA) {
	fg, bg = rgba(g.Fg), rgba(g.Bg)
	if t := o.Theme; t != nil {
		if !g.FgSet {
			fg = rgba(t.Fg)
		}
		if !g.BgSet {
			bg = rgba(t.Bg)
		}
	}
	cursor = fg
	if g.CursorColor != nil {
		cursor = rgba(*g.CursorColor)
	} else if t := o.Theme; t != nil && t.Cursor != nil {
		cursor = rgba(*t.Cursor)
	}
	return fg, bg, cursor
}

// Frame is one picture of a filmstrip and how long it shows.
type Frame struct {
	Grid  *vt.Grid
	Delay time.Duration
}

func padding(o Options) int {
	switch {
	case o.Padding < 0:
		return 0
	case o.Padding == 0:
		return 8
	}
	return o.Padding
}

func rgba(c vt.RGB) color.RGBA { return color.RGBA{c.R, c.G, c.B, 255} }

// Image draws a grid. A nil grid, or fonts that cannot load, give a 1x1
// image.
func Image(g *vt.Grid, o Options) *image.RGBA {
	fs, err := facesFor(o)
	if g == nil || err != nil {
		return image.NewRGBA(image.Rect(0, 0, 1, 1))
	}
	pad := padding(o)
	cw, ch := fs.cellW, fs.cellH
	img := image.NewRGBA(image.Rect(0, 0, g.Cols*cw+2*pad, g.Rows*ch+2*pad))
	defFg, defBg, curC := o.defaults(g)
	draw.Draw(img, img.Bounds(), image.NewUniform(defBg), image.Point{}, draw.Src)
	fs.mu.Lock()
	defer fs.mu.Unlock()
	for y := 0; y < g.Rows && y < len(g.Cells); y++ {
		row := g.Cells[y]
		for x := 0; x < g.Cols && x < len(row); x++ {
			c := row[x]
			if c.Spacer {
				continue
			}
			span := 1
			if c.Wide {
				span = 2
			}
			r := image.Rect(pad+x*cw, pad+y*ch, pad+(x+span)*cw, pad+(y+1)*ch).Intersect(img.Bounds())
			fg, bg := o.colours(g, c, defFg, defBg)
			if c.Inverse {
				fg, bg = bg, fg
			}
			cursorHere := o.Cursor && g.Cursor.Visible && g.Cursor.X == x && g.Cursor.Y == y
			if cursorHere && (g.CursorStyle == "block" || g.CursorStyle == "") {
				fg, bg = bg, curC
			}
			if c.Faint {
				fg = blend(fg, bg, 0.5)
			}
			p := cellPainter{img: img, r: r, fg: fg, bg: bg}
			if bg != defBg {
				p.fill(0, 0, r.Dx(), r.Dy(), bg)
			}
			if !c.Invisible && c.Text != "" && c.Text != " " {
				p.glyph(fs, c)
			}
			if c.Underline {
				th := max(1, ch/14)
				p.fill(0, min(fs.ascent+1, ch-th), r.Dx(), min(fs.ascent+1, ch-th)+th, fg)
			}
			if c.Strike {
				th := max(1, ch/14)
				y := fs.ascent - fs.ascent*3/10
				p.fill(0, y, r.Dx(), y+th, fg)
			}
		}
	}
	if o.Cursor && g.Cursor.Visible && g.Cursor.Y >= 0 && g.Cursor.Y < g.Rows && g.Cursor.X >= 0 && g.Cursor.X < g.Cols {
		drawCursor(img, g, fs, pad, curC)
	}
	return img
}

// drawCursor draws the bar, underline and hollow cursors (a block is drawn
// with its cell).
func drawCursor(img *image.RGBA, g *vt.Grid, fs *faceSet, pad int, cc color.RGBA) {
	cw, ch := fs.cellW, fs.cellH
	x, y := g.Cursor.X, g.Cursor.Y
	span := 1
	if y < len(g.Cells) && x < len(g.Cells[y]) && g.Cells[y][x].Wide {
		span = 2
	}
	r := image.Rect(pad+x*cw, pad+y*ch, pad+(x+span)*cw, pad+(y+1)*ch)
	p := cellPainter{img: img, r: r, fg: cc}
	th := max(1, cw/6)
	switch g.CursorStyle {
	case "bar":
		p.fill(0, 0, th, ch, cc)
	case "underline":
		p.fill(0, ch-th, r.Dx(), ch, cc)
	case "block_hollow":
		p.fill(0, 0, r.Dx(), 1, cc)
		p.fill(0, ch-1, r.Dx(), ch, cc)
		p.fill(0, 0, 1, ch, cc)
		p.fill(r.Dx()-1, 0, r.Dx(), ch, cc)
	}
}

// glyph draws a cell's text: procedurally for lines, blocks and braille,
// from the matching Go Mono face, else from the first fallback font that
// has it, fitted to its cells, or as a hollow box when none has it.
func (p cellPainter) glyph(fs *faceSet, c vt.Cell) {
	r, _ := utf8.DecodeRuneInString(c.Text)
	if procedural(r) && utf8.RuneCountInString(c.Text) == 1 {
		if p.drawProcedural(r) {
			return
		}
	}
	span := (p.r.Dx() + fs.cellW - 1) / fs.cellW
	var m *image.Alpha
	if fs.has(r) {
		face := 0
		if c.Bold {
			face |= 1
		}
		if c.Italic {
			face |= 2
		}
		m = fs.mask(face, span, c.Text)
	} else if f := fs.fallbackFor(r); f != nil {
		m = fs.fallbackMask(f, span, c.Text)
	} else {
		p.hollow()
		return
	}
	// Each pixel moves from what the cell shows towards the foreground by
	// the glyph's coverage.
	fr, fgc, fb := int(p.fg.R), int(p.fg.G), int(p.fg.B)
	for y := 0; y < p.r.Dy() && y < m.Rect.Dy(); y++ {
		mrow := m.Pix[y*m.Stride:]
		i := p.img.PixOffset(p.r.Min.X, p.r.Min.Y+y)
		for x := 0; x < p.r.Dx() && x < m.Rect.Dx(); x++ {
			if a := int(mrow[x]); a == 255 {
				p.img.Pix[i], p.img.Pix[i+1], p.img.Pix[i+2] = p.fg.R, p.fg.G, p.fg.B
			} else if a > 0 {
				px := p.img.Pix[i : i+3 : i+3]
				px[0] = uint8(int(px[0]) + (fr-int(px[0]))*a/255)
				px[1] = uint8(int(px[1]) + (fgc-int(px[1]))*a/255)
				px[2] = uint8(int(px[2]) + (fb-int(px[2]))*a/255)
			}
			i += 4
		}
	}
}

// PNG draws a grid as a PNG.
func PNG(g *vt.Grid, o Options) ([]byte, error) {
	var b bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&b, Image(g, o)); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

// frameImages draws every frame on a canvas of the largest frame's size
// (a pane may have been resized between frames), the rest of it in that
// frame's background.
func frameImages(frames []Frame, o Options) []*image.RGBA {
	imgs := make([]*image.RGBA, len(frames))
	var size image.Point
	for i, f := range frames {
		imgs[i] = Image(f.Grid, o)
		size.X = max(size.X, imgs[i].Bounds().Dx())
		size.Y = max(size.Y, imgs[i].Bounds().Dy())
	}
	for i, img := range imgs {
		if img.Bounds().Size() == size {
			continue
		}
		bg := color.RGBA{0, 0, 0, 255}
		if frames[i].Grid != nil {
			bg = rgba(frames[i].Grid.Bg)
		}
		c := image.NewRGBA(image.Rectangle{Max: size})
		draw.Draw(c, c.Bounds(), image.NewUniform(bg), image.Point{}, draw.Src)
		draw.Draw(c, img.Bounds(), img, image.Point{}, draw.Src)
		imgs[i] = c
	}
	return imgs
}
