package main

// A pick's videos: which codec each one is, read from the file's own
// headers, so `ravenry pick` can say when the card is made that a video
// will not play on some of the person's devices (the webm round,
// 2026-11-17). H.264 (.mp4, .mov, .m4v) and VP8 (.webm) play on every
// client; VP9, AV1 and HEVC only where the device decodes them.

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// videoCodec names the codec of a video's first video track ("h264",
// "hevc", "vp8", "vp9", "av1", another sample entry's name, or "" when the
// headers say nothing), and its container ("webm" for Matroska and WebM,
// "mp4" for the ISO family: .mp4, .mov, .m4v).
func videoCodec(b []byte) (codec, container string) {
	if len(b) >= 4 && bytes.Equal(b[:4], []byte{0x1a, 0x45, 0xdf, 0xa3}) {
		return ebmlCodec(b), "webm"
	}
	if len(b) >= 8 {
		switch string(b[4:8]) {
		case "ftyp", "moov", "mdat", "wide", "free", "skip":
			return isoCodec(b), "mp4"
		}
	}
	return "", ""
}

// ebmlCodec: the first video CodecID element (0x86) of a Matroska file.
func ebmlCodec(b []byte) string {
	if len(b) > 4<<20 {
		b = b[:4<<20]
	}
	for i := 0; i+2 < len(b); i++ {
		if b[i] != 0x86 || b[i+1]&0x80 == 0 {
			continue
		}
		n := int(b[i+1] & 0x7f)
		if n < 3 || i+2+n > len(b) || b[i+2] != 'V' || b[i+3] != '_' {
			continue
		}
		switch id := string(b[i+2 : i+2+n]); {
		case id == "V_VP8":
			return "vp8"
		case id == "V_VP9":
			return "vp9"
		case id == "V_AV1":
			return "av1"
		case strings.HasPrefix(id, "V_MPEG4/ISO/AVC"):
			return "h264"
		case strings.HasPrefix(id, "V_MPEGH/ISO/HEVC"):
			return "hevc"
		default:
			return strings.ToLower(strings.TrimPrefix(id, "V_"))
		}
	}
	return ""
}

// isoBoxes calls f with each box's type and body in b, in order, until f says stop.
func isoBoxes(b []byte, f func(typ string, body []byte) bool) {
	for len(b) >= 8 {
		size := uint64(binary.BigEndian.Uint32(b))
		typ := string(b[4:8])
		head := uint64(8)
		switch size {
		case 0:
			size = uint64(len(b))
		case 1:
			if len(b) < 16 {
				return
			}
			size, head = binary.BigEndian.Uint64(b[8:]), 16
		}
		if size < head || size > uint64(len(b)) {
			return
		}
		if !f(typ, b[head:size]) {
			return
		}
		b = b[size:]
	}
}

// isoCodec: the sample entry of the first track whose handler is video.
func isoCodec(b []byte) string {
	codec := ""
	child := func(body []byte, want string) []byte {
		var out []byte
		isoBoxes(body, func(t string, x []byte) bool {
			if t == want {
				out = x
				return false
			}
			return true
		})
		return out
	}
	isoBoxes(b, func(t string, moov []byte) bool {
		if t != "moov" {
			return true
		}
		isoBoxes(moov, func(t string, trak []byte) bool {
			if t != "trak" {
				return true
			}
			mdia := child(trak, "mdia")
			hdlr := child(mdia, "hdlr")
			if len(hdlr) < 12 || string(hdlr[8:12]) != "vide" {
				return true
			}
			stsd := child(child(child(mdia, "minf"), "stbl"), "stsd")
			if len(stsd) < 16 {
				return true
			}
			switch e := string(stsd[12:16]); e {
			case "avc1", "avc3":
				codec = "h264"
			case "hvc1", "hev1", "dvh1", "dvhe":
				codec = "hevc"
			case "av01":
				codec = "av1"
			case "vp09":
				codec = "vp9"
			case "vp08":
				codec = "vp8"
			default:
				codec = strings.TrimSpace(e)
			}
			return false
		})
		return false
	})
	return codec
}

