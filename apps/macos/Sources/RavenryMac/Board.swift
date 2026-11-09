// The window around the terminals, as the Electron app has it
// (apps/desktop/src/renderer/app.ts): the sidebar on the left, the session
// panel on the right, and what the middle shows. One thing is in front at a
// time, and the sidebar's highlighted row, the panel and the tab in front
// always name it (SESS-006):
//
// - a tab (a shell, or a session whose ravenryd pane this window draws);
// - a session it does not draw (in cmux, iTerm2, Rex, or a ravenryd this
//   window is not on): read only in the middle, with Open in and Move here;
// - a project no session runs in: its page (Continue this conversation);
// - New session, a page (a placeholder), a picture large.
//
// A click on a row opens what it stands for; the panel folds under 1180
// points of window (PANEL_FOLD_WIDTH) and then opens over the terminal when
// a question arrives for what is in front (or with Cmd+Option+B); a
// question elsewhere is a toast with Show. The window decides nothing about
// the board: it reads the hub's state (Hub.swift) and posts the person's
// clicks.

import AppKit

final class Board: NSObject {
    static let foldWidth: CGFloat = 1180

    enum Front: Equatable {
        case tab
        case session(String)
        case project(String)
        case page(String, String)
        case start
        /// A project's brief, beside the session (or project) it was opened from.
        case brief(String, String)
    }

    let ws: Workspace
    let hub: HubClient
    let root: RootView
    let sidebar = SidebarView()
    let panel = PanelView()
    let outside = OutsideView()
    let projectPage = ProjectPageView()
    let placeholder = PlaceholderView()
    let start = StartView()
    let brief = BriefPage()
    let gallery = GalleryPage()
    /// Every view the middle shows instead of a tab's terminal.
    private var middles: [NSView] { [outside, projectPage, placeholder, start, brief, gallery] }
    /// What a page's Close goes back to.
    private var pageBack: Front = .tab
    private let toastView = ToastView()
    private(set) var front: Front = .tab
    private(set) var pinned: [String] = []
    private(set) var sideWidth: CGFloat = SidebarView.defaultWidth
    private(set) var sideHidden = false
    /// Folded by the person on a wide window (panelPref 'closed').
    private(set) var panelClosed = false
    /// Over the terminal on a narrow window.
    private(set) var overlay = false
    private var inputs: [String: [[String: Any]]] = [:]
    private var inputsAsked: [String: Date] = [:]
    private var setup: [String: (hooks: Bool, skill: Bool)] = [:]
    private var setupAt = Date.distantPast
    private var lastOpen = Set<String>()
    private var lastYou = Set<String>()
    private var timer: Timer?
    private let keep: Bool
    /// Every open and its outcome, for the self-test: "session k: its tab".
    private(set) var log: [String] = []

