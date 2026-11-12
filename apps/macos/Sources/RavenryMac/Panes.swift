// A pane in the window (PaneBox: its header and its terminal, and in a
// split its focus ring), a tab's panes as a tree (PaneNode: a pane, or a
// split of two parts, each a pane or a split again, as Rex splits) and
// one split of it (PaneSplitView), as the Electron app draws a split
// (phase2.css .split, .pbox, .phead, .gutter; app.ts layoutSplit): a 6 pt
// divider that is dragged (double click: even), each pane at least 160 pt,
// the pane with the keyboard ringed in blue and the others a little
// dimmed. Every pane has its header, a pane alone in its tab too, with
// Rex's five buttons at its right (split right, split down, move to its
// own tab, zoom, close), greyed when they have nothing to act on.

import AppKit

/// The small line icons of the Electron app (apps/desktop/src/renderer/
/// icons.ts), drawn as paths in a 14 x 14 box.
enum Icons {
    static func shell(_ r: NSRect, _ c: NSColor) {
        stroke(r, c, 1.5) { p in
            p.move(to: NSPoint(x: 2.5, y: 4)); p.line(to: NSPoint(x: 5.5, y: 7)); p.line(to: NSPoint(x: 2.5, y: 10))
            p.move(to: NSPoint(x: 7, y: 10.5)); p.line(to: NSPoint(x: 11.5, y: 10.5))
        }
    }
    static func close(_ r: NSRect, _ c: NSColor) {
        stroke(r, c, 1.5, box: 10) { p in
            p.move(to: NSPoint(x: 2, y: 2)); p.line(to: NSPoint(x: 8, y: 8))
            p.move(to: NSPoint(x: 8, y: 2)); p.line(to: NSPoint(x: 2, y: 8))
        }
    }
    static func plus(_ r: NSRect, _ c: NSColor) {
        stroke(r, c, 1.7) { p in
            p.move(to: NSPoint(x: 7, y: 2)); p.line(to: NSPoint(x: 7, y: 12))
            p.move(to: NSPoint(x: 2, y: 7)); p.line(to: NSPoint(x: 12, y: 7))
        }
    }
    static func split(_ r: NSRect, _ c: NSColor) {
        stroke(r, c, 1.4) { p in
            p.appendRoundedRect(NSRect(x: 1.5, y: 2, width: 11, height: 10), xRadius: 2, yRadius: 2)
            p.move(to: NSPoint(x: 7, y: 2)); p.line(to: NSPoint(x: 7, y: 12))
        }
    }
    /// Split down: the same box, ruled across.
    static func splitDown(_ r: NSRect, _ c: NSColor) {
        stroke(r, c, 1.4) { p in
            p.appendRoundedRect(NSRect(x: 1.5, y: 2, width: 11, height: 10), xRadius: 2, yRadius: 2)
            p.move(to: NSPoint(x: 1.5, y: 7)); p.line(to: NSPoint(x: 12.5, y: 7))
        }
    }
    /// Move to its own tab (Rex's two squares): a square with another behind it.
    static func ownTab(_ r: NSRect, _ c: NSColor) {
        stroke(r, c, 1.4) { p in
            p.appendRoundedRect(NSRect(x: 1.5, y: 4.5, width: 8, height: 8), xRadius: 1.6, yRadius: 1.6)
            p.move(to: NSPoint(x: 4.5, y: 4.5)); p.line(to: NSPoint(x: 4.5, y: 3.1))
            p.appendArc(from: NSPoint(x: 4.5, y: 1.5), to: NSPoint(x: 6.1, y: 1.5), radius: 1.6)
            p.line(to: NSPoint(x: 10.9, y: 1.5))
            p.appendArc(from: NSPoint(x: 12.5, y: 1.5), to: NSPoint(x: 12.5, y: 3.1), radius: 1.6)
            p.line(to: NSPoint(x: 12.5, y: 7.9))
            p.appendArc(from: NSPoint(x: 12.5, y: 9.5), to: NSPoint(x: 10.9, y: 9.5), radius: 1.6)
            p.line(to: NSPoint(x: 9.5, y: 9.5))
        }
    }
    /// Zoom: two arrows out to the corners.
    static func zoom(_ r: NSRect, _ c: NSColor) {
        stroke(r, c, 1.5) { p in
            p.move(to: NSPoint(x: 8.5, y: 1.8)); p.line(to: NSPoint(x: 12.2, y: 1.8)); p.line(to: NSPoint(x: 12.2, y: 5.5))
            p.move(to: NSPoint(x: 12.2, y: 1.8)); p.line(to: NSPoint(x: 8.2, y: 5.8))
            p.move(to: NSPoint(x: 5.5, y: 12.2)); p.line(to: NSPoint(x: 1.8, y: 12.2)); p.line(to: NSPoint(x: 1.8, y: 8.5))
            p.move(to: NSPoint(x: 1.8, y: 12.2)); p.line(to: NSPoint(x: 5.8, y: 8.2))
        }
    }
    /// Zoomed (Show all panes): the arrows pointing back in.
    static func unzoom(_ r: NSRect, _ c: NSColor) {
        stroke(r, c, 1.5) { p in
            p.move(to: NSPoint(x: 8.4, y: 2.2)); p.line(to: NSPoint(x: 8.4, y: 5.6)); p.line(to: NSPoint(x: 11.8, y: 5.6))
            p.move(to: NSPoint(x: 8.4, y: 5.6)); p.line(to: NSPoint(x: 12.3, y: 1.7))
            p.move(to: NSPoint(x: 5.6, y: 11.8)); p.line(to: NSPoint(x: 5.6, y: 8.4)); p.line(to: NSPoint(x: 2.2, y: 8.4))
            p.move(to: NSPoint(x: 5.6, y: 8.4)); p.line(to: NSPoint(x: 1.7, y: 12.3))
        }
    }
    /// The session panel's fold (icons.ts PANEL): a window with its right part ruled off.
    static func panel(_ r: NSRect, _ c: NSColor) {
        stroke(r, c, 1.5, box: 16) { p in
            p.appendRoundedRect(NSRect(x: 1, y: 2, width: 14, height: 12), xRadius: 2.5, yRadius: 2.5)
            p.move(to: NSPoint(x: 10.5, y: 2)); p.line(to: NSPoint(x: 10.5, y: 14))
        }
    }
    /// The sidebar's fold: the same window, its left part ruled off.
    static func sidebar(_ r: NSRect, _ c: NSColor) {
        stroke(r, c, 1.5, box: 16) { p in
            p.appendRoundedRect(NSRect(x: 1, y: 2, width: 14, height: 12), xRadius: 2.5, yRadius: 2.5)
            p.move(to: NSPoint(x: 5.5, y: 2)); p.line(to: NSPoint(x: 5.5, y: 14))
        }
    }
    /// Draws a path given in a box x box space (y down) into r.
    private static func stroke(_ r: NSRect, _ c: NSColor, _ w: CGFloat, box: CGFloat = 14, _ build: (NSBezierPath) -> Void) {
        let p = NSBezierPath()
        build(p)
        let k = r.width / box
        p.transform(using: AffineTransform(m11: k, m12: 0, m21: 0, m22: k, tX: r.minX, tY: r.minY))
        p.lineWidth = w * r.width / box
        p.lineCapStyle = .round
        p.lineJoinStyle = .round
        c.setStroke()
        p.stroke()
    }
}

