package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"ravenryd/internal/proto"
)

// callCtx bounds a command; waits get their own timeout plus a margin.
func callCtx(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), d)
}

func cmdNew(in []string) error {
	a, err := parse(in, map[string]flagKind{
		"cwd": valueFlag, "env": listFlag, "size": valueFlag, "name": valueFlag,
		"hidden": boolFlag, "ttl": valueFlag, "scrollback": valueFlag,
	})
	if err != nil {
		return err
	}
	params := map[string]any{}
	if len(a.pos) > 0 {
		params["command"] = a.pos
	}
	if v := a.values["cwd"]; v != "" {
		params["cwd"] = v
	} else if wd, err := os.Getwd(); err == nil {
		params["cwd"] = wd
	}
	if envs := a.lists["env"]; len(envs) > 0 {
		env := map[string]string{}
		for _, kv := range envs {
			k, v, ok := strings.Cut(kv, "=")
			if !ok || k == "" {
				return fmt.Errorf("--env %q is not NAME=VALUE", kv)
			}
			env[k] = v
		}
		params["env"] = env
	}
	if v := a.values["size"]; v != "" {
		cols, rows, err := size(v)
		if err != nil {
			return err
		}
		params["cols"], params["rows"] = cols, rows
	}
	if v := a.values["name"]; v != "" {
		params["name"] = v
	}
	if a.bools["hidden"] {
		params["hidden"] = true
	}
	if v := a.values["ttl"]; v != "" {
		d, err := duration(v)
		if err != nil {
			return err
		}
		params["ttl_ms"] = d.Milliseconds()
	}
	if v := a.values["scrollback"]; v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return fmt.Errorf("--scrollback %q is not a number", v)
		}
		params["scrollback"] = n
	}
	ctx, cancel := callCtx(15 * time.Second)
	defer cancel()
	c, err := connectNewest(ctx, a.g)
	if err != nil {
		return err
	}
	defer c.Close()
	var r proto.PaneResult
	if err := c.Call(ctx, "pane.new", params, &r); err != nil {
		return err
	}
	if a.g.json {
		return printJSON(r)
	}
	fmt.Println(r.Pane.ID)
	return nil
}

func cmdList(in []string) error {
	a, err := parse(in, map[string]flagKind{"all": boolFlag})
	if err != nil {
		return err
	}
	ctx, cancel := callCtx(10 * time.Second)
	defer cancel()
	type row struct {
		proto.Pane
		Daemon string `json:"daemon"`
	}
	rows := []row{}
	socks := []string{}
	if s := pinned(a.g); s != "" {
		socks = append(socks, s)
	} else {
		for _, d := range liveDaemons() {
			socks = append(socks, d.socket)
		}
	}
	for _, s := range socks {
		c, err := dial(ctx, s)
		if err != nil {
			continue
		}
		var l proto.ListResult
		if err := c.Call(ctx, "pane.list", map[string]any{"hidden": a.bools["all"]}, &l); err == nil {
			for _, p := range l.Panes {
				rows = append(rows, row{Pane: p, Daemon: c.Hello.Daemon.Version})
			}
		}
		c.Close()
	}
	if a.g.json {
		return printJSON(rows)
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "PANE\tSTATE\tSIZE\tPID\tDAEMON\tCOMMAND\tTITLE")
	for _, r := range rows {
		state := r.State
		if r.Exit != nil {
			state = fmt.Sprintf("exited %d", r.Exit.Code)
			if r.Exit.Signal != "" {
				state = "killed " + r.Exit.Signal
			}
		}
		cmd := strings.Join(r.Command, " ")
		if r.Name != "" {
			cmd = r.Name + ": " + cmd
		}
		fmt.Fprintf(w, "%s\t%s\t%dx%d\t%d\t%s\t%s\t%s\n", r.ID, state, r.Cols, r.Rows, r.PID, r.Daemon, cmd, r.Title)
	}
	return w.Flush()
}

