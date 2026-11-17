// The hub: the board's server, which knows every session and what it needs.
// The window reads it as the Electron app does (apps/desktop/src/main/hub.ts):
// the server-sent events of GET /api/events, each `state` event the whole
// board, read again after a drop (every 250 ms for the first 15 s, then
// backing off to 10 s). It draws what the hub sends and decides nothing:
// the sidebar is `state.sidebar` (hub/server/sidebar.mjs), a checkpoint's
// words its `words` (hub/server/cpwords.mjs), the brief's Next its
// `brief.nextParts` (hub/server/briefnext.mjs).
//
// Where it is: RAVENRY_HUB_URL, else the port the running board wrote to
// <RAVENRY_HOME or ~/.ravenry>/board.json, else 4600. A window off every
// screen (the bench, the self-tests) reads a hub only when RAVENRY_HUB_URL
// names one (a test's), never the person's.
//
// It posts only what the person clicked (an answer, Continue, Move here,
// Hand off now, Start), as the board's own page does (X-Ravenry: 1), and
// never with RAVENRY_MAC_HUB_READONLY=1. Its stream is not the app's own
// (no ?app=1): the Mac notifications stay the Electron app's.

import AppKit

// MARK: the state, typed as the window reads it

struct SideMark {
    let kind: String, text: String, code: Bool, label: String?
    init(_ d: [String: Any]) {
        kind = d["kind"] as? String ?? "other"; text = d["text"] as? String ?? ""
        code = d["code"] as? Bool ?? false; label = d["label"] as? String
    }
}

struct SideRow {
    let key: String, surfaceId: String, name: String
    let assistant: String?, pct: Int?, pctWarn: Bool
    /// The model its transcript last named (hub/server/models.mjs): "Opus 5.5", "gpt-5.4"; its family alone, "Opus", "Codex".
    let model: String?, modelShort: String?
    let line: String?, mark: SideMark?, group: String, machine: String?
    /// The chip's word: the model where the row is wide, its family where it is narrow, else the assistant.
    func chip(narrow: Bool) -> String? { (narrow ? modelShort ?? model : model) ?? assistant }
    init(_ d: [String: Any]) {
        key = d["key"] as? String ?? ""; surfaceId = d["surfaceId"] as? String ?? ""; name = d["name"] as? String ?? ""
        assistant = d["assistant"] as? String; pct = (d["pct"] as? NSNumber)?.intValue; pctWarn = d["pctWarn"] as? Bool ?? false
        model = d["model"] as? String; modelShort = d["modelShort"] as? String
        line = d["line"] as? String; mark = (d["mark"] as? [String: Any]).map(SideMark.init)
        group = d["group"] as? String ?? "idle"; machine = d["machine"] as? String
    }
}

struct SideProject {
    let id: String, name: String, machine: String?
    let timeAt: String?, timeStyle: String
    let rows: [SideRow]
    /// Its folder is in one macOS has not let the board read (hub/server/access.mjs): "waiting", "denied" or "slow", and that folder ("~/Documents").
    let access: (state: String, folder: String)?
    init(_ d: [String: Any]) {
        id = d["id"] as? String ?? ""; name = d["name"] as? String ?? ""; machine = d["machine"] as? String
        let a = d["access"] as? [String: Any]
        access = (a?["state"] as? String).map { ($0, a?["folder"] as? String ?? "") }
        let t = d["time"] as? [String: Any] ?? [:]
        timeAt = t["at"] as? String; timeStyle = t["style"] as? String ?? "ago"
        rows = (d["rows"] as? [[String: Any]] ?? []).map(SideRow.init)
    }
}

struct SideSection {
    let group: String, title: String, count: Int
    let projects: [SideProject]
    init(_ d: [String: Any]) {
        group = d["group"] as? String ?? "idle"; title = d["title"] as? String ?? ""
        count = (d["count"] as? NSNumber)?.intValue ?? 0
        projects = (d["projects"] as? [[String: Any]] ?? []).map(SideProject.init)
    }
}

/// A page of the sidebar's lower nav (state.pages).
struct NavPage {
    let key: String, label: String, icon: String, number: Int?, countLabel: String?, slot: Int?, origin: String, project: String?
    /// The page's id and route (an open:page button names either), and what changes when it was read again.
    let id: String, route: String, rev: String
    init(_ d: [String: Any]) {
        id = d["id"] as? String ?? ""; route = d["route"] as? String ?? ""; rev = d["rev"] as? String ?? ""
        key = d["key"] as? String ?? ""; label = d["label"] as? String ?? ""; icon = d["icon"] as? String ?? "page"
        number = (d["number"] as? NSNumber)?.intValue; countLabel = d["countLabel"] as? String
        slot = (d["slot"] as? NSNumber)?.intValue; origin = d["origin"] as? String ?? "default"; project = d["project"] as? String
    }
}