/// A small borderless button that draws one of the icons, its background
/// on hover (.tab .x, .phead .x).
final class IconButton: NSView {
    var draw: (NSRect, NSColor) -> Void
    var color: NSColor
    var hoverColor: NSColor
    var hoverFill: NSColor
    var iconSize: CGFloat
    var action: (() -> Void)?
    private var hover = false

    init(size: CGFloat, iconSize: CGFloat, color: NSColor, hoverColor: NSColor, hoverFill: NSColor, draw: @escaping (NSRect, NSColor) -> Void) {
        self.draw = draw
        self.color = color
        self.hoverColor = hoverColor
        self.hoverFill = hoverFill
        self.iconSize = iconSize
        super.init(frame: NSRect(x: 0, y: 0, width: size, height: size))
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways], owner: self))
    }
    override func mouseEntered(with e: NSEvent) { hover = true; needsDisplay = true }
    override func mouseExited(with e: NSEvent) { hover = false; needsDisplay = true }
    override func mouseDown(with e: NSEvent) {}
    override func resetCursorRects() { handCursor() }
    override func mouseUp(with e: NSEvent) {
        if bounds.contains(convert(e.locationInWindow, from: nil)) { action?() }
    }
    override func accessibilityPerformPress() -> Bool { action?(); return true }

    override func draw(_ dirty: NSRect) {
        if hover {
            hoverFill.setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 4, yRadius: 4).fill()
        }
        let s = iconSize
        draw(NSRect(x: (bounds.width - s) / 2, y: (bounds.height - s) / 2, width: s, height: s), hover ? hoverColor : color)
    }
}

/// A view drawn over others that takes no press (a pane's focus ring):
/// the press, and the pointer, are the view's under it.
final class PassView: NSView {
    override func hitTest(_ p: NSPoint) -> NSView? { nil }
}

/// A tab's panes: one pane, or a split in two parts (side by side, or one
/// over the other), each a pane or a split again, to any depth that keeps
/// each pane at its minimum size (Workspace.splitRefusal).
final class PaneNode {
    /// A pane: its id. nil for a split.
    private(set) var pane: String?
    /// A split: side by side (true) or one over the other.
    private(set) var across = true
    /// The first part's share of the split's space, 0 to 1.
    var fraction: CGFloat = 0.5
    private(set) var first: PaneNode?
    private(set) var second: PaneNode?
    private(set) weak var parent: PaneNode?

    init(pane: String) { self.pane = pane }
    init(across: Bool, first: PaneNode, second: PaneNode, fraction: CGFloat = 0.5) {
        self.across = across
        self.fraction = fraction
        self.first = first
        self.second = second
        first.parent = self
        second.parent = self
    }

    var isSplit: Bool { pane == nil }
    /// The other part of its split.
    var sibling: PaneNode? { parent.flatMap { $0.first === self ? $0.second : $0.first } }
    /// Its panes, left to right and top to bottom.
    var leaves: [String] { pane.map { [$0] } ?? ((first?.leaves ?? []) + (second?.leaves ?? [])) }
    /// The node of a pane under it.
    func node(of id: String) -> PaneNode? {
        if pane == id { return self }
        return first?.node(of: id) ?? second?.node(of: id)
    }
    /// Every split under it, itself first.
    var splits: [PaneNode] { isSplit ? [self] + (first?.splits ?? []) + (second?.splits ?? []) : [] }

