package server

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"

	"ravenryd/internal/proto"
	"ravenryd/internal/render"
)

// Picks (checkpoints.go): an agent shows 2 to 4 variants (pictures,
// pages, videos, or a shot of a pane taken now) and the person picks one,
// perhaps with a region of it (on a video: of the frame they paused on, at
// its time t) and a note ("this, but..."). The hub keeps the variants with
// the project in Ravenry's data.

const (
	minVariants = 2
	maxVariants = 4
	maxLabel    = 64
	// A variant's file, a video's too: the hub keeps a copy of each.
	maxVariantSize = 100 << 20
	// A region's time on a video, in seconds: a day at most.
	maxRegionTime = 86400
	maxNote       = 4000
)

// variantType is a file's type by its extension.
func variantType(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg":
		return "image"
	case ".html", ".htm":
		return "html"
	case ".mp4", ".m4v", ".mov", ".webm":
		return "video"
	}
	return ""
}

// stateDir is where the daemon keeps a pick's shots and a replay's
// recording.
func (s *Server) stateDir() string {
	if s.o.StateDir != "" {
		return s.o.StateDir
	}
	return filepath.Dir(s.o.Manager.LogDir())
}

func (s *Server) picksDir() string { return filepath.Join(s.stateDir(), "picks") }

// checkVariants checks a pick's variants, and takes the shots of the
// panes it names now, into files of the daemon's.
// maxDescription: the agent's words on a variant.
const maxDescription = 200

func (s *Server) checkVariants(in []proto.VariantRequest) ([]proto.Variant, error) {
	if len(in) < minVariants || len(in) > maxVariants {
		return nil, bad("a pick has %d to %d variants", minVariants, maxVariants)
	}
	seen := map[string]bool{}
	out := make([]proto.Variant, 0, len(in))
	for i, v := range in {
		if v.Label == "" || len(v.Label) > maxLabel || !plainText(v.Label) {
			return nil, bad("variant %d: label is 1 to %d bytes on one line", i, maxLabel)
		}
		if seen[v.Label] {
			return nil, bad("variant %d: label %q is taken", i, v.Label)
		}
		seen[v.Label] = true
		if len(v.Description) > maxDescription || !plainText(v.Description) {
			removeShots(out)
			return nil, bad("variant %d: description is at most %d bytes on one line", i, maxDescription)
		}
		if (v.Path == "") == (v.Pane == "") {
			removeShots(out)
			return nil, bad("variant %d: a file (path) or a pane to take a shot of (pane)", i)
		}
		if v.Pane != "" {
			f, size, err := s.shotFile(v.Pane)
			if err != nil {
				removeShots(out)
				return nil, err
			}
			out = append(out, proto.Variant{Label: v.Label, Description: v.Description, Path: f, Type: "image", Size: size, Pane: v.Pane})
			continue
		}
		if !filepath.IsAbs(v.Path) || len(v.Path) > 4096 {
			removeShots(out)
			return nil, bad("variant %d: path is absolute", i)
		}
		t := variantType(v.Path)
		if t == "" {
			removeShots(out)
			return nil, bad("variant %d: a picture (.png, .jpg, .gif, .webp, .svg), a page (.html) or a video (.mp4, .mov, .m4v, .webm)", i)
		}
		fi, err := os.Stat(v.Path)
		if err != nil || !fi.Mode().IsRegular() {
			removeShots(out)
			return nil, fmt.Errorf("variant %d: no file %s", i, v.Path)
		}
		if fi.Size() > maxVariantSize {
			removeShots(out)
			return nil, bad("variant %d: %s is over %d MiB", i, v.Path, maxVariantSize>>20)
		}
		out = append(out, proto.Variant{Label: v.Label, Description: v.Description, Path: v.Path, Type: t, Size: fi.Size()})
	}
	return out, nil
}

// shotFile renders a pane as it is now into a PNG of the daemon's.
func (s *Server) shotFile(id string) (string, int64, error) {
	p, err := s.o.Manager.Get(id)
	if err != nil {
		return "", 0, err
	}
	g, _, err := p.Grid()
	if err != nil {
		return "", 0, err
	}
	b, err := render.PNG(g, render.Options{Cursor: true})
	if err != nil {
		return "", 0, err
	}
	dir := s.picksDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", 0, err
	}
	var r [8]byte
	rand.Read(r[:])
	f := filepath.Join(dir, "shot-"+hex.EncodeToString(r[:])+".png")
	if err := os.WriteFile(f, b, 0o600); err != nil {
		return "", 0, err
	}
	return f, int64(len(b)), nil
}

// removeShots removes the shot files the daemon made for a pick.
func removeShots(vs []proto.Variant) {
	for _, v := range vs {
		if v.Pane != "" && strings.HasPrefix(filepath.Base(v.Path), "shot-") {
			os.Remove(v.Path)
		}
	}
}

func checkPick(p proto.Pick, vs []proto.Variant) (proto.Pick, error) {
	found := false
	for _, v := range vs {
		if v.Label == p.Label {
			found = true
		}
	}
	if !found {
		return proto.Pick{}, bad("pick.label is one of the variants' labels")
	}
	if len(p.Note) > maxNote || !textOK(p.Note) {
		return proto.Pick{}, bad("pick.note is at most %d bytes", maxNote)
	}
	if r := p.Region; r != nil {
		ok := func(f float64) bool { return !math.IsNaN(f) && f >= 0 && f <= 1 }
		if !ok(r.X) || !ok(r.Y) || !ok(r.W) || !ok(r.H) || r.W <= 0 || r.H <= 0 || r.X+r.W > 1.000001 || r.Y+r.H > 1.000001 {
			return proto.Pick{}, bad("pick.region is x, y, w and h, fractions of the variant from 0 to 1, inside it")
		}
		if t := r.T; t != nil && (math.IsNaN(*t) || *t < 0 || *t > maxRegionTime) {
			return proto.Pick{}, bad("pick.region.t is the time of the video's frame, in seconds from 0 to %d", maxRegionTime)
		}
		rr := *r
		if r.T != nil {
			t := *r.T
			rr.T = &t
		}
		p.Region = &rr
	}
	return p, nil
}
