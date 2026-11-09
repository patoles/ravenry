// A cheap, always-on log of the input events that went wrong on a
// person's screen before: each scroll event as the window and the view
// got it, what the view sent and what the daemon answered, and the view's
// offset in the frames after. One line an event, appended on a queue of
// its own so the main thread never waits on the disk.
//
// The file is ~/Library/Logs/RavenryMac/events.log, or the path in
// RAVENRY_MAC_EVENTS_LOG (the self-test's). A window off every screen
// (the bench, the self-test) logs only to that path, never to the
// person's Library.

import AppKit

final class EventLog {
    static let shared = EventLog()

    private let queue = DispatchQueue(label: "dev.ravenry.mac.eventlog")
    private var handle: FileHandle?
    private(set) var path: String?
    private let start = CACurrentMediaTime()

    /// Opens the log: the given path, or the person's when not offscreen.
    func open(offscreen: Bool) {
        let env = ProcessInfo.processInfo.environment["RAVENRY_MAC_EVENTS_LOG"]
        var p = env
        if p == nil && !offscreen {
            let home = FileManager.default.homeDirectoryForCurrentUser
            p = home.appendingPathComponent("Library/Logs/RavenryMac/events.log").path
        }
        guard let p else { return }
        let dir = (p as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        // Keep it small: a log over 4 MB starts again.
        if let a = try? FileManager.default.attributesOfItem(atPath: p), (a[.size] as? NSNumber)?.intValue ?? 0 > 4 << 20 {
            try? FileManager.default.removeItem(atPath: p)
        }
        if !FileManager.default.fileExists(atPath: p) {
            FileManager.default.createFile(atPath: p, contents: nil)
        }
        guard let h = FileHandle(forWritingAtPath: p) else { return }
        h.seekToEndOfFile()
        handle = h
        path = p
        write("start pid \(ProcessInfo.processInfo.processIdentifier) \(Date())")
    }

    var enabled: Bool { handle != nil }

    func write(_ line: @autoclosure () -> String) {
        guard let h = handle else { return }
        let s = String(format: "%.3f ", CACurrentMediaTime() - start) + line() + "\n"
        queue.async { h.write(s.data(using: .utf8)!) }
    }

    /// Waits until every line so far is on disk (the self-test).
    func flush() { queue.sync {} }
}

extension NSEvent.Phase {
    var name: String {
        var n: [String] = []
        if contains(.began) { n.append("began") }
        if contains(.stationary) { n.append("stationary") }
        if contains(.changed) { n.append("changed") }
        if contains(.ended) { n.append("ended") }
        if contains(.cancelled) { n.append("cancelled") }
        if contains(.mayBegin) { n.append("mayBegin") }
        return n.isEmpty ? "none" : n.joined(separator: "+")
    }
}