    /// This pane becomes a split of itself and a new pane, the new one on
    /// `side` (right, left, down or up), half and half.
    func split(adding id: String, side: String) {
        guard let p = pane else { return }
        let old = PaneNode(pane: p), new = PaneNode(pane: id)
        let newFirst = side == "left" || side == "up"
        set(across: side == "right" || side == "left", first: newFirst ? new : old, second: newFirst ? old : new, fraction: 0.5)
    }

    /// The same as split(adding:side:), with a whole tree (a tab dropped onto this pane).
    func split(adding tree: PaneNode, side: String) {
        guard let p = pane else { return }
        let old = PaneNode(pane: p)
        let newFirst = side == "left" || side == "up"
        set(across: side == "right" || side == "left", first: newFirst ? tree : old, second: newFirst ? old : tree, fraction: 0.5)
    }

    /// A pane in another's place (a move's new pane), the splits as they were.
    func replace(_ old: String, with new: String) {
        guard let n = node(of: old) else { return }
        n.pane = new
    }

    /// Takes a pane out: its split's other part takes the split's place.
    /// False when it is the only pane (the tab goes instead).
    @discardableResult
    func remove(_ id: String) -> Bool {
        guard let n = node(of: id), let par = n.parent, let other = par.first === n ? par.second : par.first else { return false }
        par.become(other)
        return true
    }

    private func become(_ o: PaneNode) {
        if let p = o.pane {
            pane = p
            first = nil
            second = nil
        } else if let a = o.first, let b = o.second {
            set(across: o.across, first: a, second: b, fraction: o.fraction)
        }
    }

    private func set(across: Bool, first a: PaneNode, second b: PaneNode, fraction: CGFloat) {
        pane = nil
        self.across = across
        self.fraction = fraction
        first = a
        second = b
        a.parent = self
        b.parent = self
    }

    /// How many panes it lays side by side (across) or one over the other.
    func count(across a: Bool) -> Int {
        guard isSplit, let f = first, let s = second else { return 1 }
        return across == a ? f.count(across: a) + s.count(across: a) : max(f.count(across: a), s.count(across: a))
    }
    /// Even: each pane of a row (or column) of splits the same size.
    var evenFraction: CGFloat {
        guard isSplit, let f = first, let s = second else { return 0.5 }
        let a = CGFloat(f.count(across: across)), b = CGFloat(s.count(across: across))
        return a / (a + b)
    }

    /// Where each pane lies in a rectangle (y down), the shares as the
    /// views lay them out (PaneSplitView.layoutPanes, without the minimums).
    func rects(in r: NSRect, gutter: CGFloat) -> [String: NSRect] {
        if let p = pane { return [p: r] }
        guard let f = first, let s = second else { return [:] }
        if across {
            let avail = max(0, r.width - gutter), a = round(avail * fraction)
            return f.rects(in: NSRect(x: r.minX, y: r.minY, width: a, height: r.height), gutter: gutter)
                .merging(s.rects(in: NSRect(x: r.minX + a + gutter, y: r.minY, width: avail - a, height: r.height), gutter: gutter)) { a, _ in a }
        }
        let avail = max(0, r.height - gutter), a = round(avail * fraction)
        return f.rects(in: NSRect(x: r.minX, y: r.minY, width: r.width, height: a), gutter: gutter)
            .merging(s.rects(in: NSRect(x: r.minX, y: r.minY + a + gutter, width: r.width, height: avail - a), gutter: gutter)) { a, _ in a }
    }

    /// Its smallest size, a pane's being `leaf`.
    func minSize(leaf: NSSize, gutter: CGFloat) -> NSSize {
        guard isSplit, let f = first?.minSize(leaf: leaf, gutter: gutter), let s = second?.minSize(leaf: leaf, gutter: gutter) else { return leaf }
        return across ? NSSize(width: f.width + gutter + s.width, height: max(f.height, s.height))
            : NSSize(width: max(f.width, s.width), height: f.height + gutter + s.height)
    }

    /// Its shape in a line, "(| a (- b c))": | side by side, - one over the other (the self-test compares them).
    var shape: String {
        if let p = pane { return p }
        return "(\(across ? "|" : "-") \(first?.shape ?? "") \(second?.shape ?? ""))"
    }

    /// As window.json keeps it (Layout.swift `trees`): a pane as "s:<pane>",
    /// a split as {dir: right or down, size: the first part's percent, a, b}.
    var saved: Any {
        if let p = pane { return "s:" + p }
        return ["dir": across ? "right" : "down", "size": Double(round(fraction * 1000) / 10),
                "a": first?.saved ?? "", "b": second?.saved ?? ""] as [String: Any]
    }

