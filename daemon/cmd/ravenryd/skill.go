package main

import (
	"fmt"
	"strings"
)

// `ravenry skill` prints the guide an agent reads before it drives
// Ravenry's terminals. The prose below is written once; the command
// reference at its end is generated from the command table
// (commands.go), so it always describes this binary's own commands and
// flags.

const skillIntro = `# Ravenry

Drive the terminals of Ravenry (its panes) from the command line: start
programs, read their screens, type into them, wait for what you expect,
and stop to ask the person you work for when you need them.

This guide is printed by the installed binary (` + "`ravenry skill`" + `), so it
describes the version you are running: VERSION.

## Where you are

Ravenry sets these in every pane it runs:

- ` + "`RAVENRY_PANE`" + `: your own pane's id ("p" and 7 characters).
- ` + "`RAVENRY_SOCKET`" + `: the daemon that runs your pane. Every command uses it,
  so you reach the right machine and version without looking.

If they are not set, you are not in a Ravenry pane: commands then use the
newest daemon on this machine (and start one if none runs).

## Words

| The person says | Ravenry |
| --- | --- |
| terminal, tab, pane, shell | a pane: ` + "`ravenry new`" + ` |
| what is on screen | ` + "`ravenry capture PANE`" + ` |
| type, press, paste | ` + "`ravenry send PANE --paste TEXT --key Enter`" + ` |
| wait until it is done | ` + "`ravenry wait PANE --prompt`" + `, ` + "`--text`" + `, ` + "`--quiet`" + `, ` + "`--exit`" + ` |
| ask me, check with me | ` + "`ravenry ask --wait \"...\" --option Done`" + ` |
| I'll run it myself / needs my OK | ` + "`ravenry approve 'COMMAND'`" + ` |
| a password, a token, a one-time code | ` + "`ravenry secret \"...\" -- PROGRAM ARGS`" + ` |
| a page in Ravenry's sidebar (playtest notes, a reading list) | write ` + "`~/.ravenry/pages/<id>.page.yaml`" + ` and its items, then ` + "`ravenry page check FILE`" + `; ` + "`ravenry page docs`" + ` has the format |

## Rules that save you

- **Never type into your own pane.** ` + "`send`" + ` and ` + "`settle`" + ` to ` + "`$RAVENRY_PANE`" + `
  type into the program running you. Start a pane for the work instead:
  ` + "`id=$(ravenry new --cwd \"$PWD\")`" + `.
- **Wait for a condition, never sleep.** ` + "`ravenry send`" + ` prints a mark; pass it
  to ` + "`wait --since`" + ` and the wait sees exactly what your input caused:

      mark=$(ravenry send "$id" --paste 'npm test' --key Enter)
      ravenry wait "$id" --prompt --since "$mark" --timeout 10m --json

  ` + "`--prompt`" + ` holds when the shell is back at its prompt and gives the
  command's exit status; ` + "`--quiet 800ms`" + ` holds once the screen stops
  changing, for programs that draw their own screen.
- **One call instead of press, sleep, read.** ` + "`ravenry settle PANE --key Down`" + `
  sends the key, waits for the screen to settle and prints the rows that
  changed.
- **Pick the typing mode.** ` + "`--paste`" + ` is one paste; ` + "`--typed`" + ` is key by key
  (Claude Code's ` + "`!`" + ` bash mode only works typed); ` + "`--raw`" + ` is bytes.
- **Read only what is new.** ` + "`ravenry read PANE --since MARK`" + ` reads the pane's
  log from a mark, instead of capturing the whole screen again.
- **Dim text is information.** ` + "`capture --styles`" + ` shows it: a greyed
  suggestion is not typed text.
- **A timed-out wait is not a failure of the command.** It exits 124; look
  at the pane (` + "`capture`" + `) before you send anything again.
- **Check what runs before you say a fix is live.** A server or board
  started before your change still runs the old code. ` + "`ravenry process PANE`" + `
  gives its command, executable, start, the git HEAD it started on and
  ` + "`changed`" + ` with why (HEAD moved, files edited, executable rebuilt). When it
  changed, ` + "`ravenry restart PANE --command`" + ` reruns the shell's command in the
  same pane (` + "`ravenry restart PANE`" + ` restarts a pane that runs it directly).
- **Clean up.** ` + "`ravenry close PANE`" + ` ends the pane and every process it
  started, including ones that detached. For a pane only you need, use
  ` + "`new --hidden --ttl 30m`" + ` so it goes by itself.
- **Do not stop or restart the daemon** (` + "`ravenryd serve`" + `): it holds every
  terminal of the person, and other versions may run beside it on purpose.

## Checkpoints: when you need the person

` + "`ask`" + `, ` + "`approve`" + ` and ` + "`secret`" + ` show a card in the Ravenry app and an alert on
the person's phone, and wait (by default) until they answer there. The
person never needs to come back to your chat.

- **Ask and wait.** Arm it before they act, with a timeout:

      ravenry ask --wait "Put on the headset and open the game" --option Done --option "Didn't work" --timeout 20m

  It prints the button they pressed (or the text they typed, with
  ` + "`--text`" + `). Branch on that output.
- **Approve and run.** For a command you must not run yourself (a push, a
  publish, anything the person keeps for themselves):

      ravenry approve 'git push && npm publish' --why "Release 0.4.1" --warn "Publishing to npm can't be undone"

  They see the exact text, and it runs only if they approve, in a new pane
  in your folder they can watch. You get its output and its exit status,
  as if you had run it. ` + "`--warn`" + ` says what can't be undone; it shows as
  your warning, beside Ravenry's own guess. The person may edit the
  command before approving it: then the edited one runs, and you are told
  so with its final text. A declined command comes with their reason when
  they gave one. Never retry a declined command another way.
- **Secrets.** Never ask the person to paste a password, token or code into
  your chat. Ask for it here; it goes to the program, never to you, and is
  masked in the pane's output, logs and captures:

      ravenry secret "Mail service API key" -- npx wrangler secret put MAIL_API_KEY
      ravenry secret "npm one-time code" --pane "$id"     # a program already waiting in that pane
      ravenry secret "npm token" --env NPM_TOKEN -- npm publish

  With a command, it starts in a new pane and the secret is typed once it
  waits for input (or given in ` + "`--env`" + `); you get the command's output and
  status. ` + "`--pane`" + ` can never be your own pane.
- **Exit status** of ask, approve, secret and ` + "`checkpoint ID --wait`" + `:
  0 answered (for a command: the command's own status), 124 nobody answered
  in time, 125 the person declined (or it was cancelled), 1 anything else.
- ` + "`--no-wait`" + ` prints the checkpoint id and returns: arm it, do other work,
  then ` + "`ravenry checkpoint ID --wait`" + `. Withdraw one you no longer need with
  ` + "`ravenry checkpoint ID --cancel`" + `.
- **Only the person answers.** You cannot answer a checkpoint, yours or
  another agent's: ` + "`checkpoint ID --answer`" + `, ` + "`--approve`" + ` and ` + "`--decline`" + ` are for
  the person at a terminal, and the daemon and the hub refuse an answer
  from any program inside a pane, however it connects. Wait for them.

## Before you ask the person anything

- **Check their decisions first.** ` + "`ravenry decisions --search WORD`" + ` lists the
  directions the person already gave for this project, in their own
  words, newest first. If one answers your question, follow it and do not
  ask again.
- **Record a direction they give you,** verbatim, so later sessions follow
  it: ` + "`ravenry decide \"THEIR EXACT WORDS\"`" + ` (` + "`--replaces ID`" + ` when it overrides
  an earlier one). Never paraphrase, never record your own idea as theirs.
  The person sees it at once and can undo or edit it.
- **Pictures, not words, for a look.** ` + "`ravenry pick \"Which header?\" --variant A=a.png --variant B=b.html --variant C=pane:$id`" + `
  shows 2 to 4 variants and waits; it prints the label they picked, then
  ` + "`region x y w h`" + ` (the part they circled, fractions of the picture) and
  ` + "`note ...`" + ` ("this, but..."). Exit codes as ` + "`ask`" + `. Say what each
  one is with ` + "`--describe A=\"The hull stays flat\"`" + `: the label stays its name.

## Panes you did not start

- **You drive the panes you started** (and the panes those started).
  Typing into any other pane, another agent's session included, and
  closing, restarting or overriding it, asks the person first: ` + "`send`" + ` waits until they let you (once, or for your
  session), and exits 125 if they say no. ` + "`--no-wait`" + ` fails at once and
  prints the checkpoint instead. Say why with ` + "`--reason \"...\"`" + `, in a
  sentence: the person reads it on the question.
- **Every input is logged with who sent it** (` + "`ravenry inputs PANE`" + `): the
  person always sees what you typed.
- **One driver at a time.** ` + "`ravenry lease PANE --ttl 10m`" + ` keeps other agents
  out (they exit 75); renew it the same way, ` + "`--release`" + ` when done. The
  person's own typing is never held back.
- ` + "`ravenry files PANE`" + `: the files an agent changed there (from its hooks,
  and git status).

## Seeing what a program draws

- ` + "`ravenry shot PANE -o shot.png`" + ` is a picture of the screen with its
  colours: look at it before you say a TUI looks right.
- ` + "`ravenry frames PANE --last 5s -o strip.gif`" + ` is a filmstrip of its last
  seconds: flicker, half-drawn menus and stalled spinners show there.
- ` + "`ravenry override PANE --size 80x24`" + ` (or ` + "`--phone`" + `, ` + "`--slow 2000`" + `,
  ` + "`--term dumb --restart`" + `) tests the program under those conditions;
  ` + "`--clear`" + ` takes them off.
- ` + "`ravenry fixture PANE --last 30s -o bug.fixture.json`" + ` turns a real
  session into a test fixture; ` + "`ravenry replay bug.fixture.json --headless -o end.png`" + `
  plays it into a fresh screen, at any ` + "`--speed`" + `.

## Two names, one binary

` + "`ravenry`" + ` is what you type. ` + "`ravenryd`" + ` is the same binary's service side:
` + "`ravenryd serve`" + ` (the daemon), ` + "`ravenryd proxy`" + ` (what ` + "`ssh host ravenryd proxy`" + `
runs), ` + "`ravenryd hook`" + ` (what Claude Code's and Codex's hooks run) and
` + "`ravenryd daemons`" + `. Every command also works as ` + "`ravenryd COMMAND`" + `.

## Commands

Every command takes ` + "`--json`" + ` (print JSON, the stable form to parse),
` + "`--socket PATH`" + ` and ` + "`--no-start`" + `. Key names for ` + "`--key`" + `: Enter Tab Escape
Backspace Delete Insert Home End PageUp PageDown Up Down Left Right Space
F1-F12 or one character, with Ctrl+ Alt+ Shift+ Super+ (or C- M- S-).
`

func skillText() string {
	var b strings.Builder
	b.WriteString(strings.Replace(skillIntro, "VERSION", version, 1))
	for _, g := range groups {
		var cs []*command
		for _, c := range commands {
			if c.group == g && !c.service && c.name != "help" {
				cs = append(cs, c)
			}
		}
		if len(cs) == 0 {
			continue
		}
		fmt.Fprintf(&b, "\n### %s\n\n", g)
		for _, c := range cs {
			line := "ravenry " + c.name
			if c.args != "" {
				line += " " + c.args
			}
			fmt.Fprintf(&b, "- `%s`: %s.\n", line, c.summary)
			for _, f := range c.flags {
				fmt.Fprintf(&b, "  - `%s`: %s\n", flagLine(f), f.help)
			}
		}
	}
	return b.String()
}

func cmdSkill(in []string) error {
	a, err := parse(in, specOf("skill"))
	if err != nil {
		return err
	}
	if a.g.json {
		return printJSON(map[string]string{"skill": skillText(), "version": version})
	}
	fmt.Print(skillText())
	return nil
}
