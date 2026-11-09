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
}

final class LayoutStore {
    let url: URL
    private var timer: DispatchWorkItem?
    /// The tab ids this window held and closed: gone from the file too.
    private var dropped = Set<String>()

    init?(offscreen: Bool) {
        let env = ProcessInfo.processInfo.environment
        if let d = env["RAVENRY_DESKTOP_DATA"], !d.isEmpty {
            url = URL(fileURLWithPath: d).appendingPathComponent("window.json")
        } else if offscreen {
            return nil
        } else {
            let lib = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
            url = lib.appendingPathComponent("Ravenry/window.json")
        }
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
    func save(order ours: [String], splits: [SavedSplit], active: String?) {
        timer?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.write(order: ours, splits: splits, active: active) }
        timer = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: w)
    }

    /// Writes now what a save waits to write.
    func flush() {
        guard let t = timer, !t.isCancelled else { return }
        t.perform()
        t.cancel()
    }

    private func write(order ours: [String], splits: [SavedSplit], active: String?) {
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
