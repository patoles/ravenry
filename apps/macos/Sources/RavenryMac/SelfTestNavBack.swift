// The self-test of the way back from every view one view opens
// (sidetest.mjs --screen nav, after screenNav): the brief from Objectives,
// from a plan, from a project's page and from the panel beside a session;
// a session's view from the brief; a project's page from Objectives; Start
// from a project's page; the gallery beside a session; and the pages a
// page opens (Alerts, Learn, Machines, Sessions, New project, Decisions).
// Each is opened from its source three times: its back link names the
// source and a press on it, Esc and Cmd+W each go back there, the source as
// it was (Objectives at the place scrolled to).

import AppKit

extension SelfTestBoard {
    /// What a view's back link is: its button (nil: none drawn).
    func backButtonOf(_ v: NSView) -> RButton? {
        if let p = v as? InAppPage { return p.buttons["back"] }
        if let p = v as? MiddleView { return p.backBtn }
        if let p = v as? BriefPage { return p.buttons["back"] }
        if let p = v as? ReviewView { return p.buttons["back"] }
        if let p = v as? PickerView { return p.buttons["back"] }
        return nil
    }

    /// Opens `open` from `source` three times: the link says "‹  <name>",
    /// and its press, Esc and Cmd+W each come back to the source.
    func backRoundTrip(_ id: String, pic: String? = nil, name: String, source: () -> Void, open: () -> Void, at: @escaping () -> Bool, view: () -> NSView?) {
        let b = board
        source(); open(); settle(0.3)
        let v = view()
        let link = v.flatMap { backButtonOf($0) }
        check("back_\(id)_link_says_\(name.lowercased().replacingOccurrences(of: " ", with: "_"))", link?.title == "‹  " + name && b.backName == name && link?.isHiddenOrHasHiddenAncestor == false,
              "link \(link?.title ?? "none") backName \(b.backName ?? "nil") front \(b.front)")
        if let pic { settle(0.4); picture(pic) }
        if let link { click(link) }
        check("back_\(id)_link_goes_back", wait(2) { at() }, "\(b.front) \(b.log.suffix(2).joined(separator: " | "))")
        source(); open(); settle(0.2)
        // A field the page put the keyboard in lets go of it at the first Esc (New project's name).
        if let tv = window.firstResponder as? NSTextView, tv.isFieldEditor { esc() }
        esc()
        check("back_\(id)_esc_goes_back", wait(2) { at() }, "\(b.front) \(b.log.suffix(2).joined(separator: " | "))")
        source(); open(); settle(0.2)
        _ = key("w", .command)
        check("back_\(id)_cmd_w_goes_back", wait(2) { at() }, "\(b.front) \(b.log.suffix(2).joined(separator: " | "))")
    }

    private func toTerminal() { var n = 0; while board.root.middle != nil && n < 20 { board.back(); n += 1 } }