    /// A tree from window.json, the panes `have` says are there; a pane
    /// that is gone leaves its split's other part in its place. nil when
    /// none of its panes is there, or it is not one.
    static func from(saved v: Any?, have: (String) -> Bool, depth: Int = 0) -> PaneNode? {
        guard depth < 32 else { return nil }
        if let s = v as? String {
            guard s.hasPrefix("s:") else { return nil }
            let id = String(s.dropFirst(2))
            return !id.isEmpty && have(id) ? PaneNode(pane: id) : nil
        }
        guard let d = v as? [String: Any], let dir = d["dir"] as? String, dir == "right" || dir == "down" else { return nil }
        let a = from(saved: d["a"], have: have, depth: depth + 1), b = from(saved: d["b"], have: have, depth: depth + 1)
        guard let a, let b else { return a ?? b }
        let size = (d["size"] as? NSNumber)?.doubleValue ?? 50
        return PaneNode(across: dir == "right", first: a, second: b, fraction: CGFloat(size > 0 && size < 100 ? size / 100 : 0.5))
    }
}

/// A button of a pane's header (Rex's pane buttons): its icon, a fill on
/// hover, greyed when it has nothing to act on (no press then), lit in the
/// accent while on (Zoom while zoomed). Its colours are read when drawn,
/// so they follow the terminal's theme and the appearance.
final class HeadButton: NSView {
    let kind: String
    var icon: (NSRect, NSColor) -> Void { didSet { needsDisplay = true } }
    let iconSize: CGFloat
    var action: (() -> Void)?
    var enabled = true { didSet { if enabled != oldValue { needsDisplay = true; setAccessibilityEnabled(enabled); window?.invalidateCursorRects(for: self) } } }
    var on = false { didSet { if on != oldValue { needsDisplay = true } } }
    /// The pointer is over it (a test sets it to draw the hover).
    var hover = false { didSet { if hover != oldValue { needsDisplay = true } } }
    /// Each press that acted (the self-test counts them).
    private(set) var presses = 0

    init(kind: String, iconSize: CGFloat = 14, icon: @escaping (NSRect, NSColor) -> Void) {
        self.kind = kind
        self.icon = icon
        self.iconSize = iconSize
        super.init(frame: NSRect(x: 0, y: 0, width: HeadButton.size, height: HeadButton.size))
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityIdentifier("pane." + kind)
    }
    required init?(coder: NSCoder) { fatalError() }

    static let size: CGFloat = 22
    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    /// A press acts even when the window was not the key one (as the strip's buttons).
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways], owner: self))
    }
    override func mouseEntered(with e: NSEvent) { hover = true }
    override func mouseExited(with e: NSEvent) { hover = false }
    override func mouseDown(with e: NSEvent) {}
    override func resetCursorRects() { if enabled { handCursor() } }
    override func mouseUp(with e: NSEvent) {
        if bounds.contains(convert(e.locationInWindow, from: nil)) { press() }
    }
    override func accessibilityPerformPress() -> Bool { press() }
    @discardableResult
    func press() -> Bool {
        guard enabled, let a = action else { return false }
        presses += 1
        a()
        return true
    }

    override func draw(_ dirty: NSRect) {
        let lit = enabled && on
        if lit {
            Design.work.withAlphaComponent(Workspace.dark ? 0.22 : 0.14).setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 4, yRadius: 4).fill()
        } else if hover && enabled {
            Design.headHover.setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 4, yRadius: 4).fill()
        }
        let c = !enabled ? Design.headOff : lit ? Design.work : hover ? Design.tfg : Design.headFg
        let s = iconSize
        icon(NSRect(x: (bounds.width - s) / 2, y: (bounds.height - s) / 2, width: s, height: s), c)
    }
}

/// A pane's smallest size in a split, and a split's (from its panes'):
/// the dividers stop there and a split is refused under it.
protocol PaneSized: NSView {
    var minSize: NSSize { get }
}

/// A pane's place in the window: its header (its name, its buttons), its
/// terminal under it and, in a split, a ring when it has the keyboard.
final class PaneBox: NSView, PaneSized {
    let term: TerminalView
    private let head = PaneHead()
    private let ring = PassView()
    var showsHead = true { didSet { if showsHead != oldValue { needsLayout = true; head.isHidden = !showsHead } } }
    /// One of several panes on screen: the ring when it has the keyboard, dimmed when not.
    var inSplit = false { didSet { update() } }
    var inFocus = false { didSet { update() } }
    var name = "" { didSet { head.name = name } }
    var sub: String? { didSet { head.sub = sub } }
    var badge: String? { didSet { head.badge = badge } }
    /// A session's pane: its state's colour, a dot in the shell icon's place.
    var dot: String? { didSet { head.dot = dot } }
    var headView: PaneHead { head }
    var onClose: (() -> Void)? { didSet { head.close.action = onClose } }
    var onClickHead: (() -> Void)?
    /// After its size changed (the window, a divider): its buttons say again what they can do.
    var onResize: (() -> Void)?

    init(term: TerminalView) {
        self.term = term
        super.init(frame: term.frame)
        wantsLayer = true
        addSubview(term)
        addSubview(head)
        head.onClick = { [weak self] in self?.onClickHead?() }
        ring.wantsLayer = true
        ring.layer?.borderWidth = 1
        ring.isHidden = true
        addSubview(ring)
        term.autoresizingMask = []
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }

    /// In a split: 160 pt across, and its header and the terminal's smallest grid high (at least 160).
    var minSize: NSSize {
        NSSize(width: Design.paneMin, height: max(Design.paneMin, term.minContentSize.height + Design.headHeight))
    }

