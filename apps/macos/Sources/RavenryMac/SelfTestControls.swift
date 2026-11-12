// A11Y-003, every visible control does what it says (sidetest --screen
// controls): on the main window (the sidebar, its foot, the tab strip, the
// panel beside the terminal), Alerts, Learn, Machines and each tab of
// Settings, every control the Accessibility tree offers a press is pressed
// (accessibilityPerformPress, as VoiceOver and the audit's AX presses do),
// one at a time from the screen as it was, and something must come of it:
// a request to the hub, a page, window, card, toast or sheet, a change in
// what the window says or a control's value, or what the app hands to the
// Mac (Outside: an open, a copy). And none opens the board itself in the
// browser. A choice already picked (a segment, a theme) may do nothing.

import AppKit

extension SelfTestBoard {
    private struct World: Equatable {
        var front = "", log = 0, sent = 0, outside = 0, toasts = 0, settings = false, phone = false, windows = 0, tabs = 0, main = 0, set = 0
    }
    private func axSig(_ v: NSView) -> Int {
        var h = Hasher()
        func walk(_ x: NSView) {
            if x.isHidden { return }
            if let f = x as? NSTextField { h.combine(f.stringValue) }
            if let b = x as? NSButton { h.combine(b.title); h.combine(b.state.rawValue) }
            if let val = x.accessibilityValue() { h.combine("\(val)") }
            if let b = x as? Box { h.combine(b.ring ?? ""); h.combine(b.fill ?? "") }
            x.subviews.forEach(walk)
        }
        walk(v)
        return h.finalize()
    }
    private func world() -> World {
        let sw = board.settings
        return World(front: "\(board.front)", log: board.log.count, sent: board.hub.sent.count, outside: Outside.record?.count ?? 0, toasts: board.toastTexts.count,
                     settings: sw.window.isVisible, phone: board.phoneCard.isOpen, windows: NSApp.windows.filter { $0.isVisible }.count, tabs: board.ws.tabs.count,
                     main: axSig(window.contentView!), set: sw.window.isVisible ? axSig(sw.window.contentView!) : 0)
    }
    /// The controls a press reaches, in the order drawn, with a key that finds the same one again.
    private func pressables(_ root: NSView) -> [(key: String, view: NSView)] {
        var out: [(String, NSView)] = []
        var seen: [String: Int] = [:]
        func walk(_ v: NSView) {
            if v.isHiddenOrHasHiddenAncestor || v.alphaValue < 0.05 || v is TerminalView { return }
            // Off (greyed, and said so to VoiceOver): a press is not asked of it.
            if let c = v as? CheckRow, !c.enabled { return }
            let role = v.accessibilityRole()
            let pressable = (v is NSButton && (v as? NSButton)?.isEnabled == true && !(v is NSPopUpButton))
                || (v.isAccessibilityElement() && [.button, .radioButton, .checkBox, .link, .menuButton].contains(role) && !(v is NSButton))
            if pressable && !v.visibleRect.isEmpty {
                let label = v.accessibilityLabel() ?? (v as? NSButton)?.title ?? v.toolTip ?? ""
                let base = "\(type(of: v))|\(label)"
                let n = seen[base, default: 0]; seen[base] = n + 1
                out.append(("\(base)#\(n)", v))
                if v is NSButton { return }
            }
            v.subviews.forEach(walk)
        }
        walk(root)
        return out
    }
    private func picked(_ v: NSView) -> Bool {
        if v.isAccessibilitySelected() { return true }
        if let b = v.accessibilityValue() as? Bool { return b }
        if let n = v.accessibilityValue() as? NSNumber, v.accessibilityRole() == .radioButton { return n.boolValue }
        return false
    }

    /// A session in front (its panel), its project's brief, New session, Decisions and each page of the sidebar.
    private func sessionAndPages(_ clean: @escaping () -> Void) -> [(String, () -> NSView?)] {
        var out: [(String, () -> NSView?)] = []
        if let p = board.hub.state?.projects.first(where: { $0.id == "garden-planner" }) ?? board.hub.state?.projects.first(where: { !$0.sessions.isEmpty }), let s = p.sessions.first {
            let key = "\(p.id)/\(s.surfaceId)"
            out.append(("session panel", { clean(); self.board.toTerminal(); self.board.pickSession(key, why: "test"); self.settle(0.6); return self.board.panel }))
            out.append(("session middle", { clean(); self.board.toTerminal(); self.board.pickSession(key, why: "test"); self.settle(0.6); return self.board.root.middle }))
            out.append(("brief", { clean(); self.board.toTerminal(); self.board.openBrief(p.id); _ = self.wait(4) { self.board.root.middle === self.board.brief }; self.settle(0.5); return self.board.brief }))
        }
        out.append(("new session", { clean(); self.board.toTerminal(); self.board.openStart(nil); _ = self.wait(5) { self.board.start.controls["go"] != nil }; return self.board.start }))
        out.append(("decisions", { clean(); self.board.toTerminal(); self.board.openDecisions(); self.settle(1); return self.board.decisions }))
        for pg in board.hub.state?.pages ?? [] {
            out.append(("page \(pg.label)", { clean(); self.board.toTerminal(); self.board.openPage(pg.key, pg.label); self.settle(1.2); return self.board.root.middle }))
        }
        return out
    }

