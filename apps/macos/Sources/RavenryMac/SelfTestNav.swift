// The self-test of going back, Esc, the keyboard with a page in front,
// the toasts (sidetest.mjs --screen nav) and of the windows
// (--screen windows): New Window, Move Tab to New Window, a window closed,
// the last window closed with Ravenry still running, the Dock's reopen.

import AppKit

extension SelfTestBoard {
    /// Esc as the keyboard sends it: through the app (sendEvent), so its key watch sees it.
    func esc() {
        guard let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                       windowNumber: window.windowNumber, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}",
                                       isARepeat: false, keyCode: 53) else { return }
        NSApp.sendEvent(e)
        settle(0.3)
    }

    /// A press at a point of the window, through the app (its press watch sees it).
    func press(at p: NSPoint) {
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            if let e = NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                          windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) {
                NSApp.sendEvent(e)
            }
        }
        settle(0.3)
    }

    private func navPage(_ icon: String) -> NavPage? { board.hub.state?.pages.first { $0.icon == icon || $0.label.lowercased().hasPrefix(icon) } }
    private var onTerminal: Bool { board.front == .tab && board.root.middle == nil }
    /// Back to the terminal, every step.
    private func home() { var n = 0; while board.root.middle != nil && n < 20 { board.back(); n += 1 } }

    func screenNav() {
        let b = board
        guard let plans = navPage("plans"), let ideas = navPage("idea"), let rules = navPage("rules") else {
            check("nav_pages_listed", false, (b.hub.state?.pages.map { "\($0.key):\($0.icon)" } ?? []).joined(separator: ","))
            return
        }
        // Plans, then a plan from it: the plan's Close goes back to Plans, not the terminal (B1, V6).
        b.openPage(plans.key, plans.label)
        check("nav_plans_open", b.front == .page(plans.key, plans.label) && b.root.middle === b.files, "\(b.front)")
        b.files.host?.openPlan("garden-planner", nil)
        check("nav_plan_from_plans", b.front == .page("plan:garden-planner", t("panel.plan")) && b.root.middle === b.plan, "\(b.front)")
        check("nav_plan_back_named", b.backName == plans.label && b.plan.backLink?.name == plans.label, "\(b.backName ?? "nil") / \(b.plan.backLink?.name ?? "nil")")
        size(1280, 820)
        picture("native-nav-plan-1280.png")
        b.plan.onClose?()
        check("nav_plan_close_to_plans", b.front == .page(plans.key, plans.label) && b.root.middle === b.files, "\(b.front) \(b.log.suffix(2).joined(separator: " | "))")
        picture("native-nav-plan-closed-1280.png")
        // The head's "‹ Plans" link: the same step back (B2, group 3 draws it from backLink).
        b.files.host?.openPlan("garden-planner", nil)
        check("nav_plan_head_link", shows(b.plan, plans.label), texts(b.plan).prefix(4).joined(separator: " | "))
        b.plan.backLink?.run()
        check("nav_plan_link_to_plans", b.front == .page(plans.key, plans.label), "\(b.front)")
        // Esc: the same step back, then to the terminal.
        b.files.host?.openPlan("garden-planner", nil)
        esc()
        check("nav_esc_plan_to_plans", b.front == .page(plans.key, plans.label), "\(b.front) \(b.log.suffix(2).joined(separator: " | "))")
        esc()
        check("nav_esc_plans_to_terminal", onTerminal, "\(b.front)")
        // Deeper: Plans, a plan, its brief; each Close one step back (C17).
        b.openPage(plans.key, plans.label)
        b.files.host?.openPlan("garden-planner", nil)
        b.plan.openBrief?("garden-planner")
        check("nav_brief_from_plan", { if case .brief("garden-planner", _) = b.front { return true }; return false }() && b.backName == t("panel.plan"), "\(b.front) back \(b.backName ?? "nil")")
        b.back()
        check("nav_brief_back_to_plan", b.front == .page("plan:garden-planner", t("panel.plan")), "\(b.front)")
        b.back()
        check("nav_then_plans", b.front == .page(plans.key, plans.label), "\(b.front)")
        b.back()
        check("nav_then_terminal", onTerminal, "\(b.front)")
        // The sidebar's Plans while on a plan opened from Plans: one level, no loop.
        b.openPage(plans.key, plans.label)
        b.files.host?.openPlan("garden-planner", nil)
        b.openPage(plans.key, plans.label)
        check("nav_no_loop", b.backTrail.isEmpty, "\(b.backTrail)")
        // A page from the sidebar while on another: top level, its Close to the terminal.
        home()
        b.openPage(ideas.key, ideas.label)
        b.sidebar.onNav?(rules.key, rules.label)
        check("nav_sidebar_is_top_level", b.front == .page(rules.key, rules.label) && b.backTrail.isEmpty && b.backName == nil, "\(b.backTrail)")
        b.back()
        check("nav_sidebar_page_closes_to_terminal", onTerminal, "\(b.front)")
        // An idea from Ideas: its "‹ Ideas" goes up to Ideas, whose Close then goes to the terminal (B3).
        home()
        b.openPage(ideas.key, ideas.label)
        b.openIdea("demo-tidepool")
        b.idea.openIdeas?()
        check("nav_idea_up_to_ideas", b.front == .page(ideas.key, ideas.label) && b.backTrail.isEmpty, "\(b.front) \(b.backTrail)")
        b.back()
        check("nav_ideas_close_to_terminal", onTerminal, "\(b.front)")
        // The brief from a project's page closes to that page (B4).
        if let p = b.hub.state?.projects.first(where: { $0.mainSession == nil }) {
            home()
            b.pickProject(p.id)
            b.openPage("brief:\(p.id)", t("panel.brief"))
            b.back()
            check("nav_brief_back_to_project", b.front == .project(p.id), "\(b.front)")
            b.back()
        }

        // Keys with a page in front act on what is seen (D3, D4).
        home()
        let tabs = b.ws.tabs.count
        b.openPage(rules.key, rules.label)
        check("nav_page_has_keyboard", !(window.firstResponder is TerminalView), "\(window.firstResponder.map { "\(type(of: $0))" } ?? "nil")")
        _ = key("w", .command)
        check("nav_cmd_w_goes_back", onTerminal && b.ws.tabs.count == tabs, "\(b.front) tabs \(b.ws.tabs.count) of \(tabs)")
        b.openPage(rules.key, rules.label)
        _ = key("t", .command)
        check("nav_cmd_t_shows_terminal", wait(3) { b.ws.tabs.count == tabs + 1 } && onTerminal && b.ws.active === b.ws.tabs.last, "\(b.front) tabs \(b.ws.tabs.count)")
        b.openPage(rules.key, rules.label)
        _ = key("1", .command)
        check("nav_cmd_1_shows_terminal", onTerminal && b.ws.active === b.ws.tabs.first, "\(b.front)")
        b.openPage(rules.key, rules.label)
        _ = key("\t", .control)
        check("nav_ctrl_tab_shows_terminal", onTerminal && b.ws.active === b.ws.tabs.first, "\(b.front)")
        _ = key("w", .command)
        // (the shell Cmd+T opened: the one in front is closed by Cmd+W on a terminal)

        // Esc closes the panel over the terminal (D17).
        size(900, 760)
        if !b.panelVisible { b.togglePanel() }
        check("nav_overlay_open", b.root.panelMode == .overlay, "\(b.root.panelMode)")
        esc()
        check("nav_esc_closes_overlay", b.root.panelMode == .hidden && onTerminal, "\(b.root.panelMode)")
        size(1280, 820)

        // Toasts: three at most, keyed ones replace their own, plain ones stay on their view (A31 to A34, V2).
        let ts = b.toastStack
        ts.clear()
        b.openPage(ideas.key, ideas.label)
        b.toast("Thinking up 3 directions. They land in Spark.")
        b.toast("Paper-boat needs you: tilt?", actions: [("Show", {})], key: "needs:paper-boat/sf-1")
        b.toast("Paper-boat needs you: keep it level?", actions: [("Show", {})], key: "needs:paper-boat/sf-1")
        check("toast_keyed_replaces", b.toastTexts == ["Thinking up 3 directions. They land in Spark.", "Paper-boat needs you: keep it level?"], b.toastTexts.joined(separator: " | "))
        b.toast("Saved.", actions: [("Undo", {})], key: "decision", seconds: 60)
        b.toast("Copied.", actions: [("Show", {})])
        check("toast_three_at_most", b.toastTexts.count == 3 && !b.toastTexts.contains("Thinking up 3 directions. They land in Spark."), b.toastTexts.joined(separator: " | "))
        b.toast("Thinking up 3 directions. They land in Spark.")
        let plain = ts.items.last
        check("toast_plain_no_x", plain?.buttons.isEmpty == true && !(plain.map { texts($0) } ?? []).contains(t("toast.dismiss")) && plain.map { hasDismiss($0) } == false)
        check("toast_action_has_x", ts.items.first.map { hasDismiss($0) } == true)
        picture("native-toasts-1280.png")
        b.openPage(rules.key, rules.label)
        check("toast_plain_stays_on_its_view", !b.toastTexts.contains("Thinking up 3 directions. They land in Spark.") && b.toastTexts.count == 2, b.toastTexts.joined(separator: " | "))
        picture("native-toasts-rules-1280.png")
        // The pointer over them pauses their time; once it leaves, 2 s more.
        ts.clear()
        b.toast("A short one.", actions: [], seconds: 0.6)
        ts.hover(true)
        settle(1.2)
        check("toast_hover_pauses", b.toastTexts == ["A short one."], b.toastTexts.joined(separator: " | "))
        ts.hover(false)
        settle(1.0)
        check("toast_after_hover_two_seconds", b.toastTexts == ["A short one."])
        check("toast_then_goes", wait(3) { b.toastTexts.isEmpty })
        // Said by a page the person left: kept, shown with OK on return.
        home()
        b.files.host?.toast("The rule could not be saved.", nil)
        check("toast_kept_not_shown_elsewhere", b.toastTexts.isEmpty, b.toastTexts.joined(separator: " | "))
        b.openPage(rules.key, rules.label)
        check("toast_kept_shown_on_return", b.toastTexts == ["The rule could not be saved."] && b.toastButtons.map(\.title) == [t("toast.ok")], b.toastTexts.joined(separator: " | "))
        ts.clear()
        b.back()

        // The phone card: a press outside it closes it (C24).
        b.openPhone()
        check("phone_open", b.phoneCard.isOpen)
        let stage = b.ws.stage
        press(at: stage.convert(NSPoint(x: stage.bounds.midX, y: stage.bounds.midY), to: nil))
        check("phone_press_outside_closes", !b.phoneCard.isOpen, b.log.suffix(2).joined(separator: " | "))

        // Sessions kept as tabs (D7, D8, D9, D21): a read-only session's tab stays when another is picked.
        home()
        let outside = (b.hub.state?.projects ?? []).filter { $0.machine == nil }.flatMap { p in p.sessions.filter { $0.pane == nil && $0.machine == nil }.map { (p.id, "\(p.id)/\($0.surfaceId)") } }
        if outside.count >= 2 {
            let (p1, k1) = outside[0], k2 = outside[1].1
            func ids() -> [String] { b.ws.bar.items.map(\.model.id) }
            b.sidebar.onSession?(k1)
            check("tabs_session_is_a_tab", ids().contains("view:\(k1)") && b.ws.extraTab?.id == "view:\(k1)", ids().joined(separator: ","))
            b.ws.bar.onSelect?(b.ws.tabs[0].id)
            check("tabs_session_tab_stays", onTerminal && ids().contains("view:\(k1)"), ids().joined(separator: ","))
            b.sidebar.onSession?(k2)
            check("tabs_two_sessions", ids().contains("view:\(k1)") && ids().contains("view:\(k2)") && b.ws.extraTab?.id == "view:\(k2)", ids().joined(separator: ","))
            b.ws.bar.onSelect?("view:\(k1)")
            check("tabs_click_brings_it", b.front == .session(k1), "\(b.front)")
            b.openPage("brief:\(p1)", t("panel.brief"))
            let order = ids()
            check("tabs_brief_beside_its_session", order.firstIndex(of: "view:\(k1)").map { order.indices.contains($0 + 1) && order[$0 + 1] == "view:brief" } ?? false, order.joined(separator: ","))
            picture("native-tabs-sessions-1280.png")
            b.back()
            // Pinned: kept with the tabs (window.json), back in a window opened after, as after a relaunch.
            b.togglePin(k2)
            b.ws.flush()
            check("tabs_pin_saved", LayoutStore(offscreen: true, socket: b.ws.conn.socketPath)?.read().pinned.contains(k2) ?? false)
            // The x: the session's tab goes, the session goes on.
            b.ws.bar.onClose?("view:\(k1)")
            check("tabs_x_closes_tab", !ids().contains("view:\(k1)") && b.front != .session(k1) && b.hub.state?.find(k1) != nil, ids().joined(separator: ","))
            if let app = NSApp.delegate as? AppDelegate, let nw = app.makeWindow(.shell(nil)) {
                _ = wait(8) { nw.hub.state != nil }
                nw.board.render()
                check("tabs_pinned_come_back", nw.ws.bar.items.contains { $0.model.id == "view:\(k2)" }, nw.ws.bar.items.map(\.model.id).joined(separator: ","))
                nw.window.performClose(nil)
                settle(0.3)
            }
            b.togglePin(k2)
            b.ws.bar.onClose?("view:\(k2)")
            home()
        } else {
            check("tabs_outside_sessions", false, "\(outside)")
        }

        // Learn ticks an answered question (C20).
        let n = b.hub.sentBodies.count
        b.panel.host?.answered()
        check("learn_needs_ticked", wait(3) { b.hub.sentBodies.dropFirst(n).contains { $0.path == "/api/onboarding" && (($0.body["learn"] as? [String: Any])?["needs"] as? Bool) == true } } || b.learn.used["needs"] == true,
              b.hub.sentBodies.dropFirst(n).map(\.path).joined(separator: ","))
    }

    private func hasDismiss(_ v: NSView) -> Bool {
        if let r = v as? RButton, r.title == t("toast.dismiss") || r.accessibilityLabel() == t("toast.dismiss") || r.toolTip == t("toast.dismiss") { return true }
        return v.subviews.contains { hasDismiss($0) }
    }

    // MARK: windows

    private func shot(_ rw: RavenryWindow, _ name: String) {
        guard let root = rw.window.contentView, let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { return }
        root.cacheDisplay(in: root.bounds, to: rep)
        let s: CGFloat = 2
        let w = Int(root.bounds.width * s), h = Int(root.bounds.height * s)
        guard let base = rep.cgImage, let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                                          bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return }
        var bg = CGColor(gray: 0, alpha: 1)
        rw.window.effectiveAppearance.performAsCurrentDrawingAppearance { bg = (rw.window.backgroundColor.usingColorSpace(.sRGB) ?? .black).cgColor }
        ctx.setFillColor(bg)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.draw(base, in: CGRect(x: 0, y: 0, width: w, height: h))
        if rw.board.root.middle == nil {
            for (_, bx) in rw.ws.boxes where bx.term.window != nil && bx.term.live && !bx.term.isHiddenOrHasHiddenAncestor {
                guard let img = bx.term.snapshotImage() else { continue }
                let r = bx.term.convert(bx.term.bounds, to: root)
                ctx.draw(img, in: CGRect(x: r.minX * s, y: CGFloat(h) - r.maxY * s, width: r.width * s, height: r.height * s))
            }
        }
        guard let img = ctx.makeImage() else { return }
        try? NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent(name))
    }

    func screenWindows() {
        guard let app = NSApp.delegate as? AppDelegate, let w1 = app.windows.first else { check("windows_app", false); return }
        let total0 = w1.ws.tabs.count
        check("windows_one_at_start", app.windows.count == 1)
        let menus = NSApp.mainMenu?.items.compactMap { $0.submenu?.title } ?? []
        check("windows_menus", menus == ["Ravenry", "Shell", "Edit", "View", "Window", "Help"] && NSApp.windowsMenu?.title == "Window", menus.joined(separator: ","))
        let appMenu = NSApp.mainMenu?.items.first?.submenu?.items.map(\.title) ?? []
        check("windows_app_menu", ["About Ravenry", "Settings\u{2026}", "Services", "Hide Ravenry", "Hide Others", "Show All", "Quit Ravenry"].allSatisfy(appMenu.contains), appMenu.joined(separator: ","))
        // Cmd+N: a second window with a shell of its own, its own sidebar and panel.
        check("windows_cmd_n", key("n", .command) && wait(5) { app.windows.count == 2 }, "\(app.windows.count)")
        guard app.windows.count == 2 else { return }
        let w2 = app.windows[1]
        check("windows_second_has_a_shell", w2.ws.tabs.count == 1 && wait(5) { (w2.ws.focusedView?.screen.frames ?? 0) > 0 } && !w1.ws.tabs.contains { $0.host == w2.ws.tabs[0].host },
              "tabs \(w2.ws.tabs.map(\.host)) vs \(w1.ws.tabs.map(\.host))")
        check("windows_second_has_board", w2.board.root.sidebar != nil && wait(8) { (w2.hub.state?.projects.count ?? 0) >= 5 })
        settle(0.8)
        w2.board.render(force: true)
        settle(0.4)
        shot(w2, "native-window-second-900.png")
        // The menus act on the window in front: Cmd+T in the second.
        _ = key("t", .command)
        check("windows_cmd_t_in_front_window", wait(3) { w2.ws.tabs.count == 2 } && w1.ws.tabs.count == total0, "w1 \(w1.ws.tabs.count) w2 \(w2.ws.tabs.count)")
        // Move Tab to New Window: the tab in front alone in a third, whole with its split, its panes still running.
        _ = key("d", .command)
        _ = wait(3) { w2.ws.active?.guest != nil }
        let moving = w2.ws.active!.host, guest = w2.ws.active?.guest
        app.menuMoveTabToNewWindow(nil)
        check("windows_move_tab", app.windows.count == 3 && w2.ws.tabs.count == 1 && app.windows[2].ws.tabs.map(\.host) == [moving] && w2.ws.paneInfo(moving) == nil,
              "windows \(app.windows.count) w2 \(w2.ws.tabs.map(\.host)) w3 \(app.windows.last?.ws.tabs.map(\.host) ?? [])")
        check("windows_move_keeps_split", guest != nil && app.windows.last?.ws.tabs.first?.guest == guest, "guest \(guest ?? "none") then \(app.windows.last?.ws.tabs.first?.guest ?? "none")")
        let w3 = app.windows[2]
        check("windows_moved_tab_draws", wait(5) { (w3.ws.focusedView?.screen.frames ?? 0) > 0 })
        shot(w3, "native-window-moved-tab-900.png")
        // The tab strip's right click offers it.
        check("windows_tab_menu", w2.ws.bar.menu?.delegate === w2.tabMenu)
        // Closing a window ends no shell: its tab joins the window in front.
        let all = Set(app.windows.flatMap { w in w.ws.tabs.flatMap { w.ws.panes(of: $0) } })
        w3.window.performClose(nil)
        settle(0.5)
        let after = Set(app.windows.flatMap { w in w.ws.tabs.flatMap { w.ws.panes(of: $0) } })
        check("windows_close_keeps_tabs", app.windows.count == 2 && after == all, "windows \(app.windows.count) before \(all.sorted()) after \(after.sorted())")
        check("windows_close_keeps_split", app.windows.contains { w in w.ws.tabs.contains { $0.host == moving && $0.guest == guest } })
        // The last window closed: Ravenry keeps running; the Dock's click brings one back with every tab.
        for w in app.windows { w.window.performClose(nil); settle(0.3) }
        check("windows_last_closed_app_runs", app.windows.isEmpty && !app.terminating && app.windowLog.contains { $0.contains("keeps running") }, app.windowLog.suffix(3).joined(separator: " | "))
        _ = app.applicationShouldHandleReopen(NSApp, hasVisibleWindows: false)
        settle(1.0)
        let back = app.windows.first
        let restored = Set(back.map { w in w.ws.tabs.flatMap { w.ws.panes(of: $0) } } ?? [])
        check("windows_reopen_restores", app.windows.count == 1 && restored.isSuperset(of: all), "restored \(restored.sorted()) of \(all.sorted())")
        if let back { _ = wait(5) { (back.ws.focusedView?.screen.frames ?? 0) > 0 }; shot(back, "native-window-reopened-900.png") }
    }
}
