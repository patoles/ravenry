// The window's tabs and splits, as the Electron app's terminal area has
// them (apps/desktop/src/renderer/app.ts: newShell, splitNew, closeTab,
// removeTab, stepTab, focus-pane, layoutSplit, restoreTabs, save):
//
// - A tab per pane: the daemon's panes labelled ravenry.kind: shell (this
//   window's: a second window's carry its id, ravenry.window, as the
//   Electron app's do), its agents' own panes, and a session's pane once
//   opened (the hub's New session, Continue, Move here, a click in the
//   sidebar). A shell another client makes for this window is a tab at
//   once. Each is named as the Electron app names it (tabLabel): a pane
//   the board follows as a session reads as that session (its topic, its
//   project in grey, its state's dot), an assistant the app started as
//   that assistant, else shellLabel (the pane's own name, else the
//   program's title, else the program; its folder after it). After a
//   relaunch every running pane that was a tab is one again (restore).
// - Cmd+T or the + opens a shell in the folder of the pane in front;
//   Cmd+W closes the pane with the keyboard (its tab, or its split's
//   pane, the tab whole again) and ends its process, a shell's or an
//   agent's own pane's: a session's tab only goes, the session goes on
//   (the sidebar opens it again). The last tab gone, the window says
//   "No shell is open" with New shell, as the Electron app's. Cmd+1 to
//   Cmd+9, Cmd+Shift+[ and ], Ctrl+Tab and Ctrl+Shift+Tab pick a tab; a
//   tab is dragged along the strip, or down onto an edge of the pane in
//   front to split it with that tab.
// - One split per tab: Cmd+D a new shell on the right, Cmd+Shift+D
//   below, with the keyboard (a new tab when the tab is split already);
//   Cmd+Option+arrows or a click move the keyboard; the divider is
//   dragged, a double click or Cmd+Ctrl+= evens it; Cmd+Shift+Enter
//   shows the pane with the keyboard alone, and back.
// - Each pane is its own render stream. A tab not in front has none and
//   draws nothing; brought to the front, its panes draw the rows they
//   had at once and open their streams again. A pane never drawn yet is
//   laid out under the tab in front and takes its place once its first
//   frame came (at most 300 ms), so a switch never shows a blank pane.
// - The order, the splits and the tab in front are kept in the Electron
//   app's window.json (Layout.swift), so both apps agree.
// - The panes of every daemon the window draws (Daemons.swift) are tabs
//   alike: each pane talks to its own daemon (conn(of:)), new ones go to
//   the newest.

import AppKit

/// What the window knows of a pane, from pane.list and the daemon's
/// events.
final class PaneInfo {
    let id: String
    var name = ""
    var title = ""
    var cwd = ""
    var command: [String] = []
    var createdAt = ""
    /// The lines the daemon keeps of it (0: not said).
    var scrollback = 0
    /// When it last printed (the daemon's last_output_at): Learn's filmstrip card picks the busiest.
    var lastOutput = ""
    /// Who made it (a Source: the person, an agent in its pane, a program).
    var creator: [String: Any]?
    /// An agent's lease on it, with who waits (pane.lease).
    var lease: [String: Any]?
    var labels: [String: String] = [:]
    /// The assistant its agent reported (pane.agent), and its state (needs_you, working, idle).
    var agent: String?
    var agentState: String?
    /// What its agent last reported, whole (pane.agent: state, since, assistant, need).
    var report: [String: Any]?

    init(id: String) { self.id = id }

    func update(_ p: [String: Any]) {
        if let v = p["name"] as? String { name = v }
        if let v = p["title"] as? String { title = v }
        if let v = p["cwd"] as? String { cwd = v }
        if let v = p["command"] as? [String] { command = v }
        if let v = p["created_at"] as? String { createdAt = v }
        if let v = p["last_output_at"] as? String { lastOutput = v }
        if let v = p["scrollback"] as? NSNumber { scrollback = v.intValue }
        if let v = p["creator"] as? [String: Any] { creator = v }
        if let v = p["labels"] as? [String: String] { labels = v }
        if let a = p["agent"] as? [String: Any] { agent = a["assistant"] as? String ?? agent; agentState = a["state"] as? String; report = a }
        if p["lease"] != nil { lease = p["lease"] as? [String: Any] }
    }
}

/// A tab: its pane, and the pane beside it when split.
final class Tab {
    var host: String
    var guest: String?
    /// Where the guest is: right, left, down or up.
    var side = "right"
    /// The host's share, in percent.
    var size: Double = 50
    /// 1 when the guest has the keyboard.
    var focus = 0
    var zoom = false

    init(host: String) { self.host = host }
    var id: String { "s:" + host }
    var focusedPane: String { focus == 1 ? (guest ?? host) : host }
}

/// An agent's own pane: made by an agent in a pane, shown, running, not a shell (the Electron app's agentPane).
func isAgentPane(_ p: [String: Any]) -> Bool {
    let c = p["creator"] as? [String: Any]
    return c?["kind"] as? String == "agent" && (c?["pane"] as? String) != nil && !(p["hidden"] as? Bool ?? false)
        && (p["state"] as? String ?? "running") == "running" && (p["labels"] as? [String: String])?["ravenry.kind"] != "shell"
}

final class Workspace: NSObject {
    let window: TerminalWindow
    let options: Options
    /// Every daemon the window draws (Daemons.swift).
    let daemons: Daemons
    /// The newest daemon's connection: where new panes go.
    var conn: Connection { daemons.newest?.conn ?? firstConn }
    private let firstConn: Connection
    /// Whose each pane is: the daemon it runs in.
    private var homes: [String: DaemonLink] = [:]
    /// The connection of a pane's own daemon (its keys, its close, its panel).
    func conn(of pane: String) -> Connection { homes[pane]?.conn ?? conn }
    /// The daemon a pane runs in.
    func daemon(of pane: String) -> DaemonLink? { homes[pane] }
    let root = RootView()
    let bar = TabBar()
    let stage = StageView()
    private(set) var tabs: [Tab] = []
    private(set) var active: Tab?
    private var info: [String: PaneInfo] = [:]
    private(set) var boxes: [String: PaneBox] = [:]
    private var shown: NSView?
    private var shownTab: Tab?
    private var pending: (tab: Tab, view: NSView, timer: DispatchWorkItem)?
    private let layout: LayoutStore?
    let scale: CGFloat
    var closing = false
    /// The terminal settings both apps share (Settings.swift), and what
    /// they make of a terminal now (TermLook.swift).
    let settings: SettingsStore
    private(set) var look: TermLook
    /// The command line's --font, --font-size and --option-as-alt: for
    /// this run, until the setting changes.
    private var pins: [String: Any] = [:]
    private var lastValues: [String: Any] = [:]
    private var appearanceWatch: NSKeyValueObservation?
    /// What closing a busy shell asked, when a test answered it (closeAnswer).
    private(set) var closeAsked: [String] = []
    /// A test's answer to "Close this tab?" for this window, in place of the
    /// sheet; nil (the default, off every screen too): the real sheet, on the
    /// window wherever it is (TERM-016's check presses its buttons).
    var closeAnswer: (close: Bool, dont: Bool)?
    /// The same for every window (the self-tests that close busy panes on the way).
    static var testCloseAnswer: (close: Bool, dont: Bool)?
    /// The bells of panes not on screen that rang a sound or the Dock (offscreen).
    private(set) var bellsHeard: [String] = []
    /// Each switch's times: to the first draw of the tab in front, and to
    /// the first frame of its new streams (the bench reads them).
    var onSwitch: ((_ tab: String, _ drawnMs: Double, _ frameMs: Double, _ hadRows: Bool) -> Void)?
    let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()

    /// This window's id on its shells (ravenry.window); nil for the first
    /// window, whose shells carry none (the Electron app's thisWindow).
    let windowId: String?

    init(window: TerminalWindow, options: Options, daemons: Daemons, scale: CGFloat, windowId: String? = nil) {
        self.window = window
        self.options = options
        self.windowId = windowId
        self.daemons = daemons
        let conn = daemons.newest!.conn
        firstConn = conn
        self.scale = scale
        settings = SettingsStore(offscreen: options.offscreen)
        if let f = options.font { pins["fontFamily"] = f }
        if let z = options.fontSize { pins["fontSize"] = Int(min(TerminalView.fontSizeRange.upperBound, max(TerminalView.fontSizeRange.lowerBound, z.rounded()))) }
        if !options.optionAsAlt.isEmpty { pins["optionAsMeta"] = options.optionAsAlt }
        look = TermLook(settings, dark: Workspace.dark, pins: pins)
        lastValues = settings.values
        layout = LayoutStore(offscreen: options.offscreen, socket: conn.socketPath)
        super.init()
        settings.observe { [weak self] in self?.settingsChanged() }
        appearanceWatch = NSApp.observe(\.effectiveAppearance) { [weak self] _, _ in
            DispatchQueue.main.async { self?.applyLook() }
        }
        Design.terminal = look.theme
        root.bar = bar
        root.stage = stage
        root.addSubview(root.sheet)
        root.sheet.addSubview(stage)
        root.sheet.addSubview(bar)
        bar.onSelect = { [weak self] id in self?.select(id: id) }
        bar.onClose = { [weak self] id in
            guard let self, let t = self.tabs.first(where: { $0.id == id }) else { return }
            self.closeTab(t)
        }
        bar.onNew = { [weak self] in self?.newTab(nil) }
        bar.onMove = { [weak self] id, to in self?.move(id: id, to: to) }
        bar.onToggleSidebar = { [weak self] in
            guard let self else { return }
            if let f = self.onToggleSidebar { f() } else { self.menuCommand("menuToggleSidebar:") }
        }
        bar.onTogglePanel = { [weak self] in
            guard let self else { return }
            if let f = self.onTogglePanel { f() } else { self.menuCommand("menuTogglePanel:") }
        }
        bar.onFilm = { [weak self] in self?.toggleFilm() }
        setUpFilm()
        bar.onDragOut = { [weak self] id, p in self?.dragOver(id, p) }
        bar.onDropOut = { [weak self] id, p in self?.dropTab(id, p) ?? false }
        root.workspace = self
    }

    // MARK: the strip's fold buttons

    /// The sidebar's and the panel's fold (Board sets them); unset, the
    /// strip's buttons run the View menu's items, the same commands.
    var onToggleSidebar: (() -> Void)?
    var onTogglePanel: (() -> Void)?

    /// Runs the main menu's item with this action, as a click on it would.
    func menuCommand(_ action: String) {
        guard let i = Workspace.menuItem(NSApp.mainMenu, action: action), let a = i.action else { return }
        NSApp.sendAction(a, to: i.target, from: i)
    }

