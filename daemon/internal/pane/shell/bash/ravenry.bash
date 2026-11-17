# Ravenry's shell integration for bash. It marks each step of a command
# with OSC 133 (A a prompt starts, B input starts, C a command runs, D it
# ended with its status) and tells the terminal the working folder with
# OSC 7. Ctrl+Left and Ctrl+Right (CSI 1;5D and 1;5C) move a word, where
# the user's inputrc left them unbound. The user's files are never
# changed. Opt out with
# RAVENRY_SHELL_INTEGRATION=0.
#
# ravenryd loads it one of two ways:
#
#   - bash 4 and newer: bash starts in POSIX mode with ENV naming this
#     file (POSIX mode reads only ENV), and this file leaves POSIX mode
#     and runs the user's startup files as bash would have
#     (RAVENRY_BASH_INJECT holds the --norc and --noprofile it was given,
#     RAVENRY_BASH_RCFILE its --rcfile).
#   - bash 3.2, as macOS ships it, which reads its usual files even in
#     POSIX mode: PROMPT_COMMAND in the environment sources this file at
#     the first prompt, after the user's files ran (RAVENRY_BASH_BOOT).
#     A startup file that sets PROMPT_COMMAND outright, rather than adding
#     to it, keeps the integration out.
#
# Parts of this file (leaving POSIX mode and running the user's startup
# files as bash would have, under RAVENRY_BASH_INJECT) are based on the
# bash integration of Ghostty (https://github.com/ghostty-org/ghostty,
# src/shell-integration/bash/ghostty.bash), parts of which are based on
# the bash integration of kitty (https://github.com/kovidgoyal/kitty,
# Copyright Kovid Goyal). Both are distributed under the GNU General
# Public License, version 3 or (at your option) any later version; this
# file is distributed under version 3 (LICENSE at the root of this
# repository).

if [ -n "${RAVENRY_BASH_INJECT-}" ]; then
  builtin declare _ravenry_flags="$RAVENRY_BASH_INJECT"
  builtin unset ENV RAVENRY_BASH_INJECT
  if [ -n "${RAVENRY_BASH_ENV+X}" ]; then
    builtin export ENV="$RAVENRY_BASH_ENV"
    builtin unset RAVENRY_BASH_ENV
  fi
  builtin set +o posix
  if [[ $_ravenry_flags != *--noprofile* ]] && builtin shopt -q login_shell; then
    if [ -r /etc/profile ]; then builtin source /etc/profile; fi
    for _ravenry_f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
      if [ -r "$_ravenry_f" ]; then builtin source "$_ravenry_f"; break; fi
    done
  elif [[ $_ravenry_flags != *--norc* ]]; then
    # The system bashrc, where this bash's build reads one.
    for _ravenry_f in /etc/bash.bashrc /etc/bash/bashrc; do
      if [ -r "$_ravenry_f" ]; then builtin source "$_ravenry_f"; break; fi
    done
    _ravenry_f="${RAVENRY_BASH_RCFILE:-$HOME/.bashrc}"
    if [ -r "$_ravenry_f" ]; then builtin source "$_ravenry_f"; fi
  fi
  builtin unset _ravenry_f _ravenry_flags RAVENRY_BASH_RCFILE
fi

if [ -n "${RAVENRY_BASH_BOOT-}" ]; then
  # Take the bootstrap out of PROMPT_COMMAND, wherever the user's files
  # put it, and give back what the environment had.
  _ravenry_boot="$RAVENRY_BASH_BOOT"
  builtin unset RAVENRY_BASH_BOOT
  # What the user's files added after the bootstrap still runs in this
  # PROMPT_COMMAND, so the first command line only counts from the next
  # prompt then.
  _ravenry_rest="${PROMPT_COMMAND#*"$_ravenry_boot"}"
  if [[ $_ravenry_rest == *[![:space:]\;]* ]]; then _ravenry_first=late; else _ravenry_first=now; fi
  # What the environment had takes the bootstrap's place (a no-op when it
  # had nothing, which keeps separators around it valid).
  if [[ $PROMPT_COMMAND == *"$_ravenry_boot"* ]]; then
    PROMPT_COMMAND="${PROMPT_COMMAND%%"$_ravenry_boot"*}${RAVENRY_BASH_PROMPT_COMMAND:-:}$_ravenry_rest"
  fi
  if [ -n "${RAVENRY_BASH_PROMPT_COMMAND+X}" ]; then
    builtin unset RAVENRY_BASH_PROMPT_COMMAND
  else
    builtin export -n PROMPT_COMMAND
  fi
  builtin unset _ravenry_boot _ravenry_rest
