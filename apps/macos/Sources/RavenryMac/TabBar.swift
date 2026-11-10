// The tab strip, as the Electron app draws it (app.css .tabs, .tab;
// app.ts renderTabs): 40 pt high on the sheet's colour with a line under
// it, each tab 32 pt high with its top corners rounded, the tab in front
// in the terminal's colours so it joins its terminal. A tab shows the
// shell icon, its name, its folder in grey when that says more, "2" with
// the split icon when split, and a close x (on hover, and always on the
// tab in front). The + after the last tab opens a shell. A click brings a
// tab to the front, a middle click closes it, a drag moves it along the
// strip (the others make room as it passes them). When the tabs crowd,
// the folders go first, then the tabs narrow. The strip sits in the
// window's title bar, after its buttons; its empty part moves the window
// and a double click there zooms it, as a title bar does.

import AppKit

struct TabModel: Equatable {
    var id: String
    var name: String
    var sub: String?
    var split: Bool
    var active: Bool
    var tip: String
    /// A session's tab (the middle shows it, Board.swift): its dot in its
    /// state's colour in the shell icon's place.
    var dot: String? = nil
}

final class TabBar: NSView {
    var onSelect: ((String) -> Void)?
    var onClose: ((String) -> Void)?
    var onNew: (() -> Void)?
    /// Left of the first tab: the window's buttons when the strip is the
    /// window's top (Design.stripLead), else the .tabs padding (8).
    var lead: CGFloat = Design.stripLead { didSet { if lead != oldValue { needsLayout = true } } }
    /// A tab dragged to another place: its id and its new index.
    var onMove: ((String, Int) -> Void)?

    private(set) var items: [TabItem] = []
    let plus = IconButton(size: 32, iconSize: 12, color: Design.tx2, hoverColor: Design.tx, hoverFill: .clear, draw: Icons.plus)
    private var models: [TabModel] = []
    private var dragged: TabItem?
    private var dragOffset: CGFloat = 0

