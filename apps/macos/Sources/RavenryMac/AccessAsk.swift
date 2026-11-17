// The app asks macOS for a folder itself.
//
// The hub is a background service (launchd), and macOS may never show its
// question to the person for it: on 2026-11-17, after an update changed
// the app's signature, the hub's question about ~/Documents had nobody to
// answer it. When the hub says a folder waits on macOS's answer, or was
// refused (state.access.blocked, or its 503 before its first state), this
// app, in front with its window on screen, reads that folder itself, off
// the main thread, so macOS asks the person over the window. macOS keeps
// one answer for Ravenry (bundle id dev.ravenry.app, the app's signature),
// and the hub's reads are attributed to the same app (its service runs
// Contents/MacOS/Ravenry, NodeRunner.swift), so the answer is the hub's
// too; the hub then asks again at once (POST /api/access/retry).
//
// Once per folder and state in a run. A test's run never reads the
// person's own protected folders: the folder is recorded instead.

import AppKit

enum AccessAsk {
    /// The folders asked, "<path>|<state>".
    static var asked: Set<String> = []
    /// A self-test: in front whatever the window says.
    static var testFront = false
    /// What a test's run read or would have read: "read PATH: ok|EPERM|..." or "skipped PATH".
    static var record: [String] = []

    /// A test's run: a self-test, a test's data or a window off every screen.
    static var isTest: Bool {
        let e = ProcessInfo.processInfo.environment
        return Outside.record != nil || e["RAVENRY_HOME"] != nil || e["RAVENRY_DESKTOP_DATA"] != nil || e["RAVENRY_OFFSCREEN"] == "1"
    }

    /// The person's own folders macOS protects (their account's home, whatever HOME says).
    static func personsOwn(_ path: String) -> Bool {
        guard let pw = getpwuid(getuid()), let h = pw.pointee.pw_dir else { return true }
        let home = String(cString: h)
        let roots = ["Documents", "Desktop", "Downloads", "Library/Mobile Documents"].map { "\(home)/\($0)" }
        return path.hasPrefix("/Volumes/") || roots.contains { path == $0 || path.hasPrefix($0 + "/") }
    }

    /// The folders to ask about in this state: { path, state } of each folder the hub leaves alone,
    /// waiting or refused (a slow one is allowed already: asking changes nothing; its words say what does).
    static func wanted(_ access: [String: Any]?, waitingPath: String?) -> [(path: String, state: String)] {
        var out: [(String, String)] = []
        for b in access?["blocked"] as? [[String: Any]] ?? [] {
            guard let p = b["path"] as? String, p.hasPrefix("/"), let s = b["state"] as? String, s == "waiting" || s == "denied" else { continue }
            out.append((p, s))
        }
        if let p = waitingPath, p.hasPrefix("/"), !out.contains(where: { $0.0 == p }) { out.append((p, "waiting")) }
        return out
    }

    /// Asks for each folder not asked yet in this state, when the app is in front with its window on
    /// screen; `retry` tells the hub once the read returned.
    static func ask(_ folders: [(path: String, state: String)], window: NSWindow?, retry: @escaping () -> Void) {
        guard !folders.isEmpty else { return }
        let front = testFront || (NSApp.isActive && (window?.isVisible ?? false) && (window?.occlusionState.contains(.visible) ?? false))
        guard front else { return }
        for f in folders {
            let key = "\(f.path)|\(f.state)"
            guard !asked.contains(key) else { continue }
            asked.insert(key)
            if isTest && personsOwn(f.path) {
                record.append("skipped \(f.path)")
                AppLog.write("access: a test's run does not ask macOS for \(f.path)")
                continue
            }
            AppLog.write("access: the hub has no answer for \(f.path) (\(f.state)); this app asks macOS itself")
            DispatchQueue.global(qos: .userInitiated).async {
                let t0 = Date()
                var how = "ok"
                do { _ = try FileManager.default.contentsOfDirectory(atPath: f.path) } catch {
                    let ns = error as NSError
                    let u = ns.userInfo[NSUnderlyingErrorKey] as? NSError
                    how = u.map { $0.code == Int(EPERM) ? "EPERM" : $0.code == Int(EACCES) ? "EACCES" : "error \($0.code)" } ?? "error \(ns.code)"
                }
                let ms = Int(Date().timeIntervalSince(t0) * 1000)
                DispatchQueue.main.async {
                    record.append("read \(f.path): \(how)")
                    AppLog.write("access: macOS answered this app for \(f.path) in \(ms) ms (\(how)); the hub asks again")
                    retry()
                }
            }
        }
    }
}