    static func menuItem(_ m: NSMenu?, action: String) -> NSMenuItem? {
        for i in m?.items ?? [] {
            if let a = i.action, NSStringFromSelector(a) == action { return i }
            if let f = menuItem(i.submenu, action: action) { return f }
        }
        return nil
    }

    // MARK: panes and their views

    var focusedView: TerminalView? { active.flatMap { boxes[$0.focusedPane]?.term } }

    private func box(_ pane: String) -> PaneBox? {
        if let b = boxes[pane] { return b }
        guard let v = TerminalView(frame: stage.bounds, scale: scale, fontName: look.font, fontSize: look.size) else { return nil }
        v.offscreen = options.offscreen && !options.benchLayer
        v.apply(look)
        keepScrollback(pane)
        let fps = options.offscreen && !options.benchOnscreen ? 120 : (NSScreen.main?.maximumFramesPerSecond ?? 60)
        v.refreshInterval = 1.0 / Double(max(fps, 30))
        v.attach(conn(of: pane), pane: pane, fps: fps)
        v.onTitle = { [weak self] t in
            guard let self else { return }
            if let i = self.info[pane], !t.isEmpty || !i.title.isEmpty { i.title = t }
            self.refresh()
        }
        v.onFocus = { [weak self] in self?.focused(pane: pane) }
        // Who typed what the gutter marks (TERM-044): Board's sourceOf.
        v.marks.whoOf = { [weak self] s in self?.whoOf?(s) }
        v.onFontSize = { [weak self] s in self?.setFontSize(s) }
        v.windowMinSize = { [weak self] in self?.minContentSize() ?? .zero }
        // Its menu's Split Right, Split Down (its own tab, not split yet) and Copy Path.
        v.onSplit = { [weak self] side in
            guard let self, let t = self.tabs.first(where: { $0.host == pane || $0.guest == pane }), t.guest == nil else { return }
            if t !== self.active { self.show(t) }
            self.split(side)
        }
        v.canSplit = { [weak self] in self?.tabs.first(where: { $0.host == pane || $0.guest == pane })?.guest == nil }
        v.folderPath = { [weak self] in self?.info[pane].flatMap { $0.cwd.isEmpty ? nil : $0.cwd } }
        let b = PaneBox(term: v)
        b.onClose = { [weak self] in self?.askClose(pane) { self?.closePane(pane) } }
        b.onClickHead = { [weak self, weak v] in if let v { self?.window.makeFirstResponder(v) } }
        boxes[pane] = b
        return b
    }

    /// A pane as the tabs name it (app.ts tabLabel): the session the board
    /// follows in it (its topic, else its project; the project in grey
    /// when that says more); else shellLabel: the assistant the app started
    /// in it (ravenry.agent), its own name (not the default "Shell"), else
    /// the title its program set, else the program; and its folder (~ for
    /// home) when that is not the name.
    func label(_ pane: String) -> (name: String, sub: String?) {
        if let f = session(of: pane) {
            let name = f.session.topic.flatMap { $0.isEmpty ? nil : $0 } ?? f.project.name
            sessionNames[pane] = name
            return (name, name.lowercased() == f.project.name.lowercased() ? nil : f.project.name)
        }
        let i = info[pane] ?? PaneInfo(id: pane)
        // A session the hub started (ravenry.session) that the board does
        // not list, not yet or not for now: the name it had, else
        // "Session" with its folder (app.ts tabLabel, SESS-011).
        if let s = i.labels["ravenry.session"], !s.isEmpty, i.labels["ravenry.kind"] != "shell" {
            if let n = sessionNames[pane] { return (n, nil) }
            return ("Session", i.cwd.isEmpty ? nil : i.cwd == home ? "~" : (i.cwd as NSString).lastPathComponent)
        }
        if let a = i.labels["ravenry.agent"], !a.isEmpty {
            let name = Workspace.assistantName(a)
            let folder = i.cwd.isEmpty ? "" : i.cwd == home ? "~" : (i.cwd as NSString).lastPathComponent
            return (name, folder.isEmpty ? nil : folder)
        }
        let title = i.title.trimmingCharacters(in: .whitespaces)
        let first = i.command.first.map { ($0 as NSString).lastPathComponent } ?? ""
        let prog = first.isEmpty ? "Shell" : first
        let own = !i.name.isEmpty && i.name != "Shell" ? i.name : ""
        let name = !own.isEmpty ? own : !title.isEmpty ? title : prog
        var folder = ""
        if !i.cwd.isEmpty {
            folder = i.cwd == home ? "~" : (i.cwd as NSString).lastPathComponent
        }
        // A pane an agent opened says whose it is ("Claude's"), as its folder would.
        if i.creator?["kind"] as? String == "agent", let who = whoOf?(i.creator!) { return (name, "\(who)'s") }
        let sub = !folder.isEmpty && folder.lowercased() != name.lowercased() ? folder : nil
        return (name, sub)
    }

    /// A session pane's name when the board last listed it (label).
    private var sessionNames: [String: String] = [:]

    /// An assistant as people say it (app.ts assistantName).
    static func assistantName(_ kind: String) -> String {
        kind == "claude" ? "Claude" : kind == "codex" ? "Codex" : kind.prefix(1).uppercased() + kind.dropFirst()
    }

    /// The board (Board sets it; else the app's): which session a pane runs.
    /// It also holds the checkpoints of this window's daemons (LocalCheckpoints.swift): each daemon's list now, its events from here.
    weak var hub: HubClient? {
        didSet {
            hub?.daemonConn = { [weak self] s in self?.daemons.all.first { $0.socket == s }?.conn }
            for d in daemons.all { listCheckpoints(d) }
        }
    }
    /// What a daemon holds now (checkpoint.list): its events only say what changes from here.
    func listCheckpoints(_ d: DaemonLink) {
        guard d.conn.methods.isEmpty || d.conn.methods.contains("checkpoint.list") else { return }
        d.conn.request("checkpoint.list", [:]) { [weak self, weak d] r in
            guard case .success(let j) = r, let list = j["checkpoints"] as? [[String: Any]] else { return }
            DispatchQueue.main.async { if let d { for cp in list { self?.hub?.daemonCheckpoint(cp, socket: d.socket) } } }
        }
    }
    private var hubState: HubState? { (hub ?? (NSApp.delegate as? AppDelegate)?.hub)?.state }

    /// The session the board follows in a pane of this Mac (sessionOfPane).
    func session(of pane: String) -> (project: HubProject, session: HubSession)? {
        guard let st = hubState else { return nil }
        for p in st.projects where p.machine == nil {
            for s in p.sessions where s.pane == pane && s.machine == nil { return (p, s) }
        }
        return nil
    }

    /// A session's own pane (the hub started it: ravenry.session, or it is
    /// neither a shell nor an agent's own pane): closing its tab leaves it
    /// running, as the Electron app's session tabs ("the session goes on").
    func keepsRunning(_ pane: String) -> Bool {
        guard let i = info[pane] else { return false }
        if i.labels["ravenry.kind"] == "shell" { return false }
        if i.creator?["kind"] as? String == "agent", i.creator?["pane"] != nil { return false }
        return true
    }

    // MARK: the start

    /// The tabs the daemons have (their shells, their agents' own panes and
    /// every running pane the window kept as a tab), in the saved order with
    /// the saved splits, the saved one in front; a new shell when none.
    func restore() throws {
        let saved = layout?.read() ?? SavedLayout()
        // Every daemon's, the newest first (a pane id names one pane across daemons).
        var panes: [[String: Any]] = []
        for (k, d) in daemons.all.enumerated() {
            let mine: [[String: Any]]
            do {
                mine = try shells(of: d, kept: saved.order)
            } catch {
                // The newest must answer; an older one that does not is left out.
                if k == 0 { throw error }
                NSLog("RavenryMac: \(d.version) at \(d.socket): \(error)")
                continue
            }
            for p in mine {
                guard let id = p["id"] as? String, homes[id] == nil else { continue }
                homes[id] = d
                panes.append(p)
            }
        }
        for p in panes {
            guard let id = p["id"] as? String else { continue }
            let i = PaneInfo(id: id)
            i.update(p)
            info[id] = i
        }
        var ids = panes.compactMap { $0["id"] as? String }
        ids.sort { (info[$0]?.createdAt ?? "") < (info[$1]?.createdAt ?? "") }
        // A copy: the closure must not read `ids` while `ids.sort` mutates it
        // (Swift's exclusivity check aborts the app on launch otherwise).
        let byAge = ids
        let rank: (String) -> Int = { id in saved.order.firstIndex(of: "s:" + id) ?? (saved.order.count + (byAge.firstIndex(of: id) ?? 0)) }
        ids.sort { rank($0) < rank($1) }
        tabs = ids.map { Tab(host: $0) }
        for sp in saved.splits {
            guard let h = tabs.first(where: { $0.id == sp.host }), let g = tabs.first(where: { $0.id == sp.guest }),
                  h !== g, h.guest == nil, g.guest == nil, ["right", "left", "down", "up"].contains(sp.side) else { continue }
            tabs.removeAll { $0 === g }
            h.guest = g.host
            h.side = sp.side
            h.size = sp.size > 0 && sp.size < 100 ? sp.size : 50
            h.focus = sp.focus == 1 ? 1 : 0
            h.zoom = sp.zoom
        }
        var front = tabs.first { $0.id == saved.active || ("s:" + ($0.guest ?? "")) == saved.active }
        if let a = options.attach { front = tabs.first { $0.host == a || $0.guest == a } ?? front }
        if tabs.isEmpty {
            // In the folder of the shell in front last, while it is there (TERM-068).
            var isDir: ObjCBool = false
            let last = saved.lastCwd.flatMap { FileManager.default.fileExists(atPath: $0, isDirectory: &isDir) && isDir.boolValue ? $0 : nil }
            guard let id = try newPane(cwd: last, size: stage.bounds.size) else { throw ConnectionError.connect("no pane") }
            tabs = [Tab(host: id)]
            // No tab to bring back: the launch opens on New session, with Ink (Ink.swift).
            restoredNone = true
        }
        show(front ?? tabs[0], wait: true)
    }

    /// The launch had no tab to bring back (restore made a new shell).
    private(set) var restoredNone = false

