package pane

import (
	"bufio"
	"os"
	"os/exec"
	"os/user"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

// The account's login shell, for a daemon started with no $SHELL: launchd
// gives its agents none, so a daemon the app's hub service started opened
// /bin/sh, with no shell integration, and a session waited 4 s for a prompt
// it never saw (2026-11-07). macOS keeps it in Directory Services (dscl),
// Linux in /etc/passwd. "" when it cannot be found.
var (
	accountShellOnce sync.Once
	accountShellPath string
)

func accountShell() string {
	accountShellOnce.Do(func() { accountShellPath = lookupAccountShell() })
	return accountShellPath
}

func lookupAccountShell() string {
	u, err := user.Current()
	if err != nil {
		return ""
	}
	ok := func(sh string) string {
		sh = strings.TrimSpace(sh)
		if fi, err := os.Stat(sh); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 && strings.HasPrefix(sh, "/") {
			return sh
		}
		return ""
	}
	if runtime.GOOS == "darwin" {
		out, err := exec.Command("/usr/bin/dscl", ".", "-read", "/Users/"+u.Username, "UserShell").Output()
		if err != nil {
			return ""
		}
		_, v, found := strings.Cut(string(out), "UserShell:")
		if !found {
			return ""
		}
		return ok(v)
	}
	f, err := os.Open("/etc/passwd")
	if err != nil {
		return ""
	}
	defer f.Close()
	uid := strconv.Itoa(os.Getuid())
	s := bufio.NewScanner(f)
	for s.Scan() {
		parts := strings.Split(s.Text(), ":")
		if len(parts) >= 7 && parts[2] == uid {
			return ok(parts[6])
		}
	}
	return ""
}

// loginShell is $SHELL, else the account's login shell, else /bin/sh.
func loginShell(extra map[string]string, env []string) string {
	if sh := envValue("SHELL", extra, env); sh != "" {
		return sh
	}
	if sh := accountShell(); sh != "" {
		return sh
	}
	return "/bin/sh"
}
