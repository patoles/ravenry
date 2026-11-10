// Every running ravenryd the window draws (HUB-006, UPD-004): one
// Connection per daemon in the runtime folder that answers pane.render, so
// an update never makes a running session worse. Installing a newer app
// starts its daemon beside the old one; the old one drains (it takes no new
// panes and exits once its last pane ended), and until then its panes stay
// live tabs, drawn and typed into over their own daemon's connection.
//
// - The first connection is the one main.swift found or started (the
//   newest with the render stream). With --socket it is the only one: a
//   test's own daemon.
// - Otherwise the runtime folder (where that daemon's socket is, and every
//   other version's: ravenryd-<version>.sock, as paths.Sockets lists them)
//   is read at the start and every 2 seconds: a socket not connected yet is
//   tried off the main thread (the hello as ravenry-desktop, as the first);
//   one without pane.render (before 0.1.23) is left alone until its file
//   changes, and its sessions stay read only in the middle (Middle.swift).
// - New panes go to the newest daemon not draining (`newest`); a daemon
//   that says it drains (hello's daemon.draining, the daemon.draining event)
//   keeps its panes until they end. A daemon that goes away takes its tabs
//   with it.
//
// Pane ids are unique across daemons ("p" and 7 random characters,
// daemon/internal/pane newID), so the tabs, the layout file and the board
// keep naming panes by id alone; `Workspace.conn(of:)` says whose a pane is.

import Foundation

/// One daemon the window draws.
final class DaemonLink {
    let conn: Connection
    /// The newer version it drains for, else "".
    var draining: String
    var socket: String { conn.socketPath }
    var version: String { conn.daemonVersion }
    init(_ c: Connection) {
        conn = c
        draining = c.daemonDraining
    }
}

final class Daemons {
    /// Newest first, a draining one after those that are not (main thread).
    private(set) var all: [DaemonLink] = []
    /// The runtime folder read for more daemons; nil: the first one only.
    let folder: String?
    /// A daemon that joined after the start, one that went away, and every
    /// daemon's events, on the main thread.
    var onJoin: ((DaemonLink) -> Void)?
    var onLeave: ((DaemonLink) -> Void)?
    var onEvent: ((DaemonLink, [String: Any]) -> Void)?
    /// A line for the app's log.
    var log: ((String) -> Void)?
    /// Sockets tried and left alone, by their file (inode): no render
    /// stream, or nothing answered (a stale file); tried again when the
    /// file changes, or a refused one after 10 s.
    private var left: [String: (ino: UInt64, renderless: Bool, at: Date)] = [:]
    private var trying = Set<String>()
    private let queue = DispatchQueue(label: "ravenry-daemons", qos: .userInitiated)
    private var timer: Timer?
    private var closed = false

    init(first: Connection, watch: Bool, log: ((String) -> Void)? = nil) {
        folder = watch ? URL(fileURLWithPath: first.socketPath).deletingLastPathComponent().path : nil
        self.log = log
        add(first, joined: false)
    }

    /// Where new panes go: the newest daemon that does not drain, else the newest.
    var newest: DaemonLink? { all.first }

    func link(of c: Connection?) -> DaemonLink? { all.first { $0.conn === c } }

    private func sort() {
        all.sort { a, b in
            if a.draining.isEmpty != b.draining.isEmpty { return a.draining.isEmpty }
            return compareVersions(a.version, b.version) > 0
        }
    }

    /// A connected daemon: its events, its end, in the window.
    private func add(_ c: Connection, joined: Bool) {
        let l = DaemonLink(c)
        all.append(l)
        sort()
        c.onEvent = { [weak self, weak l] ev in
            DispatchQueue.main.async {
                guard let self, let l, self.all.contains(where: { $0 === l }) else { return }
                if ev["event"] as? String == "daemon.draining" {
                    l.draining = ev["newer"] as? String ?? "newer"
                    self.sort()
                    self.log?("daemon: \(l.version) drains for \(l.draining); its panes stay tabs until they end")
                }
                self.onEvent?(l, ev)
            }
        }
        c.onClose = { [weak self, weak l] in
            DispatchQueue.main.async {
                guard let self, let l, !self.closed, let i = self.all.firstIndex(where: { $0 === l }) else { return }
                self.all.remove(at: i)
                self.log?("daemon: \(l.version) at \(l.socket) went away")
                self.onLeave?(l)
            }
        }
        c.request("events.subscribe", ["display": true, "activity": true])
        log?("daemon: drawing \(l.version) at \(l.socket)\(l.draining.isEmpty ? "" : " (draining for \(l.draining))")")
        if joined { onJoin?(l) }
    }

    /// The sockets in the folder not connected and worth a try now.
    private func candidates() -> [(String, UInt64)] {
        guard let folder, let names = try? FileManager.default.contentsOfDirectory(atPath: folder) else { return [] }
        var out: [(String, UInt64)] = []
        for n in names where n.hasPrefix("ravenryd-") && n.hasSuffix(".sock") {
            let p = (folder as NSString).appendingPathComponent(n)
            var st = stat()
            guard stat(p, &st) == 0, (st.st_mode & S_IFMT) == S_IFSOCK else { continue }
            let ino = UInt64(st.st_ino)
            if all.contains(where: { $0.socket == p }) || trying.contains(p) { continue }
            if let l = left[p], l.ino == ino, l.renderless || Date().timeIntervalSince(l.at) < 10 { continue }
            out.append((p, ino))
        }
        return out
    }

    /// A daemon at this socket, with the render stream, else nil (and why).
    private static func open(_ path: String) -> (Connection?, renderless: Bool, why: String) {
        do {
            let c = try Connection(socket: path)
            c.start()
            // As the first connection (main.swift open): the daemon takes the
            // app's own process for the person, on every daemon it draws.
            try c.hello(client: "ravenry-desktop", timeout: 3)
            if c.methods.contains("pane.render") { return (c, false, "") }
            c.close()
            return (nil, true, "\(c.daemonVersion) has no render stream")
        } catch {
            return (nil, false, "\(error)")
        }
    }

    /// At the start, before the tabs are restored: every daemon in the
    /// folder that answers, at once.
    func joinNow() {
        for (p, ino) in candidates() {
            let (c, renderless, why) = Daemons.open(p)
            if let c { add(c, joined: false) } else {
                left[p] = (ino, renderless, Date())
                log?("daemon: \(p) left read only: \(why)")
            }
        }
    }

    /// Reads the folder every 2 seconds for daemons that came.
    func watch() {
        guard folder != nil, timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.scan() }
    }

    private func scan() {
        guard !closed else { return }
        for (p, ino) in candidates() {
            trying.insert(p)
            queue.async { [weak self] in
                let (c, renderless, why) = Daemons.open(p)
                DispatchQueue.main.async {
                    guard let self else { c?.close(); return }
                    self.trying.remove(p)
                    guard !self.closed, let c else {
                        c?.close()
                        if self.left[p]?.ino != ino { self.log?("daemon: \(p) left read only: \(why)") }
                        self.left[p] = (ino, renderless, Date())
                        return
                    }
                    self.left[p] = nil
                    self.add(c, joined: true)
                }
            }
        }
    }

    /// The window goes: every connection closes (the panes keep running).
    func close() {
        closed = true
        timer?.invalidate()
        for l in all { l.conn.close() }
    }
}
