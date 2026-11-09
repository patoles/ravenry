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
var groups = []string{"Panes", "Waiting and input", "Who drives", "Pictures and recordings", "Checkpoints", "Decisions", "Agents", "Pages", "Guide", "Daemon"}

func init() {
	durationArg := "DURATION"
	input := []flagDoc{
		{"paste", valueFlag, "TEXT", "one paste (bracketed when the program asked for it)"},
		{"typed", valueFlag, "TEXT", "one key at a time, never one read (Claude Code's ! bash mode needs it)"},
		{"raw", valueFlag, "TEXT", "the bytes as they are, in one write"},
		{"key", valueFlag, "NAME", "a named key: Enter, Ctrl+C, Up, Shift+Tab, M-x, ..."},
		{"delay", valueFlag, durationArg, "pause between typed characters (default 10ms)"},
		{"no-wait", boolFlag, "", "into a pane you did not start: fail at once (exit 125, printing the checkpoint) instead of waiting for the person to let you"},
		{"reason", valueFlag, "TEXT", "into a pane you did not start: why, in your words; the person reads it on the question"},
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
		{name: "process", group: "Panes", args: "PANE", summary: "what runs in its foreground: pid, arguments, executable and when it was built, folder, start, the git HEAD it started on, and whether its code changed since (HEAD moved, files edited, executable rebuilt)", run: cmdProcess},
		{name: "update", group: "Panes", args: "PANE", summary: "rename a pane, or set and remove its labels", flags: []flagDoc{
			{"name", valueFlag, "NAME", "its new name (empty clears it)"},
			{"label", listFlag, "KEY=VALUE", "set a label (repeatable)"},
			{"unlabel", listFlag, "KEY", "remove a label (repeatable)"},
		}, run: cmdUpdate},
		{name: "resize", group: "Panes", args: "PANE COLSxROWS", summary: "change its size", run: cmdResize},
		{name: "attach", group: "Panes", args: "PANE | --new [-- COMMAND ARGS...]", summary: "put a pane in this terminal: its screen, then live output; your keys go to it and this terminal's size becomes its size (what the native app runs inside each terminal view). Leaves the pane running when the terminal goes away", flags: []flagDoc{
			{"new", boolFlag, "", "start a new pane at this terminal's size (the login shell when no command is given) and attach to it"},
			{"cwd", valueFlag, "DIR", "with --new: working directory (default: home)"},
			{"name", valueFlag, "NAME", "with --new: a name for people"},
			{"label", listFlag, "KEY=VALUE", "with --new: a label for programs (repeatable)"},
			{"close", boolFlag, "", "with --new: close the pane when this terminal goes away"},
		}, run: cmdAttach},
		{name: "clear", group: "Panes", args: "PANE", summary: "clear its screen and scrollback as Cmd+K does: the prompt stays at the top, everything above it goes (not on a full-screen program's screen)", run: cmdClear},
		{name: "restart", group: "Panes", args: "PANE", summary: "close it and start its command again (same env, its current folder, name and labels); prints the new id. A pane you did not start waits for the person's yes", flags: []flagDoc{
			{"no-wait", boolFlag, "", "a pane you did not start: fail at once (exit 125, printing the checkpoint) instead of waiting for the person"},
			{"reason", valueFlag, "TEXT", "for a pane you did not start: why, in your words; the person reads it on the question"},
			{"grace", valueFlag, durationArg, "how long its processes get to end (default 1s)"},
			{"command", boolFlag, "", "only the command its shell runs, in the same pane: Ctrl-C (then SIGTERM, SIGKILL within --grace), wait for the prompt, type the same command line; prints the mark just before it"},
		}, run: cmdRestart},
		{name: "close", group: "Panes", args: "PANE", summary: "end the pane and every process it started. A pane you did not start waits for the person's yes", flags: []flagDoc{
			{"no-wait", boolFlag, "", "a pane you did not start: fail at once (exit 125, printing the checkpoint) instead of waiting for the person"},
			{"reason", valueFlag, "TEXT", "for a pane you did not start: why, in your words; the person reads it on the question"},
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
		// Who drives
		{name: "inputs", group: "Who drives", args: "PANE", summary: "who typed what into a pane: the person, an agent (its pane) or a program, oldest first; secrets and password prompts never shown", flags: []flagDoc{
			{"since", valueFlag, "SEQ", "after this record"},
			{"limit", valueFlag, "N", "at most this many (default 200)"},
		}, run: cmdInputs},
		{name: "lease", group: "Who drives", args: "PANE", summary: "be the one agent driving a pane: another agent's input is refused (exit 75) until it ends; the person is never held back; asks the person first for a pane you did not start; prints when it ends", flags: []flagDoc{
			{"ttl", valueFlag, durationArg, "how long it lasts (default 60s, at most 1h); lease again to renew"},
			{"wait", valueFlag, durationArg, "while another agent holds it, wait in turn this long"},
			{"release", boolFlag, "", "let it go"},
			{"no-wait", boolFlag, "", "do not wait for the person to let you drive the pane"},
			{"reason", valueFlag, "TEXT", "for a pane you did not start: why, in your words; the person reads it on the question"},
		}, run: cmdLease},
		{name: "grants", group: "Who drives", args: "[PANE]", summary: "the agents a person let type into panes they did not start, for their session", run: cmdGrants},
		{name: "revoke", group: "Who drives", args: "GRANT", summary: "end a grant (a person only: refused inside a pane)", run: cmdRevoke},
		{name: "files", group: "Who drives", args: "PANE", summary: "the files the agent in a pane changed: from its hooks (paths only) and git status in its folder", flags: []flagDoc{
			{"no-git", boolFlag, "", "only what the hooks said"},
		}, run: cmdFiles},
		// Pictures and recordings
		{name: "shot", group: "Pictures and recordings", args: "PANE", summary: "a PNG of a pane, with its colours and styles, to check how a TUI looks", flags: []flagDoc{
			{"out", valueFlag, "FILE", "where (-o FILE; default PANE.png; - for standard output)"},
			{"size", valueFlag, "COLSxROWS", "as it would look at this size, reflowed (the program is not told; for that, override --size)"},
			{"font-size", valueFlag, "PX", "text size (default 14)"},
			{"no-cursor", boolFlag, "", "leave the cursor out"},
		}, run: cmdShot},
		{name: "frames", group: "Pictures and recordings", args: "PANE", summary: "a filmstrip of a pane's last seconds (about 20 are kept), to see flicker, half-drawn menus and spinners that stall", flags: []flagDoc{
			{"out", valueFlag, "FILE", "a .gif, an .apng or .png (animated), or a folder for one PNG a frame (-o FILE; default PANE.gif)"},
			{"last", valueFlag, durationArg, "how far back (default 10s)"},
			{"max", valueFlag, "N", "at most this many frames, spread over the stretch (default 100)"},
			{"font-size", valueFlag, "PX", "text size (default 14)"},
		}, run: cmdFrames},
		{name: "fixture", group: "Pictures and recordings", args: "PANE", summary: "save a span of a pane's output with its timing as a test fixture (JSON); secrets stay masked; works for a closed pane whose log is kept", flags: []flagDoc{
			{"out", valueFlag, "FILE", "where (-o FILE; default PANE.fixture.json; - for standard output)"},
			{"from", valueFlag, "MARK", "start here"},
			{"to", valueFlag, "MARK", "end here"},
			{"last", valueFlag, durationArg, "the latest stretch instead"},
		}, run: cmdFixture},
		{name: "replay", group: "Pictures and recordings", args: "PANE|FIXTURE", summary: "play a pane's recording or a fixture into a fresh pane (prints its id), or headless (prints the screen it ends on)", flags: []flagDoc{
			{"speed", valueFlag, "N", "1 as recorded, 2 twice as fast, max as fast as it goes"},
			{"headless", boolFlag, "", "into a fresh screen of the daemon's, not a pane"},
			{"out", valueFlag, "FILE", "headless: a PNG of the screen it ends on (-o FILE)"},
			{"frames", valueFlag, "FILE", "headless: its filmstrip, as frames --out takes"},
			{"size", valueFlag, "COLSxROWS", "at this size"},
			{"phone", boolFlag, "", "at phone width (40x30)"},
			{"slow", valueFlag, "BPS", "as over a slow link: this many bytes a second"},
			{"term", valueFlag, "NAME", "the TERM the replay pane gets"},
			{"font-size", valueFlag, "PX", "headless pictures' text size"},
		}, run: cmdReplay},
		{name: "override", group: "Pictures and recordings", args: "PANE", summary: "test conditions on a pane: a size its program sees and redraws for (its window's size comes back with --clear), slowed output, another TERM at its next restart", flags: []flagDoc{
			{"size", valueFlag, "COLSxROWS", "the size the program sees (80x24 for 80 columns); 0x0 gives the window's size back"},
			{"phone", boolFlag, "", "phone width: 40x30"},
			{"slow", valueFlag, "BPS", "its output at this many bytes a second (0: not slowed)"},
			{"term", valueFlag, "NAME", "TERM for its next restart (dumb, vt100, xterm; empty: as it was)"},
			{"restart", boolFlag, "", "restart it now, with them (prints the new pane's id)"},
			{"clear", boolFlag, "", "take every condition off"},
			{"reason", valueFlag, "TEXT", "for a pane you did not start: why, in your words; the person reads it on the question"},
		}, run: cmdOverride},
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
		{name: "pick", group: "Checkpoints", args: "TITLE", summary: "show the person 2 to 4 variants (pictures, HTML pages, or a shot of a pane) and wait for their pick; prints its label, then the region they circled (x y w h, fractions) and their note (\"this, but...\")", flags: append([]flagDoc{
			{"variant", listFlag, "LABEL=FILE", "a variant: an image or an .html file, or LABEL=pane:PANE for a shot of that pane now (repeat 2 to 4 times)"},
			{"describe", listFlag, "LABEL=TEXT", "what a variant is, in your words, under its picture (at most 200 bytes; repeatable)"},
		}, wait...), run: cmdPick},
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
			{"allow", valueFlag, "once|session", "with --approve on a drive: let the agent type this once (default) or for its session"},
			{"command", valueFlag, "TEXT", "with --approve: run this instead, the command as the person edited it"},
			{"decline", boolFlag, "", "a person declines it (refused inside a pane)"},
		}, run: cmdCheckpoint},
		// Decisions
		{name: "decisions", group: "Decisions", summary: "the person's decisions on record, verbatim, newest first: check here before you ask them anything", flags: []flagDoc{
			{"project", valueFlag, "NAME", "this project's (default: the project of this folder)"},
			{"search", valueFlag, "WORDS", "only the ones that say these words"},
			{"all", boolFlag, "", "with the ones a later decision replaced"},
			{"all-projects", boolFlag, "", "every project's"},
		}, run: cmdDecisions},
		{name: "decide", group: "Decisions", args: "QUOTE", summary: "record a direction the person gave, in their exact words, so later sessions follow it; prints its id (the person sees it and can undo it)", flags: []flagDoc{
			{"project", valueFlag, "NAME", "the project it is for (default: the project of this folder)"},
			{"replaces", valueFlag, "ID", "the decision it overrides"},
			{"scope", valueFlag, "TEXT", "what it covers, in a few words (the menus, the release)"},
		}, run: cmdDecide},
		{name: "review", group: "Decisions", args: "reply ID TEXT", summary: "answer the person's review comment on your work (the id is in the comment, rc...): your words join its thread, where they read them; prints the reply's id", run: cmdReview},
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
