package render

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/draw"
	"image/gif"
	"image/png"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/vt"
)

var (
	bg  = rgbOf(0x1d, 0x1f, 0x21)
	fg  = rgbOf(0xc5, 0xc8, 0xc6)
	red = rgbOf(0xcc, 0x33, 0x33)
)

// grid makes a grid from rows of text, one rune per cell.
func rgbOf(r, g, b uint8) vt.RGB { return vt.RGB{R: r, G: g, B: b} }

func grid(rows ...string) *vt.Grid {
	cols := 0
	for _, r := range rows {
		cols = max(cols, len([]rune(r)))
	}
	g := &vt.Grid{Cols: cols, Rows: len(rows), Fg: fg, Bg: bg, CursorStyle: "block"}
	for _, r := range rows {
		row := make([]vt.Cell, cols)
		for i, ch := range []rune(r) {
			if ch != ' ' {
				row[i].Text = string(ch)
			}
		}
		g.Cells = append(g.Cells, row)
	}
	return g
}

func at(img *image.RGBA, x, y int) vt.RGB {
	c := img.RGBAAt(x, y)
	return rgbOf(c.R, c.G, c.B)
}

// cellPx is the centre of cell (x, y) and the cell size.
func cellPx(o Options, x, y int) (int, int, int, int) {
	cw, ch := CellSize(o)
	pad := padding(o)
	return pad + x*cw + cw/2, pad + y*ch + ch/2, cw, ch
}

func TestSizeAndBackground(t *testing.T) {
	o := Options{}
	cw, ch := CellSize(o)
	if cw < 6 || ch < 12 || cw >= ch {
		t.Fatalf("cell %dx%d at 14 px", cw, ch)
	}
	img := Image(grid("ab", "cd", "ef"), o)
	if got := img.Bounds().Size(); got != image.Pt(2*cw+16, 3*ch+16) {
		t.Fatalf("image %v, cell %dx%d", got, cw, ch)
	}
	if at(img, 1, 1) != bg {
		t.Fatalf("padding = %v", at(img, 1, 1))
	}
	if w, _ := CellSize(Options{FontSize: 28}); w < 2*cw-2 || w > 2*cw+2 {
		t.Fatalf("28 px cell width %d against 14 px %d", w, cw)
	}
}

func TestColoursInverseFaint(t *testing.T) {
	g := grid("    ")
	g.Cells[0][0] = vt.Cell{Text: "█", Fg: red, HasFg: true}
	g.Cells[0][1] = vt.Cell{Bg: red, HasBg: true}
	g.Cells[0][2] = vt.Cell{Inverse: true}
	g.Cells[0][3] = vt.Cell{Text: "█", Faint: true}
	o := Options{}
	img := Image(g, o)
	x, y, _, _ := cellPx(o, 0, 0)
	if at(img, x, y) != red {
		t.Errorf("full block in red = %v", at(img, x, y))
	}
	x, y, _, _ = cellPx(o, 1, 0)
	if at(img, x, y) != red {
		t.Errorf("red background = %v", at(img, x, y))
	}
	x, y, _, _ = cellPx(o, 2, 0)
	if at(img, x, y) != fg {
		t.Errorf("inverse blank = %v, want the foreground", at(img, x, y))
	}
	x, y, _, _ = cellPx(o, 3, 0)
	want := rgbOf(uint8((int(fg.R)+int(bg.R)+1)/2), uint8((int(fg.G)+int(bg.G)+1)/2), uint8((int(fg.B)+int(bg.B)+1)/2))
	if got := at(img, x, y); got != want {
		t.Errorf("faint block = %v, want %v", got, want)
	}
}

