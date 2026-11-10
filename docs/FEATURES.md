# Features

What a Ravenry client must do, one row per feature, and where each client
stands. This is the single list: a new platform (the native Mac app, later
Linux and Windows) is built against it, and no feature is forgotten because
it lived only in one client's code.

Built from the code on 2026-11-09: `apps/desktop/src`, `apps/phone/src`,
`apps/android`, the hub's routes (`hub/server/index.mjs`), the protocol
(`packages/protocol/PROTOCOL.md`), `docs/`, `hub/docs/` and the rows of the
release check (`apps/desktop/tools/release-check.mjs`).

## 1. Rules for every client

- **Logic lives in the hub or the daemon.** A client draws what they send
  and sends the person's intents (a click, a key, an answer). When a client
  has to decide something (which section a session goes in, what a
  checkpoint says), that is a gap to move, listed in section 3.
- **Copy and design tokens come from shared files,** never typed again in a
  client. They live at the repository root, in `shared/`, and
  `shared/README.md` is their format (for Swift and Kotlin too):
  - `shared/strings/en.json`: the user-facing strings, one key each, with
    `{name}` placeholders. Swift and Kotlin read it as it is or through a
    build step that writes constants.
  - `shared/tokens/tokens.json`: colours for dark and light (the window, the
    sheets, text, and the four states: you, work, wait, idle), shadows,
    fonts, type sizes, radii and spacing.
  - `shared/tokens/themes/`: the terminal themes, moved from
    `apps/desktop/src/shared/themes/` (not yet).
  - `shared/icons/`: the icons as SVG files, written from the desktop's
    `icons.ts` by `shared/icons/export.mjs` (`--check` says when they
    drifted); the native Mac app reads them, the desktop still imports
    `icons.ts`.

  What exists today: the colours and shadows of the desktop and the phone
  board come from `shared/tokens/tokens.json`, made CSS variables by
  `shared/tokens/css.mjs` in each build (`apps/desktop/build.mjs` gives
  `app.css` and `settings.css` an `@import "ravenry-tokens.css"`;
  `apps/phone/build.mjs` writes them first in its stylesheet), and
  `apps/desktop/test/shared.test.ts` checks that no stylesheet types them
  again. The phone's copy had drifted and now takes the desktop's values
  (`--tx3` #8E8E93 dark and #6B6B70 light, `--idle-t` .02 light). The type
  sizes, radii and spacing are in the file and are CSS variables
  (`--fs-*`, `--radius-*`, `--space-*`), but the rules of `app.css` and
  `phone.css` still write their sizes as numbers (gap). `hub/public/app.css`
  (the browser board) still has its own copy of the colours, drifted like
  the phone's was (gap). Strings: `shared/strings/en.json` holds the
  sidebar's section titles (`group.you`, `group.work`, `group.wait`,
  `group.idle`, read by the hub through `hub/server/strings.mjs`) and the
  words the desktop and the phone both wrote (pages, checkpoint cards, the
  pick, hand-off, the empty board), read with `t(key, vars)`
  (`apps/desktop/src/shared/strings.ts`, `apps/phone/src/strings.ts`). The
  rest of the strings are still inline in each client's TypeScript (gap:
  moved a screen at a time; `app.ts` and `checkpoints.ts` next, after the
  hub took the board and the checkpoint words). Still shared by import only:
  key names (`hub/public/keys.mjs`), paths as people read them
  (`hub/public/homepath.mjs`), the shipped pages
  (`packages/page-format/defaults/`), and the hub's own words in its API
  answers and phone alerts (`hub/server/push.mjs`). Eight terminal themes
  are in `apps/desktop/src/shared/themes/*.json` with `themes.ts`; icons as
  SVG paths in `apps/desktop/src/renderer/icons.ts` and
  `apps/phone/src/icons.ts`; the brand in `hub/brand/`; the phone's glyph
  font (`apps/phone/src/glyphs.css`, `apps/phone/tools/glyph-font.py`).
- **Every feature has an id,** `AREA-NNN`. An id is never reused or
  renumbered; a feature that goes keeps its row, marked removed.
- **A feature is done on a platform only when its acceptance check passes
  there.** Code that is there without its check passing is `partial`.

### How to read the table

- **Logic:** where the behaviour is decided. `hub` with its route,
  `daemon` with its protocol message (`PROTOCOL.md`), or `client` when the
  client alone does it.
- **Acceptance:** what proves it. `RC-N` is step N of the release check
  (`apps/desktop/tools/release-check.mjs`; steps 14 to 27 run the tool
  named in that file, row by row, and `RC-env` is its last step). A path is
  a test file or tool. `manual:` is a step a person does. `none yet` means
  nothing proves it today.
