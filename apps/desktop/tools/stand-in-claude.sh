#!/bin/sh
# A stand-in for Claude Code, for tools/first-run.mjs: no account, no quota.
# As Claude Code does at start, it runs the SessionStart hooks of
# ~/.claude/settings.json with the event on standard input, then draws a
# banner and a prompt and answers each line typed.
#
# A hook that starts the Ravenry app's own executable without
# ELECTRON_RUN_AS_NODE=1 would open the app (a window on the screen) instead
# of running the hook: it is not run, but written to ~/.stand-in-refused,
# which fails the measurement.
S="$HOME/.claude/settings.json"
sid="stand-in-$$"
ev="{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$sid\",\"cwd\":\"$PWD\",\"source\":\"startup\",\"transcript_path\":\"$HOME/.claude/projects/stand-in/$sid.jsonl\"}"
if [ -f "$S" ]; then
  # The settings are written by Ravenry with two-space indents: the
  # SessionStart list runs from its key to the "]" at the same depth.
  awk '/^    "SessionStart": \[/ { on = 1; next } on && /^    \]/ { on = 0 } on && /"command":/ { print }' "$S" |
    sed -e 's/^ *"command": "//' -e 's/",\{0,1\}$//' -e 's/\\"/"/g' |
    while IFS= read -r c; do
      case "$c" in
        *ELECTRON_RUN_AS_NODE=1*) printf '%s' "$ev" | sh -c "$c" >/dev/null 2>&1 ;;
        */MacOS/Ravenry\ *|*/ravenry\ *) printf '%s\n' "$c" >> "$HOME/.stand-in-refused" ;;
        *) printf '%s' "$ev" | sh -c "$c" >/dev/null 2>&1 ;;
      esac
    done
fi
printf '\n * Welcome to Claude Code (stand-in)\n\n   cwd: %s\n\n> ' "$PWD"
while IFS= read -r line; do printf 'you said: %s\n> ' "$line"; done
