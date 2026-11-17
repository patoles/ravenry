package main

import (
	"encoding/base64"
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func box(typ string, body ...[]byte) []byte {
	n := 8
	for _, b := range body {
		n += len(b)
	}
	out := make([]byte, 8, n)
	binary.BigEndian.PutUint32(out, uint32(n))
	copy(out[4:], typ)
	for _, b := range body {
		out = append(out, b...)
	}
	return out
}

// isoWith: an ISO file whose tracks are an audio track, then a video track of sample entry `entry`.
func isoWith(entry string) []byte {
	trak := func(handler, entry string) []byte {
		hdlr := box("hdlr", make([]byte, 8), []byte(handler), make([]byte, 12))
		stsd := box("stsd", []byte{0, 0, 0, 0, 0, 0, 0, 1}, box(entry, make([]byte, 20)))
		return box("trak", box("tkhd", make([]byte, 20)), box("mdia", box("mdhd", make([]byte, 20)), hdlr, box("minf", box("stbl", stsd))))
	}
	return append(box("ftyp", []byte("isom\x00\x00\x02\x00")), box("moov", box("mvhd", make([]byte, 100)), trak("soun", "mp4a"), trak("vide", entry))...)
}

func ebmlWith(id string) []byte {
	b := []byte{0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84, 'w', 'e', 'b', 'm'}
	// An audio track's CodecID first (A_OPUS), then the video's.
	b = append(b, 0x86, 0x80|6)
	b = append(b, "A_OPUS"...)
	b = append(b, 0x86, byte(0x80|len(id)))
	return append(b, id...)
}

func TestVideoCodecReadsTheHeaders(t *testing.T) {
	for _, c := range []struct {
		name, codec, container string
		b                      []byte
	}{
		{"webm vp8", "vp8", "webm", ebmlWith("V_VP8")},
		{"webm vp9", "vp9", "webm", ebmlWith("V_VP9")},
		{"webm av1", "av1", "webm", ebmlWith("V_AV1")},
		{"mkv h264", "h264", "webm", ebmlWith("V_MPEG4/ISO/AVC")},
		{"mp4 h264", "h264", "mp4", isoWith("avc1")},
		{"mov hevc", "hevc", "mp4", isoWith("hvc1")},
		{"mp4 av1", "av1", "mp4", isoWith("av01")},
		{"mp4 vp9", "vp9", "mp4", isoWith("vp09")},
		{"a picture", "", "", []byte("\x89PNG\r\n\x1a\n0000")},
		{"nothing", "", "", nil},
	} {
		codec, container := videoCodec(c.b)
		if codec != c.codec || container != c.container {
			t.Errorf("%s: %q %q, want %q %q", c.name, codec, container, c.codec, c.container)
		}
	}
}

// A real file of each, made with ffmpeg when it is there.
func TestVideoCodecOfRealFiles(t *testing.T) {
	ff, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("no ffmpeg")
	}
	dir := t.TempDir()
	for _, c := range []struct {
		file, codec string
		args        []string
	}{
		{"a.webm", "vp8", []string{"-c:v", "libvpx"}},
		{"b.webm", "vp9", []string{"-c:v", "libvpx-vp9"}},
		{"c.mp4", "h264", []string{"-c:v", "libx264", "-pix_fmt", "yuv420p"}},
		{"d.mov", "h264", []string{"-c:v", "libx264", "-pix_fmt", "yuv420p"}},
		{"e.webm", "av1", []string{"-c:v", "libsvtav1"}},
	} {
		f := filepath.Join(dir, c.file)
		args := append([]string{"-v", "quiet", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=1"}, c.args...)
		if err := exec.Command(ff, append(args, "-y", f)...).Run(); err != nil {
			t.Logf("%s: this ffmpeg cannot make it: %v", c.file, err)
			continue
		}
		b, _ := os.ReadFile(f)
		if got, _ := videoCodec(b); got != c.codec {
			t.Errorf("%s: %q, want %q", c.file, got, c.codec)
		}
	}
}

func TestPickVideoNotes(t *testing.T) {
	dir := t.TempDir()
	av1 := filepath.Join(dir, "clip.webm")
	os.WriteFile(av1, ebmlWith("V_AV1"), 0o600)
	vp9 := filepath.Join(dir, "ok.webm") // VP9: plays everywhere but on an iPhone or iPad without its decoder
	os.WriteFile(vp9, ebmlWith("V_VP9"), 0o600)
	h264 := filepath.Join(dir, "ok.mp4")
	os.WriteFile(h264, isoWith("avc1"), 0o600)
	hevc := filepath.Join(dir, "phone.mov")
	os.WriteFile(hevc, isoWith("hvc1"), 0o600)
	page := filepath.Join(dir, "page.html")
	os.WriteFile(page, []byte(`<video controls><source src="data:video/webm;base64,`+base64.StdEncoding.EncodeToString(ebmlWith("V_AV1"))+`" type="video/webm"></video>`), 0o600)
	beside := filepath.Join(dir, "beside.html")
	os.WriteFile(beside, []byte(`<video src="clip.webm"></video>`), 0o600)
	plain := filepath.Join(dir, "plain.html")
	os.WriteFile(plain, []byte(`<p>no video</p>`), 0o600)
	vs := []map[string]any{{"label": "A", "path": av1}, {"label": "B", "path": vp9}, {"label": "C", "path": h264}, {"label": "D", "path": hevc}, {"label": "E", "path": page}, {"label": "F", "path": beside}, {"label": "G", "path": plain}, {"label": "H", "pane": "p1"}}
	notes := pickVideoNotes(vs)
	if len(notes) != 5 {
		t.Fatalf("%d notes, want 5 (A, B, D, E, F): %q", len(notes), notes)
	}
	for i, want := range []string{"A: clip.webm is AV1 video", "B: ok.webm is VP9 video", "D: phone.mov is HEVC video", "E: the video in page.html is AV1 video", "F: the video in beside.html is AV1 video"} {
		if !strings.Contains(notes[i], want) || !strings.Contains(notes[i], "make it H.264 .mp4") || !strings.Contains(notes[i], "This video can't play here") {
			t.Errorf("note %d: %q, want %q, the words the card shows and what to use", i, notes[i], want)
		}
	}
}
