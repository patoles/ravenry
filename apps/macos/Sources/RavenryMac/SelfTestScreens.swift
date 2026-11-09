// The self-test of the screens the middle shows besides a terminal
// (scripts/sidetest.mjs --screen NAME): one screen at a time, on the demo
// hub with its plan, its idea and the lighthouse project whose brief has
// every shape a brief takes (sidetest.mjs writes it). Each check drives the
// screen as the person would (a mouse press on a link, a button's click)
// and reads what it shows; each screen leaves pictures at 1280 and 900
// points, dark and light, beside the Electron app's of the same hub.

import AppKit

extension SelfTestBoard {
    func runScreen(_ name: String) {
        let hub = board.hub
        check("hub_state", wait(20) { (hub.state?.projects.count ?? 0) >= 5 }, hub.url)
        settle(0.6)
        switch name {
        case "brief": screenBrief()
        default: check("screen_known", false, name)
        }
        finish()
    }

    /// Pictures of what is in front at 1280 and 900, dark and light.
    func pictures(_ name: String) {
        for (w, h) in [(CGFloat(1280), CGFloat(820)), (900, 760)] {
            size(w, h)
            for dark in [true, false] {
                NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                settle(0.4)
                board.render(force: true)
                settle(0.4)
                picture("native-\(name)-\(Int(w))-\(dark ? "dark" : "light").png")
                if name == "brief" { check("brief_top_kept_\(Int(w))_\(dark ? "dark" : "light")", board.brief.scroll.contentView.bounds.origin.y == 0, "clip \(board.brief.scroll.contentView.bounds)") }
            }
        }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        size(1280, 820)
    }

    /// A mouse press and release at a point of a view.
    func click(_ v: NSView, at p: NSPoint, count: Int = 1) {
        let w = v.convert(p, to: nil)
        let ev = { (type: NSEvent.EventType) in NSEvent.mouseEvent(with: type, location: w, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                                   windowNumber: self.window.windowNumber, context: nil, eventNumber: 0, clickCount: count, pressure: 1) }
        // The release waits in the queue: a view that tracks the press (a
        // text view's link, a slider) reads it from there, as from the mouse.
        if let up = ev(.leftMouseUp) { NSApp.postEvent(up, atStart: false) }
        if let down = ev(.leftMouseDown) { window.sendEvent(down) }
        settle(0.2)
    }

    /// The middle of the text a text view draws for the first range of `s`.
    func point(of s: String, in tv: NSTextView) -> NSPoint? {
        let r = (tv.string as NSString).range(of: s)
        guard r.location != NSNotFound, let lm = tv.layoutManager, let tc = tv.textContainer else { return nil }
        let g = lm.glyphRange(forCharacterRange: NSRange(location: r.location, length: min(3, r.length)), actualCharacterRange: nil)
        let b = lm.boundingRect(forGlyphRange: g, in: tc)
        let o = tv.textContainerOrigin
        let pt = NSPoint(x: b.midX + o.x, y: b.midY + o.y)
        // As the person would: scrolled into view first.
        tv.scrollToVisible(NSRect(x: pt.x - 20, y: pt.y - 40, width: 40, height: 80))
        window.contentView?.layoutSubtreeIfNeeded()
        return pt
    }

    // MARK: the brief (BRIEF-002 to BRIEF-004)

