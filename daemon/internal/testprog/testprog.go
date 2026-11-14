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
//	agent     an agent in a pane: connects to $RAVENRY_SOCKET and runs the
//	          lines of $RAVENRY_TESTPROG_STEPS, one call each
//	          ("METHOD JSON"), printing "step <n> ok <result JSON>" or
//	          "step <n> <error code> <checkpoint>"; $PANE in a line is the
//	          pane the previous pane.new made; a line "INPUT <channel>
//	          <Go-quoted bytes>" sends an input frame as a display does; an
//	          error with no request's id prints "async <code>"; then sleeps
//	redraw    draws the last rows of the lines of $RAVENRY_TESTPROG_FILE
//	          laid out at the terminal's width, and again after each
//	          SIGWINCH, the way Claude Code does: a synchronized update
//	          (mode 2026), every row erased from the top (ESC[2K ESC[1B),
//	          the rows drawn at their places in four writes 20 ms apart,
//	          the update ended. A SIGWINCH during a redraw makes one more
//	          once it is done. Autowrap is off, so a redraw finished for a
//	          width the screen has already left still fills every row.
//	          With $RAVENRY_TESTPROG_REDRAW=claude it draws as Claude Code
//	          does instead (ClaudeScreen): autowrap on, the transcript's
//	          lines word-wrapped at the width, each word placed at its
//	          column (ESC[<col>G), the rows one under the other (CR LF)
//	          from the top, a footer of a rule, the prompt, a rule and a
//	          status line. It redraws once for every size it is told, in
//	          order, 120 to 200 ms after the SIGWINCH, with the size it
//	          read then: a synchronized update, every row erased, the rows
//	          in four writes 20 ms apart, the cursor put back at the prompt
//	          with relative moves. claude-busy adds a spinner line over the
//	          footer that it updates 10 times a second with relative moves
//	          from the prompt, each in a synchronized update, as Claude
//	          Code does while it works. $RAVENRY_TESTPROG_LIVE=N: the last
//	          N lines are its live part, drawn whole from the top when they
//	          are taller than the screen (the rows past it scroll into the
//	          scrollback), the whole transcript so on the first draw, as
//	          Claude Code does while a turn or a background agent runs.
package testprog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
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
	case "agent":
		agentSteps()
	case "redraw":
		redraw()
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

func redraw() {
	data, err := os.ReadFile(os.Getenv("RAVENRY_TESTPROG_FILE"))
	if err != nil {
		fmt.Println("error", err)
		os.Exit(1)
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	live, _ := strconv.Atoi(os.Getenv("RAVENRY_TESTPROG_LIVE"))
	switch os.Getenv("RAVENRY_TESTPROG_REDRAW") {
	case "claude":
		claude(lines, false, live)
		return
	case "claude-busy":
		claude(lines, true, live)
		return
	}
	winch := make(chan os.Signal, 1)
	signal.Notify(winch, syscall.SIGWINCH)
	os.Stdout.WriteString("\x1b[?7l")
	for {
		cols, rows, err := term.GetSize(0)
		if err != nil {
			fmt.Println("error", err)
			os.Exit(1)
		}
		var laid []string
		for _, l := range lines {
			for len(l) > cols {
				laid, l = append(laid, l[:cols]), l[cols:]
			}
			laid = append(laid, l)
		}
		laid = laid[max(0, len(laid)-rows):]
		os.Stdout.WriteString("\x1b[?2026h\x1b[H" + strings.Repeat("\x1b[2K\x1b[1B", rows))
		per := (len(laid) + 3) / 4
		for i := 0; i < len(laid); i += per {
			time.Sleep(20 * time.Millisecond)
			var b strings.Builder
			for y := i; y < min(i+per, len(laid)); y++ {
				fmt.Fprintf(&b, "\x1b[%d;1H%s", y+1, laid[y])
			}
			os.Stdout.WriteString(b.String())
		}
		os.Stdout.WriteString("\x1b[?2026l")
		<-winch
	}
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

func agentSteps() {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	name := os.Getenv("RAVENRY_TESTPROG_NAME") // the name it gives at hello; default agent
	if name == "" {
		name = "agent"
	}
	// An error the daemon sends with no request's id (a refused input
	// frame) is printed as "async <code>".
	tap := func(dir string, text bool, data []byte) {
		var m struct {
			Type  string                 `json:"type"`
			ID    *uint64                `json:"id"`
			Error *struct{ Code string } `json:"error"`
		}
		if dir == "recv" && text && json.Unmarshal(data, &m) == nil && m.Type == "error" && m.ID == nil && m.Error != nil {
			fmt.Printf("async %s\n", m.Error.Code)
		}
	}
	c, err := client.Dial(ctx, os.Getenv("RAVENRY_SOCKET"), client.Options{Name: name, OnMessage: tap})
	if err != nil {
		fmt.Println("error", err)
		os.Exit(1)
	}
	defer c.Close()
	made := ""
	for i, line := range strings.Split(os.Getenv("RAVENRY_TESTPROG_STEPS"), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		method, params, _ := strings.Cut(line, " ")
		params = strings.ReplaceAll(params, "$PANE", made)
		if method == "INPUT" {
			// "INPUT <channel> <Go-quoted bytes>": an input frame, as a display sends.
			chs, q, _ := strings.Cut(params, " ")
			ch, err1 := strconv.ParseUint(chs, 10, 32)
			b, err2 := strconv.Unquote(q)
			if err := errors.Join(err1, err2); err != nil {
				fmt.Printf("step %d error %v\n", i, err)
				continue
			}
			if err := c.WriteBinary(ctx, append(proto.AppendFrame(nil, proto.FrameInput, uint32(ch), 0), b...)); err != nil {
				fmt.Printf("step %d error %v\n", i, err)
				continue
			}
			fmt.Printf("step %d ok\n", i)
			continue
		}
		var out map[string]any
		err := c.Call(ctx, method, json.RawMessage(params), &out)
		var ce *client.Error
		switch {
		case err == nil:
			if p, ok := out["pane"].(map[string]any); ok && method == "pane.new" {
				made, _ = p["id"].(string)
			}
			b, _ := json.Marshal(out)
			fmt.Printf("step %d ok %s\n", i, b)
		case errors.As(err, &ce):
			fmt.Printf("step %d %s %s\n", i, ce.Code, ce.Checkpoint)
		default:
			fmt.Printf("step %d error %v\n", i, err)
		}
	}
	fmt.Println("steps done")
	time.Sleep(10 * time.Minute)
}
