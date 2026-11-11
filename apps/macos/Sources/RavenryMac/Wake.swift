// After the Mac sleeps and wakes (A11Y-012), the window does what it was
// doing: the hub's stream is opened again at once (a full state with it,
// so nothing shown is from before the sleep, and a hub that started again
// meanwhile, on another port too, is found), the runtime folder is read for
// daemons that came or went, and every pane on show opens its render stream
// again, so it draws the daemon's screen of now, never a blank or an old one.
//
// Neither the Electron app nor this one did anything at a wake before: the
// stream to a hub that had gone was retried at the backoff's 10 s, and a
// pane showed what it had.
//
// A test off every screen asks for a wake through the report's command
// file (main.swift report), as macOS's own notification would.

import AppKit

extension AppDelegate {
    func watchWake() {
        let nc = NSWorkspace.shared.notificationCenter
        nc.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { _ in
            AppLog.write("sleep: the Mac goes to sleep")
        }
        nc.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.woke()
        }
    }

    /// What a wake does; also run by a test (the report's "wake" command).
    func woke() {
        var redrawn = 0
        for w in windows where !w.closing {
            w.hub.reconnectNow("the Mac woke")
            for b in w.ws.boxes.values where b.term.live {
                b.term.pause()
                b.term.resume()
                redrawn += 1
            }
        }
        daemons?.scanNow()
        AppLog.write("wake: the hub read again, the daemons looked for, \(redrawn) pane\(redrawn == 1 ? "" : "s") on show drawn again")
    }
}