    override init(frame: NSRect) {
        super.init(frame: frame)
        addSubview(plus)
        plus.toolTip = "New shell (⌘T)"
        plus.setAccessibilityLabel("New shell")
        plus.action = { [weak self] in self?.onNew?() }
        setAccessibilityElement(true)
        setAccessibilityRole(.tabGroup)
        setAccessibilityLabel("Tabs")
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { true }

    func set(_ tabs: [TabModel]) {
        guard tabs != models || items.count != tabs.count else { return }
        models = tabs
        // Reuse the items by id, so a hover or a drag survives.
        var byId = Dictionary(items.map { ($0.model.id, $0) }, uniquingKeysWith: { a, _ in a })
        var next: [TabItem] = []
        for m in tabs {
            let it = byId.removeValue(forKey: m.id) ?? makeItem()
            it.model = m
            next.append(it)
        }
        for (_, gone) in byId { gone.removeFromSuperview() }
        items = next
        for it in items where it.superview == nil { addSubview(it, positioned: .below, relativeTo: plus) }
        setAccessibilityChildren(items + [plus])
        layoutTabs(animated: false)
    }

    private func makeItem() -> TabItem {
        let it = TabItem()
        it.bar = self
        return it
    }

    override func layout() {
        super.layout()
        layoutTabs(animated: false)
    }

    /// Each tab's width: its content, at most 240 pt; without the folders
    /// when they do not all fit, then narrower, all alike.
    private func widths() -> [CGFloat] {
        let avail = bounds.width - lead - 8 - 32 - 6
        var w = items.map { $0.idealWidth(withSub: true) }
        let gaps = CGFloat(max(0, items.count - 1)) * Design.tabGap
        if w.reduce(0, +) + gaps > avail { w = items.map { $0.idealWidth(withSub: false) } }
        let total = w.reduce(0, +) + gaps
        if total > avail && !w.isEmpty {
            let each = max(72, (avail - gaps) / CGFloat(w.count))
            w = w.map { min($0, each) }
        }
        items.forEach { $0.showSub = true }
        for (i, it) in items.enumerated() where w[i] < it.idealWidth(withSub: true) { it.showSub = false }
        return w
    }

    func layoutTabs(animated: Bool) {
        let w = widths()
        var x = lead
        let y = bounds.height - Design.tabHeight
        for (i, it) in items.enumerated() {
            let f = NSRect(x: x, y: y, width: w[i], height: Design.tabHeight)
            if it !== dragged {
                if animated {
                    NSAnimationContext.runAnimationGroup { c in c.duration = 0.15; it.animator().frame = f }
                } else {
                    it.frame = f
                }
            }
            it.slot = f
            x += w[i] + Design.tabGap
        }
        plus.frame = NSRect(x: x, y: y, width: 32, height: Design.tabHeight)
    }

    override func draw(_ dirty: NSRect) {
        Design.sheet.setFill()
        bounds.fill()
        Design.sep.setFill()
        NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill()
    }

    override func mouseUp(with e: NSEvent) {
        // The title bar's double click: the window zooms.
        if e.clickCount == 2 { window?.performZoom(nil) }
    }

    // MARK: dragging a tab along the strip

    func beginDrag(_ it: TabItem, at x: CGFloat) {
        dragged = it
        dragOffset = x - it.frame.minX
        it.removeFromSuperview()
        addSubview(it, positioned: .below, relativeTo: plus) // over the others
        addSubview(plus)
    }

    func drag(_ it: TabItem, to x: CGFloat) {
        guard dragged === it, let i = items.firstIndex(where: { $0 === it }) else { return }
        var f = it.frame
        f.origin.x = min(max(lead, x - dragOffset), max(lead, bounds.width - f.width))
        it.frame = f
        // It takes the place of a tab whose middle it passed.
        let mid = f.midX
        var j = i
        while j > 0 && mid < items[j - 1].slot.midX { j -= 1 }
        while j < items.count - 1 && mid > items[j + 1].slot.midX { j += 1 }
        if j != i {
            items.remove(at: i)
            items.insert(it, at: j)
            layoutTabs(animated: true)
        }
    }

    func endDrag(_ it: TabItem) {
        guard dragged === it else { return }
        dragged = nil
        let to = items.firstIndex(where: { $0 === it }) ?? 0
        it.frame = it.slot
        models = items.map { $0.model }
        onMove?(it.model.id, to)
    }
}

final class TabItem: NSView {
    weak var bar: TabBar?
    var model = TabModel(id: "", name: "", sub: nil, split: false, active: false, tip: "") {
        didSet {
            toolTip = model.tip
            setAccessibilityLabel(model.name)
            setAccessibilityValue(model.active)
            close.isHidden = !(model.active || hover)
            needsDisplay = true
        }
    }
    var showSub = true { didSet { if showSub != oldValue { needsDisplay = true } } }
    /// Its place in the strip (where it goes back to after a drag).
    var slot = NSRect.zero
    let close = IconButton(size: Design.closeSize, iconSize: 10, color: Design.tx3, hoverColor: Design.tx, hoverFill: NSColor(white: 1, alpha: 0.12), draw: Icons.close)
    private var hover = false
    private var downX: CGFloat?
    private var moving = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        addSubview(close)
        close.toolTip = "Close (⌘W)"
        close.setAccessibilityLabel("Close")
        close.action = { [weak self] in
            guard let self else { return }
            self.bar?.onClose?(self.model.id)
        }
        setAccessibilityElement(true)
        setAccessibilityRole(.radioButton)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    private var fg: NSColor { model.active ? Design.tfg : (hover ? Design.tx : Design.tx2) }
    private var fg3: NSColor { model.active ? Design.tfg.withAlphaComponent(0.55) : Design.tx3 }
    private func nameText() -> NSAttributedString { NSAttributedString(string: model.name, attributes: [.font: Design.tabFont, .foregroundColor: fg]) }
    private func subText() -> NSAttributedString? { model.sub.map { NSAttributedString(string: $0, attributes: [.font: Design.tabFont, .foregroundColor: fg3]) } }
    private static let badge = NSAttributedString(string: "2", attributes: [.font: Design.tabFont])

