// Session links (Simon, 2026-11-10: "just clicking the link should open the
// session without asking"). A Claude session's name ("ravenry-19",
// "ai-game-sdk-8e") or id in terminal text is a link: drawn as one at rest
// (the link colour, underlined), and a press and release on it without
// moving opens that session's tab at once, with no card and no question; a
// drag still selects. ravenry://session/<name> (a phone alert, a brief)
// opens it the same way. The names are never shown as such ("why do we need
// to display the session id, that's not useful for the user").
//
// Only the words the hub knows are links: the names of
// hub/server/sessionnames.mjs (GET /api/session-names, read again when the
// state's sessionNames.rev changes), the ids of the board's sessions and of
// the named ones (whole, or their first 8 characters), and of those only
// the ones that open: on the board, or with a project to continue them in.
// A word that names nothing is plain text.
//
// Finding them costs the drawing nothing: the rows a frame brings are
// scanned on the connection's reader thread while the frame is applied
// (Screen.apply), one table lookup a character, a hash lookup only for a
// word with a dash (a name, an id) or of 8 hex characters (a short id). The
// renderer reads the spans it left.

import AppKit
import os

/// A link's cells on one view row (columns x0 to x1) and its word (an
/// index into Screen.nameWords). A name wrapped over two rows has a span on each.
struct NameSpan: Equatable {
    var y: Int, x0: Int, x1: Int, word: Int
}

/// The words that are links, by a hash of their bytes. Made again on the
/// main thread when they change (gen), read on the reader threads.
final class NameMatcher {
    let gen: Int
    let words: [[UInt8]]
    let strings: [String]
    private let byHash: [UInt64: Int]
    let minLen: Int, maxLen: Int
    var isEmpty: Bool { words.isEmpty }

    static let basis: UInt64 = 0xcbf2_9ce4_8422_2325
    static let prime: UInt64 = 0x100_0000_01b3

    init(_ list: [String], gen: Int) {
        self.gen = gen
        var w: [[UInt8]] = [], s: [String] = [], h: [UInt64: Int] = [:]
        for x in list {
            let b = Array(x.utf8)
            guard !b.isEmpty, b.allSatisfy({ $0 < 128 && NameMatcher.wordChar[Int($0)] }) else { continue }
            var v = NameMatcher.basis
            for c in b { v = (v ^ UInt64(c)) &* NameMatcher.prime }
            if h[v] != nil { continue }
            h[v] = w.count
            w.append(b)
            s.append(x)
        }
        words = w; strings = s; byHash = h
        minLen = w.map(\.count).min() ?? 0
        maxLen = w.map(\.count).max() ?? 0
    }

    /// The characters a word is made of: letters, digits, dash, underscore.
    static let wordChar: [Bool] = (0..<128).map { c in
        (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 45 || c == 95
    }

    func lookup(_ buf: UnsafeMutablePointer<UInt8>, _ n: Int, _ h: UInt64) -> Int? {
        guard let i = byHash[h], words[i].count == n else { return nil }
        let w = words[i]
        for k in 0..<n where w[k] != buf[k] { return nil }
        return i
    }
}

extension Screen {
    /// Finds the session names and ids in the rows: nameSpans in reading
    /// order, nameWords their words. The caller holds the lock.
    func findNames(_ m: NameMatcher) {
        nameGen = m.gen
        if !nameSpans.isEmpty { nameSpans.removeAll(keepingCapacity: true); nameWords.removeAll(keepingCapacity: true) }
        if m.isEmpty || rows == 0 { return }
        let n = min(rows, lines.count, wraps.count)
        withUnsafeTemporaryAllocation(of: UInt8.self, capacity: m.maxLen + 1) { buf in
            var s = NameScan(m: m, buf: buf.baseAddress!, cols: cols)
            for y in 0..<n {
                lines[y].withUnsafeBufferPointer { row in
                    for x in 0..<row.count {
                        let c = row[x]
                        if c.flags & Cell.spacer != 0 { continue }
                        s.feed(c.g == 0 ? 32 : c.g, y, x)
                    }
                }
                // A row that does not wrap onto the next ends its last word.
                if !wraps[y] { s.feed(10, y, cols) }
            }
            s.feed(10, n, 0)
            nameSpans = s.spans
            nameWords = s.found
        }
    }
}

/// The scan of a screen's rows, one character at a time, in reading order.
/// A word is a link when the matcher has it, unless it is part of a path,
/// an address or a file name: right after / \ . @, or right before / \ @,
/// or before a dot that a letter or digit follows ("ravenry-19.json"; "to
/// ravenry-19." is a link).
private struct NameScan {
    let m: NameMatcher
    let buf: UnsafeMutablePointer<UInt8>
    let cols: Int
    var spans: [NameSpan] = []
    var found: [String] = []
    private var len = 0, h = NameMatcher.basis, dash = false, hex = true
    private var sy = 0, sx = 0, ey = 0, ex = 0
    private var before: UInt32 = 32
    /// A word found right before a dot, decided by what follows the dot.
    private var pending: (i: Int, sy: Int, sx: Int, ey: Int, ex: Int)?

