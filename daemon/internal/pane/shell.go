package pane

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Shell integration: the shells ravenryd starts (zsh, bash and fish) get
// OSC 133 prompt marks (A, B, C with the command line, D with the exit
// status) and OSC 7 for the working folder: the integration is
// injected when the shell starts, and the user's own
// startup files run as they always do and are never changed.
//
//   - zsh: ZDOTDIR names a folder whose .zshenv gives ZDOTDIR back, runs
//     the user's .zshenv and loads the integration.
//   - bash 4 and newer: bash --posix with ENV naming a file that leaves
//     POSIX mode and runs the user's startup files as bash would have.
//   - bash 3.2 (macOS's /bin/bash, which reads its usual files even in
//     POSIX mode): PROMPT_COMMAND in the environment loads the integration
//     at the first prompt.
//   - fish: XDG_DATA_DIRS starts with a folder whose
//     fish/vendor_conf.d holds the integration.
//
// RAVENRY_SHELL_INTEGRATION=0 (or off, no, false), in the pane's env or
// the daemon's environment, starts the shell as it is.

//go:embed all:shell
var shellFiles embed.FS

// ShellIntegrationEnv is the variable that turns shell integration off.
const ShellIntegrationEnv = "RAVENRY_SHELL_INTEGRATION"

// installShell writes the integration files into a folder of base named
// after their content, so daemons of different versions never share
// one, and returns it.
func installShell(base string) (string, error) {
	h := sha256.New()
	var files []string
	err := fs.WalkDir(shellFiles, "shell", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := shellFiles.ReadFile(p)
		if err != nil {
			return err
		}
		h.Write([]byte(p + "\x00"))
		h.Write(b)
		files = append(files, p)
		return nil
	})
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, hex.EncodeToString(h.Sum(nil))[:12])
	if _, err := os.Stat(filepath.Join(dir, ".complete")); err == nil {
		return dir, nil
	}
	if err := os.MkdirAll(base, 0o700); err != nil {
		return "", err
	}
	tmp, err := os.MkdirTemp(base, ".new-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmp)
	for _, p := range files {
		b, _ := shellFiles.ReadFile(p)
		dst := filepath.Join(tmp, strings.TrimPrefix(p, "shell/"))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return "", err
		}
		if err := os.WriteFile(dst, b, 0o644); err != nil {
			return "", err
		}
	}
	if err := os.WriteFile(filepath.Join(tmp, ".complete"), nil, 0o644); err != nil {
		return "", err
	}
	if err := os.Chmod(tmp, 0o755); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, dir); err != nil {
		// Another daemon wrote the same files first.
		if _, serr := os.Stat(filepath.Join(dir, ".complete")); serr != nil {
			return "", err
		}
	}
	return dir, nil
}

// shellOff reports whether the pane asked for no shell integration.
func shellOff(extra map[string]string, env []string) bool {
	switch strings.ToLower(envValue(ShellIntegrationEnv, extra, env)) {
	case "0", "off", "no", "false":
		return true
	}
	return false
}

// envLookup returns a variable as the pane will see it, and whether it is
// set at all.
func envLookup(key string, extra map[string]string, env []string) (string, bool) {
	if v, ok := extra[key]; ok {
		return v, true
	}
	val, found := "", false
	for _, kv := range env {
		if k, v, ok := strings.Cut(kv, "="); ok && k == key {
			val, found = v, true
		}
	}
	return val, found
}

