# Presses keys in one iTerm2 session through iTerm2's Python API, for the
# board's iTerm2 adapter (server/iterm.mjs): the arrow keys that move a
# Claude Code menu's selection (server/choose.mjs).
#
# Usage: python3 iterm-keys.py <session unique ID> <key> [<key> ...]
# Keys: up, down, enter. Exit 0 when sent, 3 when no session has that id,
# 2 on a bad argument, 1 when iTerm2 could not be reached.
#
# The iterm2 package authenticates itself through AppleScript ("request
# cookie and key"), so this needs the Python API turned on in iTerm2
# (Settings > General > Magic) and nothing else.
import sys

SEQ = {"up": "\x1b[A", "down": "\x1b[B", "enter": "\r"}


def main():
    if len(sys.argv) < 3 or any(k not in SEQ for k in sys.argv[2:]):
        sys.stderr.write("usage: iterm-keys.py <session id> up|down|enter ...\n")
        return 2
    try:
        import iterm2
    except ImportError:
        sys.stderr.write("the iterm2 package is missing: run node tools/install-iterm.mjs\n")
        return 1
    sid, keys = sys.argv[1], sys.argv[2:]
    result = {"code": 0}

    async def run(connection):
        app = await iterm2.async_get_app(connection)
        session = app.get_session_by_id(sid)
        if session is None:
            result["code"] = 3
            return
        for k in keys:
            await session.async_send_text(SEQ[k], suppress_broadcast=True)

    try:
        iterm2.run_until_complete(run, retry=False)
    except Exception as e:  # iTerm2 not running, API off, refused
        sys.stderr.write("could not reach iTerm2: %s\n" % (e,))
        return 1
    if result["code"] == 3:
        sys.stderr.write("no iTerm2 session %s\n" % sid)
    return result["code"]


sys.exit(main())