    func screenBrief() {
        let bp = board.brief
        let k1 = "garden-planner/sf-1"
        if let r = board.sidebar.rows[k1] { click(r) }
        _ = wait(3) { self.board.panel.buttons["brief"] != nil }
        board.panel.buttons["brief"]?.performClick(nil)
        check("brief_opens_from_panel", board.front == .brief("garden-planner", k1) && board.root.middle === bp && board.root.panelMode == .docked && board.panel.key == k1, "\(board.front) \(board.root.panelMode)")
        check("brief_drawn", wait(5) { bp.shownText != nil } && bp.text.string.contains("Goal") && bp.text.string.contains("A planting calendar"), String(bp.text.string.prefix(80)))
        check("brief_plan_checklist", bp.text.string.contains("Plan  1 of 3") && bp.doc.boxes == ["x", " ", " "], "\(bp.doc.boxes)")
        check("brief_head_updated", bp.edit != nil)
        check("brief_at_top", bp.scroll.contentView.bounds.origin.y == 0 && bp.text.textContainerOrigin.y == 0 && bp.text.frame.minY == 0,
              "clip \(bp.scroll.contentView.bounds) origin \(bp.text.textContainerOrigin) frame \(bp.text.frame) scroll \(bp.scroll.frame) insets \(bp.scroll.contentInsets.top)")
        bp.edit?.performClick(nil)
        check("brief_edit_opens_file", Outside.record?.last?.hasSuffix("/garden-planner/BRIEF.md") ?? false, Outside.record?.last ?? "")
        check("brief_highlight_follows", board.sidebar.rows[k1]?.selected == true, "y \(bp.scroll.contentView.bounds.origin.y)")
        pictures("brief")

        // Every shape a brief takes: the lighthouse's.
        board.openPage("brief:lighthouse", t("panel.brief"))
        check("brief_rich_drawn", wait(5) { bp.shownText?.contains("# Lighthouse") ?? false }, bp.error ?? "")
        let s = bp.text.string
        check("brief_fields", s.hasPrefix("\nGoal") && s.contains("Done means"), String(s.prefix(60)))
        check("brief_checkbox_marks", bp.doc.boxes.sorted() == [" ", "-", ">", "?", "x"].sorted(), "\(bp.doc.boxes)")
        check("brief_code_block", s.contains("ravenryd serve --lamp 10s"))
        check("brief_nested_list", s.contains("The inner ring"))
        check("brief_entries", s.contains("split into 3 dated entries") && s.contains("2026-11-08"), "")
        let attrs = bp.text.textStorage.map { st in (0..<st.length).compactMap { st.attribute(.link, at: $0, effectiveRange: nil) as? String } } ?? []
        check("brief_links", attrs.contains("https://example.com/lamps") && attrs.contains { $0.hasPrefix("file://") && $0.hasSuffix("/lighthouse/notes/lamp.md") } && attrs.contains("https://example.org/tides") && !attrs.contains { $0.hasPrefix("rvn-entry") }, Set(attrs).sorted().joined(separator: " "))
        // A press on a link: the browser, recorded.
        let before = Outside.record?.count ?? 0
        if let p = point(of: "the lamp makers", in: bp.text) {
            let hit = window.contentView?.hitTest(window.contentView!.convert(bp.text.convert(p, to: nil), from: nil))
            check("brief_link_hit", hit === bp.text, "\(hit.map { String(describing: type(of: $0)) } ?? "nil") at \(p)")
            click(bp.text, at: p)
        }
        check("brief_link_opens", Outside.record?.dropFirst(before).contains("open https://example.com/lamps") ?? false, Outside.record?.suffix(2).joined(separator: ", ") ?? "")
        let b2 = Outside.record?.count ?? 0
        if let p = point(of: "mail the keeper", in: bp.text) { click(bp.text, at: p) }
        check("brief_other_scheme_never_opens", (Outside.record?.count ?? 0) == b2)
        // An entry opens with a press on its date; the newest was open.
        check("brief_newest_entry_open", bp.doc.open == [0])
        if let p = point(of: "2026-11-07", in: bp.text) { click(bp.text, at: p) }
        check("brief_entry_toggles", bp.doc.open == [0, 1], "\(bp.doc.open)")
        // Long words wrap: the text is never wider than its column.
        check("brief_no_sideways", bp.text.frame.width <= bp.scroll.contentSize.width + 0.5 && (bp.text.layoutManager?.usedRect(for: bp.text.textContainer!).width ?? 9999) <= 621, "\(bp.text.frame.width)")
        pictures("brief-rich")
        // Scrolled, words selected, an entry open: kept through the hub's refreshes.
        size(1280, 520)
        bp.scroll.contentView.scroll(to: NSPoint(x: 0, y: 120))
        bp.scroll.reflectScrolledClipView(bp.scroll.contentView)
        let sel = (bp.text.string as NSString).range(of: "rocks")
        bp.text.setSelectedRange(sel)
        let gen = board.hub.state.map { ObjectIdentifier($0) }
        _ = wait(12) { self.board.hub.state.map { ObjectIdentifier($0) } != gen }
        settle(5)
        board.render()
        settle(0.5)
        check("brief_kept_through_refresh", abs(bp.scroll.contentView.bounds.origin.y - 120) < 1 && bp.text.selectedRange() == sel && bp.doc.open == [0, 1],
              "y \(bp.scroll.contentView.bounds.origin.y) sel \(bp.text.selectedRange()) open \(bp.doc.open)")
        size(1280, 820)

        // A project with no brief: the hub's words, no crash.
        board.openPage("brief:old-notes", t("panel.brief"))
        check("brief_none", wait(5) { bp.error != nil } && bp.text.string == bp.error, bp.text.string)
        // A hub older than nextParts, updatedAt and by: drawn with what it has.
        bp.apply(200, ["text": "# Old\n\nGoal: Still drawn.\n\n## Next step\n2026-11-01: One. 2026-10-30: Two.\n", "file": "/nowhere/BRIEF.md"])
        check("brief_older_hub", bp.text.string.contains("Still drawn") && !bp.text.string.contains("dated entries"), String(bp.text.string.prefix(60)))
        // Back to the session: the tab strip's view closes.
        board.ws.bar.onClose?("view:brief")
        check("brief_closes", board.root.middle == nil && board.front == .tab, "\(board.front)")
    }
}