    /// A daemon's tabs: its shells, the pane --attach names, its agents' own
    /// panes, and every running pane the window kept as a tab (`kept`, the
    /// saved order: "s:<pane>"), whoever started it. A session the hub
    /// started (New session, Continue, Move here) is a tab only once opened
    /// (tab(showing:), replace), labelled ravenry.session, not shell: kept by
    /// its id, it comes back after a relaunch as a shell does, so an update
    /// never leaves one running with no tab. A pane never a tab (a session
    /// not opened yet, an agent's hidden pane) stays as it was: the sidebar
    /// opens it.
    private func shells(of d: DaemonLink, kept: [String]) throws -> [[String: Any]] {
        let c = d.conn
        let r = try c.call("pane.list", ["hidden": true])
        let kept = Set(kept)
        let running = (r["panes"] as? [[String: Any]] ?? []).filter { ($0["state"] as? String ?? "running") == "running" }
        return running.filter { p in
            let id = p["id"] as? String ?? ""
            return isOwnShell(p) || id == options.attach || kept.contains("s:" + id) || isAgentPane(p)
        }
    }

    /// A shell of this window: labelled ravenry.kind: shell, shown, and
    /// carrying this window's id (none for the first window), as the
    /// Electron app's windows tell their shells apart.
    func isOwnShell(_ p: [String: Any]) -> Bool {
        let l = p["labels"] as? [String: String] ?? [:]
        return l["ravenry.kind"] == "shell" && !(p["hidden"] as? Bool ?? false) && l["ravenry.window"].flatMap { $0.isEmpty ? nil : $0 } == windowId
    }

    /// A daemon that started after the window (a newer app's, an update):
    /// its shells, its agents' own panes and the panes kept as tabs are tabs
    /// at the end, in the saved order, the tab in front stays.
    func joined(_ d: DaemonLink) {
        let saved = layout?.read() ?? SavedLayout()
        guard let mine = try? shells(of: d, kept: saved.order) else { return }
        var added: [Tab] = []
        for p in mine.sorted(by: { ($0["created_at"] as? String ?? "") < ($1["created_at"] as? String ?? "") }) {
            guard let id = p["id"] as? String, homes[id] == nil, !tabs.contains(where: { $0.host == id || $0.guest == id }) else { continue }
            homes[id] = d
            let i = PaneInfo(id: id)
            i.update(p)
            info[id] = i
            added.append(Tab(host: id))
        }
        let rank: (Tab) -> Int = { t in saved.order.firstIndex(of: t.id) ?? Int.max }
        tabs += added.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map(\.element)
        refresh()
        save()
        listCheckpoints(d)
    }

    /// A daemon went away: its panes' tabs go (their processes went with it).
    func left(_ d: DaemonLink) {
        hub?.dropDaemon(d.socket)
        // The last one gone: the window stays as it was, and says so.
        if daemons.all.isEmpty { window.title = "Ravenry (the daemon went away)"; return }
        let gone = homes.filter { $0.value === d }.map(\.key)
        // Never an empty window: a shell in the newest first when every tab was that daemon's.
        if tabs.allSatisfy({ panes(of: $0).allSatisfy(gone.contains) }) { newTab(in: nil) }
        for id in gone {
            // One a move replaces waits for its new pane (release, else replace).
            if held.contains(id) { endedHeld.insert(id); continue }
            removePane(id)
        }
    }

    /// A new shell in the newest daemon (pane.new), labelled as the app's
    /// shells (with this window's id when it is not the first); or a
    /// program in its place (Start with the board down: the assistant,
    /// named and labelled ravenry.agent, as the Electron app's).
    @discardableResult
    func newPane(cwd: String?, size: NSSize, program: Program? = nil) throws -> String? {
        let r = Renderer(scale: scale, fontName: look.font, fontSize: look.size)
        let g = r?.grid(for: NSSize(width: max(size.width, 160), height: max(size.height, 80))) ?? (cols: 80, rows: 24)
        var labels = ["ravenry.kind": "shell"]
        if let w = windowId { labels["ravenry.window"] = w }
        if let a = program?.agent { labels["ravenry.agent"] = a }
        var params: [String: Any] = ["cols": g.cols, "rows": g.rows, "name": program?.name ?? "Shell", "labels": labels, "scrollback": look.scrollback]
        if let c = program?.command, !c.isEmpty { params["command"] = c } else if !options.command.isEmpty { params["command"] = options.command }
        if let c = cwd, !c.isEmpty { params["cwd"] = c } else if options.bench != nil || options.selftest != nil { params["cwd"] = home }
        let d = daemons.newest
        let res = try conn.call("pane.new", params)
        guard let p = res["pane"] as? [String: Any], let id = p["id"] as? String else { return nil }
        homes[id] = d
        let i = PaneInfo(id: id)
        i.update(p)
        info[id] = i
        return id
    }

    // MARK: showing a tab

    /// Brings a tab to the front. Its panes draw the rows they had at
    /// once and open their streams; a pane that never had a frame waits
    /// under the tab in front for its first one.
    func show(_ t: Tab, wait: Bool = false) {
        let t0 = CACurrentMediaTime()
        if let p = pending {
            p.timer.cancel()
            if p.tab !== t { p.view.removeFromSuperview(); panes(of: p.tab).forEach { if shownTab == nil || !panes(of: shownTab!).contains($0) { boxes[$0]?.term.pause() } } }
            pending = nil
        }
        active = t
        bells.remove(t.id)
        activity.remove(t.id)
        empty.isHidden = true
        let content = build(t)
        content.frame = stage.bounds
        let ids = panes(of: t, visibleOnly: true)
        let fresh = ids.contains { id in boxes[id].map { b in b.term.screen.lock(); defer { b.term.screen.unlock() }; return b.term.screen.frames == 0 } ?? true }
        // Waiting under the tab in front needs one, and another tab.
        let canWait = fresh && !wait && shownTab !== t && shown?.superview === stage
        if !canWait {
            stage.addSubview(content)
            swapTo(t, content)
            report(t, ids, t0, hadRows: !fresh)
            for id in ids { boxes[id]?.term.resume(wait: wait) }
        } else {
            // Under the tab in front until its first frames came.
            stage.addSubview(content, positioned: .below, relativeTo: shown)
            content.layoutSubtreeIfNeeded()
            var left = Set(ids)
            let timer = DispatchWorkItem { [weak self] in self?.finishPending(t) }
            pending = (t, content, timer)
            for id in ids {
                guard let v = boxes[id]?.term else { continue }
                v.onFrame = { [weak self, weak v] in
                    DispatchQueue.main.async {
                        guard let self, let v, let p = self.pending, p.tab === t else { return }
                        v.onFrame = nil
                        left.remove(id)
                        if left.isEmpty { self.finishPending(t) }
                    }
                }
            }
            report(t, ids, t0, hadRows: false)
            for id in ids { boxes[id]?.term.resume() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: timer)
        }
        refresh()
        bar.keepFrontInSight()
        save()
    }

    private func finishPending(_ t: Tab) {
        guard let p = pending, p.tab === t else { return }
        p.timer.cancel()
        pending = nil
        swapTo(t, p.view)
    }

    /// The tab's content in place of the one shown: the old tab's panes
    /// stop their streams, the keyboard goes to the pane that has it.
    private func swapTo(_ t: Tab, _ content: NSView) {
        if let old = shown, old !== content {
            let keep = Set(panes(of: t, visibleOnly: true))
            if let ot = shownTab { for id in panes(of: ot) where !keep.contains(id) { boxes[id]?.term.pause() } }
            // (A pane of the old content may be in the new one: a split
            // made from it.)
            if old.superview === stage { old.removeFromSuperview() }
        }
        shown = content
        shownTab = t
        updateBoxes(t)
        if let v = boxes[t.focusedPane]?.term { window.makeFirstResponder(v) }
        updateMinSize()
        film.follow(t.focusedPane)
        onFront?()
    }

    // MARK: the sidebar's and the panel's (Board.swift)

    /// What the middle shows when it is not a tab's terminal (a session
    /// outside, a page): the extra tab in front (the Electron app's view tab).
    var extraTab: TabModel? {
        get { extraTabs.first { $0.active } }
        set { extraTabs = newValue.map { [$0] } ?? [] }
    }
    /// Every tab that is not a pane's (a read-only session, a pinned one,
    /// a page in front), each right after the tab its `after` names (a
    /// session's own tab, "s:<pane>"), else after the others; the one
    /// `active` is in front (extraTab). Board keeps them, and lists the
    /// ones to keep across a relaunch in `pinned`.
    var extraTabs: [TabModel] = [] { didSet { if extraTabs != oldValue { refresh() } } }
    /// After the tab in front or its pane with the keyboard changed.
    var onFront: (() -> Void)?
    /// The sessions pinned to the tabs, written with the tabs.
    var pinned: [String]?
    /// What was kept: the pinned sessions among them.
    private(set) lazy var saved: SavedLayout = layout?.read() ?? SavedLayout()

    func paneInfo(_ id: String) -> PaneInfo? { info[id] }
    /// Every pane the window knows of in its daemon.
    func paneIDs() -> [String] { info.keys.sorted() }

    /// The tab that shows a pane of this daemon, a tab of its own when no
    /// tab shows it yet (a session's pane: ravenry.session); nil when this
    /// daemon has no such pane.
    func tab(showing pane: String) -> Tab? {
        if let t = tabs.first(where: { $0.host == pane || $0.guest == pane }) {
            if t.guest == pane { t.focus = 1 } else if t.guest != nil { t.focus = 0 }
            return t
        }
        guard adopt(pane) else { return nil }
        let t = Tab(host: pane)
        tabs.append(t)
        return t
    }

    /// A running pane of any daemon the window draws (the newest first),
    /// known here from now on: its daemon and what pane.list says of it.
    private func adopt(_ pane: String) -> Bool {
        if info[pane] != nil { return true }
        for d in daemons.all {
            guard let r = try? d.conn.call("pane.list", ["hidden": true], timeout: 3),
                  let p = (r["panes"] as? [[String: Any]] ?? []).first(where: { $0["id"] as? String == pane && ($0["state"] as? String ?? "running") == "running" }) else { continue }
            homes[pane] = d
            let i = PaneInfo(id: pane)
            i.update(p)
            info[pane] = i
            return true
        }
        return false
    }

    // MARK: a move's new pane in the old one's place

    /// Panes a move is replacing (Board.move): when one ends, or its daemon
    /// goes, its tab stays, showing what it last drew, until the new pane
    /// takes its place or the move is over.
    private var held: Set<String> = []
    private var endedHeld: Set<String> = []
    func hold(_ pane: String) { held.insert(pane) }
    /// The move is over: a held pane that ended meanwhile, and was not
    /// replaced, goes now.
    func release(_ pane: String) {
        held.remove(pane)
        if endedHeld.remove(pane) != nil, info[pane] != nil { closePane(pane) }
    }

