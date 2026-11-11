// The pieces a page from a file is drawn with (apps/desktop/src/renderer/
// pages.ts, app.css .ocard, .orow, .lane, .nt, .pcard, .ptabs, .dot, .bx):
// a card, a row that opens on a press, a step's or a task's mark, the
// small glyphs the page's bars carry, a board's note that is dragged to
// another lane, the tabs, and a box to tick.

import AppKit

/// A token colour as the appearance in effect has it.
private func cg(_ name: String) -> CGColor { Design.color(name).cgColor }

/// A box that opens on a press (.orow[role=button], .pcard, .gl-r), its own buttons keeping theirs.
class PressBox: Box {
    var onPress: (() -> Void)?
    var key = ""
    override func mouseDown(with e: NSEvent) { if let p = onPress { p() } else { super.mouseDown(with: e) } }
    override func resetCursorRects() { handCursor(onPress != nil) }
    override func hitTest(_ p: NSPoint) -> NSView? {
        guard let v = super.hitTest(p) else { return nil }
        guard onPress != nil else { return v }
        var x: NSView? = v
        while let c = x, c !== self { if c is NSButton || c is NSTextField && (c as! NSTextField).isEditable || c is TickBox || c is NSPopUpButton || c is TaskDot || c is Chevron || c is NSTextView { return v }; x = c.superview }
        if LinkField.takes(v, p, from: superview) { return v }
        return self
    }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { onPress?(); return true }
}

/// A card (.ocard, .pcard, .lane, .pstat): its content from the top, the card as tall as its row asks.
func card(_ content: NSView, fill: String = "card", radius: CGFloat = 10, insets: NSEdgeInsets = NSEdgeInsetsZero, press: (() -> Void)? = nil) -> PressBox {
    let b = PressBox(fill: fill, radius: radius)
    b.onPress = press
    b.translatesAutoresizingMaskIntoConstraints = false
    b.layer?.masksToBounds = true
    content.translatesAutoresizingMaskIntoConstraints = false
    b.addSubview(content)
    let bottom = content.bottomAnchor.constraint(equalTo: b.bottomAnchor, constant: -insets.bottom)
    bottom.priority = .defaultHigh
    NSLayoutConstraint.activate([
        content.leadingAnchor.constraint(equalTo: b.leadingAnchor, constant: insets.left),
        content.trailingAnchor.constraint(equalTo: b.trailingAnchor, constant: -insets.right),
        content.topAnchor.constraint(equalTo: b.topAnchor, constant: insets.top),
        content.bottomAnchor.constraint(lessThanOrEqualTo: b.bottomAnchor, constant: -insets.bottom), bottom,
    ])
    if press != nil { b.setAccessibilityElement(true); b.setAccessibilityRole(.button) }
    return b
}

/// A line between rows (.orow's border-top).
func hline() -> NSView {
    let l = Box(fill: "sep")
    l.translatesAutoresizingMaskIntoConstraints = false
    l.heightAnchor.constraint(equalToConstant: 1).isActive = true
    return l
}

/// A space of a fixed width or height.
func gap(_ w: CGFloat, _ h: CGFloat = 1) -> NSView {
    let v = NSView()
    v.translatesAutoresizingMaskIntoConstraints = false
    v.widthAnchor.constraint(equalToConstant: w).isActive = true
    v.heightAnchor.constraint(equalToConstant: h).isActive = true
    return v
}

/// Width and height fixed.
@discardableResult func fix(_ v: NSView, w: CGFloat? = nil, h: CGFloat? = nil, minW: CGFloat? = nil) -> NSView {
    v.translatesAutoresizingMaskIntoConstraints = false
    if let w { v.widthAnchor.constraint(equalToConstant: w).isActive = true }
    if let h { v.heightAnchor.constraint(equalToConstant: h).isActive = true }
    if let minW { v.widthAnchor.constraint(greaterThanOrEqualToConstant: minW).isActive = true }
    return v
}

/// Gives way first when a row is short of room.
@discardableResult func soft(_ v: NSView) -> NSView {
    v.setContentHuggingPriority(.init(1), for: .horizontal)
    v.setContentCompressionResistancePriority(.init(1), for: .horizontal)
    return v
}

