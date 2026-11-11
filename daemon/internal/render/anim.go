package render

import (
	"bytes"
	"compress/lzw"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"sort"
	"time"
)

// GIF draws frames as an animated GIF that loops forever, each frame
// only the part that changed since the one before. Its palette is
// the colours the frames use; when they use more than 256 (antialiased
// text in many colours), the 256 most used are kept and every other
// colour takes the nearest of them, which keeps text sharp where
// dithering would speckle it.
//
// It holds two pictures at a time, never the whole strip: a first pass
// draws each frame, keeps where it changed and counts the colours there;
// a second draws each again and writes its changed part in the palette
// (writeGIF). A 153x60 pane's 200 frames are 1 GB drawn.
func GIF(frames []Frame, o Options) ([]byte, error) {
	if len(frames) == 0 {
		return nil, errors.New("render: no frames")
	}
	size := canvasSize(frames, o)
	count := map[uint32]int{}
	steps := changes(frames, size, o, func(img *image.RGBA, r image.Rectangle) {
		for y := r.Min.Y; y < r.Max.Y; y++ {
			row := img.Pix[img.PixOffset(r.Min.X, y):img.PixOffset(r.Max.X, y)]
			for i := 0; i+3 < len(row); i += 4 {
				count[uint32(row[i])<<16|uint32(row[i+1])<<8|uint32(row[i+2])]++
			}
		}
	})
	pal := gifPalette(count)
	near := map[uint32]uint8{}
	var b bytes.Buffer
	w := newGIFWriter(&b, size, pal)
	k := 0
	for i, f := range frames {
		if k >= len(steps) || steps[k].frame != i {
			continue
		}
		st := steps[k]
		k++
		img := frameImage(f, size, o)
		pi := image.NewPaletted(st.rect, pal)
		for y := st.rect.Min.Y; y < st.rect.Max.Y; y++ {
			src := img.Pix[img.PixOffset(st.rect.Min.X, y):]
			dst := pi.Pix[pi.PixOffset(st.rect.Min.X, y):]
			for x := 0; x < st.rect.Dx(); x++ {
				c := uint32(src[4*x])<<16 | uint32(src[4*x+1])<<8 | uint32(src[4*x+2])
				idx, ok := near[c]
				if !ok {
					idx = uint8(pal.Index(color.RGBA{src[4*x], src[4*x+1], src[4*x+2], 255}))
					near[c] = idx
				}
				dst[x] = idx
			}
		}
		if err := w.frame(pi, gifDelay(st.delay)); err != nil {
			return nil, err
		}
	}
	return w.end()
}

// step is one frame of an animation as it is written: which frame, the
// part of its picture that changed since the frame before (all of it for
// the first), and how long it shows.
type step struct {
	frame int
	rect  image.Rectangle
	delay time.Duration
}

// changes draws the frames one at a time (the one before kept to compare)
// and turns them into steps: each frame keeps only the rectangle that
// changed since the one before, and a frame that changed nothing is
// dropped, its time added to the frame before. A filmstrip of a spinner
// then writes one cell per frame, not the whole screen. seen gets each
// step's picture and rectangle while it is drawn.
func changes(frames []Frame, size image.Point, o Options, seen func(*image.RGBA, image.Rectangle)) []step {
	var out []step
	var prev *image.RGBA
	for i, f := range frames {
		img := frameImage(f, size, o)
		r := img.Bounds()
		if prev != nil {
			r = diffRect(prev, img)
			if r.Empty() {
				out[len(out)-1].delay += f.Delay
				continue
			}
		}
		out = append(out, step{frame: i, rect: r, delay: f.Delay})
		if seen != nil {
			seen(img, r)
		}
		prev = img
	}
	return out
}

// diffRect is the smallest rectangle holding every pixel that differs
// between two images of the same size.
func diffRect(a, b *image.RGBA) image.Rectangle {
	w, h := b.Bounds().Dx(), b.Bounds().Dy()
	minX, minY, maxX, maxY := w, h, -1, -1
	for y := 0; y < h; y++ {
		ra := a.Pix[y*a.Stride : y*a.Stride+4*w]
		rb := b.Pix[y*b.Stride : y*b.Stride+4*w]
		if bytes.Equal(ra, rb) {
			continue
		}
		minY, maxY = min(minY, y), y
		x0 := 0
		for x0 < w && bytes.Equal(ra[4*x0:4*x0+4], rb[4*x0:4*x0+4]) {
			x0++
		}
		x1 := w - 1
		for x1 > x0 && bytes.Equal(ra[4*x1:4*x1+4], rb[4*x1:4*x1+4]) {
			x1--
		}
		minX, maxX = min(minX, x0), max(maxX, x1)
	}
	if maxY < 0 {
		return image.Rectangle{}
	}
	return image.Rect(minX, minY, maxX+1, maxY+1)
}