    /// The hub's move resumed a session in a new pane (`new`, on the newest
    /// daemon) and names the old one it replaces: the new pane takes the
    /// old one's place in its tab, at the same position in the strip, split
    /// or not; the old one is forgotten here (the hub closes it). The old
    /// pane's last picture stays until the new one drew (at most 300 ms).
    /// nil when no tab shows the old pane or the new one is not running.
    func replace(_ old: String, with new: String) -> Tab? {
        guard old != new, let t = tabs.first(where: { $0.host == old || $0.guest == old }), adopt(new) else { return nil }
        // A tab of its own already (one came first): it goes, the old place stays.
        var front = t === active
        if let o = tabs.firstIndex(where: { $0 !== t && ($0.host == new || $0.guest == new) }) {
            guard tabs[o].guest == nil else { return nil }
            front = front || tabs[o] === active
            layout?.forget([tabs[o].id])
            tabs.remove(at: o)
        }
        if t.host == old { t.host = new } else { t.guest = new }
        layout?.forget(["s:" + old])
        let ob = boxes.removeValue(forKey: old)
        ob?.term.pause()
        info.removeValue(forKey: old)
        homes.removeValue(forKey: old)
        held.remove(old)
        endedHeld.remove(old)
        if front {
            // Built again with the new pane, under the old picture until it drew.
            if shown?.superview !== stage { ob?.removeFromSuperview() }
            shownTab = nil
            show(t)
        } else {
            ob?.removeFromSuperview()
            refresh()
            save()
        }
        return t
    }

    /// Shows a tab again (the middle showed something else over it).
    func showAgain(_ t: Tab) {
        if t !== active { show(t) } else {
            if let v = boxes[t.focusedPane]?.term { window.makeFirstResponder(v) }
            onFront?()
        }
    }

    private func report(_ t: Tab, _ ids: [String], _ t0: CFTimeInterval, hadRows: Bool) {
        guard let cb = onSwitch else { return }
        // The first draw, and the first frame of the new streams.
        var drawn = 0.0, framed = 0.0
        let views = ids.compactMap { boxes[$0]?.term }
        for v in views {
            let old = v.onDraw
            v.onDraw = { seq, cpu in
                old?(seq, cpu)
                if drawn == 0 { drawn = (CACurrentMediaTime() - t0) * 1000 }
                if seq != 0 && framed == 0 {
                    framed = (CACurrentMediaTime() - t0) * 1000
                    v.onDraw = old
                    cb(t.id, drawn, framed, hadRows)
                }
            }
        }
    }

    /// The panes of a tab; visibleOnly: without the one a zoom hides.
    func panes(of t: Tab, visibleOnly: Bool = false) -> [String] {
        guard let g = t.guest else { return [t.host] }
        if visibleOnly && t.zoom { return [t.focusedPane] }
        return [t.host, g]
    }

    /// The view that shows a tab: its pane, or its split.
    private func build(_ t: Tab) -> NSView {
        guard let g = t.guest, !t.zoom, let hb = box(t.host), let gb = box(g) else {
            return box(t.zoom ? t.focusedPane : t.host) ?? NSView()
        }
        hb.removeFromSuperview()
        gb.removeFromSuperview()
        let guestFirst = t.side == "left" || t.side == "up"
        let f = CGFloat(guestFirst ? 100 - t.size : t.size) / 100
        let sv = PaneSplitView(vertical: t.side == "right" || t.side == "left", first: guestFirst ? gb : hb, second: guestFirst ? hb : gb, fraction: f)
        sv.frame = stage.bounds
        sv.layoutPanes()
        sv.onFraction = { [weak self, weak t] f in
            guard let self, let t else { return }
            t.size = Double(round((guestFirst ? 1 - f : f) * 1000) / 10)
            self.save()
        }
        return sv
    }

    private func updateBoxes(_ t: Tab) {
        let split = t.guest != nil && !t.zoom
        for id in panes(of: t) {
            guard let b = boxes[id] else { continue }
            let l = label(id)
            b.name = l.name
            b.sub = l.sub
            // An agent's own pane: the chip with its assistant (app.ts renderPaneHead), not "Claude's" under it.
            let c = info[id]?.creator
            b.badge = c?["kind"] as? String == "agent" && c?["pane"] != nil ? (whoOf?(c!).map { $0 == "An agent" ? "Agent" : $0 } ?? "Agent") : nil
            b.showsHead = split
            b.inFocus = id == t.focusedPane
            // A session's pane: its state's dot in the head (marksOf: the board's group).
            b.dot = b.badge == nil && session(of: id) != nil ? (marksOf?(id).group ?? "idle") : nil
        }
    }

    /// The tab strip, the headers and the window's title, from the model.
    func refresh() {
        // The film button while a pane is on screen (not a page, not Start).
        bar.filmable = active != nil && extraTab == nil
        var models = tabs.enumerated().map { i, t in
            let l = label(t.host)
            let m = marksOf?(t.host)
            let on = t === active && extraTab == nil
            return TabModel(id: t.id, name: l.name, sub: l.sub, split: t.guest != nil, active: on,
                            tip: i < 9 ? "\(l.name) (⌘\(i + 1))" : l.name, dot: m?.group,
                            bell: bells.contains(t.id), activity: activity.contains(t.id), lent: m?.lent?.who, lentCls: m?.lent?.cls ?? "other",
                            closeTip: t.guest == nil && keepsRunning(t.host) ? Words.t("strip.closeSession") : nil)
        }
        // Each extra tab right after its session's, in the order given; the rest at the end.
        for x in extraTabs {
            let at = x.after.flatMap { a in models.lastIndex { $0.id == a || $0.id == "s:" + a || ($0.after == a && $0.id.hasPrefix("view:")) } }
            models.insert(x, at: at.map { $0 + 1 } ?? models.count)
        }
        bar.set(models)
        empty.isHidden = !tabs.isEmpty
        if let t = shownTab { updateBoxes(t) }
        if hintPane != nil { placeHint() }
        if let t = active { window.title = label(t.focusedPane).name }
    }

    // MARK: commands

    func select(id: String) {
        guard let t = tabs.first(where: { $0.id == id }), t !== active else { return }
        show(t)
    }

    func select(index i: Int) {
        guard i >= 0 && i < tabs.count else { return }
        if tabs[i] !== active { show(tabs[i]) }
    }

    func step(_ d: Int) {
        guard !tabs.isEmpty else { return }
        let i = active.flatMap { a in tabs.firstIndex { $0 === a } } ?? 0
        select(index: (i + d + tabs.count) % tabs.count)
    }

    /// A tab moved along the strip: `to` is its place among the panes'
    /// tabs; after a drag (the strip already shows it there), its place
    /// among every tab drawn, the extra ones not counted.
    func move(id: String, to: Int) {
        guard let i = tabs.firstIndex(where: { $0.id == id }) else { refresh(); return }
        let drawn = bar.items.map(\.model.id)
        var at = to
        if drawn.indices.contains(to), drawn[to] == id { at = drawn[..<to].filter { !$0.hasPrefix("view:") }.count }
        let t = tabs.remove(at: i)
        tabs.insert(t, at: min(max(0, at), tabs.count))
        refresh()
        save()
    }

    /// Cmd+T: a shell in the folder of the pane in front, in a new tab
    /// after the last.
    func newTab(_ sender: Any?) { newTab(in: active.flatMap { info[$0.focusedPane]?.cwd }) }

    /// What a new pane runs instead of a shell: its command, its name, the assistant it is.
    struct Program {
        var command: [String]
        var name: String
        var agent: String?
    }

    /// A shell in a folder (or a program: Start's assistant with the board
    /// down), in a new tab after the last, in front.
    func newTab(in cwd: String?, program: Program? = nil) {
        do {
            guard let id = try newPane(cwd: cwd, size: stage.bounds.size, program: program) else { return }
            let t = Tab(host: id)
            tabs.append(t)
            show(t)
        } catch {
            NSLog("RavenryMac: new shell: \(error)")
        }
    }

    /// Cmd+D (right), Cmd+Shift+D (down): a shell beside the pane in
    /// front, with the keyboard; a new tab when the tab is split already.
    func split(_ side: String) {
        guard let t = active, t.guest == nil else { newTab(nil); return }
        let s = stage.bounds.size
        let half = side == "down" ? NSSize(width: s.width, height: s.height / 2 - Design.headHeight) : NSSize(width: s.width / 2, height: s.height - Design.headHeight)
        do {
            guard let id = try newPane(cwd: info[t.host]?.cwd, size: half) else { return }
            t.guest = id
            t.side = side
            t.size = 50
            t.focus = 1
            t.zoom = false
            show(t)
        } catch {
            NSLog("RavenryMac: split: \(error)")
        }
    }

    /// Cmd+Option+arrows: the other pane of the split, when it lies that
    /// way.
    func focusToward(_ dir: String) {
        guard let t = active, t.guest != nil else { return }
        let toGuest = dir == t.side
        let opposite = ["right": "left", "left": "right", "down": "up", "up": "down"]
        let toHost = opposite[dir] == t.side
        if toGuest { focusSplit(t, 1) } else if toHost { focusSplit(t, 0) }
    }

    private func focusSplit(_ t: Tab, _ i: Int) {
        if t.focus != i {
            t.focus = i
            if t.zoom { show(t); return }
        }
        if let v = boxes[t.focusedPane]?.term { window.makeFirstResponder(v) }
        updateBoxes(t)
        refresh()
        save()
    }

    /// A pane took the keyboard (a click in it).
    private func focused(pane: String) {
        guard let t = active, t.guest != nil else { return }
        let i = pane == t.guest ? 1 : 0
        if t.focus != i {
            t.focus = i
            updateBoxes(t)
            refresh()
            save()
        }
    }

    /// Even: half and half.
    func equalize() {
        guard let t = active, t.guest != nil, let sv = shown as? PaneSplitView else { return }
        sv.equalize()
        _ = t
    }

    /// Cmd+Shift+Enter: the pane with the keyboard alone, and back.
    func toggleZoom() {
        guard let t = active, t.guest != nil else { return }
        t.zoom.toggle()
        show(t)
    }

    /// Cmd+W: the pane with the keyboard (a session's only leaves the tab).
    func closeFocused() {
        guard let t = active else { return }
        let id = t.focusedPane
        if keepsRunning(id) { removePane(id); return }
        askClose(id) { [weak self] in self?.closePane(id) }
    }

    /// The tab's x, a middle click: its shells end (asked first when busy);
    /// a session's pane only leaves the strip, the session goes on.
    func closeTab(_ t: Tab) {
        let ids = panes(of: t)
        let ending = ids.filter { !keepsRunning($0) }
        let close = { [weak self] in
            guard let self else { return }
            for id in ids { if ending.contains(id) { self.closePane(id) } else { self.removePane(id) } }
        }
        guard let ask = ending.first else { return close() }
        askClose(ask, then: close)
    }