/// .as-tag: a word in a ring, in its tone's colour.
func asTag(_ s: String, tone: String? = nil) -> Box {
    let c = tone == "ok" ? "ok" : tone == "you" ? "you" : "tx2"
    let b = boxed(label(s, Fonts.pt(11, .semibold), c), fill: nil, ring: tone == "ok" || tone == "you" ? c : "sep", radius: 5, insets: NSEdgeInsets(top: 2, left: 7, bottom: 2, right: 7))
    b.setContentHuggingPriority(.required, for: .horizontal)
    b.setContentCompressionResistancePriority(.init(400), for: .horizontal)
    return b
}

/// .chip: a word on a tint.
func chip(_ s: String) -> Box {
    let b = boxed(label(s, Fonts.pt(11, .semibold), "tx2"), fill: "card2", radius: 5, insets: NSEdgeInsets(top: 3, left: 8, bottom: 3, right: 8))
    b.setContentHuggingPriority(.required, for: .horizontal)
    return b
}

/// .cnt: a count in a round pill.
func countPill(_ n: Int) -> Box {
    let l = label("\(n)", Fonts.pt(12, .bold).withTabularDigits, "tx2")
    l.alignment = .center
    let b = boxed(l, fill: "lane-cnt", radius: 10, insets: NSEdgeInsets(top: 1, left: 6, bottom: 1, right: 6))
    b.widthAnchor.constraint(greaterThanOrEqualToConstant: 20).isActive = true
    b.heightAnchor.constraint(equalToConstant: 20).isActive = true
    b.setContentHuggingPriority(.required, for: .horizontal)
    return b
}

/// A mark drawn in a 14-point box: a step's or a task's dot (taskDot,
/// rowDot), the glyphs of the page's bars (info, shield, a tick).
final class Mark: NSView {
    enum Kind: String { case done, now, you, wait, todo, skip, gate, gateOn, gateDone, branch, branchTodo, branchLegend, info, shield, fix }
    let kind: Kind
    var tint = "tx3" { didSet { needsDisplay = true } }
    init(_ kind: Kind, size: CGFloat = 13) {
        self.kind = kind
        super.init(frame: NSRect(x: 0, y: 0, width: size, height: size))
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: size).isActive = true
        heightAnchor.constraint(equalToConstant: size).isActive = true
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    /// A step's mark in a plan row (rowDot): g, G, Gd, b, bt, else a task's.
    static func step(_ c: String) -> Mark {
        switch c {
        case "g": return Mark(.gate)
        case "G": return Mark(.gateOn)
        case "Gd": return Mark(.gateDone)
        case "b": return Mark(.branch)
        case "bt": return Mark(.branchTodo)
        default: return task(["x": "done", "n": "now", "y": "you", "s": "skip"][c] ?? "todo")
        }
    }
    static func task(_ st: String) -> Mark { Mark(Kind(rawValue: st) ?? .todo) }
    override func viewDidChangeEffectiveAppearance() { needsDisplay = true }
    override func draw(_ r: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let s = bounds.width
            let k = s / 18
            func diamond(_ inset: CGFloat) -> NSBezierPath {
                let p = NSBezierPath()
                p.move(to: NSPoint(x: 9 * k, y: inset * k)); p.line(to: NSPoint(x: (18 - inset) * k, y: 9 * k))
                p.line(to: NSPoint(x: 9 * k, y: (18 - inset) * k)); p.line(to: NSPoint(x: inset * k, y: 9 * k)); p.close()
                return p
            }
            func branch(_ c: String) {
                let p = NSBezierPath()
                p.move(to: NSPoint(x: 9 * k, y: 15 * k)); p.line(to: NSPoint(x: 9 * k, y: 10 * k)); p.line(to: NSPoint(x: 5 * k, y: 4.5 * k))
                p.move(to: NSPoint(x: 9 * k, y: 10 * k)); p.line(to: NSPoint(x: 13 * k, y: 4.5 * k))
                p.lineWidth = 2 * k; p.lineCapStyle = .round; p.lineJoinStyle = .round
                Design.color(c).setStroke(); p.stroke()
            }
            switch kind {
            case .done, .now:
                Design.color(kind == .done ? "ok" : "work").setFill()
                NSBezierPath(ovalIn: bounds).fill()
            case .you, .wait:
                let p = NSBezierPath(ovalIn: bounds.insetBy(dx: 1, dy: 1))
                p.lineWidth = 2
                if kind == .wait { p.setLineDash([2.6, 1.8], count: 2, phase: 0) }
                Design.color(kind == .you ? "you" : "wait").setStroke(); p.stroke()
            case .todo, .skip:
                let p = NSBezierPath(ovalIn: bounds.insetBy(dx: 0.75, dy: 0.75))
                p.lineWidth = 1.5
                Design.color("idle").setStroke(); p.stroke()
            case .gate:
                let p = diamond(2.2); p.lineWidth = 2 * k; Design.color("idle").setStroke(); p.stroke()
            case .gateOn:
                let p = diamond(2.2); p.lineWidth = 2 * k; Design.color("you-t").setFill(); p.fill(); Design.color("you").setStroke(); p.stroke()
            case .gateDone:
                Design.color("ok").setFill(); diamond(1.2).fill()
            case .branch: branch("ok")
            case .branchTodo: branch("idle")
            case .branchLegend: branch("tx2")
            case .info, .shield, .fix:
                // In a 14 (16 for the shield) point view box, stroked in `tint`.
                let u = s / (kind == .shield ? 16 : 14)
                let p = NSBezierPath()
                p.lineWidth = (kind == .fix ? 1.8 : 1.5) * u
                p.lineCapStyle = .round; p.lineJoinStyle = .round
                func pt(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: x * u, y: y * u) }
                switch kind {
                case .info:
                    p.appendOval(in: NSRect(x: 1.4 * u, y: 1.4 * u, width: 11.2 * u, height: 11.2 * u))
                    p.move(to: pt(7, 6.3)); p.line(to: pt(7, 9.9)); p.move(to: pt(7, 4.3)); p.line(to: pt(7, 4.4))
                case .shield:
                    p.move(to: pt(8, 1.5)); p.line(to: pt(13.5, 3.5)); p.line(to: pt(13.5, 7.7))
                    p.curve(to: pt(8, 14.5), controlPoint1: pt(13.5, 10.9), controlPoint2: pt(11.2, 13.4))
                    p.curve(to: pt(2.5, 7.7), controlPoint1: pt(4.8, 13.4), controlPoint2: pt(2.5, 10.9))
                    p.line(to: pt(2.5, 3.5)); p.close()
                    p.move(to: pt(8, 5.5)); p.line(to: pt(8, 8.7)); p.move(to: pt(8, 10.6)); p.line(to: pt(8, 10.7))
                default:
                    p.move(to: pt(2.5, 7.4)); p.line(to: pt(5.3, 10.2)); p.line(to: pt(11.5, 3.8))
                }
                Design.color(tint).setStroke(); p.stroke()
            }
        }
    }
}

