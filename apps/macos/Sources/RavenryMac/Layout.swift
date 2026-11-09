// Where the tabs and their splits are kept between launches: the
// Electron app's own window.json (apps/desktop/src/main/local.ts Store,
// in its data folder: RAVENRY_DESKTOP_DATA, else ~/Library/Application
// Support/Ravenry), with its keys and their meaning
// (apps/desktop/src/renderer/app.ts save() and restoreTabs()):
//
//   order   every tab's id, "s:<pane>" for a shell, in the strip's order
//           (a split's second pane is listed after its tab);
//   splits  {host, guest, side, size, focus, zoom}: the tab "host" shows
//           the tab "guest" beside it, on side right, left, down or up;
//           size is the host's share in percent; focus 1 when the guest
//           has the keyboard;
//   active  the tab in front.
//
// So the two apps agree: which panes are tabs is the daemon's (the panes
// labelled ravenry.kind: shell), and their order and splits are this
// file's, whichever app wrote it last. Writing, this app changes only
// those three keys, and in them only the ids of its own tabs; the rest
// (pinned sessions, the window's place, another daemon's tabs) stays.
//
// A window off every screen (the bench, the self-test) uses the file
// only when RAVENRY_DESKTOP_DATA names a folder (its own), never the
// person's.
//
// The file is kept by daemon: tab ids are pane ids, which mean something
// only to the daemon that holds the panes. A window on the Electron app's
// daemon (its socket in the Electron app's runtime folder,
// ~/Library/Application Support/Ravenry/run) shares window.json with it;
// a window on any other daemon (a test's, the native spike's own) keeps
// window-<daemon>.json beside it, <daemon> the first 12 hex digits of the
// SHA-256 of that daemon's runtime folder (where its sockets live, across
// its updates). So two clients on different daemons never write over each
// other's tabs, and two on the same daemon share them.

import CryptoKit
import Foundation

struct SavedSplit {
    var host: String
    var guest: String
    var side: String
    var size: Double
    var focus: Int
    var zoom: Bool
}

struct SavedLayout {
    var order: [String] = []
    var splits: [SavedSplit] = []
    var active: String?
    /// The sessions pinned to the tabs (their keys), as the Electron app keeps them.
    var pinned: [String] = []
}

final class LayoutStore {
    let url: URL
    private var timer: DispatchWorkItem?
    /// The tab ids this window held and closed: gone from the file too.
    private var dropped = Set<String>()

    init?(offscreen: Bool, socket: String?, env: [String: String] = ProcessInfo.processInfo.environment) {
        let dir: URL
        if let d = env["RAVENRY_DESKTOP_DATA"], !d.isEmpty {
            dir = URL(fileURLWithPath: d)
        } else if offscreen {
            return nil
        } else {
            let lib = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
            dir = lib.appendingPathComponent("Ravenry")
        }
        url = dir.appendingPathComponent(LayoutStore.fileName(socket: socket))
    }

    /// The Electron app's daemons' folder: its window.json is theirs.
    static var electronRuntime: String {
        (NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/Ravenry/run")
    }

    /// window.json for the Electron app's daemon, else window-<daemon>.json.
    static func fileName(socket: String?) -> String {
        guard let s = socket, !s.isEmpty else { return "window.json" }
        let folder = URL(fileURLWithPath: s).deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath().path
        let electron = URL(fileURLWithPath: electronRuntime).standardizedFileURL.resolvingSymlinksInPath().path
        if folder == electron { return "window.json" }
        let h = SHA256.hash(data: Data(folder.utf8)).map { String(format: "%02x", $0) }.joined()
        return "window-\(h.prefix(12)).json"
    }

    private func readAll() -> [String: Any] {
        guard let d = try? Data(contentsOf: url) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] ?? [:]
    }

    func read() -> SavedLayout {
        let all = readAll()
        var l = SavedLayout()
        l.order = all["order"] as? [String] ?? []
        l.active = all["active"] as? String
        l.pinned = (all["pinned"] as? [Any] ?? []).compactMap { $0 as? String }
        for s in all["splits"] as? [[String: Any]] ?? [] {
            guard let h = s["host"] as? String, let g = s["guest"] as? String else { continue }
            l.splits.append(SavedSplit(host: h, guest: g, side: s["side"] as? String ?? "right",
                                       size: (s["size"] as? NSNumber)?.doubleValue ?? 50,
                                       focus: (s["focus"] as? NSNumber)?.intValue ?? 0, zoom: s["zoom"] as? Bool ?? false))
        }
        return l
    }

    func forget(_ ids: [String]) { dropped.formUnion(ids) }

    /// Writes this window's tabs (ids in the strip's order, guests after
    /// their tab), splits and tab in front, 200 ms after the last change.
    func save(order ours: [String], splits: [SavedSplit], active: String?, pinned: [String]? = nil) {
        timer?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.write(order: ours, splits: splits, active: active, pinned: pinned) }
        timer = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: w)
    }

    /// Writes now what a save waits to write.
    func flush() {
        guard let t = timer, !t.isCancelled else { return }
        t.perform()
        t.cancel()
    }

    private func write(order ours: [String], splits: [SavedSplit], active: String?, pinned: [String]?) {
        timer = nil
        var all = readAll()
        let mine = Set(ours).union(dropped)
        // The other ids keep their places; this window's go where its
        // first one was (at the end when none was there).
        var order: [String] = []
        var placed = false
        for id in all["order"] as? [String] ?? [] {
            if mine.contains(id) {
                if !placed { order += ours; placed = true }
            } else {
                order.append(id)
            }
        }
        if !placed { order += ours }
        var outSplits = (all["splits"] as? [[String: Any]] ?? []).filter { s in
            !mine.contains(s["host"] as? String ?? "") && !mine.contains(s["guest"] as? String ?? "")
        }
        for s in splits {
            outSplits.append(["host": s.host, "guest": s.guest, "side": s.side, "size": s.size, "focus": s.focus, "zoom": s.zoom])
        }
        all["order"] = order
        if let p = pinned { all["pinned"] = p }
        all["splits"] = outSplits
        if let a = active { all["active"] = a } else if let a = all["active"] as? String, mine.contains(a) { all["active"] = NSNull() }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            var d = try JSONSerialization.data(withJSONObject: all, options: [.prettyPrinted, .sortedKeys])
            d.append(0x0A)
            let tmp = url.appendingPathExtension("tmp")
            try d.write(to: tmp)
            if rename(tmp.path, url.path) != 0 { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        } catch {
            NSLog("RavenryMac: window.json: \(error)")
        }
    }
}
