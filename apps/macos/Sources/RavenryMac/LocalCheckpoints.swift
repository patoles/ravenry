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
    /// What the hub's copy adds to a daemon's (checkpoints.ts put: the hub's extras survive a daemon event that lacks them):
    /// a page's run, its project and session, its machine. By id, kept as long as the checkpoint is.
    private var extras: [String: [String: Any]] = [:]
    static let extraKeys = ["page", "project", "projectId", "surfaceId", "machine", "checked", "pick_record"]

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
        extras = extras.filter { items[$0.key] != nil }
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
            if items[id] != nil {
                var x: [String: Any] = [:]
                for k in DaemonCheckpoints.extraKeys { if let v = h[k], !(v is NSNull) { x[k] = v } }
                if !x.isEmpty { extras[id] = x }
            }
            guard let d = items[id]?.cp, DaemonCheckpoints.stage(d) > DaemonCheckpoints.stage(h) else { out.append(h); continue }
            var m = h.merging(d) { _, b in b }
            m["words"] = nil
            out.append(m)
        }
        let recent = Date().addingTimeInterval(-30)
        let mine = items.filter { !seen.contains($0.key) && ($0.value.closedAt.map { $0 > recent } ?? true) }
            .map { kv -> [String: Any] in kv.value.cp.merging(extras[kv.key] ?? [:]) { a, _ in a } }.sorted { ($0["created_at"] as? String ?? "") < ($1["created_at"] as? String ?? "") }
        return out + mine
    }
}

/// The cards that closed while this window watched (checkpoints.ts Known's
/// closedSeen and forPane): a pane's card says how its checkpoint ended
/// (answered, declined, withdrawn, out of time, ran) in the hub's words
/// (words.after) for half an hour, until another opens there or its agent
/// moves on. A drive's or a pick's has nothing more to say: it goes at once,
/// as does one the person answered in the terminal instead (answered_in).
final class ClosedCards {
    struct Seen {
        var cp: [String: Any]
        var at: Date
        /// Its agent moved on, or it is a drive or a pick: never shown.
        var hidden: Bool
    }
    private(set) var items: [String: Seen] = [:]
    static var keep: TimeInterval = 30 * 60

    /// A closed copy (an answer's, a daemon's, the hub's own list of recent
    /// ones), worded for its state. Seen closed from the first copy; a later
    /// copy only brings its words up to date. True when anything changed.
    @discardableResult
    func saw(_ cp: [String: Any], now: Date = When.now()) -> Bool {
        guard let id = cp["id"] as? String, !id.isEmpty, !DaemonCheckpoints.isOpen(cp) else { return false }
        if var had = items[id] {
            let w0 = (had.cp["words"] as? [String: Any])?["state"] as? String, w1 = (cp["words"] as? [String: Any])?["state"] as? String
            let inTerminal = had.cp["answered_in"] == nil && cp["answered_in"] as? String == "terminal"
            guard had.cp["state"] as? String != cp["state"] as? String || (w1 != nil && w0 != w1) || (had.cp["page"] == nil && cp["page"] != nil) || inTerminal else { return false }
            var c = cp
            for k in DaemonCheckpoints.extraKeys where c[k] == nil { c[k] = had.cp[k] }
            had.cp = c
            if inTerminal { had.hidden = true }
            items[id] = had
            if inTerminal { answeredInTerminal(c) }
            return true
        }
        let kind = cp["kind"] as? String ?? ""
        // One the person answered in the terminal instead (the hub withdrew it, answered_in): their words are in the session, so it goes too.
        let inTerminal = cp["answered_in"] as? String == "terminal"
        items[id] = Seen(cp: cp, at: now, hidden: kind == "drive" || kind == "pick" || inTerminal)
        if inTerminal { answeredInTerminal(cp) }
        prune(now)
        return true
    }

    /// The person wrote to the pane's agent (a card of it closed as answered in the terminal): the cards that closed there before go too, as when its agent moves on.
    private func answeredInTerminal(_ cp: [String: Any]) {
        guard let pane = cp["pane"] as? String, !pane.isEmpty else { return }
        let machine = (cp["machine"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        for (id, s) in items where s.cp["pane"] as? String == pane && ((s.cp["machine"] as? String).flatMap { $0.isEmpty ? nil : $0 }) == machine { items[id]?.hidden = true }
    }

    /// The closed copy of one, while it is kept.
    func get(_ id: String, now: Date = When.now()) -> [String: Any]? {
        guard let s = items[id], now.timeIntervalSince(s.at) < ClosedCards.keep else { return nil }
        return s.cp
    }

    /// The card a pane shows once nothing is open there: the last that closed, while it is kept and its agent has not moved on.
    func forPane(_ pane: String, machine: String?, now: Date = When.now()) -> [String: Any]? {
        items.values.filter { s in
            !s.hidden && now.timeIntervalSince(s.at) < ClosedCards.keep && s.cp["pane"] as? String == pane
                && ((s.cp["machine"] as? String).flatMap { $0.isEmpty ? nil : $0 }) == machine
        }.max { $0.at < $1.at }?.cp
    }

    /// The pane's agent reported again (a new tool use, a prompt, its turn ended): the cards that closed before go (checkpoints.ts settle).
    func settle(pane: String, since: Date) {
        for (id, s) in items where s.cp["pane"] as? String == pane && !s.hidden && s.at < since { items[id]?.hidden = true }
    }

    func prune(_ now: Date = When.now()) {
        items = items.filter { now.timeIntervalSince($0.value.at) < ClosedCards.keep }
    }
}
