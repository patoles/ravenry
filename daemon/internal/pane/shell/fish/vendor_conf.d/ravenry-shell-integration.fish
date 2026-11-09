# Ravenry's shell integration for fish. ravenryd puts this folder's parent
# first in XDG_DATA_DIRS, so fish reads this file with its vendor
# configuration, before the user's config.fish. It gives XDG_DATA_DIRS
# back, then in an interactive shell marks each step of a command with
# OSC 133 (A a prompt starts, B input starts, C a command runs, D it ended
# with its status) and tells the terminal the working folder with OSC 7.
# The user's files are never changed. Opt out with
# RAVENRY_SHELL_INTEGRATION=0.

if set -q RAVENRY_FISH_XDG_DIR
    set -l keep
    for d in (string split : -- "$XDG_DATA_DIRS")
        test "$d" = "$RAVENRY_FISH_XDG_DIR"; or set -a keep $d
    end
    if set -q keep[1]; and not set -q RAVENRY_FISH_XDG_UNSET
        set -gx XDG_DATA_DIRS (string join : -- $keep)
    else
        set -e XDG_DATA_DIRS
    end
    set -e RAVENRY_FISH_XDG_DIR
    set -q RAVENRY_FISH_XDG_UNSET; and set -e RAVENRY_FISH_XDG_UNSET
end

status is-interactive; or exit 0
set -q _ravenry_fish_loaded; and exit 0
set -g _ravenry_fish_loaded 1

function _ravenry_preexec --on-event fish_preexec
    set -g _ravenry_ran 1
    printf '\e]133;C;cmdline_url=%s\a' (string escape --style=url -- (string sub -l 4096 -- "$argv"))
end

function _ravenry_postexec --on-event fish_postexec
    set -l s $status
    if set -q _ravenry_ran
        set -e _ravenry_ran
        printf '\e]133;D;%s\a' $s
    end
end

function _ravenry_restore_status
    return $argv[1]
end

# At each prompt, the folder; at the first, A and B around the user's
# prompt (their config.fish has run by then).
function _ravenry_prompt_event --on-event fish_prompt
    printf '\e]7;file://%s%s\a' "$hostname" (string escape --style=url -- "$PWD")
    if not functions -q _ravenry_user_prompt; and functions -q fish_prompt
        functions -c fish_prompt _ravenry_user_prompt
        function fish_prompt
            set -l s $status
            # redraw=1: fish repaints its prompt on a resize, so the
            # terminal clears the old one first.
            printf '\e]133;A;redraw=1\a'
            _ravenry_restore_status $s
            _ravenry_user_prompt
            printf '\e]133;B\a'
        end
    end
end