var (
	videoTag  = regexp.MustCompile(`(?is)<video\b([^>]*)>(.*?)(?:</video\s*>|$)`)
	sourceTag = regexp.MustCompile(`(?i)<source\b([^>]*)>`)
	srcAttr   = regexp.MustCompile(`(?i)\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`)
	dataURI   = regexp.MustCompile(`(?is)^data:([\w.+/-]+)((?:;[\w=.-]+)*?)(;base64)?,(.*)$`)
)

// pageVideoBytes: the video a page holds as the hub finds it (its first
// <video>'s src, or its first <source>'s: a data: URI, or a file beside the
// page), else nil.
func pageVideoBytes(html []byte, pagePath string) []byte {
	m := videoTag.FindSubmatch(html)
	if m == nil {
		return nil
	}
	attr := func(tag []byte) string {
		a := srcAttr.FindSubmatch(tag)
		if a == nil {
			return ""
		}
		for _, x := range a[1:] {
			if len(x) > 0 {
				return strings.TrimSpace(strings.ReplaceAll(string(x), "&amp;", "&"))
			}
		}
		return ""
	}
	src := attr(m[1])
	if src == "" {
		if s := sourceTag.FindSubmatch(m[2]); s != nil {
			src = attr(s[1])
		}
	}
	if src == "" {
		return nil
	}
	if d := dataURI.FindStringSubmatch(src); d != nil {
		if d[3] == "" {
			s, err := url.PathUnescape(d[4])
			if err != nil {
				return nil
			}
			return []byte(s)
		}
		out, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(d[4]), ""))
		if err != nil {
			return nil
		}
		return out
	}
	if regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*:`).MatchString(src) && !strings.HasPrefix(strings.ToLower(src), "file:") {
		return nil
	}
	f := regexp.MustCompile(`[?#].*$`).ReplaceAllString(src, "")
	f = strings.TrimPrefix(strings.TrimPrefix(f, "file://"), "FILE://")
	if u, err := url.PathUnescape(f); err == nil {
		f = u
	}
	if !filepath.IsAbs(f) {
		f = filepath.Join(filepath.Dir(pagePath), f)
	}
	b, err := os.ReadFile(f)
	if err != nil || len(b) > maxPickVideo {
		return nil
	}
	return b
}

// maxPickVideo: the hub keeps a video of up to 100 MiB (ravenryd's maxVariantSize).
const maxPickVideo = 100 << 20

// codecWhere: for a codec that plays on some clients only, where (measured
// on the clients, docs/FEATURES.md PANEL-039). H.264 and VP8 play on every
// one.
var codecWhere = map[string]string{
	"vp9":  "VP9 plays in the Mac app, on the board and in the Android app, but in the iPhone and iPad app only where the device decodes VP9 (the iOS simulator does not)",
	"av1":  "AV1 plays on the board in Chrome and in the Android app, but not in the Mac app, the iPhone and iPad app or Safari on an M1 or M2 Mac or an iPhone before the 15 Pro",
	"hevc": "HEVC plays in the Mac app, the iPhone and iPad app and Safari, but not on the board in every browser or on every Android phone",
}

// pickVideoNotes: a line for each video (a variant's own, a page's) that
// will not play on every client, naming them and what to use instead.
func pickVideoNotes(vs []map[string]any) []string {
	var notes []string
	for _, v := range vs {
		p, _ := v["path"].(string)
		if p == "" {
			continue
		}
		ext := strings.ToLower(filepath.Ext(p))
		var b []byte
		switch ext {
		case ".mp4", ".m4v", ".mov", ".webm":
			fi, err := os.Stat(p)
			if err != nil || fi.Size() > maxPickVideo {
				continue
			}
			b, _ = os.ReadFile(p)
		case ".html", ".htm":
			if h, err := os.ReadFile(p); err == nil && len(h) <= maxPickVideo {
				b = pageVideoBytes(h, p)
			}
		}
		codec, _ := videoCodec(b)
		where, ok := codecWhere[codec]
		if !ok {
			continue
		}
		in := ""
		if ext == ".html" || ext == ".htm" {
			in = "the video in "
		}
		notes = append(notes, fmt.Sprintf("ravenry pick: %v: %s%s is %s video. %s; where it does not, the card shows \"This video can't play here\". For a video that plays everywhere, make it H.264 .mp4 (or VP8 .webm).", v["label"], in, filepath.Base(p), strings.ToUpper(codec), where))
	}
	return notes
}
