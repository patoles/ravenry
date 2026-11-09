// A project's brief as a page in the middle (BRIEF-002 to BRIEF-004), as
// the Electron app draws it (app.ts renderBrief, phase2.css .bdoc): a head
// with the brief's name, its project, "Updated <time> by <assistant>" and
// Edit (the file in the person's Markdown editor), then the whole brief
// (BriefDoc.swift) in one column at most 620 points wide. The brief is
// read from the hub when it shows (GET /api/brief), again at most every 4
// seconds while it shows, and drawn again only when its text changed, so
// the entries opened, the place scrolled to and the selection stay. Links
// open in the browser (Outside.swift).

import AppKit

final class BriefPage: Box, NSTextViewDelegate {
    private(set) var project = ""
    var hub: HubClient?
    /// What the page drew last (the self-test reads it).
    private(set) var shownText: String?
    private(set) var doc = BriefDoc(dir: "")
    private(set) var edit: RButton?
    private(set) var error: String?
    let text: NSTextView
    let scroll = NSScrollView()
    private let head = Box()
    private let headLine = Box(fill: "sep")
    private var data: [String: (code: Int, j: [String: Any], at: Date)] = [:]
    private var asking = Set<String>()
    private var entries: [BriefEntry] = []
    private var lastWidth: CGFloat = 0
    private var projectName = ""
    private var machine = false

    init() {
        // TextKit 1: the code blocks and the entries' box are text blocks.
        let storage = NSTextStorage()
        let lm = NSLayoutManager()
        storage.addLayoutManager(lm)
        let tc = NSTextContainer(size: NSSize(width: 620, height: CGFloat.greatestFiniteMagnitude))
        tc.widthTracksTextView = true
        lm.addTextContainer(tc)
        text = LinkText(frame: .zero, textContainer: tc)
        super.init(fill: "sheet")
        text.isEditable = false
        text.isSelectable = true
        text.drawsBackground = false
        text.isVerticallyResizable = true
        text.isHorizontallyResizable = false
        // As tall as its text: it grows past the first frame it was given.
        text.minSize = .zero
        text.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        text.autoresizingMask = [.width]
        text.delegate = self
        text.linkTextAttributes = [.foregroundColor: Design.color("link"), .underlineStyle: NSUnderlineStyle.single.rawValue, .cursor: NSCursor.pointingHand]
        text.setAccessibilityLabel(t("brief.title"))
        scroll.drawsBackground = false
        // Under the window's title bar is the page's head, not the text.
        scroll.automaticallyAdjustsContentInsets = false
        scroll.contentInsets = NSEdgeInsetsZero
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.documentView = text
        addSubview(head)
        addSubview(headLine)
        addSubview(scroll)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        let hh: CGFloat = 46
        head.frame = NSRect(x: 0, y: 0, width: bounds.width, height: hh)
        head.subviews.first?.frame = head.bounds
        headLine.frame = NSRect(x: 0, y: hh, width: bounds.width, height: 1)
        scroll.frame = NSRect(x: 0, y: hh + 1, width: bounds.width, height: max(0, bounds.height - hh - 1))
        let w = scroll.contentSize.width
        // A new size keeps the place scrolled to (the clip view would move it by the inset).
        let y = scroll.contentView.bounds.origin.y
        // .md: at most 620 wide, in the middle; 20 at each side at least.
        let side = max(20, (w - 620) / 2)
        if text.textContainerInset != NSSize(width: side, height: 0) { text.textContainerInset = NSSize(width: side, height: 0) }
        if text.frame.width != w { text.frame.size.width = w }
        text.minSize = NSSize(width: 0, height: scroll.contentSize.height)
        if abs(w - lastWidth) > 0.5 {
            lastWidth = w
            if !entries.isEmpty { redraw() }
        }
        let top = min(y, max(0, text.frame.height - scroll.contentSize.height))
        if scroll.contentView.bounds.origin.y != top { scroll.contentView.scroll(to: NSPoint(x: 0, y: top)); scroll.reflectScrolledClipView(scroll.contentView) }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        // The checkboxes are pictures: drawn again in the new colours.
        if shownText != nil { redraw() }
    }

    /// Shows a project's brief: what the hub gave last at once, asked again after 4 seconds.
    func show(_ pid: String, state: HubState?) {
        if project != pid { project = pid; shownText = nil; doc = BriefDoc(dir: ""); text.string = ""; scroll.contentView.scroll(to: .zero) }
        let p = state?.project(pid)
        projectName = p?.name ?? pid
        machine = p?.machine != nil
        if let d = data[pid] { apply(d.code, d.j) }
        if data[pid].map({ Date().timeIntervalSince($0.at) > 4 }) ?? true { fetch(pid) }
    }

    private func fetch(_ pid: String) {
        guard !asking.contains(pid), let hub else { return }
        asking.insert(pid)
        hub.get("/api/brief?project=\(pid.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? pid)") { [weak self] code, j in
            guard let self else { return }
            self.asking.remove(pid)
            self.data[pid] = (code, j, Date())
            if self.project == pid && !self.isHiddenOrHasHiddenAncestor { self.apply(code, j) }
        }
    }

