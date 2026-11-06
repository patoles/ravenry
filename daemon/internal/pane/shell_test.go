package pane

import (
	"context"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"ravenryd/internal/testenv"
	"regexp"
	"strings"
	"testing"
	"time"
)

// shellHome makes a throwaway HOME whose startup files for each shell
// export marks the test reads back, set their own prompt, and (bash)
// add to PROMPT_COMMAND, so the test proves the user's own files still
// run as they would without the integration.
func shellHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	files := map[string]string{
		// skip_global_compinit: Debian's /etc/zsh/zshrc runs compinit,
		// which on a CI runner stops at a question about insecure folders.
		".zshenv":   "export ENV_MARK=zshenv-ok\nskip_global_compinit=1\n",
		".zprofile": "export PROFILE_MARK=zprofile-ok\n",
		".zshrc":    "export RC_MARK=zshrc-ok\nPS1='zsh-user> '\n",
		".bash_profile": "export PROFILE_MARK=bash_profile-ok\n" +
			"[ -r ~/.bashrc ] && . ~/.bashrc\n",
		".bashrc": "export RC_MARK=bashrc-ok\nPS1='bash-user> '\n" +
			"PROMPT_COMMAND=\"${PROMPT_COMMAND:+$PROMPT_COMMAND;}USER_PC=ran\"\n",
		".config/fish/config.fish": "set -gx RC_MARK fish-ok\n" +
			"if status is-login; set -gx PROFILE_MARK fish-login-ok; end\n" +
			"function fish_prompt; echo -n 'fish-user> '; end\n",
	}
	for name, body := range files {
		p := filepath.Join(home, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return home
}

func shellManager(t *testing.T, home, shellPath string) *Manager {
	t.Helper()
	env := []string{"PATH=" + filepath.Dir(shellPath) + ":/usr/bin:/bin", "HOME=" + home, "LANG=en_US.UTF-8",
		"SHELL=" + shellPath, "BASH_SILENCE_DEPRECATION_WARNING=1"}
	logs, shells := t.TempDir(), filepath.Join(t.TempDir(), "state dir", "shell")
	testenv.Check(t, env)
	testenv.CheckDirs(t, logs, shells)
	m := NewManager(ManagerOptions{
		// A space, as in macOS's "Application Support".
		LogDir: logs, ShellDir: shells, Env: env,
	})
	t.Cleanup(func() { m.Shutdown(time.Second) })
	if m.shell == "" {
		t.Fatal("the shell integration files were not written")
	}
	return m
}

// run types a command line and waits for the next prompt.
func run(t *testing.T, p *Pane, line string) *WaitResult {
	t.Helper()
	mark := p.Mark()
	if err := p.Input([]byte(line + "\r")); err != nil {
		t.Fatal(err)
	}
	r, err := p.Wait(context.Background(), WaitSpec{Prompt: true, Since: &mark, Timeout: 10 * time.Second}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if r.Condition != "prompt" {
		t.Fatalf("%q: no prompt after it (%s); screen %q", line, r.Condition, r.Screen)
	}
	return r
}

func TestShellIntegration(t *testing.T) {
	type tc struct {
		shell string
		login bool
		args  []string // for a shell started by command
	}
	var cases []tc
	for _, sh := range []string{"zsh", "bash", "fish"} {
		path, err := exec.LookPath(sh)
		if err != nil {
			t.Logf("%s: not installed, skipped", sh)
			continue
		}
		cases = append(cases, tc{shell: path, login: true}, tc{shell: path, args: []string{path}})
		if sh == "bash" {
			cases = append(cases, tc{shell: path, args: []string{path, "--norc"}})
		}
	}
	if len(cases) == 0 {
		t.Skip("no zsh, bash or fish")
	}
	for _, c := range cases {
		name := filepath.Base(c.shell)
		what := "login"
		if !c.login {
			what = strings.Join(c.args[1:], " ")
			if what == "" {
				what = "interactive"
			}
		}
		t.Run(name+" "+what, func(t *testing.T) {
			home := shellHome(t)
			m := shellManager(t, home, c.shell)
			cwd := filepath.Join(t.TempDir(), "a folder")
			os.Mkdir(cwd, 0o700)
			p := newPane(t, m, Config{Command: c.args, Cwd: cwd, Cols: 200})
			norc := len(c.args) > 1 && c.args[1] == "--norc"

			// The first prompt is marked.
			r, err := p.Wait(context.Background(), WaitSpec{Prompt: true, Since: new(uint64), Timeout: 10 * time.Second}, nil)
			if err != nil || r.Condition != "prompt" {
				t.Fatalf("no marked first prompt: %v %+v", err, r)
			}
			// The user's own files ran, with their prompt.
			r = run(t, p, `echo "marks:$RC_MARK:$PROFILE_MARK:$ENV_MARK:"`)
			want := map[string]string{
				"zsh login": "marks:zshrc-ok:zprofile-ok:zshenv-ok:", "zsh interactive": "marks:zshrc-ok::zshenv-ok:",
				"bash login": "marks:bashrc-ok:bash_profile-ok::", "bash interactive": "marks:bashrc-ok:::",
				"bash --norc": "marks::::",
				"fish login":  "marks:fish-ok:fish-login-ok::", "fish interactive": "marks:fish-ok:::",
			}[name+" "+what]
			if !strings.Contains(r.Output, want) {
				t.Fatalf("the user's startup files: want %q in %q", want, r.Output)
			}
			if !norc {
				if lines, _ := p.Text(); !strings.Contains(strings.Join(lines, "\n"), name+"-user> ") {
					t.Fatalf("the user's prompt is gone: %q", lines)
				}
			}

			// A command's status and its command line. (bash: the first
			// line after start may not count when the user's files added
			// to PROMPT_COMMAND, so this is the second.)
			run(t, p, `sh -c 'exit 3'`)
			sh := p.Info().Shell
			if sh == nil || sh.State != "prompt" || sh.ExitCode == nil || *sh.ExitCode != 3 || sh.Command != `sh -c 'exit 3'` {
				t.Fatalf("after exit 3: %+v", sh)
			}
			run(t, p, "true")
			if sh := p.Info().Shell; sh.ExitCode == nil || *sh.ExitCode != 0 || sh.Command != "true" {
				t.Fatalf("after true: %+v", sh)
			}
			// OSC 7 names the folder, percent-encoded.
			all, _, _, err := p.Read(0, 1<<20)
			if err != nil {
				t.Fatal(err)
			}
			real, _ := filepath.EvalSymlinks(cwd)
			found := false
			for _, m := range regexp.MustCompile(`\x1b\]7;file://[^/\x07]*(/[^\x07]*)\x07`).FindAllSubmatch(all, -1) {
				if dir, err := url.PathUnescape(string(m[1])); err == nil && (dir == cwd || dir == real) {
					found = true
				}
			}
			if !found {
				t.Fatalf("no OSC 7 for %s in %q", cwd, all)
			}
			// Nothing of the injection is left for the shell's children.
			r = run(t, p, `env | grep -E '^(ZDOTDIR|ENV|PROMPT_COMMAND|RAVENRY_(ZSH|BASH|FISH)_[A-Z_]*)=' ; echo env-checked`)
			if out := strings.TrimSpace(strings.ReplaceAll(r.Output, "\r", "")); !regexp.MustCompile(`(?m)^env-checked$`).MatchString(out) || regexp.MustCompile(`(?m)^(ZDOTDIR|ENV|PROMPT_COMMAND|RAVENRY_\w+)=`).MatchString(out) {
				t.Fatalf("left in the environment: %q", out)
			}
		})
	}
}

// RAVENRY_SHELL_INTEGRATION=0 starts the shell as it is.
func TestShellIntegrationOptOut(t *testing.T) {
	for _, sh := range []string{"zsh", "bash"} {
		path, err := exec.LookPath(sh)
		if err != nil {
			continue
		}
		t.Run(sh, func(t *testing.T) {
			home := shellHome(t)
			m := shellManager(t, home, path)
			p := newPane(t, m, Config{Env: map[string]string{ShellIntegrationEnv: "0"}})
			if len(p.cmd.Args) != 1 {
				t.Fatalf("args changed: %q", p.cmd.Args)
			}
			waitText(t, p, sh+`-user> `, 0)
			p.Input([]byte("echo opt-$((40+2))\r"))
			waitText(t, p, `opt-42`, 0)
			time.Sleep(200 * time.Millisecond)
			if sh := p.Info().Shell; sh != nil {
				t.Fatalf("marks without the integration: %+v", sh)
			}
			for _, kv := range p.cmd.Env {
				if strings.HasPrefix(kv, "ZDOTDIR=") || strings.HasPrefix(kv, "ENV=") || strings.HasPrefix(kv, "PROMPT_COMMAND=") {
					t.Fatalf("injected anyway: %s", kv)
				}
			}
		})
	}
}

// Only an interactive shell is changed: a shell running a command or a
// script, and other programs, start as they are.
func TestShellIntegrationLeavesCommandsAlone(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("no bash")
	}
	m := shellManager(t, shellHome(t), bash)
	for _, argv := range [][]string{{bash, "-c", "echo plain-$((1+1))"}, {"/bin/sh", "-c", "echo plain-$((1+1))"}} {
		p := newPane(t, m, Config{Command: argv})
		waitText(t, p, `plain-2`, 0)
		if strings.Join(p.cmd.Args[1:], " ") != strings.Join(argv[1:], " ") {
			t.Fatalf("args changed: %q", p.cmd.Args)
		}
		for _, kv := range p.cmd.Env {
			if strings.HasPrefix(kv, "ENV=") || strings.HasPrefix(kv, "PROMPT_COMMAND=") {
				t.Fatalf("%q injected: %s", argv, kv)
			}
		}
	}
}