// injectShell sets up shell integration for the command cmd is about to
// run, when it is zsh, bash or fish: it may change cmd.Args, and returns
// the variables to add to the pane's environment (nil for none).
func injectShell(dir string, cmd *exec.Cmd, extra map[string]string, env []string) map[string]string {
	if dir == "" || shellOff(extra, env) {
		return nil
	}
	switch filepath.Base(cmd.Path) {
	case "zsh":
		out := map[string]string{"ZDOTDIR": filepath.Join(dir, "zsh")}
		if v, ok := envLookup("ZDOTDIR", extra, env); ok {
			out["RAVENRY_ZSH_ZDOTDIR"] = v
		}
		return out
	case "fish":
		out := map[string]string{"RAVENRY_FISH_XDG_DIR": dir}
		xdg, _ := envLookup("XDG_DATA_DIRS", extra, env)
		if xdg == "" {
			// Unset, fish reads its own defaults: these, and the
			// integration unsets it again.
			xdg = "/usr/local/share:/usr/share"
			out["RAVENRY_FISH_XDG_UNSET"] = "1"
		}
		out["XDG_DATA_DIRS"] = dir + ":" + xdg
		return out
	case "bash":
		return injectBash(dir, cmd, extra, env)
	}
	return nil
}

// injectBash handles an interactive bash: its options are only those
// that leave it interactive (-l, --login, -i, --norc, --noprofile,
// --rcfile); anything else (-c, a script, other options) is started as
// it is.
func injectBash(dir string, cmd *exec.Cmd, extra map[string]string, env []string) map[string]string {
	keep := []string{cmd.Args[0]}
	inject := "1"
	rcfile := ""
	args := cmd.Args[1:]
	for i := 0; i < len(args); i++ {
		switch a := args[i]; a {
		case "-l", "--login", "-i":
			keep = append(keep, a)
		case "--norc", "--noprofile":
			inject += " " + a
		case "--rcfile", "--init-file":
			if i+1 == len(args) {
				return nil
			}
			i++
			rcfile = args[i]
		default:
			return nil
		}
	}
	script := filepath.Join(dir, "bash", "ravenry.bash")
	if bashMajor(cmd.Path) >= 4 {
		cmd.Args = append([]string{keep[0], "--posix"}, keep[1:]...)
		out := map[string]string{"ENV": script, "RAVENRY_BASH_INJECT": inject}
		if rcfile != "" {
			out["RAVENRY_BASH_RCFILE"] = rcfile
		}
		if v, ok := envLookup("ENV", extra, env); ok {
			out["RAVENRY_BASH_ENV"] = v
		}
		return out
	}
	boot := "builtin source '" + strings.ReplaceAll(script, "'", `'\''`) + "'"
	out := map[string]string{"PROMPT_COMMAND": boot, "RAVENRY_BASH_BOOT": boot}
	if v, ok := envLookup("PROMPT_COMMAND", extra, env); ok {
		out["RAVENRY_BASH_PROMPT_COMMAND"] = v
	}
	return out
}

var bashVersions = struct {
	sync.Mutex
	m map[string]int
}{m: map[string]int{}}

// bashMajor is the major version of a bash, or 0 when it cannot tell.
// It runs the bash once per executable (keyed by path, size and time).
func bashMajor(path string) int {
	fi, err := os.Stat(path)
	if err != nil {
		return 0
	}
	key := path + "\x00" + strconv.FormatInt(fi.Size(), 10) + "\x00" + fi.ModTime().String()
	bashVersions.Lock()
	v, ok := bashVersions.m[key]
	bashVersions.Unlock()
	if ok {
		return v
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, path, "--norc", "--noprofile", "-c", `echo "${BASH_VERSINFO[0]}"`)
	c.Env = []string{"PATH=/usr/bin:/bin"}
	b, err := c.Output()
	if err == nil {
		v, _ = strconv.Atoi(strings.TrimSpace(string(b)))
	}
	bashVersions.Lock()
	bashVersions.m[key] = v
	bashVersions.Unlock()
	return v
}

// withEnv sets variables in an environment list.
func withEnv(list []string, set map[string]string) []string {
	if len(set) == 0 {
		return list
	}
	out := list[:0:0]
	for _, kv := range list {
		k, _, _ := strings.Cut(kv, "=")
		if _, ok := set[k]; !ok {
			out = append(out, kv)
		}
	}
	for k, v := range set {
		out = append(out, k+"="+v)
	}
	return out
}