/// .bx: a box to tick, green with a tick when done.
final class TickBox: NSView {
    var done: Bool { didSet { needsDisplay = true; setAccessibilityValue(done) } }
    var enabled: Bool
    var run: (() -> Void)?
    init(_ done: Bool, enabled: Bool, run: (() -> Void)?) {
        self.done = done; self.enabled = enabled; self.run = run
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 15).isActive = true
        heightAnchor.constraint(equalToConstant: 15).isActive = true
        setAccessibilityElement(true)
        setAccessibilityRole(.checkBox)
        setAccessibilityLabel(done ? t("pg.untick") : t("pg.tick"))
        setAccessibilityValue(done)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func draw(_ r: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            if done {
                Design.color("ok").setFill()
                NSBezierPath(roundedRect: bounds, xRadius: 4, yRadius: 4).fill()
                let p = NSBezierPath()
                p.move(to: NSPoint(x: 4, y: 7.8)); p.line(to: NSPoint(x: 6.6, y: 10.4)); p.line(to: NSPoint(x: 11.2, y: 5))
                p.lineWidth = 2; p.lineCapStyle = .round; p.lineJoinStyle = .round
                NSColor.white.setStroke(); p.stroke()
            } else {
                let p = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.75, dy: 0.75), xRadius: 3.4, yRadius: 3.4)
                p.lineWidth = 1.5
                Design.color("idle").withAlphaComponent(enabled ? 1 : 0.5).setStroke(); p.stroke()
            }
        }
    }
    override func mouseDown(with e: NSEvent) { if enabled { run?() } }
    override func resetCursorRects() { handCursor(enabled) }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { if enabled { run?() }; return true }
}