    /// Closing a shell whose program is still running asks first, as the
    /// settings say (confirmCloseBusy; the Electron app's askClose): busy
    /// when the terminal's foreground process is not the pane's first one.
    func askClose(_ pane: String, then close: @escaping () -> Void) {
        guard look.confirmClose else { return close() }
        let what = tabs.contains { $0.guest != nil && ($0.host == pane || $0.guest == pane) } ? "pane" : "tab"
        let c = conn(of: pane)
        c.request("pane.process", ["pane": pane]) { [weak self] r in
            guard let self else { return }
            guard case .success(let v) = r, let fg = v["foreground"] as? [String: Any], let fpid = (fg["pid"] as? NSNumber)?.intValue else {
                return DispatchQueue.main.async(execute: close)
            }
            // Busy, as the daemon says it (pane.process `busy`); an older daemon's answer has none: its first process compared below.
            if let b = v["busy"] as? Bool {
                DispatchQueue.main.async {
                    guard b else { return close() }
                    self.confirmBusy(pane, fg, what: what, then: close)
                }
                return
            }
            c.request("pane.list") { [weak self] r2 in
                var first: Int?
                if case .success(let l) = r2, let ps = l["panes"] as? [[String: Any]] {
                    first = (ps.first { $0["id"] as? String == pane }?["pid"] as? NSNumber)?.intValue
                }
                DispatchQueue.main.async {
                    guard let self, let first, first != fpid else { return close() }
                    self.confirmBusy(pane, fg, what: what, then: close)
                }
            }
        }
    }

    /// "Close this tab?" with what runs there.
    private func confirmBusy(_ pane: String, _ fg: [String: Any], what: String, then close: @escaping () -> Void) {
        var argv = fg["argv"] as? [String] ?? []
        if let a = argv.first { argv[0] = (a as NSString).lastPathComponent }
        let cmd = argv.isEmpty ? t("close.aprogram") : argv.joined(separator: " ")
        let sh = info[pane]?.command.first.map { String(($0 as NSString).lastPathComponent.drop { $0 == "-" }) } ?? ""
        confirmClose(what: what, shell: sh.isEmpty ? t("close.theshell") : sh, cmd: cmd, then: close)
    }

    private func confirmClose(what: String, shell: String, cmd: String, then close: @escaping () -> Void) {
        let title = t("close.title.\(what)"), body = t("close.body", ["shell": shell, "cmd": cmd])
        let answer: (Bool, Bool) -> Void = { [weak self] yes, dont in
            if yes && dont { self?.settings.set(["confirmCloseBusy": false]) }
            if yes { close() } else if let v = self?.focusedView { self?.window.makeFirstResponder(v) }
        }
        if let a = closeAnswer ?? Workspace.testCloseAnswer {
            closeAsked.append("\(title) \(body)")
            return answer(a.close, a.dont)
        }
        let a = NSAlert()
        a.alertStyle = .warning
        a.messageText = title
        a.informativeText = body + "\n\n" + t("close.note")
        let yes = a.addButton(withTitle: t("close.close"))
        yes.hasDestructiveAction = true
        yes.keyEquivalent = ""
        a.addButton(withTitle: t("close.cancel")).keyEquivalent = "\r"
        a.showsSuppressionButton = true
        a.suppressionButton?.title = t("close.dont")
        if options.offscreen {
            // Off every screen the sheet is not shown: AppKit puts a sheet on a
            // screen, even over a window off every one (it showed at the person's
            // screen's corner). The alert is laid out as the sheet's and kept, its
            // buttons answering as the sheet's do (TERM-016's check presses them,
            // Return through its key equivalents).
            a.layout()
            closeAlert = a
            closeAlertAnswer = { r in answer(r == .alertFirstButtonReturn, a.suppressionButton?.state == .on) }
            for (i, b) in a.buttons.enumerated() { b.target = self; b.action = #selector(closeAlertButton(_:)); b.tag = i }
            return
        }
        a.beginSheetModal(for: window) { r in
            answer(r == .alertFirstButtonReturn, a.suppressionButton?.state == .on)
        }
    }

    /// Off every screen: the close alert waiting for a press, and its answer.
    private(set) var closeAlert: NSAlert?
    private var closeAlertAnswer: ((NSApplication.ModalResponse) -> Void)?
    @objc private func closeAlertButton(_ b: NSButton) {
        let done = closeAlertAnswer
        closeAlert = nil
        closeAlertAnswer = nil
        done?(NSApplication.ModalResponse(rawValue: NSApplication.ModalResponse.alertFirstButtonReturn.rawValue + b.tag))
    }

    /// Closes a pane: its process ends (pane.close); its tab goes, or its
    /// split's other pane is the tab, whole again.
    func closePane(_ id: String) {
        let c = conn(of: id)
        closedHere.insert(id)
        removePane(id)
        c.request("pane.close", ["pane": id])
    }

    /// A pane is gone (closed here, or it ended): out of its tab.
    func removePane(_ id: String) {
        guard let i = tabs.firstIndex(where: { $0.host == id || $0.guest == id }) else { return }
        let t = tabs[i]
        layout?.forget(["s:" + id])
        let wasActive = t === active
        boxes[id]?.term.pause()
        boxes[id]?.removeFromSuperview()
        boxes.removeValue(forKey: id)
        info.removeValue(forKey: id)
        homes.removeValue(forKey: id)
        if t.guest == id {
            t.guest = nil
            t.focus = 0
            t.zoom = false
        } else if let g = t.guest {
            // The tab's own pane went: its split's pane is the tab.
            t.host = g
            t.guest = nil
            t.focus = 0
            t.zoom = false
        } else {
            tabs.remove(at: i)
            if wasActive {
                shown?.removeFromSuperview()
                shown = nil
                shownTab = nil
                active = nil
                if tabs.isEmpty {
                    save()
                    layout?.flush()
                    emptied()
                    return
                }
                show(tabs[min(i, tabs.count - 1)])
                return
            }
            refresh()
            save()
            return
        }
        if wasActive {
            shown?.removeFromSuperview()
            shown = nil
            shownTab = nil
            show(t)
        } else {
            refresh()
            save()
        }
    }

    // MARK: text size

    /// Cmd+= / Cmd+- / Cmd+0: written to the settings, which every pane
    /// (and the Electron app) follows.
    func setFontSize(_ s: CGFloat) {
        pins["fontSize"] = nil
        if settings.set(["fontSize": Int(s)]) != nil { return }
        applyLook()
    }

    static var dark: Bool { (NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) ?? .darkAqua) == .darkAqua }

    /// The settings file changed (here, in Settings or the other app): a
    /// pin from the command line gives way to its setting once that
    /// setting changes.
    private func settingsChanged() {
        for (k, v) in settings.values where !((lastValues[k] as AnyObject?)?.isEqual(v) ?? false) { pins[k] = nil }
        lastValues = settings.values
        applyLook()
    }

    /// Every pane takes what the settings make of a terminal now, and so
    /// does what draws beside them (the tab in front, the panes' heads).
    func applyLook() {
        let l = TermLook(settings, dark: Workspace.dark, pins: pins)
        guard l != look else { return }
        let was = look
        look = l
        for b in boxes.values { b.term.apply(l); b.needsDisplay = true }
        if l.scrollback != was.scrollback { for id in boxes.keys { keepScrollback(id) } }
        Design.terminal = l.theme
        root.sheet.restyle()
        stage.layer?.backgroundColor = Design.tbg.cgColor
        bar.needsDisplay = true
        for v in bar.subviews { v.needsDisplay = true }
        updateMinSize()
        // The filmstrip's frames are drawn in the terminal's colours: again in the new ones.
        if let p = film.pane, l.theme != was.theme || l.size != was.size { film.load(p) }
        onLook?()
    }

    /// After the look changed (Board redraws what follows the terminal's colours).
    var onLook: (() -> Void)?

    /// The daemon keeps as many lines of a pane as the Scrollback setting
    /// says (pane.update), so a snapshot brings them all back.
    private func keepScrollback(_ id: String) {
        let want = look.scrollback
        guard let i = info[id], i.scrollback != want else { return }
        i.scrollback = want
        conn(of: id).request("pane.update", ["pane": id, "scrollback": want])
    }

    // MARK: size

    /// The window's smallest content: each pane of the tab in front at
    /// least its smallest grid (40 x 10), or 160 pt in a split, as the
    /// Electron app's; the strip above.
    func minContentSize() -> NSSize {
        guard let t = active, let v = boxes[t.host]?.term else { return NSSize(width: 400, height: 200) }
        let one = v.minContentSize
        var m = one
        if t.guest != nil && !t.zoom {
            if t.side == "right" || t.side == "left" {
                m = NSSize(width: 2 * Design.paneMin + Design.gutter, height: one.height + Design.headHeight)
            } else {
                m = NSSize(width: one.width, height: 2 * max(Design.paneMin, one.height + Design.headHeight) + Design.gutter)
            }
        }
        return NSSize(width: m.width, height: m.height + Design.stripHeight)
    }

    func updateMinSize() { focusedView?.updateMinSize() }

    // MARK: the daemon's events

