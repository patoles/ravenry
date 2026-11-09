# Ravenry's shell integration for zsh, loaded by .zshenv beside it in an
# interactive shell. It marks each step of a command with OSC 133 (A a
# prompt starts, B input starts, C a command runs, D it ended with its
# status) and tells the terminal the working folder with OSC 7.
#
# It hooks in at the first prompt, after the user's .zshrc ran, so it
# comes after any prompt theme's own hooks; each prompt it puts the A and
# B marks back around PS1 when a theme redrew it.

[[ -z "${_ravenry_zsh_loaded-}" ]] || 'builtin' 'return' 0
typeset -g _ravenry_zsh_loaded=1
typeset -gi _ravenry_ran=0

# REPLY: $1 percent-encoded, byte by byte.
_ravenry_urlencode() {
  emulate -L zsh
  local LC_ALL=C s=$1 out= c
  local -i i n
  for (( i = 1; i <= ${#s}; i++ )); do
    c=${s[i]}
    case $c in
      ([A-Za-z0-9/._~-]) out+=$c ;;
      (*) builtin printf -v n '%d' "'$c"; builtin printf -v c '%%%02X' $(( n & 255 )); out+=$c ;;
    esac
  done
  REPLY=$out
}

_ravenry_precmd() {
  local -i ret=$?
  if (( _ravenry_ran )); then
    builtin printf '\e]133;D;%d\a' $ret
    _ravenry_ran=0
  fi
  _ravenry_urlencode "$PWD"
  builtin printf '\e]7;file://%s%s\a' "${HOST-}" "$REPLY"
  # redraw=1: zsh draws its prompt again on a resize, so the terminal
  # clears the old one first (libghostty-vt does not assume it).
  [[ $PS1 == *$'\e]133;A;redraw=1\a'* ]] || PS1=$'%{\e]133;A;redraw=1\a%}'$PS1
  [[ $PS1 == *$'\e]133;B\a'* ]] || PS1=$PS1$'%{\e]133;B\a%}'
  return $ret
}

_ravenry_preexec() {
  _ravenry_ran=1
  _ravenry_urlencode "${1[1,4096]}"
  builtin printf '\e]133;C;cmdline_url=%s\a' "$REPLY"
}

_ravenry_deferred_init() {
  precmd_functions=(${precmd_functions:#_ravenry_deferred_init} _ravenry_precmd)
  preexec_functions=(${preexec_functions:#_ravenry_preexec} _ravenry_preexec)
  _ravenry_precmd
}

typeset -ga precmd_functions preexec_functions
precmd_functions+=(_ravenry_deferred_init)