    private func update() {
        ring.isHidden = !(inSplit && inFocus)
        ring.layer?.borderColor = Design.work.cgColor
        head.focused = inFocus
        term.alphaValue = inSplit && !inFocus ? Design.unfocusedAlpha : 1
    }

    override func layout() {
        super.layout()
        let h = showsHead ? Design.headHeight : 0
        // Only frames that changed: AppKit lays the box out again after
        // setFrameSize did, and the terminal must draw once a step.
        head.setIf(NSRect(x: 0, y: 0, width: bounds.width, height: h))
        term.setIf(NSRect(x: 0, y: h, width: bounds.width, height: max(1, bounds.height - h)))
        ring.setIf(bounds)
        update()
    }

    override func setFrameSize(_ s: NSSize) {
        let was = frame.size
        super.setFrameSize(s)
        // Lay out at once: the terminal draws its new size in this same
        // transaction (a live resize, a divider's drag).
        layout()
        if s != was { onResize?() }
    }
}

/// A pane's header (.phead, and Rex's pane header): the shell icon (a
/// session's dot), the name, "1 of 3" while zoomed, its folder (or, for an
/// agent's own pane, the agent's chip: .phead .ag), and at its right Split
/// right, Split down, Move to its own tab, Zoom and Close.
final class PaneHead: NSView {
    var name = "" { didSet { needsDisplay = true } }
    var sub: String? { didSet { needsDisplay = true } }
    /// An agent's own pane: its assistant ("Claude"), else "Agent", in a chip after the name.
    var badge: String? { didSet { needsDisplay = true; setAccessibilityValue(badge) } }
    /// Where the chip was drawn, for the self-test.
    private(set) var badgeRect: NSRect?
    /// Zoomed: "1 of 3" in the accent after the name (the panes the zoom hides).
    var zoomChip: String? { didSet { if zoomChip != oldValue { needsDisplay = true } } }
    /// A session's pane (its state's colour): a dot instead of the shell icon (app.ts renderPaneHead).
    var dot: String? { didSet { if dot != oldValue { needsDisplay = true } } }
    var focused = false { didSet { needsDisplay = true } }
    var onClick: (() -> Void)?
    let splitRight = HeadButton(kind: "splitRight", icon: Icons.split)
    let splitDown = HeadButton(kind: "splitDown", icon: Icons.splitDown)
    let ownTab = HeadButton(kind: "ownTab", icon: Icons.ownTab)
    let zoom = HeadButton(kind: "zoom", icon: Icons.zoom)
    let close = HeadButton(kind: "close", iconSize: 10, icon: Icons.close)
    var buttons: [HeadButton] { [splitRight, splitDown, ownTab, zoom, close] }

    override init(frame: NSRect) {
        super.init(frame: frame)
        for b in buttons { addSubview(b) }
        close.toolTip = "Close pane (⌘W)"
        close.setAccessibilityLabel("Close pane")
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { true }
    /// Where the buttons start (the name and the folder stop before it).
    private var buttonsX: CGFloat { bounds.width - 6 - CGFloat(buttons.count) * HeadButton.size - CGFloat(buttons.count - 1) * 2 }
    override func layout() {
        super.layout()
        placeButtons()
    }
    override func setFrameSize(_ s: NSSize) {
        super.setFrameSize(s)
        // At once: the buttons sit at the right edge as the pane resizes (no layout pass waits).
        placeButtons()
    }
    private func placeButtons() {
        var x = buttonsX
        for b in buttons {
            b.setIf(NSRect(x: x, y: (bounds.height - HeadButton.size) / 2, width: HeadButton.size, height: HeadButton.size))
            x += HeadButton.size + 2
        }
    }
    override func mouseDown(with e: NSEvent) { onClick?() }

    /// What each button can do now: its words with its key, and why not when it is greyed.
    func set(_ b: HeadButton, enabled: Bool, words: String, why: String? = nil) {
        b.enabled = enabled
        b.toolTip = why.map { words + "\n" + $0 } ?? words
        b.setAccessibilityLabel(words.components(separatedBy: " (").first ?? words)
        b.setAccessibilityHelp(why)
    }

    override func draw(_ dirty: NSRect) {
        Design.tbg.setFill()
        bounds.fill()
        Design.headLine.setFill()
        NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill()
        if let d = dot {
            Design.color(d).setFill()
            NSBezierPath(ovalIn: NSRect(x: 14.5, y: (bounds.height - 7) / 2, width: 7, height: 7)).fill()
        } else {
            Icons.shell(NSRect(x: 12, y: (bounds.height - 12) / 2, width: 12, height: 12), Design.headFg)
        }
        var x: CGFloat = 12 + 12 + 7
        let maxX = buttonsX - 7
        let nameAttrs: [NSAttributedString.Key: Any] = [.font: Design.headNameFont, .foregroundColor: focused ? Design.tfg : Design.headName]
        x = drawText(name, nameAttrs, x: x, maxX: maxX)
        if let z = zoomChip, x < maxX - 40 {
            // Variant A's chip: 10.5 semibold, the accent on its tint.
            let a: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 10.5, weight: .semibold), .foregroundColor: Design.work]
            let sz = NSAttributedString(string: z, attributes: a).size()
            let r = NSRect(x: x + 8, y: floor((bounds.height - sz.height - 2) / 2), width: min(ceil(sz.width) + 12, maxX - x - 8), height: ceil(sz.height) + 2)
            Design.work.withAlphaComponent(Workspace.dark ? 0.22 : 0.14).setFill()
            NSBezierPath(roundedRect: r, xRadius: 4, yRadius: 4).fill()
            _ = drawText(z, a, x: r.minX + 6, maxX: r.maxX - 6)
            x = r.maxX
        }
        badgeRect = nil
        if let b = badge, x < maxX - 30 {
            // .ag: 10.5 semibold, 1 by 6 padding, radius 4, on rgba(191,90,242,.22) in #DA8FFF.
            let a: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 10.5, weight: .semibold), .foregroundColor: NSColor(srgbRed: 0xDA / 255, green: 0x8F / 255, blue: 0xFF / 255, alpha: 1)]
            let sz = NSAttributedString(string: b, attributes: a).size()
            let r = NSRect(x: x + 7, y: floor((bounds.height - sz.height - 2) / 2), width: min(ceil(sz.width) + 12, maxX - x - 7), height: ceil(sz.height) + 2)
            NSColor(srgbRed: 191 / 255, green: 90 / 255, blue: 242 / 255, alpha: 0.22).setFill()
            NSBezierPath(roundedRect: r, xRadius: 4, yRadius: 4).fill()
            _ = drawText(b, a, x: r.minX + 6, maxX: r.maxX - 6)
            badgeRect = r
        } else if let s = sub, x < maxX - 20 {
            _ = drawText(s, [.font: Design.headFont, .foregroundColor: Design.headFg], x: x + 7, maxX: maxX)
        }
    }

    private func drawText(_ s: String, _ a: [NSAttributedString.Key: Any], x: CGFloat, maxX: CGFloat) -> CGFloat {
        let str = NSAttributedString(string: s, attributes: a)
        let size = str.size()
        let w = min(size.width, max(0, maxX - x))
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byTruncatingTail
        let m = NSMutableAttributedString(attributedString: str)
        m.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: m.length))
        m.draw(with: NSRect(x: x, y: (bounds.height - size.height) / 2, width: w, height: size.height), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        return x + w
    }
}

