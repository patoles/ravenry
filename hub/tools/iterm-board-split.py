# Puts the board page above the board's terminal in the Ravenry tab, for
# tools/open-in-iterm.mjs, through iTerm2's Python API (AppleScript can only
# split below).
#
# Usage: python3 -I iterm-board-split.py <terminal session id> <page profile> <tag> <terminal rows>
# Prints the page session's id. Exit 3 when the terminal session is gone,
# 1 when iTerm2 could not be reached.
import sys


async def shrink(connection, term_id, page_id, rows):
    # The terminal down to `rows` and the page up by the same height, so the
    # window keeps its size (a preferred size on the terminal alone shrinks
    # the window, measured on iTerm2 3.7.6). A browser session's grid is in
    # points, a terminal's in cells, so the height moves through the frames.
    import iterm2
    app = await iterm2.async_get_app(connection)
    term, page = app.get_session_by_id(term_id), app.get_session_by_id(page_id)
    if term is None or page is None or term.grid_size.height <= rows:
        return
    cell = term.frame.size.height / max(1, term.grid_size.height)
    move = cell * (term.grid_size.height - rows)
    per_point = page.grid_size.height / max(1, page.frame.size.height)
    term.preferred_size = iterm2.util.Size(term.grid_size.width, rows)
    page.preferred_size = iterm2.util.Size(page.grid_size.width, int(round(page.grid_size.height + move * per_point)))
    if term.tab is not None:
        await term.tab.async_update_layout()


def main():
    if len(sys.argv) != 5:
        sys.stderr.write("usage: iterm-board-split.py <session id> <profile> <tag> <rows>\n")
        return 2
    try:
        import iterm2
    except ImportError:
        sys.stderr.write("the iterm2 package is missing: run node tools/install-iterm.mjs\n")
        return 1
    sid, profile, tag, rows = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
    result = {"code": 0}

    async def run(connection):
        app = await iterm2.async_get_app(connection)
        term = app.get_session_by_id(sid)
        if term is None:
            result["code"] = 3
            return
        page = await term.async_split_pane(vertical=False, before=True, profile=profile)
        await page.async_set_variable("user.ravenryBoard", tag)
        await shrink(connection, term.session_id, page.session_id, rows)
        print(page.session_id, flush=True)

    try:
        iterm2.run_until_complete(run, retry=False)
    except Exception as e:  # iTerm2 not running, API off, refused
        sys.stderr.write("could not reach iTerm2: %s\n" % (e,))
        return 1
    if result["code"] == 3:
        sys.stderr.write("no iTerm2 session %s\n" % sid)
    return result["code"]


sys.exit(main())
