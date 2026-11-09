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
| TERM-001 | Every pane runs in ravenryd, so closing, restarting or updating the window never ends it | daemon `pane.new`, `pane.list` | RC-4 | missing | done | n/a | n/a |
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
| TERM-013 | An agent's own pane opens as a split beside the tab it came from, without taking the keyboard; its header says its name and Agent once | client; daemon `pane.created` (creator) | RC-10, RC-16 | missing | done | n/a | n/a |
| TERM-014 | Splits come back after a relaunch, with their panes | client `window.json` | RC-16; macOS: `apps/macos/scripts/selftest.sh` (restore_splits) | done | done | n/a | n/a |
| TERM-015 | Cmd+W closes the pane with the keyboard and ends its process; an idle shell closes at once | daemon `pane.close` | RC-16, RC-17 (F3); macOS: `apps/macos/scripts/selftest.sh` (split_cmd_w_closes_pane, tab_cmd_w_closes, tab_middle_click_closes): every shell closes at once, a busy one too (no TERM-016 question yet) | partial | done | n/a | n/a |
| TERM-016 | Closing a busy shell asks "Close this tab?" with what runs, Cancel the default, and Don't ask again | daemon `pane.process`; client setting | RC-17 (F3) | missing | done | n/a | n/a |
| TERM-017 | Resize: rows at once, columns once the size holds; hidden terminals resize when shown or idle; no pane blank or flashed while dragging | daemon `pane.resize`; client | RC-26, `apps/desktop/tools/frame-time.mjs`, `apps/desktop/tools/resize-load.mjs`; macOS: `apps/macos/scripts/bench.sh` (drag, fast drag, divider drag over both panes of a split, 0 blank, 0 debris, ends on the daemon's screen): a hidden tab resizes when shown; columns follow at once, not once the size holds | partial | done | n/a | n/a |
| TERM-018 | Switching views (a tab, a session, a page, the panel) never shows a half-drawn, blank or flashed frame | client | RC-26; macOS: `apps/macos/scripts/bench.sh` (tab switches: blank panes 0; the rows a pane had are drawn at the switch, a pane never drawn waits under the tab in front for its first frame) | done | done | n/a | n/a |
| TERM-019 | Synchronized output: an update shows whole; a big one is parsed in slices and never freezes the window | client; daemon stream frames | RC-26, `apps/desktop/tools/resize-load.mjs` | missing | done | done | done |
| TERM-020 | Colours: 16, 256 and truecolor, `ls -G` and the prompt, fresh, after a tab switch and after a relaunch | daemon screen; client renderer | RC-19 | missing | done | done | done |
| TERM-021 | Links: OSC 8 and plain URLs (http, https, file only) open on Cmd+click (Ctrl+click off the Mac); a plain click opens nothing | client; daemon `render.link` | RC-14, RC-20; macOS: `apps/macos/scripts/selftest.sh` (link_*), `daemon/internal/vt/select_test.go` (TestLinkAt), `daemon/internal/server/basics_test.go` (TestRenderLinkAndPaths) | done | done | missing | missing |
| TERM-022 | Hovering a link says "Cmd+click to open"; holding Cmd underlines it with the pointing hand; a setting opens links on a plain click | client setting | RC-20; macOS: `apps/macos/scripts/selftest.sh` (link_pointing_hand, link_underline_drawn); no hover hint and no plain-click setting yet | partial | done | n/a | n/a |
| TERM-023 | Paste goes to the daemon as one paste: bracketed when the program asked, unsafe control characters made harmless | daemon `pane.send` (paste); daemon `render.input` paste | `apps/desktop/tools/smoke.mjs`; macOS: `apps/macos/scripts/selftest.sh` (paste_cmd_v) | done | done | n/a | n/a |
| TERM-024 | A file dropped on the terminal pastes its path, quoted; several separated by spaces | client; daemon `render.input` paths | RC-14; macOS: `apps/macos/scripts/selftest.sh` (drop_files_quoted_paths), `daemon/internal/server/basics_test.go` (TestRenderLinkAndPaths) | done | done | n/a | n/a |
| TERM-025 | Scrollback of 100 to 100,000 lines (10,000 by default), the same length kept by the daemon | client setting; daemon `pane.new` | RC-17 (settings) | missing | done | n/a | n/a |
| TERM-026 | Cmd+Home and Cmd+End go to the top and the bottom of the scrollback | client | RC-14; macOS: `apps/macos/scripts/selftest.sh` (cmd_home_top, cmd_end_bottom) | done | done | n/a | n/a |
| TERM-027 | Cmd+K clears the scrollback, in the daemon too, and types nothing | daemon `pane.clear` | RC-11; macOS: `apps/macos/scripts/selftest.sh` (clear_cmd_k) | done | done | n/a | n/a |
| TERM-028 | Selection: Cmd+A selects all, Cmd+C copies, neither types anything; a right click selects nothing | client; daemon `render.copy` | RC-11; macOS: `apps/macos/scripts/selftest.sh` (select_all_cmd_a, copy_cmd_c_private_pasteboard) | done | done | missing | missing |
| TERM-029 | Copy on select (a setting) | client setting | RC-17 (settings) | missing | done | n/a | n/a |
| TERM-030 | Find (Cmd+F): every match counted, Enter for the next, Cmd+Shift+G the one before, Aa for match case, Esc gives the keyboard back | client; daemon `render.find` | RC-17 (F1); macOS: `apps/macos/scripts/selftest.sh` (find_*), `daemon/internal/vt/select_test.go` (TestFind), `daemon/internal/server/basics_test.go` (TestRenderFind); no Aa: libghostty-vt matches ASCII letters in any case | partial | done | n/a | n/a |
| TERM-031 | Right-click menu: Open Link, Copy Link, Copy, Paste, Select All, Copy Path, Find, Clear, Split Right, Split Down | client | RC-17 (F2); macOS: `apps/macos/scripts/selftest.sh` (context_menu_items): Copy, Paste, Select All, Clear, Find; no link or split items yet | partial | done | n/a | n/a |
| TERM-032 | Every row of the keys table arrives as its exact bytes: Cmd+arrows, Option+arrows by word, Cmd+Backspace, Shift+Enter as a newline | client | RC-11; macOS: `apps/macos/scripts/selftest.sh` (key_*), `daemon/internal/server/keybinds_test.go` (TestRenderKeybindsZsh), `daemon/internal/vt/keybinds_test.go` (every row of the daemon's macos table, docs/RENDERING.md "Key bindings") | done | done | n/a | n/a |
| TERM-033 | Option as Meta: off, left, right or both | client setting | RC-17 (settings) | missing | done | n/a | n/a |
| TERM-034 | The daemon answers terminal queries; the client never answers them too | daemon | `apps/desktop/test/queries.test.ts` | missing | done | done | done |
| TERM-035 | Bell: a flash on screen, a small bell on a hidden tab until opened, or a sound, or off; the Dock bounces while the app is not in front | client setting | RC-17 (F4); macOS: `apps/macos/scripts/selftest.sh` (bell_flash_shows, bell_flash_ends): the flash only, no hidden-tab bell, sound or Dock | partial | done | n/a | n/a |
| TERM-036 | Font family, with Menlo, SF Mono, DejaVu Sans Mono and Liberation Mono as fallbacks | client setting | `apps/desktop/test/settings.test.ts`; macOS: `apps/macos/scripts/selftest.sh` (font_default_menlo_12): Menlo 12 by default and `--font`; no setting yet | partial | done | n/a | n/a |
| TERM-037 | Text size: Cmd+=, Cmd+- and Cmd+0 change the terminals only, write the settings, and are kept across a relaunch | client setting | RC-14, RC-17 (settings); macOS: `apps/macos/scripts/selftest.sh` (cmd_plus_bigger, cmd_minus_smaller, cmd_0_default); kept in the app's own defaults, not a shared settings file | partial | done | n/a | n/a |
| TERM-038 | Cursor style (block, bar, underline) and blink; programs may still change it | client setting | RC-17 (settings); macOS: `apps/macos/scripts/selftest.sh` (cursor_*): the program's style and blink; no setting yet | partial | done | n/a | n/a |
| TERM-039 | Themes: eight shipped; one for light and one for dark following the system, or one always | client setting; `apps/desktop/src/shared/themes/` | `apps/desktop/test/settings.test.ts`, `apps/desktop/tools/settings-shots.mjs` | missing | done | partial | partial |
| TERM-040 | Import a theme from an .itermcolors or a Ghostty theme file | client (`apps/desktop/src/main/themeimport.ts`) | `apps/desktop/test/themeimport.test.ts` | missing | done | n/a | n/a |
| TERM-041 | The agents' symbols (record, star, warning, braille spinner) drawn from Ravenry's glyph font, never a colour emoji font | client font | none yet | missing | partial | done | done |
| TERM-042 | New Window (Cmd+N) with a shell of its own; Close Window; the first window's tabs stay as they were | client | RC-17 (G) | missing | done | n/a | n/a |
| TERM-043 | The window keeps its size and place, on a screen that is still there | client `window.json` | RC-14 | missing | done | n/a | n/a |
| TERM-044 | What an agent or the hub typed is marked in the right gutter with its name and time; the person's own typing never is | daemon `pane.inputs`; client | `apps/desktop/tools/marks-test.mjs` | missing | done | missing | missing |
| TERM-045 | Filmstrip: the pane's last 20 s, bad frames marked, step and play, Send to the agent, Save as GIF | daemon `pane.frames`; hub `POST /api/sessions/:id/filmstrip` | `apps/desktop/test/phase2.test.ts`, `apps/desktop/tools/phase2-shots.mjs` | missing | done | missing | missing |
| TERM-046 | A pane asked to show (`ravenryd focus`) comes to the front | daemon event `pane.focus` | `apps/desktop/tools/smoke.mjs` | missing | done | n/a | n/a |
| TERM-047 | The phone's key bar: Esc, Tab, the arrows, Enter and Ctrl-C into the pane | client; hub `GET /api/term` | `apps/phone/test/logic.test.ts` | n/a | n/a | done | done |
| TERM-048 | Wheel and trackpad: precise deltas added up in rows with momentum; to the program when it reports the mouse; arrow keys on the alternate screen (mode 1007), as Ghostty does; typing brings a scrolled view back | daemon `render.input` wheel | `daemon/internal/server/basics_test.go` (TestRenderWheel, TestRenderWheelProgram); macOS: `apps/macos/scripts/selftest.sh` (wheel_precise_rows, wheel_discrete_3_rows_a_notch, key_scrolls_back) | done | partial | partial | partial |
| TERM-049 | An overlay scrollbar shows while the view scrolls and fades out after, macOS style | client | macOS: `apps/macos/scripts/selftest.sh` (scrollbar_shows, scrollbar_drawn, scrollbar_hides) | done | partial | n/a | n/a |
| TERM-050 | Selection: a drag, two clicks a word, three a line, Shift-click extends, Option a block, across the scrollback (a drag past the edge scrolls); a copy joins soft-wrapped rows | daemon `render.input` select, `render.copy` (libghostty-vt's selection gesture) | `daemon/internal/vt/select_test.go` (TestSelectGesture), `daemon/internal/server/basics_test.go` (TestRenderSelection); macOS: `apps/macos/scripts/selftest.sh` (select_*, drag_past_top_autoscrolls) | done | partial | missing | missing |
| TERM-051 | Box drawing, block elements, braille and the Powerline triangles drawn by the renderer to fill the cell, so lines join | client renderer | macOS: `apps/macos/scripts/selftest.sh` (box_lines_join_across, box_lines_join_down, block_fills_cell) | done | partial | partial | partial |
| TERM-052 | The cell comes from the font's own metrics (advance, ascent, descent and line gap rounded to pixels, Ghostty's computation), Menlo 12 by default as in Rex; no ligatures | client renderer | macOS: `apps/macos/scripts/selftest.sh` (cell_14x28_px_at_2x, grid_fills_view); `apps/macos/scripts/bench.sh` prints the grid of a 900 x 560 pt window | done | partial | n/a | n/a |
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
| SESS-009 | New Session (Cmd+Shift+N, or the + at the sidebar's top) starts the assistant in a Ravenry pane in the chosen folder | hub `POST /api/sessions/start` | RC-2, `hub/tools/new-session-test.mjs` (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | missing | missing |
| SESS-010 | A new session in a folder another session works in gets its own copy on a new branch, one line saying why, or works in the folder if asked | hub `POST /api/sessions/start` (worktree) | `hub/tools/worktree-test.mjs` | missing | done | missing | missing |
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
| PANEL-009 | A shell's panel: who opened it, its folder, what it runs, and what the agent in it reported | daemon `pane.list`, `agent.report` | `apps/desktop/tools/smoke.mjs` (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | n/a | n/a |
| PANEL-010 | Who can type here: you always; an agent asks each time unless let for its session; take it back | daemon `pane.grants`, `pane.revoke` | `apps/desktop/test/phase2.test.ts`, `apps/desktop/tools/phase2-shots.mjs` | missing | done | missing | missing |
| PANEL-011 | Typed here: the pane's input log, a typed command as one entry | daemon `pane.inputs` | RC-17 (Typed here) (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | missing | missing |
| PANEL-012 | A lent pane: a strip with who has it and who waits, Hand it to and Take it back, a badge on its tab; Panes it uses in the session's panel | daemon `pane.lease` | `apps/desktop/tools/phase2-shots.mjs` | missing | done | missing | missing |
| PANEL-013 | Files changed: each file with its added and removed lines, one another session changed too in orange; See all opens the project's grid | hub `GET /api/projects/:id/files` | `hub/tools/worktree-test.mjs` | missing | done | missing | missing |
| PANEL-014 | Review a worktree session: its files and diff, comments on lines, Send N comments, Merge into main, Undo the merge, Delete the branch | hub `/api/sessions/:id/diff`, `review/*`, `merge`, `unmerge`, `delete-branch`, `discard` | `hub/tools/worktree-test.mjs`, `apps/desktop/test/phase2.test.ts` | missing | done | missing | missing |
| PANEL-015 | A checkpoint shows as a mark on its row, a dot on its tab, and a card at the top of the panel (phone: a bar over the session, its own screen) | daemon `checkpoint.*` events; hub `GET /api/checkpoints`; what it says: hub `words` on every checkpoint (`hub/server/cpwords.mjs`; state `checkpoints`, `GET /api/checkpoints`, the answer's response, `POST /api/checkpoints/words` for a daemon's copy), tokens filled by the rule in `hub/docs/STATE-RULES.md`; times said against the client's clock. Gap: a daemon's copy is drawn empty until the hub words it, so with the hub down the desktop shows no card words | `hub/tools/cpwords-test.mjs`, `hub/tools/hub-api-test.mjs`, `apps/desktop/test/checkpoints.test.ts`, `apps/desktop/tools/checkpoint-shots.mjs` (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | done | done |
| PANEL-016 | Ask: the question, one answer per line with number keys, or an answer in your own words | daemon `checkpoint.answer`, else hub `POST /api/checkpoints/answer`; its words (heading, head, body, the phone's checks) hub `words` | `hub/tools/cpwords-test.mjs`, `apps/desktop/test/checkpoints.test.ts`, `apps/desktop/tools/checkpoint-shots.mjs` (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | done | done |
| PANEL-017 | Approve: the command with its folder, machine and pane, the warnings and whose they are, Edit, Refuse and Run | daemon `checkpoint.answer`, else hub `POST /api/checkpoints/answer`; the warnings, the machine and Run's label hub `words`; for a command being edited the client applies the hub's guess rules (`words.guess.rules`, regular expressions as data) at each keystroke | `hub/tools/cpwords-test.mjs`, `apps/desktop/test/checkpoints.test.ts`, `apps/desktop/tools/checkpoint-shots.mjs` (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | done | done |
| PANEL-018 | Run from the phone always asks for a fingerprint first; it cannot be turned off | Android `RunActivity` | `apps/phone/tools/pick-shots.mjs` | n/a | n/a | done | n/a |
| PANEL-019 | Secret: typed into a field inside the card and sent to the terminal, never kept or shown | daemon `checkpoint.answer`; its words hub `words` (`secret.noun`, `after`); the field's own checks (`secretProblem`, `characters`) stay in the client as input validation, so the value never goes to the hub | `apps/desktop/test/checkpoints.test.ts`, `hub/tools/cpwords-test.mjs` | missing | done | done | n/a |
| PANEL-020 | The phone's private keyboard for a secret: no suggestions, no learning, the page never sees it | Android `SecretField` | none yet | n/a | n/a | done | n/a |
| PANEL-021 | Drive: an agent asks to type into, close, restart or change a pane; allow once or for the session, or refuse | daemon checkpoint (drive), `pane.grants`; its words, the pane's name and the phone's screen hub `words.drive` | `hub/tools/cpwords-test.mjs`, `apps/desktop/test/phase2.test.ts`, `apps/phone/tools/pick-shots.mjs` (macOS: `apps/macos/scripts/sidetest.mjs`) | partial | done | done | done |
| PANEL-022 | Pick: 2 to 4 pictures side by side (phone: one at a time, swiped), Pick, Circle a part with a note, None of these | hub `GET /api/checkpoints/:id/variants/:n`, `POST /api/checkpoints/answer`; each variant's letter, name and the agent's words hub `words.variants` | `hub/tools/picks-test.mjs`, `hub/tools/cpwords-test.mjs`, `apps/phone/tools/pick-shots.mjs` | missing | done | done | done |
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
| PLAN-001 | A plan's page: its steps with their proofs, how many are done, the current one, Pause and Resume | hub state (plan); `POST /api/plan/pause`, `resume` | RC-25, `hub/tools/plans-test.mjs` | missing | done | partial | partial |
| PLAN-002 | Answer a plan's gate: its choices as buttons, or your own words | hub `POST /api/plan/answer` | `hub/tools/plans-test.mjs`, `hub/tools/person-routes-test.mjs` | missing | done | partial | missing |
| PLAN-003 | Confirm or reopen a gate the file alone passed | hub `POST /api/plan/confirm`, `reopen` | `hub/tools/plans-test.mjs` | missing | missing | missing | missing |
| PLAN-004 | New plan from the brief: say the goal, the hub drafts the steps, answer its questions, Start or Discard; Stop while it drafts | hub `GET /api/plan/draft`; `POST /api/plan/draft`, `edit`, `start`, `discard`, `halt` | RC-25, `hub/tools/plans-test.mjs` | missing | done | missing | missing |
| PLAN-005 | Write your own plan, or revise a draft with a comment | hub `POST /api/plan/own`, `revise` | `hub/tools/plans-test.mjs` | missing | missing | missing | missing |
| PLAN-006 | Change a running plan | hub `POST /api/plan/change` | `hub/tools/plans-test.mjs` | missing | missing | missing | missing |

### Ideas

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| IDEA-001 | The Ideas page: a board from spark to mockup, greenlit and parked; drag a card to another lane (phone: a long press, Move to) | hub page `ideas.page.yaml`; `POST /api/pages/item/set` | `apps/desktop/tools/pages-test.mjs`, `hub/tools/pages-test.mjs` | missing | done | done | done |
| IDEA-002 | Add an idea, or brainstorm ideas from a seed | hub `POST /api/ideas/add`, `/api/ideas/brainstorm` | none yet | missing | done | done | done |
| IDEA-003 | An idea's thread: talk with the agent, ask for a mockup round, Greenlight, Park | hub `GET /api/ideas`; `POST /api/ideas/:id/say`, `mockups`, `update` | RC-25, `hub/tools/idea-mockups-test.mjs` | missing | done | missing | missing |
| IDEA-004 | Pick a mockup from a round, or stop the round | hub `POST /api/ideas/:id/mockups/pick`, `mockups/stop` | `hub/tools/idea-mockups-test.mjs` | missing | missing | missing | missing |
| IDEA-005 | Add references and pictures to an idea | hub `POST /api/ideas/:id/ref`, `image` | none yet | missing | missing | missing | missing |
| IDEA-006 | Make a project from an idea | hub `POST /api/project/new` (ideaId) | none yet | missing | missing | missing | missing |
| IDEA-007 | Archive an idea; Undo brings it back | hub `POST /api/pages/item/archive`, `restore` | `apps/desktop/tools/pages-test.mjs` | missing | done | done | done |

### Decisions

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DEC-001 | Decisions in the sidebar with the count of active ones, a dot while one can still be undone | hub `GET /api/decisions` | RC-24 | missing | done | missing | missing |
| DEC-002 | The Decisions page: newest first, each in the person's words with when, where and who saved it, a replaced one crossed out, how often agents read it | hub `GET /api/decisions?all=1` | RC-24, `hub/tools/decisions-test.mjs` | missing | done | missing | missing |
| DEC-003 | An agent saves one: a toast (phone: an alert) with Undo for a minute, and Show | hub event `decision`; `POST /api/decisions/undo` | `hub/tools/decisions-test.mjs`, `apps/android/app/src/test/java/dev/ravenry/app/AlertsTest.kt` | missing | done | done | missing |
| DEC-004 | Add, edit or remove a decision yourself | hub `POST /api/decisions/add`, `edit`, `remove` | `hub/tools/decisions-test.mjs` | missing | missing | missing | missing |
| DEC-005 | The app's own reads of the ledger never count as an agent's | hub (`agent=1` only from agents) | `hub/tools/decisions-test.mjs` | missing | done | n/a | n/a |

### Pages from files

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PAGE-001 | The sidebar's pages from page files: the shipped five (Ideas, Objectives, Plans, Rules, Ship), then added ones, then a project's with its name | hub `GET /api/pages`, state (pages) | `apps/desktop/tools/pages-test.mjs`, `hub/tools/pages-test.mjs` | missing | done | done | done |
| PAGE-002 | A page opens in the middle and right columns; its lists, boards and groups use page-format's own filters, sorts and counts, run by the hub: a client draws the rows, groups, tab counts, stats and item buttons it is sent, and sends the tab picked | hub `GET /api/pages/page?key=&tab=` (`drawn`, `hub/server/pagedraw.mjs`, `hub/docs/PAGES.md`) | `hub/tools/pagedraw-test.mjs`, `hub/tools/pages-test.mjs`, `apps/desktop/tools/pages-test.mjs` | missing | done | done | done |
| PAGE-003 | Edits go to the hub field by field, against the hash the screen was drawn from; "changed since your copy" when it moved | hub `POST /api/pages/item/set`, `toggle`, `create` | `hub/tools/pages-test.mjs`, `apps/desktop/test/pages.test.ts` | missing | done | done | done |
| PAGE-004 | A page file with a mistake shows its last good version under the problem, with Open file and Ask Claude to fix | hub `GET /api/pages/page`, `POST /api/pages/ask` (fix) | `apps/desktop/tools/pages-test.mjs` | missing | done | done | done |
| PAGE-005 | A project's page's buttons stay off until the person trusts it | hub `POST /api/pages/trust` | `hub/tools/pages-test.mjs` | missing | done | done | done |
| PAGE-006 | A page's button types into a session only once approved; a run always goes through approve and run, its card headed with the page and the button, never as an agent's | hub `POST /api/pages/ask`, `approve`, `dismiss`, `run`; the card's heading: `cpwords.mjs` with the page run, also in `POST /api/checkpoints/words` | `hub/tools/pages-test.mjs`, `apps/desktop/tools/pages-test.mjs` | missing | done | done | done |
| PAGE-007 | Customize a shipped page into your own copy | hub `POST /api/pages/customize` | `hub/tools/pages-test.mjs` | missing | done | done | done |
| PAGE-008 | A page never runs script or loads a remote picture; its pictures come from the hub | hub `GET /api/pages/img` | `hub/tools/pages-test.mjs` | missing | done | done | done |
| PAGE-009 | On a phone: a tap opens a note as a sheet, a long press offers Move to (the note pressed found in the lanes the hub drew), a round button makes a new one | client; hub `GET /api/pages/page` (`drawn` lanes) | manual: `apps/phone/tools/preview.mjs` | n/a | n/a | done | done |
| PAGE-010 | The Rules page: rules from project memory to save or put off, and repeated asks to make into rules | hub `GET /api/rules`, `/api/rules/repeats`; `POST /api/rules/:id`, `/api/repeats/:id` | `hub/tools/rules-repeats-test.mjs` | missing | done | done | done |

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
| ALERT-001 | The bell in the sidebar's foot, lit while something needs you, opens Alerts in the window | client | RC-25 | missing | done | n/a | n/a |
| ALERT-002 | The Alerts page: on or off, the channel in use, the last one sent, Send a test | hub `GET /api/alerts/setup`; `POST /api/alerts/test`, `switch` | RC-27, `hub/tools/alerts-test.mjs` | missing | done | n/a | n/a |
| ALERT-003 | Mac notifications posted by the app as "Ravenry"; the hub hears whether macOS showed each; a click opens its session | hub event `notify`; `POST /api/alerts/desktop/result` | RC-27, `hub/tools/desktop-notify-test.mjs` | missing | done | n/a | n/a |
| ALERT-004 | macOS not allowing them: Alerts says so, with a button to System Settings, Notifications | client | RC-27 | missing | done | n/a | n/a |
| ALERT-005 | Telegram, a Discord or Slack webhook, or ntfy (its QR, Copy the link, New topic): set up, Use it, Turn off | hub `POST /api/alerts/telegram`, `webhook`, `ntfy/*`, `done`, `switch` | `hub/tools/alerts-test.mjs`, `hub/tools/push-ntfy-e2e.mjs` | missing | done | n/a | n/a |
| ALERT-006 | Pair your phone, from Alerts | client | RC-24 | missing | done | n/a | n/a |
| ALERT-007 | Phone push through UnifiedPush, each alert encrypted for that phone; with no distributor, the held connection | hub `POST /api/phone/push`; Android `Push` | `apps/android/app/src/test/java/dev/ravenry/app/WebPushTest.kt` | n/a | n/a | done | n/a |
| ALERT-008 | Phone alerts answered from the shade: the answers, Run with a fingerprint, a reply line, Undo a decision, Open | hub alert messages (`hub/server/push.mjs`); Android `Notifier`, `ActionReceiver` | `apps/android/app/src/test/java/dev/ravenry/app/AlertsTest.kt` | n/a | n/a | done | n/a |
| ALERT-009 | A pick's pictures side by side in its alert | Android `Pictures` | `apps/phone/tools/pick-shots.mjs` | n/a | n/a | done | n/a |
| ALERT-010 | While paired, the connection held in the background, with a quiet "Linked to" notification counting the sessions | Android `ConnectionService`; hub `GET /api/events` | none yet | n/a | n/a | done | n/a |

### Settings

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SET-001 | The Settings window (Cmd+, on the Mac, Ctrl+, under Edit on Linux) with Appearance, Behavior and Skills | client | `apps/desktop/tools/settings-shots.mjs`, RC-17 (settings) | missing | done | n/a | n/a |
| SET-002 | The settings file: written whole and at once; a wrong value back to its default and logged; a broken file kept aside; migrations keep the old file | client (`apps/desktop/src/shared/settings.ts`, `apps/desktop/src/main/settingsstore.ts`) | `apps/desktop/test/settings.test.ts` | missing | done | n/a | n/a |
| SET-003 | A change applies at once in every window | client | RC-17 (settings) | missing | done | n/a | n/a |
| SET-004 | Skills: for Claude Code and for Codex, the hooks and the Ravenry skill each installed or removed; removing leaves the files byte for byte as they were. With no board running, the rows wait for it ("Needs Ravenry's board running") | hub `POST /api/setup/hooks`, `GET` and `POST /api/setup/skills` (`hub/server/skills.mjs`) | RC-21 (D), `hub/tools/setup-skills-test.mjs` | missing | done | n/a | n/a |
| SET-005 | Hand-off: on or off, the line, the ceiling, the context window, a fresh session after | hub `GET` and `POST /api/settings/handoff` | `hub/tools/handoff-hook-test.mjs` | missing | missing | missing | missing |
| SET-006 | Start new sessions with Claude Code or Codex, and the Codex model to fall back on | hub `GET` and `POST /api/settings/assistant` | `hub/tools/start-with-test.mjs` | missing | partial | missing | missing |
| SET-007 | Where new projects go | hub `GET` and `POST /api/settings/projects-root` | `hub/tools/projects-root-test.mjs` | missing | missing | n/a | n/a |
| SET-008 | The phone's settings: the computer it is paired with and whether it answers, push on or off, the held connection on or off, Run always asks for a fingerprint, Sign out | hub `GET /api/phone/me`, `POST /api/phone/unpair`; shell `push.*`, `connection.*` | none yet | n/a | n/a | done | partial |

### Onboarding and Learn

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ONB-001 | The first launch reaches a working session with no terminal command: folders that look like projects (or choose or drop one), the assistants found and signed in, Start | hub `GET /api/setup/start` (`hub/server/firstlaunch.mjs`), `POST /api/sessions/start`. Gap: while the board is not up yet, the desktop runs `hub/server/firstlaunch.mjs` in process (IPC `local:start`, without the board's folders) and starts the assistant in a pane of its own; a native client shows Choose a folder and a plain shell until the board answers | `apps/desktop/tools/first-run.mjs`, RC-2, `hub/tools/setup-skills-test.mjs` | missing | done | n/a | n/a |
| ONB-002 | Step 2, before the session: "Let Claude work with Ravenry", the hooks and the skill ticked, Set them up or Not now | hub `POST /api/setup/hooks`, `GET` and `POST /api/setup/skills`; answered once per assistant: hub `GET` and `POST /api/onboarding` (`setup`) | RC-21 (A2, B) | missing | done | n/a | n/a |
| ONB-003 | One-time hints under the first Needs-you row, the first pane an agent opens and the first pick, each with Learn more and an x, inside its region from 1440 x 900 down to 720 x 480 | dismissed: hub `GET` and `POST /api/onboarding` (`hints`, `hub/server/onboarding.mjs`); where it sits: client | RC-21 (F), `hub/tools/onboarding-test.mjs` | missing | done | missing | missing |
| ONB-004 | Learn Ravenry, from the ? and Help: seven cards with a play mark, each ticked once used, no progress bar, never opened by itself | ticks: hub `GET` and `POST /api/onboarding` (`learn`); the cards: client | RC-21 (E), `hub/tools/onboarding-test.mjs` | missing | done | missing | missing |
| ONB-005 | Try it opens a session with its message ready in the input, not sent | client; hub `POST /api/sessions/start` | RC-21 (E) | missing | done | missing | missing |
| ONB-006 | Relaunched, or in a second client: no hint comes back, Learn stays closed, no step 2 again. What the app's store held before is sent to the board once; a mark made while the board is not up waits in the store until it answers | hub `GET` and `POST /api/onboarding` (`hub/server/onboarding.mjs`); client `apps/desktop/src/renderer/onboarding.ts` (the store's marks the board lacks) | RC-21 (F/A2), `hub/tools/onboarding-test.mjs`, `apps/desktop/test/onboarding.test.ts` | missing | done | n/a | n/a |
| ONB-007 | While macOS asks whether Ravenry may read a folder, the window says so and where to turn it on; a refused folder is named | hub (`hub/server/access.mjs`), state (waitingFor) | `apps/desktop/tools/access-shots.mjs`, `hub/tools/access-wait-test.mjs` | missing | done | n/a | n/a |
| ONB-008 | The switch from the npm board: what was found and what happens to each, each step as it is done, and the way back | hub (`hub/server/npmswitch.mjs`); client `apps/desktop/src/main/npmswitch.ts` | RC-6, `apps/desktop/test/npmswitch.test.ts` | missing | done | n/a | n/a |

### Phone pairing

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PHONE-001 | Phone access: a switch on the computer, off until turned on (pairing turns it on); off, the phone port is closed and a request from the Wi-Fi gets 403 | hub `POST /api/phone/access` | `hub/tools/phone-access-test.mjs` | missing | done | n/a | n/a |
| PHONE-002 | The pairing QR code: the hub's addresses, port, key pin and a one-time code, with the code and its check number to type instead | hub `GET /api/phone` | `hub/tools/phone-app-test.mjs` | missing | done | n/a | n/a |
| PHONE-003 | Pair by the QR code, by the `ravenry://pair` link (asked first), or by the typed code after comparing the check number | hub `POST /api/phone/pair` | `apps/android/app/src/test/java/dev/ravenry/app/PairingTest.kt` | n/a | n/a | done | n/a |
| PHONE-004 | TLS that takes only the pinned key, whoever signed it; the token and the pin kept encrypted on the phone | Android `HubClient`, `Store` | `apps/android/app/src/test/java/dev/ravenry/app/PinTest.kt` | n/a | n/a | done | n/a |
| PHONE-005 | Every request of the page goes through the shell; the page never holds the token | Android bridge (`ravenryShell`) | `apps/android/app/src/androidTest/java/dev/ravenry/app/BridgeTest.kt` | n/a | n/a | done | n/a |
| PHONE-006 | Devices: every phone signed in, renamed with a click, Sign out; New key signs every phone out | hub `GET /api/phone/devices`; `POST /api/phone/devices/rename`, `revoke`, `/api/phone/new-key` | `hub/tools/phone-app-test.mjs` | missing | done | n/a | n/a |
| PHONE-007 | An older phone keeps working against a newer hub (the link's, the push's, the bridge's and the API's versions) | hub `GET /api/phone/hello` | `hub/tools/phone-app-test.mjs` | n/a | n/a | done | done |

### Machines

| ID | Behaviour | Logic | Acceptance | macOS | Electron | Android | Phone web |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MACH-001 | The Machines page, from the server mark in the sidebar's foot (a dot while one needs you): each machine, its state, its ravenryd beside this app's | hub `GET /api/machines` | `apps/desktop/tools/machines-shots.mjs`, `hub/tools/machines-test.mjs` | missing | done | partial | partial |
| MACH-002 | Add a machine from the hosts in `~/.ssh/config`, or remove one | hub `POST /api/machines/add`, `remove` | `hub/tools/machines-test.mjs` | missing | done | n/a | n/a |
| MACH-003 | Install, Update or Uninstall ravenryd and the hooks over ssh with no sudo, each step shown with what it did or why it stopped | hub `POST /api/machines/install`, `uninstall` | `hub/tools/remote-install-test.mjs`, `apps/desktop/tools/machines-shots.mjs` | missing | done | n/a | n/a |
| MACH-004 | Retry a machine that did not answer | hub `POST /api/machines/retry` | `hub/tools/machines-test.mjs` | missing | done | n/a | n/a |
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
| A11Y-006 | Dark and light on every screen, following the system, in the shared colours | `shared/tokens/tokens.json` (dark and light); client picks the theme | RC-9, RC-10, RC-19, RC-25, `apps/desktop/test/shared.test.ts` | missing | done | done | done |
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
- `apps/desktop/src/shared/settings.ts` and `apps/desktop/src/main/themeimport.ts`: the settings' keys and the theme import. To `shared/` as data, so every client reads the same keys and themes.
- `apps/desktop/src/renderer/app.ts` swapMoved() and moveStates(): which pane a move replaced. The hub's move answer should say it.
- Left after the moves of 2026-11-09 (each in its row): the first launch runs `hub/server/firstlaunch.mjs` in the app while the hub is not up yet (ONB-001); a checkpoint the desktop hears only from its own daemon has no words until the hub words it, so with the hub down its card is empty (PANEL-015); most strings are still inline in each client, the type sizes, radii and gaps are tokens no rule uses yet, and `hub/public/app.css` keeps its own colours (section 1); terminal themes and icons are not in `shared/` yet.

Moved to the hub on 2026-11-09: the sidebar's sections, rows, order and counts (`state.sidebar`, `hub/server/sidebar.mjs`), what a checkpoint and its row mark say (`cp.words`, `hub/server/cpwords.mjs`, `POST /api/checkpoints/words`), the brief's Next items (`brief.nextParts`, `hub/server/briefnext.mjs`), a project's gallery, newest first (`brief.gallery`, `hub/server/pictures.mjs` galleryList(), moved from the desktop's inapp.ts pictures() for the native Mac app; the desktop still works it out itself), a page's filters, sorts, groups and counts (`drawn` in `GET /api/pages/page`, `hub/server/pagedraw.mjs`), the first launch's folders and assistants (`GET /api/setup/start`), the skill's install and remove (`GET` and `POST /api/setup/skills`), the onboarding state (`GET` and `POST /api/onboarding`), and the shared strings and tokens (`shared/`, `shared/README.md`).

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