final class HubSession {
    let raw: [String: Any]
    init(_ d: [String: Any]) { raw = d }
    func s(_ k: String) -> String? { raw[k] as? String }
    var surfaceId: String { s("surfaceId") ?? "" }
    var topic: String? { s("topic") }
    var assistant: String? { s("assistant") }
    /// "Claude Opus 5.5": the assistant and the model its transcript last named (hub/server/models.mjs), nil before it named one.
    var modelTitle: String? { s("modelTitle") }
    var state: String { s("state") ?? "" }
    var since: String? { s("since") }
    var sessionId: String? { s("sessionId") }
    var group: String { s("group") ?? "idle" }
    var machine: String? { s("machine") }
    var handed: Bool { raw["handed"] as? Bool ?? false }
    var words: [String: Any] { raw["words"] as? [String: Any] ?? [:] }
    var ctx: (tokens: Double, window: Double, pct: Double)? {
        guard let c = raw["ctx"] as? [String: Any], let tk = (c["tokens"] as? NSNumber)?.doubleValue,
              let w = (c["window"] as? NSNumber)?.doubleValue, let p = (c["pct"] as? NSNumber)?.doubleValue else { return nil }
        return (tk, w, p)
    }
    /// The ravenryd pane it runs in, else nil (hub/server/sidebar.mjs paneOf).
    var pane: String? {
        if let p = raw["pane"] as? String { return p }
        if let p = raw["pane"] as? [String: Any] { return p["id"] as? String }
        let id = surfaceId
        if id.hasPrefix("ravenry:") { let p = String(id.dropFirst(8)); if p.range(of: "^p[a-z2-7]{7}$", options: .regularExpression) != nil { return p } }
        return nil
    }
    /// Its worktree (hub/docs/SESSIONS.md, Worktrees): branch, folder, baseBranch, state, merged.
    var worktree: [String: Any]? { raw["worktree"] as? [String: Any] }
    var alsoOpen: String? { (raw["alsoOpen"] as? [String: Any])?["name"] as? String }
    var movedOn: String? { (raw["movedOn"] as? [String: Any])?["name"] as? String }
    var moving: [String: Any]? { raw["moving"] as? [String: Any] }
    var outside: [String: Any]? { raw["outside"] as? [String: Any] }
    var term: String? { s("term") }
    var termName: String? { s("termName") }
    var cannot: String? { s("cannot") }
    /// false when the hub cannot read its terminal.
    var terminal: Bool? { raw["terminal"] as? Bool }
    var screen: [String] { raw["screen"] as? [String] ?? [] }
    var conversation: [[String: Any]] { raw["conversation"] as? [[String: Any]] ?? [] }
    /// Its hand-off (hub/server/handoff.mjs): Hand off now was asked and waits for a clean point.
    var handoff: [String: Any]? { raw["handoff"] as? [String: Any] }
    var handoffQueued: Bool { (handoff?["manual"] as? Bool ?? false) && !["written", "resumed"].contains(handoff?["state"] as? String ?? "") }
}

/// One process of state.sessions (the hub's Sessions view, server/index.mjs
/// buildSessions): a running Claude or Codex, its memory, the group it is
/// in (use, handed, idle, left, unmapped) and whether Close may end it.
struct SessionProc {
    let raw: [String: Any]
    init(_ d: [String: Any]) { raw = d }
    var sessionId: String? { raw["sessionId"] as? String }
    var surfaceId: String? { raw["surfaceId"] as? String }
    var projectId: String? { raw["projectId"] as? String }
    var pid: Int { (raw["pid"] as? NSNumber)?.intValue ?? 0 }
    var label: String { raw["label"] as? String ?? "" }
    var line: String { raw["line"] as? String ?? "" }
    var group: String { raw["group"] as? String ?? "use" }
    var mix: String { raw["mix"] as? String ?? "idle" }
    var tag: String? { raw["tag"] as? String }
    var since: String? { raw["since"] as? String }
    var memKb: Double { (raw["memKb"] as? NSNumber)?.doubleValue ?? 0 }
    var assistant: String? { raw["assistant"] as? String }
    var folder: String? { raw["folder"] as? String }
    var unowned: Bool { raw["unowned"] as? Bool ?? false }
    var isFolder: Bool { raw["isFolder"] as? Bool ?? false }
    var closable: Bool { raw["closable"] as? Bool ?? false }
    var blocked: String? { raw["blocked"] as? String }
    /// The hub closes it: quiet long enough (or handed off, or left for you), and nothing stops it.
    var canClose: Bool { closable && sessionId != nil && ["handed", "idle", "left"].contains(group) }
    /// Why Close is not offered.
    var whyNot: String {
        if group == "use" { return t("sess.inUse") }
        return blocked ?? t("sess.cannotClose")
    }
    /// RSS in KB as "849 MB" or "10.0 GB" (1024-based, like Activity Monitor; the hub's fmtMem).
    static func mem(_ kb: Double) -> String {
        let mb = kb / 1024
        return mb < 1000 ? "\(Int(mb.rounded())) MB" : String(format: "%.1f GB", mb / 1024)
    }
}

final class HubProject {
    let raw: [String: Any]
    let sessions: [HubSession]
    init(_ d: [String: Any]) { raw = d; sessions = (d["sessions"] as? [[String: Any]] ?? []).map(HubSession.init) }
    func s(_ k: String) -> String? { raw[k] as? String }
    var id: String { s("id") ?? "" }
    var name: String { s("name") ?? id }
    var machine: String? { s("machine").flatMap { $0 == "local" ? nil : $0 } }
    var folder: String? { s("folder") }
    var folderShort: String? { s("folderShort") }
    var primary: String? { s("primary") }
    var since: String? { s("since") }
    var waitingOn: String? { s("waitingOn") }
    var brief: [String: Any]? { raw["brief"] as? [String: Any] }
    var plan: [String: Any]? { raw["plan"] as? [String: Any] }
    var planGate: Bool { raw["planGate"].map { !($0 is NSNull) && ($0 as? Bool ?? true) } ?? false }
    var timeline: [[String: Any]] { raw["timeline"] as? [[String: Any]] ?? [] }
    /// The hub sends the last finished hand-off (an object with resumedAt) or null, never a Bool (PANEL-006).
    var handoffRecent: Bool { (raw["handoffRecent"] as? [String: Any]).map { !$0.isEmpty } ?? (raw["handoffRecent"] as? Bool ?? false) }
    /// Its main session, else its first that was not handed off.
    var mainSession: HubSession? {
        sessions.first { $0.surfaceId == primary && !$0.handed } ?? sessions.first { !$0.handed }
    }
}

