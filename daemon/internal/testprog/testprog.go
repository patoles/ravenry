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
//	rawecho   switches the terminal to raw mode, prints $RAVENRY_TESTPROG_INIT,
//	          then "ready", then "read <quoted bytes>" for every read
package testprog

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"
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
	case "rawecho":
		rawecho()
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
