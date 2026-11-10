// The sidebar's and the panel's self-test (scripts/sidetest.mjs): the app
// off every screen on a throwaway daemon and a demo hub (never the
// person's), driven with real events where the person would use them (a
// mouse press on a row, the menu's key equivalents) and the buttons' own
// clicks. Each check reads what the window shows (the rows drawn, the one
// highlighted, what the panel and the middle show, what was posted to the
// hub), and it writes pictures of the window at 1440, 1280 and 900 points
// wide, dark and light. The driver adds the arrivals: the app writes
// <out>.arrive-N and waits for <out>.go-N.

import AppKit

final class SelfTestBoard {
    let board: Board
    let window: NSWindow
    let out: String
    /// One screen's checks only (SelfTestScreens.swift), else the whole run.
    var screen: String?
    var checks: [[String: Any]] = []

    init(board: Board, window: NSWindow, out: String) { self.board = board; self.window = window; self.out = out }

    func check(_ name: String, _ ok: Bool, _ detail: String = "") {
        checks.append(["name": name, "ok": ok, "detail": detail])
    }

    var dir: URL { URL(fileURLWithPath: out).deletingLastPathComponent() }

    /// Waits on the main loop until `cond`, at most `timeout` seconds.
    func wait(_ timeout: Double = 8, _ cond: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if cond() { return true }
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        return cond()
    }
    func settle(_ s: Double = 0.4) { RunLoop.main.run(until: Date().addingTimeInterval(s)) }

    func size(_ w: CGFloat, _ h: CGFloat) {
        window.setContentSize(NSSize(width: w, height: h))
        board.resized()
        window.contentView?.layoutSubtreeIfNeeded()
        settle(0.5)
    }

