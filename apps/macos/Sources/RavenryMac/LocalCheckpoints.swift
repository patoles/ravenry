// The checkpoints this window's daemons hold (PROTOCOL.md section 4), as
// the Electron app keeps them (apps/desktop/src/renderer/checkpoints.ts,
// Checkpoints): what checkpoint.list said when each daemon was reached, and
// its checkpoint.opened, .running and .closed events since. The hub's state
// lists the checkpoints it hears of; these add the ones only a daemon of
// this window holds (the hub down, or a hub that does not follow that
// daemon), so a question asked in a pane always shows, and each is
// answered where it is held: its daemon first, the hub second (app.ts
// answerCp). A daemon's copy has no words; the window words it with the
// hub's own code (cpwords.mjs, OlderHub), so its card reads as the hub's.

import Foundation

final class DaemonCheckpoints {
    /// One checkpoint a daemon of this window holds, and when it was seen to close.
    struct Held {
        var cp: [String: Any]
        var socket: String
        var closedAt: Date?
    }
    private(set) var items: [String: Held] = [:]
    /// The daemons that refused an answer from this window as not the person (forbidden).
    var notPerson = Set<String>()

    /// open 0, running 1, anything else (closed) 2: a checkpoint only moves on.
    static func stage(_ cp: [String: Any]) -> Int {
        switch cp["state"] as? String { case "open": return 0; case "running": return 1; default: return 2 }
    }
    static func isOpen(_ cp: [String: Any]) -> Bool { stage(cp) < 2 }

    /// A daemon's copy (an event or its list); true when it is new here and open.
    @discardableResult
    func put(_ cp: [String: Any], socket: String) -> Bool {
        guard let id = cp["id"] as? String, !id.isEmpty else { return false }
        let had = items[id]
        // A late copy never takes a checkpoint back (closed, then open again).
        if let h = had, DaemonCheckpoints.stage(cp) < DaemonCheckpoints.stage(h.cp) { return false }
        var c = cp
        c["words"] = nil
        items[id] = Held(cp: c, socket: socket, closedAt: DaemonCheckpoints.isOpen(c) ? nil : (had?.closedAt ?? Date()))
        // Closed ones are kept ten minutes (a hub's late copy stays closed), then forgotten.
        let cut = Date().addingTimeInterval(-600)
        items = items.filter { ($0.value.closedAt ?? .distantFuture) > cut }
        return had == nil && DaemonCheckpoints.isOpen(c)
    }

    /// A daemon went away: what was known only through it goes.
    func drop(socket: String) { items = items.filter { $0.value.socket != socket } }

    /// The daemon holding a checkpoint, by its socket.
    func socket(of id: String) -> String? { items[id]?.socket }

    /// The hub's list with this window's copies: the hub's where it is as
    /// far on (its words, its project and session), the daemon's state over
    /// it where the daemon is further on (its words then made again), and the
    /// ones only a daemon holds (a closed one for half a minute).
    func merged(_ hub: [[String: Any]]) -> [[String: Any]] {
        var out: [[String: Any]] = []
        var seen = Set<String>()
        for h in hub {
            guard let id = h["id"] as? String else { out.append(h); continue }
            seen.insert(id)
            guard let d = items[id]?.cp, DaemonCheckpoints.stage(d) > DaemonCheckpoints.stage(h) else { out.append(h); continue }
            var m = h.merging(d) { _, b in b }
            m["words"] = nil
            out.append(m)
        }
        let recent = Date().addingTimeInterval(-30)
        let mine = items.filter { !seen.contains($0.key) && ($0.value.closedAt.map { $0 > recent } ?? true) }
            .map(\.value.cp).sorted { ($0["created_at"] as? String ?? "") < ($1["created_at"] as? String ?? "") }
        return out + mine
    }
}