/// .ptabs: the page's tabs, the one drawn on, each with its count.
final class PageTabs: Box {
    private(set) var segs: [SegButton] = []
    init(_ labels: [(String, Int?)], on: Int, pick: @escaping (Int) -> Void) {
        super.init(fill: "card", radius: 8)
        translatesAutoresizingMaskIntoConstraints = false
        var views: [NSView] = []
        for (i, (l, n)) in labels.enumerated() {
            let b = SegButton(l, count: n, on: i == on) { pick(i) }
            segs.append(b)
            views.append(b)
        }
        let row = hstack(views, spacing: 2, insets: NSEdgeInsets(top: 2, left: 2, bottom: 2, right: 2))
        addSubview(row)
        NSLayoutConstraint.activate([row.leadingAnchor.constraint(equalTo: leadingAnchor), row.trailingAnchor.constraint(equalTo: trailingAnchor),
                                     row.topAnchor.constraint(equalTo: topAnchor), row.bottomAnchor.constraint(equalTo: bottomAnchor)])
        setContentHuggingPriority(.required, for: .horizontal)
    }
    required init?(coder: NSCoder) { fatalError() }
}

/// .seg: a tab's label and count, lit when on.
final class SegButton: NSButton {
    var run: (() -> Void)?
    let on: Bool
    init(_ l: String, count: Int?, on: Bool, run: @escaping () -> Void) {
        self.on = on; self.run = run
        super.init(frame: .zero)
        isBordered = false
        bezelStyle = .regularSquare
        setButtonType(.momentaryChange)
        wantsLayer = true
        target = self
        action = #selector(fire)
        translatesAutoresizingMaskIntoConstraints = false
        title = l
        let a = NSMutableAttributedString(string: l, attributes: [.font: Fonts.pt(12.5), .foregroundColor: Design.color(on ? "tx" : "tx2")])
        if let n = count, n != 0 { a.append(NSAttributedString(string: " \(n)", attributes: [.font: Fonts.pt(12.5).withTabularDigits, .foregroundColor: Design.color("tx3")])) }
        attributedTitle = a
        setAccessibilityValue(on)
        setContentHuggingPriority(.required, for: .horizontal)
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc private func fire() { run?() }
    override var intrinsicContentSize: NSSize { let s = attributedTitle.size(); return NSSize(width: ceil(s.width) + 24, height: 26) }
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        guard let l = layer else { return }
        effectiveAppearance.performAsCurrentDrawingAppearance {
            l.cornerRadius = 6
            l.backgroundColor = on ? cg("sheet") : nil
            l.borderWidth = on ? 1 : 0
            l.borderColor = cg("sep")
        }
    }
    override func draw(_ r: NSRect) {
        let s = attributedTitle.size()
        attributedTitle.draw(at: NSPoint(x: (bounds.width - s.width) / 2, y: (bounds.height - s.height) / 2))
    }
    override func viewDidChangeEffectiveAppearance() { needsDisplay = true }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
}

/// A note on a board (.nt): opens on a press; dragged to another lane, it
/// moves there (the page's drop). Its buttons show while the pointer is on it.
final class NoteCard: PressBox {
    var acts: NSView?
    /// Where a drag is dropped: the page lights the lane under the point and moves the item on release.
    var dragMoved: ((NSPoint) -> Void)?
    var dragEnded: ((NSPoint?) -> Void)?
    var draggable = false
    private var hover = false { didSet { acts?.isHidden = !hover; needsDisplay = true } }
    override func updateLayer() {
        super.updateLayer()
        guard let l = layer else { return }
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let light = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .aqua
            l.borderWidth = hover ? 1.5 : light ? 1 : 0
            l.borderColor = hover ? cg("work") : cg("sep")
        }
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for t in trackingAreas { removeTrackingArea(t) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with e: NSEvent) { hover = true }
    override func mouseExited(with e: NSEvent) { hover = false }
    /// A press, then: a release where it began opens it; a move of more than
    /// 4 points drags it, the page lighting the lane under the pointer, and
    /// the release drops it there.
    override func mouseDown(with e: NSEvent) {
        guard draggable, let win = window else { onPress?(); return }
        let start = e.locationInWindow
        var dragging = false
        while true {
            let next = win.nextEvent(matching: [.leftMouseDragged, .leftMouseUp], until: Date().addingTimeInterval(0.05), inMode: .eventTracking, dequeue: true)
            guard let ev = next else {
                // No release queued and the button is up (a press made by a test): a click.
                if NSEvent.pressedMouseButtons & 1 == 0 { if dragging { dragEnded?(nil) } else { onPress?() }; return }
                continue
            }
            if ev.type == .leftMouseDragged {
                if !dragging && hypot(ev.locationInWindow.x - start.x, ev.locationInWindow.y - start.y) > 4 { dragging = true }
                if dragging { dragMoved?(ev.locationInWindow) }
            } else {
                if dragging { dragEnded?(ev.locationInWindow) } else { onPress?() }
                return
            }
        }
    }
}

