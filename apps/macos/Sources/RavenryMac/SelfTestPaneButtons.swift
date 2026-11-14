// The pane buttons and splits of splits (sidetest.mjs --screen
// panebuttons): every pane's header, a pane alone in its tab too, with
// Split right, Split down, Move to its own tab, Zoom and Close at its right.
// Each button is pressed as the person presses it (a mouse press and
// release through the window at its middle) and its effect is read where
// it lands: the tab's tree of panes, the frames drawn, the daemon's panes
// and their folders, the keyboard. Then the same with the keys, a split
// the minimum size refuses (the reason in the button's tip), a tab dropped
// onto a pane of a split, and pictures at 1280, dark and light: one pane,
// a split, a nested split, zoomed, a button's tip.

import AppKit

extension SelfTestBoard {
    private func daemonPanes() -> [String: [String: Any]] {
        guard let r = try? board.ws.conn.call("pane.list", ["hidden": true], timeout: 3) else { return [:] }
        var out: [String: [String: Any]] = [:]
        for p in r["panes"] as? [[String: Any]] ?? [] where (p["state"] as? String ?? "running") == "running" {
            if let id = p["id"] as? String { out[id] = p }
        }
        return out
    }

    /// A pane's frame in the window's content (y down).
    private func frameOf(_ p: String) -> NSRect {
        guard let b = board.ws.boxes[p], b.window != nil, let root = window.contentView else { return .zero }
        let r = b.convert(b.bounds, to: nil)
        return NSRect(x: r.minX, y: root.bounds.height - r.maxY, width: r.width, height: r.height)
    }

    private func headOf(_ p: String) -> PaneHead? { board.ws.boxes[p]?.headView }

    /// A check, also in the app's log as it happens (a run that stops midway still says how far it got).
    private func pbCheck(_ name: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
        let d = detail()
        NSLog("panebuttons: \(ok ? "pass" : "FAIL") \(name) \(ok ? "" : d)")
        check(name, ok, d)
    }

    /// A key as the menu takes it (the Shell menu's equivalents).
    private func menuKey(_ chars: String, _ mods: NSEvent.ModifierFlags) -> Bool { key(chars, mods) }
    private func arrow(_ k: Int) -> String { String(UnicodeScalar(k)!) }

    /// Pictures at 1280, dark and light, with views over the terminal drawn on top (a tip).
    private func pictures1280(_ name: String, over: @escaping () -> [NSView] = { [] }) {
        size(1280, 820)
        for dark in [true, false] {
            NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            settle(0.4)
            board.render(force: true)
            settle(0.4)
            for b in board.ws.boxes.values { b.headView.needsDisplay = true; b.headView.buttons.forEach { $0.needsDisplay = true } }
            settle(0.1)
            pictureOver("native-panebuttons-\(name)-1280-\(dark ? "dark" : "light").png", over())
        }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        settle(0.3)
    }

