# Ravenry's shell integration for zsh. ravenryd starts zsh with ZDOTDIR
# naming this folder, so zsh reads this file first. It gives ZDOTDIR back,
# runs the user's own .zshenv, and in an interactive shell loads the
# integration. zsh then reads the user's .zprofile, .zshrc and .zlogin
# from their own ZDOTDIR (or HOME) as usual. The user's files are never
# changed. Opt out with RAVENRY_SHELL_INTEGRATION=0.

if [[ -n "${RAVENRY_ZSH_ZDOTDIR+X}" ]]; then
  'builtin' 'export' ZDOTDIR="$RAVENRY_ZSH_ZDOTDIR"
  'builtin' 'unset' 'RAVENRY_ZSH_ZDOTDIR'
else
  'builtin' 'unset' 'ZDOTDIR'
fi

{
  'builtin' 'typeset' _ravenry_file="${ZDOTDIR-$HOME}/.zshenv"
  [[ ! -r "$_ravenry_file" ]] || 'builtin' 'source' '--' "$_ravenry_file"
} always {
  if [[ -o 'interactive' ]]; then
    _ravenry_file="${${(%):-%x}:A:h}/ravenry-integration.zsh"
    [[ ! -r "$_ravenry_file" ]] || 'builtin' 'source' '--' "$_ravenry_file"
  fi
  'builtin' 'unset' '_ravenry_file'
}