final class HubState {
    let raw: [String: Any]
    let sections: [SideSection]
    let counts: [String: Int]
    let projects: [HubProject]
    let checkpoints: [[String: Any]]
    let pages: [NavPage]
    init(_ d: [String: Any]) {
        raw = d
        let sb = d["sidebar"] as? [String: Any] ?? [:]
        sections = (sb["sections"] as? [[String: Any]] ?? []).map(SideSection.init)
        counts = (sb["counts"] as? [String: Any] ?? [:]).compactMapValues { ($0 as? NSNumber)?.intValue }
        projects = (d["projects"] as? [[String: Any]] ?? []).map(HubProject.init)
        checkpoints = d["checkpoints"] as? [[String: Any]] ?? []
        pages = (d["pages"] as? [[String: Any]] ?? []).map(NavPage.init)
    }
    var threshold: Double { ((raw["settings"] as? [String: Any])?["handoffThreshold"] as? NSNumber)?.doubleValue ?? 50 }
    /// Hand off automatically (the Settings' Hand-off tab): off, no line is drawn.
    var handoffEnabled: Bool { (raw["settings"] as? [String: Any])?["handoffEnabled"] as? Bool ?? true }
    /// state.sessions: every running assistant process, and the ones closed in the last 14 days.
    var sessionsView: [String: Any]? { raw["sessions"] as? [String: Any] }
    var sessionProcs: [SessionProc] { (sessionsView?["rows"] as? [[String: Any]] ?? []).map(SessionProc.init) }
    var sessionsIdle: Int { (sessionsView?["idleCount"] as? NSNumber)?.intValue ?? 0 }
    /// "3.1 GB" of the assistants' memory, else nil (the desktop's memoryLine).
    var memoryLine: String? {
        guard let kb = ((raw["sessions"] as? [String: Any])?["totalKb"] as? NSNumber)?.doubleValue, kb > 0 else { return nil }
        let gb = kb / 1048576
        return gb >= 1 ? String(format: "%.1f GB", gb) : "\(Int((kb / 1024).rounded())) MB"
    }
    func find(_ key: String) -> (project: HubProject, session: HubSession)? {
        for p in projects { for s in p.sessions where "\(p.id)/\(s.surfaceId)" == key { return (p, s) } }
        return nil
    }
    func project(_ id: String) -> HubProject? { projects.first { $0.id == id } }
    /// Where every client opens (hub/server/openon.mjs, NAV-009): the project of the session the
    /// person used last on any device (typed to, answered a card of, opened), else the one active last.
    var openOn: (projectId: String, key: String?, at: Date, why: String)? {
        guard let o = raw["openOn"] as? [String: Any], let pid = o["projectId"] as? String, let at = When.date(o["at"] as? String) else { return nil }
        return (pid, o["key"] as? String, at, o["why"] as? String ?? "")
    }
    /// The open checkpoint of a session: by its project and surface, else its pane (hub/server/sidebar.mjs marksOf).
    /// An open checkpoint from a pane of this computer's daemon (a shell's), the oldest first.
    func checkpoint(pane: String) -> [String: Any]? {
        checkpoints.filter { ["open", "running"].contains($0["state"] as? String ?? "") && $0["pane"] as? String == pane && $0["machine"] as? String == nil }
            .sorted { ($0["created_at"] as? String ?? "") < ($1["created_at"] as? String ?? "") }.first
    }

    func checkpoint(of p: HubProject, _ s: HubSession) -> [String: Any]? {
        let open = checkpoints.filter { ["open", "running"].contains($0["state"] as? String ?? "") }
            .sorted { ($0["created_at"] as? String ?? "") < ($1["created_at"] as? String ?? "") }
        if let c = open.first(where: { $0["projectId"] as? String == p.id && $0["surfaceId"] as? String == s.surfaceId }) { return c }
        if let pane = s.pane { return open.first { $0["pane"] as? String == pane && ($0["machine"] as? String) == (s.machine ?? p.machine) } }
        return nil
    }
}

// MARK: times, said against this computer's clock (the desktop's model.ts)

enum When {
    private static let iso: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
    private static let iso2 = ISO8601DateFormatter()
    static func date(_ s: String?) -> Date? { s.flatMap { iso.date(from: $0) ?? iso2.date(from: $0) } }
    static var now: () -> Date = { Date() }
    /// "now", "4 min", "2 h", "3 d".
    static func ago(_ s: String?) -> String {
        guard let d = date(s) else { return "now" }
        let ms = now().timeIntervalSince(d) * 1000
        guard ms >= 60000 else { return "now" }
        let m = Int(ms / 60000)
        if m < 60 { return "\(m) min" }
        let h = m / 60
        return h < 24 ? "\(h) h" : "\(h / 24) d"
    }
    /// "10:51" today, else how long ago.
    static func clock(_ s: String?) -> String {
        guard let d = date(s) else { return "now" }
        guard Calendar.current.isDate(d, inSameDayAs: now()) else { return ago(s) }
        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }
    /// "Mon 9 Nov, 18:04".
    static func stopped(_ s: String?) -> String {
        guard let d = date(s) else { return "" }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_GB"); f.dateFormat = "EEE d MMM, HH:mm"
        return f.string(from: d)
    }
    /// "312k", "1M", "1.5M".
    static func tokens(_ n: Double) -> String {
        if n >= 1e6 { let v = n / 1e6; var s = n >= 1e7 ? String(format: "%.0f", v) : String(format: "%.1f", v); if s.hasSuffix(".0") { s.removeLast(2) }; return s + "M" }
        if n >= 1000 { return "\(Int((n / 1000).rounded()))k" }
        return "\(Int(n))"
    }
}

// MARK: the client