    /// The hub's answer drawn: an error's words, else the brief (again only when its text changed).
    func apply(_ code: Int, _ j: [String: Any]) {
        guard code == 200, let body = j["text"] as? String else {
            error = j["error"] as? String ?? t("brief.unreadable")
            shownText = nil
            entries = []
            drawHead(nil)
            let p = NSMutableParagraphStyle(); p.alignment = .left
            text.textStorage?.setAttributedString(NSAttributedString(string: error ?? "", attributes: [.font: Fonts.pt(13), .foregroundColor: Design.color("tx3"), .paragraphStyle: p]))
            return
        }
        error = nil
        drawHead(j)
        if shownText == body { return }
        let file = j["file"] as? String ?? ""
        doc = BriefDoc(dir: (file as NSString).deletingLastPathComponent, open: shownText == nil ? [0] : doc.open, width: min(620, max(100, lastWidth - 40)))
        entries = ((j["nextParts"] as? [String: Any])?["entries"] as? [[String: Any]] ?? []).map(BriefEntry.init)
        shownText = body
        redraw()
    }

    /// The text drawn again from the brief it shows (an entry opened, the width or the colours changed): the place scrolled to stays.
    private func redraw() {
        guard let body = shownText else { return }
        let y = scroll.contentView.bounds.origin.y
        let sel = text.selectedRanges
        doc.width = min(620, max(100, lastWidth - 40))
        var d = doc
        let s = d.page(body, entries: entries)
        doc = d
        text.textStorage?.setAttributedString(s)
        text.sizeToFit()
        let len = text.string.utf16.count
        let kept = sel.map { $0.rangeValue }.filter { NSMaxRange($0) <= len }
        if !kept.isEmpty { text.selectedRanges = kept.map { NSValue(range: $0) } }
        scroll.contentView.scroll(to: NSPoint(x: 0, y: min(y, max(0, text.frame.height - scroll.contentSize.height))))
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    private func drawHead(_ j: [String: Any]?) {
        head.subviews.forEach { $0.removeFromSuperview() }
        var updated: NSTextField? = nil
        edit = nil
        if let j {
            let by = j["by"] as? String
            let when = When.clock(j["updatedAt"] as? String)
            updated = label(by.map { t("brief.updatedBy", ["when": when, "who": $0]) } ?? t("brief.updated", ["when": when]), Fonts.pt(12.5), "tx3")
            updated?.toolTip = j["path"] as? String
            if !machine, let file = j["file"] as? String {
                let b = RButton(t("brief.edit"), small: true) { Outside.openFile(file) }
                b.toolTip = t("brief.editTip", ["path": j["path"] as? String ?? file])
                edit = b
            }
        }
        let name = label(t("brief.title"), Fonts.pt(13, Fonts.w650))
        let row = hstack([Icon("doc", "tx3", size: 15), name, label(projectName, Fonts.pt(12.5), "tx3"), spring(), updated, edit], spacing: 10, insets: NSEdgeInsets(top: 0, left: 20, bottom: 0, right: 20))
        row.translatesAutoresizingMaskIntoConstraints = true
        head.addSubview(row)
        row.frame = head.bounds
        row.autoresizingMask = [.width, .height]
    }

    /// A link: an entry opens or closes; http, https and file URLs open outside.
    func textView(_ v: NSTextView, clickedOnLink link: Any, at i: Int) -> Bool {
        let s = (link as? URL)?.absoluteString ?? (link as? String) ?? ""
        if s.hasPrefix("rvn-entry:"), let n = Int(s.dropFirst(10)) {
            if doc.open.contains(n) { doc.open.remove(n) } else { doc.open.insert(n) }
            redraw()
            return true
        }
        clicked.append(s)
        Outside.open(s)
        return true
    }
    /// The links clicked, for the self-test.
    private(set) var clicked: [String] = []
}

/// A text view whose links open on the press, as the Electron app's (a
/// press elsewhere selects as usual).
final class LinkText: NSTextView {
    /// The link under a point of the view, if a glyph there has one.
    func link(at p: NSPoint) -> Any? {
        guard let lm = layoutManager, let tc = textContainer, let st = textStorage, st.length > 0 else { return nil }
        let o = textContainerOrigin
        let q = NSPoint(x: p.x - o.x, y: p.y - o.y)
        let g = lm.glyphIndex(for: q, in: tc)
        guard lm.boundingRect(forGlyphRange: NSRange(location: g, length: 1), in: tc).insetBy(dx: -1, dy: -1).contains(q) else { return nil }
        let c = lm.characterIndexForGlyph(at: g)
        guard c < st.length else { return nil }
        return st.attribute(.link, at: c, effectiveRange: nil) ?? st.attribute(BriefDoc.entryKey, at: c, effectiveRange: nil)
    }
    /// A link opens with the press that brings the window forward, as a row does.
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func mouseDown(with e: NSEvent) {
        if e.clickCount == 1, !e.modifierFlags.contains(.shift), let l = link(at: convert(e.locationInWindow, from: nil)) {
            _ = delegate?.textView?(self, clickedOnLink: l, at: 0)
            return
        }
        super.mouseDown(with: e)
    }
}
