# Ravenry's shell integration for zsh. ravenryd starts zsh with ZDOTDIR
# naming this folder, so zsh reads this file first. It gives ZDOTDIR back,
# runs the user's own .zshenv, and in an interactive shell loads the
# integration. zsh then reads the user's .zprofile, .zshrc and .zlogin
# from their own ZDOTDIR (or HOME) as usual. The user's files are never
# changed. Opt out with RAVENRY_SHELL_INTEGRATION=0.
#
# Parts of this file (giving ZDOTDIR back, and the try/always block that
# runs the user's .zshenv first) are based on the zsh integration of
# Ghostty (https://github.com/ghostty-org/ghostty,
# src/shell-integration/zsh/.zshenv), which started as a copy of the zsh
# integration of kitty (https://github.com/kovidgoyal/kitty, Copyright
# Kovid Goyal). Both are distributed under the GNU General Public License,
# version 3 or (at your option) any later version; this file is
# distributed under version 3 (LICENSE at the root of this repository).

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