// gifDelay is a delay in a GIF's hundredths of a second, at least 2
// (browsers show shorter delays as 10).
func gifDelay(d time.Duration) int {
	return max(2, int((d+5*time.Millisecond)/(10*time.Millisecond)))
}

// gifPalette is the 256 colours used most (count: pixels a colour).
func gifPalette(count map[uint32]int) color.Palette {
	keys := make([]uint32, 0, len(count))
	for k := range count {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if count[keys[i]] != count[keys[j]] {
			return count[keys[i]] > count[keys[j]]
		}
		return keys[i] < keys[j]
	})
	if len(keys) > 256 {
		keys = keys[:256]
	}
	pal := make(color.Palette, len(keys))
	for i, k := range keys {
		pal[i] = color.RGBA{uint8(k >> 16), uint8(k >> 8), uint8(k), 255}
	}
	return pal
}

// APNG draws frames as an animated PNG that loops forever. Each frame
// (only the part that changed, as for a GIF) is encoded by image/png, and
// its image data goes into the animation: the first frame's as IDAT (what
// a viewer without APNG shows), the others' as fdAT, each after its fcTL
// with its place on the canvas, numbered in one sequence. Each frame is
// encoded as it is drawn (two pictures held at a time, as for a GIF); the
// count of frames, which comes first in the file, is written last.
func APNG(frames []Frame, o Options) ([]byte, error) {
	if len(frames) == 0 {
		return nil, errors.New("render: no frames")
	}
	size := canvasSize(frames, o)
	var body bytes.Buffer
	seq := uint32(0)
	var ihdr []byte
	n := 0
	var fail error
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	steps := changes(frames, size, o, func(img *image.RGBA, r image.Rectangle) {
		if fail != nil {
			return
		}
		var b bytes.Buffer
		if err := enc.Encode(&b, img.SubImage(r)); err != nil {
			fail = err
			return
		}
		chunks, err := pngChunks(b.Bytes())
		if err != nil {
			fail = err
			return
		}
		var hdr []byte
		var data [][]byte
		for _, c := range chunks {
			switch c.typ {
			case "IHDR":
				hdr = c.data
			case "IDAT":
				data = append(data, c.data)
			}
		}
		if len(hdr) != 13 || len(data) == 0 {
			fail = errors.New("render: a frame's PNG has no IHDR or IDAT")
			return
		}
		if n == 0 {
			ihdr = append([]byte(nil), hdr...)
		} else if !bytes.Equal(hdr[8:], ihdr[8:]) {
			// Bit depth, colour type, compression, filter and interlace
			// must be the first frame's; only the size differs.
			fail = errors.New("render: frames encoded with different PNG formats")
			return
		}
		fctl := make([]byte, 26)
		binary.BigEndian.PutUint32(fctl[0:], seq)
		seq++
		binary.BigEndian.PutUint32(fctl[4:], uint32(r.Dx()))
		binary.BigEndian.PutUint32(fctl[8:], uint32(r.Dy()))
		binary.BigEndian.PutUint32(fctl[12:], uint32(r.Min.X))
		binary.BigEndian.PutUint32(fctl[16:], uint32(r.Min.Y))
		binary.BigEndian.PutUint16(fctl[22:], 1000)
		fctl[24], fctl[25] = 0, 0 // dispose none, blend source
		// The delay (fctl[20:22]) is set once the step's time is known.
		writeChunk(&body, "fcTL", fctl)
		for _, d := range data {
			if n == 0 {
				writeChunk(&body, "IDAT", d)
				continue
			}
			fd := make([]byte, 4+len(d))
			binary.BigEndian.PutUint32(fd, seq)
			seq++
			copy(fd[4:], d)
			writeChunk(&body, "fdAT", fd)
		}
		n++
	})
	if fail != nil {
		return nil, fail
	}
	// Each fcTL's delay: the steps' times, now that dropped frames have
	// added theirs; the chunk's CRC again.
	out := bytes.Buffer{}
	out.WriteString("\x89PNG\r\n\x1a\n")
	writeChunk(&out, "IHDR", ihdr)
	actl := make([]byte, 8)
	binary.BigEndian.PutUint32(actl[0:], uint32(len(steps)))
	binary.BigEndian.PutUint32(actl[4:], 0) // loop forever
	writeChunk(&out, "acTL", actl)
	bb := body.Bytes()
	k := 0
	for pos := 0; pos+12 <= len(bb); {
		ln := int(binary.BigEndian.Uint32(bb[pos:]))
		if string(bb[pos+4:pos+8]) == "fcTL" && k < len(steps) {
			d := bb[pos+8 : pos+8+ln]
			ms := min(max(steps[k].delay.Milliseconds(), 0), 65535)
			binary.BigEndian.PutUint16(d[20:], uint16(ms))
			crc := crc32.NewIEEE()
			crc.Write(bb[pos+4 : pos+8+ln])
			binary.BigEndian.PutUint32(bb[pos+8+ln:], crc.Sum32())
			k++
		}
		pos += 12 + ln
	}
	out.Write(bb)
	writeChunk(&out, "IEND", nil)
	return out.Bytes(), nil
}

