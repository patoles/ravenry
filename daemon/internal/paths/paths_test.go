package paths

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCompareVersions(t *testing.T) {
	order := []string{"0.0.0-dev", "0.1.0-rc.1", "0.1.0-rc.2", "0.1.0", "0.1.1", "0.2.0", "1.0.0-alpha", "1.0.0", "1.10.0"}
	for i := range order {
		for j := range order {
			want := 0
			if i < j {
				want = -1
			} else if i > j {
				want = 1
			}
			if got := CompareVersions(order[i], order[j]); got != want {
				t.Errorf("CompareVersions(%q, %q) = %d, want %d", order[i], order[j], got, want)
			}
		}
	}
}

func TestPrivateDir(t *testing.T) {
	base := t.TempDir()
	d := filepath.Join(base, "a", "b")
	if err := EnsurePrivateDir(d); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(d)
	if fi.Mode().Perm() != 0o700 {
		t.Fatalf("mode %v", fi.Mode().Perm())
	}
	if err := os.Chmod(d, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := EnsurePrivateDir(d); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(d); fi.Mode().Perm() != 0o700 {
		t.Fatalf("an open directory was not closed: %v", fi.Mode().Perm())
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(d, link); err != nil {
		t.Fatal(err)
	}
	if err := EnsurePrivateDir(link); err == nil {
		t.Fatal("a symlink was accepted")
	}
}

func TestSocketsNewestFirst(t *testing.T) {
	dir, err := os.MkdirTemp("", "rv")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	t.Setenv("RAVENRY_RUNTIME_DIR", dir)
	for _, v := range []string{"0.1.0", "0.10.0", "0.2.0", "0.0.0-dev"} {
		p, err := SocketPath(v)
		if err != nil {
			t.Fatal(err)
		}
		l, err := net.Listen("unix", p)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { l.Close() })
	}
	os.WriteFile(filepath.Join(dir, "ravenryd-9.9.9.sock"), nil, 0o600) // not a socket
	got, err := Sockets()
	if err != nil {
		t.Fatal(err)
	}
	var vs []string
	for _, s := range got {
		vs = append(vs, s.Version)
	}
	want := []string{"0.10.0", "0.2.0", "0.1.0", "0.0.0-dev"}
	if len(vs) != len(want) {
		t.Fatalf("versions %v", vs)
	}
	for i := range want {
		if vs[i] != want[i] {
			t.Fatalf("versions %v, want %v", vs, want)
		}
	}
}

func TestSocketPathTooLong(t *testing.T) {
	long := filepath.Join(t.TempDir(), strings.Repeat("a", 120))
	t.Setenv("RAVENRY_RUNTIME_DIR", long)
	if _, err := SocketPath("0.1.0"); err == nil {
		t.Fatal("an over-long socket path was accepted")
	}
}