func cmdCapture(in []string) error {
	a, err := parse(in, map[string]flagKind{"styles": boolFlag, "history": valueFlag, "vt": boolFlag})
	if err != nil {
		return err
	}
	id, err := onePane(a, "capture")
	if err != nil {
		return err
	}
	params := map[string]any{"pane": id}
	if a.bools["styles"] {
		params["styles"] = true
	}
	if a.bools["vt"] {
		params["vt"] = true
	}
	if v := a.values["history"]; v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return fmt.Errorf("--history %q is not a number", v)
		}
		params["history"] = n
	}
	ctx, cancel := callCtx(10 * time.Second)
	defer cancel()
	c, err := connectFor(ctx, a.g, id)
	if err != nil {
		return err
	}
	defer c.Close()
	var r proto.CaptureResult
	if err := c.Call(ctx, "pane.capture", params, &r); err != nil {
		return err
	}
	if a.g.json {
		return printJSON(r)
	}
	if a.bools["vt"] {
		_, err := os.Stdout.WriteString(r.VT)
		return err
	}
	for _, l := range r.Lines {
		fmt.Println(l.Text)
	}
	return nil
}

// inputs reads the ordered input flags.
func inputs(a *args) ([]map[string]any, error) {
	var out []map[string]any
	delay := -1
	if v := a.values["delay"]; v != "" {
		d, err := duration(v)
		if err != nil {
			return nil, err
		}
		delay = int(d.Milliseconds())
	}
	for _, f := range a.ordered {
		switch f[0] {
		case "paste", "typed", "raw":
			it := map[string]any{"text": f[1], "mode": f[0]}
			if f[0] == "typed" && delay >= 0 {
				it["delay_ms"] = delay
			}
			out = append(out, it)
		case "key":
			out = append(out, map[string]any{"key": f[1]})
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no input: give --paste, --typed, --raw or --key")
	}
	return out, nil
}

func cmdSend(in []string, settle bool) error {
	spec := map[string]flagKind{"paste": valueFlag, "typed": valueFlag, "raw": valueFlag, "key": valueFlag, "delay": valueFlag}
	name := "send"
	if settle {
		name = "settle"
		spec["quiet"], spec["timeout"] = valueFlag, valueFlag
	}
	a, err := parse(in, spec)
	if err != nil {
		return err
	}
	id, err := onePane(a, name)
	if err != nil {
		return err
	}
	items, err := inputs(a)
	if err != nil {
		return err
	}
	params := map[string]any{"pane": id, "input": items}
	timeout := 10 * time.Second
	if settle {
		if v := a.values["quiet"]; v != "" {
			d, err := duration(v)
			if err != nil {
				return err
			}
			params["quiet_ms"] = d.Milliseconds()
		}
		if v := a.values["timeout"]; v != "" {
			d, err := duration(v)
			if err != nil {
				return err
			}
			params["timeout_ms"] = d.Milliseconds()
			timeout = d
		}
	}
	ctx, cancel := callCtx(timeout + 30*time.Second)
	defer cancel()
	c, err := connectFor(ctx, a.g, id)
	if err != nil {
		return err
	}
	defer c.Close()
	if !settle {
		var r proto.SendResult
		if err := c.Call(ctx, "pane.send", params, &r); err != nil {
			return err
		}
		if a.g.json {
			return printJSON(r)
		}
		fmt.Println(r.Mark)
		return nil
	}
	var r proto.SettleResult
	if err := c.Call(ctx, "pane.settle", params, &r); err != nil {
		return err
	}
	if a.g.json {
		return printJSON(r)
	}
	printChanges(r.Wait)
	return nil
}

func printChanges(w proto.WaitResult) {
	for _, ch := range w.Changes {
		fmt.Printf("%3d| %s\n", ch.Row, ch.After)
	}
}

func cmdWait(in []string) error {
	a, err := parse(in, map[string]flagKind{"text": valueFlag, "screen": boolFlag, "quiet": valueFlag, "exit": boolFlag, "since": valueFlag, "timeout": valueFlag})
	if err != nil {
		return err
	}
	id, err := onePane(a, "wait")
	if err != nil {
		return err
	}
	params := map[string]any{"pane": id}
	if v := a.values["text"]; v != "" {
		params["text"] = v
	}
	if a.bools["screen"] {
		params["screen"] = true
	}
	if a.bools["exit"] {
		params["exit"] = true
	}
	if v := a.values["quiet"]; v != "" {
		d, err := duration(v)
		if err != nil {
			return err
		}
		params["quiet_ms"] = d.Milliseconds()
	}
	if v := a.values["since"]; v != "" {
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			return fmt.Errorf("--since %q is not a mark", v)
		}
		params["since"] = n
	}
	timeout := 30 * time.Second
	if v := a.values["timeout"]; v != "" {
		if timeout, err = duration(v); err != nil {
			return err
		}
	}
	params["timeout_ms"] = timeout.Milliseconds()
	ctx, cancel := callCtx(timeout + 30*time.Second)
	defer cancel()
	c, err := connectFor(ctx, a.g, id)
	if err != nil {
		return err
	}
	defer c.Close()
	var r proto.WaitResult
	if err := c.Call(ctx, "pane.wait", params, &r); err != nil {
		return err
	}
	if a.g.json {
		if err := printJSON(r); err != nil {
			return err
		}
	} else {
		switch {
		case r.Condition == "text" && r.Match != nil:
			fmt.Printf("text %q (mark %d)\n", *r.Match, r.Mark)
		case r.Condition == "exit" && r.Exit != nil:
			fmt.Printf("exit %d%s (mark %d)\n", r.Exit.Code, prefixed(" ", r.Exit.Signal), r.Mark)
		default:
			fmt.Printf("%s (mark %d)\n", r.Condition, r.Mark)
		}
		os.Stdout.WriteString(r.Output)
		if r.Output != "" && !strings.HasSuffix(r.Output, "\n") {
			fmt.Println()
		}
	}
	if r.Condition == "timeout" {
		return exitCode(124)
	}
	return nil
}