    init(ws: Workspace, hub: HubClient, keep: Bool, sidebarOn: Bool) {
        self.ws = ws
        self.hub = hub
        self.root = ws.root
        self.keep = keep
        super.init()
        let d = UserDefaults.standard
        if keep {
            if let w = d.object(forKey: "sidebarWidth") as? Double { sideWidth = min(SidebarView.maxWidth, max(SidebarView.minWidth, CGFloat(w))) }
            sideHidden = d.bool(forKey: "sidebarHidden")
        }
        // Measuring the terminal (the bench, its self-test): the sidebar and the panel start folded.
        if !sidebarOn { sideHidden = true; panelClosed = true }
        pinned = ws.saved.pinned
        ws.pinned = pinned
        root.sidebar = sidebar
        root.panel = panel
        root.addSubview(sidebar)
        root.addSubview(panel)
        root.sideWidth = sideHidden ? 0 : sideWidth
        ws.window.backgroundColor = Design.color("win")
        for v in [outside, projectPage, placeholder, start] as [MiddleView] { v.isHidden = true }
        outside.hub = hub; projectPage.hub = hub; start.hub = hub
        brief.isHidden = true
        brief.hub = hub
        gallery.isHidden = true
        gallery.hub = hub
        gallery.toast = { [weak self] s in self?.toast(s) }
        wire()
        hub.onState = { [weak self] st in self?.onState(st) }
        hub.onStatus = { [weak self] _ in self?.render() }
        ws.onFront = { [weak self] in
            guard let self else { return }
            // A tab came to the front (a click on the strip, a shortcut): the middle is its terminal.
            if case .tab = self.front {} else if !self.showingMiddle { self.front = .tab }
            // After the switch has drawn: the sidebar and the panel follow.
            self.renderSoon()
        }
        let prevSelect = ws.bar.onSelect
        let prevClose = ws.bar.onClose
        ws.bar.onClose = { [weak self] id in
            guard let self else { return }
            if id.hasPrefix("view:") { self.back(); return }
            prevClose?(id)
        }
        ws.bar.onSelect = { [weak self] id in
            guard let self else { return }
            if id.hasPrefix("view:") { return }
            self.front = .tab
            self.hideMiddle()
            if let t = self.ws.tabs.first(where: { $0.id == id }) { self.ws.showAgain(t) } else { prevSelect?(id) }
            self.render()
        }
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.render() }
        hub.start()
        render()
    }

    private var showingMiddle = false

    private func wire() {
        sidebar.onSession = { [weak self] k in self?.pickSession(k, why: "click") }
        sidebar.onProject = { [weak self] id in self?.pickProject(id) }
        sidebar.onPin = { [weak self] k in self?.togglePin(k) }
        sidebar.onNew = { [weak self] in self?.openStart(nil) }
        sidebar.onNav = { [weak self] key, name in self?.openPage(key, name) }
        sidebar.onResize = { [weak self] w in
            guard let self else { return }
            self.sideWidth = w
            self.root.sideWidth = w
            if self.keep { UserDefaults.standard.set(Double(w), forKey: "sidebarWidth") }
            self.root.place()
        }
        panel.host = PanelView.Host(
            hub: hub,
            pinned: { [weak self] k in self?.pinned.contains(k) ?? false },
            togglePin: { [weak self] k in self?.togglePin(k) },
            hide: { [weak self] in self?.togglePanel() },
            openPicture: { [weak self] p, pic in self?.openPicture(p, pic) },
            openPage: { [weak self] k, n in self?.openPage(k, n) },
            inputs: { [weak self] pane in self?.inputsOf(pane) },
            setup: { [weak self] a in self?.setupOf(a) },
            toast: { [weak self] s in self?.toast(s) },
            answered: { [weak self] in
                guard let self else { return }
                // Answered on a narrow window: back to the terminal.
                if self.overlay { self.overlay = false }
                self.render(force: true)
            })
        panel.onMove = { [weak self] p, s, keep in self?.move(p, s, keep: keep) }
        outside.onOpen = { [weak self] p, s in
            self?.hub.post("/api/open", ["projectId": p.id, "surfaceId": s.surfaceId]) { code, j in if code != 200 { self?.toast(j["error"] as? String ?? "\(code)") } }
        }
        outside.onMove = { [weak self] p, s in self?.move(p, s, keep: "ravenry") }
        projectPage.onContinue = { [weak self] p, l in self?.continueLast(p, l) }
        projectPage.onMoveLast = { [weak self] p, l in self?.moveLast(p, l) }
        projectPage.onNewHere = { [weak self] p in self?.openStart(p.folder) }
        projectPage.onBrief = { [weak self] p in self?.openPage("brief:\(p.id)", t("panel.brief")) }
        projectPage.onShowSession = { [weak self] k in self?.pickSession(k, why: "project page") }
        start.onStarted = { [weak self] key, pane in
            guard let self else { return }
            if let p = pane, let tb = self.ws.tab(showing: p) { self.front = .tab; self.hideMiddle(); self.ws.showAgain(tb); self.render(); return }
            if let k = key { self.pickSession(k, why: "start") } else { self.render() }
        }
        start.grid = { [weak self] in
            guard let v = self?.ws.focusedView else { return (100, 30) }
            return (v.screen.cols, v.screen.rows)
        }
        gallery.onClose = { [weak self] in self?.back() }
    }

    // MARK: what is in front

    /// The session in front's key, a project's ("project:<id>"), a shell
    /// tab's ("tab:<id>"), else nil: the sidebar's highlight and the panel follow it.
    var frontKey: String? {
        switch front {
        case .session(let k): return k
        case .project(let id): return "project:\(id)"
        case .brief(_, let k): return k
        case .tab:
            guard let t = ws.active else { return nil }
            let pane = t.focusedPane
            if let st = hub.state { for p in st.projects { for s in p.sessions where s.pane == pane { return "\(p.id)/\(s.surfaceId)" } } }
            return "tab:\(t.id)"
        default: return nil
        }
    }

    private func onState(_ st: HubState) {
        // A checkpoint or a session that came to need you: the panel opens
        // on it when it is in front, else a toast says so, with Show.
        let open = Set(st.checkpoints.filter { ["open", "running"].contains($0["state"] as? String ?? "") }.compactMap { $0["id"] as? String })
        let you = Set(st.sections.filter { $0.group == "you" }.flatMap { $0.projects.flatMap { $0.rows.map { $0.key } } })
        let newCps = open.subtracting(lastOpen)
        let newYou = you.subtracting(lastYou)
        let first = lastOpen.isEmpty && lastYou.isEmpty && log.isEmpty
        if you != lastYou || open != lastOpen { log.append("state you: \(you.sorted().joined(separator: ","))") }
        lastOpen = open; lastYou = you
        if !newYou.isEmpty || !newCps.isEmpty { log.append("state: new \((newCps.sorted() + newYou.sorted()).joined(separator: ","))\(first ? " (first)" : "")") }
        if !first {
            var arrived: [String] = []
            for id in newCps {
                if let cp = st.checkpoints.first(where: { $0["id"] as? String == id }),
                   let k = st.projects.lazy.compactMap({ p in p.sessions.first(where: { st.checkpoint(of: p, $0)?["id"] as? String == id }).map { "\(p.id)/\($0.surfaceId)" } }).first {
                    _ = cp
                    arrived.append(k)
                }
            }
            arrived += newYou.sorted()
            if let k = arrived.last { arrive(k, st) }
        }
        render()
    }

    private func arrive(_ key: String, _ st: HubState) {
        if frontKey == key {
            if !wide { overlay = true }
            log.append("arrived \(key): the panel opens")
            return
        }
        guard let f = st.find(key) else { return }
        let title = f.session.topic ?? f.project.name
        let w = f.session.words
        let what = ((w["question"] as? String) ?? (w["headline"] as? String) ?? (w["line"] as? String) ?? "").replacingOccurrences(of: "\n", with: " ")
        let said = what.isEmpty ? "." : ": " + (what.count > 70 ? String(what.prefix(69)) + "..." : what)
        let proj = title != f.project.name ? " in \(f.project.name)" : ""
        log.append("arrived \(key): a toast")
        toast("\(title)\(proj) needs you\(said)", action: ("Show", { [weak self] in self?.pickSession(key, why: "notification") }))
    }

    var wide: Bool { root.bounds.width >= Board.foldWidth }

    var panelVisible: Bool {
        switch front {
        case .start, .page: return overlay
        default: break
        }
        if overlay { return true }
        return wide && !panelClosed
    }

    func togglePanel() {
        if overlay { overlay = false } else if wide { panelClosed = panelVisible } else { overlay = true }
        log.append("panel \(panelVisible ? "shown" : "hidden")")
        render(force: true)
    }

    func toggleSidebar() {
        sideHidden.toggle()
        if keep { UserDefaults.standard.set(sideHidden, forKey: "sidebarHidden") }
        log.append("sidebar \(sideHidden ? "hidden" : "shown")")
        render()
    }

    /// The window was resized: a wide window docks the panel again.
    func resized() {
        if wide && overlay { overlay = false }
        render()
    }

    // MARK: opening

    func pickSession(_ key: String, why: String) {
        guard let st = hub.state, let f = st.find(key) else { log.append("session \(why) \(key): not on the board"); return }
        overlay = false
        // A session waiting at a checkpoint: on a narrow window the panel opens over the terminal.
        if st.checkpoint(of: f.project, f.session) != nil, !wide { overlay = true; log.append("session \(key): its question opens the panel") }
        if let pane = f.session.pane, f.session.machine == nil && f.project.machine == nil, let t = ws.tab(showing: pane) {
            front = .tab
            hideMiddle()
            ws.showAgain(t)
            log.append("session \(why) \(key): its tab \(t.id)")
        } else {
            front = .session(key)
            let why2: String? = f.session.pane != nil ? "it runs in the board's ravenryd, \(f.session.machine ?? f.project.machine ?? "not this window's")" : nil
            showMiddle(outside)
            outside.show(f.project, f.session, why: why2)
            log.append("session \(why) \(key): its view outside Ravenry")
        }
        render()
    }

    func pickProject(_ id: String) {
        guard let p = hub.state?.project(id) else { return }
        if let s = p.mainSession { pickSession("\(p.id)/\(s.surfaceId)", why: "project"); return }
        overlay = false
        front = .project(id)
        showMiddle(projectPage)
        projectPage.show(p)
        log.append("project \(id): its page")
        render()
    }

    func openStart(_ folder: String?) {
        overlay = false
        front = .start
        showMiddle(start)
        start.show(folder: folder ?? hub.state?.projects.first?.folder)
        log.append("start")
        render()
    }

    func openPage(_ key: String, _ name: String) {
        if key.hasPrefix("brief:") { openBrief(String(key.dropFirst(6))); return }
        if key.hasPrefix("gallery:") { openGallery(String(key.dropFirst(8)), at: nil); return }
        overlay = false
        notePageBack()
        front = .page(key, name)
        showMiddle(placeholder)
        placeholder.show(name)
        log.append("page \(key)")
        render()
    }

    /// The brief as a page, beside what was in front: the panel stays on it.
    func openBrief(_ pid: String) {
        overlay = false
        var k = frontKey ?? "project:\(pid)"
        if case .brief(_, let was) = front { k = was }
        if k.hasPrefix("tab:") { k = "project:\(pid)" }
        front = .brief(pid, k)
        showMiddle(brief)
        brief.show(pid, state: hub.state)
        log.append("brief \(pid)")
        render()
    }

    /// The latest picture from the panel: large, in its project's gallery.
    func openPicture(_ p: HubProject, _ pic: [String: Any]) {
        let i = GalleryPic.of(p).firstIndex { $0.url == pic["url"] as? String } ?? 0
        openGallery(p.id, at: i)
    }

    /// A project's gallery, or one of its pictures large.
    func openGallery(_ pid: String, at: Int?) {
        overlay = false
        notePageBack()
        front = .page("gallery:\(pid)", t("gallery.title"))
        showMiddle(gallery)
        gallery.show(pid, at: at, state: hub.state)
        log.append("gallery \(pid) \(at.map { "\($0)" } ?? "grid")")
        render()
    }

    /// Where a page's Close goes: what was in front before the first page.
    private func notePageBack() {
        if case .page = front { return }
        pageBack = front
    }

    /// Back from a page: what was in front before it, else the tab.
    private func back() {
        let to = pageBack
        pageBack = .tab
        if case .page = front {
            switch to {
            case .session(let k) where hub.state?.find(k) != nil: pickSession(k, why: "back"); return
            case .project(let id) where hub.state?.project(id) != nil: pickProject(id); return
            case .brief(let pid, _): front = to; showMiddle(brief); brief.show(pid, state: hub.state); render(); return
            default: break
            }
        }
        front = .tab
        hideMiddle()
        if let t = ws.active { ws.showAgain(t) }
        render()
    }

    private func showMiddle(_ v: NSView) {
        for m in middles where m !== v { m.isHidden = true }
        if v !== outside { outside.stop() }
        v.isHidden = false
        root.middle = v
        root.wideMiddle = v is InAppPage
        showingMiddle = true
        root.place()
    }

    private func hideMiddle() {
        outside.stop()
        for m in middles { m.isHidden = true }
        root.middle = nil
        root.wideMiddle = false
        showingMiddle = false
        if let t = ws.active, let v = ws.boxes[t.focusedPane]?.term { ws.window.makeFirstResponder(v) }
    }

    func togglePin(_ key: String) {
        if let i = pinned.firstIndex(of: key) { pinned.remove(at: i) } else { pinned.append(key) }
        ws.pinned = pinned
        ws.save()
        log.append("pin \(key): \(pinned.contains(key) ? "on" : "off")")
        render(force: true)
    }

    // MARK: moves and Continue, as the person clicked them

    private func move(_ p: HubProject, _ s: HubSession, keep: String) {
        guard let sid = s.sessionId else { return }
        outside.moving.insert(sid)
        render(force: true)
        let g = start.grid()
        hub.post("/api/sessions/move", ["projectId": p.id, "sessionId": sid, "keep": keep, "cols": g.cols, "rows": g.rows]) { [weak self] code, j in
            guard let self else { return }
            self.outside.moving.remove(sid)
            if code != 200 || !(j["ok"] as? Bool ?? false) { self.toast(t("move.notDone", ["why": j["error"] as? String ?? "the board answered \(code)"])) }
            else if let sf = j["surfaceId"] as? String { self.pickSession("\(p.id)/\(sf)", why: "move") }
            self.render(force: true)
        }
    }

    private func continueLast(_ p: HubProject, _ l: [String: Any]) {
        guard let sid = l["sessionId"] as? String else { return }
        projectPage.busy = true; projectPage.error = nil; projectPage.draw(p)
        let g = start.grid()
        hub.post("/api/sessions/resume", ["projectId": p.id, "sessionId": sid, "cols": g.cols, "rows": g.rows]) { [weak self] code, j in
            guard let self else { return }
            self.projectPage.busy = false
            if code != 200 { self.projectPage.error = j["error"] as? String ?? "It could not be continued."; self.projectPage.draw(p); return }
            if let pane = (j["pane"] as? [String: Any])?["id"] as? String, let tb = self.ws.tab(showing: pane) {
                self.front = .tab; self.hideMiddle(); self.ws.showAgain(tb); self.render(); return
            }
            if let pid = j["projectId"] as? String, let sf = j["surfaceId"] as? String { self.pickSession("\(pid)/\(sf)", why: "continue") }
        }
    }

    private func moveLast(_ p: HubProject, _ l: [String: Any]) {
        guard let sid = l["sessionId"] as? String else { return }
        projectPage.busy = true; projectPage.draw(p)
        let g = start.grid()
        hub.post("/api/sessions/move", ["projectId": p.id, "sessionId": sid, "keep": "ravenry", "cols": g.cols, "rows": g.rows]) { [weak self] code, j in
            guard let self else { return }
            self.projectPage.busy = false
            if code != 200 { self.projectPage.error = j["error"] as? String ?? "It could not be moved."; self.projectPage.draw(p); return }
            if j["waiting"] as? Bool ?? false { self.toast("It moves here once Claude finishes its turn in \(j["name"] as? String ?? "the other terminal")."); return }
            if let sf = j["surfaceId"] as? String { self.pickSession("\(p.id)/\(sf)", why: "move") }
        }
    }

    // MARK: what the panel reads besides the state

    private func inputsOf(_ pane: String) -> [[String: Any]]? {
        guard ws.paneInfo(pane) != nil || ws.tabs.contains(where: { $0.host == pane || $0.guest == pane }) else { return nil }
        if Date().timeIntervalSince(inputsAsked[pane] ?? .distantPast) > 3 {
            inputsAsked[pane] = Date()
            ws.conn.request("pane.inputs", ["pane": pane, "limit": 50]) { [weak self] r in
                guard case .success(let j) = r, let recs = j["inputs"] as? [[String: Any]] else { return }
                DispatchQueue.main.async {
                    guard let self else { return }
                    let changed = self.inputs[pane]?.count != recs.count
                    self.inputs[pane] = recs
                    if changed { self.render() }
                }
            }
        }
        return inputs[pane] ?? []
    }

    private func setupOf(_ a: String) -> (hooks: Bool, skill: Bool)? {
        if Date().timeIntervalSince(setupAt) > 30 {
            setupAt = Date()
            hub.get("/api/setup/skills") { [weak self] code, j in
                guard let self, code == 200 else { return }
                var next: [String: (hooks: Bool, skill: Bool)] = [:]
                for r in j["skills"] as? [[String: Any]] ?? [] where r["found"] as? Bool ?? false {
                    if let k = r["kind"] as? String { next[k] = (r["hooks"] as? String == "on", r["installed"] as? Bool ?? false) }
                }
                self.setup = next
                self.render()
            }
        }
        return setup[a]
    }

    // MARK: drawing

    private var renderQueued = false
    func renderSoon() {
        guard !renderQueued else { return }
        renderQueued = true
        // A moment after a tab switch: the new tab's first frames draw first.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            guard let self else { return }
            self.renderQueued = false
            let t0 = CACurrentMediaTime()
            self.render()
            if self.ws.options.bench != nil { NSLog("board render %.2f ms", (CACurrentMediaTime() - t0) * 1000) }
        }
    }

    func render(force: Bool = false) {
        let st = hub.state
        // A session in front that left the board: its view says so.
        if case .session(let k) = front, let st, st.find(k) == nil { outside.stop() }
        if case .session(let k) = front, let f = st?.find(k) { outside.show(f.project, f.session, why: f.session.pane != nil ? "it runs in the board's ravenryd" : nil) }
        if case .project(let id) = front, let p = st?.project(id) { projectPage.show(p) }
        if case .brief(let pid, _) = front { brief.show(pid, state: st) }
        if case .page(let k, _) = front, k.hasPrefix("gallery:") { gallery.refresh(st) }
        root.sideWidth = sideHidden ? 0 : sideWidth
        root.panelMode = panelVisible ? (overlay || !wide ? .overlay : .docked) : .hidden
        panel.isOverlay = root.panelMode == .overlay
        let bg = sideHidden ? Design.termBg : Design.color("win")
        if ws.window.backgroundColor != bg { ws.window.backgroundColor = bg }
        let fk = frontKey
        var page: String? = nil
        if case .page(let k, _) = front { page = k }
        if !sideHidden { sidebar.update(state: st, reachable: hub.reachable, front: fk, pinned: Set(pinned), page: page, alerts: (st?.counts["you"] ?? 0) > 0) }
        if panelVisible {
            var pane: (id: String, name: String, cwd: String, command: [String])? = nil
            if case .tab = front, let t = ws.active, let i = ws.paneInfo(t.focusedPane) {
                pane = (i.id, ws.label(i.id).name, i.cwd, i.command)
            }
            if case .session = front {} else if fk?.hasPrefix("tab:") == false, let t = ws.active, let i = ws.paneInfo(t.focusedPane), case .tab = front {
                pane = (i.id, ws.label(i.id).name, i.cwd, i.command)
            }
            panel.update(state: st, front: fk?.hasPrefix("tab:") == true ? nil : fk, pane: pane, force: force)
        }
        ws.extraTab = middleTab(st)
        root.place()
        toastView.place(in: root)
    }

    /// The middle's tab: a session's name and its project, a page's name.
    private func middleTab(_ st: HubState?) -> TabModel? {
        switch front {
        case .session(let k):
            guard let f = st?.find(k) else { return nil }
            let name = f.session.topic ?? f.project.name
            let g = st?.sections.first { $0.projects.contains { $0.rows.contains { $0.key == k } } }?.group ?? f.session.group
            return TabModel(id: "view:\(k)", name: name, sub: name == f.project.name ? nil : f.project.name, split: false, active: true, tip: name, dot: g)
        case .project(let id):
            guard let p = st?.project(id) else { return nil }
            return TabModel(id: "view:project", name: p.name, sub: nil, split: false, active: true, tip: p.name, dot: "idle")
        case .page(_, let name): return TabModel(id: "view:page", name: name, sub: nil, split: false, active: true, tip: name, dot: "tx3")
        case .start: return TabModel(id: "view:start", name: t("start.title"), sub: nil, split: false, active: true, tip: t("start.title"), dot: "tx3")
        case .brief(let pid, _):
            return TabModel(id: "view:brief", name: t("brief.title"), sub: st?.project(pid)?.name, split: false, active: true, tip: t("brief.title"), dot: "tx3")
        case .tab: return nil
        }
    }

    // MARK: the menus' commands

    @objc func menuNewSession(_ sender: Any?) { openStart(nil) }
    @objc func menuToggleSidebar(_ sender: Any?) { toggleSidebar() }
    @objc func menuTogglePanel(_ sender: Any?) { togglePanel() }
    @objc func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(menuToggleSidebar(_:)) { item.title = sideHidden ? t("side.show") : t("side.hide") }
        return true
    }

    // MARK: toasts

    func toast(_ text: String, action: (String, () -> Void)? = nil) {
        log.append("toast \(text)")
        toastView.show(text, action: action, in: root)
    }
}

