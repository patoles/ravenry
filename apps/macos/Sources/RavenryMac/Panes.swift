// A pane in the window (PaneBox: its terminal, and in a split its header
// and focus ring) and a tab split in two (PaneSplitView), as the Electron
// app has them (phase2.css .split, .pbox, .phead, .gutter; app.ts
// layoutSplit): one split per tab, a 6 pt divider that is dragged
// (double click: even), each pane at least 160 pt, the pane with the
// keyboard ringed in blue and the other a little dimmed.

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

/// A pane's place in the window: its terminal and, in a split, a header
/// above it (its name, a close x) and a ring when it has the keyboard.
final class PaneBox: NSView {
    let term: TerminalView
    private let head = PaneHead()
    private let ring = NSView()
    var showsHead = false { didSet { if showsHead != oldValue { needsLayout = true; head.isHidden = !showsHead } } }
    var inFocus = false { didSet { update() } }
    var name = "" { didSet { head.name = name } }
    var sub: String? { didSet { head.sub = sub } }
    var onClose: (() -> Void)? { didSet { head.close.action = onClose } }
    var onClickHead: (() -> Void)?

    init(term: TerminalView) {
        self.term = term
        super.init(frame: term.frame)
        wantsLayer = true
        addSubview(term)
        addSubview(head)
        head.isHidden = true
        head.onClick = { [weak self] in self?.onClickHead?() }
        ring.wantsLayer = true
        ring.layer?.borderWidth = 1
        ring.isHidden = true
        addSubview(ring)
        term.autoresizingMask = []
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }

    private func update() {
        ring.isHidden = !(showsHead && inFocus)
        ring.layer?.borderColor = Design.work.cgColor
        head.focused = inFocus
        term.alphaValue = showsHead && !inFocus ? Design.unfocusedAlpha : 1
    }

    override func layout() {
        super.layout()
        let h = showsHead ? Design.headHeight : 0
        head.frame = NSRect(x: 0, y: 0, width: bounds.width, height: h)
        term.frame = NSRect(x: 0, y: h, width: bounds.width, height: max(1, bounds.height - h))
        ring.frame = bounds
        update()
    }

    override func setFrameSize(_ s: NSSize) {
        super.setFrameSize(s)
        // Lay out at once: the terminal draws its new size in this same
        // transaction (a live resize, a divider's drag).
        layout()
    }
}

/// A split pane's header (.phead): the shell icon, the name, its folder,
/// and the close x on the right.
final class PaneHead: NSView {
    var name = "" { didSet { needsDisplay = true } }
    var sub: String? { didSet { needsDisplay = true } }
    var focused = false { didSet { needsDisplay = true } }
    var onClick: (() -> Void)?
    let close = IconButton(size: 18, iconSize: 10, color: Design.headFg, hoverColor: Design.termFg,
                           hoverFill: NSColor(white: 0.82, alpha: 0.14), draw: Icons.close)

    override init(frame: NSRect) {
        super.init(frame: frame)
        addSubview(close)
        close.toolTip = "Close pane (⌘W)"
        close.setAccessibilityLabel("Close pane")
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { true }
    override func layout() {
        super.layout()
        close.frame = NSRect(x: bounds.width - 8 - 18, y: (bounds.height - 18) / 2, width: 18, height: 18)
    }
    override func mouseDown(with e: NSEvent) { onClick?() }

    override func draw(_ dirty: NSRect) {
        Design.tbg.setFill()
        bounds.fill()
        Design.headLine.setFill()
        NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill()
        Icons.shell(NSRect(x: 12, y: (bounds.height - 12) / 2, width: 12, height: 12), Design.headFg)
        var x: CGFloat = 12 + 12 + 7
        let maxX = bounds.width - 8 - 18 - 7
        let nameAttrs: [NSAttributedString.Key: Any] = [.font: Design.headNameFont, .foregroundColor: focused ? Design.tfg : Design.headName]
        x = drawText(name, nameAttrs, x: x, maxX: maxX)
        if let s = sub, x < maxX - 20 {
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

/// A tab split in two. `fraction` is the first pane's share (the host's,
/// or the guest's when it is on the left or above), kept as the window
/// resizes; a drag of the divider changes it.
final class PaneSplitView: NSSplitView, NSSplitViewDelegate {
    var fraction: CGFloat = 0.5
    /// The divider was dragged or double-clicked: the new fraction.
    var onFraction: ((CGFloat) -> Void)?
    var boxes: [PaneBox] { arrangedSubviews.compactMap { $0 as? PaneBox } }
    private(set) var dragging = false
    private var hover = false

    init(vertical: Bool, first: PaneBox, second: PaneBox, fraction: CGFloat) {
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
        addTrackingArea(NSTrackingArea(rect: dividerRect.insetBy(dx: isVertical ? -2 : 0, dy: isVertical ? 0 : -2),
                                       options: [.mouseEnteredAndExited, .activeInKeyWindow], owner: self, userInfo: ["divider": true]))
    }
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

    /// Even: half and half (a double click on the divider).
    func equalize() {
        setFraction(0.5)
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

    func splitView(_ s: NSSplitView, constrainMinCoordinate p: CGFloat, ofSubviewAt i: Int) -> CGFloat { Design.paneMin }
    func splitView(_ s: NSSplitView, constrainMaxCoordinate p: CGFloat, ofSubviewAt i: Int) -> CGFloat {
        (isVertical ? bounds.width : bounds.height) - dividerThickness - Design.paneMin
    }
    func splitView(_ s: NSSplitView, canCollapseSubview v: NSView) -> Bool { false }

    /// A new size of the split (the window's): each pane keeps its share.
    func splitView(_ s: NSSplitView, resizeSubviewsWithOldSize old: NSSize) {
        layoutPanes()
    }

    func layoutPanes() {
        let views = arrangedSubviews
        guard views.count == 2 else { return }
        let d = dividerThickness
        if isVertical {
            let avail = max(0, bounds.width - d)
            let a = round(avail * fraction)
            views[0].frame = NSRect(x: 0, y: 0, width: a, height: bounds.height)
            views[1].frame = NSRect(x: a + d, y: 0, width: max(0, avail - a), height: bounds.height)
        } else {
            let avail = max(0, bounds.height - d)
            let a = round(avail * fraction)
            views[0].frame = NSRect(x: 0, y: 0, width: bounds.width, height: a)
            views[1].frame = NSRect(x: 0, y: a + d, width: bounds.width, height: max(0, avail - a))
        }
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