final class HubClient: NSObject, URLSessionDataDelegate {
    /// Where the hub is. Found through board.json (not named), it is read
    /// again at each reconnect: a hub started again on another port (PORT=4700) is followed (HUB-012).
    private(set) var base: URL?
    /// The hub was named for this run (RAVENRY_HUB_URL), not found.
    let named: Bool
    private(set) var state: HubState?
    private(set) var reachable = false
    /// How many times the stream was opened (a check sees it was never dropped).
    private(set) var streamStarts = 0
    /// The protected folder macOS is asking about while the hub waits for
    /// the answer (its 503, hub/server/access.mjs), as "~/Documents".
    private(set) var waitingFor: String?
    /// The hub answers but has not read the board yet (HUB-004): its 503
    /// "starting" on /api/state, or a first state with no generatedAt.
    private(set) var starting = false
    /// What macOS calls that folder in System Settings ("Documents"), the hub's `folder`.
    private(set) var waitingFolder: String?
    /// That folder's absolute path (the hub's `path`), for the app to ask macOS itself (AccessAsk.swift).
    private(set) var waitingPath: String?
    var onState: ((HubState) -> Void)?
    var onStatus: ((Bool) -> Void)?
    /// A Mac notification the hub asks this app to post (event: notify, on the app's stream ?app=1).
    var onNotify: (([String: Any]) -> Void)?
    /// The decision ledger changed (event: decision, { type: saved, edited or removed }).
    var onDecision: (([String: Any]) -> Void)?
    /// This app's id on the hub: with two apps (this and the Electron one), notifications go to the one focused last.
    let client = UUID().uuidString.lowercased()
    /// Every request the window sent, for the self-test: "POST /api/send".
    private(set) var sent: [String] = []
    /// Each POST's body as sent, for the self-test; a secret is kept as its length only.
    private(set) var sentBodies: [(path: String, body: [String: Any])] = []
    /// The self-test's checkpoints (sidetest.mjs --screen cards): the state's own replaced by them.
    /// The self-test's changes to each state (sidetest.mjs --screen review), and its answers to some GETs.
    var testPatch: (([String: Any]) -> [String: Any])?
    var testAnswers: [String: [String: Any]] = [:]
    /// Each POST's answer, for the self-test: its place in `sent`, the path,
    /// the status (0: no answer), and whether a test faked it (testPostAnswers).
    private(set) var answers: [(seq: Int, path: String, code: Int, faked: Bool)] = []
    /// POSTs sent and not answered yet (the self-test waits for them before it quits).
    private(set) var inFlight = 0
    /// The self-test's answers to some POSTs (sidetest.mjs --screen start): kept in sentBodies, never sent.
    var testPostAnswers: [String: (Int, [String: Any])] = [:]
    /// The self-test's: the board taken as not running where a click needs it (Try it).
    var testDown = false
    var testCheckpoints: [[String: Any]]? {
        didSet {
            guard let s = state else { return }
            var r = s.raw
            r["checkpoints"] = testCheckpoints ?? []
            if let f = testPatch { r = f(r) }
            hubRaw = r
            state = HubState(withLocal(r))
            onState?(state!)
        }
    }
    /// The last state as the hub sent it (filled for an older hub, the self-test's changes made), before this window's daemons' checkpoints.
    private(set) var hubRaw: [String: Any]?

    // MARK: the checkpoints this window's daemons hold (LocalCheckpoints.swift)

    let daemonCps = DaemonCheckpoints()
    /// The cards that closed while this window watched (LocalCheckpoints.swift ClosedCards).
    let closed = ClosedCards()
    /// The open checkpoints of the last state built, by id: one gone from the next with no word of how is asked of the hub.
    private var openSeen: [String: [String: Any]] = [:]
    /// The ids asked of the hub's recent closed ones (GET /api/checkpoints?all), once each.
    private var askedClosed = Set<String>()
    /// A daemon's checkpoint opened while the hub has sent no state yet (the board down from the start): the ids.
    var onLocal: (([String]) -> Void)?
    /// A daemon's connection by its socket, while the window has it (Workspace).
    var daemonConn: (String) -> Connection? = { _ in nil }
    /// The self-test's: the daemon's answer to checkpoint.answer replaced by this error code (forbidden, not_found).
    var testDaemonError: String?
    /// The hub's own code for a daemon's copies (OlderHub's, on the main thread only), and the words it made, by "<id>|<state>".
    private lazy var wordsJS = OlderHub()
    private var wordsMade: [String: [String: Any]] = [:]

    /// Every checkpoint this window knows: the state's (the daemons' in it), else the daemons' alone; nil when neither has said anything.
    var checkpoints: [[String: Any]]? {
        if let s = state { return s.checkpoints }
        return daemonCps.items.isEmpty ? nil : worded(daemonCps.merged([]))
    }
    func checkpoint(id: String) -> [String: Any]? { checkpoints?.first { $0["id"] as? String == id } }

    /// The card a session's panel shows: its open checkpoint, else the last
    /// that closed in its pane while this window watched (app.ts cpOfSession).
    func card(of p: HubProject, _ s: HubSession) -> [String: Any]? {
        if let c = state?.checkpoint(of: p, s) { return c }
        guard let pane = s.pane else { return nil }
        return closed.forPane(pane, machine: s.machine ?? p.machine)
    }
    /// A shell's: its open checkpoint, else the last that closed there (checkpoints.ts forPane).
    func card(pane: String) -> [String: Any]? { checkpoint(pane: pane) ?? closed.forPane(pane, machine: nil) }
    /// A loose card's (a page's run): open, else how it ended.
    func card(id: String) -> [String: Any]? {
        if let c = checkpoint(id: id), DaemonCheckpoints.isOpen(c) { return c }
        return closed.get(id) ?? checkpoint(id: id)
    }
    /// The agent in a pane reported again: the cards that closed there before go (app.ts agent.report, checkpoints.ts settle).
    func settle(pane: String, since: Date) { closed.settle(pane: pane, since: since) }
    /// An open checkpoint from a pane of this computer's daemons, the oldest first.
    func checkpoint(pane: String) -> [String: Any]? {
        (checkpoints ?? []).filter { ["open", "running"].contains($0["state"] as? String ?? "") && $0["pane"] as? String == pane && $0["machine"] as? String == nil }
            .sorted { ($0["created_at"] as? String ?? "") < ($1["created_at"] as? String ?? "") }.first
    }