/// One split of a tab (a PaneNode's): two parts, each a pane or a split
/// again. `fraction` is the first part's share, kept as the window
/// resizes; a drag of the divider changes it, never past either part's
/// smallest size.
final class PaneSplitView: NSSplitView, NSSplitViewDelegate, PaneSized {
    var fraction: CGFloat = 0.5
    /// What a double click evens it to (each pane of a row the same size).
    var evenFraction: CGFloat = 0.5
    /// The divider was dragged or double-clicked: the new fraction.
    var onFraction: ((CGFloat) -> Void)?
    /// Every pane under it, in its nested splits too.
    var boxes: [PaneBox] { arrangedSubviews.flatMap { v -> [PaneBox] in (v as? PaneBox).map { [$0] } ?? (v as? PaneSplitView)?.boxes ?? [] } }
    private(set) var dragging = false
    private var hover = false

    init(vertical: Bool, first: NSView, second: NSView, fraction: CGFloat) {
        self.fraction = fraction
        super.init(frame: .zero)
        isVertical = vertical
        dividerStyle = .thin
        delegate = self
        addArrangedSubview(first)
        addArrangedSubview(second)
        setAccessibilityLabel("Split")
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var dividerThickness: CGFloat { Design.gutter }
    override var mouseDownCanMoveWindow: Bool { false }

    /// Its parts' smallest sizes, with the divider.
    var minSize: NSSize {
        let m = arrangedSubviews.map { ($0 as? PaneSized)?.minSize ?? NSSize(width: Design.paneMin, height: Design.paneMin) }
        guard m.count == 2 else { return NSSize(width: Design.paneMin, height: Design.paneMin) }
        return isVertical ? NSSize(width: m[0].width + Design.gutter + m[1].width, height: max(m[0].height, m[1].height))
            : NSSize(width: max(m[0].width, m[1].width), height: m[0].height + Design.gutter + m[1].height)
    }
    /// A part's smallest extent along the split.
    private func minExtent(_ i: Int) -> CGFloat {
        guard arrangedSubviews.indices.contains(i) else { return Design.paneMin }
        let m = (arrangedSubviews[i] as? PaneSized)?.minSize ?? NSSize(width: Design.paneMin, height: Design.paneMin)
        return isVertical ? m.width : m.height
    }

    override func drawDivider(in rect: NSRect) {
        (hover || dragging ? Design.work : Design.sep).setFill()
        rect.fill()
    }

    private var dividerRect: NSRect {
        guard let a = arrangedSubviews.first else { return .zero }
        return isVertical ? NSRect(x: a.frame.maxX, y: 0, width: dividerThickness, height: bounds.height)
            : NSRect(x: 0, y: a.frame.maxY, width: bounds.width, height: dividerThickness)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.filter { $0.userInfo?["divider"] != nil }.forEach(removeTrackingArea)
        let r = dividerRect.insetBy(dx: isVertical ? -2 : 0, dy: isVertical ? 0 : -2)
        addTrackingArea(NSTrackingArea(rect: r, options: [.mouseEnteredAndExited, .activeInKeyWindow], owner: self, userInfo: ["divider": true]))
        // What the divider does, as the Electron app's gutter says it.
        removeAllToolTips()
        addToolTip(r, owner: PaneSplitView.dividerTip as NSString, userData: nil)
    }
    static let dividerTip = t("split.dividerTip")
    override func mouseEntered(with e: NSEvent) { hover = true; setNeedsDisplay(dividerRect) }
    override func mouseExited(with e: NSEvent) { hover = false; setNeedsDisplay(dividerRect) }

    /// The panes draw in the window's transaction while the divider
    /// moves, so their content never lags its frame.
    func beginDrag() {
        dragging = true
        boxes.forEach { $0.term.splitDragging = true }
    }
    func endDrag() {
        dragging = false
        boxes.forEach { $0.term.splitDragging = false }
        updateTrackingAreas()
        setNeedsDisplay(bounds)
        onFraction?(fraction)
    }

    override func mouseDown(with e: NSEvent) {
        let p = convert(e.locationInWindow, from: nil)
        guard dividerRect.insetBy(dx: -2, dy: -2).contains(p) else { super.mouseDown(with: e); return }
        if e.clickCount == 2 {
            equalize()
            return
        }
        beginDrag()
        super.mouseDown(with: e) // AppKit's own tracking, until the button is up
        endDrag()
    }

    /// Even (a double click on the divider): each pane of the row the same size.
    func equalize() {
        setFraction(evenFraction)
        onFraction?(fraction)
    }

    /// Moves the divider to a share of the space (the bench's drag goes
    /// through here, as AppKit's tracking goes through setPosition).
    func setFraction(_ f: CGFloat) {
        fraction = f
        let avail = (isVertical ? bounds.width : bounds.height) - dividerThickness
        guard avail > 0 else { return }
        setPosition(round(avail * f), ofDividerAt: 0)
    }

    func splitView(_ s: NSSplitView, constrainMinCoordinate p: CGFloat, ofSubviewAt i: Int) -> CGFloat { minExtent(0) }
    func splitView(_ s: NSSplitView, constrainMaxCoordinate p: CGFloat, ofSubviewAt i: Int) -> CGFloat {
        (isVertical ? bounds.width : bounds.height) - dividerThickness - minExtent(1)
    }
    func splitView(_ s: NSSplitView, canCollapseSubview v: NSView) -> Bool { false }

    /// A new size of the split (the window's): each part keeps its share.
    func splitView(_ s: NSSplitView, resizeSubviewsWithOldSize old: NSSize) {
        layoutPanes()
    }

    /// Each part at its share, kept at its smallest size while there is room for both.
    func layoutPanes() {
        let views = arrangedSubviews
        guard views.count == 2 else { return }
        let d = dividerThickness
        let avail = max(0, (isVertical ? bounds.width : bounds.height) - d)
        var a = round(avail * fraction)
        let lo = minExtent(0), hi = avail - minExtent(1)
        if lo <= hi { a = min(max(a, lo), hi) }
        if isVertical {
            views[0].setIf(NSRect(x: 0, y: 0, width: a, height: bounds.height))
            views[1].setIf(NSRect(x: a + d, y: 0, width: max(0, avail - a), height: bounds.height))
        } else {
            views[0].setIf(NSRect(x: 0, y: 0, width: bounds.width, height: a))
            views[1].setIf(NSRect(x: 0, y: a + d, width: bounds.width, height: max(0, avail - a)))
        }
        for v in views { (v as? PaneSplitView)?.layoutPanes() }
    }

    func splitViewDidResizeSubviews(_ n: Notification) {
        // The divider dragged: the share follows. (AppKit also moves it
        // when the window is too small for both panes' minimum; the share
        // stays then, and comes back as the window grows.)
        guard let a = arrangedSubviews.first else { return }
        let avail = (isVertical ? bounds.width : bounds.height) - dividerThickness
        if dragging && avail > 0 && n.userInfo?["NSSplitViewDividerIndex"] != nil {
            fraction = (isVertical ? a.frame.width : a.frame.height) / avail
        }
        updateTrackingAreas()
    }
}

/// A tab dragged over the pane in front (Workspace.dragOver, the Electron
/// app's .dropzone): the half it would take lit in the accent, with "Split
/// right" and the split icon in a pill; grey with the reason when the tab
/// in front cannot take it.
final class SplitDropView: NSView {
    private(set) var side = "right"
    private(set) var words = ""
    private(set) var refused = false
    override var isFlipped: Bool { true }
    override func hitTest(_ p: NSPoint) -> NSView? { nil }