    func event(_ ev: [String: Any], from d: DaemonLink) {
        let name = ev["event"] as? String ?? ""
        if name == "stream.end", let ch = (ev["channel"] as? NSNumber)?.uint32Value {
            // A pane on screen ended (a channel is its daemon's connection's).
            if let (id, _) = boxes.first(where: { $0.value.term.channel == ch && $0.value.term.conn === d.conn }) { ended(id) }
            return
        }
        // A question asked in one of its panes, or one that moved on (app.ts onCheckpoint).
        if name.hasPrefix("checkpoint."), let cp = ev["checkpoint"] as? [String: Any] {
            if name == "checkpoint.running" { besideAsker(cp, d) }
            hub?.daemonCheckpoint(cp, socket: d.socket)
            return
        }
        guard let p = ev["pane"] as? [String: Any], let id = p["id"] as? String else { return }
        switch name {
        case "pane.title", "pane.cwd", "pane.updated", "pane.created":
            info[id]?.update(p)
            // The shell in front changed folder: kept as the last folder (TERM-068).
            if name == "pane.cwd", active?.focusedPane == id { save() }
            let shown = tabs.contains(where: { $0.host == id || $0.guest == id })
            if isAgentPane(p), !shown { homes[id] = homes[id] ?? d; addAgentPane(p) }
            else if !shown, isOwnShell(p), (p["state"] as? String ?? "running") == "running", !closedHere.contains(id), !held.contains(id), !gaveAway.contains(id) {
                // A shell another client made for this window (the command
                // line, the Electron app's first window): a tab at the end, the front left alone.
                homes[id] = homes[id] ?? d
                let i = info[id] ?? PaneInfo(id: id)
                i.update(p)
                info[id] = i
                tabs.append(Tab(host: id))
                if tabs.count == 1 { show(tabs[0]) } else { save() }
            }
            else if name == "pane.created", p["creator"] == nil, (p["labels"] as? [String: String])?["ravenry.kind"] != "shell" {
                // pane.created can come before the daemon recorded who made it: asked once more.
                d.conn.request("pane.list", [:]) { [weak self] r in
                    guard case .success(let j) = r, let q = (j["panes"] as? [[String: Any]] ?? []).first(where: { $0["id"] as? String == id }) else { return }
                    DispatchQueue.main.async {
                        guard let self, isAgentPane(q), !self.tabs.contains(where: { $0.host == id || $0.guest == id }) else { return }
                        self.homes[id] = self.homes[id] ?? d
                        self.addAgentPane(q)
                    }
                }
            }
            refresh()
        case "agent.report":
            // What the agent in a pane reported: its tab's dot follows.
            // It moved on: a card answered before that leaves the panel (app.ts, checkpoints.ts settle).
            if let a = p["agent"] as? [String: Any] { hub?.settle(pane: id, since: When.date(a["at"] as? String ?? a["since"] as? String) ?? When.now()) }
            if let i = info[id] { i.update(p); refresh() }
        case "pane.lease":
            if let i = info[id] { i.lease = p["lease"] as? [String: Any]; refresh(); onLease?(id) }
        case "pane.exited", "pane.closed":
            if info[id] != nil { ended(id) }
        case "pane.bell":
            // A bell in a pane not on screen: the sound and the Dock, as
            // the settings say (one on screen rings in its view), and a
            // small bell on its tab until it is opened.
            if info[id] != nil, boxes[id]?.term.window == nil {
                TerminalView.ring(look, offscreen: options.offscreen) { self.bellsHeard.append($0) }
            }
            if let t = tabs.first(where: { $0.host == id || $0.guest == id }), !(t === active && extraTab == nil) || boxes[id]?.term.window == nil {
                bells.insert(t.id)
                refresh()
            }
        case "pane.input":
            // What someone typed: its mark in the gutter of the pane on screen (TERM-044).
            if let r = ev["input"] as? [String: Any], let v = boxes[id]?.term, v.live { v.inputLogged(r) }
        case "pane.activity":
            // A tab not on screen printed: a quiet dot on it.
            if let t = tabs.first(where: { $0.host == id || $0.guest == id }), !(t === active && extraTab == nil) {
                activity.insert(t.id)
                refresh()
            }
        case "pane.focus":
            if let t = tabs.first(where: { $0.host == id || $0.guest == id }) {
                if t.guest == id { t.focus = 1 } else if t.guest != nil { t.focus = 0 }
                show(t)
                if !options.offscreen { NSApp.activate(ignoringOtherApps: true) }
            }
        default:
            break
        }
    }

    /// Panes this window closed (their last events may still come), and
    /// panes it gave to another window (move(_:to:)): never a tab again here.
    private var closedHere: Set<String> = []
    private var gaveAway: Set<String> = []

    /// Tabs whose pane rang a bell, or printed, while not on screen (cleared when shown).
    private(set) var bells: Set<String> = []
    private(set) var activity: Set<String> = []
    /// Who a Source is, by the board's names ("Claude").
    var whoOf: (([String: Any]) -> String?)?
    /// What a tab's pane says to the board (Board.swift): its session's state for the dot, the agent holding its lease.
    var marksOf: ((String) -> (group: String?, lent: Who?))?

    /// Something about a pane's lease changed (the strip and the panel follow).
    var onLease: ((String) -> Void)?

    /// An agent's own pane: beside its session's (or shell's) tab, without
    /// the keyboard, when that tab is not split yet; else a tab right after
    /// it (and its other panes), else at the end. The tab in front stays.
    func addAgentPane(_ p: [String: Any], owner given: String? = nil) {
        guard let id = p["id"] as? String, let owner = given ?? (p["creator"] as? [String: Any])?["pane"] as? String else { return }
        let i = info[id] ?? PaneInfo(id: id)
        i.update(p)
        info[id] = i
        if let host = tabs.first(where: { $0.host == owner && $0.guest == nil }) {
            host.guest = id
            host.side = "right"
            host.size = 50
            host.focus = 0
            host.zoom = false
            if host === active {
                shown?.removeFromSuperview()
                shown = nil
                shownTab = nil
                show(host)
            }
        } else {
            var at = -1
            for (k, x) in tabs.enumerated() where x.host == owner || x.guest == owner || [x.host, x.guest].contains(where: { $0.flatMap { self.info[$0]?.creator?["pane"] as? String } == owner }) { at = k }
            tabs.insert(Tab(host: id), at: at < 0 ? tabs.count : at + 1)
        }
        refresh()
        save()
        if given == nil { wantHint(id) }
    }

    /// An approved command's pane (a checkpoint's run, which the person's
    /// approval started): beside the pane that asked, as the card said ("A
    /// new one, beside <pane>"), so they watch it run and the card's Show
    /// in the terminal finds it; its tab goes when the command ends.
    private func besideAsker(_ cp: [String: Any], _ d: DaemonLink) {
        guard let run = (cp["run"] as? [String: Any])?["pane"] as? String, let asker = cp["pane"] as? String,
              cp["machine"] == nil || cp["machine"] is NSNull,
              tabs.contains(where: { $0.host == asker || $0.guest == asker }),
              !tabs.contains(where: { $0.host == run || $0.guest == run }) else { return }
        d.conn.request("pane.list", [:]) { [weak self] r in
            guard case .success(let j) = r, let q = (j["panes"] as? [[String: Any]] ?? []).first(where: { $0["id"] as? String == run }),
                  (q["state"] as? String ?? "running") == "running" else { return }
            DispatchQueue.main.async {
                guard let self, !self.tabs.contains(where: { $0.host == run || $0.guest == run }), !self.closedHere.contains(run) else { return }
                self.homes[run] = self.homes[run] ?? d
                self.addAgentPane(q, owner: asker)
            }
        }
    }

    /// A pane's program ended: its tab goes (the pane too, from the daemon).
    private func ended(_ id: String) {
        if held.contains(id) { endedHeld.insert(id); return }
        closePane(id)
    }

    // MARK: the filmstrip

    /// The sheet under the pane with its last 20 seconds, and a frame of it over the pane.
    let film = FilmSheet()
    let filmView = FilmFrameView()

    private func setUpFilm() {
        root.film = film
        film.conn = { [weak self] p in self?.info[p] != nil ? self?.conn(of: p) : nil }
        film.look = { [weak self] in
            guard let self else { return (Theme.ravenry, 13, 2) }
            return (self.look.theme, self.look.size, self.scale)
        }
        film.paneName = { [weak self] p in self?.label(p).name ?? p }
        film.sendTo = { [weak self] p in
            guard let self else { return nil }
            // The session of the agent that opened it, else the pane's own (app.ts sendTo).
            let c = self.info[p]?.creator
            let owner = c?["kind"] as? String == "agent" ? c?["pane"] as? String : nil
            guard let f = owner.flatMap({ self.session(of: $0) }) ?? self.session(of: p), let hub = self.hub ?? (NSApp.delegate as? AppDelegate)?.hub else { return nil }
            let who = f.session.assistant.map(Workspace.assistantName) ?? Words.t("film.theAgent")
            let sid = f.session.surfaceId.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? f.session.surfaceId
            return (who, { done in
                hub.post("/api/sessions/\(sid)/filmstrip", ["pane": p, "last_ms": Film.lastMs]) { code, j in
                    // 502: the daemon's own words for why it could not draw them.
                    done(code == 200 ? nil : code == 502 ? Words.t("film.whyDaemon") : j["error"] as? String ?? Words.t("film.boardSaid", ["code": "\(code)"]))
                }
            })
        }
        film.changed = { [weak self] in self?.filmChanged() }
        filmView.onBack = { [weak self] in self?.film.live() }
    }

    /// The strip's film button: the filmstrip of the pane with the keyboard, or closed.
    func toggleFilm() {
        guard let t = active, extraTab == nil else { return }
        film.toggle(t.focusedPane)
    }

    /// Opens the filmstrip of a pane (Learn's card), its tab in front.
    func openFilm(_ pane: String) {
        guard let t = tabs.first(where: { $0.host == pane || $0.guest == pane }) else { return }
        if t !== active { show(t) }
        if film.pane != pane { film.load(pane) }
    }

    private func filmChanged() {
        bar.filmOn = film.isOpen
        root.filmHeight = film.isOpen ? FilmSheet.height : 0
        root.place()
        let cw = focusedView.map { $0.renderer.fonts.cellWidth / $0.renderer.fonts.scale } ?? 0
        if let x = film.overlayImage(cellWidth: cw) {
            if filmView.superview !== stage { stage.addSubview(filmView) }
            filmView.frame = stage.bounds
            filmView.show(x)
        } else {
            filmView.removeFromSuperview()
        }
        stage.window?.cursorRectsAgain()
    }

    // MARK: the one-time hint

    /// "Claude opened “dev server” beside it.": the first time an agent
    /// opens a pane of its own (app.ts hintAt agent-pane), under its pane's
    /// head in a split, else under its tab. Learn more opens Learn at its
    /// card; either way it is never shown again.
    let hint = HintView()
    private(set) var hintPane: String?
    private var hintsDone: [String: Bool]?

    private func wantHint(_ pane: String) {
        guard hintPane == nil, let hub = hub ?? (NSApp.delegate as? AppDelegate)?.hub else { return }
        let show = { [weak self] in
            guard let self, self.hintsDone?["agent-pane"] != true, self.hintPane == nil, self.info[pane] != nil else { return }
            self.hintPane = pane
            self.placeHint()
        }
        if hintsDone != nil { return show() }
        hub.get("/api/onboarding") { [weak self] code, j in
            DispatchQueue.main.async {
                guard let self else { return }
                self.hintsDone = code == 200 ? (j["hints"] as? [String: Any] ?? [:]).compactMapValues { $0 as? Bool } : nil
                if self.hintsDone != nil { show() }
            }
        }
    }

    /// Dismissed (or Learn more): marked on the board, never again.
    func dismissHint(learn: Bool) {
        guard hintPane != nil else { return }
        hintPane = nil
        hintsDone?["agent-pane"] = true
        hint.removeFromSuperview()
        (hub ?? (NSApp.delegate as? AppDelegate)?.hub)?.post("/api/onboarding", ["hints": ["agent-pane": true]]) { _, _ in }
        if learn { menuCommand("menuLearn:") }
    }