    /// A checkpoint a daemon of this window reported (its list, an event), on the main thread.
    func daemonCheckpoint(_ cp: [String: Any], socket: String) {
        let opened = daemonCps.put(cp, socket: socket)
        localChanged(opened ? [cp["id"] as? String ?? ""] : [])
    }

    /// A daemon went away: its checkpoints with it.
    func dropDaemon(_ socket: String) {
        let had = daemonCps.items.count
        daemonCps.drop(socket: socket)
        if daemonCps.items.count != had { localChanged([]) }
    }

    private func localChanged(_ opened: [String]) {
        if let r = hubRaw {
            let st = HubState(withLocal(r))
            state = st
            onState?(st)
        } else {
            // The board down from the start: the daemons' alone, closed cards noted all the same.
            _ = noteClosed(worded(daemonCps.merged([])))
            onLocal?(opened.filter { !$0.isEmpty })
        }
    }

    /// The hub's state with this window's daemons' checkpoints merged in, and how the ones that closed ended.
    private func withLocal(_ raw: [String: Any]) -> [String: Any] {
        var r = raw
        let list = raw["checkpoints"] as? [[String: Any]] ?? []
        r["checkpoints"] = noteClosed(daemonCps.items.isEmpty ? list : worded(daemonCps.merged(list)))
        return r
    }

    /// Notes the checkpoints that closed (ClosedCards) and keeps them closed:
    /// a late open copy of one this window saw close is its closed copy (a
    /// checkpoint only moves on); one that was open and left the list with
    /// no word of how (answered on the phone, withdrawn, out of time, on a
    /// machine) is asked of the hub's recent closed ones (app.ts closedOnHub).
    private func noteClosed(_ list: [[String: Any]]) -> [[String: Any]] {
        var out: [[String: Any]] = []
        var openNow: [String: [String: Any]] = [:]
        var listed = Set<String>()
        for c in list {
            guard let id = c["id"] as? String else { out.append(c); continue }
            listed.insert(id)
            if DaemonCheckpoints.isOpen(c) {
                // Lost (its daemon went away) is the one closed state that opens again, when that daemon lists it again.
                if let done = closed.get(id), done["state"] as? String != "lost" { out.append(done); continue }
                openNow[id] = c
            } else if openSeen[id] != nil || closed.items[id] != nil {
                closed.saw(c)
            }
            out.append(c)
        }
        let gone = openSeen.keys.filter { !listed.contains($0) && closed.items[$0] == nil && !askedClosed.contains($0) }
        openSeen = openNow
        if !gone.isEmpty { askClosed(Array(gone)) }
        return out
    }

    private func askClosed(_ ids: [String]) {
        askedClosed.formUnion(ids)
        guard base != nil else { return }
        get("/api/checkpoints?all") { [weak self] code, j in
            guard let self, code == 200 else { return }
            var any = false
            for cp in j["checkpoints"] as? [[String: Any]] ?? [] where ids.contains(cp["id"] as? String ?? "") {
                if self.closed.saw(cp) { any = true }
            }
            if any { self.localChanged([]) }
        }
    }

    /// A closed copy an answer returned (the hub's, worded): its card says how it ended at once.
    private func answered(_ cp: [String: Any]?) {
        guard let cp, closed.saw(cp) else { return }
        localChanged([])
    }

    /// Each checkpoint with words for its state: the hub's, else made here by the hub's own code (cpwords.mjs wordsOf).
    private func worded(_ list: [[String: Any]]) -> [[String: Any]] {
        func key(_ c: [String: Any]) -> String { "\(c["id"] as? String ?? "")|\(c["state"] as? String ?? "")" }
        func lacks(_ c: [String: Any]) -> Bool { (c["words"] as? [String: Any])?["state"] as? String != c["state"] as? String }
        let lacking = list.filter { lacks($0) && wordsMade[key($0)] == nil }
        if !lacking.isEmpty {
            let bare = lacking.map { c -> [String: Any] in var x = c; x["words"] = nil; return x }
            let filled = wordsJS.fill(["sidebar": [:] as [String: Any], "projects": [] as [Any], "checkpoints": bare])["checkpoints"] as? [[String: Any]] ?? []
            for c in filled { if let w = c["words"] as? [String: Any] { wordsMade[key(c)] = w } }
        }
        return list.map { c in
            guard lacks(c), let w = wordsMade[key(c)] else { return c }
            var x = c
            x["words"] = w
            return x
        }
    }