/// A Markdown document as a page draws it (the document view, an item's
/// text): one selectable text from BriefDoc.document, at most `measure`
/// wide so a line stays readable at any window width. Each ## section folds
/// from the chevron in the gutter or a press on its heading; with three
/// sections or more and room beside the text, a contents column lists them
/// and a press scrolls the page to one. A box ticks through `onBox` (its
/// place among the text's boxes, its new state). As tall as its text.
final class DocView: Flipped, NSTextViewDelegate {
    /// About 80 characters a line at 14 points.
    static let measure: CGFloat = 660
    static let contentsW: CGFloat = 210
    let text: LinkText
    private let md: String
    private let dir: String
    let canTick: Bool
    private let size: CGFloat
    private(set) var folded: Set<Int>
    var onBox: ((Int, Bool) -> Void)?
    /// The sections folded changed (the page keeps them through its redraws).
    var onFold: ((Set<Int>) -> Void)?
    private(set) var headings: [BriefDoc.Heading] = []
    /// The boxes drawn, in the text's order.
    private(set) var boxes: [(text: String, done: Bool)] = []
    private var chevrons: [Int: Chevron] = [:]
    private(set) var contents: NSView?
    private(set) var contentsRows: [Int: PressBox] = [:]
    private var lastW: CGFloat = -1
    private var height: CGFloat = 0
    /// The links pressed (the self-test reads them).
    private(set) var clicked: [String] = []

