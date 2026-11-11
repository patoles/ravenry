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
        case "gallery": screenGallery()
        case "plan": screenPlan()
        case "idea": screenIdea()
        case "alerts": screenAlerts()
        case "pages": screenPages()
        case "decisions": screenDecisions()
        case "settings": screenSettings()
        case "learn": screenLearn()
        case "machines": screenMachines()
        case "phone": screenPhone()
        case "terminal": screenTerminal()
        case "cards": screenCards()
        case "panes": screenPanes()
        case "strip": screenStrip()
        case "startlocal": screenStartLocal()
        case "tabmarks": screenTabMarks()
        case "review": screenReview()
        case "window": screenWindow()
        case "start": screenStart()
        case "daemons": screenDaemons()
        case "sessions": screenSessions()
        case "panel": screenPanel()
        case "nav": screenNav()
        case "windows": screenWindows()
        case "updates": screenUpdates()
        case "links": screenLinks()
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
                // No words squeezed into a column (a wrapping label laid out narrow and kept so).
                let sq = squeezed(window.contentView!)
                check("\(name)_no_squeezed_text_\(Int(w))_\(dark ? "dark" : "light")", sq.isEmpty, sq.prefix(4).joined(separator: " | "))
                if name == "brief" { check("brief_top_kept_\(Int(w))_\(dark ? "dark" : "light")", board.brief.scroll.contentView.bounds.origin.y == 0, "clip \(board.brief.scroll.contentView.bounds)") }
            }
        }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        size(1280, 820)
    }

    /// The words shown in a field narrower than 80 pt while holding more
    /// than 10 characters that do not fit it on one line and are cut inside
    /// a word or set a word a line (a wrapping label squeezed).
    func squeezed(_ v: NSView) -> [String] {
        var out: [String] = []
        func walk(_ x: NSView) {
            if x.isHidden || x.alphaValue == 0 { return }
            // Narrow, and not room for its words on one line (wrapped or cut).
            if let f = x as? NSTextField, !f.isEditable, f.stringValue.count > 10, f.frame.width < 80,
               let one = f.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)), one.width > f.frame.width + 2,
               squeezedWords(f, lineHeight: one.height) {
                out.append("\(f.stringValue.prefix(30)) (\(Int(f.frame.width)) pt)")
            }
            for s in x.subviews { walk(s) }
        }
        walk(v)
        return out
    }

    /// A word cut across lines, or a word a line: what a squeezed field
    /// shows (two words a line, as the Electron app wraps "6 decisions, 1
    /// replaced" at 900, is not one).
    private func squeezedWords(_ f: NSTextField, lineHeight: CGFloat) -> Bool {
        let words = f.stringValue.split(whereSeparator: { $0.isWhitespace })
        let font = f.font ?? Fonts.pt(13)
        let widest = words.map { (String($0) as NSString).size(withAttributes: [.font: font]).width }.max() ?? 0
        let lines = Int((f.frame.height / max(1, lineHeight)).rounded())
        return widest > f.frame.width + 1 || (words.count >= 3 && lines >= words.count)
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
            let hit = window.contentView?.hitTest(window.contentView!.superview!.convert(bp.text.convert(p, to: nil), from: nil))
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
        // Where it was opened from (Board's back stack): the session k1 (its view, or its tab when this window has its pane);
        // the brief of old-notes took the first brief's place, so it does not come back.
        check("brief_closes", board.root.middle !== bp && (board.front == .session(k1) || (board.front == .tab && board.frontKey == k1)), "\(board.front)")

        // A Plan task's box ticks it in the brief (POST /api/brief/tick), drawn ticked when the hub reads it again.
        board.openPage("brief:lighthouse", t("panel.brief"))
        _ = wait(5) { bp.doc.planTasks.contains { $0.text == "Test at dusk" } }
        if let n = bp.doc.planTasks.firstIndex(where: { $0.text == "Test at dusk" }) {
            let sent = board.hub.sent.count
            _ = bp.textView(bp.text, clickedOnLink: "rvn-task:\(n)", at: 0)
            check("brief_task_ticks", wait(8) { self.board.hub.sent.dropFirst(sent).contains("POST /api/brief/tick") } && wait(10) { bp.doc.planTasks.first { $0.text == "Test at dusk" }?.done == true },
                  "\(bp.ticked) \(bp.tickError ?? "-") \(bp.doc.planTasks.map { "\($0.text)=\($0.done)" })")
        } else { check("brief_task_ticks", false, "\(bp.doc.planTasks.map { $0.text })") }
    }

    // MARK: the gallery and one picture large (PIC-001, PIC-002)

    func screenGallery() {
        let g = board.gallery
        let k1 = "garden-planner/sf-1"
        if let r = board.sidebar.rows[k1] { click(r) }
        _ = wait(5) { self.board.panel.pictureView != nil }
        if let pv = board.panel.pictureView { click(pv) }
        check("gallery_from_panel_picture", board.front == .page("gallery:garden-planner", t("gallery.title")) && g.at == 0 && board.root.middle === g && board.root.wideMiddle && board.root.panelMode == .hidden,
              "\(board.front) at \(String(describing: g.at)) \(board.root.panelMode)")
        check("gallery_list_from_hub", g.pics.count == 2 && g.pics[0].key != nil && g.pics[1].fromBrief, g.pics.map { "\($0.name) \($0.key ?? "-")" }.joined(separator: ", "))
        check("picture_loaded_fitted", wait(5) { g.zoom.picture.image != nil } && abs(g.zoom.magnification - g.zoom.fit) < 0.001, "mag \(g.zoom.magnification) fit \(g.zoom.fit)")
        check("picture_prev_off_at_first", g.buttons["previous"]?.isEnabled == false && g.buttons["next"]?.isEnabled == true)
        g.buttons["next"]?.performClick(nil)
        check("picture_next", g.at == 1 && g.buttons["next"]?.isEnabled == false && g.buttons["reveal"] == nil, "at \(String(describing: g.at))")
        g.buttons["previous"]?.performClick(nil)
        check("picture_previous", g.at == 0)
        if g.thumbs.count == 2 { click(g.thumbs[1]) }
        check("picture_strip", g.at == 1, "at \(String(describing: g.at))")
        if g.thumbs.count == 2 { click(g.thumbs[0]) }
        g.buttons["reveal"]?.performClick(nil)
        check("picture_show_in_finder", wait(5) { self.board.hub.sent.contains("POST /api/project/reveal-picture") }, board.hub.sent.suffix(2).joined(separator: ", "))
        settle(0.5)
        pictures("picture")
        // A click zooms in around the point clicked; the point stays under the pointer.
        size(1280, 820)
        _ = wait(3) { g.zoom.picture.image != nil }
        let z = g.zoom
        let vp = NSPoint(x: z.bounds.width * 0.5 + 60, y: z.bounds.height * 0.5 - 30)
        let inPic = z.picture.convert(z.convert(vp, to: z.picture.superview), from: z.picture.superview)
        _ = inPic
        let docBefore = z.contentView.convert(z.convert(vp, to: z.contentView), to: z.picture)
        let hv = window.contentView!.hitTest(window.contentView!.superview!.convert(z.convert(vp, to: nil), from: nil))
        check("picture_hit", hv === z.picture, "\(hv.map { String(describing: type(of: $0)) } ?? "nil") pic \(z.picture.frame) clip \(z.contentView.bounds)")
        click(z, at: vp)
        settle(0.3)
        let docAfter = z.contentView.convert(z.convert(vp, to: z.contentView), to: z.picture)
        check("picture_click_zooms_in", z.zoomed, "mag \(z.magnification) fit \(z.fit)")
        check("picture_zoom_keeps_point", abs(docAfter.x - docBefore.x) < 2 && abs(docAfter.y - docBefore.y) < 2, "\(docBefore) to \(docAfter)")
        check("picture_pinch_and_pan", z.allowsMagnification && z.maxMagnification >= z.fit * 5.9 && z.hasHorizontalScroller, "max \(z.maxMagnification)")
        // Zoomed and moved: kept through the hub's refreshes.
        z.contentView.scroll(to: NSPoint(x: z.contentView.bounds.origin.x + 10, y: z.contentView.bounds.origin.y))
        let m0 = z.magnification, o0 = z.contentView.bounds.origin
        let gen = board.hub.state.map { ObjectIdentifier($0) }
        _ = wait(12) { self.board.hub.state.map { ObjectIdentifier($0) } != gen }
        settle(2.5)
        board.render()
        settle(0.3)
        check("picture_zoom_kept_through_refresh", z.magnification == m0 && z.contentView.bounds.origin == o0, "mag \(m0) to \(z.magnification), \(o0) to \(z.contentView.bounds.origin)")
        pictures("picture-zoomed")
        click(z, at: vp)
        check("picture_click_fits_again", !z.zoomed)
        // Back to the grid: the picture it came from ringed.
        g.buttons["back"]?.performClick(nil)
        check("gallery_back_to_grid", g.at == nil && g.lit == 0 && g.cards.count == 2 && !z.isHidden == false)
        settle(0.4)
        pictures("gallery")
        if g.cards.count == 2 { click(g.cards[1]) }
        check("gallery_card_opens", g.at == 1)
        g.closeButton.performClick(nil)
        check("gallery_close_goes_back", board.front == .session(k1) || (board.front == .tab && board.frontKey == k1), "\(board.front)")
        // No pictures: said so.
        board.openGallery("old-notes", at: 0)
        check("gallery_empty", g.at == nil && g.pics.isEmpty && g.cards.isEmpty)
        pictures("gallery-empty")
        // A hub older than brief.gallery: its pictures as they come.
        let old = HubProject(["id": "x", "name": "x", "brief": ["pictures": [["path": "~/x/a.png", "url": "/a", "auto": true], ["path": "~/x/b.png", "alt": "B", "url": "/b"], ["path": "~/x/c.png"]]]])
        let ol = GalleryPic.of(old)
        check("gallery_older_hub", ol.map { $0.name } == ["a.png", "B"] && !ol[0].fromBrief && ol[1].fromBrief, ol.map { $0.name }.joined(separator: ","))
        g.closeButton.performClick(nil)
        screenGalleryMore()
    }
}