    /// A press and a release at the middle of a view, as the window gets them.
    func click(_ v: NSView) {
        window.contentView?.layoutSubtreeIfNeeded()
        // As the person would: scrolled into view first.
        v.scrollToVisible(v.bounds)
        let p = v.convert(NSPoint(x: v.bounds.midX, y: v.bounds.midY), to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            if let e = NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                          windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) {
                window.sendEvent(e)
            }
        }
        settle(0.2)
    }

    /// A key equivalent, as the menu gets it.
    func key(_ chars: String, _ mods: NSEvent.ModifierFlags) -> Bool {
        guard let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime,
                                       windowNumber: window.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars,
                                       isARepeat: false, keyCode: 0) else { return false }
        let done = window.performKeyEquivalent(with: e) || (NSApp.mainMenu?.performKeyEquivalent(with: e) ?? false)
        settle(0.2)
        return done
    }

    func picture(_ name: String) {
        guard let root = window.contentView, let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { return }
        root.cacheDisplay(in: root.bounds, to: rep)
        let s: CGFloat = 2
        let w = Int(root.bounds.width * s), h = Int(root.bounds.height * s)
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
              let base = rep.cgImage else { return }
        var bg = CGColor(gray: 0, alpha: 1)
        window.effectiveAppearance.performAsCurrentDrawingAppearance { bg = (window.backgroundColor.usingColorSpace(.sRGB) ?? .black).cgColor }
        ctx.setFillColor(bg)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.draw(base, in: CGRect(x: 0, y: 0, width: w, height: h))
        // Each pane's last drawing at its place (Metal draws offscreen),
        // then what lies over the terminal: the panel over it, the toast.
        if board.root.middle == nil {
            for (_, b) in board.ws.boxes where b.term.window != nil && b.term.live && !b.term.isHiddenOrHasHiddenAncestor {
                guard let img = b.term.snapshotImage() else { continue }
                let r = b.term.convert(b.term.bounds, to: root)
                ctx.draw(img, in: CGRect(x: r.minX * s, y: CGFloat(h) - r.maxY * s, width: r.width * s, height: r.height * s))
            }
        }
        var over: [NSView] = []
        if board.root.panelMode == .overlay, let p = board.root.panel { over.append(p) }
        // (the phone card too: the terminal's drawing goes over it here, not on screen, where its layer is above.)
        over += root.subviews.filter { ($0 is ToastView || $0 is PhoneCard) && !$0.isHidden }
        for v in over {
            guard let r2 = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { continue }
            v.cacheDisplay(in: v.bounds, to: r2)
            if let img = r2.cgImage {
                let r = v.frame
                ctx.draw(img, in: CGRect(x: r.minX * s, y: CGFloat(h) - r.maxY * s, width: r.width * s, height: r.height * s))
            }
        }
        guard let img = ctx.makeImage() else { return }
        try? NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent(name))
    }

    /// Waits for the driver to add an arrival.
    func arrival(_ n: Int) -> Bool {
        let a = URL(fileURLWithPath: out + ".arrive-\(n)"), g = URL(fileURLWithPath: out + ".go-\(n)")
        try? Data().write(to: a)
        return wait(30) { FileManager.default.fileExists(atPath: g.path) }
    }

    /// From a timer, not the main queue: the waits below run the main
    /// loop, which then also runs what the hub and the daemon queue for it.
    func start() {
        Outside.record = []
        Timer.scheduledTimer(withTimeInterval: 0.1, repeats: false) { _ in self.run() }
    }

    private func run() {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        size(1440, 900)
        if let s = screen { runScreen(s); return }
        let hub = board.hub
        check("hub_state", wait(20) { (hub.state?.projects.count ?? 0) >= 5 }, hub.url)
        guard let st0 = hub.state else { finish(); return }
        settle(0.6)
        // The sections, their counts and every row the hub sent.
        let keys = st0.sections.flatMap { s in s.projects.flatMap { p in p.rows.isEmpty ? ["project:\(p.id)"] : p.rows.map { $0.key } } }
        let drawn = keys.filter { board.sidebar.rows[$0] != nil }
        check("sidebar_rows", !keys.isEmpty && drawn.count == keys.count, "\(drawn.count) of \(keys.count): \(keys.joined(separator: ","))")
        check("sidebar_counts", st0.sections.map { $0.count }.reduce(0, +) == keys.count, st0.sections.map { "\($0.group) \($0.count)" }.joined(separator: ", "))
        check("nav_pages", ["objectives", "plans", "ideas", "rules", "ship", "decisions"].allSatisfy { board.sidebar.rows["page:\($0)"] != nil })

        // A question arrives (paper-boat): a toast with Show, the shell stays in front.
        check("arrival_1", arrival(1))
        check("arrived_in_state", wait(30) { hub.state?.sidebar(has: "paper-boat/sf-3", in: "you") ?? false })
        settle(0.6)
        check("toast_on_arrival", board.log.contains { $0.hasPrefix("arrived paper-boat/sf-3: a toast") } && board.front == .tab, board.log.suffix(3).joined(separator: " | "))
        picture("native-shell-1440.png")

        // A click on a session row: its view in the middle, highlighted, the panel on it.
        let k1 = "garden-planner/sf-1"
        if let r = board.sidebar.rows[k1] { click(r) }
        check("click_session", board.front == .session(k1) && board.panel.key == k1 && board.panel.shows == "session", "front \(board.front) panel \(board.panel.key)")
        check("row_highlighted", board.sidebar.rows[k1]?.selected == true)
        check("outside_view", board.root.middle === board.outside && !board.outside.isHidden)
        settle(1.0)
        picture("native-session-1440.png")
        size(1280, 800)
        picture("native-session-1280.png")
        check("panel_docked_1280", board.root.panelMode == .docked)
        NSApp.appearance = NSAppearance(named: .aqua)
        settle(0.6)
        board.render(force: true)
        settle(0.4)
        picture("native-session-1280-light.png")
        NSApp.appearance = NSAppearance(named: .darkAqua)
        settle(0.4)
        board.render(force: true)

        // The pin, on the row and in the panel.
        if let pb = board.sidebar.pins[k1] { pb.performClick(nil) }
        settle(0.3)
        check("pin_row", board.pinned.contains(k1))
        board.panel.buttons["pin"]?.performClick(nil)
        settle(0.3)
        check("unpin_panel", !board.pinned.contains(k1))

        // The panel's own buttons post what the person clicked (a test hub).
        board.panel.buttons["handoff"]?.performClick(nil)
        _ = wait(3) { hub.sent.contains("POST /api/handoff") }
        check("hand_off_now", hub.sent.contains("POST /api/handoff"), hub.sent.joined(separator: ", "))
        check("brief_card", board.panel.buttons["brief"] != nil)
        board.panel.buttons["brief"]?.performClick(nil)
        check("open_brief_page", board.front == .brief("garden-planner", k1) && board.root.middle === board.brief, "\(board.front)")
        if let r = board.sidebar.rows[k1] { click(r) }
        _ = wait(3) { self.board.panel.pictureView != nil }
        check("picture_thumb", board.panel.pictureView != nil)
        if let pv = board.panel.pictureView { click(pv) }
        check("picture_large", board.front == .page("gallery:garden-planner", t("gallery.title")) && board.gallery.at == 0 && !board.gallery.isHidden)
        board.gallery.closeButton.performClick(nil)
        check("picture_closed", board.front == .session(k1) || board.front == .tab, "\(board.front)")

        // The paper-boat session: Move here goes to the hub as the person.
        let k2 = "paper-boat/sf-3"
        if let r = board.sidebar.rows[k2] { click(r) }
        check("click_you_session", board.front == .session(k2) && board.panel.key == k2)
        board.outside.buttons["move"]?.performClick(nil)
        _ = wait(5) { hub.sent.contains("POST /api/sessions/move") }
        check("move_here_posted", hub.sent.contains("POST /api/sessions/move"), board.outside.buttons.keys.sorted().joined(separator: ","))

        // An idle project: its page, Continue this conversation or New session.
        let idle = st0.sections.first { $0.group == "idle" }?.projects.first { $0.rows.isEmpty && st0.project($0.id)?.mainSession == nil }
        if let p = idle, let r = board.sidebar.rows["project:\(p.id)"] { click(r) }
        check("click_idle_project", board.log.last.map { $0.contains(idle?.id ?? "-") } ?? false, board.log.last ?? "")
        _ = wait(5) { self.board.projectPage.buttons["continue"] != nil || self.board.projectPage.buttons["new"] != nil }
        check("project_page", board.projectPage.buttons["continue"] != nil || board.projectPage.buttons["new"] != nil, board.projectPage.buttons.keys.sorted().joined(separator: ","))
        settle(0.5)
        picture("native-project-1280.png")

        // A page from a file: drawn natively from the hub's page, never a web view.
        if let r = board.sidebar.rows["page:plans"] { click(r) }
        check("nav_plans", board.front == .page("plans", "Plans") && board.root.middle === board.files && board.files.key == "plans" && board.sidebar.rows["page:plans"]?.selected == true)
        board.sidebar.newButton.performClick(nil)
        check("new_session", board.front == .start && !board.start.isHidden)
        // Answered here, never sent: no assistant runs (step 2 and more: --screen start).
        hub.testAnswers["/api/onboarding"] = ["ok": true, "setup": ["claude": true, "codex": true]]
        hub.testPostAnswers["/api/sessions/start"] = (409, ["error": "Not started by the self-test."])
        _ = wait(5) { self.board.start.controls["go"] != nil && self.board.start.folder != nil }
        let tabs0 = board.ws.tabs.count
        board.start.go.performClick(nil)
        // The board's start, or a shell in the folder when the board finds no assistant.
        _ = wait(5) { hub.sent.contains("POST /api/sessions/start") || self.board.ws.tabs.count > tabs0 }
        check("start_posted", hub.sent.contains("POST /api/sessions/start") || board.ws.tabs.count > tabs0)
        hub.testAnswers["/api/onboarding"] = nil
        hub.testPostAnswers = [:]

        // The shortcuts.
        if let t = board.ws.tabs.first { board.ws.bar.onSelect?(t.id) }
        check("cmd_shift_n", key("N", [.command, .shift]) && board.front == .start)
        let side0 = board.root.sideWidth
        check("hide_sidebar", key("s", [.command, .control]) && board.root.sideWidth == 0 && side0 > 0)
        check("show_sidebar", key("s", [.command, .control]) && board.root.sideWidth == side0)
        if let r = board.sidebar.rows[k1] { click(r) }
        let vis0 = board.root.panelMode
        check("hide_panel", key("b", [.command, .option]) && board.root.panelMode == .hidden && vis0 == .docked, "\(vis0)")
        check("show_panel", key("b", [.command, .option]) && board.root.panelMode == .docked)

        // The sidebar's edge, dragged.
        let w0 = board.root.sideWidth
        board.sidebar.onResize?(340)
        check("resize_sidebar", board.root.sideWidth == 340 && w0 == SidebarView.defaultWidth, "\(w0) to \(board.root.sideWidth)")
        board.sidebar.onResize?(SidebarView.defaultWidth)

        // Narrow: the panel folds away; a question for what is in front opens it over the terminal.
        if let t = board.ws.tabs.first { board.ws.bar.onSelect?(t.id) }
        size(900, 700)
        check("panel_folds_900", board.root.panelMode == .hidden && board.front == .tab, "\(board.root.panelMode) \(board.front)")
        picture("native-folded-900.png")
        let k3 = "notes-app/sf-4"
        if let r = board.sidebar.rows[k3] { click(r) }
        check("narrow_pick", board.front == .session(k3) && board.root.panelMode == .hidden, "\(board.front) \(board.root.panelMode)")
        check("arrival_2", arrival(2))
        _ = wait(10) { self.board.root.panelMode == .overlay }
        check("panel_opens_on_question", board.root.panelMode == .overlay, board.log.suffix(2).joined(separator: " | "))
        settle(0.8)
        picture("native-arrival-900.png")
        check("panel_folds_again", key("b", [.command, .option]) && board.root.panelMode == .hidden)
        finish()
    }

    func finish() {
        let failed = checks.filter { !($0["ok"] as? Bool ?? false) }.count
        let res: [String: Any] = ["checks": checks, "failed": failed, "log": board.log, "sent": board.hub.sent]
        if let d = try? JSONSerialization.data(withJSONObject: res, options: [.prettyPrinted]) { try? d.write(to: URL(fileURLWithPath: out)) }
        NSApp.terminate(nil)
    }
}

extension HubState {
    func sidebar(has key: String, in group: String) -> Bool {
        sections.contains { $0.group == group && $0.projects.contains { $0.rows.contains { $0.key == key } } }
    }
}
