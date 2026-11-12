// One Ravenry per data folder, as the Electron app's
// requestSingleInstanceLock (main.ts): a second start (`open -n`, the
// executable run by hand, a second copy of the app) finds the first one
// holding <data>/app.lock, asks it to come to the front and quits, with a
// line in app.log. Two apps on one data folder would both set up the hub
// service, both write window.json and both answer the same cards.
//
// The lock is flock(2) on the file, so it goes with the process however it
// ends; the file keeps the holder's pid for the log. The first one comes to
// the front on a distributed notification (`dev.ravenry.app.front`, its
// object the data folder), as a Dock click would bring it: a window again
// if none is open, and NSApp activated.
//
// A development build (no build.json: it sets nothing up) and a window off
// every screen (the bench, the self-tests) take no lock, unless a test asks
// (RAVENRY_TEST_SINGLE=1, the twin only: Gate drops it in a release); then
// the first one does what a Dock click does (a window again if none is
// open, restored if minimised, ordered in front) but is not activated, its
// window stays off every screen, never taking the focus from the person's
// screen, and app.log says what it did (scripts/singlecheck.mjs).

import AppKit

enum SingleInstance {
    static let note = Notification.Name("dev.ravenry.app.front")
    private static var fd: Int32 = -1

    static var dataFolder: String {
        let e = ProcessInfo.processInfo.environment
        if let d = e["RAVENRY_DESKTOP_DATA"], !d.isEmpty { return d }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Ravenry").path
    }

    static var test: Bool { ProcessInfo.processInfo.environment["RAVENRY_TEST_SINGLE"] == "1" }

    /// Before the app runs: the lock taken, or this launch ends here.
    static func atLaunch(offscreen: Bool) {
        guard (AppInstall.shared.packaged && !offscreen) || test else { return }
        let dir = dataFolder
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let path = dir + "/app.lock"
        let f = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        guard f >= 0 else { return }
        if flock(f, LOCK_EX | LOCK_NB) == 0 {
            fd = f
            ftruncate(f, 0)
            let s = "\(getpid())\n"
            _ = s.withCString { write(f, $0, strlen($0)) }
            return
        }
        var buf = [CChar](repeating: 0, count: 32)
        _ = pread(f, &buf, 31, 0)
        let other = String(cString: buf).trimmingCharacters(in: .whitespacesAndNewlines)
        close(f)
        AppInstall.shared.log("launch: another Ravenry with this data folder runs (pid \(other.isEmpty ? "unknown" : other)): it comes to the front, and this one quits")
        DistributedNotificationCenter.default().postNotificationName(note, object: dir, userInfo: nil, deliverImmediately: true)
        exit(0)
    }

    /// The first one, told a second one started: to the front, as a Dock click.
    static func listen(_ app: AppDelegate) {
        guard fd >= 0 else { return }
        DistributedNotificationCenter.default().addObserver(forName: note, object: dataFolder, queue: .main) { [weak app] _ in
            guard let app else { return }
            // As a Dock click: a window again if none is open, restored if minimised, in front.
            let had = app.windows.count
            _ = app.applicationShouldHandleReopen(NSApp, hasVisibleWindows: !app.windows.isEmpty)
            let w = (app.current ?? app.windows.first)?.window
            if let w, w.isMiniaturized { w.deminiaturize(nil) }
            if test && app.options.offscreen {
                // A test off every screen: the same steps, but the app is not activated and its window
                // stays where it is drawn, off every screen (never the person's focus or screen).
                w?.orderFront(nil)
                let what = w.map { "\($0.isVisible ? "visible" : "not visible")\($0.isMiniaturized ? ", minimised" : ""), ordered in front of the app's windows" } ?? "no window"
                AppInstall.shared.log("launch: a second Ravenry started and quit; this one comes to the front (off every screen in a test, not activated): \(had == 0 ? "a window made again" : "its window") \(what), \(app.windows.count) window(s)")
                return
            }
            AppInstall.shared.log("launch: a second Ravenry started and quit; this one comes to the front")
            NSApp.activate(ignoringOtherApps: true)
            w?.makeKeyAndOrderFront(nil)
        }
    }
}
