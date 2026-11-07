package render

import (
	"image"
	"image/color"
	"math"
)

// Box drawing (U+2500 to U+257F), block elements (U+2580 to U+259F) and
// braille (U+2800 to U+28FF) are drawn to fill the cell exactly, as
// terminals draw them, so the lines of a border join from cell to cell and
// a braille spinner shows its dots, whatever the font has.

// procedural reports whether r is drawn here rather than from the font.
func procedural(r rune) bool {
	return (r >= 0x2500 && r <= 0x259F) || (r >= 0x2800 && r <= 0x28FF)
}

// Line weights of a box drawing segment.
const (
	none   = 0
	light  = 1
	heavy  = 2
	double = 3
)

// boxLines gives each box drawing character from U+2500 to U+254F and
// U+2550 to U+256C, and U+2574 to U+257F, its four arms: up, right, down
// and left, each 0 (none), 1 (light), 2 (heavy) or 3 (double).
var boxLines = map[rune]string{
	0x2500: "0101", 0x2501: "0202", 0x2502: "1010", 0x2503: "2020",
	0x2504: "0101", 0x2505: "0202", 0x2506: "1010", 0x2507: "2020",
	0x2508: "0101", 0x2509: "0202", 0x250A: "1010", 0x250B: "2020",
	0x250C: "0110", 0x250D: "0210", 0x250E: "0120", 0x250F: "0220",
	0x2510: "0011", 0x2511: "0012", 0x2512: "0021", 0x2513: "0022",
	0x2514: "1100", 0x2515: "1200", 0x2516: "2100", 0x2517: "2200",
	0x2518: "1001", 0x2519: "1002", 0x251A: "2001", 0x251B: "2002",
	0x251C: "1110", 0x251D: "1210", 0x251E: "2110", 0x251F: "1120",
	0x2520: "2120", 0x2521: "2210", 0x2522: "1220", 0x2523: "2220",
	0x2524: "1011", 0x2525: "1012", 0x2526: "2011", 0x2527: "1021",
	0x2528: "2021", 0x2529: "2012", 0x252A: "1022", 0x252B: "2022",
	0x252C: "0111", 0x252D: "0112", 0x252E: "0211", 0x252F: "0212",
	0x2530: "0121", 0x2531: "0122", 0x2532: "0221", 0x2533: "0222",
	0x2534: "1101", 0x2535: "1102", 0x2536: "1201", 0x2537: "1202",
	0x2538: "2101", 0x2539: "2102", 0x253A: "2201", 0x253B: "2202",
	0x253C: "1111", 0x253D: "1112", 0x253E: "1211", 0x253F: "1212",
	0x2540: "2111", 0x2541: "1121", 0x2542: "2121", 0x2543: "2112",
	0x2544: "2211", 0x2545: "1122", 0x2546: "1221", 0x2547: "2212",
	0x2548: "1222", 0x2549: "2122", 0x254A: "2221", 0x254B: "2222",
	0x254C: "0101", 0x254D: "0202", 0x254E: "1010", 0x254F: "2020",
	0x2550: "0303", 0x2551: "3030", 0x2552: "0310", 0x2553: "0130",
	0x2554: "0330", 0x2555: "0013", 0x2556: "0031", 0x2557: "0033",
	0x2558: "1300", 0x2559: "3100", 0x255A: "3300", 0x255B: "1003",
	0x255C: "3001", 0x255D: "3003", 0x255E: "1310", 0x255F: "3130",
	0x2560: "3330", 0x2561: "1013", 0x2562: "3031", 0x2563: "3033",
	0x2564: "0313", 0x2565: "0131", 0x2566: "0333", 0x2567: "1303",
	0x2568: "3101", 0x2569: "3303", 0x256A: "1313", 0x256B: "3131",
	0x256C: "3333",
	0x2574: "0001", 0x2575: "1000", 0x2576: "0100", 0x2577: "0010",
	0x2578: "0002", 0x2579: "2000", 0x257A: "0200", 0x257B: "0020",
	0x257C: "0201", 0x257D: "1020", 0x257E: "0102", 0x257F: "2010",
}