    func show(side: String, words: String, refused: Bool) {
        guard side != self.side || words != self.words || refused != self.refused else { return }
        self.side = side
        self.words = words
        self.refused = refused
        setAccessibilityLabel(words)
        needsDisplay = true
    }

    /// The half of the stage it lights, 4 pt in from its edges.
    var zone: NSRect {
        let b = bounds
        var r: NSRect
        switch side {
        case "left": r = NSRect(x: 0, y: 0, width: b.width / 2 - 8, height: b.height)
        case "up": r = NSRect(x: 0, y: 0, width: b.width, height: b.height / 2 - 8)
        case "down": r = NSRect(x: 0, y: b.height / 2 + 8, width: b.width, height: b.height / 2 - 8)
        default: r = NSRect(x: b.width / 2 + 8, y: 0, width: b.width / 2 - 8, height: b.height)
        }
        return r.insetBy(dx: 4, dy: 4)
    }

    override func draw(_ dirty: NSRect) {
        let z = zone
        let p = NSBezierPath(roundedRect: z, xRadius: 8, yRadius: 8)
        (refused ? NSColor(white: 0.5, alpha: 0.12) : NSColor(srgbRed: 10 / 255, green: 132 / 255, blue: 1, alpha: 0.16)).setFill()
        p.fill()
        let ring = NSBezierPath(roundedRect: z.insetBy(dx: 1, dy: 1), xRadius: 7, yRadius: 7)
        ring.lineWidth = 2
        (refused ? Design.color("tx3") : Design.work).setStroke()
        ring.stroke()
        // The pill: the split icon (not when refused) and the words.
        let a = NSAttributedString(string: words, attributes: [.font: NSFont.systemFont(ofSize: 12.5, weight: .semibold),
                                                               .foregroundColor: refused ? Design.tx2 : NSColor.white])
        let ts = a.size()
        let iw: CGFloat = refused ? 0 : 12 + 6
        let pill = NSRect(x: z.midX - (ts.width + iw + 20) / 2, y: z.midY - 13, width: ts.width + iw + 20, height: 26)
        (refused ? Design.color("card2") : Design.work).setFill()
        NSBezierPath(roundedRect: pill, xRadius: 6, yRadius: 6).fill()
        if !refused { Icons.split(NSRect(x: pill.minX + 10, y: pill.midY - 6, width: 12, height: 12), .white) }
        a.draw(at: NSPoint(x: pill.minX + 10 + iw, y: pill.midY - ts.height / 2))
    }
}

/// A one-time hint (the Electron app's .hint): a blue card under the thing
/// itself the first time it happens, its words, Learn more and an x, an
/// arrow pointing at the thing. Dismissed either way, never again (the
/// hub's onboarding marks, hints).
final class HintView: NSView {
    let text = NSTextField(wrappingLabelWithString: "")
    let learn = NSButton(title: t("hint.learnMore"), target: nil, action: nil)
    let close = IconButton(size: 18, iconSize: 9, color: .white, hoverColor: .white, hoverFill: NSColor(white: 1, alpha: 0.2), draw: Icons.close)
    var onLearn: (() -> Void)?
    var onDismiss: (() -> Void)?
    /// Where the arrow sits from the left, pointing up at the thing.
    var arrowX: CGFloat = 24 { didSet { needsDisplay = true } }
    override var isFlipped: Bool { true }
    override init(frame: NSRect) {
        super.init(frame: frame)
        text.font = Fonts.pt(12.5)
        text.textColor = .white
        text.maximumNumberOfLines = 0
        learn.isBordered = false
        learn.attributedTitle = NSAttributedString(string: t("hint.learnMore"), attributes: [.font: Fonts.pt(12.5, .semibold), .foregroundColor: NSColor.white, .underlineStyle: NSUnderlineStyle.single.rawValue])
        learn.target = self
        learn.action = #selector(learnClicked)
        close.toolTip = t("hint.dismiss")
        close.setAccessibilityLabel(t("hint.dismiss"))
        close.action = { [weak self] in self?.onDismiss?() }
        for v in [text, learn, close] as [NSView] { addSubview(v) }
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc private func learnClicked() { onLearn?() }

    func set(bold: String, rest: String) {
        let a = NSMutableAttributedString(string: bold, attributes: [.font: Fonts.pt(12.5, .semibold), .foregroundColor: NSColor.white])
        a.append(NSAttributedString(string: rest, attributes: [.font: Fonts.pt(12.5), .foregroundColor: NSColor.white]))
        text.attributedStringValue = a
        setAccessibilityLabel(bold + rest)
    }

    /// Its height at a width (the words wrap).
    func height(for w: CGFloat) -> CGFloat {
        let lw = learn.fittingSize.width
        let tw = max(60, w - 12 - 12 - lw - 12 - 18 - 10)
        let th = text.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: tw, height: 1000)).height ?? 18
        return max(36, ceil(th) + 18) + 5
    }

    override func layout() {
        super.layout()
        let lw = learn.fittingSize.width
        let body = NSRect(x: 0, y: 5, width: bounds.width, height: bounds.height - 5)
        close.frame = NSRect(x: body.maxX - 10 - 18, y: body.midY - 9, width: 18, height: 18)
        learn.frame = NSRect(x: close.frame.minX - 12 - lw, y: body.midY - 10, width: lw, height: 20)
        let tw = max(60, learn.frame.minX - 12 - 12)
        let th = text.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: tw, height: 1000)).height ?? 18
        text.frame = NSRect(x: 12, y: body.midY - ceil(th) / 2, width: tw, height: ceil(th))
    }

    override func draw(_ dirty: NSRect) {
        Design.work.setFill()
        NSBezierPath(roundedRect: NSRect(x: 0, y: 5, width: bounds.width, height: bounds.height - 5), xRadius: 9, yRadius: 9).fill()
        let a = NSBezierPath()
        let x = min(max(14, arrowX), bounds.width - 14)
        a.move(to: NSPoint(x: x - 6, y: 6)); a.line(to: NSPoint(x: x, y: 0)); a.line(to: NSPoint(x: x + 6, y: 6)); a.close()
        a.fill()
    }
}