    func screenPaneButtons() {
        let ws = board.ws
        guard wait(10, { ws.active != nil }) else { pbCheck("pb_first_tab", false); return }
        size(1280, 820)
        // A folder for the shells, so a split's folder can be told from home.
        let shop = (ws.home as NSString).appendingPathComponent("kite-shop")
        try? FileManager.default.createDirectory(atPath: shop, withIntermediateDirectories: true)
        // As the Shell menu's New Shell does: the terminal in front of any page.
        board.tabCommand("new shell") { $0.newTab(in: shop) }
        guard wait(5, { ws.active.map { ws.paneInfo($0.host)?.cwd == shop } ?? false }), let tab = ws.active else { pbCheck("pb_tab_in_folder", false); return }
        let p0 = tab.host
        board.render(force: true)
        settle(0.5)

        // One pane: its header, the five buttons, the last three greyed with why.
        guard let h0 = headOf(p0) else { pbCheck("pb_one_head", false); return }
        pbCheck("pb_one_pane_head", !h0.isHidden && h0.frame.height == Design.headHeight && h0.window != nil && ws.boxes[p0]?.showsHead == true
              && h0.buttons.map(\.kind) == ["splitRight", "splitDown", "ownTab", "zoom", "close"], "\(h0.frame) \(h0.buttons.map(\.kind))")
        pbCheck("pb_one_pane_buttons_state", h0.splitRight.enabled && h0.splitDown.enabled && !h0.ownTab.enabled && !h0.zoom.enabled && !h0.close.enabled,
              h0.buttons.map { "\($0.kind) \($0.enabled)" }.joined(separator: ", "))
        pbCheck("pb_tips", h0.splitRight.toolTip == "Split right (⌘D)" && h0.splitDown.toolTip == "Split down (⇧⌘D)"
              && h0.zoom.toolTip == "Zoom pane (⇧⌘↩)\nIt is the only pane in this tab" && h0.close.toolTip == "Close pane (⌘W)\nIt is the only pane in this tab"
              && h0.ownTab.toolTip == "Move to its own tab\nIt is the only pane in this tab",
              h0.buttons.map { $0.toolTip ?? "-" }.joined(separator: " | "))
        pbCheck("pb_a11y_labels", h0.buttons.map { $0.accessibilityLabel() ?? "" } == ["Split right", "Split down", "Move to its own tab", "Zoom pane", "Close pane"]
              && h0.buttons.allSatisfy { $0.accessibilityRole() == .button } && h0.close.isAccessibilityEnabled() == false,
              h0.buttons.map { $0.accessibilityLabel() ?? "-" }.joined(separator: ", "))
        // Greyed buttons do nothing: a press on each leaves the tab, the pane and the zoom as they were.
        let tabs0 = ws.tabs.count, d0 = Set(daemonPanes().keys)
        for b in [h0.ownTab, h0.zoom, h0.close] { click(b) }
        settle(0.3)
        pbCheck("pb_greyed_do_nothing", ws.tabs.count == tabs0 && tab.count == 1 && !tab.zoom && Set(daemonPanes().keys) == d0 && [h0.ownTab, h0.zoom, h0.close].allSatisfy { $0.presses == 0 },
              "tabs \(ws.tabs.count) panes \(tab.count) zoom \(tab.zoom)")
        // The hover: its fill and the tip, in the pictures.
        h0.splitRight.hover = true
        let tip0 = TipView(h0.splitRight)
        pictures1280("one", over: { [tip0.place(in: ws.stage)] })
        tip0.removeFromSuperview()
        h0.splitRight.hover = false

        // Split right, pressed in the header: a shell on the right, in the pane's folder, with the keyboard.
        click(h0.splitRight)
        let hitAt = h0.splitRight.convert(NSPoint(x: 11, y: 11), to: nil)
        let hitV = window.contentView.flatMap { cv in cv.hitTest(cv.superview?.convert(hitAt, from: nil) ?? hitAt) }
        var chain: [String] = []
        var hv = hitV
        while let x = hv { chain.append("\(type(of: x))\(x.frame)"); hv = x.superview }
        let hit: String? = chain.joined(separator: " < ") + " btn \(h0.splitRight.frame) head \(h0.frame) term \(ws.boxes[p0]?.term.frame ?? .zero) at \(hitAt)"
        pbCheck("pb_split_right", wait(5) { tab.count == 2 } && tab.root.across && tab.root.first?.pane == p0,
                "\(tab.root.shape) hit \(hit ?? "none") refused \(ws.splitsRefused) presses \(h0.splitRight.presses) front \(board.front) middle \(String(describing: board.root.middle))")
        let p1 = tab.leaves.last ?? ""
        _ = wait(3) { self.frameOf(p1).width > 0 }
        let f0 = frameOf(p0), f1 = frameOf(p1)
        pbCheck("pb_split_right_place", f1.minX >= f0.maxX + Design.gutter - 0.5 && abs(f1.minY - f0.minY) < 1 && abs(f1.width - f0.width) <= 1, "\(f0) \(f1)")
        pbCheck("pb_split_right_daemon_folder", wait(5) { self.daemonPanes()[p1]?["cwd"] as? String == shop }, "\(daemonPanes()[p1]?["cwd"] ?? "none")")
        pbCheck("pb_split_keyboard", tab.focusedPane == p1 && window.firstResponder === ws.boxes[p1]?.term)
        // Now each pane's own tab, zoom and close are live.
        board.render(force: true)
        guard let h1 = headOf(p1) else { pbCheck("pb_split_head", false); return }
        pbCheck("pb_split_buttons_live", [h0, h1].allSatisfy { $0.ownTab.enabled && $0.zoom.enabled && $0.close.enabled }
              && ws.boxes[p0]?.inSplit == true && ws.boxes[p1]?.inFocus == true, [h0, h1].map { $0.buttons.map { "\($0.kind) \($0.enabled)" }.joined(separator: " ") }.joined(separator: " / "))
        pbCheck("pb_strip_count_2", ws.bar.items.first { $0.model.id == tab.id }?.model.count == 2)
        pictures1280("split")

        // Split down in the right pane's header: nested, three panes.
        click(h1.splitDown)
        pbCheck("pb_split_down_nested", wait(5) { tab.count == 3 }, tab.root.shape)
        let p2 = tab.leaves.first { ![p0, p1].contains($0) } ?? ""
        _ = wait(3) { self.frameOf(p2).width > 0 }
        let g1 = frameOf(p1), g2 = frameOf(p2)
        pbCheck("pb_split_down_place", tab.root.shape == "(| \(p0) (- \(p1) \(p2)))" && g2.minY >= g1.maxY + Design.gutter - 0.5 && abs(g2.minX - g1.minX) < 1
              && abs(g2.width - g1.width) < 1 && daemonPanes()[p2] != nil, "\(tab.root.shape) \(g1) \(g2)")
        // And Split down in the left pane's: four, two by two.
        click(h0.splitDown)
        pbCheck("pb_split_four", wait(5) { tab.count == 4 }, tab.root.shape)
        let p3 = tab.leaves.first { ![p0, p1, p2].contains($0) } ?? ""
        _ = wait(3) { self.frameOf(p3).width > 0 }
        let fr = [p0, p1, p2, p3].map(frameOf)
        pbCheck("pb_four_grid", tab.root.shape == "(| (- \(p0) \(p3)) (- \(p1) \(p2)))" && abs(fr[3].minX - fr[0].minX) < 1 && fr[3].minY >= fr[0].maxY && fr[1].minX >= fr[0].maxX
              && Set([p0, p1, p2, p3]).isSubset(of: Set(daemonPanes().keys)) && fr.allSatisfy { $0.width >= Design.paneMin && $0.height >= Design.paneMin },
              "\(tab.root.shape) \(fr)")
        pbCheck("pb_strip_count_4", ws.bar.items.first { $0.model.id == tab.id }?.model.count == 4)
        pictures1280("nested")
        // Kept: the tree in window.json, the one split the Electron app reads beside it.
        ws.save()
        ws.flush()
        let file = ws.layoutURL.flatMap { try? Data(contentsOf: $0) }.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any] ?? [:]
        let tr = (file["trees"] as? [[String: Any]] ?? []).first { $0["host"] as? String == tab.id }
        let restored = PaneNode.from(saved: tr?["tree"], have: { _ in true })
        pbCheck("pb_tree_saved", restored?.shape == tab.root.shape && (file["splits"] as? [[String: Any]] ?? []).contains { $0["host"] as? String == tab.id && $0["guest"] as? String == tr?["guest"] as? String },
              "\(tr ?? [:])")