    /// Under the agent's pane head when it shows split, else under its tab;
    /// hidden while a page is in front or its pane is not on screen.
    func placeHint() {
        guard let p = hintPane else { return }
        guard info[p] != nil else { hintPane = nil; hint.removeFromSuperview(); return }
        let c = info[p]?.creator
        let who = c.flatMap { whoOf?($0) } ?? Words.t("hint.anAgent")
        let name = info[p]?.name ?? ""
        hint.set(bold: !name.isEmpty && name != "Shell" ? Words.t("hint.agentOpenedNamed", ["who": who, "name": name]) : Words.t("hint.agentOpened", ["who": who]),
                 rest: Words.t("hint.agentRest"))
        hint.onDismiss = { [weak self] in self?.dismissHint(learn: false) }
        hint.onLearn = { [weak self] in self?.dismissHint(learn: true) }
        let onScreen = extraTab == nil && active.map { panes(of: $0, visibleOnly: true).contains(p) } ?? false
        var region = stage.bounds
        var anchorX: CGFloat = 24
        if onScreen, let b = boxes[p], b.showsHead {
            let r = b.convert(b.bounds, to: stage)
            region = NSRect(x: r.minX, y: r.minY + Design.headHeight, width: r.width, height: r.height - Design.headHeight)
            anchorX = r.minX + 40
        } else if let it = bar.items.first(where: { $0.model.id == "s:" + p || $0.model.id == tabs.first(where: { $0.guest == p })?.id }), extraTab == nil, it.superview != nil {
            anchorX = it.convert(NSPoint(x: it.bounds.midX, y: 0), to: stage).x
        } else {
            hint.removeFromSuperview()
            return
        }
        guard region.width >= 220 else { hint.removeFromSuperview(); return }
        let w = min(560, region.width - 20)
        let x = max(region.minX + 10, min(anchorX - 24, region.maxX - 10 - w))
        let h = hint.height(for: w)
        if hint.superview !== stage { stage.addSubview(hint, positioned: .above, relativeTo: nil) }
        hint.frame = NSRect(x: x, y: region.minY + 6, width: w, height: h)
        hint.arrowX = anchorX - x
        hint.needsLayout = true
    }

    // MARK: no tab left

    /// "No shell is open." with New shell (the Electron app's renderNone),
    /// over the stage while no tab is left; the sidebar and the panel stay.
    let empty = EmptyStage()
    /// The last tab went (Board or the window manager may close a second
    /// window then); unset, the window stays and says so.
    var onEmpty: (() -> Void)?

    private func emptied() {
        refresh()
        if let f = onEmpty { f(); return }
        if empty.superview !== stage { stage.addSubview(empty) }
        empty.frame = stage.bounds
        empty.isHidden = false
        empty.onNew = { [weak self] in self?.newTab(in: nil) }
        window.makeFirstResponder(empty.button)
        window.title = "Ravenry"
        onFront?()
    }

    // MARK: a tab dragged onto the pane in front

    /// What a drop there does, lit on the stage while a tab is dragged.
    let dropZone = SplitDropView()

    /// The edge of the stage a point is near (within 30% of it), or nil in the middle (app.ts edgeAt).
    func edge(at p: NSPoint) -> String? {
        let b = stage.bounds
        guard b.width > 0, b.height > 0, b.contains(p) else { return nil }
        let fx = p.x / b.width, fy = p.y / b.height
        let d: [(String, CGFloat)] = [("left", fx), ("right", 1 - fx), ("up", fy), ("down", 1 - fy)]
        let m = d.min { $0.1 < $1.1 }!
        return m.1 < 0.3 ? m.0 : nil
    }

    /// Why a tab cannot split the tab in front (nil: it can).
    private func refusal(_ t: Tab) -> String? {
        guard let host = active else { return "" }
        if host.guest != nil { return Words.t("strip.dropSplit") }
        if t.guest != nil { return Words.t("strip.dropSplitTab") }
        return nil
    }

    /// A tab dragged over the window (nil: out of it, or let go): the edge
    /// it would split lit, with what it would do or why it cannot.
    func dragOver(_ id: String, _ wp: NSPoint?) {
        guard let wp, let t = tabs.first(where: { $0.id == id }), t !== active, extraTab == nil, root.middle == nil,
              let side = edge(at: stage.convert(wp, from: nil)) else {
            dropZone.removeFromSuperview()
            return
        }
        if dropZone.superview !== stage { stage.addSubview(dropZone) }
        dropZone.frame = stage.bounds
        let why = refusal(t)
        dropZone.show(side: side, words: why ?? Words.t("strip.drop.\(side)"), refused: why != nil)
    }

    /// The drop: the tab's pane beside the tab in front, on that side,
    /// with the keyboard (linkSplit); its own tab goes.
    @discardableResult
    func dropTab(_ id: String, _ wp: NSPoint) -> Bool {
        dropZone.removeFromSuperview()
        guard let t = tabs.first(where: { $0.id == id }), let host = active, t !== host, extraTab == nil, root.middle == nil,
              refusal(t) == nil, let side = edge(at: stage.convert(wp, from: nil)) else { return false }
        tabs.removeAll { $0 === t }
        host.guest = t.host
        host.side = side
        host.size = 50
        host.focus = 1
        host.zoom = false
        shown?.removeFromSuperview()
        shown = nil
        shownTab = nil
        show(host)
        return true
    }

    // MARK: a tab to another window

    /// Moves a tab whole (its split too) to another window's workspace, its
    /// panes running on: out of this strip (the next tab in front here, or
    /// "No shell is open"), its shells labelled with that window's id
    /// (ravenry.window: none for the first window), a tab at the end there,
    /// in front.
    func move(_ t: Tab, to other: Workspace) {
        guard other !== self, let i = tabs.firstIndex(where: { $0 === t }) else { return }
        let ids = panes(of: t)
        let wasActive = t === active
        var moved: [(String, PaneInfo?, DaemonLink?)] = []
        if let p = film.pane, ids.contains(p) { film.close() }
        if let h = hintPane, ids.contains(h) { hintPane = nil; hint.removeFromSuperview() }
        for id in ids {
            boxes[id]?.term.pause()
            boxes[id]?.removeFromSuperview()
            boxes.removeValue(forKey: id)
            moved.append((id, info.removeValue(forKey: id), homes.removeValue(forKey: id)))
            gaveAway.insert(id)
        }
        bells.remove(t.id)
        activity.remove(t.id)
        layout?.forget(ids.map { "s:" + $0 })
        tabs.remove(at: i)
        if wasActive {
            shown?.removeFromSuperview()
            shown = nil
            shownTab = nil
            active = nil
            if tabs.isEmpty { save(); emptied() } else { show(tabs[min(i, tabs.count - 1)]) }
        } else {
            refresh()
            save()
        }
        other.receive(t, moved)
    }

    /// A tab from another window (move(_:to:)): its panes known here, its
    /// shells labelled as this window's, in front.
    func receive(_ t: Tab, _ moved: [(String, PaneInfo?, DaemonLink?)]) {
        for (id, i, d) in moved {
            gaveAway.remove(id)
            closedHere.remove(id)
            let pi = i ?? PaneInfo(id: id)
            info[id] = pi
            if let d { homes[id] = d }
            if pi.labels["ravenry.kind"] == "shell" && pi.labels["ravenry.window"].flatMap({ $0.isEmpty ? nil : $0 }) != windowId {
                pi.labels["ravenry.window"] = windowId
                conn(of: id).request("pane.update", ["pane": id, "labels": ["ravenry.window": windowId ?? NSNull()] as [String: Any]])
            }
        }
        tabs.append(t)
        show(t)
    }

    // MARK: kept

    func save() {
        guard let layout else { return }
        var order: [String] = []
        var splits: [SavedSplit] = []
        for t in tabs {
            order.append(t.id)
            if let g = t.guest {
                order.append("s:" + g)
                splits.append(SavedSplit(host: t.id, guest: "s:" + g, side: t.side, size: t.size, focus: t.focus, zoom: t.zoom))
            }
        }
        // The folder of the shell in front (TERM-068), as the Electron app's lastCwd.
        let front = active.flatMap { info[$0.focusedPane] }
        let lastCwd = front.flatMap { $0.labels["ravenry.kind"] == "shell" && !$0.cwd.isEmpty ? $0.cwd : nil }
        layout.save(order: order, splits: splits, active: active?.id, pinned: pinned, lastCwd: lastCwd)
    }

    func flush() { layout?.flush() }

    // MARK: the window's size and place (TERM-043)

    /// A frame from saved bounds (the Electron app's: from the top left of
    /// the main screen), when at least 160 x 80 of it lies on a screen that
    /// is still there and it is at least 720 x 480; else nil.
    static func frame(fromBounds b: [String: Any], screens: [NSRect], mainHeight: CGFloat) -> NSRect? {
        guard let x = (b["x"] as? NSNumber)?.doubleValue, let y = (b["y"] as? NSNumber)?.doubleValue,
              let w = (b["width"] as? NSNumber)?.doubleValue, let h = (b["height"] as? NSNumber)?.doubleValue,
              [x, y, w, h].allSatisfy({ $0.isFinite }), w >= 720, h >= 480 else { return nil }
        let r = NSRect(x: x, y: Double(mainHeight) - y - h, width: w, height: h)
        let seen = screens.contains { a in let i = a.intersection(r); return i.width >= 160 && i.height >= 80 }
        return seen ? r : nil
    }

    /// The bounds of a frame, as the Electron app writes them.
    static func bounds(fromFrame f: NSRect, mainHeight: CGFloat, maximized: Bool) -> [String: Any] {
        ["x": Int(f.minX.rounded()), "y": Int((mainHeight - f.maxY).rounded()), "width": Int(f.width.rounded()), "height": Int(f.height.rounded()), "maximized": maximized]
    }

    private static var mainHeight: CGFloat { NSScreen.screens.first?.frame.height ?? 900 }
    private var boundsTimer: DispatchWorkItem?
    private var boundsWatch: [NSObjectProtocol] = []

    /// Puts the window where it was left; false when nothing usable was kept.
    func placeWindow() -> Bool {
        guard let b = layout?.readBounds(),
              let f = Workspace.frame(fromBounds: b, screens: NSScreen.screens.map(\.visibleFrame), mainHeight: Workspace.mainHeight) else { return false }
        window.setFrame(f, display: false)
        if b["maximized"] as? Bool ?? false, !window.isZoomed { window.zoom(nil) }
        return true
    }