    func idealWidth(withSub: Bool) -> CGFloat {
        var w = Design.tabPadLeft + 12 + Design.tabInnerGap + ceil(nameText().size().width)
        if withSub, let s = subText() { w += Design.tabInnerGap + ceil(s.size().width) }
        if model.split { w += Design.tabInnerGap + 11 + 3 + ceil(TabItem.badge.size().width) }
        w += Design.tabInnerGap + Design.closeSize + Design.tabPadRight
        return min(Design.tabMaxWidth, w)
    }

    override func layout() {
        super.layout()
        close.frame = NSRect(x: bounds.width - Design.tabPadRight - Design.closeSize, y: (bounds.height - Design.closeSize) / 2,
                             width: Design.closeSize, height: Design.closeSize)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with e: NSEvent) { hover = true; close.isHidden = false; needsDisplay = true }
    override func mouseExited(with e: NSEvent) { hover = false; close.isHidden = !model.active; needsDisplay = true }

    override func mouseDown(with e: NSEvent) {
        downX = superview?.convert(e.locationInWindow, from: nil).x
        moving = false
        bar?.onSelect?(model.id)
    }
    override func mouseDragged(with e: NSEvent) {
        guard let bar, let x0 = downX else { return }
        let x = bar.convert(e.locationInWindow, from: nil).x
        if !moving && abs(x - x0) > 3 {
            moving = true
            bar.beginDrag(self, at: x0)
        }
        if moving { bar.drag(self, to: x) }
    }
    override func mouseUp(with e: NSEvent) {
        if moving { bar?.endDrag(self) }
        moving = false
        downX = nil
    }
    override func otherMouseUp(with e: NSEvent) {
        if e.buttonNumber == 2 { bar?.onClose?(model.id) }
    }
    override func accessibilityPerformPress() -> Bool { bar?.onSelect?(model.id); return true }

    override func draw(_ dirty: NSRect) {
        if model.active {
            Design.tbg.setFill()
            let r = Design.tabRadius
            let p = NSBezierPath()
            let b = bounds
            p.move(to: NSPoint(x: 0, y: b.maxY))
            p.line(to: NSPoint(x: 0, y: r))
            p.appendArc(withCenter: NSPoint(x: r, y: r), radius: r, startAngle: 180, endAngle: 270)
            p.line(to: NSPoint(x: b.maxX - r, y: 0))
            p.appendArc(withCenter: NSPoint(x: b.maxX - r, y: r), radius: r, startAngle: 270, endAngle: 360)
            p.line(to: NSPoint(x: b.maxX, y: b.maxY))
            p.close()
            p.fill()
        }
        var x = Design.tabPadLeft
        if let d = model.dot {
            Design.color(d).setFill()
            NSBezierPath(ovalIn: NSRect(x: x + 2.5, y: (bounds.height - 7) / 2, width: 7, height: 7)).fill()
        } else {
            Icons.shell(NSRect(x: x, y: (bounds.height - 12) / 2, width: 12, height: 12), fg3)
        }
        x += 12 + Design.tabInnerGap
        var end = bounds.width - Design.tabPadRight - Design.closeSize - Design.tabInnerGap
        if model.split {
            let bw = 11 + 3 + ceil(TabItem.badge.size().width)
            let bx = end - bw
            Icons.split(NSRect(x: bx, y: (bounds.height - 11) / 2, width: 11, height: 11), fg3)
            let b = NSAttributedString(string: "2", attributes: [.font: Design.tabFont, .foregroundColor: fg3])
            b.draw(at: NSPoint(x: bx + 14, y: (bounds.height - b.size().height) / 2))
            end = bx - Design.tabInnerGap
        }
        x = text(nameText(), x: x, maxX: end)
        if showSub, let s = subText(), x + Design.tabInnerGap < end - 2 {
            _ = text(s, x: x + Design.tabInnerGap, maxX: end)
        }
    }

    private func text(_ a: NSAttributedString, x: CGFloat, maxX: CGFloat) -> CGFloat {
        let size = a.size()
        let w = max(0, min(ceil(size.width), maxX - x))
        let m = NSMutableAttributedString(attributedString: a)
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byTruncatingTail
        m.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: m.length))
        m.draw(with: NSRect(x: x, y: (bounds.height - size.height) / 2, width: w, height: size.height), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        return x + w
    }
}
