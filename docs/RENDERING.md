# The render stream

A client that draws a terminal itself (the native Mac app, and later a
Linux or Windows one) does not run a terminal emulator of its own. The
daemon's screen, libghostty-vt inside `ravenryd`, is the only screen: the
client asks for a pane's screen as **frames of changed rows** and draws
them, and sends the person's keys and mouse as **events** that the daemon
encodes for the program. There is never a second screen to drift from the
first, which is what made the first native spike (Ghostty's own renderer
fed the pane's bytes) blink and leave prompt debris on a resize.

```
  client (Swift, Metal)                    ravenryd (Go)
  +---------------------------+            +-------------------------------+
  | rows it was sent, cursor, |  frames    | pane: pty, libghostty-vt      |
  | modes, colours            |<-----------|  render state -> changed rows |
  | glyph atlas, GPU quads    |            |  frame pacing, acks           |
  |                           |  events    |  key, mouse, paste encoders   |
  | NSTextInputClient, mouse  |----------->|  (Kitty keyboard, SGR mouse,  |
  | selection, copy           |            |   bracketed paste)            |
  +---------------------------+            +-------------------------------+
```

Everything except drawing and capturing input lives in the daemon, in Go,
so a new client only implements the parts listed under
[What a client implements](#what-a-client-implements).

The messages are part of protocol v1 (PROTOCOL.md, section 4, "The render
stream"); this document is the frame format and what a client does with
it. The Go reference decoder is `daemon/internal/rframe`.

## Messages

| Message | What |
| --- | --- |
| `pane.render` {pane, cols?, rows?, fps?, window?, keybinds?} | Starts a render stream on a new channel, resizing the pane first when cols and rows are given. Result: `channel`, and `format`, the frame format's version (1). `keybinds`: the key bindings for the stream's keys (below, "Key bindings"). |
| binary frame, kind 4 | One render frame on that channel (below). The header's mark is the pane's output position the frame shows (0 from a daemon before 0.1.36). |
| `ack` {channel, frame} | The client drew the frames up to `frame` (a frame's `seq`). |
| `pane.resize` {pane, cols, rows} | The client's grid size changed. |
| `render.scroll` {channel, offset} | Show the screen `offset` rows up into the scrollback; 0 is the live screen. |
| `render.input` {channel, events} | Keys, mouse, committed text, paste, focus, the wheel, selection gestures, dropped files (below). |
| `render.text` {channel, from, to, rect?} | The text between two cells in screen coordinates, as a copy. |
| `render.copy` {channel} | The pane's selection, as a copy. |
| `render.find` {channel, needle, step?, case_sensitive?, regex?} | Find in the screen and scrollback, in any case, in the needle's case, or a regular expression; the frames carry the matches. |
| `render.link` {channel, at} | The link on a cell: a hyperlink (OSC 8) or a URL in the text. |
| `pane.unsubscribe` {channel} | Ends the stream. |

## Frames

A frame is everything that changed since the frame before it on the same
stream. Integers are big-endian.

### Header (30 bytes)

| Bytes | Field | |
| --- | --- | --- |
| 0 | format | 1. A client refuses a frame of another version. |
| 1 | flags | 1 full: the frame carries every row; rows it does not list are empty. 2 held: the program holds the screen (synchronized output) and these rows are the last frame it finished. |
| 2 to 5 | seq | The frame's number on this stream, from 1. The client acknowledges it. |
| 6 to 7 | cols | The grid's size. When it differs from the last frame's, the frame is full. |
| 8 to 9 | rows | |
| 10 to 13 | history | Rows of scrollback above the screen. |
| 14 to 17 | offset | How many rows up from the bottom the rows are (0: live). |
| 18 to 19 | cursor x | On the rows of this frame, 0-based. |
| 20 to 21 | cursor y | |
| 22 | cursor flags | 1 in view (the cursor is on these rows; not when scrolled away), 2 visible (the program shows it), 4 blink, 8 wide tail (it sits on the second half of a wide character), 16 password (the program reads a password; a client shows its secure input). |
| 23 | cursor style | 0 block, 1 bar, 2 underline, 3 hollow block. |
| 24 to 25 | modes | 1 mouse (the program reports clicks and the wheel: send them, do not select), 2 mouse drag (motion with a button down), 4 mouse motion (all motion), 8 bracketed paste, 16 alternate screen (no scrollback to scroll), 32 focus reports, 64 application cursor keys, 128 alternate scroll (mode 1007: on the alternate screen the wheel is arrow keys). |
| 26 to 29 | bell | How many times the bell rang in this pane; a client rings when it grows. |

### Sections

After the header come sections until the end of the payload: a tag (1
byte), a length (4 bytes), then that many bytes. A client skips a tag it
does not know.

| Tag | Section | Sent |
| --- | --- | --- |
| 1 | title | UTF-8, the title the program set (OSC 0, 2). In a full frame and when it changes. |
| 2 | colours | 1 byte of flags (1 foreground, 2 background, 4 cursor colour set by the program, OSC 10, 11, 12), the three colours (3 bytes each, RGB, meaningful when set), a count (2 bytes), then that many changed palette entries: index (1), RGB (3). Only what the program changed (OSC 4); the client keeps its own theme for the rest. In a full frame and when they change. |
| 3 | links | A count (2), then entries: id (2), length (2), URI (UTF-8). The hyperlinks (OSC 8) the rows of this frame use that this stream did not send before. A client keeps them by id for the stream's life. |
| 4 | rows | A count (2), then rows: y (2), flags (1: bit 1 the row soft-wraps onto the next), length (4), the row's data. |
| 5 | selection | Flags (1: 1 there is a selection, 2 it is a block), then a range. In a full frame and when it changes. |
| 6 | find | Flags (1: 1 a search runs, 2 the selected match is on these rows), the count of matches (4), the selected one's index from the newest (4, -1 for none), the selected match's range when flag 2 is set, then a count (2) and the ranges of the other matches on these rows. In a full frame and when it changes, while a search runs and once when it ends. |

A range is two cells in screen coordinates (row 0 is the oldest row of
the scrollback), inclusive, in reading order: x0 (2), y0 (4), x1 (2), y1
(4). A block covers columns x0 to x1 of each row; otherwise the range runs
from x0 on its first row to x1 on its last, whole rows between.

### A row's data

Runs of cells that share a style, from column 0. The cells after the last
run are empty, in the default style.

A run: its style (16 bytes), a cell count (2), then the cells.

The style:

| Bytes | |
| --- | --- |
| 0 to 3 | foreground: kind (0 default, 1 palette, 2 RGB), then the index or R, G, B |
| 4 to 7 | background, the same way |
| 8 to 11 | underline colour, the same way (0: the foreground) |
| 12 to 13 | attributes: 1 bold, 2 faint, 4 italic, 8 blink, 16 inverse, 32 invisible, 64 strikethrough, 128 overline; bits 8 to 10 the underline: 0 none, 1 single, 2 double, 3 curly, 4 dotted, 5 dashed |
| 14 to 15 | hyperlink id, 0 for none |

A cell is one byte, then its text:

- `0`: empty (a space, in the run's background).
- `0xff`: the second half of a wide character, drawn by the cell before it.
- otherwise the low 7 bits are the length of the cell's UTF-8 text (a
  whole grapheme cluster: a base character and its combining marks,
  variation selectors, an emoji sequence), and bit 8 says the character is
  wide (two cells; the next cell is `0xff`).

Palette colours are indexes, not resolved colours: the client resolves
them with its theme and the frame's changed entries, so a light or dark
theme on the client is never overridden by the daemon's defaults.

## How the daemon paces frames

- **Only what changed.** libghostty-vt's render state reports the rows
  that changed since the last read; the daemon encodes those and compares
  them with what it last encoded, so a row whose bytes are the same is not
  sent. Each stream remembers what it was sent, row by row.
- **At the client's rate.** At most `fps` frames a second (`pane.render`,
  default 60). A change after an idle moment goes out at once, so a
  keystroke's echo is never held for a tick.
- **Acknowledged.** At most `window` frames (default 2) are sent and not
  yet acknowledged. A client that draws slower than output arrives gets
  fewer, later frames, each with everything that changed, and the pane is
  never slowed. A client acknowledges a frame once it has drawn it (or
  dropped it for a newer one).
- **Whole.** A frame never shows a program's synchronized update half
  done (mode 2026): during one the daemon keeps sending the last frame the
  program finished, up to a second from its start, as Ghostty does. A
  resize does not end it (libghostty's resize does, and Claude Code,
  which erases every row after a SIGWINCH and draws them again over 50
  to 150 ms, showed blank or a few rows through a drag): at the new size
  the frame is that last finished one, its rows cut at the new width and
  its last rows kept when the screen got shorter (`TestRenderDragSyncRedraw`).
- **Resize.** On `pane.resize` the daemon resizes the screen and the pty
  together; a shell at its prompt at every step of a drag, any other
  program once per pause of it (below). When the shell is at a prompt (OSC 133, which Ravenry's shell
  integration marks with `redraw=1`), the resize clears the prompt for the
  shell to draw it again (a libghostty patch,
  `daemon/patches/ghostty-prompt-clear-top.patch`): from the prompt's
  first row, before the reflow, and it puts the cursor where the shell's
  redraw, which moves up the rows it drew the prompt on, lands on that
  first row. So at any width no row of an old prompt stays on the screen
  or goes into the scrollback (a command line taller than the screen
  used to leave zsh's ">...." rows there), and the output above the
  prompt stays. A command line taller than the screen, which zsh then
  draws as ">...." and its end, keeps its start in the scrollback, once:
  the command line the shell drew whole is laid out again at each new
  width (as zsh counts rows: a line that fills the width takes one more),
  the rows zsh will not draw stay above the screen, and at the next
  resize they and zsh's end of it are one command line again; when it
  fits once more, zsh draws it all and nothing of it stays above. Frames are held until the shell has drawn it: its prompt
  mark and 4 ms of quiet, or 30 ms while it is most likely still writing
  (its last read filled the pty's buffer, 1 KiB on macOS, or its output
  stopped at the prompt while the command line has text, which zsh
  writes apart), at most 250 ms. A size asked for during that redraw, or
  while the shell is still writing, waits for its end: a shell resized
  in the middle of its redraw counts its prompt's rows on a screen that
  changed under it and leaves pieces of the old prompt behind.
- **A program's resize.** Any other program (not a shell at its prompt:
  Claude Code, an editor, a build) is told its new size once per pause
  of a drag, not at each step (`daemon/internal/pane/coalesce.go`).
  Claude Code redraws once for every size it is told, in order, 100 to
  250 ms after it, and places its words at absolute columns
  (`ESC[<col>G`). Resized at every step, a redraw laid out for a width
  the drag had already left landed on a narrower screen: every column
  past the margin went to the last one, a column of single letters down
  the right edge and the rest mostly empty (Simon on 0.1.31: "still
  blanks, and vertical bars of characters too now"; 17 of 180 frames of
  his recorded drag), and widening showed a narrow layout in a wide pane
  for 300 to 400 ms. Resizing the screen at each step without telling
  the program breaks it another way: its cursor moves, relative to rows
  the reflow moved, land on the wrong rows and leave garbage in the
  scrollback. Ghostty never parses a program's output against a size
  the program was not told: it sets the pty's size and the grid's
  together, under one lock, and coalesces resizes 25 ms apart
  (`src/termio/Thread.zig`, `Termio.zig` resize); kitty waits for the
  resizes to stop (about 0.1 s) and then does both. So:
  - A resize on its own (a split, a font change, a window snapped, a
    drag's first step) goes at once: the screen and the pty together.
  - During a drag (a size within 50 ms of the last one asked) the screen
    and the program's size stay as they are; the frames go out at the
    size asked, the screen cut or padded to it (its rows cut at a
    narrower width, padded at a wider one; a shorter view shows the last
    rows, the cursor moved up with them; a taller one is padded below).
  - When the drag pauses (no step for 80 ms) and at its end, the screen
    and the pty are resized once, together, to the latest size asked.
    A further size goes only once the program has drawn itself at that
    one: it ended a synchronized update begun after the resize that
    erased at least half the rows (Claude Code's redraw erases every
    row; its spinner's updates erase none), or its output has been quiet
    300 ms, or a second has passed. Always the latest size asked, never
    one the drag has left.
  - A program that draws with synchronized output is shown as it was,
    cut or padded to the new size, until that redraw (the screen's
    render state frozen, `vt` Freeze), so the reflow of its old layout is
    never shown either. Any other program's redraw after a resize is
    held until it has been quiet 6 ms, at most 100 ms.

  `TestRenderDragClaude` (testprog's redraw drawing as Claude Code does,
  idle and with a spinner line updated 10 times a second, a width drag
  at 8 to 16 ms steps with a 300 ms pause): on 0.1.31, 15 to 24 of 131
  to 137 frames with bars and 90 to 98 not a screen the program drew,
  about 100 scrollback rows of garbage; with this, none. The reflow
  itself is libghostty-vt's, over the whole scrollback: about 2.5 ms for
  7800 rows, now once per pause rather than at every step. The client
  meanwhile draws the frame it has at the new size; it never sees a
  cleared prompt, nor half a redraw.

## Key bindings

Some keys a terminal sends as fixed bytes for the shell's line editor
rather than encoding them, because that is what people on the platform
expect: on a Mac, Cmd+Left to the start of the line. The tables live in
the daemon (`daemon/internal/vt/keybinds.go`), so every client of a
platform sends the same bytes and none types them again; a client names
its table in `pane.render` (`keybinds`). A binding applies to a press or
a repeat with exactly its modifiers (Caps Lock and Num Lock aside), even
when the program asked for the Kitty keyboard protocol, as Ghostty's do.
A setting may later replace single rows; the tables are the defaults.

`macos`, Ghostty's macOS defaults (its `src/config/Config.zig`, "Natural
text editing", at the libghostty pin) and so Rex's, and what the
Electron app sends (`apps/desktop/src/renderer/terminal.ts`):

| Key | Sends | At a shell prompt |
| --- | --- | --- |
| Cmd+Left | `^A` | the start of the line |
| Cmd+Right | `^E` | the end of the line |
| Cmd+Backspace | `^U` | deletes to the start of the line (zsh: the whole line) |
| Option+Left | `ESC b` | a word left |
| Option+Right | `ESC f` | a word right (zsh: to the next word's start) |
| Cmd+Delete (forward) | `^K` | deletes to the end of the line (Ravenry's, not Ghostty's) |
| Option+Delete (forward) | `ESC d` | deletes the next word (Ravenry's) |
| Shift+Enter | LF | a new line in Claude Code and Codex; Enter in a shell (the Electron app's) |

Not bound, because the encoder already gives what is expected:
Option+Backspace is `ESC DEL`, the word before the cursor; Ctrl+Left and
Ctrl+Right are `CSI 1;5D` and `CSI 1;5C`, as in Ghostty, and Ravenry's
zsh and bash integrations bind those to a word left and right where the
person's own files left them unbound (zsh binds neither and typed
`;5D`). Ghostty's Cmd+Up and Cmd+Down jump to the previous or next
prompt, a client's action, not bytes: not done yet. `daemon/internal/server/keybinds_test.go`
checks each at a zsh prompt.

## What a client implements

These are the parts that are the platform's, and nothing else:

1. **The connection.** WebSocket over the daemon's unix socket (PROTOCOL.md
   section 1), `hello`, then `pane.render` with the grid size, the
   display's refresh rate as `fps` and a window of 2.
2. **The screen copy.** Apply each frame: on `full` (or a new size) clear
   the rows; replace each listed row; keep title, colours, links, cursor,
   modes. `rframe.Screen.Apply` is the reference.
3. **Drawing.** A glyph cache (one glyph per grapheme cluster, bold and
   italic faces, wide characters over two cells, colour emoji), cell
   backgrounds, glyphs, underline styles, strikethrough, the cursor in its
   style, the selection. Draw at the display's refresh, only when a frame
   came or the selection or cursor blink changed. Acknowledge each frame
   once drawn.
4. **Resize.** From the view's size and the cell size, the grid size; when
   it changes, `pane.resize`. Draw the rows you have at the new size at
   once (cut or padded); the reflowed rows follow. On a Mac, draw in step
   with the window during a live resize (CAMetalLayer with
   `presentsWithTransaction`), so the content never lags the frame.
5. **Keys.** Each key press, repeat and release as `render.input` key
   events: the physical key as a W3C `KeyboardEvent.code` (`KeyA`,
   `ArrowUp`, `Enter`, `F5`), the modifiers, the modifiers the layout used
   to make the text (`consumed`), the text, and the key's unshifted
   character. The daemon encodes them (legacy, application cursor keys,
   the Kitty keyboard protocol) for the program's modes. Text from an
   input method (dead keys, Japanese, emoji picker) is sent as `text` when
   committed; the marked text being composed is drawn by the client at the
   cursor and not sent.
6. **Mouse and wheel.** When `modes` has mouse, clicks (and motion, when
   asked) as `render.input` mouse events with the position and cell size
   in the client's units; the daemon encodes them (X10, SGR, SGR pixels).
   Every wheel or trackpad movement goes as a `wheel` event in rows (a
   trackpad's points divided by the cell's height, momentum included):
   the daemon decides, as Ghostty does, whether it goes to the program,
   becomes arrow keys on the alternate screen, or scrolls the view. The
   client draws a scrollbar from `history`, `offset` and `rows`.
7. **Selection and copy.** Without mouse reporting (or with Shift), a
   press, drags and the release as `select` events with the cell under
   the pointer in screen coordinates (the frame's `history - offset` is
   the screen row of the view's first row) and the pointer within the
   grid; Shift as `extend`, Option as `rect`. The daemon (libghostty-vt's
   selection gesture) decides what is selected, the frames say what it
   is (section 5), the client draws it, and `render.copy` reads it.
   `render.text` reads any other range.
8. **Find and links.** `render.find` with what the person typed, a
   step, and match case and regular expression when the person turned
   them on; the client draws the matches the frames carry (section 6).
   `render.link` on the cell under the pointer while the person holds
   the platform's link modifier: the client underlines from `from` to
   `to` and opens `uri` on a click.
9. **Paste.** `render.input` paste: the daemon brackets it when the
   program asked (mode 2004) and makes it safe otherwise. Files dropped
   on the view as `paths`; the daemon quotes them.
10. **Focus.** `render.input` focus true and false; the daemon reports it
   when the program asked (mode 1004).

A Linux client (GTK4 with a GL area, or a Vulkan surface) and a Windows
one (Direct3D 11 or 12 with DirectWrite for glyphs) implement the same
ten parts; none of them needs a VT parser, a key encoder, a mouse
encoder, a selection model, a search or a link detector.

The selection is the pane's (libghostty-vt keeps one per screen): two
clients that draw the same pane see the same selection. A search is the
stream's.

## What the daemon does not do yet

- Images (Kitty graphics, sixel) are not in frames.
- Blink: the cursor's blink flag is sent; text blink is an attribute the
  client may ignore.
- A program's clipboard writes (OSC 52) and desktop notifications are not
  forwarded on the render stream.