// dashes is how many dashes a dashed line has.
var dashes = map[rune]int{
	0x2504: 3, 0x2505: 3, 0x2506: 3, 0x2507: 3,
	0x2508: 4, 0x2509: 4, 0x250A: 4, 0x250B: 4,
	0x254C: 2, 0x254D: 2, 0x254E: 2, 0x254F: 2,
}

// cellPainter draws into one cell's rectangle.
type cellPainter struct {
	img *image.RGBA
	r   image.Rectangle // the cell (two cells for a wide character)
	fg  color.RGBA
	bg  color.RGBA
}

func (p cellPainter) fill(x0, y0, x1, y1 int, c color.RGBA) {
	rr := image.Rect(p.r.Min.X+x0, p.r.Min.Y+y0, p.r.Min.X+x1, p.r.Min.Y+y1).Intersect(p.r)
	for y := rr.Min.Y; y < rr.Max.Y; y++ {
		i := p.img.PixOffset(rr.Min.X, y)
		for x := rr.Min.X; x < rr.Max.X; x++ {
			p.img.Pix[i], p.img.Pix[i+1], p.img.Pix[i+2], p.img.Pix[i+3] = c.R, c.G, c.B, 255
			i += 4
		}
	}
}

// blend mixes a over b: a weight of 1 is a.
func blend(a, b color.RGBA, w float64) color.RGBA {
	m := func(x, y uint8) uint8 { return uint8(math.Round(float64(x)*w + float64(y)*(1-w))) }
	return color.RGBA{m(a.R, b.R), m(a.G, b.G), m(a.B, b.B), 255}
}

// drawProcedural draws r into the cell and reports whether it could.
func (p cellPainter) drawProcedural(r rune) bool {
	w, h := p.r.Dx(), p.r.Dy()
	switch {
	case r >= 0x2800 && r <= 0x28FF:
		p.braille(int(r-0x2800), w, h)
		return true
	case r >= 0x2580 && r <= 0x259F:
		p.block(r, w, h)
		return true
	case r >= 0x256D && r <= 0x2570:
		p.arc(r, w, h)
		return true
	case r >= 0x2571 && r <= 0x2573:
		p.diagonal(r, w, h)
		return true
	}
	arms, ok := boxLines[r]
	if !ok {
		return false
	}
	p.box(arms, dashes[r], w, h)
	return true
}

// thickness is a light line's width in pixels for a cell w wide.
func thickness(w int) int { return max(1, int(math.Round(float64(w)/8))) }

func (p cellPainter) box(arms string, dash, w, h int) {
	t := thickness(w)
	weight := [4]int{}
	for i := 0; i < 4; i++ {
		weight[i] = int(arms[i] - '0')
	}
	up, right, down, left := weight[0], weight[1], weight[2], weight[3]
	width := func(wt int) int {
		if wt == heavy {
			return 2 * t
		}
		return t
	}
	// A line of thickness th centred on c starts at c - th/2.
	cx, cy := w/2, h/2
	// A double line's strokes are this far from the centre line, each
	// side, which leaves a gap of about two strokes between them.
	g := max(2, (3*t+1)/2)
	// How far a single or heavy arm goes past the centre, so it meets the
	// arms across it.
	reach := func(a, b int) int {
		e := 0
		for _, wt := range []int{a, b} {
			switch wt {
			case light, heavy:
				e = max(e, (width(wt)+1)/2)
			case double:
				e = max(e, g+(t+1)/2)
			}
		}
		return e
	}
	hline := func(x0, x1, y, th int) { p.dashedH(x0, x1, y-th/2, th, dash) }
	vline := func(y0, y1, x, th int) { p.dashedV(y0, y1, x-th/2, th, dash) }
	// Single and heavy arms.
	if left == light || left == heavy {
		hline(0, cx+reach(up, down), cy, width(left))
	}
	if right == light || right == heavy {
		hline(cx-reach(up, down), w, cy, width(right))
	}
	if up == light || up == heavy {
		vline(0, cy+reach(left, right), cx, width(up))
	}
	if down == light || down == heavy {
		vline(cy-reach(left, right), h, cx, width(down))
	}
	// Double arms: two strokes, each stopping where an arm across it
	// starts, so corners and joins are drawn as in a double box.
	at := func(present bool, inner, outer int) int {
		if present {
			return inner
		}
		return outer
	}
	if left == double {
		hline(0, at(up != none, cx-g, cx+g)+(t+1)/2, cy-g, t)
		hline(0, at(down != none, cx-g, cx+g)+(t+1)/2, cy+g, t)
	}
	if right == double {
		hline(at(up != none, cx+g, cx-g)-t/2, w, cy-g, t)
		hline(at(down != none, cx+g, cx-g)-t/2, w, cy+g, t)
	}
	if up == double {
		vline(0, at(left != none, cy-g, cy+g)+(t+1)/2, cx-g, t)
		vline(0, at(right != none, cy-g, cy+g)+(t+1)/2, cx+g, t)
	}
	if down == double {
		vline(at(left != none, cy+g, cy-g)-t/2, h, cx-g, t)
		vline(at(right != none, cy+g, cy-g)-t/2, h, cx+g, t)
	}
}

