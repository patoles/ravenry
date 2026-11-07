package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/pane"
	"ravenryd/internal/paths"
	"ravenryd/internal/proto"
)

// Checkpoints: an agent waits for a person (PROTOCOL.md section 4,
// Checkpoints). ask, approve and secret open one in the daemon of the pane
// they run in and, unless --no-wait, wait for it to close, then exit:
//
//	0    answered (approve, and a secret with a command: the command's own status)
//	124  nobody answered in time
//	125  a person declined, or it was cancelled
//	1    anything else (the command did not start, no daemon)

const (
	exitTimeout  = 124
	exitDeclined = 125
)

var safeWord = regexp.MustCompile(`^[A-Za-z0-9_@%+=:,./-]+$`)

// shellJoin quotes arguments into the one line a shell runs as them.
func shellJoin(argv []string) string {
	out := make([]string, len(argv))
	for i, a := range argv {
		if safeWord.MatchString(a) {
			out[i] = a
		} else {
			out[i] = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
		}
	}
	return strings.Join(out, " ")
}

// checkpointParams are the fields every kind shares.
func checkpointParams(a *args, kind, title string) (map[string]any, error) {
	if title == "" {
		return nil, fmt.Errorf("give the title as one argument, quoted")
	}
	p := map[string]any{"kind": kind, "title": title}
	if id := os.Getenv("RAVENRY_PANE"); id != "" {
		p["pane"] = id
	}
	if v := a.values["timeout"]; v != "" {
		d, err := duration(v)
		if err != nil {
			return nil, err
		}
		p["timeout_ms"] = d.Milliseconds()
	}
	if v := a.values["cwd"]; v != "" {
		p["cwd"] = absDir(v)
	}
	return p, nil
}

func absDir(v string) string {
	if strings.HasPrefix(v, "/") {
		return v
	}
	wd, _ := os.Getwd()
	return wd + "/" + v
}

// openCheckpoint opens it in the daemon of this pane (or the newest),
// then waits for it unless --no-wait.
func openCheckpoint(a *args, params map[string]any) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cctx, ccancel := callCtx(15 * time.Second)
	defer ccancel()
	c, err := connectNewest(cctx, a.g)
	if err != nil {
		return err
	}
	defer c.Close()
	var r proto.CheckpointResult
	if err := c.Call(cctx, "checkpoint.new", params, &r); err != nil {
		return err
	}
	if a.bools["no-wait"] {
		if a.g.json {
			return printJSON(r)
		}
		fmt.Println(r.Checkpoint.ID)
		return nil
	}
	fmt.Fprintf(os.Stderr, "waiting for a person to answer %s (in the Ravenry app or on the phone)...\n", r.Checkpoint.ID)
	return waitCheckpoint(ctx, c, a, r.Checkpoint.ID, nil)
}

