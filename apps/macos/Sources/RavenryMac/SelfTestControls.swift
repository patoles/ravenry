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
        }
        let screens: [(String, () -> NSView?)] = [
            ("main", { clean(); self.board.toTerminal(); self.board.render(force: true); return self.window.contentView }),
            ("alerts", { clean(); self.board.openAlerts(); _ = self.wait(4) { self.board.alerts.setup != nil }; return self.board.alerts }),
            ("learn", { clean(); self.board.openLearn(); _ = self.wait(3) { self.board.learn.cardViews.count > 0 }; return self.board.learn }),
            ("machines", { clean(); self.board.openMachines(); _ = self.wait(4) { self.board.machines.loaded }; return self.board.machines }),
        ] + sessionAndPages(clean) + ["appearance", "behavior", "handoff", "skills"].map { tab in
            ("settings \(tab)", { clean(); self.board.toTerminal(); self.board.menuSettings(nil); _ = self.wait(3) { sw.window.isVisible }
                sw.tabButtons[tab]?.press(); self.settle(0.5); return sw.window.contentView })
        }
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
    }
}