// dashedH draws a horizontal stroke from x0 to x1, solid or in n dashes
// spread over the cell.
func (p cellPainter) dashedH(x0, x1, y, th, n int) {
	if n == 0 {
		p.fill(x0, y, x1, y+th, p.fg)
		return
	}
	seg := float64(x1-x0) / float64(n)
	for i := 0; i < n; i++ {
		a := x0 + int(math.Round(seg*float64(i)))
		b := x0 + int(math.Round(seg*(float64(i)+0.65)))
		p.fill(a, y, max(b, a+1), y+th, p.fg)
	}
}

func (p cellPainter) dashedV(y0, y1, x, th, n int) {
	if n == 0 {
		p.fill(x, y0, x+th, y1, p.fg)
		return
	}
	seg := float64(y1-y0) / float64(n)
	for i := 0; i < n; i++ {
		a := y0 + int(math.Round(seg*float64(i)))
		b := y0 + int(math.Round(seg*(float64(i)+0.65)))
		p.fill(x, a, x+th, max(b, a+1), p.fg)
	}
}

// dot draws a filled square of side th centred on (x, y).
func (p cellPainter) dot(x, y float64, th int) {
	x0 := int(math.Round(x - float64(th)/2))
	y0 := int(math.Round(y - float64(th)/2))
	p.fill(x0, y0, x0+th, y0+th, p.fg)
}

// arc draws a rounded corner (U+256D to U+2570): a quarter circle between
// the two arms, which reach the cell's edges.
func (p cellPainter) arc(r rune, w, h int) {
	t := thickness(w)
	cx, cy := float64(w/2), float64(h/2)
	rad := math.Min(cx, cy)
	// sx and sy point from the corner towards its two arms.
	sx, sy := 1.0, 1.0 // U+256D: right and down
	switch r {
	case 0x256E:
		sx, sy = -1, 1
	case 0x256F:
		sx, sy = -1, -1
	case 0x2570:
		sx, sy = 1, -1
	}
	ox, oy := cx+sx*rad, cy+sy*rad // the circle's centre
	steps := int(rad*2) + 8
	for i := 0; i <= steps; i++ {
		a := math.Pi / 2 * float64(i) / float64(steps)
		p.dot(ox-sx*rad*math.Cos(a), oy-sy*rad*math.Sin(a), t)
	}
	// The straight parts, from the arc to the edges.
	if sx > 0 {
		p.fill(int(ox), int(cy)-t/2, w, int(cy)-t/2+t, p.fg)
	} else {
		p.fill(0, int(cy)-t/2, int(ox)+1, int(cy)-t/2+t, p.fg)
	}
	if sy > 0 {
		p.fill(int(cx)-t/2, int(oy), int(cx)-t/2+t, h, p.fg)
	} else {
		p.fill(int(cx)-t/2, 0, int(cx)-t/2+t, int(oy)+1, p.fg)
	}
}