    /// Answers a checkpoint as the Electron app does (app.ts answerCp):
    /// through the daemon of this window that holds it, else through the
    /// hub. `done` gets whether it was taken, else the words to show.
    func answerCheckpoint(_ id: String, _ reply: [String: Any], _ done: @escaping (Bool, String?) -> Void) {
        let hubHas = (hubRaw?["checkpoints"] as? [[String: Any]])?.contains { $0["id"] as? String == id } ?? false
        if let sock = daemonCps.socket(of: id) {
            if let c = daemonConn(sock) {
                var params = reply
                params["checkpoint"] = id
                params["by"] = "desktop"
                var kept = params
                if let sec = kept["secret"] as? String { kept["secret"] = "(\(sec.count) characters)" }
                sent.append("ravenryd checkpoint.answer")
                sentBodies.append(("ravenryd checkpoint.answer", kept))
                let edited = reply["command"] != nil || reply["reason"] != nil
                let finish: (Result<[String: Any], ConnectionError>) -> Void = { [weak self] r in
                    guard let self else { return }
                    switch r {
                    case .success(let j):
                        if let cp = j["checkpoint"] as? [String: Any] { self.daemonCheckpoint(cp, socket: sock) }
                        done(true, nil)
                    case .failure(let e):
                        if case .daemon(let code, let msg) = e {
                            if code == "forbidden" { self.daemonCps.notPerson.insert(sock); done(false, t("checkpoint.notPerson")); return }
                            if code == "not_found" { done(false, t("checkpoint.closedAlready")); return }
                            // Older only when it says it does not know the field (Go's decoder: unknown field "command");
                            // else it refused what was written (a command over 8 KiB, a reason too long), in its own words.
                            if code == "bad_request" && edited && msg.contains("unknown field") { done(false, t("checkpoint.oldDaemon", ["why": msg])); return }
                            if code == "bad_request" && edited { done(false, t("checkpoint.daemonFailed", ["why": msg])); return }
                        }
                        if !hubHas { done(false, t("checkpoint.daemonFailed", ["why": "\(e)"])); return }
                        self.answerOnHub(id, reply, done)
                    }
                }
                if let code = testDaemonError {
                    DispatchQueue.main.async { finish(.failure(.daemon(code: code, message: "the self-test's \(code)"))) }
                    return
                }
                c.request("checkpoint.answer", params) { r in DispatchQueue.main.async { finish(r) } }
                return
            }
            if !hubHas { DispatchQueue.main.async { done(false, t("checkpoint.daemonGone")) }; return }
        }
        answerOnHub(id, reply, done)
    }

    private func answerOnHub(_ id: String, _ reply: [String: Any], _ done: @escaping (Bool, String?) -> Void) {
        var body = reply
        body["id"] = id
        body["by"] = "desktop"
        post("/api/checkpoints/answer", body) { code, j in
            if code == 200 { self.answered(j["checkpoint"] as? [String: Any]); done(true, nil); return }
            // The hub takes answers from a person only (refusedAsPerson): this window was started from inside a pane.
            if code == 403, j["notPerson"] as? Bool == true { done(false, t("checkpoint.notPerson")); return }
            done(false, t("checkpoint.failed", ["why": j["error"] as? String ?? "the board answered \(code)"]))
        }
    }
    private var session: URLSession!
    private var task: URLSessionDataTask?
    private var buf = Data()
    private var startedAt = Date()
    private var retry: TimeInterval = 1
    private var stopped = false
    private let readOnly: Bool
    /// The board.json to read the port from, when the hub is found, not named.
    private let boardFile: String?
    /// Each reconnect scheduled carries the count at its scheduling: a later one (a wake) cancels it.
    private var gen = 0
    /// The hub's own code, for a hub older than state.sidebar (OlderHub.swift).
    private lazy var older = OlderHub()

    init(offscreen: Bool, env: [String: String] = ProcessInfo.processInfo.environment) {
        let testHome = env["RAVENRY_HOME"].flatMap { $0.isEmpty ? nil : $0 }
        if let u = env["RAVENRY_HUB_URL"], !u.isEmpty {
            base = URL(string: u.hasSuffix("/") ? String(u.dropLast()) : u); named = true; boardFile = nil
        } else if offscreen && testHome == nil {
            // Off every screen, never the person's hub; a test's RAVENRY_HOME is read (its board.json).
            base = nil; named = false; boardFile = nil
        } else {
            boardFile = (testHome ?? (NSHomeDirectory() + "/.ravenry")) + "/board.json"
            named = false
            // No board.json: the default port, except off every screen (a test's
            // home), where it would be the person's board.
            base = HubClient.boardURL(boardFile!) ?? (offscreen ? nil : URL(string: "http://127.0.0.1:4600"))
        }
        readOnly = env["RAVENRY_MAC_HUB_READONLY"] == "1"
        super.init()
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 3600 * 24
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }

    var url: String { base?.absoluteString ?? "" }

