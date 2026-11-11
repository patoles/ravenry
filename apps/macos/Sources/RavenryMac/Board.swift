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
    /// A pane Move here or Continue started that this window had no tab for yet (showStarted).
    private var awaitTab: (pane: String, from: Front, until: Date, olds: [String])?
    /// Panes it uses' Hand it over buttons by pane, for the self-test.
    var usesButtons: [String: RButton] = [:]
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
    /// The grants on each pane (pane.grants) and when they were asked (Lent.swift).
    var grants: [String: [[String: Any]]] = [:]
    var grantsAsked: [String: Date] = [:]
    /// What the person did about a lease or a grant, for the self-test.
    var leaseActs: [String] = []
    /// A worktree session's review in the middle beside the panel ("review:<session key>"),
    /// the grid of who changed what ("files:<project>"), and what the panel shows of both.
    let review = ReviewView()
    let filesGrid = FilesGridPage()
    lazy var worktrees = WorktreeCards(hub: hub)
    /// A pick side by side, in the middle beside the panel (key "pick:<checkpoint id>").
    let picker = PickerView()
    /// Sessions: memory, Close the idle ones, Reopen (SessionsPage.swift).
    let sessionsPage = SessionsPage()
    /// New project: its folder, its brief and a first session (NewProjectPage.swift).
    let newProject = NewProjectPage()
    let notifier: Notifier
    /// The project of the session the person last had open (a page's Ask Claude to fix).
    private(set) var lastProject: String?
    /// Every view the middle shows instead of a tab's terminal.
    private var middles: [NSView] { [outside, projectPage, placeholder, start, brief, gallery, plan, idea, alerts, files, decisions, learn, machines, picker, review, filesGrid, sessionsPage, newProject] }
    /// Something the middle showed, and how to show it again as it was.
    private struct Step {
        let front: Front
        var again: () -> Void
    }
    /// Where Close, Esc and a page's "‹ Plans" link go back to, the last on
    /// top (the Electron app's backFrom, more than one level deep). Empty:
    /// the terminal. Coming to the terminal empties it.
    private var backStack: [Step] = []
    /// What the middle shows now (nil: a tab's terminal).
    private var here: Step?
    /// Going back or up: the step shown again is not pushed.
    private var goingBack = false
    private let toastView = ToastView()
    /// The window is closed: the board does nothing more.
    private(set) var closed = false
    private var monitors: [Any] = []
    /// One Settings window and one notifier for every window of the app.
    private static var sharedSettings: SettingsWindow?
    private static var sharedNotifier: Notifier?
    /// The board of the window the person used last (a notification's click opens there).
    static weak var lastFront: Board?
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
        let firstBoard = Board.sharedNotifier == nil
        let nt = Board.sharedNotifier ?? Notifier(standIn: !keep)
        Board.sharedNotifier = nt
        notifier = nt
        super.init()
        Board.lastFront = self
        let d = UserDefaults.standard
        if keep {
            if let w = d.object(forKey: "sidebarWidth") as? Double { sideWidth = min(SidebarView.maxWidth, max(SidebarView.minWidth, CGFloat(w))) }
            sideHidden = d.bool(forKey: "sidebarHidden")
        }
        // Measuring the terminal (the bench, its self-test): the sidebar and the panel start folded.
        if !sidebarOn { sideHidden = true; panelClosed = true }
        pinned = ws.saved.pinned
        ws.pinned = pinned
        // The pinned sessions come back as tabs (their panes' once the board names them).
        sessionTabs = pinned
        root.sidebar = sidebar
        root.panel = panel
        root.panelModeFor = { [weak self] w in self?.panelMode(width: w) ?? .hidden }
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
        gallery.toast = toaster(gallery)
        for f in [plan, idea, alerts, files, decisions, learn, machines, sessionsPage, newProject] as [FormPage] {
            f.isHidden = true
            f.hub = hub
            f.toast = toaster(f)
            f.onClose = { [weak self] in self?.back() }
        }
        alerts.pairPhone = { [weak self] in self?.openPhone() }
        learn.tryIt = { [weak self] c in self?.tryIt(c) }
        machines.copy = { Outside.copy($0) }
        machines.onList = { [weak self] in self?.render() }
        ws.onLook = { [weak self] in self?.render() }
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
            openBrief: { [weak self] pid, at in self?.openBrief(pid); self?.brief.focus(at) },
            lastProject: { [weak self] in self?.lastProject },
            toast: { [weak self] s, a in
                guard let self else { return }
                // Said by the page after the person left it: kept for it.
                if a == nil, self.root.middle !== self.files { self.keep(s, for: self.files); return }
                self.toast(s, action: a)
            })
        // Mac notifications the hub sends this app (Notifier.swift): posted, and macOS's answer sent back.
        hub.onNotify = { [weak self] j in
            guard let self, let q = Notifier.request(j) else { return }
            self.notifier.post(q) { r in
                self.log.append("notify \(q.title): \(r["ok"] as? Bool == true ? "shown" : "not shown")")
                self.hub.post("/api/alerts/desktop/result", r) { _, _ in }
            }
        }
        // One notifier for the app: its click opens in the window used last.
        if firstBoard {
            notifier.onOpen = { q in
                guard let b = Board.lastFront, let pid = q.projectId else { return }
                if let sf = q.surfaceId, b.hub.state?.find("\(pid)/\(sf)") != nil { b.pickSession("\(pid)/\(sf)", why: "notification") } else if b.hub.state?.project(pid) != nil { b.pickProject(pid) }
                b.ws.window.makeKeyAndOrderFront(nil)
            }
        }
        // In front: the hub sends the next Mac notification here, not to another app beside it.
        NotificationCenter.default.addObserver(forName: NSWindow.didBecomeKeyNotification, object: ws.window, queue: .main) { [weak self] _ in
            guard let self, !self.closed else { return }
            Board.lastFront = self
            self.reportFocus()
        }
        // The idea's "‹ Ideas": up to the Ideas page, as it was when it was opened from there.
        idea.openIdeas = { [weak self] in
            guard let self else { return }
            if let p = self.hub.state?.pages.first(where: { $0.icon == "idea" }) { self.up(toPage: p.key, p.label) } else { self.back() }
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
        // The switch from the npm board: the centre, the quiet bar (NpmSwitch.swift).
        followNpm()
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
        let prevNew = ws.bar.onNew
        // The strip's +: a new shell, in front even when a view was (the view's tab is the strip's last).
        ws.bar.onNew = { [weak self] in
            guard let self else { return }
            self.tabCommand("new shell (+)") { _ in prevNew?() }
        }
        ws.bar.onClose = { [weak self] id in
            guard let self else { return }
            if id.hasPrefix("view:") { self.closeViewTab(id); return }
            prevClose?(id)
        }
        ws.bar.onSelect = { [weak self] id in
            guard let self else { return }
            if id.hasPrefix("view:") { self.selectViewTab(id); return }
            self.front = .tab
            self.hideMiddle()
            if let t = self.ws.tabs.first(where: { $0.id == id }) { self.ws.showAgain(t) } else { prevSelect?(id) }
            self.render()
        }
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.render() }
        watchKeysAndPresses()
        hub.start()
        render()
    }

    /// The window closed: its timers, its hub stream and its key watch stop.
    func close() {
        guard !closed else { return }
        closed = true
        timer?.invalidate(); decTimer?.invalidate()
        for m in monitors { NSEvent.removeMonitor(m) }
        monitors = []
        toastView.clear()
        if phoneCard.isOpen { phoneCard.close() }
        outside.stop()
        hub.stop()
        if Board.lastFront === self { Board.lastFront = nil }
    }

    private var showingMiddle = false

    private func wire() {
        // The sidebar is the top level: what it opens sits over the terminal,
        // its Close back to the terminal; a page opened from a page goes back to it.
        sidebar.onSession = { [weak self] k in self?.topLevel { $0.pickSession(k, why: "click") } }
        sidebar.onProject = { [weak self] id in self?.topLevel { $0.pickProject(id) } }
        sidebar.onPin = { [weak self] k in self?.togglePin(k) }
        sidebar.onNew = { [weak self] in self?.topLevel { $0.openStart(nil) } }
        sidebar.onNav = { [weak self] key, name in self?.topLevel { $0.openPage(key, name) } }
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
                self.markUsed("needs")
                // Answered on a narrow window: back to the terminal.
                if self.overlay { self.overlay = false }
                self.render(force: true)
            })
        panel.host?.paneName = { [weak self] id in self.flatMap { $0.ws.paneInfo(id) != nil ? $0.ws.label(id).name : nil } }
        panel.host?.openPicker = { [weak self] id in self?.openPicker(id) }
        panel.host?.whoCanType = { [weak self] pane in self?.whoCanType(pane) ?? [] }
        panel.host?.revoke = { [weak self] pane, g in self?.revokeGrant(pane, g) }
        panel.host?.opened = { [weak self] pane in self?.openedLine(pane) }
        panel.host?.report = { [weak self] pane in self?.ws.paneInfo(pane)?.report }
        panel.host?.ownerOf = { [weak self] pane in
            guard let self, let c = self.ws.paneInfo(pane)?.creator, c["kind"] as? String == "agent" else { return nil }
            return self.sourceOf(c).who
        }
        ws.onLease = { [weak self] _ in self?.render(force: true) }
        ws.whoOf = { [weak self] src in self?.sourceOf(src).who }
        worktrees.rerender = { [weak self] in
            guard let self else { return }
            self.render(force: true)
            if case .page(let k, let n) = self.front, k.hasPrefix("files:") { self.filesGrid.redraw(name: n) }
        }
        worktrees.toast = { [weak self] s in self?.toast(s) }
        worktrees.openReview = { [weak self] k in self?.openReview(k) }
        worktrees.openGrid = { [weak self] pid in self?.openFilesGrid(pid) }
        panel.host?.extras = { [weak self] p, s, card, sec in
            guard let self else { return [] }
            var out = self.worktrees.views(p, s, card: card, sec: sec)
            // The panes its agent uses, when it runs in this window's daemon.
            if let pane = s.pane, self.ws.paneInfo(pane) != nil, let v = self.panesItUsesSection(pane, sec: sec) { out.append(v) }
            return out
        }
        review.hub = hub
        review.cards = worktrees
        review.toast = toaster(review)
        review.back = { [weak self] in self?.back() }
        filesGrid.hub = hub
        filesGrid.cards = worktrees
        filesGrid.onClose = { [weak self] in self?.back() }
        // A tab's dot: its session's state (amber while it waits on you, a checkpoint open in its pane too); its lease's holder.
        ws.marksOf = { [weak self] pane in
            guard let self else { return (nil, nil) }
            // What the agent in it reported (agent.report), then its session on the board, then a question open in it.
            let rs = self.ws.paneInfo(pane)?.agentState
            var group: String? = rs == "needs_you" ? "you" : rs == "working" ? "work" : nil
            if let st = self.hub.state {
                for p in st.projects where p.machine == nil { for s in p.sessions where s.pane == pane && s.machine == nil { group = s.group } }
            }
            // A question open in it, from the board or this window's daemons (the board down too).
            if self.hub.checkpoint(pane: pane) != nil { group = "you" }
            let l = self.leaseOf(pane).map { self.sourceOf($0["holder"] as? [String: Any]) }
            return (group, l)
        }
        picker.hub = hub
        picker.onClose = { [weak self] in self?.back() }
        picker.answer = { [weak self] id, reply, done in
            self?.markUsed("needs")
            // Through the daemon that holds it, else the hub (HubClient.answerCheckpoint).
            self?.hub.answerCheckpoint(id, reply) { ok, error in
                done(ok, error)
                self?.render(force: true)
            }
        }
        picker.whereOf = { [weak self] cp in
            guard let st = self?.hub.state, let p = st.project(cp["projectId"] as? String ?? ""), let s = p.sessions.first(where: { $0.surfaceId == cp["surfaceId"] as? String }) else { return nil }
            return [s.topic, p.name].compactMap { $0 }.joined(separator: ", ")
        }
        panel.onMove = { [weak self] p, s, keep in self?.move(p, s, keep: keep) }
        panel.onMoveNewer = { [weak self] p, s in self?.move(p, s, keep: "ravenry", now: true) }
        panel.host?.olderDaemon = { [weak self] pane in
            guard let self, self.ws.paneInfo(pane) != nil, let d = self.ws.daemon(of: pane), !d.draining.isEmpty else { return nil }
            return d.version
        }
        panel.host?.moving = { [weak self] sid in self?.outside.moving.contains(sid) ?? false }
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
        start.onShell = { [weak self] folder in
            guard let self else { return }
            self.front = .tab; self.hideMiddle()
            self.ws.newTab(in: folder)
            self.render()
        }
        // The board down: Start runs the assistant in a pane of this window, in front.
        start.onRun = { [weak self] folder, program in
            guard let self else { return }
            self.front = .tab; self.hideMiddle()
            self.ws.newTab(in: folder, program: program)
            self.render()
        }
        start.onCancel = { [weak self] in
            guard let self else { return }
            self.front = .tab; self.hideMiddle(); self.render()
        }
        start.grid = { [weak self] in
            guard let v = self?.ws.focusedView else { return (100, 30) }
            return (v.screen.cols, v.screen.rows)
        }
        gallery.onClose = { [weak self] in self?.back() }
        // Group A's sidebar, panel and page hooks, once the panel's host is set.
        wireSessions()
        // The panel's checkpoints from the daemons, New project (NewProjectPage.swift).
        wirePanel()
    }

    // MARK: what is in front

    /// The session in front's key, a project's ("project:<id>"), a shell
    /// tab's ("tab:<id>"), else nil: the sidebar's highlight and the panel follow it.
    var frontKey: String? {
        switch front {
        case .session(let k): return k
        case .project(let id): return "project:\(id)"
        case .brief(_, let k): return k
        case .page(let k, _) where k.hasPrefix("review:"): return String(k.dropFirst(7))
        case .page(let k, _) where k.hasPrefix("pick:"):
            // A pick side by side: the panel stays on the session that asked.
            guard let st = hub.state, let cp = st.checkpoints.first(where: { $0["id"] as? String == String(k.dropFirst(5)) }),
                  let p = st.project(cp["projectId"] as? String ?? ""), let s = p.sessions.first(where: { $0.surfaceId == cp["surfaceId"] as? String }) else { return nil }
            return "\(p.id)/\(s.surfaceId)"
        case .tab:
            guard let t = ws.active else { return nil }
            let pane = t.focusedPane
            if let st = hub.state { for p in st.projects { for s in p.sessions where s.pane == pane { return "\(p.id)/\(s.surfaceId)" } } }
            return "tab:\(t.id)"
        default: return nil
        }
    }

    private func onState(_ st: HubState) {
        SessionLinks.shared.stateArrived(st, hub: hub, board: self)
        if !pinsPlaced {
            pinsPlaced = true
            for k in pinned where st.find(k) != nil { pinTab(k) }
        }
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
            var unheld: [String: Any]?
            for id in newCps {
                if let cp = st.checkpoints.first(where: { $0["id"] as? String == id }),
                   let k = st.projects.lazy.compactMap({ p in p.sessions.first(where: { st.checkpoint(of: p, $0)?["id"] as? String == id }).map { "\(p.id)/\($0.surfaceId)" } }).first {
                    _ = cp
                    arrived.append(k)
                } else if let cp = st.checkpoints.first(where: { $0["id"] as? String == id }) { unheld = cp }
            }
            arrived += newYou.sorted()
            if let k = arrived.last { arrive(k, st) }
            // One no session holds: its shell tab, else on its own (cpArrived).
            if let c = unheld { cpArrived(c) }
        }
        render()
    }

    /// A checkpoint no session holds (app.ts arrive, targetOf): the shell
    /// tab of its pane (in front, the panel shows it; else a toast with
    /// Show), else its card on its own over what is in front.
    func cpArrived(_ cp: [String: Any]) {
        guard let id = cp["id"] as? String else { return }
        if let pane = cp["pane"] as? String, cp["machine"] as? String == nil, let tb = ws.tab(showing: pane) {
            if case .tab = front, ws.active === tb {
                if !wide { overlay = true }
                log.append("arrived tab:\(tb.id): the panel opens")
                return
            }
            let w = cp["words"] as? [String: Any] ?? [:]
            let what = InlineMd.plain(((w["head"] as? String) ?? (cp["title"] as? String) ?? "").replacingOccurrences(of: "\n", with: " "))
            let said = what.isEmpty ? "." : ": " + (what.count > 70 ? String(what.prefix(69)) + "..." : what)
            log.append("arrived tab:\(tb.id): a toast")
            toast("\(ws.label(pane).name) needs you\(said)", actions: [("Show", { [weak self] in self?.showPane(pane) })], key: "needs:tab:\(tb.id)")
            return
        }
        log.append("checkpoint \(id): no session or tab holds it, its card on its own")
        showCheckpoint(id)
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
        let what = InlineMd.plain(((w["question"] as? String) ?? (w["headline"] as? String) ?? (w["line"] as? String) ?? "").replacingOccurrences(of: "\n", with: " "))
        let said = what.isEmpty ? "." : ": " + (what.count > 70 ? String(what.prefix(69)) + "..." : what)
        let proj = title != f.project.name ? " in \(f.project.name)" : ""
        log.append("arrived \(key): a toast")
        toast("\(title)\(proj) needs you\(said)", actions: [("Show", { [weak self] in self?.pickSession(key, why: "notification") })], key: "needs:\(key)")
    }

    var wide: Bool { root.bounds.width >= Board.foldWidth }

    var panelVisible: Bool { panelVisible(wide: wide, overlay: overlay) }

    private func panelVisible(wide: Bool, overlay: Bool) -> Bool {
        switch front {
        // A review sits beside its session's panel, as a tab does.
        case .page(let k, _) where k.hasPrefix("review:"): break
        case .start, .page: return overlay
        default: break
        }
        if overlay { return true }
        return wide && !panelClosed
    }

    /// The panel at a width of the window (a wide one docks it again):
    /// the root asks at each layout (RootView.place), so a window dragged
    /// across the fold width lays the middle out once a step.
    func panelMode(width: CGFloat) -> RootView.PanelMode {
        let wide = width >= Board.foldWidth
        // A loose checkpoint's card (a page's run button) lies over the page even on a wide window.
        let ov = overlay && (!wide || panel.loose != nil)
        return panelVisible(wide: wide, overlay: ov) ? (ov || !wide ? .overlay : .docked) : .hidden
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
        let t0 = CACurrentMediaTime()
        defer { if ws.options.bench != nil { resizeMs.append((CACurrentMediaTime() - t0) * 1000) } }
        if wide && overlay { overlay = false }
        // While the person drags the window's edge only the layout follows
        // each step (RootView.place, the panel's mode with it) and the
        // toast keeps its place; the rest of the board when the panel
        // comes or goes, and once the drag ends (resizeEnded).
        if ws.window.liveResizing && root.panelMode == renderedPanelMode {
            renderAfterResize = true
            toastView.place(in: root)
            if phoneCard.isOpen { phoneCard.place() }
            return
        }
        render()
    }

    /// The person let go of the window's edge.
    func resizeEnded() {
        if renderAfterResize { renderAfterResize = false; render() }
    }
    private var renderAfterResize = false
    private var renderedPanelMode: RootView.PanelMode?
    /// What each resize cost on the main thread (the bench reads it).
    var resizeMs: [Double] = []

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
            enter(.session(key)) { [weak self] in self?.pickSession(key, why: "back") }
            front = .session(key)
            frontSid = f.session.sessionId
            outsideEnded = nil
            if !sessionTabs.contains(key) { sessionTabs.append(key) }
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
        enter(.project(id)) { [weak self] in self?.pickProject(id) }
        front = .project(id)
        showMiddle(projectPage)
        projectPage.show(p)
        log.append("project \(id): its page")
        render()
    }

    func openStart(_ folder: String?) {
        overlay = false
        enter(.start) { [weak self] in self?.openStart(folder) }
        front = .start
        showMiddle(start)
        start.show(folder: folder)
        log.append("start")
        render()
    }

    func openPage(_ key: String, _ name: String) {
        // While the npm board keeps the data, what needs the app's hub points there (NpmSwitch.swift).
        if npmPoints(key) { return }
        if key.hasPrefix("brief:") { openBrief(String(key.dropFirst(6))); return }
        if key.hasPrefix("gallery:") { openGallery(String(key.dropFirst(8)), at: nil); return }
        if key.hasPrefix("plan:") { openPlan(String(key.dropFirst(5)), title: nil); return }
        if key.hasPrefix("newplan:") { openNewPlan(String(key.dropFirst(8))); return }
        if key.hasPrefix("idea:") { openIdea(String(key.dropFirst(5))); return }
        if key.hasPrefix("pick:") { openPicker(String(key.dropFirst(5))); return }
        if key.hasPrefix("review:") { openReview(String(key.dropFirst(7))); return }
        if key.hasPrefix("files:") { openFilesGrid(String(key.dropFirst(6))); return }
        if key == "side.alerts" { openAlerts(); return }
        if key == "decisions" { openDecisions(); return }
        if key == "side.learn" { openLearn(); return }
        if key == "side.machines" { openMachines(); return }
        if key == "side.phone" { if phoneCard.isOpen { phoneCard.close() } else { openPhone() }; return }
        // The foot's Settings, and the panel's way to Settings when the first-launch step was off (its Skills).
        if key == "sessions" { openSessions(); return }
        if key == "newproject" { openNewProject(nil); return }
        if key.hasPrefix("settings:") { openSettings(String(key.dropFirst(9))); return }
        if key == "side.settings" || key == "settings" { openSettings(key == "settings" ? "skills" : nil); return }
        if hub.state?.pages.contains(where: { $0.key == key }) == true { openFilePage(key, name); return }
        overlay = false
        enter(.page(key, name)) { [weak self] in self?.openPage(key, name) }
        front = .page(key, name)
        showMiddle(placeholder)
        placeholder.show(name)
        log.append("page \(key)")
        render()
    }

    /// A page from a page file, as the hub draws it.
    func openFilePage(_ key: String, _ name: String) {
        overlay = false
        enter(.page(key, name)) { [weak self] in self?.openFilePage(key, name) }
        front = .page(key, name)
        showMiddle(files)
        files.show(key)
        log.append("page \(key): drawn")
        render()
    }

    /// The brief as a page, beside what was in front: the panel stays on it.
    func openBrief(_ pid: String, from: String? = nil) {
        overlay = false
        var k = frontKey ?? "project:\(pid)"
        if case .brief(_, let was) = front { k = was }
        if k.hasPrefix("tab:") { k = "project:\(pid)" }
        if let from { k = from }
        // A brief over a brief takes its place: its Close goes where the first came from.
        let was = goingBack
        if case .brief = front { goingBack = true }
        enter(.brief(pid, k)) { [weak self] in self?.openBrief(pid, from: k) }
        goingBack = was
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
        enter(.page("gallery:\(pid)", t("gallery.title"))) { [weak self] in self?.openGallery(pid, at: at) }
        front = .page("gallery:\(pid)", t("gallery.title"))
        showMiddle(gallery)
        gallery.show(pid, at: at, state: hub.state)
        log.append("gallery \(pid) \(at.map { "\($0)" } ?? "grid")")
        render()
    }

    /// A project's plan: the one with this title, else the one its page shows first.
    func openPlan(_ pid: String, title: String?) {
        overlay = false
        enter(.page("plan:\(pid)", t("panel.plan"))) { [weak self] in self?.openPlan(pid, title: title) }
        front = .page("plan:\(pid)", t("panel.plan"))
        showMiddle(plan)
        plan.show(pid, mode: .plan, title: title, state: hub.state)
        log.append("plan \(pid) \(title ?? "-")")
        render()
    }

    /// A new plan drafted from a project's brief.
    func openNewPlan(_ pid: String) {
        overlay = false
        enter(.page("newplan:\(pid)", t("panel.newPlan"))) { [weak self] in self?.openNewPlan(pid) }
        front = .page("newplan:\(pid)", t("panel.newPlan"))
        showMiddle(plan)
        plan.show(pid, mode: .new, state: hub.state)
        log.append("newplan \(pid)")
        render()
    }

    /// New project, from nothing or from a folder (a shell's, a session's that is in no project).
    func openNewProject(_ from: NewProjectPage.From?) {
        overlay = false
        enter(.page("newproject", t("np.title"))) { [weak self] in self?.openNewProject(from) }
        front = .page("newproject", t("np.title"))
        showMiddle(newProject)
        newProject.show(from: from, state: hub.state)
        log.append("new project\(from.map { " from \($0.folderShort)" } ?? "")")
        render()
    }

    /// Alerts: Mac notifications, the phone and one other way.
    func openAlerts() {
        overlay = false
        enter(.page("side.alerts", t("alerts.title"))) { [weak self] in self?.openAlerts() }
        front = .page("side.alerts", t("alerts.title"))
        showMiddle(alerts)
        alerts.show()
        log.append("alerts")
        render()
    }

    /// The Settings window (SettingsWindow.swift), on the shared settings file (offscreen: in memory, or RAVENRY_DESKTOP_DATA's).
    /// One Settings window for every window of the app.
    var settings: SettingsWindow {
        if let s = Board.sharedSettings { return s }
        let s = SettingsWindow(store: ws.settings, hub: hub, offscreen: !keep)
        Board.sharedSettings = s
        return s
    }
    func openSettings(_ tab: String? = nil) {
        settings.show(tab)
        log.append("settings \(settings.tab)")
    }
    @objc func menuSettings(_ sender: Any?) { openSettings() }

    /// Learn Ravenry; `lit`: the card a hint's Learn more points at.
    func openLearn(lit: String? = nil) {
        overlay = false
        enter(.page("side.learn", t("learn.title"))) { [weak self] in self?.openLearn() }
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
        enter(.page("side.machines", t("mach.title"))) { [weak self] in self?.openMachines() }
        front = .page("side.machines", t("mach.title"))
        showMiddle(machines)
        machines.show()
        log.append("machines")
        render()
    }

    /// A checkpoint's card over what is in front (a page's run button: FilePage.Host.showCheckpoint, Electron's showCheckpoint).
    func showCheckpoint(_ id: String) {
        panel.loose = id
        overlay = true
        log.append("checkpoint \(id): its card over the page")
        render(force: true)
    }

    /// Sessions: the memory the sessions hold, Close the idle ones, Reopen a closed one.
    func openSessions() {
        overlay = false
        enter(.page("sessions", t("sess.title"))) { [weak self] in self?.openSessions() }
        front = .page("sessions", t("sess.title"))
        showMiddle(sessionsPage)
        sessionsPage.show()
        log.append("sessions")
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
            // The terminal that printed last, its filmstrip open (Filmstrip.swift).
            guard let tb = ws.tabs.max(by: { (ws.paneInfo($0.host)?.lastOutput ?? "") < (ws.paneInfo($1.host)?.lastOutput ?? "") }) else { toast(t("learn.filmNeeds")); return }
            front = .tab; hideMiddle(); ws.showAgain(tb)
            markUsed("film")
            ws.openFilm(tb.focusedPane)
            render()
            return
        }
        guard hub.reachable else { toast(t("learn.noBoard")); return }
        hub.get("/api/setup/start") { [weak self] code, j in
            guard let self else { return }
            // The assistant new sessions start with and the last folder used (LearnPage.tryChoice).
            guard let ch = LearnPage.tryChoice(start: j, state: self.hub.state, lastProject: self.lastProject) else { self.toast(t("learn.noAssistant")); return }
            let kind = ch.kind, folder = ch.folder
            let lp = self.lastProject.flatMap { self.hub.state?.project($0) }
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
        enter(.page("decisions", t("side.decisions"))) { [weak self] in self?.openDecisions() }
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
        // A newer one replaces it; with Undo it stays the undo's minute.
        toast(text, actions: acts, key: "decision", seconds: acts.count > 1 ? 60 : nil)
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
        enter(.page("idea:\(id)", t("idea.ideas"))) { [weak self] in self?.openIdea(id) }
        front = .page("idea:\(id)", t("idea.ideas"))
        showMiddle(idea)
        idea.show(id)
        log.append("idea \(id)")
        render()
    }

    /// A worktree session's review in the middle, the panel beside it on the session.
    func openReview(_ key: String) {
        guard let f = hub.state?.find(key) else { return }
        markUsed("review")
        overlay = false
        enter(.page("review:\(key)", t("review.tab"))) { [weak self] in self?.openReview(key) }
        front = .page("review:\(key)", t("review.tab"))
        showMiddle(review)
        review.show(key, f.project, f.session)
        log.append("review \(key)")
        render()
    }

    /// Who changed what in a project, as a page.
    func openFilesGrid(_ pid: String) {
        guard let p = hub.state?.project(pid) else { return }
        overlay = false
        enter(.page("files:\(pid)", p.name)) { [weak self] in self?.openFilesGrid(pid) }
        front = .page("files:\(pid)", p.name)
        showMiddle(filesGrid)
        filesGrid.show(pid, name: p.name)
        log.append("files \(pid)")
        render()
    }

    /// A pick side by side in the middle, the panel beside it on its card.
    func openPicker(_ id: String) {
        guard let cp = hub.state?.checkpoints.first(where: { $0["id"] as? String == id }) else { return }
        markUsed("pick")
        overlay = false
        enter(.page("pick:\(id)", t("pick.tab"))) { [weak self] in self?.openPicker(id) }
        front = .page("pick:\(id)", t("pick.tab"))
        showMiddle(picker)
        picker.show(cp)
        ws.window.makeFirstResponder(picker)
        log.append("pick \(id)")
        render()
    }

    // MARK: going back (every page keeps where it was opened from)

    /// Something comes to the middle: what was there goes on the back
    /// stack, unless this is a step back, the same view again, or a view
    /// already deeper in the stack (Plans from the sidebar while on a plan
    /// opened from Plans), which goes back to that level instead of looping.
    private func enter(_ f: Front, _ again: @escaping () -> Void) {
        defer { here = Step(front: f, again: again) }
        if goingBack { return }
        if let i = backStack.lastIndex(where: { $0.front == f }) { backStack.removeSubrange(i...); return }
        guard var h = here, h.front != f else { return }
        // The gallery comes back on the picture it showed when it was left.
        if case .page(let k, _) = h.front, k.hasPrefix("gallery:") {
            let pid = String(k.dropFirst(8)), at = gallery.at
            h.again = { [weak self] in self?.openGallery(pid, at: at) }
        }
        backStack.append(h)
        if backStack.count > 40 { backStack.removeFirst() }
    }

    /// Opened from the sidebar: a fresh stack over the terminal.
    func topLevel(_ run: (Board) -> Void) {
        backStack.removeAll()
        here = nil
        run(self)
    }

    /// A step that can still be shown (its session, project or question is still on the board).
    private func stillThere(_ f: Front) -> Bool {
        let st = hub.state
        switch f {
        case .session(let k): return st?.find(k) != nil
        case .project(let id): return st?.project(id) != nil
        case .brief(let pid, _): return st?.project(pid) != nil
        case .page(let k, _) where k.hasPrefix("review:"): return st?.find(String(k.dropFirst(7))) != nil
        case .page(let k, _) where k.hasPrefix("pick:"): return st?.checkpoints.contains { $0["id"] as? String == String(k.dropFirst(5)) } ?? false
        case .page(let k, _) where k.hasPrefix("files:"): return st?.project(String(k.dropFirst(6))) != nil
        default: return true
        }
    }

    /// A step's name, as a page's back link says it ("‹ Plans").
    private func name(of f: Front) -> String? {
        switch f {
        case .page(_, let n): return n
        case .session(let k): return hub.state?.find(k).map { $0.session.topic ?? $0.project.name }
        case .project(let id): return hub.state?.project(id)?.name
        case .brief: return t("brief.title")
        case .start: return t("start.title")
        case .tab: return nil
        }
    }

    /// Where Close and Esc go from what is in front, named; nil: the terminal.
    var backName: String? { backStack.last { stillThere($0.front) }.flatMap { name(of: $0.front) } }
    /// What the back stack holds, oldest first, for the self-test.
    var backTrail: [Front] { backStack.map(\.front) }

    /// Back one step: what was in front before (a page, a session's view,
    /// a project, the brief, Start), else the terminal. A page's Close,
    /// Esc, Cmd+W and the x on the view's tab all come here.
    func back() {
        while let s = backStack.popLast() {
            guard stillThere(s.front) else { continue }
            log.append("back to \(s.front)")
            goingBack = true
            s.again()
            goingBack = false
            return
        }
        log.append("back to the terminal")
        front = .tab
        hideMiddle()
        if let t = ws.active { ws.showAgain(t) }
        render()
    }

    /// Up to a page (the idea's "‹ Ideas"): back to it when it is in the
    /// stack, else it opens in the place of the view in front, so its Close
    /// goes where that view came from.
    func up(toPage key: String, _ name: String) {
        if let i = backStack.lastIndex(where: { if case .page(key, _) = $0.front { return true }; return false }) {
            let s = backStack[i]
            backStack.removeSubrange(i...)
            goingBack = true; s.again(); goingBack = false
        } else {
            goingBack = true; openPage(key, name); goingBack = false
        }
        log.append("up to \(key)")
    }

    private func showMiddle(_ v: NSView) {
        for m in middles where m !== v { m.isHidden = true }
        if v !== outside { outside.stop() }
        v.isHidden = false
        root.middle = v
        root.wideMiddle = v is InAppPage || v === picker
        showingMiddle = true
        // The page's head links back to where it was opened from ("‹ Plans"; InAppPage.backLink).
        (v as? InAppPage)?.backLink = backName.map { n in (n, { [weak self] in self?.back() }) }
        // The keyboard leaves the terminal the view covers: keys never act on a tab no one sees.
        if let r = ws.window.firstResponder as? NSView, r === ws.root || r.isDescendant(of: ws.stage) {
            ws.window.makeFirstResponder(v.acceptsFirstResponder ? v : nil)
        }
        root.place()
        showKept(for: v)
    }

    /// A tab's terminal in front: the back stack starts again from it.
    private func hideMiddle() {
        outside.stop()
        for m in middles { m.isHidden = true }
        root.middle = nil
        root.wideMiddle = false
        showingMiddle = false
        backStack.removeAll()
        here = nil
        if let t = ws.active, let v = ws.boxes[t.focusedPane]?.term { ws.window.makeFirstResponder(v) }
    }

    // MARK: Esc, a press outside the phone card

    private func watchKeysAndPresses() {
        if let m = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { [weak self] e in
            guard let self, !self.closed, e.window === self.ws.window, e.keyCode == 53,
                  e.modifierFlags.intersection([.command, .option, .control, .shift]).isEmpty else { return e }
            return self.escape() ? nil : e
        }) { monitors.append(m) }
        if let m = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { [weak self] e in
            guard let self, !self.closed, self.phoneCard.isOpen, e.window === self.ws.window else { return e }
            // A press outside the phone card closes it (its mark in the foot toggles it itself).
            if !self.phoneCard.bounds.contains(self.phoneCard.convert(e.locationInWindow, from: nil)) && !self.onPhoneMark(e.locationInWindow) {
                self.log.append("phone card: a press outside closes it")
                self.phoneCard.close()
            }
            return e
        }) { monitors.append(m) }
    }

    private func onPhoneMark(_ p: NSPoint) -> Bool {
        guard let m = sidebar.footButtons["side.phone"] else { return false }
        return m.bounds.contains(m.convert(p, from: nil))
    }

    /// A press in the window at a point (the self-test's), through the outside-press watch.
    func pressOutsideCheck(at p: NSPoint) {
        guard phoneCard.isOpen, !phoneCard.bounds.contains(phoneCard.convert(p, from: nil)), !onPhoneMark(p) else { return }
        log.append("phone card: a press outside closes it")
        phoneCard.close()
    }

    /// Esc in the window: the phone card, a page's sheet, a channel's
    /// setup, a zoomed picture, the panel over the terminal, else what is
    /// in front goes back one step. A field being typed in keeps its Esc,
    /// and on a terminal Esc is the program's.
    @discardableResult
    func escape() -> Bool {
        let w = ws.window
        if w.attachedSheet != nil { return false }
        if let tv = w.firstResponder as? NSTextView, tv.isEditable { return false }
        if phoneCard.isOpen { phoneCard.cancelOperation(nil); log.append("esc: phone card"); render(); return true }
        if case .page(let k, _) = front {
            if k == files.key, files.sheetView != nil { files.closeSheet(); log.append("esc: page sheet"); return true }
            if k == "side.alerts", alerts.open != nil { alerts.cancelOperation(nil); log.append("esc: channel setup"); return true }
            // A zoomed picture fitted, then the grid (Gallery.escape), then back.
            if k.hasPrefix("gallery:"), gallery.escape() { log.append("esc: gallery"); return true }
        }
        if overlay {
            overlay = false
            log.append("esc: panel")
            render(force: true)
            if case .tab = front, let v = ws.focusedView { w.makeFirstResponder(v) }
            return true
        }
        guard showingMiddle else { return false }
        log.append("esc: back")
        back()
        return true
    }

    // MARK: the keyboard's tab commands

    /// A tab command (New Shell, Tab 1 to 9, Split): with a page, a
    /// session's view, a project or Start in front, the terminal comes to
    /// the front first, so the command is seen (the Electron app's setView).
    func tabCommand(_ what: String, _ run: (Workspace) -> Void) {
        let was = showingMiddle
        if was { front = .tab; hideMiddle() }
        run(ws)
        if was, let t = ws.active { ws.showAgain(t) }
        log.append("command \(what)\(was ? ": the terminal in front" : "")")
        render()
    }

    /// Ctrl+Tab and back: from the view's tab (the strip's last), the first tab or the last.
    func stepTab(_ d: Int) {
        if showingMiddle { tabCommand(d > 0 ? "next tab" : "previous tab") { $0.select(index: d > 0 ? 0 : $0.tabs.count - 1) } } else { ws.step(d) }
    }

    /// Cmd+W: what is in front closes. A page, a session's view, a
    /// project or Start goes back where it was opened from; on a terminal,
    /// the pane with the keyboard (never a shell hidden behind a page).
    func closeCommand() {
        if showingMiddle { log.append("command close: back"); back(); return }
        ws.closeFocused()
    }

    /// ravenryd focus (pane.focus): the terminal comes to the front for the pane the daemon names.
    func toTerminal() {
        guard showingMiddle else { return }
        front = .tab
        hideMiddle()
    }


    /// Pin a session to the tabs (its row's pin, its panel's): its pane's
    /// tab when this window has its pane, else a tab of its own; kept with
    /// the tabs (window.json pinned) and back after a relaunch. Unpinned, a
    /// session's own tab goes unless it is in front.
    func togglePin(_ key: String) {
        if let i = pinned.firstIndex(of: key) {
            pinned.remove(at: i)
            if front != .session(key) { sessionTabs.removeAll { $0 == key } }
        } else {
            pinned.append(key)
            pinTab(key)
        }
        ws.pinned = pinned
        ws.save()
        log.append("pin \(key): \(pinned.contains(key) ? "on" : "off")")
        render(force: true)
    }

    /// A pinned session as a tab: its pane's when this window can show it, else its own.
    private func pinTab(_ key: String) {
        guard let st = hub.state, let f = st.find(key) else { if !sessionTabs.contains(key) { sessionTabs.append(key) }; return }
        if let pane = f.session.pane, f.session.machine == nil, f.project.machine == nil, ws.tab(showing: pane) != nil { ws.refresh(); return }
        if !sessionTabs.contains(key) { sessionTabs.append(key) }
    }

    // MARK: moves and Continue, as the person clicked them

    /// Move here (`keep` ravenry) or Keep it in (outside). `now`: the
    /// panel's Move here for a session on an older daemon, which goes at
    /// once even mid-turn (its line said it stops what it is doing).
    private func move(_ p: HubProject, _ s: HubSession, keep: String, now: Bool = false) {
        guard let sid = s.sessionId else { return }
        outside.moving.insert(sid)
        // Its pane here keeps its tab while it ends, until the new one takes its place.
        let old = keep == "ravenry" ? s.pane.flatMap { ws.paneInfo($0) != nil ? $0 : nil } : nil
        if let old { ws.hold(old) }
        render(force: true)
        let g = start.grid()
        var body: [String: Any] = ["projectId": p.id, "sessionId": sid, "keep": keep, "cols": g.cols, "rows": g.rows]
        if now { body["now"] = true }
        log.append("session move \(sid)\(now ? " (now)" : ""): from \(old.map { "\($0) on \(ws.daemon(of: $0)?.version ?? "?")" } ?? "elsewhere")")
        hub.post("/api/sessions/move", body) { [weak self] code, j in
            guard let self else { return }
            self.outside.moving.remove(sid)
            if code != 200 || !(j["ok"] as? Bool ?? false) { self.toast(t("move.notDone", ["why": j["error"] as? String ?? "the board answered \(code)"])) }
            else { self.showStarted(p, j, why: "move") }
            if let old { self.ws.release(old) }
            self.render(force: true)
        }
    }

    /// After Move here or Continue, the hub's answer: the new pane in the
    /// place of the old one it replaces (`replaced`: the same tab, at the
    /// same position), else in a tab of its own, in front at once when this
    /// window has it; else the session's view, and its tab as soon as it
    /// comes (render, within 10 s, unless the person opened something else
    /// meanwhile). The board's state names the new session a moment after
    /// the hub answers, so the session alone could not be found yet and its
    /// read-only view stayed.
    private func showStarted(_ p: HubProject, _ j: [String: Any], why: String) {
        let pane = (j["pane"] as? [String: Any])?["id"] as? String
        let olds = j["replaced"] as? [String] ?? []
        if let pane, let tb = placeTab(pane, olds) {
            awaitTab = nil
            front = .tab; hideMiddle(); ws.showAgain(tb); render()
            log.append("session \(why): its new pane \(pane) in front, tab \((ws.tabs.firstIndex { $0 === tb } ?? -1) + 1)\(olds.isEmpty ? "" : " (it replaces \(olds.joined(separator: ", ")))")")
            return
        }
        if let sf = j["surfaceId"] as? String, front != .tab || olds.isEmpty { pickSession("\(j["projectId"] as? String ?? p.id)/\(sf)", why: why) }
        if let pane, front != .tab || !olds.isEmpty { awaitTab = (pane, front, Date().addingTimeInterval(10), olds) }
    }

    /// The new pane's tab: in the place of an old pane's it replaces, else its own.
    private func placeTab(_ pane: String, _ olds: [String]) -> Tab? {
        for o in olds { if let tb = ws.replace(o, with: pane) { return tb } }
        return ws.tab(showing: pane)
    }

    private func continueLast(_ p: HubProject, _ l: [String: Any]) {
        guard let sid = l["sessionId"] as? String else { return }
        projectPage.busy = true; projectPage.error = nil; projectPage.draw(p)
        let g = start.grid()
        hub.post("/api/sessions/resume", ["projectId": p.id, "sessionId": sid, "cols": g.cols, "rows": g.rows]) { [weak self] code, j in
            guard let self else { return }
            self.projectPage.busy = false
            // Still open in another terminal: the last conversation asked again, so the page says where, with Move here (app.ts continueLast).
            if code != 200, j["open"] as? Bool == true { self.projectPage.error = nil; self.projectPage.reload(p); return }
            if code != 200 { self.projectPage.error = j["error"] as? String ?? "It could not be continued."; self.projectPage.draw(p); return }
            self.showStarted(p, j, why: "continue")
        }
    }

    /// A session link (SessionLinks.swift): a click on a session's name or
    /// id in terminal text, or ravenry://session/<name>, opens its tab at
    /// once. On the board, as its row does; ended, continued in a pane
    /// here, as the project page's Continue does.
    func openSessionLink(_ word: String, why: String) {
        guard let st = hub.state, let target = SessionLinks.shared.target(word) else { log.append("session link \(why): no session"); return }
        for p in st.projects {
            if let s = p.sessions.first(where: { $0.sessionId?.lowercased() == target.sessionId }) { return pickSession("\(p.id)/\(s.surfaceId)", why: "link \(why)") }
        }
        guard let pid = target.projectId, let p = st.project(pid) else { log.append("session link \(why): \(target.sessionId.prefix(8)) not on the board, no project"); return }
        log.append("session link \(why): continue \(target.sessionId.prefix(8)) in \(p.id)")
        let g = start.grid()
        hub.post("/api/sessions/resume", ["projectId": p.id, "sessionId": target.sessionId, "cols": g.cols, "rows": g.rows]) { [weak self] code, j in
            guard let self else { return }
            if code != 200 { self.toast(j["error"] as? String ?? t("link.notOpened")); return }
            self.showStarted(p, j, why: "continue")
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
            self.showStarted(p, j, why: "move")
        }
    }

    // MARK: what the panel reads besides the state

    private func inputsOf(_ pane: String) -> [[String: Any]]? {
        guard ws.paneInfo(pane) != nil || ws.tabs.contains(where: { $0.host == pane || $0.guest == pane }) else { return nil }
        if Date().timeIntervalSince(inputsAsked[pane] ?? .distantPast) > 3 {
            inputsAsked[pane] = Date()
            ws.conn(of: pane).request("pane.inputs", ["pane": pane, "limit": 50]) { [weak self] r in
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
        // A pane a move or Continue started, once this window has it.
        if let a = awaitTab {
            if front != a.from || Date() > a.until { awaitTab = nil }
            else if let tb = placeTab(a.pane, a.olds) {
                awaitTab = nil
                front = .tab; hideMiddle(); ws.showAgain(tb)
                log.append("session: its new pane \(a.pane) in front once it came")
            }
        }
        // A session in front that left the board: followed under its new key
        // (moved, continued: the same conversation), else its view and its tab
        // stay with their last words and say it ended.
        if case .session(let k) = front, let st, st.find(k) == nil {
            if let sid = frontSid, let p = st.projects.first(where: { $0.sessions.contains { $0.sessionId == sid } }),
               let s = p.sessions.first(where: { $0.sessionId == sid }) {
                log.append("session \(k): followed to \(p.id)/\(s.surfaceId)")
                pickSession("\(p.id)/\(s.surfaceId)", why: "followed")
                return
            }
            if outsideEnded != k {
                outsideEnded = k
                outside.stop()
                toast(t("else.ended"))
            }
        }
        if case .session(let k) = front, let f = st?.find(k) { outside.show(f.project, f.session, why: f.session.pane != nil ? "it runs in the board's ravenryd" : nil) }
        if case .project(let id) = front, let p = st?.project(id) { projectPage.show(p) }
        if case .project(let id) = front, st != nil, st?.project(id) == nil { projectPage.gone(id) }
        if case .page(let k, _) = front, k == "sessions" { sessionsPage.redraw() }
        if case .brief(let pid, _) = front { brief.show(pid, state: st) }
        if case .page(let k, _) = front, k.hasPrefix("gallery:") { gallery.refresh(st) }
        if case .page(let k, _) = front, k.hasPrefix("plan:") || k.hasPrefix("newplan:") { plan.refresh(st) }
        if case .page(let k, _) = front, k == files.key { files.refresh() }
        if case .page(let k, _) = front, k.hasPrefix("pick:") { picker.refresh(st) }
        if case .page(let k, _) = front, k.hasPrefix("review:"), let f = st?.find(String(k.dropFirst(7))) { review.show(String(k.dropFirst(7)), f.project, f.session) }
        root.sideWidth = sideHidden ? 0 : sideWidth
        root.panelMode = panelMode(width: root.bounds.width)
        renderedPanelMode = root.panelMode
        panel.isOverlay = root.panelMode == .overlay
        let bg = sideHidden ? Design.tbg : Design.color("win")
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
        sidebar.waitingFor = hub.waitingFor
        sidebar.newButton.on = front == .start
        sidebar.hasTabs = !ws.tabs.isEmpty
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
        ws.extraTabs = stripTabs(st)
        ws.refresh()
        let strip = leaseStrip()
        if strip?.text != root.strip?.text || (strip == nil) != (root.strip == nil) { root.strip = strip }
        root.place()
        toastsFollow()
        toastView.place(in: root)
        // Learn's "An agent's own pane" ticks once one is a tab here (app.ts addAgentPaneTab).
        if learn.used["panes"] != true, !panesTicked, ws.tabs.contains(where: { t in ws.panes(of: t).contains { ws.paneInfo($0)?.creator?["kind"] as? String == "agent" } }) {
            panesTicked = true
            markUsed("panes")
        }
    }
    private var panesTicked = false
    /// The pinned sessions were made tabs from the first state.
    private var pinsPlaced = false
    /// The conversation of the session whose view is in front (followed when its key changes).
    private var frontSid: String?
    /// The session in front whose end was said.
    private var outsideEnded: String?

    // MARK: the strip's tabs that are not a pane's

    /// Sessions kept as tabs that this window draws no pane of (a read-only
    /// session once opened, a pinned one), in the order they came: each
    /// stays until its x, as the Electron app's session tabs (2026-11-07,
    /// "if I select on other tab at the top the ravenry tab disappears").
    private(set) var sessionTabs: [String] = []
    /// Each one's last tab, kept while its session is gone from the board.
    private var sessionTabCache: [String: TabModel] = [:]

    /// The tab of this window that shows a session's pane, if any.
    private func ownTab(_ k: String, _ st: HubState?) -> Tab? {
        guard let f = st?.find(k), let pane = f.session.pane, f.session.machine == nil, f.project.machine == nil else { return nil }
        return ws.tabs.first { $0.host == pane || $0.guest == pane }
    }

    /// A session's tab: its name and project, its state's dot; ended when it left the board.
    private func sessionTab(_ k: String, _ st: HubState?) -> TabModel? {
        let on = front == .session(k)
        if let f = st?.find(k) {
            let name = f.session.topic ?? f.project.name
            let g = st?.sections.first { $0.projects.contains { $0.rows.contains { $0.key == k } } }?.group ?? f.session.group
            var m = TabModel(id: "view:\(k)", name: name, sub: name == f.project.name ? nil : f.project.name, split: false, active: on, tip: name, dot: g)
            m.closeTip = t("strip.closeSession")
            sessionTabCache[k] = m
            return m
        }
        guard var m = sessionTabCache[k] else { return nil }
        m.dot = "idle"; m.tip = t("else.ended"); m.active = on
        return m
    }

    /// Where a view about a session goes in the strip: right after that session's tab.
    private func tabId(of k: String, _ st: HubState?, _ out: [TabModel]) -> String? {
        if let tb = ownTab(k, st) { return tb.id }
        return out.contains { $0.id == "view:\(k)" } ? "view:\(k)" : nil
    }

    /// The strip's tabs besides the panes': the sessions kept as tabs (the
    /// one in front lit), then the view in front (a page, the brief, a
    /// review, a project, Start); the brief and a review right after their
    /// session's tab, that session's tab shown for them when it had none.
    private func stripTabs(_ st: HubState?) -> [TabModel] {
        // A session gone from the board, not in front: its tab goes.
        if let st { sessionTabs.removeAll { st.find($0) == nil && front != .session($0) } }
        var keys = sessionTabs
        for k in pinned where !keys.contains(k) && st?.find(k) != nil { keys.append(k) }
        var out: [TabModel] = []
        for k in keys where ownTab(k, st) == nil { if let m = sessionTab(k, st) { out.append(m) } }
        func beside(_ k: String) -> String? {
            if let id = tabId(of: k, st, out) { return id }
            guard st?.find(k) != nil, let m = sessionTab(k, st) else { return nil }
            out.append(m)
            return m.id
        }
        switch front {
        case .session, .tab: break
        case .project(let id):
            if let p = st?.project(id) { out.append(TabModel(id: "view:project", name: p.name, sub: nil, split: false, active: true, tip: p.name, dot: "idle")) }
        case .page(let k, let name):
            var m = TabModel(id: "view:page", name: name, sub: nil, split: false, active: true, tip: name, dot: "tx3")
            if k.hasPrefix("review:") { m.after = beside(String(k.dropFirst(7))) }
            out.append(m)
        case .start: out.append(TabModel(id: "view:start", name: t("start.title"), sub: nil, split: false, active: true, tip: t("start.title"), dot: "tx3"))
        case .brief(let pid, let k):
            var m = TabModel(id: "view:brief", name: t("brief.title"), sub: st?.project(pid)?.name, split: false, active: true, tip: t("brief.title"), dot: "tx3")
            if k.contains("/") { m.after = beside(k) }
            out.append(m)
        }
        return out
    }

    /// A press on a session's tab: that session, as the sidebar opens it.
    private func selectViewTab(_ id: String) {
        let k = String(id.dropFirst(5))
        guard k.contains("/") else { return }
        topLevel { $0.pickSession(k, why: "tab") }
    }

    /// The x on a tab that is not a pane's: a session's tab goes (the
    /// session goes on; pinned, it is unpinned), the view in front goes back.
    private func closeViewTab(_ id: String) {
        let k = String(id.dropFirst(5))
        guard k.contains("/") else { back(); return }
        sessionTabs.removeAll { $0 == k }
        if pinned.contains(k) { togglePin(k) }
        log.append("session tab \(k): closed")
        if front == .session(k) { back() } else { render() }
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
    /// A toast, said on the view in front. `key` names what it is about (a
    /// newer one with the same key replaces it); `seconds` with actions: at
    /// least 12 (infinity: until pressed).
    func toast(_ text: String, actions: [(String, () -> Void)], key: String? = nil, seconds: Double? = nil) {
        guard !closed else { return }
        log.append("toast \(text)")
        toastView.show(text, actions: actions, key: key, seconds: seconds, at: viewKey, in: root)
    }

    /// The toasts on screen now, oldest first, for the self-test.
    var toastTexts: [String] { toastView.items.map(\.text) }
    /// The toasts' stack itself, for the self-test.
    var toastStack: ToastView { toastView }

    /// The view in front as one key: a toast belongs to the view it was said on.
    private var viewKey: String {
        if case .tab = front { return "tab:\(ws.active?.id ?? "")" }
        return "\(front)"
    }
    private var lastViewKey = ""
    /// What a page said after the person left it, kept for when they come back (with OK).
    private var kept: [ObjectIdentifier: [String]] = [:]

    /// A page's toast: said when the page is in front, else kept for it.
    private func toaster(_ v: NSView) -> (String) -> Void {
        { [weak self, weak v] s in
            guard let self, let v else { return }
            if self.root.middle !== v || v.isHidden { self.keep(s, for: v) } else { self.toast(s) }
        }
    }
    private func keep(_ s: String, for v: NSView) {
        var l = kept[ObjectIdentifier(v)] ?? []
        if !l.contains(s) { l.append(s) }
        kept[ObjectIdentifier(v)] = l
        log.append("toast kept for later: \(s)")
    }
    private func showKept(for v: NSView) {
        guard let l = kept.removeValue(forKey: ObjectIdentifier(v)), !l.isEmpty else { return }
        toast(l.joined(separator: " "), actions: [(t("toast.ok"), {})], key: "kept")
    }

    /// The view in front changed: plain toasts said elsewhere go, and the
    /// question of the session now in front (the person is looking at it).
    private func toastsFollow() {
        let k = viewKey
        if k != lastViewKey {
            lastViewKey = k
            toastView.dropSaidElsewhere(k)
        }
        if let fk = frontKey { toastView.drop(key: "needs:\(fk)") }
    }
}

/// The toasts at the bottom of the window (app.ts showToast, app.css
/// .toast): up to three, the newest last. A plain one goes after 5 s and
/// when the person moves to another view; one with an action (Show, Undo)
/// stays at least 12 s (Undo a minute), with an x. The pointer over them
/// pauses their time, and they get 2 s more once it leaves (2026-11-07,
/// "Didnt have time to click it"). A newer one with the same key (a
/// session's question, the decisions) replaces the older.
final class ToastView: Flipped {
    final class Item: Box {
        let key: String
        let text: String
        let plain: Bool
        /// The view it was said on (Board.viewKey).
        let at: String
        let seconds: Double
        var left: Double
        var since = Date()
        var timer: Timer?
        var buttons: [RButton] = []
        init(key: String, text: String, plain: Bool, at: String, seconds: Double) {
            self.key = key; self.text = text; self.plain = plain; self.at = at; self.seconds = seconds; left = seconds
            super.init(fill: "card2", radius: 9)
        }
        required init?(coder: NSCoder) { fatalError() }
        override func updateLayer() {
            super.updateLayer()
            // box-shadow: 0 10px 30px rgba(0,0,0,.35)
            guard let l = layer else { return }
            l.shadowColor = NSColor.black.cgColor
            l.shadowOpacity = 0.35
            l.shadowRadius = 15
            l.shadowOffset = CGSize(width: 0, height: -10)
            l.masksToBounds = false
        }
    }

    private(set) var items: [Item] = []
    private var hovering = false
    /// The newest toast's words.
    var text: String { items.last?.text ?? "" }
    /// The buttons of the newest toast that has any (Undo, Show), for the self-test.
    var buttons: [RButton] { items.last { !$0.buttons.isEmpty }?.buttons ?? [] }
    var button: RButton? { buttons.first }

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.masksToBounds = false
        isHidden = true
    }
    required init?(coder: NSCoder) { fatalError() }

    func show(_ s: String, actions: [(String, () -> Void)], key: String?, seconds: Double?, at: String, in root: NSView) {
        let plain = actions.isEmpty
        let k = key ?? (plain ? "plain" : "say:\(s)")
        for i in items where i.key == k { drop(i) }
        let secs = plain ? (seconds ?? 5) : max(seconds ?? 12, 12)
        let item = Item(key: k, text: s, plain: plain, at: at, seconds: secs)
        let l = label(s, Fonts.pt(12.5), "tx", lines: 2)
        l.preferredMaxLayoutWidth = 520
        var parts: [NSView] = [l]
        item.buttons = actions.map { name, run in RButton(name, .link) { [weak self, weak item] in if let item { self?.drop(item) }; run() } }
        parts += item.buttons as [NSView]
        // An x on a toast with an action only (a plain one goes by itself).
        if !plain {
            let x = RButton(t("toast.dismiss"), .icon, small: true, icon: "close")
            x.removeConstraints(x.constraints.filter { $0.firstAttribute == .width || $0.firstAttribute == .height })
            x.widthAnchor.constraint(equalToConstant: 20).isActive = true
            x.heightAnchor.constraint(equalToConstant: 20).isActive = true
            x.run = { [weak self, weak item] in if let item { self?.drop(item) } }
            parts.append(x)
        }
        let st = hstack(parts, spacing: 12, insets: NSEdgeInsets(top: 9, left: 14, bottom: 9, right: 14))
        item.addSubview(st)
        st.frame.size = st.fittingSize
        item.frame.size = st.fittingSize
        item.setAccessibilityElement(true)
        item.setAccessibilityRole(.group)
        item.setAccessibilityLabel(s)
        items.append(item)
        addSubview(item)
        // At most three at once: the oldest goes.
        while items.count > 3 { drop(items[0]) }
        if superview !== root { root.addSubview(self, positioned: .above, relativeTo: nil) }
        isHidden = false
        place(in: root)
        run(item)
        NSAccessibility.post(element: item, notification: .announcementRequested, userInfo: [.announcement: s, .priority: NSAccessibilityPriorityLevel.medium.rawValue])
    }

    private func run(_ i: Item) {
        guard i.seconds.isFinite, !hovering, i.timer == nil else { return }
        i.since = Date()
        i.timer = Timer.scheduledTimer(withTimeInterval: i.left, repeats: false) { [weak self, weak i] _ in if let i { self?.drop(i) } }
    }
    private func pause(_ i: Item) {
        guard let tm = i.timer else { return }
        tm.invalidate()
        i.timer = nil
        i.left = max(0, i.left - Date().timeIntervalSince(i.since))
    }

    func drop(_ i: Item) {
        i.timer?.invalidate()
        i.timer = nil
        items.removeAll { $0 === i }
        i.removeFromSuperview()
        if items.isEmpty { isHidden = true; hovering = false } else if let r = superview { place(in: r) }
    }
    func drop(key: String) { for i in items where i.key == key { drop(i) } }
    /// Plain toasts and kept ones said on another view than `here`.
    func dropSaidElsewhere(_ here: String) { for i in items where (i.plain || i.key == "kept") && i.at != here { drop(i) } }
    func clear() { for i in items { drop(i) } }

    /// The stack at the bottom, centred, 20 pt up, the newest last.
    func place(in root: NSView) {
        guard superview === root, !isHidden else { return }
        root.addSubview(self, positioned: .above, relativeTo: nil)
        let w = items.map(\.frame.width).max() ?? 0
        var y: CGFloat = 0
        for i in items {
            i.setFrameOrigin(NSPoint(x: (w - i.frame.width) / 2, y: y))
            y += i.frame.height + 8
        }
        let h = max(0, y - 8)
        frame = NSRect(x: (root.bounds.width - w) / 2, y: root.bounds.height - h - 20, width: w, height: h)
    }

    // The pointer over the toasts pauses them; once it leaves, at least 2 s more.
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with e: NSEvent) { hover(true) }
    override func mouseExited(with e: NSEvent) { hover(false) }
    /// The pointer came over the toasts or left them (the self-test calls it too).
    func hover(_ on: Bool) {
        hovering = on
        if on { items.forEach(pause) } else { for i in items { i.left = max(i.left, 2); run(i) } }
    }
}