    init(m: NameMatcher, buf: UnsafeMutablePointer<UInt8>, cols: Int) { self.m = m; self.buf = buf; self.cols = cols }

    @inline(__always) static func isWord(_ g: UInt32) -> Bool { g < 128 && NameMatcher.wordChar[Int(g)] }

    mutating func feed(_ g: UInt32, _ y: Int, _ x: Int) {
        let word = NameScan.isWord(g)
        if let p = pending {
            pending = nil
            if !word { add(p.i, p.sy, p.sx, p.ey, p.ex) }
        }
        if word {
            if len == 0 { sy = y; sx = x; h = NameMatcher.basis; dash = false; hex = true }
            if len < m.maxLen { buf[len] = UInt8(g) }
            h = (h ^ UInt64(g)) &* NameMatcher.prime
            if g == 45 { dash = true } else if hex && !((g >= 48 && g <= 57) || (g >= 97 && g <= 102)) { hex = false }
            len += 1
            ey = y; ex = x
            return
        }
        if len > 0 { end(next: g) }
        before = g
    }

    private mutating func end(next: UInt32) {
        defer { len = 0 }
        guard len >= m.minLen, len <= m.maxLen, dash || (hex && len == 8) else { return }
        // Right after a path's slash, a dot or an @: part of something else.
        if before == 47 || before == 92 || before == 46 || before == 64 { return }
        if next == 47 || next == 92 || next == 64 { return }
        guard let i = m.lookup(buf, len, h) else { return }
        if next == 46 { pending = (i, sy, sx, ey, ex); return }
        add(i, sy, sx, ey, ex)
    }

    private mutating func add(_ i: Int, _ sy: Int, _ sx: Int, _ ey: Int, _ ex: Int) {
        let w = found.count
        found.append(m.strings[i])
        if sy == ey { spans.append(NameSpan(y: sy, x0: sx, x1: ex, word: w)); return }
        spans.append(NameSpan(y: sy, x0: sx, x1: cols - 1, word: w))
        for y in (sy + 1)..<ey { spans.append(NameSpan(y: y, x0: 0, x1: cols - 1, word: w)) }
        spans.append(NameSpan(y: ey, x0: 0, x1: ex, word: w))
    }
}

/// The table of the session names and ids that are links, for every
/// window's terminals; and what a click on one opens.
final class SessionLinks {
    static let shared = SessionLinks()
    /// Posted when the words that are links changed: the terminals draw again.
    static let changed = Notification.Name("RavenrySessionLinksChanged")

    private var lock = os_unfair_lock()
    private var current = NameMatcher([], gen: 0)
    /// The words that are links now (any thread).
    var matcher: NameMatcher {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        return current
    }

    struct Target: Equatable { let sessionId: String, projectId: String? }
    /// The hub's names: name to its session (the main thread only).
    private(set) var names: [String: Target] = [:]
    private var rev: Int?
    private var asking = false
    private var boardIds: Set<String> = []
    private var linked: [String: Target] = [:]
    /// A ravenry:// link that came before the table: opened once it is here.
    private var waiting: (word: String, board: Board, at: Date)?
    /// The words clicked or opened by a link (the self-test reads them).
    private(set) var opened: [String] = []