    /// The title its card already shows (a first # heading saying it is not drawn).
    private let skipTitle: String?
    init(_ md: String, dir: String, canTick: Bool, folded: Set<Int> = [], size: CGFloat = 14, skipTitle: String? = nil) {
        self.md = md; self.dir = dir; self.canTick = canTick; self.folded = folded; self.size = size; self.skipTitle = skipTitle
        let storage = NSTextStorage()
        let lm = NSLayoutManager()
        storage.addLayoutManager(lm)
        let tc = NSTextContainer(size: NSSize(width: DocView.measure, height: .greatestFiniteMagnitude))
        tc.lineFragmentPadding = 0
        lm.addTextContainer(tc)
        text = LinkText(frame: .zero, textContainer: tc)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        text.isEditable = false
        text.isSelectable = true
        text.drawsBackground = false
        text.isVerticallyResizable = false
        text.isHorizontallyResizable = false
        text.textContainerInset = .zero
        text.delegate = self
        text.linkTextAttributes = [.foregroundColor: Design.color("link"), .underlineStyle: NSUnderlineStyle.single.rawValue, .cursor: NSCursor.pointingHand]
        addSubview(text)
        setContentHuggingPriority(.required, for: .vertical)
        render()
        // The session names that are links changed: drawn again with them.
        NotificationCenter.default.addObserver(self, selector: #selector(linksChanged), name: SessionLinks.changed, object: nil)
    }
    @objc private func linksChanged() { render(); needsLayout = true }
    required init?(coder: NSCoder) { fatalError() }

    private var gutter: CGFloat { headings.contains { $0.section != nil } ? 22 : 0 }
    private var sections: [BriefDoc.Heading] { headings.filter { $0.section != nil } }

    private func render() {
        var d = BriefDoc(dir: dir)
        d.size = size; d.lh = 1.55; d.tick = canTick; d.codeFill = "card2"
        let r = d.document(md, folded: folded, skipTitle: skipTitle)
        boxes = d.docBoxes
        headings = r.text.length == 0 ? [] : r.headings
        text.textStorage?.setAttributedString(r.text)
        let secs = sections
        for (k, c) in chevrons where !secs.contains(where: { $0.section == k }) { c.removeFromSuperview(); chevrons[k] = nil }
        for h in secs {
            guard let n = h.section else { continue }
            let c = chevrons[n] ?? { let c = Chevron(); c.onClick = { [weak self] in self?.toggle(n) }; addSubview(c); chevrons[n] = c; return c }()
            c.open = !h.folded
            c.setAccessibilityLabel(h.title)
        }
        contents?.removeFromSuperview(); contents = nil; contentsRows = [:]
        if secs.count >= 3 {
            var rows: [NSView] = [label(t("pg.onThisPage"), Fonts.pt(11.5, .semibold), "tx3")]
            for h in secs {
                guard let n = h.section else { continue }
                let l = label(h.title, Fonts.pt(12.5), h.folded ? "tx3" : "tx2")
                l.lineBreakMode = .byTruncatingTail
                l.toolTip = h.title
                let row = card(l, fill: "card", radius: 5, insets: NSEdgeInsets(top: 3, left: 8, bottom: 3, right: 8)) { [weak self] in self?.scrollTo(n) }
                row.fill = nil
                contentsRows[n] = row
                rows.append(row)
            }
            let col = vstack(rows, spacing: 2)
            col.translatesAutoresizingMaskIntoConstraints = true
            contents = col
            addSubview(col)
        }
        lastW = -1
        needsLayout = true
    }

    /// The text's width, the contents column's x (nil when it has no room) for a width.
    private func columns(_ w: CGFloat) -> (text: CGFloat, contents: CGFloat?) {
        let g = gutter
        if contents != nil && w >= g + DocView.measure * 0.8 + 40 + DocView.contentsW {
            let tw = min(DocView.measure, w - g - 40 - DocView.contentsW)
            return (tw, g + tw + 40)
        }
        return (max(80, min(DocView.measure, w - g)), nil)
    }

    private func measure(_ w: CGFloat) {
        guard let lm = text.layoutManager, let tc = text.textContainer else { return }
        let (tw, cx) = columns(w)
        tc.containerSize = NSSize(width: tw, height: .greatestFiniteMagnitude)
        lm.ensureLayout(for: tc)
        let th = ceil(lm.usedRect(for: tc).height)
        text.frame = NSRect(x: gutter, y: 0, width: tw, height: th)
        var h = th
        if let c = contents {
            c.isHidden = cx == nil
            if let cx {
                let ch = c.fittingSize.height
                c.frame = NSRect(x: cx, y: 0, width: DocView.contentsW, height: ch)
                h = max(h, ch)
            }
        }
        // Each chevron beside its heading's first line.
        for hd in sections {
            guard let n = hd.section, let c = chevrons[n] else { continue }
            let gr = lm.glyphRange(forCharacterRange: NSRange(location: hd.range.location, length: min(1, hd.range.length)), actualCharacterRange: nil)
            let r = lm.boundingRect(forGlyphRange: gr, in: tc)
            c.frame = NSRect(x: 0, y: (r.midY - 8).rounded(), width: 16, height: 16)
        }
        if abs(h - height) > 0.5 { height = h; invalidateIntrinsicContentSize() }
    }

    override var intrinsicContentSize: NSSize {
        if lastW < 0 { measure(bounds.width > 0 ? bounds.width : DocView.measure + gutter) }
        return NSSize(width: NSView.noIntrinsicMetric, height: height)
    }

    override func layout() {
        super.layout()
        if abs(bounds.width - lastW) > 0.5 { lastW = bounds.width; measure(bounds.width) }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        // The boxes are pictures: drawn again in the new colours.
        if boxes.contains(where: { _ in true }) { render() }
    }

    func toggle(_ n: Int) {
        if folded.contains(n) { folded.remove(n) } else { folded.insert(n) }
        onFold?(folded)
        render()
    }

    /// The page scrolled so section `n`'s heading is at the top (unfolded first).
    func scrollTo(_ n: Int) {
        if folded.contains(n) { toggle(n) }
        superview?.layoutSubtreeIfNeeded()
        window?.contentView?.layoutSubtreeIfNeeded()
        guard let h = headings.first(where: { $0.section == n }), let lm = text.layoutManager, let tc = text.textContainer,
              let sv = enclosingScrollView, let docv = sv.documentView else { return }
        let gr = lm.glyphRange(forCharacterRange: NSRange(location: h.range.location, length: min(1, h.range.length)), actualCharacterRange: nil)
        let r = text.convert(lm.boundingRect(forGlyphRange: gr, in: tc), to: docv)
        let maxY = max(0, docv.frame.height - sv.contentView.bounds.height)
        sv.contentView.scroll(to: NSPoint(x: 0, y: min(maxY, max(0, r.minY - 14))))
        sv.reflectScrolledClipView(sv.contentView)
    }

    /// Box `k` pressed: its new state through `onBox`, drawn at once.
    func tick(_ k: Int) {
        guard canTick, k < boxes.count else { return }
        onBox?(k, !boxes[k].done)
    }

    func textView(_ v: NSTextView, clickedOnLink link: Any, at i: Int) -> Bool {
        let s = (link as? URL)?.absoluteString ?? (link as? String) ?? ""
        if s.hasPrefix("rvn-fold:"), let n = Int(s.dropFirst(9)) { toggle(n); return true }
        if s.hasPrefix("rvn-box:"), let k = Int(s.dropFirst(8)) { tick(k); return true }
        if s.hasPrefix("rvn-entry:") { return true }
        clicked.append(s)
        // A session's name: its session, at once (SessionLinks).
        if SessionLinks.shared.openLink(s, from: v) { return true }
        // The web and files beside the document; any other scheme is never opened.
        if s.hasPrefix("http://") || s.hasPrefix("https://") || s.hasPrefix("file:") { Outside.open(s) }
        return true
    }
}

/// A section's fold control: a chevron, down while open.
final class Chevron: NSView {
    var open = true { didSet { needsDisplay = true; setAccessibilityExpanded(open) } }
    var onClick: (() -> Void)?
    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 16, height: 16))
        setAccessibilityElement(true)
        setAccessibilityRole(.disclosureTriangle)
        toolTip = t("pg.foldTip")
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func draw(_ r: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let p = NSBezierPath()
            p.lineWidth = 1.6; p.lineCapStyle = .round; p.lineJoinStyle = .round
            if open { p.move(to: NSPoint(x: 4.5, y: 6.5)); p.line(to: NSPoint(x: 8, y: 10)); p.line(to: NSPoint(x: 11.5, y: 6.5)) }
            else { p.move(to: NSPoint(x: 6.5, y: 4.5)); p.line(to: NSPoint(x: 10, y: 8)); p.line(to: NSPoint(x: 6.5, y: 11.5)) }
            Design.color("tx3").setStroke(); p.stroke()
        }
    }
    override func viewDidChangeEffectiveAppearance() { needsDisplay = true }
    override func mouseDown(with e: NSEvent) { onClick?() }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { onClick?(); return true }
    override func resetCursorRects() { handCursor() }
}