func prefixed(p, s string) string {
	if s == "" {
		return ""
	}
	return p + s
}

func cmdRead(in []string) error {
	a, err := parse(in, map[string]flagKind{"since": valueFlag, "limit": valueFlag, "raw": boolFlag})
	if err != nil {
		return err
	}
	id, err := onePane(a, "read")
	if err != nil {
		return err
	}
	v := a.values["since"]
	if v == "" {
		return fmt.Errorf("--since MARK is required (0 reads from the start the log still holds)")
	}
	since, err := strconv.ParseUint(v, 10, 64)
	if err != nil {
		return fmt.Errorf("--since %q is not a mark", v)
	}
	params := map[string]any{"pane": id, "since": since}
	if a.bools["raw"] {
		params["format"] = "raw"
	}
	if v := a.values["limit"]; v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return fmt.Errorf("--limit %q is not a number", v)
		}
		params["limit"] = n
	}
	ctx, cancel := callCtx(10 * time.Second)
	defer cancel()
	c, err := connectFor(ctx, a.g, id)
	if err != nil {
		return err
	}
	defer c.Close()
	var r proto.ReadResult
	if err := c.Call(ctx, "pane.read", params, &r); err != nil {
		return err
	}
	if a.g.json {
		return printJSON(r)
	}
	if r.Truncated {
		fmt.Fprintf(os.Stderr, "ravenryd read: the log starts at mark %d, after %d\n", r.From, since)
	}
	if r.Data != nil {
		b, err := base64.StdEncoding.DecodeString(*r.Data)
		if err != nil {
			return err
		}
		_, err = os.Stdout.Write(b)
		return err
	}
	_, err = os.Stdout.WriteString(*r.Text)
	return err
}

func cmdResize(in []string) error {
	a, err := parse(in, map[string]flagKind{})
	if err != nil {
		return err
	}
	if len(a.pos) != 2 {
		return fmt.Errorf("usage: ravenryd resize PANE COLSxROWS")
	}
	cols, rows, err := size(a.pos[1])
	if err != nil {
		return err
	}
	ctx, cancel := callCtx(10 * time.Second)
	defer cancel()
	c, err := connectFor(ctx, a.g, a.pos[0])
	if err != nil {
		return err
	}
	defer c.Close()
	var r proto.PaneResult
	if err := c.Call(ctx, "pane.resize", map[string]any{"pane": a.pos[0], "cols": cols, "rows": rows}, &r); err != nil {
		return err
	}
	if a.g.json {
		return printJSON(r)
	}
	return nil
}

func cmdClose(in []string) error {
	a, err := parse(in, map[string]flagKind{"grace": valueFlag})
	if err != nil {
		return err
	}
	id, err := onePane(a, "close")
	if err != nil {
		return err
	}
	params := map[string]any{"pane": id}
	if v := a.values["grace"]; v != "" {
		d, err := duration(v)
		if err != nil {
			return err
		}
		params["grace_ms"] = d.Milliseconds()
	}
	ctx, cancel := callCtx(90 * time.Second)
	defer cancel()
	c, err := connectFor(ctx, a.g, id)
	if err != nil {
		return err
	}
	defer c.Close()
	var r proto.CloseResult
	if err := c.Call(ctx, "pane.close", params, &r); err != nil {
		return err
	}
	if a.g.json {
		return printJSON(r)
	}
	fmt.Printf("closed %s (%d processes)\n", r.Pane.ID, r.Signalled)
	return nil
}
