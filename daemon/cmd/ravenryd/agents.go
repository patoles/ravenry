package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"ravenryd/internal/proto"
)

func cmdProcess(in []string) error {
	a, err := parse(in, specOf("process"))
	if err != nil {
		return err
	}
	id, err := onePane(a, "process")
	if err != nil {
		return err
	}
	ctx, cancel := callCtx(10 * time.Second)
	defer cancel()
	c, err := connectFor(ctx, a.g, id)
	if err != nil {
		return err
	}
	defer c.Close()
	var r proto.ProcessResult
	if err := c.Call(ctx, "pane.process", map[string]any{"pane": id}, &r); err != nil {
		return err
	}
	if a.g.json {
		return printJSON(r)
	}
	f := r.Foreground
	fmt.Printf("%d\t%s\n", f.PID, strings.Join(f.Argv, " "))
	if f.Cwd != "" {
		fmt.Printf("cwd\t%s\n", f.Cwd)
	}
	if f.Exe != "" {
		fmt.Printf("exe\t%s\n", f.Exe)
	}
	if f.StartedAt != "" {
		fmt.Printf("started\t%s\n", f.StartedAt)
	}
	return nil
}

func cmdRestart(in []string) error {
	a, err := parse(in, specOf("restart"))
	if err != nil {
		return err
	}
	id, err := onePane(a, "restart")
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
	var r proto.RestartResult
	if err := c.Call(ctx, "pane.restart", params, &r); err != nil {
		return err
	}
	if a.g.json {
		return printJSON(r)
	}
	fmt.Println(r.Pane.ID)
	return nil
}

func cmdFocus(in []string) error {
	a, err := parse(in, specOf("focus"))
	if err != nil {
		return err
	}
	id, err := onePane(a, "focus")
	if err != nil {
		return err
	}
	ctx, cancel := callCtx(10 * time.Second)
	defer cancel()
	c, err := connectFor(ctx, a.g, id)
	if err != nil {
		return err
	}
	defer c.Close()
	var r proto.FocusResult
	if err := c.Call(ctx, "pane.focus", map[string]any{"pane": id}, &r); err != nil {
		return err
	}
	if a.g.json {
		return printJSON(r)
	}
	if r.Displays == 0 {
		return fmt.Errorf("no window that shows panes is connected")
	}
	return nil
}

func cmdAgents(in []string) error {
	a, err := parse(in, specOf("agents"))
	if err != nil {
		return err
	}
	ctx, cancel := callCtx(10 * time.Second)
	defer cancel()
	type row struct {
		Pane      string             `json:"pane"`
		Daemon    string             `json:"daemon"`
		Title     string             `json:"title"`
		Agent     *proto.AgentStatus `json:"agent,omitempty"`
		Shell     *proto.Shell       `json:"shell,omitempty"`
		PaneState string             `json:"pane_state"`
	}
	rows := []row{}
	for _, s := range daemonSockets(a.g) {
		c, err := dial(ctx, s)
		if err != nil {
			continue
		}
		var l proto.ListResult
		if c.Call(ctx, "pane.list", map[string]any{"hidden": true}, &l) == nil {
			for _, p := range l.Panes {
				rows = append(rows, row{Pane: p.ID, Daemon: c.Hello.Daemon.Version, Title: p.Title, Agent: p.Agent, Shell: p.Shell, PaneState: p.State})
			}
		}
		c.Close()
	}
	if a.g.json {
		return printJSON(rows)
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "PANE\tAGENT\tSTATE\tSINCE\tLAST EVENT\tSHELL\tTITLE")
	for _, r := range rows {
		agentName, state, since, last := "-", "-", "", ""
		if ag := r.Agent; ag != nil {
			agentName, state, since, last = ag.Assistant, ag.State, ag.Since, ag.Event
			if ag.Need != nil && ag.Need.Message != "" {
				state += ": " + ag.Need.Message
			}
		}
		shell := ""
		if r.Shell != nil {
			shell = r.Shell.State
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", r.Pane, agentName, state, since, last, shell, r.Title)
	}
	return w.Flush()
}

// daemonSockets is the pinned daemon, else every live one.
func daemonSockets(g global) []string {
	if s := pinned(g); s != "" {
		return []string{s}
	}
	var out []string
	for _, d := range liveDaemons() {
		out = append(out, d.socket)
	}
	return out
}

func cmdReports(in []string) error {
	a, err := parse(in, specOf("reports"))
	if err != nil {
		return err
	}
	if len(a.pos) > 1 {
		return fmt.Errorf("usage: ravenryd reports [PANE] [--since SEQ] [--limit N] [--follow]")
	}
	params := map[string]any{}
	pane := ""
	if len(a.pos) == 1 {
		pane = a.pos[0]
		params["pane"] = pane
	}
	if v := a.values["since"]; v != "" {
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			return fmt.Errorf("--since %q is not a sequence number", v)
		}
		params["since"] = n
	}
	if v := a.values["limit"]; v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return fmt.Errorf("--limit %q is not a number", v)
		}
		params["limit"] = n
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cctx, ccancel := callCtx(10 * time.Second)
	defer ccancel()
	var socket string
	if pane != "" {
		c, err := connectFor(cctx, a.g, pane)
		if err != nil {
			return err
		}
		socket = c.Socket()
		c.Close()
	} else if ss := daemonSockets(a.g); len(ss) > 0 {
		socket = ss[0]
	} else {
		return fmt.Errorf("no ravenryd is running")
	}
	c, err := dial(cctx, socket)
	if err != nil {
		return err
	}
	defer c.Close()
	if a.bools["follow"] {
		if err := c.SubscribeEvents(cctx); err != nil {
			return err
		}
	}
	var r proto.AgentEventsResult
	if err := c.Call(cctx, "agent.events", params, &r); err != nil {
		return err
	}
	last := r.Seq
	print := func(rp proto.AgentReport) error {
		if a.g.json {
			return printJSONLine(rp)
		}
		state := rp.State
		if rp.Need != nil {
			state += " (" + rp.Need.Kind + ")"
		}
		where := rp.Pane
		if where == "" {
			where = "-"
		}
		fmt.Printf("%d\t%s\t%s\t%s\t%s\t%s\t%s\n", rp.Seq, rp.At, where, rp.Assistant, rp.Event, state, rp.Message)
		return nil
	}
	for _, rp := range r.Reports {
		if err := print(rp); err != nil {
			return err
		}
	}
	if !a.bools["follow"] {
		return nil
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-c.Events():
			if !ok {
				return fmt.Errorf("the daemon closed the connection")
			}
			if ev.Event != "agent.report" || ev.Report == nil || ev.Report.Seq <= last {
				continue
			}
			if pane != "" && ev.Report.Pane != pane {
				continue
			}
			if err := print(*ev.Report); err != nil {
				return err
			}
		}
	}
}