/// A task's dot on an objective's row that ticks it: the task's mark, lit
/// under the pointer, its words and what a press does in its tooltip.
final class TaskDot: NSView {
    let state: String
    let run: () -> Void
    private let mark: Mark
    private var hover = false { didSet { layer?.backgroundColor = hover ? Design.color("card2").cgColor : nil } }
    init(_ state: String, text: String, run: @escaping () -> Void) {
        self.state = state; self.run = run
        mark = Mark.task(state)
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 4
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 19).isActive = true
        heightAnchor.constraint(equalToConstant: 19).isActive = true
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        addSubview(mark)
        NSLayoutConstraint.activate([mark.centerXAnchor.constraint(equalTo: centerXAnchor), mark.centerYAnchor.constraint(equalTo: centerYAnchor)])
        let done = state == "done"
        toolTip = t(done ? "pg.untickTask" : "pg.tickTask", ["task": text])
        setAccessibilityElement(true)
        setAccessibilityRole(.checkBox)
        setAccessibilityLabel(text)
        setAccessibilityValue(done)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for a in trackingAreas { removeTrackingArea(a) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with e: NSEvent) { hover = true }
    override func mouseExited(with e: NSEvent) { hover = false }
    override func resetCursorRects() { handCursor() }
    override func mouseDown(with e: NSEvent) { run() }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { run(); return true }
}