    /// Keeps the window's size and place as it moves and resizes, and when it closes.
    func keepBounds() {
        let save = { [weak self] in
            guard let self else { return }
            self.boundsTimer?.cancel()
            let w = DispatchWorkItem { [weak self] in self?.saveBoundsNow() }
            self.boundsTimer = w
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: w)
        }
        for n in [NSWindow.didMoveNotification, NSWindow.didResizeNotification] {
            boundsWatch.append(NotificationCenter.default.addObserver(forName: n, object: window, queue: .main) { _ in save() })
        }
        boundsWatch.append(NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in self?.saveBoundsNow() })
    }

    /// Writes the window's bounds (not while full screen; zoomed, the frame it had before).
    func saveBoundsNow() {
        boundsTimer?.cancel()
        guard !window.styleMask.contains(.fullScreen), window.frame.minX > -20000 else { return }
        let zoomed = window.isZoomed
        layout?.saveBounds(Workspace.bounds(fromFrame: window.frame, mainHeight: Workspace.mainHeight, maximized: zoomed))
    }
}

/// The window's content: the strip at the top (in the title bar), the
/// tab in front under it.
final class RootView: NSView {
    weak var bar: TabBar?
    /// The workspace it shows (Start's local run reaches it here).
    weak var workspace: Workspace?
    /// The filmstrip's sheet under the stage, and its height (0: closed).
    weak var film: NSView?
    var filmHeight: CGFloat = 0
    weak var stage: StageView?
    /// The sidebar, the middle's sheet and the panel (Board.swift); without
    /// a sidebar (folded, or the bench) the strip is the window's top.
    weak var sidebar: NSView?
    weak var panel: NSView?
    /// What covers the stage when the middle is not a tab's terminal.
    weak var middle: NSView?
    /// The strip across the top of a lent pane (Lent.swift), over the stage.
    var strip: LeaseStrip? {
        didSet {
            if oldValue !== strip { oldValue?.removeFromSuperview() }
            placedFor = nil
            needsLayout = true
            place()
        }
    }
    /// A bar across the sheet under the tabs (NpmSwitch.swift's quiet bar).
    var notice: NSView? {
        didSet {
            if oldValue !== notice { oldValue?.removeFromSuperview() }
            placedFor = nil
            needsLayout = true
            place()
        }
    }
    /// Where the middle goes (not wide): under the strip and the notice.
    private var middleRect: NSRect {
        let top = Design.stripHeight + (notice != nil ? NpmBar.height : 0)
        return NSRect(x: 0, y: top, width: sheet.bounds.width, height: max(1, sheet.bounds.height - top))
    }
    /// The middle over the whole sheet, the strip too (the Electron app's
    /// own pages: the gallery, a plan, an idea, Alerts, the pages).
    var wideMiddle = false
    let sheet = SheetView()
    var sideWidth: CGFloat = 0
    /// The panel beside the middle (docked), over it (overlay), or not shown.
    var panelMode: PanelMode = .hidden
    enum PanelMode { case hidden, docked, overlay }
    /// The panel's mode at a width (Board.panelMode), asked at each layout.
    var panelModeFor: ((CGFloat) -> PanelMode)?
    /// After each layout (the window's buttons are placed again).
    var onLayout: (() -> Void)?
    override var isFlipped: Bool { true }
    override func layout() {
        super.layout()
        place()
    }
    override func setFrameSize(_ s: NSSize) {
        super.setFrameSize(s)
        // At once, so the panes draw their new size in this transaction.
        place()
    }
    private var placedFor: (NSSize, CGFloat, PanelMode, Int, Bool, CGFloat)?
    /// Full screen: no window buttons left of the strip to make room for.
    var fullScreen: Bool { window?.styleMask.contains(.fullScreen) ?? false }
    func place() {
        let w = bounds.width, h = bounds.height
        if let f = panelModeFor { panelMode = f(w) }
        // The strip's fold buttons say what shows.
        bar?.sidebarShown = sidebar != nil && sideWidth > 0
        bar?.panelShown = panelMode != .hidden
        // Nothing moved: nothing to lay out (Board draws at every state).
        let key = (bounds.size, sideWidth, panelMode, middle != nil && !wideMiddle ? 1 : middle != nil ? 2 : 0, fullScreen, filmHeight)
        if let k = placedFor, k.0 == key.0, k.1 == key.1, k.2 == key.2, k.3 == key.3, k.4 == key.4, k.5 == key.5, middle == nil || middle?.frame == (wideMiddle ? sheet.bounds : middleRect) { return }
        placedFor = key
        let side = sidebar != nil && sideWidth > 0
        sidebar?.isHidden = !side
        if side { sidebar?.setIf(NSRect(x: 0, y: 0, width: sideWidth, height: h)) }
        let pw = PanelView.width
        panel?.isHidden = panelMode == .hidden
        // .tsheet and .panel: margin 8 8 8 0, radius 11, beside the sidebar.
        let m: CGFloat = side ? 8 : 0
        let right = panelMode == .docked ? pw + 8 : 0
        if sheet.superview == nil { addSubview(sheet, positioned: .below, relativeTo: nil) }
        sheet.round = side
        sheet.setIf(NSRect(x: side ? sideWidth : 0, y: m, width: max(1, w - (side ? sideWidth : 0) - right - m), height: max(1, h - 2 * m)))
        if let b = bar, b.superview !== sheet { sheet.addSubview(b) }
        if let s = stage, s.superview !== sheet { sheet.addSubview(s, positioned: .below, relativeTo: bar) }
        bar?.lead = side || key.4 ? 8 : Design.stripLead
        bar?.setIf(NSRect(x: 0, y: 0, width: sheet.bounds.width, height: Design.stripHeight))
        var sh: CGFloat = 0
        if let st = strip {
            if st.superview !== sheet { sheet.addSubview(st) }
            sh = st.height(for: sheet.bounds.width)
            st.setIf(NSRect(x: 0, y: Design.stripHeight, width: sheet.bounds.width, height: sh))
        }
        if let n = notice {
            if n.superview !== sheet { sheet.addSubview(n) }
            n.setIf(NSRect(x: 0, y: Design.stripHeight + sh, width: sheet.bounds.width, height: NpmBar.height))
            sh += NpmBar.height
        }
        let fh = film != nil ? filmHeight : 0
        stage?.setIf(NSRect(x: 0, y: Design.stripHeight + sh, width: sheet.bounds.width, height: max(1, sheet.bounds.height - Design.stripHeight - sh - fh)))
        if let f = film {
            if f.superview !== sheet { sheet.addSubview(f) }
            f.isHidden = fh == 0
            if fh > 0 { f.setIf(NSRect(x: 0, y: sheet.bounds.height - fh, width: sheet.bounds.width, height: fh)) }
        }
        if let mv = middle {
            if mv.superview !== sheet || wideMiddle { sheet.addSubview(mv, positioned: .above, relativeTo: wideMiddle ? bar : stage) }
            mv.setIf(wideMiddle ? sheet.bounds : middleRect)
        }
        if let p = panel, panelMode != .hidden {
            if p.superview !== self { addSubview(p) }
            p.setIf(NSRect(x: w - pw - 8, y: 8, width: pw, height: max(1, h - 16)))
            (p as? Box)?.dropShadow = panelMode == .overlay
            p.needsDisplay = true
            if panelMode == .overlay { addSubview(p, positioned: .above, relativeTo: nil) }
        }
        // What lies over the terminal changed (a page, the panel over it): the pointer's rects again (Cursors.swift).
        window?.cursorRectsAgain()
        onLayout?()
    }
}

extension NSView {
    /// A frame set only when it changes: the panes are not resized for nothing.
    func setIf(_ r: NSRect) { if frame != r { frame = r } }
}

/// The middle's sheet: the strip and the stage, its corners rounded beside
/// the sidebar (.tsheet).
final class SheetView: NSView {
    override var isFlipped: Bool { true }
    var round = false { didSet { if round != oldValue { restyle() } } }
    override init(frame: NSRect) {
        super.init(frame: frame)
        restyle()
    }
    required init?(coder: NSCoder) { fatalError() }
    func restyle() {
        // A layer only for the rounded corners (beside the sidebar).
        wantsLayer = round
        layer?.cornerRadius = round ? 11 : 0
        layer?.masksToBounds = round
        layer?.borderWidth = round ? 1 : 0
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.borderColor = Design.color("sheet-ring").cgColor
            layer?.backgroundColor = Design.tbg.cgColor
        }
    }
    override func viewDidChangeEffectiveAppearance() { restyle() }
}

/// Where the tab in front goes: its content fills it.
final class StageView: NSView {
    override var isFlipped: Bool { true }
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Design.tbg.cgColor
    }
    required init?(coder: NSCoder) { fatalError() }
    override func setFrameSize(_ s: NSSize) {
        super.setFrameSize(s)
        // (A hint keeps its own place: Workspace.placeHint.)
        for v in subviews where !(v is HintView) { v.setIf(bounds) }
    }
}

/// The stage with no tab (app.ts renderNone): "No shell is open." and New
/// shell with its key, in the middle.
final class EmptyStage: NSView {
    let button = RButton(t("strip.emptyNew"), .primary)
    private let words = NSTextField(labelWithString: t("strip.empty"))
    private let key = NSTextField(labelWithString: "⌘T")
    var onNew: (() -> Void)?
    override var isFlipped: Bool { true }
    override init(frame: NSRect) {
        super.init(frame: frame)
        words.font = Fonts.pt(14)
        key.font = Fonts.pt(12)
        button.run = { [weak self] in self?.onNew?() }
        for v in [words, button, key] as [NSView] { v.translatesAutoresizingMaskIntoConstraints = false; addSubview(v) }
        NSLayoutConstraint.activate([
            words.centerXAnchor.constraint(equalTo: centerXAnchor), words.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -22),
            button.topAnchor.constraint(equalTo: words.bottomAnchor, constant: 14), button.centerXAnchor.constraint(equalTo: centerXAnchor, constant: -18),
            key.leadingAnchor.constraint(equalTo: button.trailingAnchor, constant: 10), key.centerYAnchor.constraint(equalTo: button.centerYAnchor),
        ])
        autoresizingMask = [.width, .height]
        restyle()
    }
    required init?(coder: NSCoder) { fatalError() }
    private func restyle() {
        words.textColor = Design.tfg.withAlphaComponent(0.75)
        key.textColor = Design.tfg.withAlphaComponent(0.45)
    }
    override func draw(_ dirty: NSRect) {
        Design.tbg.setFill()
        bounds.fill()
        restyle()
    }
    override func viewDidChangeEffectiveAppearance() { needsDisplay = true }
}