/// A toast at the bottom of the window (.toast): 5 s, 12 s with an action.
final class ToastView: Box {
    private var timer: Timer?
    private(set) var text = ""
    private(set) var button: RButton?
    init() { super.init(fill: "card2", radius: 9) }
    required init?(coder: NSCoder) { fatalError() }
    func show(_ s: String, action: (String, () -> Void)?, in root: NSView) {
        subviews.forEach { $0.removeFromSuperview() }
        text = s
        let l = label(s, Fonts.pt(12.5), "tx", lines: 2)
        l.preferredMaxLayoutWidth = 520
        var items: [NSView] = [l]
        if let (name, run) = action {
            let b = RButton(name, .link) { [weak self] in self?.hide(); run() }
            button = b
            items.append(b)
        } else { button = nil }
        let x = RButton("Dismiss", .icon, small: true, icon: "close")
        x.removeConstraints(x.constraints.filter { $0.firstAttribute == .width || $0.firstAttribute == .height })
        x.widthAnchor.constraint(equalToConstant: 20).isActive = true
        x.heightAnchor.constraint(equalToConstant: 20).isActive = true
        x.run = { [weak self] in self?.hide() }
        items.append(x)
        let st = hstack(items, spacing: 12, insets: NSEdgeInsets(top: 9, left: 14, bottom: 9, right: 14))
        addSubview(st)
        st.frame.size = st.fittingSize
        frame.size = st.fittingSize
        if superview !== root { root.addSubview(self, positioned: .above, relativeTo: nil) }
        isHidden = false
        place(in: root)
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: action == nil ? 5 : 12, repeats: false) { [weak self] _ in self?.hide() }
    }
    func hide() { isHidden = true; text = "" }
    func place(in root: NSView) {
        guard superview === root, !isHidden else { return }
        root.addSubview(self, positioned: .above, relativeTo: nil)
        frame.origin = NSPoint(x: (root.bounds.width - frame.width) / 2, y: root.bounds.height - frame.height - 20)
    }
}
