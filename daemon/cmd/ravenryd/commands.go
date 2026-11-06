package main

import (
	"fmt"
	"path/filepath"
	"strings"
)

// One binary, two names (a multi-call binary, picked by argv[0]):
//
//   - ravenry: what people and agents type. The pane commands, waits,
//     input, checkpoints (ask, approve, secret) and the skill.
//   - ravenryd: the service side. serve, proxy, hook, daemons.
//
// Both names run every command, so `ravenryd new` (slice 1's form) keeps
// working; help shows each name its own side. A `ravenry` link next to
// `ravenryd` (make, the app's bundle) gives the second name.
//
// The table below is the one place a command's flags are defined: parse
// takes them from it (specOf), and help and `ravenry skill` print them
// from it, so what is documented is what is accepted.

type flagDoc struct {
	name string
	kind flagKind
	arg  string // what a value flag takes, for help
	help string
}

type command struct {
	name    string
	aliases []string
	service bool   // the ravenryd side
	group   string // the heading it is listed under
	args    string // positional arguments, for help
	summary string
	flags   []flagDoc
	run     func([]string) error
}

var commands []*command

func cmdByName(name string) *command {
	for _, c := range commands {
		if c.name == name {
			return c
		}
		for _, a := range c.aliases {
			if a == name {
				return c
			}
		}
	}
	return nil
}

// specOf is the flags a command accepts.
func specOf(name string) map[string]flagKind {
	c := cmdByName(name)
	if c == nil {
		panic("no command " + name)
	}
	m := map[string]flagKind{}
	for _, f := range c.flags {
		m[f.name] = f.kind
	}
	return m
}

// The groups, in the order help lists them.
var groups = []string{"Panes", "Waiting and input", "Checkpoints", "Agents", "Pages", "Guide", "Daemon"}