    /// A state from the hub: the names read again when their rev changed,
    /// the links made again when what opens changed.
    func stateArrived(_ st: HubState, hub: HubClient, board: Board) {
        var ids = Set<String>()
        for p in st.projects { for s in p.sessions { if let id = s.sessionId?.lowercased() { ids.insert(id) } } }
        if ids != boardIds { boardIds = ids; rebuild() }
        let r = ((st.raw["sessionNames"] as? [String: Any])?["rev"] as? NSNumber)?.intValue
        if let r, r != rev, !asking {
            asking = true
            hub.get("/api/session-names") { [weak self] code, j in
                guard let self else { return }
                self.asking = false
                guard code == 200, let t = j["names"] as? [String: Any] else { return }
                self.rev = r
                var next: [String: Target] = [:]
                for (k, v) in t {
                    guard let d = v as? [String: Any], let sid = (d["sessionId"] as? String)?.lowercased() else { continue }
                    next[k] = Target(sessionId: sid, projectId: d["projectId"] as? String)
                }
                if next != self.names { self.names = next; self.rebuild() }
                self.openWaiting()
            }
        } else if r == nil || r == rev {
            openWaiting()
        }
    }

    /// The words that are links: each name whose session opens (on the
    /// board, or with a project to continue it in), and those sessions'
    /// ids, whole and their first 8 characters when no other id starts so.
    private func rebuild() {
        var next: [String: Target] = [:]
        var sids = boardIds
        var projectOf: [String: String] = [:]
        for (name, t) in names where boardIds.contains(t.sessionId) || t.projectId != nil {
            next[name] = t
            sids.insert(t.sessionId)
            if let p = t.projectId { projectOf[t.sessionId] = p }
        }
        var prefixCount: [String: Int] = [:]
        for sid in sids where sid.count == 36 { prefixCount[String(sid.prefix(8)), default: 0] += 1 }
        for sid in sids where sid.count == 36 {
            let t = Target(sessionId: sid, projectId: projectOf[sid])
            next[sid] = t
            let pre = String(sid.prefix(8))
            // A short id with a letter and a digit, as no number or word is.
            if prefixCount[pre] == 1, pre.contains(where: { $0.isLetter }), pre.contains(where: { $0.isNumber }) { next[pre] = t }
        }
        guard Set(next.keys) != Set(linked.keys) || next != linked else { return }
        linked = next
        let m = NameMatcher(Array(next.keys).sorted(), gen: matcher.gen + 1)
        os_unfair_lock_lock(&lock)
        current = m
        os_unfair_lock_unlock(&lock)
        NotificationCenter.default.post(name: SessionLinks.changed, object: nil)
    }

    /// The session a word opens, or nil.
    func target(_ word: String) -> Target? {
        linked[word] ?? linked[word.lowercased()]
    }

    /// A click on a link in a terminal: its window's board opens it.
    func open(_ word: String, from view: NSView) {
        opened.append(word)
        guard let app = NSApp.delegate as? AppDelegate,
              let rw = app.windows.first(where: { $0.window === view.window }) ?? app.current ?? app.windows.first else { return }
        rw.board.openSessionLink(word, why: "click")
    }

    /// ravenry://session/<name or id>: the board of the window in front
    /// opens it, at once when the names are here, else once they come
    /// (within 20 s: an app just launched by the link).
    func openURL(_ u: URL, app: AppDelegate) -> Bool {
        guard u.scheme?.lowercased() == "ravenry", u.host?.lowercased() == "session" else { return false }
        let word = u.pathComponents.filter { $0 != "/" }.first ?? ""
        guard !word.isEmpty, word.count <= 100 else { return false }
        opened.append(word)
        let rw = app.current ?? app.windows.first ?? app.makeWindow(.restore)
        guard let rw else { return false }
        if !app.options.offscreen {
            NSApp.activate(ignoringOtherApps: true)
            rw.window.makeKeyAndOrderFront(nil)
        }
        if rev == nil || rw.board.hub.state == nil {
            waiting = (word, rw.board, Date())
        } else {
            rw.board.openSessionLink(word, why: "url")
        }
        return true
    }

    private func openWaiting() {
        guard let w = waiting, rev != nil, w.board.hub.state != nil else { return }
        waiting = nil
        if Date().timeIntervalSince(w.at) < 20 { w.board.openSessionLink(w.word, why: "url") }
    }
}

extension AppDelegate {
    /// ravenry://session/<name> (CFBundleURLTypes, scripts/package.mjs).
    @objc func application(_ application: NSApplication, open urls: [URL]) {
        for u in urls { _ = SessionLinks.shared.openURL(u, app: self) }
    }
}
