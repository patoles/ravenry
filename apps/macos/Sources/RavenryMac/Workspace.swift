// The window's tabs and splits, as the Electron app's terminal area has
// them (apps/desktop/src/renderer/app.ts: newShell, splitNew, closeTab,
// removeTab, stepTab, focus-pane, layoutSplit, restoreTabs, save):
//
// - A tab per pane: the daemon's panes labelled ravenry.kind: shell, each
//   named as the Electron app names it (shellLabel: the pane's own name,
//   else the program's title, else the program; its folder after it).
// - Cmd+T or the + opens a shell in the folder of the pane in front;
//   Cmd+W closes the pane with the keyboard (its tab, or its split's
//   pane, the tab whole again) and ends its process; the last tab gone,
//   the window closes. Cmd+1 to Cmd+9, Cmd+Shift+[ and ], Ctrl+Tab and
//   Ctrl+Shift+Tab pick a tab; a tab is dragged along the strip.
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
    /// Offscreen: what closing a busy shell asked (the self-test answers
    /// with closeAnswer instead of a sheet).
    private(set) var closeAsked: [String] = []
    var closeAnswer: (close: Bool, dont: Bool) = (true, false)
    /// The bells of panes not on screen that rang a sound or the Dock (offscreen).
    private(set) var bellsHeard: [String] = []
    /// Each switch's times: to the first draw of the tab in front, and to
    /// the first frame of its new streams (the bench reads them).
    var onSwitch: ((_ tab: String, _ drawnMs: Double, _ frameMs: Double, _ hadRows: Bool) -> Void)?
    let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()

    init(window: TerminalWindow, options: Options, daemons: Daemons, scale: CGFloat) {
        self.window = window
        self.options = options
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
        v.onFontSize = { [weak self] s in self?.setFontSize(s) }
        v.windowMinSize = { [weak self] in self?.minContentSize() ?? .zero }
        let b = PaneBox(term: v)
        b.onClose = { [weak self] in self?.askClose(pane) { self?.closePane(pane) } }
        b.onClickHead = { [weak self, weak v] in if let v { self?.window.makeFirstResponder(v) } }
        boxes[pane] = b
        return b
    }

    /// A pane as the tabs name it (app.ts shellLabel): its own name (not
    /// the default "Shell"), else the title its program set, else the
    /// program; and its folder (~ for home) when that is not the name.
    func label(_ pane: String) -> (name: String, sub: String?) {
        let i = info[pane] ?? PaneInfo(id: pane)
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

    // MARK: the start

    /// The tabs the daemon has (its shells), in the saved order with the
    /// saved splits, the saved one in front; a new shell when none.
    func restore() throws {
        // Every daemon's, the newest first (a pane id names one pane across daemons).
        var panes: [[String: Any]] = []
        for (k, d) in daemons.all.enumerated() {
            let mine: [[String: Any]]
            do {
                mine = try shells(of: d)
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
        let saved = layout?.read() ?? SavedLayout()
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
            guard let id = try newPane(cwd: nil, size: stage.bounds.size) else { throw ConnectionError.connect("no pane") }
            tabs = [Tab(host: id)]
        }
        show(front ?? tabs[0], wait: true)
    }

    /// A daemon's tabs: its shells, the pane --attach names, its agents' own panes.
    private func shells(of d: DaemonLink) throws -> [[String: Any]] {
        let c = d.conn
        let r = try c.call("pane.list", ["labels": ["ravenry.kind": "shell"]])
        var panes = (r["panes"] as? [[String: Any]] ?? []).filter { ($0["state"] as? String ?? "running") == "running" }
        if let a = options.attach, !panes.contains(where: { $0["id"] as? String == a }) {
            let all = try c.call("pane.list", ["hidden": true])
            panes += (all["panes"] as? [[String: Any]] ?? []).filter { $0["id"] as? String == a }
        }
        // The agents' own panes: tabs too, beside their sessions'.
        if let all = try? c.call("pane.list", [:]) {
            for p in all["panes"] as? [[String: Any]] ?? [] where isAgentPane(p) && !panes.contains(where: { $0["id"] as? String == p["id"] as? String }) { panes.append(p) }
        }
        return panes
    }

    /// A daemon that started after the window (a newer app's, an update):
    /// its shells and its agents' own panes are tabs at the end, in the
    /// saved order, the tab in front stays.
    func joined(_ d: DaemonLink) {
        guard let mine = try? shells(of: d) else { return }
        let saved = layout?.read() ?? SavedLayout()
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
    }

    /// A daemon went away: its panes' tabs go (their processes went with it).
    func left(_ d: DaemonLink) {
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

    /// A new shell in the newest daemon (pane.new), labelled as the app's shells.
    @discardableResult
    func newPane(cwd: String?, size: NSSize) throws -> String? {
        let r = Renderer(scale: scale, fontName: look.font, fontSize: look.size)
        let g = r?.grid(for: NSSize(width: max(size.width, 160), height: max(size.height, 80))) ?? (cols: 80, rows: 24)
        var params: [String: Any] = ["cols": g.cols, "rows": g.rows, "name": "Shell", "labels": ["ravenry.kind": "shell"], "scrollback": look.scrollback]
        if !options.command.isEmpty { params["command"] = options.command }
        if options.bench != nil || options.selftest != nil { params["cwd"] = home } else if let c = cwd, !c.isEmpty { params["cwd"] = c }
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
        onFront?()
    }

    // MARK: the sidebar's and the panel's (Board.swift)

    /// What the middle shows when it is not a tab's terminal (a session
    /// outside, a page), as a tab after the others (the Electron app's).
    var extraTab: TabModel? { didSet { if extraTab != oldValue { refresh() } } }
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
        }
    }

    /// The tab strip, the headers and the window's title, from the model.
    func refresh() {
        var models = tabs.enumerated().map { i, t in
            let l = label(t.host)
            let m = marksOf?(t.host)
            let on = t === active && extraTab == nil
            return TabModel(id: t.id, name: l.name, sub: l.sub, split: t.guest != nil, active: on,
                            tip: i < 9 ? "\(l.name) (⌘\(i + 1))" : l.name, dot: m?.group,
                            bell: bells.contains(t.id), activity: activity.contains(t.id), lent: m?.lent?.who, lentCls: m?.lent?.cls ?? "other")
        }
        if let x = extraTab { models.append(x) }
        bar.set(models)
        if let t = shownTab { updateBoxes(t) }
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

    func move(id: String, to: Int) {
        guard let i = tabs.firstIndex(where: { $0.id == id }) else { return }
        let t = tabs.remove(at: i)
        tabs.insert(t, at: min(max(0, to), tabs.count))
        refresh()
        save()
    }

    /// Cmd+T: a shell in the folder of the pane in front, in a new tab
    /// after the last.
    func newTab(_ sender: Any?) { newTab(in: active.flatMap { info[$0.focusedPane]?.cwd }) }

    /// A shell in a folder, in a new tab after the last (New session with no assistant here).
    func newTab(in cwd: String?) {
        do {
            guard let id = try newPane(cwd: cwd, size: stage.bounds.size) else { return }
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

    /// Cmd+W: the pane with the keyboard.
    func closeFocused() {
        guard let t = active else { return }
        let id = t.focusedPane
        askClose(id) { [weak self] in self?.closePane(id) }
    }

    func closeTab(_ t: Tab) {
        askClose(t.host) { [weak self] in
            guard let self else { return }
            for id in self.panes(of: t) { self.closePane(id) }
        }
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
        if options.offscreen {
            closeAsked.append("\(title) \(body)")
            return answer(closeAnswer.close, closeAnswer.dont)
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
        a.beginSheetModal(for: window) { r in
            answer(r == .alertFirstButtonReturn, a.suppressionButton?.state == .on)
        }
    }

    /// Closes a pane: its process ends (pane.close); its tab goes, or its
    /// split's other pane is the tab, whole again.
    func closePane(_ id: String) {
        let c = conn(of: id)
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
                    window.close()
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
        guard let p = ev["pane"] as? [String: Any], let id = p["id"] as? String else { return }
        switch name {
        case "pane.title", "pane.cwd", "pane.updated", "pane.created":
            info[id]?.update(p)
            if isAgentPane(p), !tabs.contains(where: { $0.host == id || $0.guest == id }) { homes[id] = homes[id] ?? d; addAgentPane(p) }
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
    func addAgentPane(_ p: [String: Any]) {
        guard let id = p["id"] as? String, let owner = (p["creator"] as? [String: Any])?["pane"] as? String else { return }
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
    }

    /// A pane's program ended: its tab goes (the pane too, from the daemon).
    private func ended(_ id: String) {
        if held.contains(id) { endedHeld.insert(id); return }
        closePane(id)
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
        layout.save(order: order, splits: splits, active: active?.id, pinned: pinned)
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
    private var placedFor: (NSSize, CGFloat, PanelMode, Int)?
    func place() {
        let w = bounds.width, h = bounds.height
        if let f = panelModeFor { panelMode = f(w) }
        // Nothing moved: nothing to lay out (Board draws at every state).
        let key = (bounds.size, sideWidth, panelMode, middle != nil && !wideMiddle ? 1 : middle != nil ? 2 : 0)
        if let k = placedFor, k.0 == key.0, k.1 == key.1, k.2 == key.2, k.3 == key.3, middle == nil || middle?.frame == (wideMiddle ? sheet.bounds : NSRect(x: 0, y: Design.stripHeight, width: sheet.bounds.width, height: max(1, sheet.bounds.height - Design.stripHeight))) { return }
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
        bar?.lead = side ? 8 : Design.stripLead
        bar?.setIf(NSRect(x: 0, y: 0, width: sheet.bounds.width, height: Design.stripHeight))
        var sh: CGFloat = 0
        if let st = strip {
            if st.superview !== sheet { sheet.addSubview(st) }
            sh = st.height(for: sheet.bounds.width)
            st.setIf(NSRect(x: 0, y: Design.stripHeight, width: sheet.bounds.width, height: sh))
        }
        stage?.setIf(NSRect(x: 0, y: Design.stripHeight + sh, width: sheet.bounds.width, height: max(1, sheet.bounds.height - Design.stripHeight - sh)))
        if let mv = middle {
            if mv.superview !== sheet || wideMiddle { sheet.addSubview(mv, positioned: .above, relativeTo: wideMiddle ? bar : stage) }
            mv.setIf(wideMiddle ? sheet.bounds : NSRect(x: 0, y: Design.stripHeight, width: sheet.bounds.width, height: max(1, sheet.bounds.height - Design.stripHeight)))
        }
        if let p = panel, panelMode != .hidden {
            if p.superview !== self { addSubview(p) }
            p.setIf(NSRect(x: w - pw - 8, y: 8, width: pw, height: max(1, h - 16)))
            (p as? Box)?.dropShadow = panelMode == .overlay
            p.needsDisplay = true
            if panelMode == .overlay { addSubview(p, positioned: .above, relativeTo: nil) }
        }
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
        for v in subviews { v.setIf(bounds) }
    }
}
