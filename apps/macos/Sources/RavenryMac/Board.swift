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
    let plan = PlanPage()
    let idea = IdeaPage()
    let alerts = AlertsPage()
    /// Decisions (the sidebar's fixed row "decisions").
    let decisions = DecisionsPage()
    private var decTimer: Timer?
    /// The sidebar's pages from page files (Objectives, Plans, Ideas, Rules, Ship and added ones).
    let files = FilePage()
    /// Learn Ravenry (the foot's ?, Help), Machines (the foot's server mark) and the phone card (the foot's phone).
    let learn = LearnPage()
    let machines = MachinesPage()
    let phoneCard = PhoneCard()
    let notifier: Notifier
    /// The project of the session the person last had open (a page's Ask Claude to fix).
    private(set) var lastProject: String?
    /// Every view the middle shows instead of a tab's terminal.
    private var middles: [NSView] { [outside, projectPage, placeholder, start, brief, gallery, plan, idea, alerts, files, decisions, learn, machines] }
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
        notifier = Notifier(standIn: !keep)
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
        for f in [plan, idea, alerts, files, decisions, learn, machines] as [FormPage] {
            f.isHidden = true
            f.hub = hub
            f.toast = { [weak self] s in self?.toast(s) }
            f.onClose = { [weak self] in self?.back() }
        }
        alerts.pairPhone = { [weak self] in self?.openPhone() }
        learn.tryIt = { [weak self] c in self?.tryIt(c) }
        machines.copy = { Outside.copy($0) }
        machines.onList = { [weak self] in self?.render() }
        phoneCard.hub = hub
        phoneCard.anchorOf = { [weak self] in self?.sidebar.footButtons["side.phone"] }
        phoneCard.toast = { [weak self] s in self?.toast(s) }
        phoneCard.onClose = { [weak self] in self?.render() }
        files.host = FilePage.Host(
            rows: { [weak self] in self?.hub.state?.pages ?? [] },
            pickSession: { [weak self] k in self?.pickSession(k, why: "page") },
            pickProject: { [weak self] name in
                guard let self, let st = self.hub.state else { return false }
                let n = name.lowercased()
                guard let p = st.projects.first(where: { $0.id.lowercased() == n || $0.name.lowercased() == n }) else { return false }
                self.pickProject(p.id)
                return true
            },
            openPage: { [weak self] k in
                guard let self else { return }
                self.openPage(k, self.hub.state?.pages.first { $0.key == k }?.label ?? k)
            },
            openPlan: { [weak self] pid, title in self?.openPlan(pid, title: title) },
            openIdea: { [weak self] id in self?.openIdea(id) },
            lastProject: { [weak self] in self?.lastProject },
            toast: { [weak self] s, a in self?.toast(s, action: a) })
        // Mac notifications the hub sends this app (Notifier.swift): posted, and macOS's answer sent back.
        hub.onNotify = { [weak self] j in
            guard let self, let q = Notifier.request(j) else { return }
            self.notifier.post(q) { r in
                self.log.append("notify \(q.title): \(r["ok"] as? Bool == true ? "shown" : "not shown")")
                self.hub.post("/api/alerts/desktop/result", r) { _, _ in }
            }
        }
        notifier.onOpen = { [weak self] q in
            guard let self, let pid = q.projectId else { return }
            if let sf = q.surfaceId, self.hub.state?.find("\(pid)/\(sf)") != nil { self.pickSession("\(pid)/\(sf)", why: "notification") } else if self.hub.state?.project(pid) != nil { self.pickProject(pid) }
        }
        // In front: the hub sends the next Mac notification here, not to another app beside it.
        NotificationCenter.default.addObserver(forName: NSWindow.didBecomeKeyNotification, object: ws.window, queue: .main) { [weak self] _ in self?.reportFocus() }
        idea.openIdeas = { [weak self] in
            guard let self else { return }
            if let p = self.hub.state?.pages.first(where: { $0.icon == "idea" }) { self.openPage(p.key, p.label) } else { self.back() }
        }
        plan.openBrief = { [weak self] pid in self?.openBrief(pid) }
        // The ledger: the sidebar's count read every 3 s (as the Electron app
        // reads it), and an agent's save said at once with Undo and Show.
        decisions.changed = { [weak self] in self?.readDecisions() }
        hub.onDecision = { [weak self] j in self?.onDecision(j) }
        decTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.readDecisions() }
        readDecisions()
        plan.openPlan = { [weak self] pid in self?.openPlan(pid, title: nil) }
        plan.showSession = { [weak self] pid in
            guard let self, let p = self.hub.state?.project(pid), let s = p.mainSession else { return false }
            self.pickSession("\(p.id)/\(s.surfaceId)", why: "plan")
            return true
        }
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
        lastProject = f.project.id
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
        if key.hasPrefix("plan:") { openPlan(String(key.dropFirst(5)), title: nil); return }
        if key.hasPrefix("newplan:") { openNewPlan(String(key.dropFirst(8))); return }
        if key.hasPrefix("idea:") { openIdea(String(key.dropFirst(5))); return }
        if key == "side.alerts" { openAlerts(); return }
        if key == "decisions" { openDecisions(); return }
        if key == "side.learn" { openLearn(); return }
        if key == "side.machines" { openMachines(); return }
        if key == "side.phone" { if phoneCard.isOpen { phoneCard.close() } else { openPhone() }; return }
        // The foot's Settings, and the panel's way to Settings when the first-launch step was off (its Skills).
        if key == "side.settings" || key == "settings" { openSettings(key == "settings" ? "skills" : nil); return }
        if hub.state?.pages.contains(where: { $0.key == key }) == true { openFilePage(key, name); return }
        overlay = false
        notePageBack()
        front = .page(key, name)
        showMiddle(placeholder)
        placeholder.show(name)
        log.append("page \(key)")
        render()
    }

    /// A page from a page file, as the hub draws it.
    func openFilePage(_ key: String, _ name: String) {
        overlay = false
        notePageBack()
        front = .page(key, name)
        showMiddle(files)
        files.show(key)
        log.append("page \(key): drawn")
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

    /// A project's plan: the one with this title, else the one its page shows first.
    func openPlan(_ pid: String, title: String?) {
        overlay = false
        notePageBack()
        front = .page("plan:\(pid)", t("panel.plan"))
        showMiddle(plan)
        plan.show(pid, mode: .plan, title: title, state: hub.state)
        log.append("plan \(pid) \(title ?? "-")")
        render()
    }

    /// A new plan drafted from a project's brief.
    func openNewPlan(_ pid: String) {
        overlay = false
        notePageBack()
        front = .page("newplan:\(pid)", t("panel.newPlan"))
        showMiddle(plan)
        plan.show(pid, mode: .new, state: hub.state)
        log.append("newplan \(pid)")
        render()
    }

    /// Alerts: Mac notifications, the phone and one other way.
    func openAlerts() {
        overlay = false
        notePageBack()
        front = .page("side.alerts", t("alerts.title"))
        showMiddle(alerts)
        alerts.show()
        log.append("alerts")
        render()
    }

    /// The Settings window (SettingsWindow.swift), on the shared settings file (offscreen: in memory, or RAVENRY_DESKTOP_DATA's).
    private(set) lazy var settings = SettingsWindow(store: SettingsStore(offscreen: !keep), hub: hub, offscreen: !keep)
    func openSettings(_ tab: String? = nil) {
        settings.show(tab)
        log.append("settings \(settings.tab)")
    }
    @objc func menuSettings(_ sender: Any?) { openSettings() }

    /// Learn Ravenry; `lit`: the card a hint's Learn more points at.
    func openLearn(lit: String? = nil) {
        overlay = false
        notePageBack()
        front = .page("side.learn", t("learn.title"))
        showMiddle(learn)
        learn.show(lit: lit)
        log.append("learn\(lit.map { " \($0)" } ?? "")")
        render()
    }
    @objc func menuLearn(_ sender: Any?) { openLearn() }

    /// Machines: the computers the hub reaches over ssh.
    func openMachines() {
        overlay = false
        notePageBack()
        front = .page("side.machines", t("mach.title"))
        showMiddle(machines)
        machines.show()
        log.append("machines")
        render()
    }

    /// The phone card over the sidebar's phone mark (the sidebar shown first).
    func openPhone() {
        if sideHidden { sideHidden = false; render(force: true) }
        guard let mark = sidebar.footButtons["side.phone"] else { return }
        markUsed("phone")
        phoneCard.open(in: root, above: mark)
        ws.window.makeFirstResponder(phoneCard)
        log.append("phone card")
        render()
    }

    /// A part of Ravenry used, for Learn's ticks (the hub's marks, POST /api/onboarding).
    func markUsed(_ k: String) {
        if learn.used[k] == true { return }
        hub.post("/api/onboarding", ["learn": [k: true]]) { [weak self] code, _ in if code == 200 { self?.learn.load() } }
    }

    /// Try it, a Learn card's action (app.ts tryIt()).
    func tryIt(_ c: LearnPage.Card) {
        log.append("try \(c.key)")
        if c.key == "phone" { back(); openPhone(); return }
        if c.key == "film" {
            // The terminal that printed last; the filmstrip itself is not native yet.
            guard let tb = ws.tabs.max(by: { (ws.paneInfo($0.host)?.lastOutput ?? "") < (ws.paneInfo($1.host)?.lastOutput ?? "") }) else { toast(t("learn.filmNeeds")); return }
            front = .tab; hideMiddle(); ws.showAgain(tb); render()
            return
        }
        guard hub.reachable else { toast(t("learn.noBoard")); return }
        hub.get("/api/setup/start") { [weak self] code, j in
            guard let self else { return }
            let found = (j["assistants"] as? [[String: Any]] ?? []).filter { $0["found"] as? Bool == true }
            guard let a = found.first(where: { $0["kind"] as? String == "claude" }) ?? found.first, let kind = a["kind"] as? String else { self.toast(t("learn.noAssistant")); return }
            // The last folder used: the project of the session last open, else the first folder the hub offers.
            let lp = self.lastProject.flatMap { self.hub.state?.project($0) }
            let folders = (j["folders"] as? [[String: Any]] ?? []).compactMap { $0["path"] as? String }
            let folder = lp?.folder ?? folders.first ?? NSHomeDirectory()
            let g = self.ws.focusedView.map { ($0.screen.cols, $0.screen.rows) } ?? (100, 30)
            var body: [String: Any] = ["folder": folder, "assistant": kind, "cols": g.0, "rows": g.1]
            if c.worktree, let p = lp { body["worktree"] = true; body["projectId"] = p.id }
            self.hub.post("/api/sessions/start", body) { [weak self] code, r in
                guard let self else { return }
                if code != 200 {
                    // The hub's words may already say it could not start.
                    let why = r["error"] as? String ?? "\(code)"
                    self.toast(why.hasPrefix("Could not start") ? why : t("learn.failed", ["why": why])); return
                }
                let pane = (r["pane"] as? [String: Any])?["id"] as? String
                if let p = pane, let tb = self.ws.tab(showing: p) { self.front = .tab; self.hideMiddle(); self.ws.showAgain(tb); self.render() }
                else if let pid = r["projectId"] as? String, let sid = r["surfaceId"] as? String { self.pickSession("\(pid)/\(sid)", why: "try it") }
                if let p = pane, let m = c.message { self.readyMessage(p, m) }
            }
        }
    }

    /// The card's message in the new session's input once its screen has been still 1.5 s (not sent), else on the clipboard.
    private func readyMessage(_ pane: String, _ text: String, since: Date = Date(), last: String = "", still: Date = Date()) {
        if Date().timeIntervalSince(since) > 40 { Outside.copy(text); toast(t("learn.onClipboard")); return }
        let v = ws.boxes[pane]?.term
        let now = v.map { $0.screen.text().trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
        if !now.isEmpty, now == last, Date().timeIntervalSince(still) >= 1.5, let v {
            v.pasteText(text)
            log.append("try: message ready in \(pane)")
            return
        }
        let s2 = now == last ? still : Date()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.readyMessage(pane, text, since: since, last: now, still: s2) }
    }

    /// Decisions; `lit`: the one a toast's Show points at.
    func openDecisions(lit: String? = nil) {
        markUsed("decisions")
        overlay = false
        notePageBack()
        front = .page("decisions", t("side.decisions"))
        showMiddle(decisions)
        decisions.show(lit: lit)
        log.append("decisions\(lit.map { " \($0)" } ?? "")")
        render()
    }

    /// The sidebar's count of the active decisions and its dot (GET /api/decisions?page=1).
    func readDecisions() {
        hub.get("/api/decisions?page=1") { [weak self] code, j in
            guard let self, code == 200 else { return }
            let d = (count: j["active"] as? Int ?? 0, live: j["undoable"] as? Bool ?? false)
            if d != self.sidebar.decisions { self.sidebar.decisions = d; self.render() }
        }
    }

    /// The ledger changed on the hub: an agent's save is said at once, with Undo for its minute and Show.
    func onDecision(_ j: [String: Any]) {
        readDecisions()
        if case .page("decisions", _) = front { decisions.load() }
        guard j["type"] as? String == "saved", let d = j["decision"] as? [String: Any], d["by"] as? String != "person", let id = d["id"] as? String else { return }
        let scope = d["scope"] as? String
        let replaced = !((d["overrides"] as? [Any]) ?? []).isEmpty
        let quote = d["quote"] as? String ?? ""
        let text = replaced ? (scope.map { t("dec.replacedScope", ["scope": $0]) } ?? t("dec.replacedToast"))
            : (scope.map { t("dec.savedScope", ["scope": $0]) } ?? t("dec.savedQuote", ["quote": Self.short(quote, 48)]))
        var acts: [(String, () -> Void)] = []
        if let u = When.date(d["undo_until"] as? String ?? j["undo_until"] as? String), u > When.now() {
            acts.append((t("dec.undo"), { [weak self] in
                self?.hub.post("/api/decisions/undo", ["id": id]) { code, r in
                    self?.toast(code == 200 ? t("dec.undone") : r["error"] as? String ?? t("dec.undoOver"))
                    self?.readDecisions()
                    if case .page("decisions", _) = self?.front { self?.decisions.load() }
                }
            }))
        }
        acts.append((t("dec.show"), { [weak self] in self?.openDecisions(lit: id) }))
        toast(text, actions: acts)
    }

    /// The quote cut at a word near `n` characters (decisions.ts short()).
    static func short(_ s: String, _ n: Int) -> String {
        guard s.count > n else { return s }
        var cut = String(s.prefix(n - 1))
        if let r = cut.range(of: "\\s+\\S*$", options: .regularExpression) { cut.removeSubrange(r) }
        return cut + "..."
    }

    /// The window came to the front: the hub's next Mac notification comes to this app.
    func reportFocus() {
        hub.post("/api/alerts/desktop/focus", ["client": hub.client]) { _, _ in }
    }

    /// An idea's thread.
    func openIdea(_ id: String) {
        overlay = false
        notePageBack()
        front = .page("idea:\(id)", t("idea.ideas"))
        showMiddle(idea)
        idea.show(id)
        log.append("idea \(id)")
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
        if case .page(let k, _) = front, k.hasPrefix("plan:") || k.hasPrefix("newplan:") { plan.refresh(st) }
        if case .page(let k, _) = front, k == files.key { files.refresh() }
        root.sideWidth = sideHidden ? 0 : sideWidth
        root.panelMode = panelVisible ? (overlay || !wide ? .overlay : .docked) : .hidden
        panel.isOverlay = root.panelMode == .overlay
        let bg = sideHidden ? Design.termBg : Design.color("win")
        if ws.window.backgroundColor != bg { ws.window.backgroundColor = bg }
        let fk = frontKey
        var page: String? = nil
        if case .page(let k, _) = front { page = k }
        // The foot: the Machines mark's dot (the hub's cards less what the page folded), and the marks lit.
        sidebar.machinesDot = machines.attention(in: st)
        var on = Set<String>()
        if phoneCard.isOpen { on.insert("side.phone") }
        if case .page(let k, _) = front, k == "side.learn" || k == "side.machines" { on.insert(k) }
        sidebar.footOn = on
        if phoneCard.isOpen { phoneCard.place() }
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

    /// The toast's button (Undo, Show), for the self-test.
    var toastButton: RButton? { toastView.button }
    /// Every button of the toast (Undo and Show), for the self-test.
    var toastButtons: [RButton] { toastView.buttons }

    func toast(_ text: String, action: (String, () -> Void)? = nil) {
        toast(text, actions: action.map { [$0] } ?? [])
    }
    func toast(_ text: String, actions: [(String, () -> Void)]) {
        log.append("toast \(text)")
        toastView.show(text, actions: actions, in: root)
    }
}

/// A toast at the bottom of the window (.toast): 5 s, 12 s with an action.
final class ToastView: Box {
    private var timer: Timer?
    private(set) var text = ""
    private(set) var buttons: [RButton] = []
    var button: RButton? { buttons.first }
    init() { super.init(fill: "card2", radius: 9) }
    required init?(coder: NSCoder) { fatalError() }
    func show(_ s: String, actions: [(String, () -> Void)], in root: NSView) {
        subviews.forEach { $0.removeFromSuperview() }
        text = s
        let l = label(s, Fonts.pt(12.5), "tx", lines: 2)
        l.preferredMaxLayoutWidth = 520
        var items: [NSView] = [l]
        buttons = actions.map { name, run in RButton(name, .link) { [weak self] in self?.hide(); run() } }
        items += buttons as [NSView]
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
        timer = Timer.scheduledTimer(withTimeInterval: actions.isEmpty ? 5 : 12, repeats: false) { [weak self] _ in self?.hide() }
    }
    func hide() { isHidden = true; text = "" }
    func place(in root: NSView) {
        guard superview === root, !isHidden else { return }
        root.addSubview(self, positioned: .above, relativeTo: nil)
        frame.origin = NSPoint(x: (root.bounds.width - frame.width) / 2, y: root.bounds.height - frame.height - 20)
    }
}
