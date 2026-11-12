// A project's brief as a page in the middle (BRIEF-002 to BRIEF-004), as
// the Electron app draws it (app.ts renderBrief, phase2.css .bdoc): a head
// with the brief's name, its project, "Updated <time> by <assistant>" and
// Edit (the file in the person's Markdown editor), then the whole brief
// (BriefDoc.swift) in one column at most 620 points wide. The brief is
// read from the hub when it shows (GET /api/brief), again at most every 4
// seconds while it shows, and drawn again only when its text changed, so
// the entries opened, the place scrolled to and the selection stay. Links
// open in the browser (Outside.swift). Add a note (BRIEF-005, the hub's
// browser board's Add note): a line under the brief's Notes, ticked when it
// is fixed (POST /api/note), from a bar under the head.

import AppKit

final class BriefPage: Box, NSTextViewDelegate, BackLinked {
    private(set) var project = ""
    /// Close: back to what was in front before (Board.back()).
    var onClose: (() -> Void)?
    /// Where it was opened from, as the head's "‹ Objectives" (Board.showMiddle sets it).
    var backLink: (name: String, run: () -> Void)? {
        didSet { if oldValue?.name != backLink?.name { drawHead(headData) } }
    }
    /// The head's buttons by name ("back", "close"), for the self-test.
    private(set) var buttons: [String: RButton] = [:]
    /// What the head was drawn from last (nil: the brief could not be read, or not yet).
    private var headData: [String: Any]?
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
    var toast: ((String) -> Void)?
    /// Add a note: its bar under the head, its field and whether it waits on the hub.
    private(set) var noteOpen = false
    let noteField = FieldBox(t("brief.notePh"), area: false)
    private let noteBar = Box(fill: "sheet")
    private(set) var noteBusy = false

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
        addSubview(noteBar)
        noteBar.isHidden = true
        noteField.onReturn = { [weak self] in self?.addNote() }
        let add = RButton(t("brief.noteAdd"), .primary, small: true) { [weak self] in self?.addNote() }
        let cancel = RButton(t("brief.noteCancel"), small: true) { [weak self] in self?.closeNote() }
        noteButtons = ["noteAdd": add, "noteCancel": cancel]
        let bar = hstack([noteField, add, cancel], spacing: 8, insets: NSEdgeInsets(top: 0, left: 20, bottom: 0, right: 14))
        bar.alignment = .centerY
        bar.translatesAutoresizingMaskIntoConstraints = true
        bar.autoresizingMask = [.width, .height]
        noteBar.addSubview(bar)
        // The session names that are links changed: the brief drawn again with them.
        NotificationCenter.default.addObserver(self, selector: #selector(linksChanged), name: SessionLinks.changed, object: nil)
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc private func linksChanged() { if shownText != nil { redraw() } }

    override func layout() {
        super.layout()
        // The Electron app's brief head: 52 high, its row in the middle, the line under it.
        let hh: CGFloat = 52
        head.frame = NSRect(x: 0, y: 0, width: bounds.width, height: hh)
        head.subviews.first?.frame = head.bounds
        fitHead()
        headLine.frame = NSRect(x: 0, y: hh, width: bounds.width, height: 1)
        let nh: CGFloat = noteOpen ? 52 : 0
        noteBar.isHidden = !noteOpen
        noteBar.frame = NSRect(x: 0, y: hh + 1, width: bounds.width, height: nh)
        noteBar.subviews.first?.frame = noteBar.bounds
        scroll.frame = NSRect(x: 0, y: hh + 1 + nh, width: bounds.width, height: max(0, bounds.height - hh - 1 - nh))
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

    /// An objective to show once the brief is drawn: its heading scrolled to the top and flashed.
    private(set) var pendingFocus: String?
    /// The objective last brought into view (the self-test reads it).
    private(set) var focused: String?
    /// Opens at an objective (Objectives' row): the next draw scrolls to its heading.
    func focus(_ objective: String?) { pendingFocus = objective; if shownText != nil { applyFocus() } }
    /// A section asked for by the hub's key for it (the hand-off card: "handoff"), its heading as the brief names it.
    private var pendingSection: String?
    /// The headings brief.mjs reads as a section, by its key.
    static let sectionNames = ["handoff": ["Hand-off", "Handoff", "Hand off", "Hand-backs"]]
    /// Opens at a section (the hand-off card's press): the next draw scrolls to its heading.
    func focus(section key: String) { pendingSection = key; if shownText != nil { applyFocus() } }

    /// Shows a project's brief: what the hub gave last at once, asked again after 4 seconds.
    func show(_ pid: String, state: HubState?) {
        let changed = project != pid
        if changed { noteOpen = false; noteField.text = ""; needsLayout = true }
        if changed { project = pid; shownText = nil; doc = BriefDoc(dir: ""); text.string = ""; scroll.contentView.scroll(to: .zero) }
        let p = state?.project(pid)
        projectName = p?.name ?? pid
        machine = p?.machine != nil
        if let d = data[pid] { apply(d.code, d.j) } else if changed { drawHead(nil) }
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
        doc.planTick = !machine && hub != nil
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
        if pendingFocus != nil || pendingSection != nil { applyFocus() }
    }

    /// The objective asked for: its heading at the top of the page, flashed as a find shows a match.
    private func applyFocus() {
        if let k = pendingSection {
            // The heading's words as this brief writes them ("## Hand-off", "## Handoff").
            pendingSection = nil
            let ns = text.string as NSString
            for name in BriefPage.sectionNames[k] ?? [k] {
                let r = ns.range(of: "\n" + name + "\n", options: .caseInsensitive)
                if r.location != NSNotFound { pendingFocus = ns.substring(with: NSRange(location: r.location + 1, length: r.length - 2)); break }
            }
        }
        guard let want = pendingFocus, !want.isEmpty, let lm = text.layoutManager, let tc = text.textContainer else { pendingFocus = nil; return }
        let ns = text.string as NSString
        var r = ns.range(of: "\n" + want + "\n")
        if r.location != NSNotFound { r = NSRange(location: r.location + 1, length: (want as NSString).length) } else { r = ns.range(of: want) }
        pendingFocus = nil
        guard r.location != NSNotFound else { return }
        layoutSubtreeIfNeeded()
        lm.ensureLayout(for: tc)
        let gr = lm.glyphRange(forCharacterRange: r, actualCharacterRange: nil)
        let rect = lm.boundingRect(forGlyphRange: gr, in: tc)
        let y = rect.minY + text.textContainerOrigin.y - 16
        scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, min(y, text.frame.height - scroll.contentSize.height))))
        scroll.reflectScrolledClipView(scroll.contentView)
        focused = want
        if window != nil { text.showFindIndicator(for: r) }
    }

    /// Why the last tick was not written (said by a beep; the self-test reads it).
    private(set) var tickError: String?
    /// The tasks ticked from the page, for the self-test: POST bodies sent.
    private(set) var ticked: [[String: Any]] = []

    /// A Plan task's box pressed: ticked or unticked in the brief (POST /api/brief/tick), then read again.
    private func tick(_ n: Int) {
        guard n < doc.planTasks.count, let hub else { return }
        let task = doc.planTasks[n]
        let body: [String: Any] = ["project": project, "objective": task.objective, "text": task.text, "done": !task.done]
        ticked.append(body)
        let pid = project
        hub.post("/api/brief/tick", body) { [weak self] code, j in
            guard let self else { return }
            if code != 200 { NSSound.beep(); self.tickError = j["error"] as? String ?? t("pg.notTicked") }
            self.data[pid] = nil
            self.fetch(pid)
        }
    }

    private func drawHead(_ j: [String: Any]?) {
        headData = j
        head.subviews.forEach { $0.removeFromSuperview() }
        let old = buttons
        buttons = [:]
        // Where it was opened from ("‹ Objectives"), and Close: both go back there (Board.back()).
        // The same buttons through a redraw (the brief read again, every 4 s at most): a press that
        // began on one before the brief came still lands (NAV-001: the head was rebuilt under it).
        let back = backLink.map { l -> RButton in
            backButton(l.name, l.run, reusing: old["back"])
        }
        if let back { buttons["back"] = back }
        let close = old["close"] ?? RButton(t("page.close"), .icon, small: true, icon: "close") { [weak self] in self?.onClose?() }
        buttons["close"] = close
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
            if !machine, hub != nil {
                let n = RButton(t("brief.addNote"), small: true) { [weak self] in self?.openNote() }
                n.toolTip = t("brief.addNoteTip")
                buttons["addNote"] = n
            }
        }
        let name = label(t("brief.title"), Fonts.pt(13, Fonts.w650))
        let row = hstack([back, Icon("doc", "tx3", size: 15), name, label(projectName, Fonts.pt(12.5), "tx3"), spring(), updated, buttons["addNote"], edit, close], spacing: 10, insets: NSEdgeInsets(top: 0, left: back == nil ? 20 : 14, bottom: 0, right: 14))
        row.translatesAutoresizingMaskIntoConstraints = true
        head.addSubview(row)
        row.frame = head.bounds
        row.autoresizingMask = [.width, .height]
        headUpdated = updated
        fitHead()
    }

    /// The head's "Updated ... by ..." words, the first to give way when the head is narrow.
    private weak var headUpdated: NSTextField?
    /// At a width where the head's row does not hold all of it (900 points with Add a note and
    /// Edit), the updated line goes, so the project's name is never squeezed; it comes back wider.
    private func fitHead() {
        guard let u = headUpdated, let row = head.subviews.first as? NSStackView else { return }
        let rest = row.views.filter { $0 !== u && !$0.isHidden }
        let need = row.edgeInsets.left + row.edgeInsets.right + rest.reduce(0) { $0 + $1.fittingSize.width } + row.spacing * CGFloat(rest.count)
            + u.fittingSize.width
        let hide = need > head.bounds.width
        if u.isHidden != hide { u.isHidden = hide }
    }

    /// The note bar's buttons, for the self-test.
    private(set) var noteButtons: [String: RButton] = [:]

    /// Add a note: the bar under the head, the keyboard in its field.
    func openNote() {
        noteOpen = true
        needsLayout = true
        layoutSubtreeIfNeeded()
        window?.makeFirstResponder(noteField.field)
    }
    func closeNote() {
        noteOpen = false
        noteField.text = ""
        needsLayout = true
    }

    /// The note sent: a line under Notes in the brief (POST /api/note), then the brief read again.
    private func addNote() {
        let text = noteField.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { window?.makeFirstResponder(noteField.field); toast?(t("brief.noteFirst")); return }
        guard !noteBusy, let hub else { return }
        noteBusy = true
        noteButtons.values.forEach { $0.isEnabled = false }
        let pid = project
        hub.post("/api/note", ["projectId": pid, "text": text]) { [weak self] code, j in
            guard let self else { return }
            self.noteBusy = false
            self.noteButtons.values.forEach { $0.isEnabled = true }
            if code != 200 { self.toast?(j["error"] as? String ?? t("page.didNotWork")); return }
            self.toast?(t("brief.noteTracked"))
            if self.project == pid { self.closeNote() }
            self.data[pid] = nil
            self.fetch(pid)
        }
    }

    /// A link: an entry opens or closes; http, https and file URLs open outside.
    func textView(_ v: NSTextView, clickedOnLink link: Any, at i: Int) -> Bool {
        let s = (link as? URL)?.absoluteString ?? (link as? String) ?? ""
        if s.hasPrefix("rvn-task:"), let n = Int(s.dropFirst(9)) { tick(n); return true }
        // A session's name: its session, at once (SessionLinks).
        if SessionLinks.shared.openLink(s, from: v) { clicked.append(s); return true }
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
    /// The rects of its links (a URL, a file, an entry), in its coordinates.
    func linkRects() -> [NSRect] {
        guard let lm = layoutManager, let tc = textContainer, let st = textStorage, st.length > 0 else { return [] }
        let o = textContainerOrigin
        var out: [NSRect] = []
        for key in [NSAttributedString.Key.link, BriefDoc.entryKey] {
            st.enumerateAttribute(key, in: NSRange(location: 0, length: st.length)) { v, cr, _ in
                guard v != nil else { return }
                let gr = lm.glyphRange(forCharacterRange: cr, actualCharacterRange: nil)
                lm.enumerateEnclosingRects(forGlyphRange: gr, withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0), in: tc) { b, _ in
                    out.append(b.offsetBy(dx: o.x, dy: o.y))
                }
            }
        }
        return out
    }
    /// The I-beam over its text, the pointing hand over its links (Cursors.swift).
    override func resetCursorRects() {
        if isEditable { super.resetCursorRects(); return }
        textCursor(visibleRect, links: linkRects().filter { $0.intersects(visibleRect) })
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