        // Zoom, pressed in the bottom right pane's header: that pane alone, the button lit, "4 of 4"; again: every pane.
        guard let h2 = headOf(p2) else { pbCheck("pb_nested_head", false); return }
        click(h2.zoom)
        let zoomed = wait(3) { tab.zoom } && tab.focusedPane == p2 && ws.boxes[p2]?.window != nil && [p0, p1, p3].allSatisfy { ws.boxes[$0]?.window == nil }
        board.render(force: true)
        pbCheck("pb_zoom", zoomed && h2.zoom.on && h2.zoom.toolTip == "Show all panes (⇧⌘↩)" && h2.zoomChip == "4 of 4" && abs(frameOf(p2).width - ws.stage.bounds.width) < 1,
              "zoom \(tab.zoom) on \(h2.zoom.on) tip \(h2.zoom.toolTip ?? "") chip \(h2.zoomChip ?? "-")")
        h2.zoom.hover = true
        let tipZ = TipView(h2.zoom)
        pictures1280("zoomed", over: { [tipZ.place(in: ws.stage)] })
        tipZ.removeFromSuperview()
        h2.zoom.hover = false
        click(h2.zoom)
        pbCheck("pb_zoom_back", wait(3) { !tab.zoom } && [p0, p1, p2, p3].allSatisfy { ws.boxes[$0]?.window != nil } && !h2.zoom.on && h2.zoomChip == nil)