- **Status columns:** `done`, `partial`, `missing` or `n/a`.
  - **macOS:** the native Mac app (`apps/macos`, Swift with its own Metal
    renderer on the daemon's render stream, docs/RENDERING.md). One window
    of tabs and splits, the sidebar and the session panel (drawn from the
    hub's state, checked by `apps/macos/scripts/sidetest.mjs`) so far: the
    rest is `missing`, or `n/a` where the feature is a phone's only.
  - **Electron:** the desktop app (`apps/desktop`) as it runs on the Mac,
    where the release check runs it. Linux builds the same code (AppImage,
    .deb); a row says when Linux differs. There is no Windows build
    (UPD-008).
  - **Android:** the Kotlin shell with the phone board inside it.
  - **Phone web:** the phone board (`apps/phone`) without a shell: what a
    browser shows through `apps/phone/tools/serve.mjs`, and the part the
    iOS shell will share. A feature that needs the shell (push, fingerprint,
    camera, private keyboard) is `n/a` here.
  - The Android and phone web columns were filled from the code. Where a
    row's acceptance names only a desktop check, their `done` means the
    shared code is there; it still needs a check of its own on the phone
    (section 3).

## 2. The checklist

### Terminal

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TERM-001 | Every pane runs in ravenryd, so closing, restarting or updating the window never ends it | daemon `pane.new`, `pane.list` | RC-4; macOS: `apps/macos/scripts/selftest.sh` (restore_tabs_order, restore_splits, restore_front_draws: the app quits, its panes keep running in ravenryd, and the app started again on the same daemon shows the same panes with their screens), `apps/macos/scripts/launchcheck.mjs` | done | done | n/a | n/a |
| TERM-002 | Showing a pane draws its screen and scrollback at once, then its live bytes; a tab off screen runs no renderer | daemon `pane.subscribe` (phone: hub `GET /api/term`) | `apps/desktop/tools/smoke.mjs`; macOS: `apps/macos/scripts/selftest.sh` (tab_hidden_no_stream_no_draws, tab_show_draws_rows_at_once, tab_show_catches_up): a tab not in front has no render stream | done | done | done | done |
| TERM-003 | New Shell (Cmd+T): a login shell, interactive, `TERM=xterm-256color`, `COLORTERM=truecolor`, `FORCE_HYPERLINK=1` | daemon `pane.new` | RC-1, RC-19; macOS: `apps/macos/scripts/selftest.sh` (tab_cmd_t_new, tab_plus_new) | done | done | n/a | n/a |
| TERM-004 | Reopened, every shell comes back with what it showed, a prompt within 2 s; a window.json with bad entries (a null pin, a number, not an object) never stops the launch | daemon `pane.list`; client `window.json` | RC-1, RC-4, `apps/desktop/tools/window-json-test.mjs`; macOS: `apps/macos/scripts/selftest.sh` (restore_tabs_order, restore_front_draws): the app is launched again on the same daemon | done | done | n/a | n/a |
| TERM-005 | Tabs hold the open session, plain shells and pinned sessions, never a copy of the sidebar; their order is kept | client | RC-10; macOS: `apps/macos/scripts/selftest.sh` (tab_drag_reorders, tab_order_saved): plain shells only, no session tabs (no sidebar yet) | partial | done | n/a | n/a |
| TERM-006 | Tab keys: Cmd+1 to 9, Ctrl+Tab and Ctrl+Shift+Tab, Cmd+Shift+] and [ | client | manual: each key brings the tab it names; macOS: `apps/macos/scripts/selftest.sh` (tab_cmd_1, tab_cmd_2, tab_cmd_shift_bracket_next, tab_cmd_shift_bracket_previous, tab_ctrl_tab_next, tab_ctrl_shift_tab_previous) | done | done | n/a | n/a |
| TERM-007 | A tab switch keeps each pane's scroll position | client | RC-14 | missing | done | n/a | n/a |
| TERM-008 | Split Right (Cmd+D) and Split Down (Cmd+Shift+D): a new shell with the keyboard, each pane its header, the tab shows "2" | client; daemon `pane.new` | RC-16; macOS: `apps/macos/scripts/selftest.sh` (split_cmd_d_right, split_cmd_shift_d_down, split_keyboard_to_new, split_headers_ring, split_tab_shows_2, split_grids_daemon, split_on_split_tab_new_tab) | done | done | n/a | n/a |
| TERM-009 | Cmd+Option+arrows or a click moves the keyboard between split panes | client | RC-16; macOS: `apps/macos/scripts/selftest.sh` (split_cmd_option_left, split_cmd_option_right, split_click_focuses) | done | done | n/a | n/a |
| TERM-010 | Dragging the divider resizes and is kept; a double click evens | client | RC-16; macOS: `apps/macos/scripts/selftest.sh` (split_divider_drag, split_double_click_evens, split_cmd_ctrl_equal_evens, split_saved); `apps/macos/scripts/bench.sh` (divider drag) | done | done | n/a | n/a |
| TERM-011 | Zoom Pane (Cmd+Shift+Enter): the focused pane alone, and back | client | RC-16; macOS: `apps/macos/scripts/selftest.sh` (split_zoom) | done | done | n/a | n/a |
| TERM-012 | A tab dragged to an edge splits with it ("Split right"); onto a split tab it says "Already split" | client | RC-16 | missing | done | n/a | n/a |
| TERM-013 | An agent's own pane opens as a split beside the tab it came from, without taking the keyboard; its header says its name and Agent once | client; daemon `pane.created` (creator) | RC-10, RC-16; macOS: `apps/macos/scripts/sidetest.mjs --screen panes` (panes_split_beside_owner, panes_split_no_keyboard, panes_split_named), `--screen tabmarks` (marks_lent_tab_after_owner: a tab after its owner when that tab is split already, "An agent's" under its name), `--screen panes` (panes_agent_chip: its header's name and Agent chip) | done | done | n/a | n/a |
| TERM-014 | Splits come back after a relaunch, with their panes | client `window.json` | RC-16; macOS: `apps/macos/scripts/selftest.sh` (restore_splits) | done | done | n/a | n/a |
| TERM-015 | Cmd+W closes the pane with the keyboard and ends its process; an idle shell closes at once | daemon `pane.close` | RC-16, RC-17 (F3); macOS: `apps/macos/scripts/selftest.sh` (split_cmd_w_closes_pane, tab_cmd_w_closes, tab_middle_click_closes, settings_close_idle_at_once) | done | done | n/a | n/a |
| TERM-016 | Closing a busy shell asks "Close this tab?" with what runs, Cancel the default, and Don't ask again | daemon `pane.process` (`busy`); client setting | RC-17 (F3), `daemon/internal/server/process_test.go` (TestProcessBusy); macOS: `apps/macos/scripts/selftest.sh` (settings_close_busy_asks, settings_close_dont_ask_again): a sheet on the window; busy is the daemon's `busy`, both apps comparing the pids themselves only for an older daemon's answer | done | done | n/a | n/a |
| TERM-017 | Resize: rows at once, columns once the size holds; hidden terminals resize when shown or idle; no pane blank or flashed while dragging | daemon `pane.resize`; client | RC-26, `apps/desktop/tools/frame-time.mjs`, `apps/desktop/tools/resize-load.mjs`; macOS: `apps/macos/scripts/bench.sh` (drag, fast drag, divider drag over both panes of a split, 0 blank, 0 debris, ends on the daemon's screen): a hidden tab resizes when shown; columns follow at once, not once the size holds | partial | done | n/a | n/a |
| TERM-018 | Switching views (a tab, a session, a page, the panel) never shows a half-drawn, blank or flashed frame | client | RC-26; macOS: `apps/macos/scripts/bench.sh` (tab switches: blank panes 0; the rows a pane had are drawn at the switch, a pane never drawn waits under the tab in front for its first frame) | done | done | n/a | n/a |
| TERM-019 | Synchronized output: an update shows whole; a big one is parsed in slices and never freezes the window | client; daemon stream frames | RC-26, `apps/desktop/tools/resize-load.mjs` | missing | done | done | done |
| TERM-020 | Colours: 16, 256 and truecolor, `ls -G` and the prompt, fresh, after a tab switch and after a relaunch | daemon screen; client renderer | RC-19 | missing | done | done | done |
| TERM-021 | Links: OSC 8 and plain URLs (http, https, file only) open on Cmd+click (Ctrl+click off the Mac); a plain click opens nothing | client; daemon `render.link` | RC-14, RC-20; macOS: `apps/macos/scripts/selftest.sh` (link_*), `daemon/internal/vt/select_test.go` (TestLinkAt), `daemon/internal/server/basics_test.go` (TestRenderLinkAndPaths) | done | done | missing | missing |
| TERM-022 | Hovering a link says "Cmd+click to open"; holding Cmd underlines it with the pointing hand; a setting opens links on a plain click | client setting | RC-20; macOS: `apps/macos/scripts/selftest.sh` (link_pointing_hand, link_underline_drawn, settings_link_one_click); no hover hint yet | partial | done | n/a | n/a |
| TERM-023 | Paste goes to the daemon as one paste: bracketed when the program asked, unsafe control characters made harmless | daemon `pane.send` (paste); daemon `render.input` paste | `apps/desktop/tools/smoke.mjs`; macOS: `apps/macos/scripts/selftest.sh` (paste_cmd_v) | done | done | n/a | n/a |
| TERM-024 | A file dropped on the terminal pastes its path, quoted; several separated by spaces | client; daemon `render.input` paths | RC-14; macOS: `apps/macos/scripts/selftest.sh` (drop_files_quoted_paths), `daemon/internal/server/basics_test.go` (TestRenderLinkAndPaths) | done | done | n/a | n/a |
| TERM-025 | Scrollback of 100 to 100,000 lines (10,000 by default), the same length kept by the daemon | client setting; daemon `pane.new`, `pane.update` | RC-17 (settings); macOS: `apps/macos/scripts/selftest.sh` (settings_scrollback_to_daemon) | done | done | n/a | n/a |
| TERM-026 | Cmd+Home and Cmd+End go to the top and the bottom of the scrollback | client | RC-14; macOS: `apps/macos/scripts/selftest.sh` (cmd_home_top, cmd_end_bottom) | done | done | n/a | n/a |
| TERM-027 | Cmd+K clears the scrollback, in the daemon too, and types nothing | daemon `pane.clear` | RC-11; macOS: `apps/macos/scripts/selftest.sh` (clear_cmd_k) | done | done | n/a | n/a |
| TERM-028 | Selection: Cmd+A selects all, Cmd+C copies, neither types anything; a right click selects nothing | client; daemon `render.copy` | RC-11; macOS: `apps/macos/scripts/selftest.sh` (select_all_cmd_a, copy_cmd_c_private_pasteboard) | done | done | missing | missing |
| TERM-029 | Copy on select (a setting) | client setting | RC-17 (settings); macOS: `apps/macos/scripts/selftest.sh` (settings_copy_on_select) | done | done | n/a | n/a |
| TERM-030 | Find (Cmd+F): every match counted, Enter for the next, Cmd+Shift+G the one before, Aa for match case, Esc gives the keyboard back | client; daemon `render.find` | RC-17 (F1); macOS: `apps/macos/scripts/selftest.sh` (find_*), `daemon/internal/vt/select_test.go` (TestFind), `daemon/internal/server/basics_test.go` (TestRenderFind); no Aa: libghostty-vt matches ASCII letters in any case | partial | done | n/a | n/a |
| TERM-031 | Right-click menu: Open Link, Copy Link, Copy, Paste, Select All, Copy Path, Find, Clear, Split Right, Split Down | client | RC-17 (F2); macOS: `apps/macos/scripts/selftest.sh` (context_menu_items): Copy, Paste, Select All, Clear, Find; no link or split items yet | partial | done | n/a | n/a |
| TERM-032 | Every row of the keys table arrives as its exact bytes: Cmd+arrows, Option+arrows by word, Cmd+Backspace, Shift+Enter as a newline | client | RC-11; macOS: `apps/macos/scripts/selftest.sh` (key_*), `daemon/internal/server/keybinds_test.go` (TestRenderKeybindsZsh), `daemon/internal/vt/keybinds_test.go` (every row of the daemon's macos table, docs/RENDERING.md "Key bindings") | done | done | n/a | n/a |
| TERM-033 | Option as Meta: off, left, right or both | client setting | RC-17 (settings); macOS: `apps/macos/scripts/selftest.sh` (settings_option_as_meta, key_*) | done | done | n/a | n/a |
| TERM-034 | The daemon answers terminal queries; the client never answers them too | daemon | `apps/desktop/test/queries.test.ts` | missing | done | done | done |
| TERM-035 | Bell: a flash on screen, a small bell on a hidden tab until opened, or a sound, or off; the Dock bounces while the app is not in front | client setting | RC-17 (F4); macOS: `apps/macos/scripts/selftest.sh` (bell_flash_shows, bell_flash_ends, settings_bell_sound, settings_bell_off): the flash, the sound and the Dock, for a hidden pane too; `apps/macos/scripts/sidetest.mjs --screen tabmarks` (marks_bell, marks_activity_dot, marks_cleared_when_opened): the small bell and the new output dot on a tab not on screen until it is opened (`events.subscribe` with `activity`) | done | done | n/a | n/a |
| TERM-036 | Font family, with Menlo, SF Mono, DejaVu Sans Mono and Liberation Mono as fallbacks | client setting | `apps/desktop/test/settings.test.ts`; macOS: `apps/macos/scripts/selftest.sh` (font_default_menlo_13, settings_font_live, settings_font_fallback) | done | done | n/a | n/a |
| TERM-037 | Text size: Cmd+=, Cmd+- and Cmd+0 change the terminals only, write the settings, and are kept across a relaunch | client setting | RC-14, RC-17 (settings); macOS: `apps/macos/scripts/selftest.sh` (cmd_plus_bigger, cmd_plus_writes_settings, cmd_minus_smaller, cmd_0_default): written to the shared settings file, 13 by default | done | done | n/a | n/a |
| TERM-038 | Cursor style (block, bar, underline) and blink; programs may still change it | client setting | RC-17 (settings); macOS: `apps/macos/scripts/selftest.sh` (cursor_*, settings_cursor_bar, settings_cursor_blinks): the setting while the program leaves a block (the daemon's frames do not tell a program's steady block from the default) | done | done | n/a | n/a |
| TERM-039 | Themes: eight shipped; one for light and one for dark following the system, or one always | client setting; `shared/themes/` | `apps/desktop/test/settings.test.ts`, `apps/desktop/tools/settings-shots.mjs`; macOS: `apps/macos/scripts/sidetest.mjs --screen terminal` (term_follows_system_*, term_paper_*), `apps/macos/scripts/selftest.sh` (settings_theme_paper, settings_theme_chrome) | done | done | partial | partial |
| TERM-040 | Import a theme from an .itermcolors or a Ghostty theme file | hub `POST /api/settings/theme-import` (`hub/server/themeimport.mjs`, moved from the desktop's `apps/desktop/src/main/themeimport.ts`, which re-exports it); each client saves it in its data folder's `themes/` | `apps/desktop/test/themeimport.test.ts`, `hub/tools/setup-skills-test.mjs`; macOS: `apps/macos/scripts/sidetest.mjs --screen settings` (set_import_*) | done | done | n/a | n/a |
| TERM-041 | The agents' symbols (record, star, warning, braille spinner) drawn from Ravenry's glyph font, never a colour emoji font | client font | none yet | missing | partial | done | done |
| TERM-042 | New Window (Cmd+N) with a shell of its own; Close Window; the first window's tabs stay as they were | client | RC-17 (G) | missing | done | n/a | n/a |
| TERM-043 | The window keeps its size and place, on a screen that is still there | client `window.json` | RC-14; macOS: `apps/macos/scripts/sidetest.mjs --screen window` (window_*: the bounds written as the Electron app writes them in the layout file beside the tabs, read back on a screen still there, refused off every screen, mostly off, too small or not numbers; then the default size, centred) | done | done | n/a | n/a |
| TERM-044 | What an agent or the hub typed is marked in the right gutter with its name and time; the person's own typing never is | daemon `pane.inputs`; client | `apps/desktop/tools/marks-test.mjs` | missing | done | missing | missing |
| TERM-045 | Filmstrip: the pane's last 20 s, bad frames marked, step and play, Send to the agent, Save as GIF | daemon `pane.frames`; hub `POST /api/sessions/:id/filmstrip` | `apps/desktop/test/phase2.test.ts`, `apps/desktop/tools/phase2-shots.mjs` | missing | done | missing | missing |
| TERM-046 | A pane asked to show (`ravenryd focus`) comes to the front | daemon event `pane.focus` | `apps/desktop/tools/smoke.mjs`; macOS: `apps/macos/scripts/sidetest.mjs --screen tabmarks` (focus_brings_pane_to_front: `ravenryd focus` from a program in another pane brings that pane's tab to the front, the app forward when on screen) | done | done | n/a | n/a |
| TERM-047 | The phone's key bar: Esc, Tab, the arrows, Enter and Ctrl-C into the pane | client; hub `GET /api/term` | `apps/phone/test/logic.test.ts` | n/a | n/a | done | done |
| TERM-048 | Wheel and trackpad: precise deltas added up in rows with momentum; to the program when it reports the mouse; arrow keys on the alternate screen (mode 1007), as Ghostty does; typing brings a scrolled view back | daemon `render.input` wheel | `daemon/internal/server/basics_test.go` (TestRenderWheel, TestRenderWheelProgram); macOS: `apps/macos/scripts/selftest.sh` (wheel_precise_rows, wheel_discrete_3_rows_a_notch, key_scrolls_back) | done | partial | partial | partial |
| TERM-049 | An overlay scrollbar shows while the view scrolls and fades out after, macOS style | client | macOS: `apps/macos/scripts/selftest.sh` (scrollbar_shows, scrollbar_drawn, scrollbar_hides) | done | partial | n/a | n/a |
| TERM-050 | Selection: a drag, two clicks a word, three a line, Shift-click extends, Option a block, across the scrollback (a drag past the edge scrolls); a copy joins soft-wrapped rows | daemon `render.input` select, `render.copy` (libghostty-vt's selection gesture) | `daemon/internal/vt/select_test.go` (TestSelectGesture), `daemon/internal/server/basics_test.go` (TestRenderSelection); macOS: `apps/macos/scripts/selftest.sh` (select_*, drag_past_top_autoscrolls) | done | partial | missing | missing |
| TERM-051 | Box drawing, block elements, braille and the Powerline triangles drawn by the renderer to fill the cell, so lines join | client renderer | macOS: `apps/macos/scripts/selftest.sh` (box_lines_join_across, box_lines_join_down, block_fills_cell) | done | partial | partial | partial |
| TERM-052 | The cell comes from the font's own metrics (advance, ascent, descent and line gap rounded to pixels, Ghostty's computation), Menlo 13 by default as the settings say; no ligatures | client renderer | macOS: `apps/macos/scripts/selftest.sh` (cell_16x30_px_at_2x, grid_fills_view); `apps/macos/scripts/bench.sh` prints the grid of a 900 x 560 pt window | done | partial | n/a | n/a |
| TERM-053 | An unfocused terminal shows a hollow, steady cursor; focused, it blinks when the program asks | client renderer; daemon frame cursor | macOS: `apps/macos/scripts/selftest.sh` (cursor_unfocused_hollow_no_blink, cursor_focused_blinks_again) | done | partial | n/a | n/a |
| TERM-054 | The window title is the one the program sets (OSC 0, 2) | daemon frame title | macOS: `apps/macos/scripts/selftest.sh` (title_from_program) | done | partial | n/a | n/a |

### Sessions and sidebar

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SESS-001 | The sections Needs you, Working, Waiting on others and Idle, each with its count, and the mix bar of all four | hub `state.sidebar` (`GET /api/state`, `/api/events`, `GET /api/sidebar`; `hub/server/sidebar.mjs` has the shape): sections, titles and counts; the client draws them | RC-18, `hub/tools/sidebar-test.mjs`, `apps/desktop/test/model.test.ts` (macOS: `apps/macos/scripts/sidetest.mjs`) | done | done | done | done |
| SESS-002 | Each session its own row in the section of its own state, the most urgent first; its project's header in each section it has a session in | hub `state.sidebar` (`hub/server/sidebar.mjs` build()), each session's `group` | `hub/tools/sidebar-test.mjs`, `apps/desktop/tools/listed-check.mjs`, `apps/desktop/test/model.test.ts` (macOS: `apps/macos/scripts/sidetest.mjs`) | done | done | done | done |
| SESS-003 | A row says the session's name, its assistant, its context %, its machine, and what it waits on or its last line | hub `state.sidebar` rows, with the open checkpoint's or the worktree review's mark and the word before it (`label`; `hub/server/sidebar.mjs` marksOf(), `hub/server/cpwords.mjs` markOf()); the client says its time against its clock | `apps/desktop/test/model.test.ts`, `apps/desktop/test/checkpoints.test.ts` (macOS: `apps/macos/scripts/sidetest.mjs`) | done | done | done | done |
| SESS-004 | An idle project is one line; a project with no session (waiting by its brief, at a plan gate) still has a row | hub `state.sidebar` | RC-18, `hub/tools/sidebar-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs`) | done | done | done | done |
| SESS-005 | One click on any row opens what it stands for at once; on the desktop its tab, row and panel come to the front, and app.log says so | client | RC-18, `apps/desktop/tools/selection-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | done | done |
| SESS-006 | The highlighted row, the panel and the tab in front always name the same thing | client | RC-1, RC-4, RC-10 (macOS: `apps/macos/scripts/sidetest.mjs`) | done | done | n/a | n/a |
| SESS-007 | States come from the assistants' hooks first and the screen second | hub (`hub/docs/STATE-RULES.md`) | `hub/tools/events-e2e.mjs`, `hub/tools/sessions-test.mjs` | missing | done | done | done |
| SESS-008 | Claude Code and Codex sessions are both followed, each with its tag | hub (`hub/docs/ASSISTANTS.md`) | `hub/tools/assistant-test.mjs`, `hub/tools/codex-stage2-test.mjs` | missing | done | done | done |
| SESS-009 | New Session (Cmd+Shift+N, or the + at the sidebar's top) starts the assistant in a Ravenry pane in the chosen folder | hub `POST /api/sessions/start` | RC-2, `hub/tools/new-session-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen start`: up to three of the hub's folders, Choose another folder, a dropped folder, the assistants found and signed in, Cancel, the reason when the board says no, a shell in the folder when no assistant is here) | done | done | missing | missing |
| SESS-010 | A new session in a folder another session works in gets its own copy on a new branch, one line saying why, or works in the folder if asked | hub `POST /api/sessions/start` (worktree); which session works there: hub `GET /api/setup/start` (`busy` on each folder, `hub/server/sidebar.mjs` busyIn()) | `hub/tools/worktree-test.mjs`, `hub/tools/sidebar-test.mjs` (busyIn); macOS: `apps/macos/scripts/sidetest.mjs --screen start` (start_own_copy_*, start_in_folder*) | done | done | missing | missing |
| SESS-011 | A session tab is named by its topic and its folder; one the board does not list yet is "Session" with its folder | client | RC-21 (B) | missing | done | n/a | n/a |
| SESS-012 | Pin a session to the tabs from its row or its panel | client | RC-24 (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | n/a | n/a |
| SESS-013 | A session in cmux, iTerm2 or Rex shows in the middle, read only: live from its screen when the hub can read it, else its transcript with one line saying why | hub `GET /api/live`, transcript | RC-3, RC-9, `hub/tools/live-screen-test.mjs`, `apps/desktop/tools/outside-shots.mjs` (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | partial | partial |
| SESS-014 | Open in cmux, iTerm2 or Rex brings that tab forward; cmux refusing its socket, the app comes forward | hub `POST /api/open` | `hub/tools/outside-terminal-test.mjs`, `hub/tools/iterm-test.mjs`, `hub/tools/rex-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | n/a | n/a |
| SESS-015 | Move here ends the session in the other terminal (after its turn when mid-turn) and resumes it in a Ravenry pane with a clean environment; one process is left | hub `POST /api/sessions/move` | RC-3, RC-9 (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | missing | missing |
| SESS-016 | Open in both: "Also open in cmux" with Move here and Keep it in cmux; went on elsewhere: Move here resumes the latest in a new pane | hub state (alsoOpen, movedOn); `POST /api/sessions/move` | RC-7, RC-9 (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | missing | missing |
| SESS-017 | An idle project's page shows its last conversation by its last turn; Continue this conversation runs `claude --resume <id>` in a pane in its folder | hub `GET /api/project/last`, `POST /api/sessions/start` (resume) | RC-23, `hub/tools/last-conversation-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | missing | missing |
| SESS-018 | A last conversation still open in cmux says so, with Move here and never a second copy; none found: New session here and Open brief | hub `GET /api/project/last`, `POST /api/sessions/move` | RC-23 (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | missing | missing |
| SESS-019 | A toast when something new needs you, never about the session in front, never two alike; Show opens it | client | RC-9 (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | n/a | n/a |
| SESS-020 | Close an ended session's row | hub `POST /api/sessions/close` | `hub/tools/sessions-test.mjs` | missing | done | done | done |
| SESS-021 | Recently closed sessions, kept 14 days, and Reopen | hub `POST /api/sessions/reopen` | `hub/tools/sessions-test.mjs` | missing | missing | missing | missing |
| SESS-022 | A session in no project: Add to a project, or New project from this folder | hub `POST /api/project/add-workspace`, `/api/project/new` | `hub/tools/new-project-folder-test.mjs` | missing | missing | missing | missing |
| SESS-023 | New project: its folder, its brief and a first session | hub `POST /api/project/new` | `hub/tools/new-project-folder-test.mjs` | missing | missing | missing | missing |
| SESS-024 | Clean context hand-off: past the line the session writes its hand-off at a clean point, and a fresh session goes on from it | hub, hooks (`hub/docs/HANDOFF.md`) | `hub/tools/handoff-e2e.mjs`, `hub/tools/handoff-hook-test.mjs` | missing | done | done | done |
| SESS-025 | Hand off now, from the panel or the phone | hub `POST /api/handoff`, `/api/handoff/start` | `hub/tools/handoff-queued-e2e.mjs` (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | done | done |
| SESS-026 | Reply to a session in your own words from outside its terminal | hub `POST /api/send` | `hub/tools/send-test.mjs` | missing | partial | done | done |
| SESS-027 | The memory line: how much memory the assistants use, in the sidebar's foot | hub state; client memoryLine() | none yet (macOS: `apps/macos/scripts/sidetest.mjs`) | done | done | missing | missing |
| SESS-028 | The phone's connection chip: this computer, then the machines it reaches, and whether each answers | hub `GET /api/machines` | `apps/phone/test/logic.test.ts` | n/a | n/a | done | done |

### Session panel

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PANEL-001 | The panel on the right shows what is selected (a session, a shell, a project, a new session); Cmd+Option+B hides it; on a narrow window it lies over the terminal | client | RC-18, RC-24 (macOS: `apps/macos/scripts/sidetest.mjs`) | done | done | n/a | n/a |
| PANEL-002 | The state in words and since when | hub state | `apps/desktop/tools/outside-shots.mjs` (macOS: `apps/macos/scripts/sidetest.mjs`) | done | done | done | done |
| PANEL-003 | What the first-launch step set up: "Alerts turned on", "Has the Ravenry skill", or off with a way to Settings | client (hooks, skills) | RC-21 (B) (macOS: `apps/macos/scripts/sidetest.mjs`) | done | done | n/a | n/a |
| PANEL-004 | A question with its quick answers as buttons, sent as the person | hub state (words.quick); `POST /api/send` | `hub/tools/send-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | done | done |
| PANEL-005 | Context: tokens of the window, the hand-off line, Hand off now | hub state (ctx, settings) | none yet (macOS: `apps/macos/scripts/sidetest.mjs`) | done | done | partial | partial |
| PANEL-006 | The last hand-off's text and "Read by this session" | hub state (timeline) | `hub/tools/handoff-e2e.mjs` (macOS: `apps/macos/scripts/sidetest.mjs`) | done | done | missing | missing |
| PANEL-007 | The latest picture, which opens large, and Gallery | hub state (brief.pictures) | RC-25 (macOS: `apps/macos/scripts/sidetest.mjs`; `apps/macos/scripts/sidetest.mjs --screen gallery`: gallery_from_panel_picture) | done | done | missing | missing |
| PANEL-008 | Plan: Running, At a gate or None running; Open the plan, or New plan | hub state (plan, planGate) | RC-25 (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | missing | missing |
| PANEL-009 | A shell's panel: who opened it, its folder, what it runs, and what the agent in it reported | daemon `pane.list`, `agent.report` | `apps/desktop/tools/smoke.mjs`; macOS: `apps/macos/scripts/sidetest.mjs --screen panes` (panes_panel_*): who opened it and when, whose pane it is; not yet what the agent in it reported | partial | done | n/a | n/a |
| PANEL-010 | Who can type here: you always; an agent asks each time unless let for its session; take it back | daemon `pane.grants`, `pane.revoke` | `apps/desktop/test/phase2.test.ts`, `apps/desktop/tools/phase2-shots.mjs`; macOS: `apps/macos/scripts/sidetest.mjs --screen panes` (panes_who_can_type: you always, the agent whose own pane it is; an agent let for its session has Asks each time to take it back, pane.revoke) | done | done | missing | missing |
| PANEL-011 | Typed here: the pane's input log, a typed command as one entry | daemon `pane.inputs` | RC-17 (Typed here) (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | missing | missing |
| PANEL-012 | A lent pane: a strip with who has it and who waits, Hand it to and Take it back, a badge on its tab; Panes it uses in the session's panel | daemon `pane.lease` | `apps/desktop/tools/phase2-shots.mjs`; macOS: `apps/macos/scripts/sidetest.mjs --screen panes` (panes_split_*, panes_strip_*, panes_take_back*), `--screen tabmarks` (marks_lent_badge): the agent's own pane as a split beside its owner's tab, the strip over a pane an agent holds with Hand it to and Take it back, the holder's badge on its tab; panes_uses_*: Panes it uses in the session's panel, its own and the person's lent to it, who waits and Hand it over | done | done | missing | missing |
| PANEL-013 | Files changed: each file with its added and removed lines, one another session changed too in orange; See all opens the project's grid | hub `GET /api/projects/:id/files` | `hub/tools/worktree-test.mjs`; macOS: `apps/macos/scripts/sidetest.mjs --screen review` (review_files_*, review_grid_*: each file with its counts, one another session changed too with who, when and what it means, read only, See all opens the grid with the files two changed first; the clashes and the grid are the hub's, `hub/server/reviewview.mjs` withClashes, `hub/tools/reviewview-test.mjs`) | done | done | missing | missing |
| PANEL-014 | Review a worktree session: its files and diff, comments on lines, Send N comments, Merge into main, Undo the merge, Delete the branch | hub `/api/sessions/:id/diff`, `review/*`, `merge`, `unmerge`, `delete-branch`, `discard` | `hub/tools/worktree-test.mjs`, `apps/desktop/test/phase2.test.ts`; macOS: `apps/macos/scripts/sidetest.mjs --screen review` (review_*: on a real worktree of the demo hub: the card and Its copy, the review beside the panel with its files and diff from the hub's lines, a comment on a line, Send 1 comment, Take back, Merge into main, Undo the merge, Delete the branch) | done | done | missing | missing |
| PANEL-015 | A checkpoint shows as a mark on its row, a dot on its tab, and a card at the top of the panel (phone: a bar over the session, its own screen) | daemon `checkpoint.*` events; hub `GET /api/checkpoints`; what it says: hub `words` on every checkpoint (`hub/server/cpwords.mjs`; state `checkpoints`, `GET /api/checkpoints`, the answer's response, `POST /api/checkpoints/words` for a daemon's copy), tokens filled by the rule in `hub/docs/STATE-RULES.md`; times said against the client's clock. Gap: a daemon's copy is drawn empty until the hub words it, so with the hub down the desktop shows no card words | `hub/tools/cpwords-test.mjs`, `hub/tools/hub-api-test.mjs`, `apps/desktop/test/checkpoints.test.ts`, `apps/desktop/tools/checkpoint-shots.mjs`; macOS: `apps/macos/scripts/sidetest.mjs` (the row's mark), `--screen cards` (the card), `--screen tabmarks` (marks_waiting_dot, marks_agent_waits_dot, marks_agent_works_dot: the tab's dot from a question open in its pane or what its agent reported) | done | done | done | done |
| PANEL-016 | Ask: the question, one answer per line with number keys, or an answer in your own words | daemon `checkpoint.answer`, else hub `POST /api/checkpoints/answer`; its words (heading, head, body, the phone's checks) hub `words` | `hub/tools/cpwords-test.mjs`, `apps/desktop/test/checkpoints.test.ts`, `apps/desktop/tools/checkpoint-shots.mjs`; macOS: `apps/macos/scripts/sidetest.mjs --screen cards` (ask_*: the number keys, a click, your own words; on the fixture of `apps/macos/scripts/cards-fixture.mjs`) | done | done | done | done |
| PANEL-017 | Approve: the command with its folder, machine and pane, the warnings and whose they are, Edit, Refuse and Run | daemon `checkpoint.answer`, else hub `POST /api/checkpoints/answer`; the warnings, the machine and Run's label hub `words`; for a command being edited the client applies the hub's guess rules (`words.guess.rules`, regular expressions as data) at each keystroke | `hub/tools/cpwords-test.mjs`, `apps/desktop/test/checkpoints.test.ts`, `apps/desktop/tools/checkpoint-shots.mjs`; macOS: `apps/macos/scripts/sidetest.mjs --screen cards` (approve_*: Run, Edit with the change tinted and the guess at each keystroke, Cmd+Enter, Esc, Refuse with and without a reason) | done | done | done | done |
| PANEL-018 | Run from the phone always asks for a fingerprint first; it cannot be turned off | Android `RunActivity` | `apps/phone/tools/pick-shots.mjs` | n/a | n/a | done | n/a |
| PANEL-019 | Secret: typed into a field inside the card and sent to the terminal, never kept or shown | daemon `checkpoint.answer`; its words hub `words` (`secret.noun`, `after`); the field's own checks (`secretProblem`, `characters`) stay in the client as input validation, so the value never goes to the hub | `apps/desktop/test/checkpoints.test.ts`, `hub/tools/cpwords-test.mjs`; macOS: `apps/macos/scripts/sidetest.mjs --screen cards` (secret_*: a secure field, too short not sent, the count, Show it, cleared on blur, sent and emptied, Not now; the self-test keeps a secret only as its length) | done | done | done | n/a |
| PANEL-020 | The phone's private keyboard for a secret: no suggestions, no learning, the page never sees it | Android `SecretField` | none yet | n/a | n/a | done | n/a |
| PANEL-021 | Drive: an agent asks to type into, close, restart or change a pane; allow once or for the session, or refuse | daemon checkpoint (drive), `pane.grants`; its words, the pane's name and the phone's screen hub `words.drive` | `hub/tools/cpwords-test.mjs`, `apps/desktop/test/phase2.test.ts`, `apps/phone/tools/pick-shots.mjs` (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | done | done |
| PANEL-022 | Pick: 2 to 4 pictures side by side (phone: one at a time, swiped), Pick, Circle a part with a note, None of these | hub `GET /api/checkpoints/:id/variants/:n`, `POST /api/checkpoints/answer`; each variant's letter, name and the agent's words hub `words.variants` | `hub/tools/picks-test.mjs`, `hub/tools/cpwords-test.mjs`, `apps/phone/tools/pick-shots.mjs`; macOS: `apps/macos/scripts/sidetest.mjs --screen cards` (pick_*: the pictures small, 1 to 3, side by side in the middle, Pick, a ring dragged with its note, Send, None of these, Esc) | done | done | done | done |
| PANEL-023 | A photo or a voice note sent with an answer | Android camera and voice; hub `POST /api/inbox/:project` | none yet | n/a | n/a | done | n/a |
| PANEL-024 | A closed card says how it ended (answered, declined, cancelled, expired) and a late copy never reopens it | hub `words.after` (its `{where}`, `{time}` and `{machine}` filled by the client); the store that never reopens one and asks for words when its copy moved on, client | `hub/tools/cpwords-test.mjs`, `apps/desktop/test/checkpoints.test.ts`, `apps/desktop/test/phase2.test.ts` (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | done | done |

### Brief

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BRIEF-001 | The panel's Brief card: the goal on one line, Next as at most 3 one-line items from the newest dated entry, "Open brief, N older entries" | hub state (each project's `brief.nextParts`: `items`, `older`; `hub/server/briefnext.mjs`) | RC-15, `hub/tools/briefnext-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs`) | done | done | missing | missing |
| BRIEF-002 | The Brief page beside the session: "Updated <time> by <assistant>", Edit, Goal, Rules, Next in dated entries newest first (the newest open), the Plan as a checklist, Hand-off | hub `GET /api/brief` (the dated entries and their sentences in `nextParts.entries`, `hub/server/briefnext.mjs`); the Markdown drawn by the client | RC-15, `hub/tools/briefnext-test.mjs`, `hub/tools/hub-api-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen brief`) | done | done | missing | missing |
| BRIEF-003 | A link in the brief opens in the browser; Edit opens the file in the Markdown editor; closing goes back to the session | client | RC-15 (macOS: `apps/macos/scripts/sidetest.mjs --screen brief` (brief_link_opens, brief_edit_opens_file, brief_closes)) | done | done | missing | missing |
| BRIEF-004 | The brief is drawn as text, never as HTML, and asked for when shown, not at every state | client; hub `GET /api/brief` | RC-15, `apps/desktop/test/brief.test.ts` (macOS: `apps/macos/scripts/sidetest.mjs --screen brief`) | done | done | missing | missing |
| BRIEF-005 | Add a note to a project's brief | hub `POST /api/note` | none yet | missing | missing | missing | missing |
| BRIEF-006 | Write a brief for a project that has none | hub `POST /api/project/brief` | none yet | missing | missing | missing | missing |

### Plans

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PLAN-001 | A plan's page: its steps with their proofs, how many are done, the current one, Pause and Resume | hub state (plan; the plans a page shows in each project's `planPages`, `hub/server/planfmt.mjs`); `POST /api/plan/pause`, `resume` | RC-25, `hub/tools/plans-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen plan`) | done | done | partial | partial |
| PLAN-002 | Answer a plan's gate: its choices as buttons, or your own words | hub `POST /api/plan/answer` | `hub/tools/plans-test.mjs`, `hub/tools/person-routes-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen plan`) | done | done | partial | missing |
| PLAN-003 | Confirm or reopen a gate the file alone passed | hub `POST /api/plan/confirm`, `reopen` | `hub/tools/plans-test.mjs` | missing | missing | missing | missing |
| PLAN-004 | New plan from the brief: say the goal, the hub drafts the steps, answer its questions, Start or Discard; Stop while it drafts | hub `GET /api/plan/draft`; `POST /api/plan/draft`, `edit`, `start`, `discard`, `halt` | RC-25, `hub/tools/plans-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen plan`) | done | done | missing | missing |
| PLAN-005 | Write your own plan, or revise a draft with a comment | hub `POST /api/plan/own`, `revise` | `hub/tools/plans-test.mjs` | missing | missing | missing | missing |
| PLAN-006 | Change a running plan | hub `POST /api/plan/change` | `hub/tools/plans-test.mjs` | missing | missing | missing | missing |

### Ideas

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| IDEA-001 | The Ideas page: a board from spark to mockup, greenlit and parked; drag a card to another lane (phone: a long press, Move to) (macOS: the mouse drags it, the lane under it lit) | hub page `ideas.page.yaml`; `POST /api/pages/item/set` | `apps/desktop/tools/pages-test.mjs`, `hub/tools/pages-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen pages`) | done | done | done | done |
| IDEA-002 | Add an idea, or brainstorm ideas from a seed | hub `POST /api/ideas/add`, `/api/ideas/brainstorm` | `apps/macos/scripts/sidetest.mjs --screen pages` | done | done | done | done |
| IDEA-003 | An idea's thread: talk with the agent, ask for a mockup round, Greenlight, Park | hub `GET /api/ideas`; `POST /api/ideas/:id/say`, `mockups`, `update` | RC-25, `hub/tools/idea-mockups-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen idea`) | done | done | missing | missing |
| IDEA-004 | Pick a mockup from a round, or stop the round | hub `POST /api/ideas/:id/mockups/pick`, `mockups/stop` | `hub/tools/idea-mockups-test.mjs` | missing | missing | missing | missing |
| IDEA-005 | Add references and pictures to an idea | hub `POST /api/ideas/:id/ref`, `image` | none yet | missing | missing | missing | missing |
| IDEA-006 | Make a project from an idea | hub `POST /api/project/new` (ideaId) | none yet | missing | missing | missing | missing |
| IDEA-007 | Archive an idea; Undo brings it back | hub `POST /api/pages/item/archive`, `restore` | `apps/desktop/tools/pages-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen pages`) | done | done | done | done |

### Decisions

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DEC-001 | Decisions in the sidebar with the count of active ones, a dot while one can still be undone | hub `GET /api/decisions` (macOS: `?page=1`'s `active` and `undoable`) | RC-24 (macOS: `apps/macos/scripts/sidetest.mjs --screen decisions`) | done | done | missing | missing |
| DEC-002 | The Decisions page: newest first, each in the person's words with when, where and who saved it, a replaced one crossed out, how often agents read it; the project menu, the search, Holds now, Replaced and All | hub `GET /api/decisions?all=1` (macOS: `GET /api/decisions?page=1`, `hub/server/decisions.mjs` page()) | RC-24, `hub/tools/decisions-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen decisions`) | done | done | missing | missing |
| DEC-003 | An agent saves one: a toast (phone: an alert) with Undo for a minute, and Show | hub event `decision`; `POST /api/decisions/undo` | `hub/tools/decisions-test.mjs`, `apps/android/app/src/test/java/dev/ravenry/app/AlertsTest.kt` (macOS: `apps/macos/scripts/sidetest.mjs --screen decisions`) | done | done | done | missing |
| DEC-004 | Add, edit or remove a decision yourself | hub `POST /api/decisions/add`, `edit`, `remove` | `hub/tools/decisions-test.mjs` | missing | missing | missing | missing |
| DEC-005 | The app's own reads of the ledger never count as an agent's | hub (`agent=1` only from agents; `page=1` never counts) | `hub/tools/decisions-test.mjs` | done | done | n/a | n/a |
| DEC-006 | A question an agent asks says the decisions it read just before (Checked your decisions first), each quoted short with when it was said | hub `checked` on an ask checkpoint (`hub/server/decisions.mjs` checkedBefore(); the desktop: app.ts checkedFor()) | `hub/tools/decisions-test.mjs` (checkedBefore); macOS: `apps/macos/scripts/sidetest.mjs --screen cards` (ask_checked_decisions) | done | done | missing | missing |

### Pages from files

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PAGE-001 | The sidebar's pages from page files: the shipped five (Ideas, Objectives, Plans, Rules, Ship), then added ones, then a project's with its name | hub `GET /api/pages`, state (pages) | `apps/desktop/tools/pages-test.mjs`, `hub/tools/pages-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen pages`) | done | done | done | done |
| PAGE-002 | A page opens in the middle and right columns; its lists, boards and groups use page-format's own filters, sorts and counts, run by the hub: a client draws the rows, groups, tab counts, stats and item buttons it is sent, and sends the tab picked | hub `GET /api/pages/page?key=&tab=` (`drawn`, `hub/server/pagedraw.mjs`, `hub/docs/PAGES.md`) | `hub/tools/pagedraw-test.mjs`, `hub/tools/pages-test.mjs`, `apps/desktop/tools/pages-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen pages`) | done | done | done | done |
| PAGE-003 | Edits go to the hub field by field, against the hash the screen was drawn from; "changed since your copy" when it moved | hub `POST /api/pages/item/set`, `toggle`, `create` | `hub/tools/pages-test.mjs`, `apps/desktop/test/pages.test.ts` (macOS: `apps/macos/scripts/sidetest.mjs --screen pages`) | done | done | done | done |
| PAGE-004 | A page file with a mistake shows its last good version under the problem, with Open file and Ask Claude to fix | hub `GET /api/pages/page`, `POST /api/pages/ask` (fix) | `apps/desktop/tools/pages-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen pages`) | done | done | done | done |
| PAGE-005 | A project's page's buttons stay off until the person trusts it | hub `POST /api/pages/trust` | `hub/tools/pages-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen pages`) | done | done | done | done |
| PAGE-006 | A page's button types into a session only once approved; a run always goes through approve and run, its card headed with the page and the button, never as an agent's | hub `POST /api/pages/ask`, `approve`, `dismiss`, `run`; the card's heading: `cpwords.mjs` with the page run, also in `POST /api/checkpoints/words` | `hub/tools/pages-test.mjs`, `apps/desktop/tools/pages-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen pages`) | done | done | done | done |
| PAGE-007 | Customize a shipped page into your own copy | hub `POST /api/pages/customize`, its See what changed lines (`changed` in `GET /api/pages/page`, `hub/server/pagedraw.mjs` changedLines) | `hub/tools/pages-test.mjs`, `hub/tools/pagedraw-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen pages`) | done | done | done | done |
| PAGE-008 | A page never runs script or loads a remote picture; its pictures come from the hub | hub `GET /api/pages/img` | `hub/tools/pages-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen pages`) | done | done | done | done |
| PAGE-009 | On a phone: a tap opens a note as a sheet, a long press offers Move to (the note pressed found in the lanes the hub drew), a round button makes a new one | client; hub `GET /api/pages/page` (`drawn` lanes) | manual: `apps/phone/tools/preview.mjs` | n/a | n/a | done | done |
| PAGE-010 | The Rules page: rules from project memory to save or put off, and repeated asks to make into rules | hub `GET /api/rules`, `/api/rules/repeats`; `POST /api/rules/:id`, `/api/repeats/:id` | `hub/tools/rules-repeats-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen pages`) | done | done | done | done |

### Gallery and pictures

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PIC-001 | The gallery of a project's pictures, the first ones loaded before it shows and the rest as they scroll in | hub state (brief.pictures, and brief.gallery: the list newest first, `hub/server/pictures.mjs` galleryList()); `GET /api/pic/:project` | RC-25, `hub/tools/gallery-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen gallery`; `hub/tools/pictures-test.mjs` for the list) | done | done | missing | missing |
| PIC-002 | One picture large; a pinch zooms in around the pointer; the zoom and scroll stay through new states | client | RC-25 (macOS: `apps/macos/scripts/sidetest.mjs --screen gallery`: picture_click_zooms_in, picture_zoom_keeps_point, picture_zoom_kept_through_refresh; the pinch and the pan are the scroll view's own) | done | done | missing | missing |
| PIC-003 | Show a picture in Finder | hub `POST /api/project/reveal-picture` | RC-24 (macOS: `apps/macos/scripts/sidetest.mjs --screen gallery`: picture_show_in_finder) | done | done | n/a | n/a |
| PIC-004 | Pictures open in the window, never in a browser | client | RC-25 (macOS: `apps/macos/scripts/sidetest.mjs --screen gallery`) | done | done | n/a | n/a |

### Alerts and notifications

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ALERT-001 | The bell in the sidebar's foot, lit while something needs you, opens Alerts in the window | client | RC-25 (macOS: `apps/macos/scripts/sidetest.mjs --screen alerts`) | done | done | n/a | n/a |
| ALERT-002 | The Alerts page: on or off, the channel in use, the last one sent, Send a test | hub `GET /api/alerts/setup`; `POST /api/alerts/test`, `switch` | RC-27, `hub/tools/alerts-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen alerts`) | done | done | n/a | n/a |
| ALERT-003 | Mac notifications posted by the app as "Ravenry"; the hub hears whether macOS showed each; a click opens its session | hub event `notify`; `POST /api/alerts/desktop/result`; to one app only, the one focused last (`POST /api/alerts/desktop/focus`, `hub/server/desktop.mjs` pickApp) | RC-27, `hub/tools/desktop-notify-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen alerts`) | done | done | n/a | n/a |
| ALERT-004 | macOS not allowing them: Alerts says so, with a button to System Settings, Notifications | client | RC-27 (macOS: `apps/macos/scripts/sidetest.mjs --screen alerts`) | done | done | n/a | n/a |
| ALERT-005 | Telegram, a Discord or Slack webhook, or ntfy (its QR, Copy the link, New topic): set up, Use it, Turn off | hub `POST /api/alerts/telegram`, `webhook`, `ntfy/*`, `done`, `switch` | `hub/tools/alerts-test.mjs`, `hub/tools/push-ntfy-e2e.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen alerts`) | done | done | n/a | n/a |
| ALERT-006 | Pair your phone, from Alerts | client | RC-24 (macOS: `apps/macos/scripts/sidetest.mjs --screen alerts`, `--screen phone`) | done | done | n/a | n/a |
| ALERT-007 | Phone push through UnifiedPush, each alert encrypted for that phone; with no distributor, the held connection | hub `POST /api/phone/push`; Android `Push` | `apps/android/app/src/test/java/dev/ravenry/app/WebPushTest.kt` | n/a | n/a | done | n/a |
| ALERT-008 | Phone alerts answered from the shade: the answers, Run with a fingerprint, a reply line, Undo a decision, Open | hub alert messages (`hub/server/push.mjs`); Android `Notifier`, `ActionReceiver` | `apps/android/app/src/test/java/dev/ravenry/app/AlertsTest.kt` | n/a | n/a | done | n/a |
| ALERT-009 | A pick's pictures side by side in its alert | Android `Pictures` | `apps/phone/tools/pick-shots.mjs` | n/a | n/a | done | n/a |
| ALERT-010 | While paired, the connection held in the background, with a quiet "Linked to" notification counting the sessions | Android `ConnectionService`; hub `GET /api/events` | none yet | n/a | n/a | done | n/a |
| ALERT-011 | With two apps running (the Electron app and the native Mac app), each Mac notification reaches exactly one: the one focused last, else the one connected last, the other when that one goes, osascript only when neither runs | hub `GET /api/events?app=1&client=`, `POST /api/alerts/desktop/focus` (`hub/server/desktop.mjs` pickApp) | `hub/tools/desktop-notify-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen alerts`) | done | done | n/a | n/a |

### Settings

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SET-001 | The Settings window (Cmd+, on the Mac, Ctrl+, under Edit on Linux) with Appearance, Behavior and Skills | client | `apps/desktop/tools/settings-shots.mjs`, RC-17 (settings) (macOS: `apps/macos/scripts/sidetest.mjs --screen settings`) | done | done | n/a | n/a |
| SET-002 | The settings file: written whole and at once; a wrong value back to its default and logged; a broken file kept aside; migrations keep the old file | keys, kinds, ranges and defaults in `shared/settings/settings.json`; client (`apps/desktop/src/shared/settings.ts`, `apps/desktop/src/main/settingsstore.ts`; macOS `Settings.swift`) | `apps/desktop/test/settings.test.ts` (macOS: `apps/macos/scripts/sidetest.mjs --screen settings`: written whole, a wrong value read as its default, unknown keys kept, set_broken_kept_aside, set_migrated_v0, set_migrated_old_kept, set_newer_kept) | done | done | n/a | n/a |
| SET-003 | A change applies at once in every window | client | RC-17 (settings) (macOS: the window and the terminals follow the file when the other app writes it, `--screen settings`, `--screen terminal`, `apps/macos/scripts/selftest.sh` (settings_*)) | done | done | n/a | n/a |
| SET-004 | Skills: for Claude Code and for Codex, the hooks and the Ravenry skill each installed or removed; removing leaves the files byte for byte as they were. With no board running, the rows wait for it ("Needs Ravenry's board running") | hub `POST /api/setup/hooks`, `GET` and `POST /api/setup/skills` (`hub/server/skills.mjs`; `?ravenryd=` adds each row's hooks, `withHooks()`) | RC-21 (D), `hub/tools/setup-skills-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen settings`) | done | done | n/a | n/a |
| SET-005 | Hand-off: on or off, the line, the ceiling, the context window, a fresh session after | hub `GET` and `POST /api/settings/handoff` | `hub/tools/handoff-hook-test.mjs` | missing | missing | missing | missing |
| SET-006 | Start new sessions with Claude Code or Codex, and the Codex model to fall back on | hub `GET` and `POST /api/settings/assistant` | `hub/tools/start-with-test.mjs` | missing | partial | missing | missing |
| SET-007 | Where new projects go | hub `GET` and `POST /api/settings/projects-root` | `hub/tools/projects-root-test.mjs` | missing | missing | n/a | n/a |
| SET-008 | The phone's settings: the computer it is paired with and whether it answers, push on or off, the held connection on or off, Run always asks for a fingerprint, Sign out | hub `GET /api/phone/me`, `POST /api/phone/unpair`; shell `push.*`, `connection.*` | none yet | n/a | n/a | done | partial |

### Onboarding and Learn

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ONB-001 | The first launch reaches a working session with no terminal command: folders that look like projects (or choose or drop one), the assistants found and signed in, Start | hub `GET /api/setup/start` (`hub/server/firstlaunch.mjs`), `POST /api/sessions/start`. Gap: while the board is not up yet, the desktop runs `hub/server/firstlaunch.mjs` in process (IPC `local:start`, without the board's folders) and starts the assistant in a pane of its own; a native client shows Choose a folder and a plain shell until the board answers | `apps/desktop/tools/first-run.mjs`, RC-2, `hub/tools/setup-skills-test.mjs` | missing | done | n/a | n/a |
| ONB-002 | Step 2, before the session: "Let Claude work with Ravenry", the hooks and the skill ticked, Set them up or Not now | hub `POST /api/setup/hooks`, `GET` and `POST /api/setup/skills`; answered once per assistant: hub `GET` and `POST /api/onboarding` (`setup`) | RC-21 (A2, B); macOS: `apps/macos/scripts/sidetest.mjs --screen start` (start_setup_*, start_set_up_posts, start_not_now) | done | done | n/a | n/a |
| ONB-003 | One-time hints under the first Needs-you row, the first pane an agent opens and the first pick, each with Learn more and an x, inside its region from 1440 x 900 down to 720 x 480 | dismissed: hub `GET` and `POST /api/onboarding` (`hints`, `hub/server/onboarding.mjs`); where it sits: client | RC-21 (F), `hub/tools/onboarding-test.mjs` | missing | done | missing | missing |
| ONB-004 | Learn Ravenry, from the ? and Help: seven cards with a play mark, each ticked once used, no progress bar, never opened by itself | ticks: hub `GET` and `POST /api/onboarding` (`learn`); the cards: client | RC-21 (E), `hub/tools/onboarding-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen learn`; ticked by the phone card and Decisions only) | done | done | missing | missing |
| ONB-005 | Try it opens a session with its message ready in the input, not sent | client; hub `POST /api/sessions/start` | RC-21 (E) (macOS: `apps/macos/scripts/sidetest.mjs --screen learn`: Try it posts the start; the message is pasted once the new screen is still, which the test board cannot show; the filmstrip card shows the busiest terminal, no native filmstrip) | partial | done | missing | missing |
| ONB-006 | Relaunched, or in a second client: no hint comes back, Learn stays closed, no step 2 again. What the app's store held before is sent to the board once; a mark made while the board is not up waits in the store until it answers | hub `GET` and `POST /api/onboarding` (`hub/server/onboarding.mjs`); client `apps/desktop/src/renderer/onboarding.ts` (the store's marks the board lacks) | RC-21 (F/A2), `hub/tools/onboarding-test.mjs`, `apps/desktop/test/onboarding.test.ts` | missing | done | n/a | n/a |
| ONB-007 | While macOS asks whether Ravenry may read a folder, the window says so and where to turn it on; a refused folder is named | hub (`hub/server/access.mjs`), state (waitingFor) | `apps/desktop/tools/access-shots.mjs`, `hub/tools/access-wait-test.mjs` | missing | done | n/a | n/a |
| ONB-008 | The switch from the npm board: what was found and what happens to each, each step as it is done, and the way back | hub (`hub/server/npmswitch.mjs`); client `apps/desktop/src/main/npmswitch.ts` | RC-6, `apps/desktop/test/npmswitch.test.ts` | missing | done | n/a | n/a |

### Phone pairing

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PHONE-001 | Phone access: a switch on the computer, off until turned on (pairing turns it on); off, the phone port is closed and a request from the Wi-Fi gets 403 | hub `POST /api/phone/access` | `hub/tools/phone-access-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen phone`) | done | done | n/a | n/a |
| PHONE-002 | The pairing QR code: the hub's addresses, port, key pin and a one-time code, with the code and its check number to type instead | hub `GET /api/phone` | `hub/tools/phone-app-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen phone`) | done | done | n/a | n/a |
| PHONE-003 | Pair by the QR code, by the `ravenry://pair` link (asked first), or by the typed code after comparing the check number | hub `POST /api/phone/pair` | `apps/android/app/src/test/java/dev/ravenry/app/PairingTest.kt` | n/a | n/a | done | n/a |
| PHONE-004 | TLS that takes only the pinned key, whoever signed it; the token and the pin kept encrypted on the phone | Android `HubClient`, `Store` | `apps/android/app/src/test/java/dev/ravenry/app/PinTest.kt` | n/a | n/a | done | n/a |
| PHONE-005 | Every request of the page goes through the shell; the page never holds the token | Android bridge (`ravenryShell`) | `apps/android/app/src/androidTest/java/dev/ravenry/app/BridgeTest.kt` | n/a | n/a | done | n/a |
| PHONE-006 | Devices: every phone signed in, renamed with a click, Sign out; New key signs every phone out | hub `GET /api/phone/devices`; `POST /api/phone/devices/rename`, `revoke`, `/api/phone/new-key`; each device's name and line: `line` of `GET /api/phone` (`hub/server/phone.mjs` deviceLine) | `hub/tools/phone-app-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen phone`) | done | done | n/a | n/a |
| PHONE-007 | An older phone keeps working against a newer hub (the link's, the push's, the bridge's and the API's versions) | hub `GET /api/phone/hello` | `hub/tools/phone-app-test.mjs` | n/a | n/a | done | done |

### Machines

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MACH-001 | The Machines page, from the server mark in the sidebar's foot (a dot while one needs you): each machine, its state, its ravenryd beside this app's | hub `GET /api/machines`; what each card says, its buttons and steps: `card` of each machine (`hub/server/machineview.mjs`) | `apps/desktop/tools/machines-shots.mjs`, `hub/tools/machines-test.mjs`, `hub/tools/machineview-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen machines`) | done | done | partial | partial |
| MACH-002 | Add a machine from the hosts in `~/.ssh/config`, or remove one | hub `POST /api/machines/add`, `remove` | `hub/tools/machines-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen machines`: the card's buttons post the hub's routes) | done | done | n/a | n/a |
| MACH-003 | Install, Update or Uninstall ravenryd and the hooks over ssh with no sudo, each step shown with what it did or why it stopped | hub `POST /api/machines/install`, `uninstall` | `hub/tools/remote-install-test.mjs`, `apps/desktop/tools/machines-shots.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen machines`: the card's buttons post the hub's routes) | done | done | n/a | n/a |
| MACH-004 | Retry a machine that did not answer | hub `POST /api/machines/retry` | `hub/tools/machines-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs --screen machines`: the card's buttons post the hub's routes) | done | done | n/a | n/a |
| MACH-005 | A machine's sessions in the sidebar with its name, their checkpoints answerable | hub state; `POST /api/checkpoints/answer` | `apps/desktop/tools/checkpoint-shots.mjs` | missing | done | done | done |
| MACH-006 | A session on a machine shows its live terminal and takes typing | hub `GET /api/term` (`ssh host ravenryd proxy`) | none yet | missing | partial | done | done |
| MACH-007 | Start a session on a machine | hub `POST /api/sessions/start` (machine) | none yet | missing | missing | missing | missing |

### Updates and install

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| UPD-001 | The packaged app copies its ravenryd and hub to a folder per version; `bin/ravenryd` and `bin/ravenry` link to the newest | client (`apps/desktop/src/main/install.ts`) | `apps/desktop/test/install.test.ts` | missing | done | n/a | n/a |
| UPD-002 | Updates from the project's releases: downloaded in the background, installed on quit or at once from Check for Updates; a .deb says it does not update itself | client (`apps/desktop/src/main/updater.ts`) | manual: install the build before, update, relaunch | missing | done | n/a | n/a |
| UPD-003 | An update that stopped trying says so, with Try again | client | none yet | missing | done | n/a | n/a |
| UPD-004 | An update never ends a session: the new daemon starts beside the old one, which drains; an old pane is one row and opens on a click | daemon (`PROTOCOL.md` section 9); hub | RC-5, RC-7 | missing | done | n/a | n/a |
| UPD-005 | After an update exactly one hub runs, on the new version; the old folder is kept until it answers | client (`apps/desktop/src/main/install.ts`) | RC-5 | missing | done | n/a | n/a |
| UPD-006 | The hooks of a session started before an update still run (they name the stable `current` folder) | client (`apps/desktop/src/main/install.ts`); hub hooks | RC-8 | missing | done | n/a | n/a |
| UPD-007 | Opened from inside a pane, the app relaunches clean, as the Dock starts it, and one instance is left | client (`apps/desktop/src/main/relaunch.ts`) | RC-13, `apps/desktop/test/relaunch.test.ts` | missing | done | n/a | n/a |
| UPD-008 | Packages: a dmg and zip for the Mac, an AppImage and a .deb for Linux, an APK for Android; none for Windows yet | build (`apps/desktop/electron-builder.config.mjs`, `.github/workflows/`) | manual: each package installs and opens | missing | partial | done | n/a |

### The hub service

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| HUB-001 | The hub runs always on as a user service (launchd on the Mac, systemd on Linux) on the app's own Node; the app installs it and brings it to its version | client (`apps/desktop/src/main/install.ts`) | RC-1, `apps/desktop/test/install.test.ts` | missing | done | n/a | n/a |
| HUB-002 | Closing the window stops neither the hub nor the alerts to the phone | hub service | manual: quit the app, an alert still reaches the phone | missing | done | n/a | n/a |
| HUB-003 | The hub the app ships answers within 1 s of listening and has its first state within 3 s on a big set of projects, its main thread never held over 200 ms | hub | RC-12 | missing | done | n/a | n/a |
| HUB-004 | Before its first state the hub answers 503 "starting" at once; the client says it is starting, never waits on a held request | hub `GET /api/state` | RC-12 | missing | done | missing | missing |
| HUB-005 | Writes come only from the board's own pages, and a person's decision never from a program inside a pane or an ssh session | hub (`hub/server/person.mjs`, `hub/docs/PERSON.md`) | `hub/tools/person-routes-test.mjs` | missing | done | done | done |
| HUB-006 | The client finds the daemon of its version in the runtime folder, or starts ravenryd | daemon socket (`PROTOCOL.md` section 9); client `apps/desktop/src/main/daemon.ts`, `apps/desktop/src/main/spawn.ts` | `apps/desktop/tools/smoke.mjs` | missing | done | n/a | n/a |
| HUB-007 | The app and every app it launches run with a clean environment: no pane variables, no `RAVENRY_*` but their own | client (`apps/desktop/src/main/gate.ts`, `apps/desktop/src/main/relaunch.ts`) | RC-env | missing | done | n/a | n/a |
| HUB-008 | Every row click, every move and every quit says what it did in app.log, and the hub's log says the same for a move | client; hub log | RC-9, RC-18 | missing | done | n/a | n/a |

### Signing

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SIGN-001 | A release build takes no test hook from its launch, quits on a debugging switch, has its fuses set, and loads nothing through `DYLD_INSERT_LIBRARIES` | client (`apps/desktop/src/main/gate.ts`), build | RC-0, `apps/desktop/tools/package-check.mjs`, `apps/desktop/test/gate.test.ts` | missing | done | n/a | n/a |
| SIGN-002 | The app and every binary in it pass `codesign --verify --deep --strict`; on a Mac with an Apple Development identity all carry its team, else ad hoc | build (`apps/desktop/scripts/pack.mjs`) | RC-0 | missing | done | n/a | n/a |
| SIGN-003 | The test twin: the same build, ravenryd and hub as the release, with the test hooks on | build (`apps/desktop/scripts/pack.mjs`) | RC-0 | missing | done | n/a | n/a |
| SIGN-004 | Release: Developer ID signing and notarization in CI when the secrets exist | `.github/workflows/release.yml` | none yet | missing | partial | n/a | n/a |
| SIGN-005 | The hardened runtime, and the words macOS shows when the app or a pane asks for a guarded folder, the camera or the microphone | build (`apps/desktop/electron-builder.config.mjs`) | manual: a pane reads `~/Documents`, the prompt names Ravenry | missing | done | n/a | n/a |
| SIGN-006 | The Android release signed with its upload key in CI when the secrets exist; no Google Play services, so it builds for F-Droid | `.github/workflows/android.yml` | none yet | n/a | n/a | partial | n/a |

### Accessibility and keyboard

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A11Y-001 | Every app action is in the menus (Shell, Edit, View, Help) with its shortcut, Mac and Linux keys each; Cmd+, reaches the menu from the terminal | client | RC-17 (G, settings) | missing | done | n/a | n/a |
| A11Y-002 | No app shortcut swallows a terminal key | client | RC-11 | missing | done | n/a | n/a |
| A11Y-003 | Every visible control does what it says: none does nothing, none opens the board in the browser | client | RC-24 | missing | done | partial | partial |
| A11Y-004 | Every icon button has a label for screen readers and a tooltip; focus shows a ring | client | RC-24 | missing | done | partial | partial |
| A11Y-005 | A checkpoint card takes the keyboard: it has a label, and number keys pick an answer | client | `apps/desktop/test/checkpoints.test.ts` | missing | done | n/a | n/a |
| A11Y-006 | Dark and light on every screen, following the system, in the shared colours | `shared/tokens/tokens.json` (dark and light); client picks the theme | RC-9, RC-10, RC-19, RC-25, `apps/desktop/test/shared.test.ts`; macOS: `apps/macos/scripts/sidetest.mjs` and each `--screen` (every screen's pictures in dark and light as the system appearance changes, beside the Electron app's), `--screen terminal` (term_follows_system_dark, term_follows_system_light); the colours from `shared/tokens/tokens.json` (Design.swift) | done | done | done | done |
| A11Y-007 | Typed text, focus, selection and scroll stay through every new state from the hub | client | RC-25 | missing | done | done | done |
| A11Y-008 | Esc closes Find, a sheet or a dialog and gives the keyboard back to the terminal; on the phone, Back goes back one screen | client; Android shell (`back`) | RC-17 (F1) | missing | done | done | n/a |
| A11Y-009 | The terminal's screen reader mode | client (xterm.js `screenReaderMode`) | none yet; macOS: VoiceOver reads the visible rows: `apps/macos/scripts/selftest.sh` (a11y_*) | partial | missing | missing | missing |
| A11Y-010 | Reduced motion respected | client | none yet | missing | missing | missing | missing |

## 3. Gaps found while reading

Between clients:

- MACH-006: the desktop shows a session on another machine read only (its screen or transcript); the phone already streams it live through the hub's `/api/term`.
- MACH-007: no client starts a session on another machine, though `POST /api/sessions/start` takes `machine`.
- SESS-009, SESS-015 to SESS-018: the phone cannot start a session, Continue one, or Move one here.
- SESS-021 to SESS-023, BRIEF-005, BRIEF-006: Reopen, New project, Add to a project, a note and a new brief exist only in the hub's browser board (`hub/public/`), in no app.
- SET-005 to SET-007: the hand-off, start-with and projects-root settings exist only in the browser board.
- DEC-004: the hub can add, edit and remove a decision as the person; no client has the buttons.
- PLAN-003, PLAN-005, PLAN-006: confirm or reopen a gate, write your own plan, revise a draft and change a running plan are in the hub and the browser board, not in the desktop.
- IDEA-004 to IDEA-006: the desktop's idea thread has no mockup pick, no stop, no references, no project from an idea.
- PLAN-002: the phone's gate alert offers only Open, and the phone has no screen to answer a gate.
- The phone has no Decisions page, brief, gallery, plan page, idea thread, Learn, files changed, review, pane leases or filmstrip.
- TERM-021, TERM-028: on the phone a link cannot be opened (it needs Cmd or Ctrl) and nothing can be selected or copied.
- HUB-004: the phone board does not handle the hub's 503 "starting".
- UPD-008: no Windows build of the desktop app.
- A11Y-009, A11Y-010: no screen reader mode in the terminal and no reduced motion in the apps (the browser board has reduced motion).
- Rows marked `none yet` have no check at all; the Android and phone web statuses rest on code reading, with no end-to-end check of the phone board's terminal, pages or sessions beyond `pick-shots.mjs` and the Kotlin tests.

Client-only logic that should move to the hub:

- `apps/desktop/src/main/install.ts` and `apps/desktop/src/main/npmswitch.ts`: the hub service, the version folders and the npm switch's choices. One `ravenry` command every client runs.
- The settings file's migrations (SET-002): written in each app, the desktop's `apps/desktop/src/shared/settings.ts` MIGRATIONS and the native Mac app's `Settings.swift` migrate(), the same steps. They should be data in `shared/settings/settings.json` (or the hub's), read by both.
- Closing a busy shell (TERM-016): moved to the daemon on 2026-11-10: `pane.process` says `busy` (the foreground is not the pane's first process), which the desktop's app.ts askClose() and the native Mac app's Workspace.askClose() read; each keeps its own comparison of the pids only for an older daemon's answer without it.
- Which pane is an agent's own (TERM-013, PANEL-012): both apps decide it from `pane.list` (a pane an agent made from its pane, shown, running, not a shell: the desktop's app.ts agentPane(), the native Mac app's Workspace.swift isAgentPane()) and both place it beside its owner's tab. The daemon's pane could say it (`own_of`).
- A worktree session's review (PANEL-013, PANEL-014): the hub now sends each file's diff lines with their numbers and how Merge goes (`GET /api/sessions/:id/diff` `lines` and `mergeMode`), and a project's files with the file another session changed too and the grid (`GET /api/projects/:id/files` `clash` on each file and `grid`; `hub/server/reviewview.mjs`, moved from the desktop's review.ts parseDiff() and files.ts clashOf() and grid()). The native Mac app reads them; the desktop still works them out itself (gap: its review.ts and files.ts to read the hub's).
- "Checked your decisions first" on an ask card (DEC-006): the hub puts the decisions the agent read just before it asked on the checkpoint (`checked`, `hub/server/decisions.mjs` checkedBefore(), moved from the desktop's app.ts checkedFor() and cards.ts checkedBox() on 2026-11-10 for the native Mac app; the desktop still works it out itself from its own read of the ledger, the same rule).
- Which session already works in a folder New session starts in (SESS-010): the hub says it on each folder of `GET /api/setup/start` (`busy`: its project, its name and the session's topic; `hub/server/sidebar.mjs` busyIn(), moved from the desktop's app.ts busyIn() on 2026-11-10 for the native Mac app; the desktop still works it out itself from the state, the same rule).
- `apps/desktop/src/renderer/app.ts` swapMoved() and moveStates(): which pane a move replaced. The hub's move answer should say it.
- Left after the moves of 2026-11-09 (each in its row): the first launch runs `hub/server/firstlaunch.mjs` in the app while the hub is not up yet (ONB-001); a checkpoint the desktop hears only from its own daemon has no words until the hub words it, so with the hub down its card is empty (PANEL-015); most strings are still inline in each client, the type sizes, radii and gaps are tokens no rule uses yet, and `hub/public/app.css` keeps its own colours (section 1); terminal themes and icons are not in `shared/` yet.

Moved to the hub on 2026-11-09: the sidebar's sections, rows, order and counts (`state.sidebar`, `hub/server/sidebar.mjs`), what a checkpoint and its row mark say (`cp.words`, `hub/server/cpwords.mjs`, `POST /api/checkpoints/words`), the brief's Next items (`brief.nextParts`, `hub/server/briefnext.mjs`), a project's gallery, newest first (`brief.gallery`, `hub/server/pictures.mjs` galleryList(), moved from the desktop's inapp.ts pictures() for the native Mac app; the desktop still works it out itself), what the Decisions page shows, its entries in days with each one's project name, the session it was said in, what it replaced and when it was replaced, filtered by Holds now, Replaced or All, a project and the search, with the counts and the menu's projects (`GET /api/decisions?page=1`, `hub/server/decisions.mjs` page(), moved from the desktop's decisions.ts render() for the native Mac app; the desktop still works it out itself), the plans a project's plan page shows, the running one first, then the brief's with their steps' states and proofs (`planPages`, `hub/server/planfmt.mjs` planPages(), moved from the desktop's inapp.ts planOf() for the native Mac app; the desktop still works it out itself), what See what changed shows of a default page against the revision a copy started from, the added lines with two around each (`changed` in `GET /api/pages/page`, `hub/server/pagedraw.mjs` changedLines(), moved from the desktop's pages.ts diffLines() and drawModal('changed') for the native Mac app; the desktop still works it out itself), a page's filters, sorts, groups and counts (`drawn` in `GET /api/pages/page`, `hub/server/pagedraw.mjs`), the first launch's folders and assistants (`GET /api/setup/start`), the skill's install and remove (`GET` and `POST /api/setup/skills`), the onboarding state (`GET` and `POST /api/onboarding`), what the Machines page shows of each machine, its state word and colour, its line, buttons, facts, the Uninstall question and its job's steps (`card` of each machine in `GET /api/machines` and the state, `hub/server/machineview.mjs`, moved from the desktop's machines.ts status(), card() and steps() for the native Mac app; the desktop still works it out itself), what the phone card says of each device (`line` in `GET /api/phone`, `hub/server/phone.mjs` deviceLine(), moved from the desktop's phonecard.ts for the native Mac app; the desktop still works it out itself), the theme import from an iTerm2 or a Ghostty file (`POST /api/settings/theme-import`, `hub/server/themeimport.mjs`, moved from the desktop's main/themeimport.ts, which now re-exports it), the Settings window's Skills rows with their hooks (`GET /api/setup/skills?ravenryd=`, `hub/server/skills.mjs` withHooks(), moved from the desktop's main.ts hooksOf() for the native Mac app; the desktop still works it out itself), the shared strings and tokens (`shared/`, `shared/README.md`), and the terminal settings' keys, kinds, ranges and defaults and the shipped themes (`shared/settings/settings.json`, `shared/themes/`, read by the desktop's `shared/settings.ts` and `themes.ts` and the native Mac app's `Settings.swift`).

## 4. How to keep it current

A change that adds, changes or removes what a client does updates its row
here in the same commit: the behaviour, the logic, the acceptance and the
status of the platform it touched. A new feature gets the next free id of
its area. A new step in the release check names the feature it proves, and
`node tools/features-check.mjs` fails until some row cites it (it also
checks the ids, the status values and that every cited file exists). A new
platform starts by copying the Electron column under its own name with
every `done` and `partial` set to `missing`, keeps `n/a` only where the
feature truly does not apply there, and turns a row to `done` only when its
acceptance check passes on that platform.