    /// The screens the first sweep left (sidetest's fixtures for --screen controls: the cards'
    /// checkpoints, notes-app's worktree and its files): the gallery's grid and one picture,
    /// an idea's thread, a plan's page, the review and its panel, the filmstrip, the picker
    /// and each kind of checkpoint card in the panel.
    private func moreScreens(_ clean: @escaping () -> Void) -> [(String, () -> NSView?)] {
        var out: [(String, () -> NSView?)] = []
        let b = board
        out.append(("gallery", { clean(); b.toTerminal(); b.openGallery("garden-planner", at: nil); _ = self.wait(4) { !b.gallery.cards.isEmpty }; self.settle(0.4); return b.gallery }))
        out.append(("gallery picture", { clean(); b.toTerminal(); b.openGallery("garden-planner", at: 0); _ = self.wait(5) { b.gallery.zoom.picture.image != nil }; self.settle(0.3); return b.gallery }))
        out.append(("idea", { clean(); b.toTerminal(); b.openPage("idea:demo-tidepool", t("idea.ideas"))
            // Finder's dialog for pictures is the Mac's: recorded, never shown off every screen.
            b.idea.choosePictures = { _, done in Outside.record?.append("choose pictures"); done([]) }
            _ = self.wait(5) { b.idea.ideas != nil && b.idea.busy.isEmpty }; self.settle(0.4); return b.idea }))
        out.append(("plan", { clean(); b.toTerminal(); b.openPlan("garden-planner", title: nil); _ = self.wait(4) { b.plan.buttons["pause"] != nil || b.plan.buttons["resume"] != nil }; self.settle(0.3); return b.plan }))
        // The review: notes-app's worktree session running in this window's daemon, done with its turn (as --screen review).
        let files = ProcessInfo.processInfo.environment["RAVENRY_MAC_FILES"].flatMap { try? Data(contentsOf: URL(fileURLWithPath: $0)) }
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        // A shell of its own (Discard this copy or Merge may close the session's pane), made again when gone.
        var reviewPane = ""
        let reviewState = {
            if let j = files, let path = j["path"] as? String, let answer = j["answer"] as? [String: Any] { b.hub.testAnswers[path] = answer }
            if !b.ws.tabs.contains(where: { $0.host == reviewPane }) {
                let before = Set(b.ws.tabs.map(\.host))
                b.ws.newTab(nil)
                reviewPane = b.ws.tabs.map(\.host).first { !before.contains($0) } ?? ""
            }
            let pane = reviewPane
            b.hub.testPatch = { st in
                var st = st
                var ps = st["projects"] as? [[String: Any]] ?? []
                for i in ps.indices where ps[i]["id"] as? String == "notes-app" {
                    var ss = ps[i]["sessions"] as? [[String: Any]] ?? []
                    if !ss.isEmpty { ss[0]["pane"] = pane; ss[0]["state"] = "idle" }
                    ps[i]["sessions"] = ss
                }
                st["projects"] = ps
                return st
            }
            b.hub.testCheckpoints = []
        }
        let reviewKey = { b.hub.state?.project("notes-app")?.sessions.first.map { "notes-app/\($0.surfaceId)" } ?? "" }
        // The review first: the panel's Merge and Discard this copy end the worktree it shows.
        out.append(("review", { clean(); reviewState(); b.toTerminal(); b.openReview(reviewKey()); _ = self.wait(6) { b.root.middle === b.review }; self.settle(0.8); return b.review }))
        out.append(("review panel", { clean(); reviewState(); b.toTerminal(); b.pickSession(reviewKey(), why: "test"); _ = self.wait(6) { b.worktrees.buttons["review"] != nil }; self.settle(0.4); return b.panel }))
        // The filmstrip of the shell in front, with something printed in its last 20 seconds.
        out.append(("filmstrip", { clean(); b.toTerminal()
            // A shell in front (a press before may have closed the last one).
            if b.ws.tabs.isEmpty { b.ws.newTab(nil); _ = self.wait(5) { b.ws.focusedView != nil } }
            if let t = b.ws.tabs.first, b.ws.active == nil { b.ws.show(t) }
            guard let fv = b.ws.focusedView else { return nil }
            b.ws.conn.request("pane.send", ["pane": fv.pane, "input": [["text": "echo film line", "mode": "paste"], ["key": "Enter"]]])
            self.settle(0.4)
            b.ws.film.testSaveDir = FileManager.default.temporaryDirectory.appendingPathComponent("ravenry-controls-gif")
            b.ws.toggleFilm()
            _ = self.wait(10) { b.ws.film.isOpen && !b.ws.film.loading }
            self.settle(0.3)
            return b.ws.film }))
        // The checkpoint cards (cards-fixture.mjs, the hub's words) and the picker of the pick.
        let cps = ProcessInfo.processInfo.environment["RAVENRY_MAC_CARDS"].flatMap { try? Data(contentsOf: URL(fileURLWithPath: $0)) }
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String: Any]] } ?? []
        for c in cps {
            let kind = c["kind"] as? String ?? "?", key = "\(c["projectId"] as? String ?? "")/\(c["surfaceId"] as? String ?? "")"
            out.append(("card \(kind)", { clean(); b.hub.testCheckpoints = cps; b.toTerminal(); b.pickSession(key, why: "test"); _ = self.wait(4) { b.panel.shownCard?.kind == kind }; self.settle(0.3); return b.panel }))
            if kind == "pick", let id = c["id"] as? String {
                out.append(("picker", { clean(); b.hub.testCheckpoints = cps; b.toTerminal(); b.openPicker(id); _ = self.wait(4) { b.root.middle === b.picker }; self.settle(0.6); return b.picker }))
            }
        }
        return out
    }

    func screenControls() {
        let sw = board.settings
        let hubHost = URL(string: board.hub.url).map { "\($0.host ?? ""):\($0.port ?? 0)" } ?? "-"
        func clean() {
            if board.phoneCard.isOpen { board.phoneCard.close() }
            if sw.window.isVisible { sw.window.orderOut(nil) }
            for w in NSApp.windows where w !== window && w !== sw.window && w.isVisible && w.attachedSheet == nil { _ = w }
            if let s = window.attachedSheet { window.endSheet(s) }
            // The window as it was: the sidebar and the panel shown (a press may fold either).
            if board.sideHidden { board.toggleSidebar() }
            if board.panelClosed { board.togglePanel() }
            // The fixtures a screen of the second sweep set (cards, the review's session), and its filmstrip.
            if board.hub.testPatch != nil || board.hub.testCheckpoints != nil { board.hub.testPatch = nil; board.hub.testCheckpoints = nil }
            if board.ws.film.isOpen { board.ws.film.close() }
        }
        let screens: [(String, () -> NSView?)] = [
            ("main", { clean(); self.board.toTerminal(); self.board.render(force: true); return self.window.contentView }),
            ("alerts", { clean(); self.board.openAlerts(); _ = self.wait(4) { self.board.alerts.setup != nil }; return self.board.alerts }),
            ("learn", { clean(); self.board.openLearn(); _ = self.wait(3) { self.board.learn.cardViews.count > 0 }; return self.board.learn }),
            ("machines", { clean(); self.board.openMachines(); _ = self.wait(4) { self.board.machines.loaded }; return self.board.machines }),
        ] + sessionAndPages(clean) + ["appearance", "behavior", "handoff", "skills"].map { tab in
            ("settings \(tab)", { clean(); self.board.toTerminal(); self.board.menuSettings(nil); _ = self.wait(3) { sw.window.isVisible }
                sw.tabButtons[tab]?.press(); self.settle(0.5); return sw.window.contentView })
        } + moreScreens(clean)
        var per: [String] = []
        var total = 0, quiet: [String] = [], browser: [String] = [], gone: [String] = [], pickedOnly = 0
        for (name, setup) in screens {
            guard let root0 = setup() else { check("controls_\(name)_root", false); continue }
            settle(0.4)
            let keys = pressables(root0).map(\.key)
            per.append("\(name) \(keys.count)")
            for k in keys {
                guard let root = setup() else { continue }
                settle(0.3)
                guard let v = pressables(root).first(where: { $0.key == k })?.view else { gone.append("\(name): \(k)"); continue }
                total += 1
                let was = world(), o = Outside.record?.count ?? 0
                let isPicked = picked(v)
                _ = v.accessibilityPerformPress()
                let changed = wait(1.2) { self.world() != was }
                let opened = (Outside.record ?? []).dropFirst(o).filter { $0.hasPrefix("open") && $0.contains(hubHost) }
                if !opened.isEmpty { browser.append("\(name): \(k) -> \(opened.joined(separator: ","))") }
                if !changed { if isPicked { pickedOnly += 1 } else { quiet.append("\(name): \(k)") } }
                // A sheet or menu a press left open goes, so the next press starts from the screen.
                if let s = window.attachedSheet { window.endSheet(s) }
                if let s = sw.window.attachedSheet { sw.window.endSheet(s) }
                _ = wait(3) { self.board.hub.inFlight == 0 }
            }
        }
        clean()
        board.toTerminal()
        check("controls_every_press_does_something", total > 90 && quiet.isEmpty, "\(total) pressed (\(pickedOnly) already picked), \(gone.count) gone after a reset (\(gone.joined(separator: ", "))); per screen \(per.joined(separator: ", ")); nothing came of: \(quiet.joined(separator: "; "))")
        check("controls_none_opens_the_board_in_the_browser", total > 90 && browser.isEmpty, browser.joined(separator: "; "))
        // Each screen had controls to press (a fixture missing would leave one out quietly).
        let empty = per.filter { $0.hasSuffix(" 0") }
        check("controls_every_screen_swept", empty.isEmpty && per.count == screens.count, "\(per.count) of \(screens.count) screens; none to press on: \(empty.joined(separator: ", "))")
    }
}