func (p cellPainter) diagonal(r rune, w, h int) {
	t := thickness(w)
	steps := 2 * (w + h)
	for i := 0; i <= steps; i++ {
		f := float64(i) / float64(steps)
		if r == 0x2571 || r == 0x2573 {
			p.dot(float64(w)*(1-f), float64(h)*f, t)
		}
		if r == 0x2572 || r == 0x2573 {
			p.dot(float64(w)*f, float64(h)*f, t)
		}
	}
}

func (p cellPainter) block(r rune, w, h int) {
	eighthsY := func(n int) int { return int(math.Round(float64(h) * float64(n) / 8)) }
	eighthsX := func(n int) int { return int(math.Round(float64(w) * float64(n) / 8)) }
	hw, hh := w/2, h/2
	quad := func(ul, ur, ll, lr bool) {
		if ul {
			p.fill(0, 0, hw, hh, p.fg)
		}
		if ur {
			p.fill(hw, 0, w, hh, p.fg)
		}
		if ll {
			p.fill(0, hh, hw, h, p.fg)
		}
		if lr {
			p.fill(hw, hh, w, h, p.fg)
		}
	}
	switch {
	case r == 0x2580:
		p.fill(0, 0, w, hh, p.fg)
	case r >= 0x2581 && r <= 0x2588:
		p.fill(0, h-eighthsY(int(r-0x2580)), w, h, p.fg)
	case r >= 0x2589 && r <= 0x258F:
		p.fill(0, 0, eighthsX(int(0x2590-r)), h, p.fg)
	case r == 0x2590:
		p.fill(hw, 0, w, h, p.fg)
	case r >= 0x2591 && r <= 0x2593:
		p.fill(0, 0, w, h, blend(p.fg, p.bg, float64(r-0x2590)/4))
	case r == 0x2594:
		p.fill(0, 0, w, eighthsY(1), p.fg)
	case r == 0x2595:
		p.fill(w-eighthsX(1), 0, w, h, p.fg)
	case r == 0x2596:
		quad(false, false, true, false)
	case r == 0x2597:
		quad(false, false, false, true)
	case r == 0x2598:
		quad(true, false, false, false)
	case r == 0x2599:
		quad(true, false, true, true)
	case r == 0x259A:
		quad(true, false, false, true)
	case r == 0x259B:
		quad(true, true, true, false)
	case r == 0x259C:
		quad(true, true, false, true)
	case r == 0x259D:
		quad(false, true, false, false)
	case r == 0x259E:
		quad(false, true, true, false)
	case r == 0x259F:
		quad(false, true, true, true)
	}
}

// braille draws the dots of a braille pattern: bits 0 to 2 are the left
// column's top three dots, 3 to 5 the right column's, 6 and 7 the bottom
// row's left and right.
func (p cellPainter) braille(bits, w, h int) {
	pos := [8][2]int{{0, 0}, {0, 1}, {0, 2}, {1, 0}, {1, 1}, {1, 2}, {0, 3}, {1, 3}}
	d := max(1, int(math.Round(float64(w)/5)))
	for i, at := range pos {
		if bits&(1<<i) == 0 {
			continue
		}
		x := float64(w) * (float64(at[0])*2 + 1) / 4
		y := float64(h) * (float64(at[1])*2 + 1) / 8
		p.dot(x, y, d)
	}
}

// hollow draws a box around the cell for a character no font here has.
func (p cellPainter) hollow() {
	w, h := p.r.Dx(), p.r.Dy()
	x0, y0, x1, y1 := 1, h/6, w-1, h-h/6
	p.fill(x0, y0, x1, y0+1, p.fg)
	p.fill(x0, y1-1, x1, y1, p.fg)
	p.fill(x0, y0, x0+1, y1, p.fg)
	p.fill(x1-1, y0, x1, y1, p.fg)
}