func TestBoxDrawingJoins(t *testing.T) {
	g := grid("┌──┐", "│  │", "└──┘", "╔═╗ ", "╚═╝ ")
	o := Options{}
	img := Image(g, o)
	cw, ch := CellSize(o)
	pad := padding(o)
	// The top border is one unbroken line across its cells at the centre row.
	y := pad + ch/2
	for x := pad + cw/2; x < pad+3*cw+cw/2; x++ {
		if at(img, x, y) != fg {
			t.Fatalf("top border broken at x=%d (%v)", x, at(img, x, y))
		}
	}
	// The left side is one unbroken line down its three rows.
	x := pad + cw/2
	for y := pad + ch/2; y < pad+2*ch+ch/2; y++ {
		if at(img, x, y) != fg {
			t.Fatalf("left border broken at y=%d (%v)", y, at(img, x, y))
		}
	}
	// Inside the box is background.
	cx, cy, _, _ := cellPx(o, 1, 1)
	if at(img, cx, cy) != bg {
		t.Fatalf("inside the box = %v", at(img, cx, cy))
	}
	// A double line has two strokes and background between them.
	cx, cy, _, _ = cellPx(o, 1, 3)
	if at(img, cx, cy) != bg {
		t.Errorf("between the strokes of ═ = %v", at(img, cx, cy))
	}
	gap := max(2, (3*thickness(cw)+1)/2)
	if at(img, cx, cy-gap) != fg || at(img, cx, cy+gap) != fg {
		t.Errorf("strokes of ═ missing: %v %v", at(img, cx, cy-gap), at(img, cx, cy+gap))
	}
}

func TestBrailleAndBlocks(t *testing.T) {
	g := grid("⠁⢀▀▄░ ")
	o := Options{}
	img := Image(g, o)
	cw, ch := CellSize(o)
	pad := padding(o)
	// ⠁ is the top-left dot only; ⢀ the bottom-right only.
	if at(img, pad+cw/4, pad+ch/8) != fg || at(img, pad+3*cw/4, pad+7*ch/8) != bg {
		t.Errorf("⠁ dots wrong")
	}
	if at(img, pad+cw+3*cw/4, pad+7*ch/8) != fg || at(img, pad+cw+cw/4, pad+ch/8) != bg {
		t.Errorf("⢀ dots wrong")
	}
	if at(img, pad+2*cw+cw/2, pad+ch/4) != fg || at(img, pad+2*cw+cw/2, pad+3*ch/4) != bg {
		t.Errorf("▀ wrong")
	}
	if at(img, pad+3*cw+cw/2, pad+ch/4) != bg || at(img, pad+3*cw+cw/2, pad+3*ch/4) != fg {
		t.Errorf("▄ wrong")
	}
	if c := at(img, pad+4*cw+cw/2, pad+ch/2); c == fg || c == bg {
		t.Errorf("░ is a solid colour: %v", c)
	}
}

func TestWideMissingAndCursor(t *testing.T) {
	g := grid("    x")
	g.Cells[0][0] = vt.Cell{Text: "界", Wide: true}
	g.Cells[0][1] = vt.Cell{Spacer: true}
	g.Cells[0][2] = vt.Cell{Text: "a", Invisible: true}
	g.Cursor = vt.Cursor{X: 4, Y: 0, Visible: true}
	o := Options{Cursor: true}
	img := Image(g, o)
	cw, ch := CellSize(o)
	pad := padding(o)
	// No Go Mono glyph for 界: a hollow box two cells wide, its left side
	// in the first cell and its right side in the second.
	if at(img, pad+1, pad+ch/2) != fg || at(img, pad+2*cw-2, pad+ch/2) != fg {
		t.Errorf("hollow box for a wide character missing")
	}
	// Invisible text draws nothing.
	for y := pad; y < pad+ch; y++ {
		for x := pad + 2*cw; x < pad+3*cw; x++ {
			if at(img, x, y) != bg {
				t.Fatalf("invisible text drew at %d,%d", x, y)
			}
		}
	}
	// The block cursor fills its cell in the foreground, and the x on it is
	// drawn in the background colour.
	if at(img, pad+4*cw+1, pad+1) != fg {
		t.Errorf("block cursor missing: %v", at(img, pad+4*cw+1, pad+1))
	}
	sawBg := false
	for y := pad; y < pad+ch; y++ {
		for x := pad + 4*cw; x < pad+5*cw; x++ {
			if at(img, x, y) == bg {
				sawBg = true
			}
		}
	}
	if !sawBg {
		t.Errorf("the x under the cursor is not drawn")
	}
	// Without the option, no cursor.
	if at(Image(g, Options{}), pad+4*cw+1, pad+1) != bg {
		t.Errorf("cursor drawn without Cursor")
	}
}