        // The keys do the same. Cmd+Option+arrows: the keyboard to the pane that way.
        ws.focusPane(tab, p2)
        _ = menuKey(arrow(NSLeftArrowFunctionKey), [.command, .option])
        let k1 = tab.focusedPane
        _ = menuKey(arrow(NSUpArrowFunctionKey), [.command, .option])
        let k2 = tab.focusedPane
        _ = menuKey(arrow(NSRightArrowFunctionKey), [.command, .option])
        let k3 = tab.focusedPane
        _ = menuKey(arrow(NSDownArrowFunctionKey), [.command, .option])
        let k4 = tab.focusedPane
        pbCheck("pb_keys_focus_arrows", k1 == p3 && k2 == p0 && k3 == p1 && k4 == p2 && window.firstResponder === ws.boxes[p2]?.term, "\([k1, k2, k3, k4]) want \([p3, p0, p1, p2])")
        // Cmd+Shift+Enter: zoom and back.
        _ = menuKey("\r", [.command, .shift])
        let kz = tab.zoom && tab.focusedPane == p2
        _ = menuKey("\r", [.command, .shift])
        pbCheck("pb_keys_zoom", kz && !tab.zoom)
        // Cmd+D in the bottom right pane: a fifth pane right of it, while each half keeps 160 pt.
        let before = Set(daemonPanes().keys)
        _ = menuKey("d", .command)
        pbCheck("pb_keys_split_right", wait(5) { tab.count == 5 }, tab.root.shape)
        let p4 = tab.focusedPane
        _ = wait(3) { self.frameOf(p4).width > 0 }
        pbCheck("pb_keys_split_right_place", tab.root.node(of: p2)?.parent?.shape == "(| \(p2) \(p4))" && !before.contains(p4) && daemonPanes()[p4] != nil && frameOf(p4).width >= Design.paneMin,
              "\(tab.root.shape) \(frameOf(p4))")
        // Again: the new pane is too narrow to halve (each half under 160 pt): refused, the reason in the button's tip.
        let w4 = frameOf(p4).width
        let refusedBefore = ws.splitsRefused.count, d4 = Set(daemonPanes().keys)
        _ = menuKey("d", .command)
        board.render(force: true)
        guard let h4 = headOf(p4) else { pbCheck("pb_fifth_head", false); return }
        pbCheck("pb_min_size_refuses", w4 < 2 * Design.paneMin + Design.gutter && tab.count == 5 && ws.splitsRefused.count == refusedBefore + 1 && Set(daemonPanes().keys) == d4
              && !h4.splitRight.enabled && h4.splitRight.toolTip == "Split right (⌘D)\nToo narrow to split: each pane needs at least 160 points across",
              "width \(w4) panes \(tab.count) refused \(ws.splitsRefused.suffix(1)) tip \(h4.splitRight.toolTip ?? "")")
        // Its greyed Split right pressed: nothing either.
        click(h4.splitRight)
        pbCheck("pb_min_size_button_does_nothing", tab.count == 5 && h4.splitRight.presses == 0 && Set(daemonPanes().keys) == d4)
        h4.splitRight.hover = true
        let tipN = TipView(h4.splitRight)
        pictures1280("too-narrow", over: { [tipN.place(in: ws.stage)] })
        tipN.removeFromSuperview()
        h4.splitRight.hover = false
        // The pane's right click offers the same (its Split Right greyed, Move to Own Tab live).
        guard let t4 = ws.boxes[p4]?.term else { pbCheck("pb_fifth_term", false); return }
        let menu = t4.contextMenu(at: t4.convert(NSPoint(x: 20, y: 20), to: nil))
        let items = Dictionary(menu.items.map { ($0.title, $0.isEnabled) }, uniquingKeysWith: { a, _ in a })
        pbCheck("pb_context_menu", items["Split Right"] == false && items["Move to Own Tab"] == true, "\(items)")
        // Cmd+W: the focused pane and its daemon pane go; the other part of its split takes the space.
        let r2 = frameOf(p2)
        _ = menuKey("w", .command)
        pbCheck("pb_keys_close", wait(5) { tab.count == 4 && self.daemonPanes()[p4] == nil } && tab.focusedPane == p2 && frameOf(p2).width > r2.width + Design.paneMin - 1,
              "\(tab.root.shape) \(r2) -> \(frameOf(p2))")
        // Cmd+Shift+D in the bottom right pane: below it.
        _ = menuKey("D", [.command, .shift])
        pbCheck("pb_keys_split_down", wait(5) { tab.count == 5 } && tab.root.node(of: p2)?.parent?.across == false, tab.root.shape)
        let p5 = tab.focusedPane
        _ = menuKey("w", .command)
        _ = wait(5) { tab.count == 4 && self.daemonPanes()[p5] == nil }

