// The pointer over the window, read from the cursor rects every view gives
// AppKit (Cursors.swift): each view is asked for them again while
// NSView.addCursorRect is recorded, AppKit's own text fields and text views
// included. At a point, the rects of the view the press goes to (hitTest)
// and of its superviews say the pointer, the deepest one's last rect
// first; a rect there from any other view is one under a view laid over
// it, which AppKit would still apply (the terminal's I-beam over a page's
// back link, Simon on 0.1.34: "Back navigation cursor stays the text
// cursor"), and counts as a leak.

import AppKit
import ObjectiveC

enum CursorProbe {
    static var log: [(view: NSView, rect: NSRect, cursor: NSCursor)] = []
    static var on = false
    static let install: Void = {
        guard let a = class_getInstanceMethod(NSView.self, #selector(NSView.addCursorRect(_:cursor:))),
              let b = class_getInstanceMethod(NSView.self, #selector(NSView.probeAddCursorRect(_:cursor:))) else { return }
        method_exchangeImplementations(a, b)
    }()

    static func name(_ c: NSCursor) -> String {
        c === NSCursor.pointingHand ? "hand" : c === NSCursor.iBeam ? "ibeam" : c === NSCursor.arrow ? "arrow"
            : c === NSCursor.resizeLeftRight ? "resize" : c === NSCursor.crosshair ? "crosshair" : "other"
    }
}

extension NSView {
    /// addCursorRect, recorded (the implementations are exchanged: this calls AppKit's).
    @objc func probeAddCursorRect(_ r: NSRect, cursor c: NSCursor) {
        if CursorProbe.on {
            let shown = r.intersection(visibleRect)
            if !shown.isEmpty { CursorProbe.log.append((self, convert(shown, to: nil), c)) }
        }
        probeAddCursorRect(r, cursor: c)
    }
}

extension SelfTestBoard {
    /// Every view's cursor rects, asked for again and recorded.
    func readCursorRects() {
        _ = CursorProbe.install
        window.contentView?.layoutSubtreeIfNeeded()
        CursorProbe.log = []
        CursorProbe.on = true
        func walk(_ v: NSView) {
            guard !v.isHidden else { return }
            v.discardCursorRects()
            v.resetCursorRects()
            v.subviews.forEach(walk)
        }
        if let root = window.contentView?.superview ?? window.contentView { walk(root) }
        CursorProbe.on = false
    }

    /// The pointer at a point of a view (its middle when nil): "hand",
    /// "ibeam" or "arrow", and the rects there of views laid under others.
    func pointer(_ v: NSView, at local: NSPoint? = nil) -> (cursor: String, leaks: [String], hit: String) {
        readCursorRects()
        let p = v.convert(local ?? NSPoint(x: v.bounds.midX, y: v.bounds.midY), to: nil)
        guard let hit = (window.contentView?.superview ?? window.contentView)?.hitTest(p) else { return ("none", [], "nothing") }
        var chain: [NSView] = []
        var x: NSView? = hit
        while let y = x { chain.append(y); x = y.superview }
        func depth(_ w: NSView) -> Int { var n = 0; var s = w.superview; while let t = s { n += 1; s = t.superview }; return n }
        var own: [(view: NSView, rect: NSRect, cursor: NSCursor)] = []
        var leaks: [String] = []
        for e in CursorProbe.log where e.rect.contains(p) {
            if chain.contains(where: { $0 === e.view }) || e.view.isDescendant(of: hit) { own.append(e) } else { leaks.append("\(CursorProbe.name(e.cursor)) of \(type(of: e.view))") }
        }
        let deepest = own.max { depth($0.view) < depth($1.view) }.map { d in own.last { $0.view === d.view }! }
        return (deepest.map { CursorProbe.name($0.cursor) } ?? "arrow", leaks, String(describing: type(of: hit)))
    }

    /// One check: the pointer over v is `want`, and nothing under another view shows through.
    func checkPointer(_ name: String, _ v: NSView?, at local: NSPoint? = nil, want: String) {
        guard let v, v.window === window, !v.isHiddenOrHasHiddenAncestor else { check("cursor_\(name)", false, "not on screen"); return }
        // As the person would reach it: scrolled into view first.
        v.scrollToVisible(v.bounds)
        let r = pointer(v, at: local)
        check("cursor_\(name)", r.cursor == want && r.leaks.isEmpty, "\(r.cursor) want \(want) over \(type(of: v)) (hit \(r.hit))\(r.leaks.isEmpty ? "" : ", under it: " + r.leaks.joined(separator: ", "))")
    }

    /// All the views of a kind under a view, in order.
    func views<T: NSView>(_ type: T.Type, in v: NSView, _ ok: (T) -> Bool = { _ in true }) -> [T] {
        var out: [T] = []
        func walk(_ x: NSView) {
            if x.isHidden { return }
            if let t = x as? T, ok(t) { out.append(t) }
            x.subviews.forEach(walk)
        }
        walk(v)
        return out
    }

    /// The pointer over a sample of each kind of thing in the window:
    /// the terminal's text, a sidebar row, a tab and its x, an icon
    /// button, the panel's links, the back links and Close of a page laid
    /// over the terminal, links in a page's text and the text around them,
    /// a session's view's back link, and a plain label.
    func pointerChecks() {
        let b = board, ws = b.ws
        size(1280, 820)
        var n = 0
        while b.root.middle != nil && n < 20 { b.back(); n += 1 }
        if ws.active == nil, let t0 = ws.tabs.first { ws.show(t0) }
        b.render(force: true)
        settle(0.4)
        checkPointer("terminal_text", ws.focusedView, want: "ibeam")
        checkPointer("sidebar_row", views(Row.self, in: b.sidebar) { $0.onOpen != nil && $0.bounds.height > 10 }.first, want: "hand")
        let tab = ws.bar.items.first { $0.model.active }
        checkPointer("tab", tab, at: tab.map { NSPoint(x: 24, y: $0.bounds.midY) }, want: "hand")
        checkPointer("tab_x", tab?.close, want: "hand")
        checkPointer("icon_button", ws.bar.panelButton, want: "hand")
        if let ib = views(RButton.self, in: window.contentView!, { $0.kind == .icon && $0.isEnabled }).first { checkPointer("icon_rbutton", ib, want: "hand") }
        // The panel beside a session: its links (Open brief, Settings).
        let st = b.hub.state
        if let p = st?.projects.first(where: { p in p.machine == nil && p.sessions.contains { $0.pane == nil && $0.machine == nil } }),
           let s = p.sessions.first(where: { $0.pane == nil && $0.machine == nil }) {
            let k = "\(p.id)/\(s.surfaceId)"
            b.sidebar.onSession?(k)
            settle(0.5); b.render(force: true); settle(0.3)
            let links = views(RButton.self, in: b.panel) { $0.kind == .link && $0.isEnabled }
            checkPointer("panel_link", links.first, want: "hand")
            checkPointer("panel_link_open_brief", links.first { $0.title == t("panel.openBrief") } ?? links.last, want: "hand")
            // A session's view opened from its brief: the bar's back link, over the terminal's place.
            var m = 0
            while b.root.middle != nil && m < 20 { b.back(); m += 1 }
            b.sidebar.onNav?("brief:\(p.id)", t("panel.brief"))
            _ = wait(4) { b.brief.shownText != nil }
            b.pickSession(k, why: "cursor check")
            settle(0.4)
            checkPointer("session_view_back_link", b.outside.backBtn, want: "hand")
        } else { check("cursor_panel_link", false, "no session outside this window on the board") }

        // The brief from Objectives, laid over the terminal: its back link, Close, its text and links.
        var m = 0
        while b.root.middle != nil && m < 20 { b.back(); m += 1 }
        if let obj = st?.pages.first(where: { $0.icon == "target" || $0.label.lowercased().hasPrefix("objectives") }) {
            let pid = st?.projects.first { $0.id == "lighthouse" }?.id ?? st?.projects.first { $0.brief != nil }?.id ?? "garden-planner"
            b.sidebar.onNav?(obj.key, obj.label)
            _ = wait(4) { b.files.key == obj.key }
            settle(0.3)
            if let l = views(LinkText.self, in: b.files, { !$0.linkRects().isEmpty }).first, let r = l.linkRects().first(where: { $0.intersects(l.visibleRect) }) {
                checkPointer("page_text_link", l, at: NSPoint(x: r.midX, y: r.midY), want: "hand")
            }
            b.files.host?.openBrief?(pid, nil)
            _ = wait(4) { b.brief.shownText != nil }
            settle(0.4)
            checkPointer("back_link_over_terminal", b.brief.buttons["back"], want: "hand")
            checkPointer("page_close", b.brief.buttons["close"], want: "hand")
            if let l = views(LinkText.self, in: b.brief, { !$0.linkRects().isEmpty }).first, let r = l.linkRects().first(where: { $0.intersects(l.visibleRect) }) {
                checkPointer("brief_text_link", l, at: NSPoint(x: r.midX, y: r.midY), want: "hand")
                // Beside the link on its line, or under it: the text's I-beam.
                let away = [NSPoint(x: r.midX, y: r.maxY + 30), NSPoint(x: r.midX, y: r.minY - 30), NSPoint(x: r.maxX + 40, y: r.midY)]
                    .first { p in l.visibleRect.contains(p) && !l.linkRects().contains { $0.insetBy(dx: -2, dy: -2).contains(p) } && l.link(at: p) == nil && self.textAt(l, p) }
                if let a = away { checkPointer("brief_text", l, at: a, want: "ibeam") } else { check("cursor_brief_text", false, "no text beside the link") }
            } else { check("cursor_brief_text_link", false, "no link in the brief's text") }
            if let f = views(LinkField.self, in: window.contentView!, { $0.hasLinks && !$0.linkRects().isEmpty }).first, let r = f.linkRects().first {
                checkPointer("session_link_in_label", f, at: NSPoint(x: r.midX, y: r.midY), want: "hand")
            }
            // A plain label of the page: the arrow, never the I-beam.
            let plain = views(NSTextField.self, in: b.brief) { f in
                !f.isEditable && !f.isSelectable && !((f as? LinkField)?.hasLinks ?? false) && !f.stringValue.isEmpty && f.bounds.width > 20 && !self.inPressable(f)
            }.first
            checkPointer("plain_label", plain, want: "arrow")
            picture("native-cursor-brief-1280.png")
        } else { check("cursor_back_link_over_terminal", false, "no Objectives page") }
        m = 0
        while b.root.middle != nil && m < 20 { b.back(); m += 1 }
    }

    /// Whether a point of a text view lies on its text (a glyph is drawn there).
    private func textAt(_ l: NSTextView, _ p: NSPoint) -> Bool {
        guard let lm = l.layoutManager, let tc = l.textContainer else { return false }
        let o = l.textContainerOrigin
        let q = NSPoint(x: p.x - o.x, y: p.y - o.y)
        let g = lm.glyphIndex(for: q, in: tc)
        return lm.boundingRect(forGlyphRange: NSRange(location: g, length: 1), in: tc).contains(q)
    }

    /// Whether a view lies in something a press acts on (a row, a button).
    private func inPressable(_ v: NSView) -> Bool {
        var x: NSView? = v
        while let y = x { if y is NSControl && !(y is NSTextField) || y is Row || y is PressBox { return true }; x = y.superview }
        return false
    }
}