fi

if [[ $- == *i* && -z "${_ravenry_loaded-}" ]]; then
  _ravenry_loaded=1
  _ravenry_ran=
  _ravenry_at_prompt=
  _ravenry_ret=0

  # REPLY: $1 percent-encoded, byte by byte.
  _ravenry_urlencode() {
    builtin local LC_ALL=C s="$1" out= c i n
    for (( i = 0; i < ${#s}; i++ )); do
      c="${s:i:1}"
      case "$c" in
        [A-Za-z0-9/._~-]) out+="$c" ;;
        *) builtin printf -v n '%d' "'$c"; builtin printf -v c '%%%02X' $(( n & 255 )); out+="$c" ;;
      esac
    done
    REPLY="$out"
  }

  # First in PROMPT_COMMAND: the status of the command that ended.
  _ravenry_status() { _ravenry_ret=$?; }

  # Last in PROMPT_COMMAND: D, the folder, and the marks around PS1, put
  # back when something redrew it.
  _ravenry_prompt() {
    if [ -n "$_ravenry_ran" ]; then
      builtin printf '\033]133;D;%d\007' "$_ravenry_ret"
      _ravenry_ran=
    fi
    _ravenry_urlencode "$PWD"
    builtin printf '\033]7;file://%s%s\007' "${HOSTNAME-}" "$REPLY"
    # redraw=1: readline draws the prompt again on a resize, so the
    # terminal clears the old one first (libghostty-vt does not assume it).
    [[ $PS1 == *'\e]133;A;redraw=1\a'* ]] || PS1='\[\e]133;A;redraw=1\a\]'"$PS1"
    [[ $PS1 == *'\e]133;B\a'* ]] || PS1="$PS1"'\[\e]133;B\a\]'
    _ravenry_at_prompt=1
    return "$_ravenry_ret"
  }

  # C: the first command bash runs after a prompt, from the DEBUG trap.
  # An empty line runs PROMPT_COMMAND again instead, which starts with
  # _ravenry_status.
  _ravenry_debug() {
    [ -n "$_ravenry_at_prompt" ] || return 0
    [ -z "${COMP_LINE-}" ] || return 0
    _ravenry_at_prompt=
    [[ $BASH_COMMAND != _ravenry_status* ]] || return 0
    _ravenry_ran=1
    builtin local line=
    if [[ -o history ]]; then
      line="$(HISTTIMEFORMAT= builtin history 1)"
      if [[ $line =~ ^[[:space:]]*[0-9]+[*[:space:]][[:space:]]*(.*)$ ]]; then
        line="${BASH_REMATCH[1]}"
      else
        line=
      fi
    fi
    if [ -n "$line" ]; then
      _ravenry_urlencode "${line:0:4096}"
      builtin printf '\033]133;C;cmdline_url=%s\007' "$REPLY"
    else
      builtin printf '\033]133;C\007'
    fi
  }

  # Ctrl+Left and Ctrl+Right a word left and right, unless bound already.
  if ! builtin bind -p 2>/dev/null | command grep -q '^"\\e\[1;5D"'; then
    builtin bind '"\e[1;5D": backward-word' 2>/dev/null
  fi
  if ! builtin bind -p 2>/dev/null | command grep -q '^"\\e\[1;5C"'; then
    builtin bind '"\e[1;5C": forward-word' 2>/dev/null
  fi

  if [[ "$(builtin declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=(_ravenry_status "${PROMPT_COMMAND[@]}" _ravenry_prompt)
  else
    PROMPT_COMMAND="_ravenry_status
${PROMPT_COMMAND-}
_ravenry_prompt"
  fi
  # C needs the DEBUG trap; a user's own DEBUG trap keeps it (and C) out.
  if [ -z "$(builtin trap -p DEBUG)" ]; then
    builtin trap '_ravenry_debug' DEBUG
  fi
  # Loaded from PROMPT_COMMAND at the first prompt: this prompt is
  # already being drawn, so mark it now.
  if [ -n "${_ravenry_first-}" ]; then
    _ravenry_prompt
    [ "$_ravenry_first" = now ] || _ravenry_at_prompt=
    builtin unset _ravenry_first
  fi
fi