        // Move to its own tab, pressed in the bottom right pane's header: a tab of its own right after, in front; the source one pane fewer.
        let ti = ws.tabs.firstIndex { $0 === tab } ?? -1
        guard let own2 = headOf(p2)?.ownTab else { pbCheck("pb_own_head", false); return }
        click(own2)
        let own = ws.active
        pbCheck("pb_own_tab", wait(3) { tab.count == 3 } && own !== tab && own?.leaves == [p2] && ws.tabs.firstIndex { $0 === own } == ti + 1
              && tab.root.shape == "(| (- \(p0) \(p3)) \(p1))" && daemonPanes()[p2] != nil && window.firstResponder === ws.boxes[p2]?.term,
              "\(tab.root.shape) own \(own?.leaves ?? [])")
        // Its own tab's buttons: alone again.
        board.render(force: true)
        pbCheck("pb_own_tab_alone", headOf(p2)?.ownTab.enabled == false && headOf(p2)?.splitRight.enabled == true)
        // Through the Shell menu: Move Pane to Own Tab, on the split tab's pane with the keyboard.
        ws.show(tab)
        ws.focusPane(tab, p3)
        let item = Workspace.menuItem(NSApp.mainMenu, action: "menuOwnTab:")
        if let i = item, let a = i.action { NSApp.sendAction(a, to: i.target, from: i) }
        settle(0.3)
        pbCheck("pb_menu_own_tab", item?.title == "Move Pane to Own Tab" && tab.count == 2 && ws.active?.leaves == [p3] && tab.root.shape == "(| \(p0) \(p1))", "\(tab.root.shape)")