    /// The port the running board wrote to board.json (hub/server/index.mjs, hooks/events.mjs), or nil
    /// when there is none: a board that stopped takes its board.json away, and the
    /// window then keeps the address it had (never the default 4600 in its place).
    static func boardURL(_ file: String) -> URL? {
        guard let d = try? Data(contentsOf: URL(fileURLWithPath: file)),
              let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], let p = (j["port"] as? NSNumber)?.intValue, p > 0, p < 65536 else { return nil }
        return URL(string: "http://127.0.0.1:\(p)")
    }

    /// The Mac woke (A11Y-012), or the hub is to be read again at once: the
    /// stream opened again now, a full state with it, then every 250 ms for
    /// 15 s while it does not answer.
    func reconnectNow(_ why: String) {
        DispatchQueue.main.async { [self] in
            guard !stopped, base != nil || boardFile != nil else { return }
            AppLog.write("hub: reading the board again (\(why))")
            startedAt = Date()
            retry = 1
            gen += 1
            let old = task
            task = nil
            old?.cancel()
            connect()
        }
    }
    func start() {
        guard base != nil || boardFile != nil else { return }
        startedAt = Date()
        connect()
    }

    func stop() { stopped = true; task?.cancel() }

    private func connect() {
        if let f = boardFile, let u = HubClient.boardURL(f), u != base {
            AppLog.write("hub: the board is at \(u.absoluteString) now (was \(base?.absoluteString ?? "none"))")
            base = u
        }
        guard !stopped else { return }
        guard let b = base else {
            // Off every screen with no board.json yet: looked for again in a moment.
            gen += 1
            let g = gen
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self, self.gen == g else { return }
                self.connect()
            }
            return
        }
        // ?app=1: the app's own stream, which the hub sends Mac notifications to (hub/server/desktop.mjs pickApp).
        // A read-only window cannot answer, so it never asks for them.
        var r = URLRequest(url: URL(string: b.absoluteString + (readOnly ? "/api/events" : "/api/events?app=1&client=\(client)")) ?? b.appendingPathComponent("api/events"))
        r.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        buf = Data()
        task = session.dataTask(with: r)
        streamStarts += 1
        task?.resume()
    }

    private func setReachable(_ v: Bool) {
        guard v != reachable else { return }
        reachable = v
        DispatchQueue.main.async { self.onStatus?(v) }
    }

    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        let ok = code == 200
        if ok { retry = 1; setReachable(true) }
        if ok, waitingFor != nil { waitingFor = nil; waitingFolder = nil; waitingPath = nil; DispatchQueue.main.async { self.onStatus?(true) } }
        // Starting: macOS may be asking whether Ravenry may read a folder;
        // every route says which until the person answers.
        if code == 503, let b = base {
            URLSession.shared.dataTask(with: b.appendingPathComponent("api/state")) { [weak self] d, _, _ in
                guard let self, let d, let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return }
                let w = j["waitingFor"] as? String, f = j["folder"] as? String, p = j["path"] as? String
                let st = j["starting"] as? Bool == true
                DispatchQueue.main.async {
                    guard w != self.waitingFor || f != self.waitingFolder || st != self.starting || p != self.waitingPath else { return }
                    self.starting = st
                    self.waitingFor = w
                    self.waitingFolder = f
                    self.waitingPath = p
                    self.onStatus?(self.reachable)
                }
            }.resume()
        }
        completionHandler(ok ? .allow : .cancel)
    }

    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard dataTask === task else { return }
        buf.append(data)
        let sep = Data("\n\n".utf8)
        while let r = buf.range(of: sep) {
            let block = String(decoding: buf[buf.startIndex..<r.lowerBound], as: UTF8.self)
            buf.removeSubrange(buf.startIndex..<r.upperBound)
            var event = "message", lines: [String] = []
            for l in block.split(separator: "\n", omittingEmptySubsequences: false) {
                if l.isEmpty || l.hasPrefix(":") { continue }
                let parts = l.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
                let f = String(parts[0])
                var v = parts.count > 1 ? String(parts[1]) : ""
                if v.hasPrefix(" ") { v.removeFirst() }
                if f == "event" { event = v } else if f == "data" { lines.append(v) }
            }
            if event == "notify", let j = (try? JSONSerialization.jsonObject(with: Data(lines.joined(separator: "\n").utf8))) as? [String: Any] {
                DispatchQueue.main.async { self.onNotify?(j) }
                continue
            }
            if event == "decision", let j = (try? JSONSerialization.jsonObject(with: Data(lines.joined(separator: "\n").utf8))) as? [String: Any] {
                DispatchQueue.main.async { self.onDecision?(j) }
                continue
            }
            guard event == "state", !lines.isEmpty,
                  let j = (try? JSONSerialization.jsonObject(with: Data(lines.joined(separator: "\n").utf8))) as? [String: Any] else { continue }
            var full = older.fill(j)
            if let fx = testCheckpoints { full["checkpoints"] = fx }
            if let f = testPatch { full = f(full) }
            // The hub's state before its first read of the board: generatedAt null, error "starting".
            let starting = (j["generatedAt"] == nil || j["generatedAt"] is NSNull) && (j["starting"] as? Bool == true || j["error"] as? String == "starting")
            // Past its first state the hub serves without a folder macOS has not answered for
            // (hub/server/access.mjs): the state's access.waiting names it, as the 503 did.
            let aw = starting ? nil : ((full["access"] as? [String: Any])?["waiting"] as? [String: Any])
            DispatchQueue.main.async {
                self.starting = starting
                if !starting {
                    self.waitingFor = aw?["folder"] as? String
                    self.waitingFolder = aw?["name"] as? String
                    self.waitingPath = aw?["path"] as? String
                }
                self.hubRaw = full
                let st = HubState(self.withLocal(full))
                self.state = st
                self.onState?(st)
            }
        }
    }

    func urlSession(_ s: URLSession, task t: URLSessionTask, didCompleteWithError error: Error?) {
        DispatchQueue.main.async { [self] in
            guard t === task, !stopped else { return }
            // A drop after the board answered (its service started again, an
            // update): read again every 250 ms for 15 s from the drop, as at
            // launch, so the sidebar is back within a second of the new hub (HUB-010).
            if reachable { startedAt = Date(); retry = 1 }
            setReachable(false)
            // As the desktop: every 250 ms in the first 15 s, then backing off to 10 s.
            let early = Date().timeIntervalSince(startedAt) < 15
            let wait = early ? 0.25 : retry
            if !early { retry = min(retry * 2, 10) }
            gen += 1
            let g = gen
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
                guard let self, self.gen == g else { return }
                self.connect()
            }
        }
    }

    /// GET a JSON answer; the callback runs on the main thread.
    func get(_ path: String, _ done: @escaping (Int, [String: Any]) -> Void) {
        if let a = testAnswers[path] { DispatchQueue.main.async { done(200, a) }; return }
        guard let b = base, let u = URL(string: b.absoluteString + path) else { done(0, ["error": "No board."]); return }
        var r = URLRequest(url: u); r.timeoutInterval = 15
        session.dataTask(with: r) { d, resp, e in
            let j = d.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] } ?? (e.map { ["error": $0.localizedDescription] } ?? [:])
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            DispatchQueue.main.async { done(code, j) }
        }.resume()
    }

    /// GET bytes (a picture).
    func data(_ path: String, _ done: @escaping (Data?) -> Void) {
        guard let b = base, let u = URL(string: b.absoluteString + path) else { done(nil); return }
        session.dataTask(with: u) { d, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok ? d : nil) }
        }.resume()
    }

    /// A file of the hub with its type (a pick's video, PickVideo.swift), on the main thread; nil: the hub did not give it.
    func file(_ path: String, _ done: @escaping (Data?, String?) -> Void) {
        guard let b = base, let u = URL(string: b.absoluteString + path) else { done(nil, nil); return }
        var r = URLRequest(url: u)
        r.timeoutInterval = 300
        session.dataTask(with: r) { d, resp, _ in
            let h = resp as? HTTPURLResponse
            let ok = h?.statusCode == 200
            DispatchQueue.main.async { done(ok ? d : nil, h?.value(forHTTPHeaderField: "Content-Type")) }
        }.resume()
    }

    // MARK: pictures, read once (2026-11-12)

    /// A picture already read, by its URL: a view made again on a redraw (the
    /// panel's latest picture, a pick's pictures) draws it at once and asks
    /// the hub for nothing. Each URL names one picture: the hub puts the
    /// file's time in it (pictures.mjs urlFor, index.mjs briefFor), a pick's
    /// pictures never change, so a new picture is a new URL and is read.
    /// At most `keepPictures` pictures and `keepPictureBytes` of pixels, the
    /// ones drawn least lately going first.
    private var pictures: [String: (img: NSImage, bytes: Int)] = [:]
    private var pictureOrder: [String] = []
    private var pictureBytes = 0
    private var pictureWaits: [String: [(NSImage?) -> Void]] = [:]
    let keepPictures = 32, keepPictureBytes = 96 << 20
    /// Every picture URL asked of the hub, in order (the self-test counts them).
    private(set) var pictureReads: [String] = []

    /// The picture at `path`: at once when it was read before (and `done`
    /// is not called), else nil, and `done` on the main thread once it is
    /// read (nil: the hub did not give it). One read at a time per URL.
    func picture(_ path: String, _ done: @escaping (NSImage?) -> Void) -> NSImage? {
        if let p = pictures[path] {
            if pictureOrder.last != path { pictureOrder.removeAll { $0 == path }; pictureOrder.append(path) }
            return p.img
        }
        if pictureWaits[path] != nil { pictureWaits[path]?.append(done); return nil }
        pictureWaits[path] = [done]
        pictureReads.append(path)
        data(path) { [weak self] d in
            guard let self else { return }
            let img = d.flatMap(NSImage.init(data:))
            if let img { self.keepPicture(path, img) }
            for f in self.pictureWaits.removeValue(forKey: path) ?? [] { f(img) }
        }
        return nil
    }

    private func keepPicture(_ path: String, _ img: NSImage) {
        // Its pixels' size, decoded (4 bytes a pixel).
        let px = img.representations.map { $0.pixelsWide * $0.pixelsHigh }.max() ?? 0
        let bytes = max(px, Int(img.size.width * img.size.height), 1) * 4
        if let old = pictures[path] { pictureBytes -= old.bytes; pictureOrder.removeAll { $0 == path } }
        pictures[path] = (img, bytes)
        pictureOrder.append(path)
        pictureBytes += bytes
        while pictureOrder.count > 1, pictureOrder.count > keepPictures || pictureBytes > keepPictureBytes {
            let gone = pictureOrder.removeFirst()
            pictureBytes -= pictures.removeValue(forKey: gone)?.bytes ?? 0
        }
    }

    /// POST where the person is (POST /api/opened, hub/server/openon.mjs): bookkeeping that answers
    /// no agent, kept out of `sent`, which lists what the person's clicks asked for.
    func postOpened(_ body: [String: Any], _ done: @escaping (Int) -> Void) {
        opened.append(body)
        guard !readOnly, let b = base, let u = URL(string: b.absoluteString + "/api/opened") else { done(0); return }
        var r = URLRequest(url: u)
        r.httpMethod = "POST"
        r.timeoutInterval = 20
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.setValue("1", forHTTPHeaderField: "X-Ravenry")
        r.httpBody = try? JSONSerialization.data(withJSONObject: body)
        session.dataTask(with: r) { _, resp, _ in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            DispatchQueue.main.async { done(code) }
        }.resume()
    }
    /// Every open told to the hub (postOpened), for the self-test.
    private(set) var opened: [[String: Any]] = []

    /// POST what the person clicked, as the board's page does.
    func post(_ path: String, _ body: [String: Any], _ done: @escaping (Int, [String: Any]) -> Void) {
        sent.append("POST \(path)")
        var kept = body
        if let sec = kept["secret"] as? String { kept["secret"] = "(\(sec.count) characters)" }
        sentBodies.append((path, kept))
        let seq = sent.count - 1
        if let a = testPostAnswers[path] { answers.append((seq, path, a.0, true)); DispatchQueue.main.async { done(a.0, a.1) }; return }
        guard !readOnly else { answers.append((seq, path, 0, false)); done(0, ["error": "This window is read only (RAVENRY_MAC_HUB_READONLY)."]); return }
        guard let b = base, let u = URL(string: b.absoluteString + path) else { answers.append((seq, path, 0, false)); done(0, ["error": "No board."]); return }
        inFlight += 1
        var r = URLRequest(url: u)
        r.httpMethod = "POST"
        r.timeoutInterval = 60
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.setValue("1", forHTTPHeaderField: "X-Ravenry")
        r.httpBody = try? JSONSerialization.data(withJSONObject: body)
        session.dataTask(with: r) { d, resp, e in
            let j = d.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] } ?? (e.map { ["error": $0.localizedDescription] } ?? [:])
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            DispatchQueue.main.async {
                self.inFlight -= 1
                self.answers.append((seq, path, code, false))
                done(code, j)
            }
        }.resume()
    }
}