type chunk struct {
	typ  string
	data []byte
}

// pngChunks splits a PNG into its chunks.
func pngChunks(b []byte) ([]chunk, error) {
	if len(b) < 8 || string(b[:8]) != "\x89PNG\r\n\x1a\n" {
		return nil, errors.New("render: not a PNG")
	}
	b = b[8:]
	var out []chunk
	for len(b) > 0 {
		if len(b) < 12 {
			return nil, errors.New("render: a PNG chunk is cut short")
		}
		n := int(binary.BigEndian.Uint32(b))
		if n < 0 || len(b) < 12+n {
			return nil, errors.New("render: a PNG chunk is cut short")
		}
		out = append(out, chunk{typ: string(b[4:8]), data: b[8 : 8+n]})
		b = b[12+n:]
	}
	return out, nil
}

func writeChunk(w *bytes.Buffer, typ string, data []byte) {
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(data)))
	w.Write(n[:])
	w.WriteString(typ)
	w.Write(data)
	crc := crc32.NewIEEE()
	crc.Write([]byte(typ))
	crc.Write(data)
	binary.BigEndian.PutUint32(n[:], crc.Sum32())
	w.Write(n[:])
}

// gifWriter writes an animated GIF a frame at a time (image/gif wants
// every frame at once): the header, the palette and a loop forever, then
// each frame where it lies on the canvas, shown until the next.
type gifWriter struct {
	w    *bytes.Buffer
	bits int // the palette's size is 1<<bits
}

func newGIFWriter(w *bytes.Buffer, size image.Point, pal color.Palette) *gifWriter {
	g := &gifWriter{w: w, bits: 1}
	for 1<<g.bits < len(pal) {
		g.bits++
	}
	w.WriteString("GIF89a")
	le16 := func(v int) { w.WriteByte(byte(v)); w.WriteByte(byte(v >> 8)) }
	le16(size.X)
	le16(size.Y)
	w.WriteByte(0x80 | 0x70 | byte(g.bits-1)) // a global palette, 8 bits a channel
	w.WriteByte(0)                            // background
	w.WriteByte(0)                            // aspect
	for i := 0; i < 1<<g.bits; i++ {
		var r, gg, b uint32
		if i < len(pal) {
			r, gg, b, _ = pal[i].RGBA()
		}
		w.Write([]byte{byte(r >> 8), byte(gg >> 8), byte(b >> 8)})
	}
	w.Write([]byte{0x21, 0xff, 0x0b})
	w.WriteString("NETSCAPE2.0")
	w.Write([]byte{0x03, 0x01, 0x00, 0x00, 0x00}) // loop forever
	return g
}

// frame writes one frame: its delay in hundredths of a second, drawn
// over the frames before (disposal none).
func (g *gifWriter) frame(pi *image.Paletted, delay int) error {
	w := g.w
	le16 := func(v int) { w.WriteByte(byte(v)); w.WriteByte(byte(v >> 8)) }
	w.Write([]byte{0x21, 0xf9, 0x04, 1 << 2})
	le16(delay)
	w.Write([]byte{0x00, 0x00})
	r := pi.Rect
	w.WriteByte(0x2c)
	le16(r.Min.X)
	le16(r.Min.Y)
	le16(r.Dx())
	le16(r.Dy())
	w.WriteByte(0x00)
	lit := max(2, g.bits)
	w.WriteByte(byte(lit))
	bw := &blockWriter{w: w}
	lz := lzw.NewWriter(bw, lzw.LSB, lit)
	for y := r.Min.Y; y < r.Max.Y; y++ {
		if _, err := lz.Write(pi.Pix[pi.PixOffset(r.Min.X, y):pi.PixOffset(r.Max.X, y)]); err != nil {
			return err
		}
	}
	if err := lz.Close(); err != nil {
		return err
	}
	bw.flush()
	w.WriteByte(0x00)
	return nil
}

func (g *gifWriter) end() ([]byte, error) {
	g.w.WriteByte(0x3b)
	return g.w.Bytes(), nil
}

// blockWriter cuts LZW data into the GIF's sub-blocks of 255 bytes.
type blockWriter struct {
	w   *bytes.Buffer
	buf [255]byte
	n   int
}

func (b *blockWriter) Write(p []byte) (int, error) {
	total := len(p)
	for len(p) > 0 {
		c := copy(b.buf[b.n:], p)
		b.n += c
		p = p[c:]
		if b.n == len(b.buf) {
			b.flush()
		}
	}
	return total, nil
}

func (b *blockWriter) flush() {
	if b.n == 0 {
		return
	}
	b.w.WriteByte(byte(b.n))
	b.w.Write(b.buf[:b.n])
	b.n = 0
}
