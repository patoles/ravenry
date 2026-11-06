// Package testprog lets a test binary act as the programs that tests run
// inside panes. A test's TestMain calls Run first; when the environment
// variable RAVENRY_TESTPROG names a program, the binary runs it and exits.
//
// Programs:
//
//	tree      starts a child, a child that ignores SIGHUP and SIGTERM, and a
//	          grandchild that daemonizes itself (setsid, parent exits),
//	          prints "pids: <a> <b> <c>" and sleeps
//	sleep     sleeps
//	stubborn  ignores SIGHUP and SIGTERM, prints "stubborn <pid>", sleeps
//	daemon    starts "sleep" in a new session, prints "daemon <pid>", exits
//	detach    detaches a helper as a daemonizing program does: a /bin/sh in
//	          a new session of its own starts /bin/sleep with its
//	          environment wiped and its output closed, and exits at once
//	          (a double fork); prints "detached <sleep pid> <sh pid>" and
//	          sleeps. The sleep ends up a child of launchd or init, in the
//	          session of a process that is gone, with no RAVENRY_PANE.
//	          $RAVENRY_TESTPROG_DETACH replaces the sleep's command line;
//	          its standard error is the pane's.
//	rawecho   switches the terminal to raw mode, prints $RAVENRY_TESTPROG_INIT,
//	          then "ready", then "read <quoted bytes>" for every read
//	answer    connects to $RAVENRY_TESTPROG_SOCKET (else $RAVENRY_SOCKET)
//	          straight on the socket, says hello (with the answer key
//	          $RAVENRY_TESTPROG_KEY when set) and declines checkpoint
//	          $RAVENRY_TESTPROG_CP, then asks to decide for hooks
//	          (agent.decisions); prints "person=<bool> answer=<ok or the
//	          error code> decide=<ok or the error code>"
package testprog

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"

	"ravenryd/internal/client"
)

// Env is the variable that selects a program.
const Env = "RAVENRY_TESTPROG"

// Run runs the program RAVENRY_TESTPROG names, if any, and exits.
func Run() {
	prog := os.Getenv(Env)
	if prog == "" {
		return
	}
	switch prog {
	case "tree":
		tree()
	case "sleep":
		time.Sleep(10 * time.Minute)
	case "stubborn":
		signal.Ignore(syscall.SIGHUP, syscall.SIGTERM)
		fmt.Printf("stubborn %d\n", os.Getpid())
		time.Sleep(10 * time.Minute)
	case "daemon":
		c := self("sleep")
		c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if err := c.Start(); err != nil {
			fmt.Println("error", err)
			os.Exit(1)
		}
		fmt.Printf("daemon %d\n", c.Process.Pid)
	case "detach":
		detach()
	case "rawecho":
		rawecho()
	case "answer":
		answer()
	default:
		fmt.Fprintf(os.Stderr, "testprog: unknown program %q\n", prog)
		os.Exit(2)
	}
	os.Exit(0)
}

// Command returns argv and env for running prog inside a pane.
func Command(prog string) ([]string, map[string]string) {
	exe, err := os.Executable()
	if err != nil {
		panic(err)
	}
	return []string{exe}, map[string]string{Env: prog}
}

func self(prog string) *exec.Cmd {
	exe, _ := os.Executable()
	c := exec.Command(exe)
	c.Env = append(os.Environ(), Env+"="+prog)
	return c
}

func tree() {
	child := self("sleep")
	if err := child.Start(); err != nil {
		fmt.Println("error", err)
		os.Exit(1)
	}
	stub := self("stubborn")
	stub.Stdout = nil
	if err := stub.Start(); err != nil {
		fmt.Println("error", err)
		os.Exit(1)
	}
	d := self("daemon")
	out, err := d.Output()
	if err != nil {
		fmt.Println("error", err)
		os.Exit(1)
	}
	var dpid int
	fmt.Sscanf(strings.TrimSpace(string(out)), "daemon %d", &dpid)
	// Give the stubborn child time to install its signal handlers.
	time.Sleep(100 * time.Millisecond)
	fmt.Printf("pids: %d %d %d\n", child.Process.Pid, stub.Process.Pid, dpid)
	time.Sleep(10 * time.Minute)
}

func detach() {
	cmd := os.Getenv("RAVENRY_TESTPROG_DETACH")
	if cmd == "" {
		cmd = "/usr/bin/env -i /bin/sleep 600 </dev/null >/dev/null 2>&1"
	}
	sh := exec.Command("/bin/sh", "-c", cmd+" & echo $!")
	sh.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	sh.Stderr = os.Stdout
	out, err := sh.Output()
	if err != nil {
		fmt.Println("error", err)
		os.Exit(1)
	}
	fmt.Printf("detached %s %d\n", strings.TrimSpace(string(out)), sh.Process.Pid)
	time.Sleep(10 * time.Minute)
}

func rawecho() {
	if _, err := term.MakeRaw(0); err != nil {
		fmt.Println("error", err)
		os.Exit(1)
	}
	os.Stdout.WriteString(os.Getenv("RAVENRY_TESTPROG_INIT"))
	os.Stdout.WriteString("ready\r\n")
	buf := make([]byte, 4096)
	for {
		n, err := os.Stdin.Read(buf)
		if n > 0 {
			fmt.Printf("read %q\r\n", buf[:n])
		}
		if err != nil {
			return
		}
	}
}

func answer() {
	sock := os.Getenv("RAVENRY_TESTPROG_SOCKET")
	if sock == "" {
		sock = os.Getenv("RAVENRY_SOCKET")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := client.Dial(ctx, sock, client.Options{Name: "testprog", AnswerKey: os.Getenv("RAVENRY_TESTPROG_KEY")})
	if err != nil {
		fmt.Println("error", err)
		os.Exit(1)
	}
	defer c.Close()
	code := func(err error) string {
		var ce *client.Error
		switch {
		case err == nil:
			return "ok"
		case errors.As(err, &ce):
			return ce.Code
		}
		fmt.Println("error", err)
		os.Exit(1)
		return ""
	}
	ans := code(c.Call(ctx, "checkpoint.answer", map[string]any{"checkpoint": os.Getenv("RAVENRY_TESTPROG_CP"), "decline": true}, nil))
	dec := code(c.Call(ctx, "agent.decisions", map[string]any{}, nil))
	fmt.Printf("person=%v answer=%s decide=%s\n", c.Hello.Person, ans, dec)
}
