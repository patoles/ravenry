package server

import (
	"encoding/base64"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"ravenryd/internal/proto"
)

// file.stat and file.read: files on the daemon's machine, read as the
// user the daemon runs as. The hub reads a remote session's transcript
// and brief through them for the hand-off, since they are on the machine
// the session runs on. A program in a pane could read the same files.

const (
	maxStatPaths     = 64
	defaultFileLimit = 1 << 20
	maxFileLimit     = 8 << 20
	maxPathLen       = 4096
)

func checkPath(p string) error {
	if p == "" || len(p) > maxPathLen || !filepath.IsAbs(p) || strings.ContainsRune(p, 0) {
		return bad("a path is absolute, at most %d bytes", maxPathLen)
	}
	return nil
}

func (c *conn) fileStat(id uint64, data []byte) {
	var r proto.FileStatRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	if len(r.Paths) == 0 || len(r.Paths) > maxStatPaths {
		c.failErr(id, bad("paths holds 1 to %d paths", maxStatPaths))
		return
	}
	res := proto.FileStatResult{Files: make([]proto.FileInfo, 0, len(r.Paths))}
	for _, p := range r.Paths {
		if err := checkPath(p); err != nil {
			c.failErr(id, err)
			return
		}
		fi := proto.FileInfo{Path: p, Type: "none"}
		if st, err := os.Stat(p); err == nil {
			switch {
			case st.Mode().IsRegular():
				fi.Type = "file"
			case st.IsDir():
				fi.Type = "dir"
			default:
				fi.Type = "other"
			}
			size := st.Size()
			fi.Size = &size
			fi.ModifiedAt = stamp(st.ModTime())
		}
		res.Files = append(res.Files, fi)
	}
	c.reply(id, "file.stat", res)
}

func (c *conn) fileRead(id uint64, data []byte) {
	var r proto.FileReadRequest
	if err := decode(data, &r); err != nil {
		c.failErr(id, err)
		return
	}
	if err := checkPath(r.Path); err != nil {
		c.failErr(id, err)
		return
	}
	if r.Offset != nil && r.Tail != nil {
		c.failErr(id, bad("give offset or tail, not both"))
		return
	}
	if (r.Offset != nil && *r.Offset < 0) || (r.Tail != nil && *r.Tail < 1) {
		c.failErr(id, bad("offset is 0 or more, tail 1 or more"))
		return
	}
	limit := defaultFileLimit
	if r.Limit != nil {
		if *r.Limit < 1 || *r.Limit > maxFileLimit {
			c.failErr(id, bad("limit must be between 1 and %d", maxFileLimit))
			return
		}
		limit = *r.Limit
	}
	format := r.Format
	if format == "" {
		format = "text"
	}
	if format != "text" && format != "raw" {
		c.failErr(id, bad("format must be text or raw"))
		return
	}
	f, err := os.Open(r.Path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			c.failErr(id, notFound("no file %s", r.Path))
		} else {
			c.failErr(id, err)
		}
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		c.failErr(id, err)
		return
	}
	if !st.Mode().IsRegular() {
		c.failErr(id, errors.New(r.Path+" is not a regular file"))
		return
	}
	size := st.Size()
	from := int64(0)
	if r.Offset != nil {
		from = min(*r.Offset, size)
	} else if r.Tail != nil {
		from = max(0, size-*r.Tail)
	}
	n := min(int64(limit), size-from)
	if r.Tail != nil {
		// The tail's end is the file's end; a limit shorter than the tail
		// keeps its last bytes.
		if size-from > int64(limit) {
			from = size - int64(limit)
		}
		n = size - from
	}
	buf := make([]byte, n)
	got, err := f.ReadAt(buf, from)
	if err != nil && !errors.Is(err, io.EOF) {
		c.failErr(id, err)
		return
	}
	buf = buf[:got]
	res := proto.FileReadResult{Path: r.Path, Size: size, ModifiedAt: stamp(st.ModTime()), From: from, To: from + int64(got)}
	if format == "raw" {
		s := base64.StdEncoding.EncodeToString(buf)
		res.Data = &s
	} else {
		t := string(buf)
		if !utf8.ValidString(t) {
			t = strings.ToValidUTF8(t, "�")
		}
		res.Text = &t
	}
	c.reply(id, "file.read", res)
}
