package server

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/pane"
	"ravenryd/internal/proto"
	"ravenryd/internal/testprog"
)

// The Ravenry app's own window is the person's, even when the app carries
// a pane's variables (2026-11-07: an agent opened it with `open -a` from a
// pane, and every key the person typed became that agent's drive
// checkpoint). A program that only gives the app's name at hello is still
// an agent; and the drive checkpoints a connection named as the app left
// open are cancelled when the real app connects.

// appCopy copies the test binary to where the app's executable would be.
func appCopy(t *testing.T, dir string) string {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(dir, "Ravenry.app", "Contents", "MacOS", "Ravenry")
	if runtime.GOOS != "darwin" {
		exe = filepath.Join(dir, "linux-unpacked", "ravenry")
	}
	os.MkdirAll(filepath.Dir(exe), 0o755)
	b, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exe, b, 0o755); err != nil {
		t.Fatal(err)
	}
	return exe
}

// runSteps starts exe outside every pane, as `open -a` from a pane would
// leave it: the pane's RAVENRY_PANE and RAVENRY_SOCKET in its environment.
// It returns the line its first step prints.
func runSteps(t *testing.T, d *daemon, exe, name, paneID string, extra []string, steps ...string) string {
	t.Helper()
	argv, env := testprog.Command("agent")
	_ = argv
	cmd := exec.Command(exe)
	cmd.Env = append([]string{"PATH=/usr/bin:/bin", "HOME=" + d.home, testprog.Env + "=" + env[testprog.Env],
		"RAVENRY_SOCKET=" + d.socket, "RAVENRY_PANE=" + paneID, "TERM_PROGRAM=ravenry",
		"RAVENRY_TESTPROG_NAME=" + name, "RAVENRY_TESTPROG_STEPS=" + strings.Join(steps, "\n")}, extra...)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	lines := make(chan string, 8)
	go func() {
		r := bufio.NewReader(out)
		for {
			l, err := r.ReadString('\n')
			if l != "" {
				lines <- strings.TrimSpace(l)
			}
			if err != nil {
				if err != io.EOF {
					lines <- "read error " + err.Error()
				}
				close(lines)
				return
			}
		}
	}()
	select {
	case l := <-lines:
		return l
	case <-time.After(15 * time.Second):
		t.Fatalf("%s gave no step line", exe)
	}
	return ""
}

func TestAppWithPaneVariablesTypesAsThePerson(t *testing.T) {
	d := startDaemon(t)
	person := d.dial(client.Options{Name: "hub"})
	call[proto.Empty](t, person, "events.subscribe", map[string]any{})
	target := newPane(t, person, map[string]any{"command": []string{"/bin/cat"}, "name": "the person's claude"})
	// The pane the variables name: the agent that ran `open -a`.
	agent := newPane(t, person, map[string]any{"command": []string{"/bin/cat"}, "name": "the agent"})
	send := func(text string) string {
		return fmt.Sprintf(`pane.send {"pane":%q,"input":[{"text":%q,"mode":"raw"}],"no_wait":true}`, target.ID, text)
	}
	exe := appCopy(t, d.dir)

	// A program that only says it is the app: still the agent of its pane.
	self, _ := os.Executable()
	if l := runSteps(t, d, self, pane.DesktopAppClient, agent.ID, nil, send("faked\r")); !strings.HasPrefix(l, "step 0 forbidden c") {
		t.Fatalf("a program giving the app's name with a pane's variables: %s", l)
	}
	left := openDrive(t, person, target.ID, agent.ID)
	if left.Drive.Agent.Client != pane.DesktopAppClient {
		t.Fatalf("the drive checkpoint names its client: %+v", left.Drive.Agent)
	}
	// The app's executable run as Node, or with a debugging port: the same.
	if l := runSteps(t, d, exe, pane.DesktopAppClient, agent.ID, []string{"ELECTRON_RUN_AS_NODE=1"}, send("as node\r")); !strings.HasPrefix(l, "step 0 forbidden c") {
		t.Fatalf("the app's executable as Node: %s", l)
	}

	// The app itself, with the pane's variables: its typing goes straight in.
	if l := runSteps(t, d, exe, pane.DesktopAppClient, agent.ID, nil, send("typed by the person\r")); !strings.HasPrefix(l, "step 0 ok") {
		t.Fatalf("the app with a pane's variables typing: %s", l)
	}
	waitFor(t, person, target.ID, `typed by the person`, 0)
	ins := inputs(t, person, target.ID)
	last := ins[len(ins)-1]
	if last.Text != "typed by the person<Enter>" || last.Source.Kind == "agent" || last.Source.Pane != "" {
		t.Fatalf("the app's input is marked as an agent's: %+v", last)
	}
	for _, in := range ins {
		if strings.Contains(in.Text, "faked") || strings.Contains(in.Text, "as node") {
			t.Fatalf("an agent's input went in without the person: %+v", in)
		}
	}
	// No drive checkpoint is open any more: the one left by a connection
	// named as the app was cancelled when the app connected.
	deadline := time.Now().Add(5 * time.Second)
	for {
		open := 0
		for _, cp := range call[proto.CheckpointListResult](t, person, "checkpoint.list", map[string]any{}).Checkpoints {
			if cp.Kind == "drive" && cp.Drive != nil && cp.Drive.Agent.Client == pane.DesktopAppClient {
				open++
			}
		}
		if open == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d drive checkpoint(s) of a connection named as the app still open", open)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !strings.Contains(d.log.String(), "judged as the person") {
		t.Fatalf("the daemon's log does not say it judged the app as the person:\n%s", d.log.String())
	}
}