// waitCheckpoint waits until it closes (or timeout passes) and exits as
// the table above says.
func waitCheckpoint(ctx context.Context, c *client.Client, a *args, id string, timeout *time.Duration) error {
	params := map[string]any{"checkpoint": id}
	if timeout != nil {
		params["timeout_ms"] = timeout.Milliseconds()
	}
	var r proto.CheckpointResult
	if err := c.Call(ctx, "checkpoint.wait", params, &r); err != nil {
		return err
	}
	cp := r.Checkpoint
	if a.g.json {
		if err := printJSON(r); err != nil {
			return err
		}
	}
	say := func(format string, v ...any) {
		if !a.g.json {
			fmt.Fprintf(os.Stderr, format+"\n", v...)
		}
	}
	switch cp.State {
	case "open", "running":
		say("%s is still %s", id, cp.State)
		return exitCode(exitTimeout)
	case "expired":
		say("nobody answered %s before it expired", id)
		return exitCode(exitTimeout)
	case "declined":
		if cp.Answer != nil && cp.Answer.Reason != "" {
			say("a person declined %s: %s", id, cp.Answer.Reason)
		} else {
			say("a person declined %s", id)
		}
		return exitCode(exitDeclined)
	case "cancelled":
		say("%s was cancelled%s", id, map[bool]string{true: ": " + cp.Reason, false: ""}[cp.Reason != ""])
		return exitCode(exitDeclined)
	}
	ans := cp.Answer
	if ans != nil && ans.Command != "" {
		// The person changed the command before it ran: what ran is theirs.
		say("a person edited the command before approving it; it ran as:\n%s", ans.Command)
	}
	if cp.Run != nil || cp.Command != "" {
		if cp.Run == nil || cp.Run.Exit == nil {
			say("%s", firstOf(cp.Reason, "the command did not run"))
			return exitCode(1)
		}
		if !a.g.json {
			fmt.Print(cp.Run.Output)
			if cp.Run.Output != "" && !strings.HasSuffix(cp.Run.Output, "\n") {
				fmt.Println()
			}
		}
		code := cp.Run.Exit.Code
		if code < 0 {
			code = 128 + 9
		}
		if code != 0 {
			return exitCode(code)
		}
		return nil
	}
	if !a.g.json && ans != nil {
		switch {
		case ans.Pick != nil:
			fmt.Println(ans.Pick.Label)
			if r := ans.Pick.Region; r != nil {
				fmt.Printf("region %.4f %.4f %.4f %.4f\n", r.X, r.Y, r.W, r.H)
			}
			if ans.Pick.Note != "" {
				fmt.Println("note " + ans.Pick.Note)
			}
		case ans.Text != nil:
			fmt.Println(*ans.Text)
		case ans.Option != "":
			fmt.Println(ans.Option)
		}
	}
	return nil
}

func firstOf(a ...string) string {
	for _, s := range a {
		if s != "" {
			return s
		}
	}
	return ""
}

func oneTitle(a *args, cmd string) (string, error) {
	n := len(a.pos)
	if a.dash >= 0 {
		n = a.dash
	}
	if n != 1 {
		return "", fmt.Errorf("usage: ravenry %s TITLE ..., with the title as one argument, quoted", cmd)
	}
	return a.pos[0], nil
}

func cmdAsk(in []string) error {
	a, err := parse(in, specOf("ask"))
	if err != nil {
		return err
	}
	title, err := oneTitle(a, "ask")
	if err != nil {
		return err
	}
	p, err := checkpointParams(a, "ask", title)
	if err != nil {
		return err
	}
	opts := a.lists["option"]
	if len(opts) == 0 && !a.bools["text"] {
		opts = []string{"Done"}
	}
	if len(opts) > 0 {
		p["options"] = opts
	}
	if a.bools["text"] {
		p["free_text"] = true
	}
	return openCheckpoint(a, p)
}

func cmdApprove(in []string) error {
	a, err := parse(in, specOf("approve"))
	if err != nil {
		return err
	}
	var command string
	switch {
	case a.dash == 0 && len(a.pos) > 0:
		command = shellJoin(a.pos)
	case a.dash < 0 && len(a.pos) == 1:
		command = a.pos[0]
	default:
		return fmt.Errorf("usage: ravenry approve 'COMMAND LINE' [--why TEXT], or ravenry approve [--why TEXT] -- PROGRAM ARGS...")
	}
	p, err := checkpointParams(a, "approve", "Run "+clipString(strings.Join(strings.Fields(command), " "), 200))
	if err != nil {
		return err
	}
	p["command"] = command
	if v := a.values["why"]; v != "" {
		p["why"] = v
	}
	if v := a.values["warn"]; v != "" {
		p["warning"] = v
	}
	return openCheckpoint(a, p)
}

func cmdSecret(in []string) error {
	a, err := parse(in, specOf("secret"))
	if err != nil {
		return err
	}
	title, err := oneTitle(a, "secret")
	if err != nil {
		return err
	}
	p, err := checkpointParams(a, "secret", title)
	if err != nil {
		return err
	}
	var argv []string
	if a.dash >= 0 {
		argv = a.pos[a.dash:]
	}
	target := map[string]any{}
	switch {
	case a.values["pane"] != "":
		if len(argv) > 0 || a.values["env"] != "" || a.values["cwd"] != "" {
			return fmt.Errorf("--pane types it into a running pane: give no command, --env or --cwd with it")
		}
		target["to"], target["pane"] = "input", a.values["pane"]
	case len(argv) > 0 && a.values["env"] != "":
		target["to"], target["env"] = "env", a.values["env"]
		p["command"] = shellJoin(argv)
	case len(argv) > 0:
		target["to"] = "run"
		p["command"] = shellJoin(argv)
	default:
		return fmt.Errorf("usage: ravenry secret TITLE --pane PANE, or ravenry secret TITLE [--env NAME] -- PROGRAM ARGS...")
	}
	if a.bools["no-enter"] {
		if target["to"] == "env" {
			return fmt.Errorf("--no-enter is for a secret that is typed, not one in --env")
		}
		target["enter"] = false
	}
	p["secret"] = target
	return openCheckpoint(a, p)
}