        // A tab dropped onto a pane of a split: that pane splits with it (here the left pane's bottom edge).
        ws.show(tab)
        board.render(force: true)
        settle(0.3)
        guard let moving = ws.tabs.first(where: { $0.leaves == [p3] }) else { pbCheck("pb_drop_setup", false); return }
        guard let b0 = ws.boxes[p0] else { pbCheck("pb_drop_box", false); return }
        let wp = b0.convert(NSPoint(x: b0.bounds.midX, y: b0.bounds.height - 30), to: nil)
        ws.dragOver(moving.id, wp)
        pbCheck("pb_drop_zone_on_pane", ws.dropZone.superview === ws.stage && ws.dropZone.side == "down" && !ws.dropZone.refused && ws.dropZone.words == "Split bottom"
              && abs(ws.dropZone.frame.width - b0.frame.width) < 1, "\(ws.dropZone.side) \(ws.dropZone.words) \(ws.dropZone.frame)")
        let dropped = ws.dropTab(moving.id, wp)
        pbCheck("pb_drop_splits_pane", dropped && tab.root.shape == "(| (- \(p0) \(p3)) \(p1))" && !ws.tabs.contains { $0 === moving } && tab.focusedPane == p3, tab.root.shape)

        // Close, pressed in a header: the pane and its daemon pane go, the other part takes its place.
        let r0 = frameOf(p0)
        guard let close3 = headOf(p3)?.close else { pbCheck("pb_close_head", false); return }
        click(close3)
        pbCheck("pb_close_button", wait(5) { tab.count == 2 && self.daemonPanes()[p3] == nil } && frameOf(p0).height > r0.height + 100 && tab.root.shape == "(| \(p0) \(p1))",
              "\(tab.root.shape) \(r0) -> \(frameOf(p0))")
        // The tab of the moved pane, closed with its x: gone with its pane.
        if let t2 = ws.tabs.first(where: { $0.leaves == [p2] }) { ws.closeTab(t2) }
        pbCheck("pb_cleanup", wait(5) { self.daemonPanes()[p2] == nil })
    }
}

/// A button's tip as macOS shows it under the pointer, drawn into the
/// pictures only (a real tip is a window of its own, which a picture of
/// the window leaves out): its words, the reason on a second line.
final class TipView: NSView {
    let lines: [String]
    weak var anchor: NSView?
    init(_ b: NSView) {
        lines = (b.toolTip ?? "").components(separatedBy: "\n")
        anchor = b
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    /// Under its button, inside the stage.
    func place(in stage: NSView) -> NSView {
        guard let a = anchor else { return self }
        let font = NSFont.systemFont(ofSize: 11)
        let w = ceil(lines.map { ($0 as NSString).size(withAttributes: [.font: font]).width }.max() ?? 0) + 14
        let h = CGFloat(lines.count) * 14 + 8
        let r = a.convert(a.bounds, to: stage)
        let x = min(max(4, r.minX), stage.bounds.width - w - 4)
        frame = NSRect(x: x, y: r.maxY + 6, width: w, height: h)
        if superview !== stage { stage.addSubview(self) }
        needsDisplay = true
        return self
    }

    override func draw(_ dirty: NSRect) {
        let dark = Workspace.dark
        (dark ? NSColor(srgbRed: 0x2C / 255, green: 0x2C / 255, blue: 0x2F / 255, alpha: 1) : NSColor(srgbRed: 0xF5 / 255, green: 0xF5 / 255, blue: 0xF4 / 255, alpha: 1)).setFill()
        let p = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 5, yRadius: 5)
        p.fill()
        (dark ? NSColor(white: 1, alpha: 0.16) : NSColor(white: 0, alpha: 0.16)).setStroke()
        p.lineWidth = 0.5
        p.stroke()
        for (i, l) in lines.enumerated() {
            let c = i == 0 ? (dark ? NSColor(srgbRed: 0xEC / 255, green: 0xEC / 255, blue: 0xEE / 255, alpha: 1) : NSColor(srgbRed: 0x1D / 255, green: 0x1D / 255, blue: 0x1F / 255, alpha: 1))
                : (dark ? NSColor(srgbRed: 0xA1 / 255, green: 0xA1 / 255, blue: 0xA8 / 255, alpha: 1) : NSColor(srgbRed: 0x5F / 255, green: 0x5F / 255, blue: 0x66 / 255, alpha: 1))
            (l as NSString).draw(at: NSPoint(x: 7, y: 4 + CGFloat(i) * 14), withAttributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: c])
        }
    }
}