    func navBack() {
        let b = board
        size(1280, 820)
        guard let st = b.hub.state,
              let obj = st.pages.first(where: { $0.icon == "target" || $0.label.lowercased().hasPrefix("objectives") }),
              let rules = st.pages.first(where: { $0.icon == "rules" || $0.label.lowercased().hasPrefix("rules") }) else {
            check("back_pages_listed", false, (b.hub.state?.pages.map { "\($0.key):\($0.icon)" } ?? []).joined(separator: ","))
            return
        }
        let pid = st.projects.first { $0.id == "lighthouse" }?.id ?? st.projects.first { $0.brief != nil }?.id ?? "garden-planner"
        func onBrief() -> Bool { if case .brief(pid, _) = b.front { return b.root.middle === b.brief }; return false }
        func onObjectives() -> Bool { b.front == .page(obj.key, obj.label) && b.root.middle === b.files }
        func objectives() { toTerminal(); b.sidebar.onNav?(obj.key, obj.label); _ = wait(4) { b.files.key == obj.key && (b.files.scroll.documentView?.frame.height ?? 0) > 200 } }

        // The brief from Objectives (Simon: "in Objectives when opening a brief there's no navigation back").
        objectives()
        settle(0.5)
        // Objectives scrolled down a little: it comes back at the same place.
        let clip = b.files.scroll.contentView
        let room = (b.files.scroll.documentView?.frame.height ?? 0) - clip.bounds.height
        let y0 = min(160, max(0, room))
        clip.scroll(to: NSPoint(x: 0, y: y0)); b.files.scroll.reflectScrolledClipView(clip)
        b.files.host?.openBrief?(pid, nil)
        _ = wait(4) { b.brief.shownText != nil }
        settle(0.3)
        check("back_brief_from_objectives_named", b.brief.backLink?.name == obj.label && b.brief.buttons["back"]?.title == "‹  " + obj.label && b.brief.buttons["close"] != nil,
              "\(b.brief.backLink?.name ?? "nil") \(b.brief.buttons.keys.sorted())")
        for (w, h) in [(CGFloat(1280), CGFloat(820)), (900, 760)] {
            size(w, h)
            for dark in [true, false] {
                NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                settle(0.4); b.render(force: true); settle(0.4)
                let n = "native-brief-from-objectives-\(Int(w))-\(dark ? "dark" : "light").png"
                picture(n)
                let sq = squeezed(window.contentView!)
                check("back_brief_head_no_squeezed_\(Int(w))_\(dark ? "dark" : "light")", sq.isEmpty && b.brief.buttons["back"].map { $0.frame.width >= $0.fittingSize.width - 1 } == true, sq.joined(separator: " | "))
            }
        }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        size(1280, 820)
        var hit = "no close"
        if let c = b.brief.buttons["close"] {
            window.contentView?.layoutSubtreeIfNeeded()
            let p = c.convert(NSPoint(x: c.bounds.midX, y: c.bounds.midY), to: nil)
            let h = window.contentView?.superview?.hitTest(p)
            hit = "close \(c.frame) in window \(c.window != nil) hidden \(c.isHiddenOrHasHiddenAncestor) hit \(h.map { v -> String in var c: [String] = []; var x: NSView? = v; while let y = x { c.append("\(type(of: y)) \(y.frame)"); x = y.superview }; return c.prefix(6).joined(separator: " < ") } ?? "nil") at \(p)"
            click(c)
        }
        check("back_brief_close_to_objectives", wait(2) { onObjectives() }, "\(b.front) \(hit)")
        check("back_objectives_same_place", abs(b.files.scroll.contentView.bounds.origin.y - y0) < 1, "y \(b.files.scroll.contentView.bounds.origin.y) was \(y0), room \(room)")
        backRoundTrip("brief_objectives", name: obj.label, source: { objectives() }, open: { b.files.host?.openBrief?(pid, nil) }, at: { onObjectives() }, view: { b.brief })

        // The brief from a plan, back to the plan.
        let planName = t("panel.plan")
        backRoundTrip("brief_plan", name: planName, source: { toTerminal(); b.openPlan("garden-planner", title: nil) }, open: { b.plan.openBrief?("garden-planner") },
                      at: { b.front == .page("plan:garden-planner", planName) && b.root.middle === b.plan }, view: { b.brief })

        // A press on the x of a page's Close (its icon used to take the press itself).
        toTerminal(); b.openPlan("garden-planner", title: nil); b.plan.openBrief?("garden-planner")
        if let c = b.brief.buttons["close"] { click(c) }
        check("back_brief_close_press_to_plan", b.front == .page("plan:garden-planner", planName), "\(b.front)")
        if let c = b.plan.buttons["close"] { click(c) }
        check("back_plan_close_press_to_terminal", b.front == .tab && b.root.middle == nil, "\(b.front)")

        // A project no session runs in: its page from Objectives, the brief from its page, Start from its page.
        if let p = st.projects.first(where: { $0.mainSession == nil && $0.machine == nil && $0.brief != nil }) ?? st.projects.first(where: { $0.mainSession == nil && $0.machine == nil }) {
            func onProject() -> Bool { b.front == .project(p.id) && b.root.middle === b.projectPage }
            backRoundTrip("project_objectives", pic: "native-nav-project-from-objectives-1280.png", name: obj.label, source: { objectives() }, open: { _ = b.files.host?.pickProject(p.id) }, at: { onObjectives() }, view: { b.projectPage })
            backRoundTrip("brief_project", name: p.name, source: { toTerminal(); b.pickProject(p.id) }, open: { b.projectPage.onBrief?(p) }, at: { onProject() }, view: { b.brief })
            backRoundTrip("start_project", pic: "native-nav-start-from-project-1280.png", name: p.name, source: { toTerminal(); b.pickProject(p.id) }, open: { b.projectPage.onNewHere?(p) }, at: { onProject() }, view: { b.start })
            toTerminal(); b.pickProject(p.id); b.projectPage.onNewHere?(p)
            if let c = b.start.controls["cancel"] { click(c) }
            check("back_start_cancel_to_project", wait(2) { onProject() }, "\(b.front)")
        } else { check("back_project_without_session", false, st.projects.map(\.id).joined(separator: ",")) }

        // A session outside this window: the panel's Open brief beside it, the
        // gallery beside it, and the session from the brief (a session's link in its text).
        if let p = st.projects.first(where: { p in p.machine == nil && p.sessions.contains { $0.pane == nil && $0.machine == nil } }),
           let s = p.sessions.first(where: { $0.pane == nil && $0.machine == nil }) {
            let k = "\(p.id)/\(s.surfaceId)", sName = s.topic ?? p.name
            func onSession() -> Bool { b.front == .session(k) && b.root.middle === b.outside }
            backRoundTrip("brief_panel", pic: "native-nav-brief-from-session-1280.png", name: sName, source: { toTerminal(); b.sidebar.onSession?(k) }, open: { b.panel.host?.openPage("brief:\(p.id)", t("panel.brief")) }, at: { onSession() }, view: { b.brief })
            backRoundTrip("session_brief", pic: "native-nav-session-from-brief-1280.png", name: t("brief.title"), source: { toTerminal(); b.sidebar.onNav?("brief:\(p.id)", t("panel.brief")) }, open: { b.pickSession(k, why: "link brief") },
                          at: { self.onBrief0(p.id) }, view: { b.outside })
            backRoundTrip("gallery_session", name: sName, source: { toTerminal(); b.sidebar.onSession?(k) }, open: { b.openGallery(p.id, at: nil) }, at: { onSession() }, view: { b.gallery })
            b.ws.bar.onClose?("view:\(k)")
        } else { check("back_outside_session", false, "none on the board") }

        // The pages a page opens (a toast's Show, a hint's Learn more, the panel's links): back to that page.
        func onRules() -> Bool { b.front == .page(rules.key, rules.label) && b.root.middle === b.files }
        let opens: [(String, () -> Void, NSView)] = [
            ("alerts", { b.openAlerts() }, b.alerts), ("learn", { b.openLearn(lit: "pick") }, b.learn), ("machines", { b.openMachines() }, b.machines),
            ("sessions", { b.openSessions() }, b.sessionsPage), ("newproject", { b.openNewProject(nil) }, b.newProject), ("decisions", { b.openDecisions() }, b.decisions),
        ]
        for (id, open, v) in opens {
            backRoundTrip("\(id)_rules", pic: id == "learn" || id == "newproject" ? "native-nav-\(id)-from-rules-1280.png" : nil, name: rules.label, source: { toTerminal(); b.sidebar.onNav?(rules.key, rules.label); _ = wait(3) { b.files.key == rules.key } }, open: open, at: { onRules() }, view: { v })
        }
        // Opened from the sidebar: top level, no link, its Close to the terminal.
        toTerminal()
        b.sidebar.onNav?("brief:\(pid)", t("panel.brief"))
        check("back_brief_from_sidebar_no_link", b.brief.buttons["back"] == nil && b.brief.backLink == nil, "\(b.brief.backLink?.name ?? "nil")")
        if let c = b.brief.buttons["close"] { click(c) }
        check("back_brief_sidebar_close_to_terminal", b.front == .tab && b.root.middle == nil, "\(b.front)")
    }

    private func onBrief0(_ pid: String) -> Bool { if case .brief(pid, _) = board.front { return board.root.middle === board.brief }; return false }
}