func TestPNGDecodes(t *testing.T) {
	g := sample()
	b, err := PNG(g, Options{Cursor: true})
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	cw, ch := CellSize(Options{})
	if img.Bounds().Dx() != g.Cols*cw+16 || img.Bounds().Dy() != g.Rows*ch+16 {
		t.Fatalf("PNG %v", img.Bounds())
	}
	// RAVENRY_RENDER_SAMPLE=FILE.png writes the sample, to look at; with
	// RAVENRY_RENDER_SAMPLE_SIZE at that font size.
	if p := os.Getenv("RAVENRY_RENDER_SAMPLE"); p != "" {
		size, _ := strconv.ParseFloat(os.Getenv("RAVENRY_RENDER_SAMPLE_SIZE"), 64)
		if b, err = PNG(g, Options{Cursor: true, FontSize: size}); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// sample is a small TUI: a rounded box with a title, a menu with a
// selected row, colours, a braille spinner and a status line.
func sample() *vt.Grid {
	rows := []string{
		"╭─ Ravenry ───────────────────────╮",
		"│ ⠋ Working on the filmstrip       │",
		"│                                  │",
		"│  > Run the tests                 │",
		"│    Open the picture              │",
		"│    Cancel                        │",
		"╰──────────────────────────────────╯",
		"┌────┬────┐ ╔══╦══╗ ▁▂▃▄▅▆▇█ ░▒▓   ",
		"│ ok │ 12 │ ║  ║  ║ ▏▎▍▌▋▊▉█ ▖▗▘▝▞▚ ",
		"└────┴────┘ ╚══╩══╝ é ç ß Ω ж 界 👍 ",
		"$ ravenry shot p1a2b3c -o pane.png  ",
	}
	g := grid(rows...)
	green := rgbOf(0x8c, 0xc8, 0x5f)
	blue := rgbOf(0x2a, 0x5d, 0x9c)
	for x := 0; x < g.Cols; x++ {
		if g.Cells[0][x].Text != "" {
			g.Cells[0][x].Fg, g.Cells[0][x].HasFg = rgbOf(0x81, 0xa2, 0xbe), true
		}
	}
	for x := 3; x < 9; x++ {
		g.Cells[0][x].Bold = true
	}
	g.Cells[1][2].Fg, g.Cells[1][2].HasFg = rgbOf(0xf0, 0xc6, 0x74), true
	for x := 1; x < 35; x++ {
		g.Cells[3][x].Bg, g.Cells[3][x].HasBg = blue, true
		g.Cells[3][x].Bold = true
	}
	for x := 4; x < 13; x++ {
		g.Cells[5][x].Faint = true
	}
	for x := 2; x < 4; x++ {
		g.Cells[8][x].Fg, g.Cells[8][x].HasFg = green, true
	}
	for x := 4; x < 20; x++ {
		g.Cells[1][x].Italic = true
	}
	// 界 and 👍 are wide: each takes its cell and the next.
	r := g.Cells[9]
	for x, c := range r {
		if c.Text == "界" || c.Text == "👍" {
			r[x].Wide = true
			copy(r[x+2:], r[x+1:len(r)-1])
			r[x+1] = vt.Cell{Spacer: true}
		}
	}
	g.Cells[10][0].Fg, g.Cells[10][0].HasFg = green, true
	for x := 2; x < 9; x++ {
		g.Cells[10][x].Underline = true
	}
	g.Cursor = vt.Cursor{X: 35, Y: 10, Visible: true}
	return g
}

func frames(n int) []Frame {
	var out []Frame
	spin := []rune("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")
	for i := 0; i < n; i++ {
		g := grid("x Working")
		g.Cells[0][0].Text = string(spin[i%len(spin)])
		out = append(out, Frame{Grid: g, Delay: time.Duration(40+i*10) * time.Millisecond})
	}
	return out
}

func TestGIF(t *testing.T) {
	b, err := GIF(frames(4), Options{})
	if err != nil {
		t.Fatal(err)
	}
	g, err := gif.DecodeAll(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Image) != 4 || g.LoopCount != 0 {
		t.Fatalf("%d frames, loop %d", len(g.Image), g.LoopCount)
	}
	for i, d := range g.Delay {
		if want := 4 + i; d != want {
			t.Errorf("frame %d delay %d, want %d", i, d, want)
		}
	}
	if gifDelay(time.Millisecond) != 2 {
		t.Errorf("a 1 ms delay is %d, not the 2 a browser keeps", gifDelay(time.Millisecond))
	}
	// Frames of different sizes share the largest canvas, and each frame
	// after the first holds only what changed: drawn over the ones before,
	// they give every frame's picture.
	fs := frames(3)
	fs[1].Grid = grid("a much longer row", "and two")
	b, err = GIF(fs, Options{})
	if err != nil {
		t.Fatal(err)
	}
	g, _ = gif.DecodeAll(bytes.NewReader(b))
	imgs := frameImages(fs, Options{})
	if g.Config.Width != imgs[0].Bounds().Dx() || g.Config.Height != imgs[0].Bounds().Dy() {
		t.Fatalf("canvas %dx%d, want %v", g.Config.Width, g.Config.Height, imgs[0].Bounds())
	}
	canvas := image.NewRGBA(imgs[0].Bounds())
	for i, fr := range g.Image {
		draw.Draw(canvas, fr.Bounds(), fr, fr.Bounds().Min, draw.Src)
		if d := diffRect(canvas, imgs[i]); !d.Empty() {
			t.Fatalf("frame %d differs from its picture in %v", i, d)
		}
	}
	// A frame that changes nothing is dropped and its time added to the
	// one before.
	fs = frames(2)
	fs = append(fs, Frame{Grid: fs[1].Grid, Delay: 300 * time.Millisecond})
	b, _ = GIF(fs, Options{})
	g, _ = gif.DecodeAll(bytes.NewReader(b))
	if len(g.Image) != 2 || g.Delay[1] != 5+30 {
		t.Fatalf("%d frames, delays %v", len(g.Image), g.Delay)
	}
}

func TestGIFManyColours(t *testing.T) {
	g := grid(strings.Repeat("█", 40), strings.Repeat("█", 40))
	for y := range g.Cells {
		for x := range g.Cells[y] {
			g.Cells[y][x].Fg, g.Cells[y][x].HasFg = rgbOf(uint8(x*6), uint8(y*100), uint8(255-x*6)), true
		}
	}
	g.Cells[0][0].Text = "a" // antialiased text adds blends
	b, err := GIF([]Frame{{Grid: g, Delay: 100 * time.Millisecond}}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := gif.DecodeAll(bytes.NewReader(b)); err != nil {
		t.Fatal(err)
	}
}

func TestAPNG(t *testing.T) {
	fs := frames(5)
	b, err := APNG(fs, Options{})
	if err != nil {
		t.Fatal(err)
	}
	// image/png reads the first frame (the IDAT), as a viewer without APNG.
	first, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	want := Image(fs[0].Grid, Options{})
	if first.Bounds() != want.Bounds() {
		t.Fatalf("first frame %v, want %v", first.Bounds(), want.Bounds())
	}
	for y := 0; y < want.Bounds().Dy(); y += 3 {
		for x := 0; x < want.Bounds().Dx(); x += 3 {
			r, g, bb, _ := first.At(x, y).RGBA()
			w := want.RGBAAt(x, y)
			if (color.RGBA{uint8(r >> 8), uint8(g >> 8), uint8(bb >> 8), 255}) != w {
				t.Fatalf("first frame differs at %d,%d", x, y)
			}
		}
	}
	// Walk the chunks: CRCs, acTL, one fcTL per frame, sequence numbers
	// 0, 1, 2, ... over fcTL and fdAT, and the delays.
	p := b[8:]
	seq, fctl, frames := uint32(0), 0, -1
	var delays []uint16
	for len(p) > 0 {
		n := binary.BigEndian.Uint32(p)
		typ := string(p[4:8])
		data := p[8 : 8+n]
		if crc32.ChecksumIEEE(p[4:8+n]) != binary.BigEndian.Uint32(p[8+n:]) {
			t.Fatalf("%s: bad CRC", typ)
		}
		switch typ {
		case "acTL":
			frames = int(binary.BigEndian.Uint32(data))
			if plays := binary.BigEndian.Uint32(data[4:]); plays != 0 {
				t.Errorf("plays %d, want 0 (forever)", plays)
			}
		case "fcTL", "fdAT":
			if got := binary.BigEndian.Uint32(data); got != seq {
				t.Fatalf("%s sequence %d, want %d", typ, got, seq)
			}
			seq++
			if typ == "fcTL" {
				fctl++
				w, h := binary.BigEndian.Uint32(data[4:]), binary.BigEndian.Uint32(data[8:])
				x, y := binary.BigEndian.Uint32(data[12:]), binary.BigEndian.Uint32(data[16:])
				if w == 0 || h == 0 || int(x+w) > want.Bounds().Dx() || int(y+h) > want.Bounds().Dy() {
					t.Errorf("frame %d at %d,%d size %dx%d is off the %v canvas", fctl, x, y, w, h, want.Bounds())
				}
				if fctl > 1 && int(w) >= want.Bounds().Dx() {
					t.Errorf("frame %d holds the whole width, not only the spinner's cell", fctl)
				}
				delays = append(delays, binary.BigEndian.Uint16(data[20:]))
				if den := binary.BigEndian.Uint16(data[22:]); den != 1000 {
					t.Errorf("delay denominator %d", den)
				}
			}
		}
		p = p[12+n:]
	}
	if frames != 5 || fctl != 5 {
		t.Fatalf("acTL says %d frames, %d fcTL", frames, fctl)
	}
	for i, d := range delays {
		if int(d) != int(fs[i].Delay.Milliseconds()) {
			t.Errorf("frame %d delay %d ms, want %d", i, d, fs[i].Delay.Milliseconds())
		}
	}
	if _, err := APNG(nil, Options{}); err == nil {
		t.Errorf("no frames gave no error")
	}
}

// TestCost prints what a picture costs: a full screen of text drawn and
// encoded, and a 30-frame GIF and APNG of it.
func TestCost(t *testing.T) {
	for _, sz := range [][2]int{{80, 24}, {200, 60}} {
		rows := make([]string, sz[1])
		for y := range rows {
			rows[y] = strings.Repeat("ravenry ", sz[0]/8+1)[:sz[0]]
		}
		g := grid(rows...)
		start := time.Now()
		b, err := PNG(g, Options{})
		if err != nil {
			t.Fatal(err)
		}
		fmt.Printf("MEASURE render.PNG %dx%d: %v, %d KiB\n", sz[0], sz[1], time.Since(start), len(b)>>10)
		// A spinner in the first cell: what a filmstrip of an agent at
		// work mostly holds.
		fs := make([]Frame, 30)
		spin := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
		for i := range fs {
			fg := *g
			fg.Cells = append([][]vt.Cell{}, g.Cells...)
			fg.Cells[0] = append([]vt.Cell{}, g.Cells[0]...)
			fg.Cells[0][0].Text = spin[i%len(spin)]
			fs[i] = Frame{Grid: &fg, Delay: 100 * time.Millisecond}
		}
		start = time.Now()
		b, _ = GIF(fs, Options{})
		fmt.Printf("MEASURE render.GIF %dx%d, 30 frames of a spinner: %v, %d KiB\n", sz[0], sz[1], time.Since(start), len(b)>>10)
		start = time.Now()
		b, _ = APNG(fs, Options{})
		fmt.Printf("MEASURE render.APNG %dx%d, 30 frames of a spinner: %v, %d KiB\n", sz[0], sz[1], time.Since(start), len(b)>>10)
	}
}