func cmdCheckpoints(in []string) error {
	a, err := parse(in, specOf("checkpoints"))
	if err != nil {
		return err
	}
	ctx, cancel := callCtx(10 * time.Second)
	defer cancel()
	type row struct {
		proto.Checkpoint
		Daemon string `json:"daemon"`
	}
	rows := []row{}
	for _, s := range daemonSockets(a.g) {
		c, err := dial(ctx, s)
		if err != nil {
			continue
		}
		var l proto.CheckpointListResult
		if c.Call(ctx, "checkpoint.list", map[string]any{"all": a.bools["all"]}, &l) == nil {
			for _, cp := range l.Checkpoints {
				rows = append(rows, row{Checkpoint: cp, Daemon: c.Hello.Daemon.Version})
			}
		}
		c.Close()
	}
	if a.g.json {
		return printJSON(rows)
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tKIND\tSTATE\tPANE\tEXPIRES\tTITLE")
	for _, r := range rows {
		pane := r.Pane
		if pane == "" {
			pane = "-"
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\n", r.ID, r.Kind, r.State, pane, r.ExpiresAt, strings.Join(strings.Fields(r.Title), " "))
	}
	return w.Flush()
}

// connectForCheckpoint finds the daemon that holds a checkpoint.
func connectForCheckpoint(ctx context.Context, g global, id string) (*client.Client, error) {
	for _, s := range daemonSockets(g) {
		c, err := dial(ctx, s)
		if err != nil {
			continue
		}
		var l proto.CheckpointListResult
		if c.Call(ctx, "checkpoint.list", map[string]any{"all": true}, &l) == nil {
			for _, cp := range l.Checkpoints {
				if cp.ID == id {
					return c, nil
				}
			}
		}
		c.Close()
	}
	return nil, fmt.Errorf("no running daemon has checkpoint %s", id)
}

func cmdCheckpoint(in []string) error {
	a, err := parse(in, specOf("checkpoint"))
	if err != nil {
		return err
	}
	if len(a.pos) != 1 {
		return fmt.Errorf("usage: ravenry checkpoint ID [--wait [--timeout T]] [--cancel [--reason TEXT]] [--answer TEXT | --approve [--command TEXT] | --decline [--reason TEXT]]")
	}
	id := a.pos[0]
	answering := a.values["answer"] != "" || a.bools["approve"] || a.bools["decline"]
	if answering {
		// Said here before anything else, so an agent reads it plainly.
		sc := pane.Scope{}
		if s := pinned(a.g); s != "" {
			sc.Dir = filepath.Dir(s)
		} else {
			sc.Dir, _ = paths.RuntimeDirFor(os.Getenv)
		}
		if o := pane.OriginOf(os.Getpid(), sc); o.Pane {
			return errPersonOnly(id)
		}
	}
	cctx, ccancel := callCtx(10 * time.Second)
	defer ccancel()
	c, err := connectForCheckpoint(cctx, a.g, id)
	if err != nil {
		return err
	}
	defer c.Close()
	switch {
	case answering:
		return answerCheckpoint(cctx, c, a, id)
	case a.bools["cancel"]:
		params := map[string]any{"checkpoint": id}
		if v := a.values["reason"]; v != "" {
			params["reason"] = v
		}
		var r proto.CheckpointResult
		if err := c.Call(cctx, "checkpoint.cancel", params, &r); err != nil {
			return err
		}
		if a.g.json {
			return printJSON(r)
		}
		return nil
	case a.bools["wait"]:
		var t *time.Duration
		if v := a.values["timeout"]; v != "" {
			d, err := duration(v)
			if err != nil {
				return err
			}
			t = &d
		}
		return waitCheckpoint(context.Background(), c, a, id, t)
	}
	var l proto.CheckpointListResult
	if err := c.Call(cctx, "checkpoint.list", map[string]any{"all": true}, &l); err != nil {
		return err
	}
	for _, cp := range l.Checkpoints {
		if cp.ID == id {
			return printJSON(cp)
		}
	}
	return fmt.Errorf("no checkpoint %s", id)
}

// errPersonOnly is what an agent reads when it tries to answer.
func errPersonOnly(id string) error {
	return fmt.Errorf("only a person can answer %s, in the Ravenry app or on the phone; a program inside a pane cannot answer it", id)
}

// answerCheckpoint is a person's answer from a terminal: --answer for an
// ask, --approve, or --decline. A secret is never typed on a command line,
// where the shell's history would keep it.
func answerCheckpoint(ctx context.Context, c *client.Client, a *args, id string) error {
	n := 0
	for _, set := range []bool{a.values["answer"] != "", a.bools["approve"], a.bools["decline"]} {
		if set {
			n++
		}
	}
	if n != 1 {
		return errors.New("answer with exactly one of --answer, --approve and --decline")
	}
	var l proto.CheckpointListResult
	if err := c.Call(ctx, "checkpoint.list", map[string]any{"all": true}, &l); err != nil {
		return err
	}
	i := slices.IndexFunc(l.Checkpoints, func(cp proto.Checkpoint) bool { return cp.ID == id })
	if i < 0 {
		return fmt.Errorf("no checkpoint %s", id)
	}
	cp := l.Checkpoints[i]
	if a.values["command"] != "" && !a.bools["approve"] {
		return errors.New("--command goes with --approve: the command as you edited it")
	}
	if a.values["reason"] != "" && !a.bools["decline"] {
		return errors.New("--reason goes with --decline (or --cancel)")
	}
	params := map[string]any{"checkpoint": id, "by": "terminal"}
	switch v := a.values["answer"]; {
	case a.bools["decline"]:
		params["decline"] = true
		if r := a.values["reason"]; r != "" {
			params["reason"] = r
		}
	case a.bools["approve"]:
		if cp.Kind != "approve" && cp.Kind != "drive" {
			return fmt.Errorf("%s is a %s, not an approve: answer it with --answer or --decline", id, cp.Kind)
		}
		params["approve"] = true
		if v := a.values["allow"]; v != "" {
			if cp.Kind != "drive" {
				return errors.New("--allow is for a drive: let an agent type once or for its session")
			}
			params["allow"] = v
		}
		if c := a.values["command"]; c != "" {
			params["command"] = c
		}
	case cp.Kind == "pick":
		return fmt.Errorf("%s is a pick: the person picks in the Ravenry app or on the phone, where they see the variants; --decline declines it", id)
	case cp.Kind == "secret":
		return fmt.Errorf("a secret is typed in the Ravenry app or on the phone, never on a command line (its history would keep it); --decline declines %s", id)
	case cp.Kind != "ask":
		return fmt.Errorf("%s is a %s: answer it with --approve or --decline", id, cp.Kind)
	default:
		if k, err := strconv.Atoi(v); err == nil && k >= 1 && k <= len(cp.Options) {
			params["choice"] = k - 1
		} else if k := slices.Index(cp.Options, v); k >= 0 {
			params["choice"] = k
		} else if cp.FreeText {
			params["text"] = v
		} else {
			return fmt.Errorf("%q is not one of the options of %s: %s", v, id, strings.Join(cp.Options, ", "))
		}
	}
	var r proto.CheckpointResult
	if err := c.Call(ctx, "checkpoint.answer", params, &r); err != nil {
		var ce *client.Error
		if errors.As(err, &ce) && ce.Code == proto.CodeForbidden {
			return fmt.Errorf("only a person can answer %s, in the Ravenry app or on the phone (the daemon refused this one: %s)", id, ce.Message)
		}
		return err
	}
	if a.g.json {
		return printJSON(r)
	}
	fmt.Println(r.Checkpoint.State)
	return nil
}
