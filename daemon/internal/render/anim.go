package render

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
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
func GIF(frames []Frame, o Options) ([]byte, error) {
	if len(frames) == 0 {
		return nil, errors.New("render: no frames")
	}
	steps := changes(frameImages(frames, o), frames)
	pal := gifPalette(steps)
	out := &gif.GIF{LoopCount: 0}
	near := map[uint32]uint8{}
	for _, st := range steps {
		img := st.img
		pi := image.NewPaletted(st.rect, pal)
		for y := st.rect.Min.Y; y < st.rect.Max.Y; y++ {
			src := img.Pix[img.PixOffset(st.rect.Min.X, y):]
			dst := pi.Pix[pi.PixOffset(st.rect.Min.X, y):]
			for x := 0; x < st.rect.Dx(); x++ {
				k := uint32(src[4*x])<<16 | uint32(src[4*x+1])<<8 | uint32(src[4*x+2])
				idx, ok := near[k]
				if !ok {
					idx = uint8(pal.Index(color.RGBA{src[4*x], src[4*x+1], src[4*x+2], 255}))
					near[k] = idx
				}
				dst[x] = idx
			}
		}
		out.Image = append(out.Image, pi)
		out.Delay = append(out.Delay, gifDelay(st.delay))
		out.Disposal = append(out.Disposal, gif.DisposalNone)
	}
	var b bytes.Buffer
	if err := gif.EncodeAll(&b, out); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

// step is one frame of an animation as it is written: the part of the
// picture that changed since the frame before (all of it for the first),
// and how long it shows.
type step struct {
	img   *image.RGBA
	rect  image.Rectangle
	delay time.Duration
}

// changes turns frames into steps: each frame keeps only the rectangle
// that changed since the one before, and a frame that changed nothing is
// dropped, its time added to the frame before. A filmstrip of a spinner
// then writes one cell per frame, not the whole screen.
func changes(imgs []*image.RGBA, frames []Frame) []step {
	var out []step
	for i, img := range imgs {
		if i == 0 {
			out = append(out, step{img: img, rect: img.Bounds(), delay: frames[i].Delay})
			continue
		}
		r := diffRect(imgs[i-1], img)
		if r.Empty() {
			out[len(out)-1].delay += frames[i].Delay
			continue
		}
		out = append(out, step{img: img, rect: r, delay: frames[i].Delay})
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

func gifPalette(steps []step) color.Palette {
	count := map[uint32]int{}
	for _, st := range steps {
		for y := st.rect.Min.Y; y < st.rect.Max.Y; y++ {
			row := st.img.Pix[st.img.PixOffset(st.rect.Min.X, y):st.img.PixOffset(st.rect.Max.X, y)]
			for i := 0; i+3 < len(row); i += 4 {
				count[uint32(row[i])<<16|uint32(row[i+1])<<8|uint32(row[i+2])]++
			}
		}
	}
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
// with its place on the canvas, numbered in one sequence.
func APNG(frames []Frame, o Options) ([]byte, error) {
	if len(frames) == 0 {
		return nil, errors.New("render: no frames")
	}
	steps := changes(frameImages(frames, o), frames)
	var out bytes.Buffer
	out.WriteString("\x89PNG\r\n\x1a\n")
	seq := uint32(0)
	var ihdr []byte
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	for i, st := range steps {
		var b bytes.Buffer
		if err := enc.Encode(&b, st.img.SubImage(st.rect)); err != nil {
			return nil, err
		}
		chunks, err := pngChunks(b.Bytes())
		if err != nil {
			return nil, err
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
			return nil, errors.New("render: a frame's PNG has no IHDR or IDAT")
		}
		if i == 0 {
			ihdr = hdr
			writeChunk(&out, "IHDR", hdr)
			actl := make([]byte, 8)
			binary.BigEndian.PutUint32(actl[0:], uint32(len(steps)))
			binary.BigEndian.PutUint32(actl[4:], 0) // loop forever
			writeChunk(&out, "acTL", actl)
		} else if !bytes.Equal(hdr[8:], ihdr[8:]) {
			// Bit depth, colour type, compression, filter and interlace
			// must be the first frame's; only the size differs.
			return nil, errors.New("render: frames encoded with different PNG formats")
		}
		fctl := make([]byte, 26)
		binary.BigEndian.PutUint32(fctl[0:], seq)
		seq++
		binary.BigEndian.PutUint32(fctl[4:], uint32(st.rect.Dx()))
		binary.BigEndian.PutUint32(fctl[8:], uint32(st.rect.Dy()))
		binary.BigEndian.PutUint32(fctl[12:], uint32(st.rect.Min.X))
		binary.BigEndian.PutUint32(fctl[16:], uint32(st.rect.Min.Y))
		// The delay as a fraction of a second.
		ms := min(max(st.delay.Milliseconds(), 0), 65535)
		binary.BigEndian.PutUint16(fctl[20:], uint16(ms))
		binary.BigEndian.PutUint16(fctl[22:], 1000)
		fctl[24], fctl[25] = 0, 0 // dispose none, blend source
		writeChunk(&out, "fcTL", fctl)
		for _, d := range data {
			if i == 0 {
				writeChunk(&out, "IDAT", d)
				continue
			}
			fd := make([]byte, 4+len(d))
			binary.BigEndian.PutUint32(fd, seq)
			seq++
			copy(fd[4:], d)
			writeChunk(&out, "fdAT", fd)
		}
	}
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