func init() {
	durationArg := "DURATION"
	input := []flagDoc{
		{"paste", valueFlag, "TEXT", "one paste (bracketed when the program asked for it)"},
		{"typed", valueFlag, "TEXT", "one key at a time, never one read (Claude Code's ! bash mode needs it)"},
		{"raw", valueFlag, "TEXT", "the bytes as they are, in one write"},
		{"key", valueFlag, "NAME", "a named key: Enter, Ctrl+C, Up, Shift+Tab, M-x, ..."},
		{"delay", valueFlag, durationArg, "pause between typed characters (default 10ms)"},
	}
	wait := []flagDoc{
		{"wait", boolFlag, "", "wait for the answer (the default)"},
		{"no-wait", boolFlag, "", "print the checkpoint's id and return at once; `ravenry checkpoint ID --wait` waits later"},
		{"timeout", valueFlag, durationArg, "how long a person has to answer (default 1h, at most 24h)"},
	}
	commands = []*command{
		// Panes
		{name: "new", group: "Panes", args: "[-- COMMAND ARGS...]", summary: "start a pane (the login shell when no command is given); prints its id", flags: []flagDoc{
			{"cwd", valueFlag, "DIR", "working directory (default: here)"},
			{"env", listFlag, "NAME=VALUE", "add to its environment (repeatable)"},
			{"size", valueFlag, "COLSxROWS", "terminal size (default 80x24)"},
			{"name", valueFlag, "NAME", "a name for people"},
			{"label", listFlag, "KEY=VALUE", "a label for programs (repeatable)"},
			{"hidden", boolFlag, "", "leave it out of ls"},
			{"ttl", valueFlag, durationArg, "with --hidden: close it this long after it started"},
			{"scrollback", valueFlag, "LINES", "history lines (default 10000)"},
		}, run: cmdNew},
		{name: "ls", aliases: []string{"list"}, group: "Panes", summary: "list panes", flags: []flagDoc{
			{"all", boolFlag, "", "include hidden panes"},
			{"label", listFlag, "KEY=VALUE", "only panes with this label (repeatable)"},
		}, run: cmdList},
		{name: "capture", group: "Panes", args: "PANE", summary: "the screen as text", flags: []flagDoc{
			{"styles", boolFlag, "", "with each line's styled runs (dim text is often a suggestion, not typed text)"},
			{"history", valueFlag, "LINES", "add this many scrollback lines"},
			{"vt", boolFlag, "", "add the VT that rebuilds the screen"},
		}, run: cmdCapture},
		{name: "read", group: "Panes", args: "PANE", summary: "what the pane printed since a mark, from its log", flags: []flagDoc{
			{"since", valueFlag, "MARK", "where to start (required)"},
			{"limit", valueFlag, "BYTES", "at most this much (default 1 MiB)"},
			{"raw", boolFlag, "", "the bytes, escapes kept"},
		}, run: cmdRead},
		{name: "process", group: "Panes", args: "PANE", summary: "what runs in its foreground: pid, arguments, executable, folder", run: cmdProcess},
		{name: "update", group: "Panes", args: "PANE", summary: "rename a pane, or set and remove its labels", flags: []flagDoc{
			{"name", valueFlag, "NAME", "its new name (empty clears it)"},
			{"label", listFlag, "KEY=VALUE", "set a label (repeatable)"},
			{"unlabel", listFlag, "KEY", "remove a label (repeatable)"},
		}, run: cmdUpdate},
		{name: "resize", group: "Panes", args: "PANE COLSxROWS", summary: "change its size", run: cmdResize},
		{name: "restart", group: "Panes", args: "PANE", summary: "close it and start its command again (same env, its current folder, name and labels); prints the new id", flags: []flagDoc{
			{"grace", valueFlag, durationArg, "how long its processes get to end (default 1s)"},
		}, run: cmdRestart},
		{name: "close", group: "Panes", args: "PANE", summary: "end the pane and every process it started", flags: []flagDoc{
			{"grace", valueFlag, durationArg, "how long its processes get to end (default 1s)"},
		}, run: cmdClose},
		{name: "focus", group: "Panes", args: "PANE", summary: "ask the windows that show panes to show this one", run: cmdFocus},
		// Waiting and input
		{name: "send", group: "Waiting and input", args: "PANE INPUT...", summary: "send input in order; prints the mark just before it", flags: input, run: func(in []string) error { return cmdSend(in, false) }},
		{name: "settle", group: "Waiting and input", args: "PANE INPUT...", summary: "send input, wait until the screen is quiet, print the rows that changed", flags: append(append([]flagDoc{}, input...),
			flagDoc{"quiet", valueFlag, durationArg, "quiet for this long (default 300ms)"},
			flagDoc{"timeout", valueFlag, durationArg, "give up after (default 10s)"},
		), run: func(in []string) error { return cmdSend(in, true) }},
		{name: "wait", group: "Waiting and input", args: "PANE", summary: "wait for a condition; exits 0 when it held, 124 on timeout", flags: []flagDoc{
			{"text", valueFlag, "REGEX", "new output matches (RE2)"},
			{"screen", boolFlag, "", "with --text: match the visible screen instead"},
			{"quiet", valueFlag, durationArg, "nothing printed for this long"},
			{"exit", boolFlag, "", "the pane's process exited"},
			{"prompt", boolFlag, "", "the shell starts its next prompt (shell integration)"},
			{"since", valueFlag, "MARK", "new output starts here (default now; send prints one)"},
			{"timeout", valueFlag, durationArg, "give up after (default 30s)"},
		}, run: cmdWait},
		// Checkpoints
		{name: "ask", group: "Checkpoints", args: "TITLE", summary: "ask a person, with buttons, and wait for the answer; prints it", flags: append([]flagDoc{
			{"option", listFlag, "TEXT", "a button (repeatable; default: one Done button)"},
			{"text", boolFlag, "", "the person may type an answer instead"},
		}, wait...), run: cmdAsk},
		{name: "approve", group: "Checkpoints", args: "COMMAND | -- PROGRAM ARGS...", summary: "propose a command that runs only once a person approves it, in a new pane; prints its output and exits with its status", flags: append([]flagDoc{
			{"why", valueFlag, "TEXT", "why it should run, shown with it"},
			{"warn", valueFlag, "TEXT", "what can't be undone or could go wrong, shown as your warning"},
			{"cwd", valueFlag, "DIR", "where it runs (default: this pane's folder)"},
		}, wait...), run: cmdApprove},
		{name: "secret", group: "Checkpoints", args: "TITLE [-- PROGRAM ARGS...]", summary: "ask a person to type a secret that goes to a program, never to you", flags: append([]flagDoc{
			{"pane", valueFlag, "PANE", "type it into this running pane (a program waiting at its prompt), not yours"},
			{"env", valueFlag, "NAME", "with a command: give it in this environment variable instead of typing it"},
			{"cwd", valueFlag, "DIR", "with a command: where it runs (default: this pane's folder)"},
			{"no-enter", boolFlag, "", "do not press Enter after typing it"},
		}, wait...), run: cmdSecret},
		{name: "checkpoints", group: "Checkpoints", summary: "list open checkpoints", flags: []flagDoc{
			{"all", boolFlag, "", "with the closed ones the daemon still holds"},
		}, run: cmdCheckpoints},
		{name: "checkpoint", group: "Checkpoints", args: "ID", summary: "show one checkpoint, wait for it, or cancel it; a person may answer it", flags: []flagDoc{
			{"wait", boolFlag, "", "wait until it closes, then exit as ask, approve or secret would"},
			{"timeout", valueFlag, durationArg, "with --wait: give up after (exit 124)"},
			{"cancel", boolFlag, "", "withdraw it (it must still be open)"},
			{"reason", valueFlag, "TEXT", "with --cancel: why, for people; with --decline: why, for the agent"},
			{"answer", valueFlag, "TEXT", "a person answers an ask: an option's number or text, or typed text (refused inside a pane)"},
			{"approve", boolFlag, "", "a person approves it, and its command runs (refused inside a pane)"},
			{"command", valueFlag, "TEXT", "with --approve: run this instead, the command as the person edited it"},
			{"decline", boolFlag, "", "a person declines it (refused inside a pane)"},
		}, run: cmdCheckpoint},
		// Agents
		{name: "agents", group: "Agents", summary: "the agent state of every pane", run: cmdAgents},
		{name: "reports", group: "Agents", args: "[PANE]", summary: "what agents reported, oldest first", flags: []flagDoc{
			{"since", valueFlag, "SEQ", "after this report"},
			{"limit", valueFlag, "N", "at most this many"},
			{"follow", boolFlag, "", "keep printing new ones"},
		}, run: cmdReports},
		// Pages
		{name: "page", group: "Pages", args: "check FILE | docs [TOPIC]", summary: "check a Ravenry page file (*.page.yaml) the way the sidebar reads it, with each problem's line, or print the page docs (a topic: board, ask, run, fields, ...); exits 1 when the file has errors", run: cmdPage},
		// Guide
		{name: "skill", group: "Guide", summary: "print the guide for agents: every command, the traps, the exit codes", run: cmdSkill},
		{name: "help", aliases: []string{"--help", "-h"}, group: "Guide", summary: "this list", run: nil},
		// Daemon (ravenryd)
		{name: "serve", service: true, group: "Daemon", summary: "run the daemon for this machine", flags: []flagDoc{
			{"detach", boolFlag, "", "start it in the background and print its socket"},
		}, run: cmdServe},
		{name: "proxy", service: true, group: "Daemon", summary: "bridge standard input and output to the daemon (ssh host ravenryd proxy)", flags: []flagDoc{
			{"version", valueFlag, "V", "the daemon of this version (default: the newest)"},
		}, run: cmdProxy},
		{name: "hook", service: true, group: "Daemon", summary: "the command an assistant's hooks run: reports the hook's JSON to the pane's daemon, and lets the session go on unless the hub decides", flags: []flagDoc{
			{"assistant", valueFlag, "NAME", "claude, codex, or any name (a-z, 0-9, ., _, -)"},
			{"state", valueFlag, "STATE", "working, needs_you, idle or ended, for assistants without a table here"},
			{"need", valueFlag, "KIND", "with --state needs_you: permission, question, auth or other"},
			{"event", valueFlag, "NAME", "the event's name, when the input has no hook_event_name"},
			{"decide", boolFlag, "", "ask the hub what to answer (Claude Code's and Codex's Stop always do)"},
			{"timeout", valueFlag, durationArg, "how long to wait for the hub (default 2s, at most 60s)"},
		}, run: cmdHook},
		{name: "daemons", service: true, group: "Daemon", summary: "list the daemons running here", run: cmdDaemons},
		{name: "peer", service: true, group: "Daemon", summary: "tell whether a process may act as the person: not inside a pane, not over ssh (the hub asks about who sent an answer)", flags: []flagDoc{
			{"pid", valueFlag, "PID", "this process"},
			{"tcp", valueFlag, "PORT", "the process that holds the TCP connection from this local port..."},
			{"to", valueFlag, "PORT", "...to this local port (the server's)"},
		}, run: cmdPeer},
		{name: "version", aliases: []string{"--version", "-v"}, service: true, group: "Daemon", summary: "this binary's version", run: cmdVersion},
	}
}

// globalFlags every command takes.
var globalFlags = []flagDoc{
	{"socket", valueFlag, "PATH", "talk to this daemon (inside a pane: $RAVENRY_SOCKET)"},
	{"no-start", boolFlag, "", "do not start a daemon when none runs"},
	{"json", boolFlag, "", "print JSON"},
}

// invokedAs is the name the binary runs under: "ravenry" or "ravenryd".
func invokedAs(argv0 string) string {
	b := strings.TrimSuffix(filepath.Base(argv0), ".exe")
	if b == "ravenry" {
		return "ravenry"
	}
	return "ravenryd"
}

func synopsis(name string, c *command) string {
	var b strings.Builder
	b.WriteString(name + " " + c.name)
	if c.args != "" {
		b.WriteString(" " + c.args)
	}
	for _, f := range c.flags {
		if f.kind == boolFlag {
			b.WriteString(" [--" + f.name + "]")
		} else {
			b.WriteString(" [--" + f.name + " " + f.arg + "]")
			if f.kind == listFlag {
				b.WriteString("...")
			}
		}
	}
	return b.String()
}

func flagLine(f flagDoc) string {
	s := "--" + f.name
	if f.kind != boolFlag {
		s += " " + f.arg
	}
	return s
}

// usageText is help for one side of the binary.
func usageText(name string) string {
	var b strings.Builder
	service := name == "ravenryd"
	if service {
		b.WriteString("ravenryd: the Ravenry daemon, the service side of the ravenry binary.\n")
		b.WriteString("Panes, waits, input and checkpoints are `ravenry help` (the same binary, linked as ravenry);\n")
		b.WriteString("`ravenryd <command>` runs them too.\n")
	} else {
		b.WriteString("ravenry: drive Ravenry's terminals from the command line. Agents: `ravenry skill`.\n")
		b.WriteString("The daemon's own commands (serve, proxy, hook, daemons) are `ravenryd help`.\n")
	}
	for _, g := range groups {
		var cs []*command
		for _, c := range commands {
			if c.group == g && (c.service == service || c.name == "help") {
				cs = append(cs, c)
			}
		}
		if len(cs) == 0 {
			continue
		}
		fmt.Fprintf(&b, "\n%s:\n", g)
		for _, c := range cs {
			line := name + " " + c.name
			if c.args != "" {
				line += " " + c.args
			}
			fmt.Fprintf(&b, "  %s\n      %s\n", line, c.summary)
			for _, f := range c.flags {
				fmt.Fprintf(&b, "      %-22s %s\n", flagLine(f), f.help)
			}
		}
	}
	b.WriteString("\nEvery command takes:\n")
	for _, f := range globalFlags {
		fmt.Fprintf(&b, "  %-22s %s\n", flagLine(f), f.help)
	}
	return b.String()
}
