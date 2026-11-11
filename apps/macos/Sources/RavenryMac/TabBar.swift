// The tab strip, as the Electron app draws it (app.css .tabs, .tab;
// app.ts renderTabs, fitTabs): 40 pt high on the sheet's colour with a
// line under it, each tab 32 pt high with its top corners rounded, the tab
// in front in the terminal's colours so it joins its terminal. A tab shows
// the shell icon (a session's: its state's dot), its name, its folder or
// project in grey when that says more, "2" with the split icon when split,
// and a close x (on hover, and always on the tab in front). The + after
// the last tab opens a shell. A click brings a tab to the front, a middle
// click closes it, a drag moves it along the strip (the others make room
// as it passes them), and a drag down onto the pane in front splits it
// with that tab (Workspace.dropTab). When the tabs crowd, the grey second
// lines go first, then the strip scrolls (the wheel or a trackpad), the tab
// in front kept in sight; a tab never narrows below its name.
//
// Two buttons hold the window's folds: at the left the sidebar's, at the
// right end the session panel's (the Electron app's .icon-btn), lit while
// what they fold is shown; before the panel's, while a pane is on screen,
// the filmstrip's (its last 20 seconds, Filmstrip.swift). The strip sits in the window's title bar, after
// its buttons; its empty part moves the window and a double click there
// zooms it, as a title bar does.

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
    /// A bell rang in it while it was not on screen (until it is opened).
    var bell = false
    /// It printed while not on screen: a quiet dot.
    var activity = false
    /// An agent holds its pane's lease: who ("Claude"), and its colour (claude, codex, other).
    var lent: String? = nil
    var lentCls = "other"
    /// What its x says (nil: by its kind, TabBar.closeTip).
    var closeTip: String? = nil
    /// An extra tab (Workspace.extraTabs): the tab it comes right after
    /// (its session's own tab, "s:<pane>", or a pane id), nil at the end.
    var after: String? = nil
}

final class TabBar: NSView {
    var onSelect: ((String) -> Void)?
    var onClose: ((String) -> Void)?
    var onNew: (() -> Void)?
    /// The fold buttons (Workspace: the View menu's Hide Sidebar and Session Panel).
    var onToggleSidebar: (() -> Void)?
    var onTogglePanel: (() -> Void)?
    /// A tab dragged down out of the strip, over the window (nil: back in
    /// the strip, or let go): what dropping it there would do, said on the
    /// pane (Workspace.dragOver). And the drop: true when it was taken.
    var onDragOut: ((String, NSPoint?) -> Void)?
    var onDropOut: ((String, NSPoint) -> Bool)?
    /// Left of the first button: the window's buttons when the strip is the
    /// window's top (Design.stripLead), else the .tabs padding (8).
    var lead: CGFloat = Design.stripLead { didSet { if lead != oldValue { needsLayout = true } } }
    /// A tab dragged to another place: its id and its new index.
    var onMove: ((String, Int) -> Void)?
    /// What the fold buttons show (RootView.place sets them).
    var sidebarShown = true { didSet { if sidebarShown != oldValue { updateFolds() } } }
    var panelShown = false { didSet { if panelShown != oldValue { updateFolds() } } }

    private(set) var items: [TabItem] = []
    let plus = IconButton(size: 32, iconSize: 12, color: Design.tx2, hoverColor: Design.tx, hoverFill: .clear, draw: Icons.plus)
    let sideButton = IconButton(size: 28, iconSize: 16, color: Design.tx2, hoverColor: Design.tx, hoverFill: NSColor(white: 0.5, alpha: 0.16), draw: Icons.sidebar)
    let panelButton = IconButton(size: 28, iconSize: 16, color: Design.tx2, hoverColor: Design.tx, hoverFill: NSColor(white: 0.5, alpha: 0.16), draw: Icons.panel)
    /// The filmstrip's (the pane's last 20 seconds), while a pane is on screen.
    let filmButton = IconButton(size: 28, iconSize: 15, color: Design.tx2, hoverColor: Design.tx, hoverFill: NSColor(white: 0.5, alpha: 0.16)) { r, c in
        TabItem.tinted("film", c)?.draw(in: r, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }
    var onFilm: (() -> Void)?
    /// A pane is on screen (the button shows), and its filmstrip is open (lit).
    var filmable = true { didSet { if filmable != oldValue { filmButton.isHidden = !filmable; needsLayout = true } } }
    var filmOn = false { didSet { if filmOn != oldValue { updateFolds() } } }
    /// The tabs' window: they scroll inside it when they do not all fit.
    let clip = TabClip()
    /// How far the tabs are scrolled (0: the first at the left).
    private(set) var offset: CGFloat = 0
    private var models: [TabModel] = []
    private var dragged: TabItem?
    private var dragOffset: CGFloat = 0
    private var draggedOut = false
    /// The tab in front is kept in sight (not after a scroll by hand).
    private var followFront = true

    override init(frame: NSRect) {
        super.init(frame: frame)
        addSubview(clip)
        clip.bar = self
        addSubview(plus)
        addSubview(sideButton)
        addSubview(panelButton)
        addSubview(filmButton)
        filmButton.action = { [weak self] in self?.onFilm?() }
        plus.toolTip = t("strip.newShell")
        plus.setAccessibilityLabel(t("strip.newShellA"))
        plus.action = { [weak self] in self?.onNew?() }
        sideButton.action = { [weak self] in self?.onToggleSidebar?() }
        panelButton.action = { [weak self] in self?.onTogglePanel?() }
        updateFolds()
        setAccessibilityElement(true)
        setAccessibilityRole(.tabGroup)
        setAccessibilityLabel("Tabs")
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { true }

    /// The fold buttons' words and colour: lit (the accent) while what they fold shows.
    private func updateFolds() {
        sideButton.toolTip = sidebarShown ? t("strip.hideSidebar") : t("strip.showSidebar")
        sideButton.setAccessibilityLabel(t("strip.sidebarA"))
        sideButton.setAccessibilityValue(sidebarShown)
        panelButton.toolTip = panelShown ? t("strip.hidePanel") : t("strip.showPanel")
        panelButton.setAccessibilityLabel(t("strip.panelA"))
        panelButton.setAccessibilityValue(panelShown)
        sideButton.color = sidebarShown ? Design.work : Design.tx2
        panelButton.color = panelShown ? Design.work : Design.tx2
        filmButton.toolTip = t("strip.film")
        filmButton.setAccessibilityLabel(t("strip.filmA"))
        filmButton.setAccessibilityValue(filmOn)
        filmButton.color = filmOn ? Design.work : Design.tx2
        sideButton.needsDisplay = true
        panelButton.needsDisplay = true
        filmButton.needsDisplay = true
    }

    func set(_ tabs: [TabModel]) {
        guard tabs != models || items.count != tabs.count else { return }
        let wasFront = models.first { $0.active }?.id
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
        for it in items where it.superview == nil { clip.addSubview(it) }
        setAccessibilityChildren([sideButton] + items + [plus, filmButton, panelButton])
        layoutTabs(animated: false)
        // Another tab in front: in sight (and kept so as the strip changes, until the strip is scrolled by hand).
        if let f = tabs.first(where: { $0.active })?.id, f != wasFront { followFront = true; layoutTabs(animated: false) }
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

    /// Where the tabs go: after the sidebar's button, before the panel's.
    private var tabsRect: NSRect {
        let y = bounds.height - Design.tabHeight
        let x0 = lead + 28 + 6
        let x1 = bounds.width - 8 - 28 - 6 - (filmable ? 28 + 4 : 0)
        return NSRect(x: x0, y: y, width: max(0, x1 - x0), height: Design.tabHeight)
    }

    /// Each tab's width: its content, at most 240 pt (320 with a lease
    /// badge); every tab without its grey second line when they do not all
    /// fit. Never narrower: the strip scrolls instead.
    private func widths(avail: CGFloat) -> [CGFloat] {
        let gaps = CGFloat(max(0, items.count - 1)) * Design.tabGap
        var w = items.map { $0.idealWidth(withSub: true) }
        let sub = w.reduce(0, +) + gaps + 32 <= avail
        if !sub { w = items.map { $0.idealWidth(withSub: false) } }
        items.forEach { $0.showSub = sub }
        return w
    }

    /// The tabs' whole width with the + after them.
    private(set) var contentWidth: CGFloat = 0
    /// More tabs than room: the strip scrolls.
    var overflows: Bool { clip.overflow }

    func layoutTabs(animated: Bool) {
        let r = tabsRect
        sideButton.setIf(NSRect(x: lead, y: r.minY + (Design.tabHeight - 28) / 2, width: 28, height: 28))
        panelButton.setIf(NSRect(x: bounds.width - 8 - 28, y: r.minY + (Design.tabHeight - 28) / 2, width: 28, height: 28))
        filmButton.setIf(NSRect(x: bounds.width - 8 - 28 - 4 - 28, y: r.minY + (Design.tabHeight - 28) / 2, width: 28, height: 28))
        let w = widths(avail: r.width)
        let tabsWidth = w.reduce(0, +) + CGFloat(max(0, items.count - 1)) * Design.tabGap
        contentWidth = tabsWidth + 32
        // Crowded: the tabs scroll in the room left of the +, which stays at the end.
        let over = contentWidth > r.width + 0.5
        let room = over ? max(0, r.width - 32) : r.width
        clip.setIf(NSRect(x: r.minX, y: r.minY, width: room, height: r.height))
        if over, followFront, dragged == nil, let i = items.firstIndex(where: { $0.model.active }) {
            let left = w[..<i].reduce(0, +) + CGFloat(i) * Design.tabGap, right = left + w[i]
            if left < offset { offset = left } else if right > offset + room { offset = right - room }
        }
        offset = over ? min(max(0, offset), max(0, tabsWidth - room)) : 0
        var x = -offset
        for (i, it) in items.enumerated() {
            let f = NSRect(x: x, y: 0, width: w[i], height: Design.tabHeight)
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
        plus.setIf(NSRect(x: over ? r.maxX - 32 : r.minX + x, y: r.minY, width: 32, height: Design.tabHeight))
        clip.overflow = over
        // More tabs beyond an edge: that edge fades out.
        clip.fade(left: over && offset > 0.5, right: over && offset < tabsWidth - room - 0.5)
    }

    /// A tab brought to the front (a click, a key, a command): in sight again.
    func keepFrontInSight() {
        followFront = true
        layoutTabs(animated: false)
    }

    /// The wheel or a trackpad over the strip: it scrolls across.
    func scroll(by dx: CGFloat) {
        let was = offset
        followFront = false
        offset += dx
        layoutTabs(animated: false)
        if offset != was { needsDisplay = true }
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

    override func scrollWheel(with e: NSEvent) { clip.scrollWheel(with: e) }

    /// The tab x's words by its kind: a page's, the brief's, a shell's.
    static func closeTip(_ m: TabModel) -> String {
        if let c = m.closeTip { return c }
        if m.id == "view:brief" { return t("strip.closeBrief") }
        if m.id.hasPrefix("view:") { return t("strip.closeView") }
        return t("strip.closeShell")
    }

    // MARK: dragging a tab along the strip, or down onto the pane

    /// A point of the window in the tabs' own coordinates.
    func stripPoint(_ windowPoint: NSPoint) -> NSPoint { clip.convert(windowPoint, from: nil) }

    func beginDrag(_ it: TabItem, at x: CGFloat) {
        dragged = it
        draggedOut = false
        dragOffset = x - it.frame.minX
        it.removeFromSuperview()
        clip.addSubview(it) // over the others
    }

    func drag(_ it: TabItem, to p: NSPoint, window wp: NSPoint) {
        guard dragged === it, let i = items.firstIndex(where: { $0 === it }) else { return }
        // Down out of the strip: over the pane in front, to split it.
        let below = convert(wp, from: nil).y > bounds.height + 6
        if below {
            draggedOut = true
            it.alphaValue = 0.45
            onDragOut?(it.model.id, wp)
            return
        }
        if draggedOut {
            draggedOut = false
            it.alphaValue = 1
            onDragOut?(it.model.id, nil)
        }
        var f = it.frame
        f.origin.x = min(max(0, p.x - dragOffset), max(0, clip.bounds.width - f.width))
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

    func endDrag(_ it: TabItem, window wp: NSPoint) {
        guard dragged === it else { return }
        dragged = nil
        it.alphaValue = 1
        if draggedOut {
            draggedOut = false
            onDragOut?(it.model.id, nil)
            // Back to its place whatever the drop did (the tab goes when it was taken).
            it.frame = it.slot
            _ = onDropOut?(it.model.id, wp)
            return
        }
        let to = items.firstIndex(where: { $0 === it }) ?? 0
        it.frame = it.slot
        models = items.map { $0.model }
        onMove?(it.model.id, to)
    }
}

/// The tabs' window in the strip: it clips them and scrolls them across
/// with the wheel or a trackpad.
final class TabClip: NSView {
    weak var bar: TabBar?
    var overflow = false
    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { true }
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.masksToBounds = true
    }
    required init?(coder: NSCoder) { fatalError() }
    override func scrollWheel(with e: NSEvent) {
        guard overflow, let bar else { return super.scrollWheel(with: e) }
        // Across: a trackpad's sideways move, else the wheel's turn.
        let d = abs(e.scrollingDeltaX) > abs(e.scrollingDeltaY) ? -e.scrollingDeltaX : -e.scrollingDeltaY
        bar.scroll(by: e.hasPreciseScrollingDeltas ? d : d * 12)
    }
    override func mouseUp(with e: NSEvent) { bar?.mouseUp(with: e) }

    /// The edges where more tabs lie fade over 18 pt.
    private(set) var faded = (left: false, right: false)
    func fade(left: Bool, right: Bool) {
        guard left || right else {
            if layer?.mask != nil { layer?.mask = nil }
            faded = (false, false)
            return
        }
        let g = (layer?.mask as? CAGradientLayer) ?? CAGradientLayer()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        g.frame = bounds
        g.startPoint = CGPoint(x: 0, y: 0.5)
        g.endPoint = CGPoint(x: 1, y: 0.5)
        let e = bounds.width > 0 ? min(0.3, 18 / bounds.width) : 0
        let a = NSColor.black.cgColor, c = NSColor.clear.cgColor
        g.colors = [left ? c : a, a, a, right ? c : a]
        g.locations = [0, NSNumber(value: Double(e)), NSNumber(value: Double(1 - e)), 1]
        if layer?.mask !== g { layer?.mask = g }
        CATransaction.commit()
        faded = (left, right)
    }
}

final class TabItem: NSView {
    weak var bar: TabBar?
    var model = TabModel(id: "", name: "", sub: nil, split: false, active: false, tip: "") {
        didSet {
            toolTip = model.tip
            close.toolTip = TabBar.closeTip(model)
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
    private var downY: CGFloat?
    private var moving = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        addSubview(close)
        close.setAccessibilityLabel(t("strip.closeA"))
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
    private static let lentFont = NSFont.systemFont(ofSize: 10.5, weight: Fonts.w650)
    private static let bellColor = NSColor(srgbRed: 1, green: 0x9F / 255, blue: 0x0A / 255, alpha: 1)
    /// The marks after the name (.lbadge, .act, .tbell): their width.
    private var marksWidth: CGFloat {
        var w: CGFloat = 0
        if let l = model.lent { w += Design.tabInnerGap + 6 + 12 + 4 + ceil((l as NSString).size(withAttributes: [.font: TabItem.lentFont]).width) + 6 }
        if model.activity && !model.active { w += Design.tabInnerGap + 5 }
        if model.bell && !model.active { w += Design.tabInnerGap + 12 }
        return w
    }

    func idealWidth(withSub: Bool) -> CGFloat {
        var w = Design.tabPadLeft + 12 + Design.tabInnerGap + ceil(nameText().size().width)
        if withSub, let s = subText() { w += Design.tabInnerGap + ceil(s.size().width) }
        if model.split { w += Design.tabInnerGap + 11 + 3 + ceil(TabItem.badge.size().width) }
        w += marksWidth
        w += Design.tabInnerGap + Design.closeSize + Design.tabPadRight
        // A lease badge takes room of its own (phase2.css .tab:has(.lbadge)).
        return min(model.lent == nil ? Design.tabMaxWidth : 320, w)
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
        downX = bar?.stripPoint(e.locationInWindow).x
        downY = e.locationInWindow.y
        moving = false
        bar?.onSelect?(model.id)
    }
    override func mouseDragged(with e: NSEvent) {
        guard let bar, let x0 = downX else { return }
        let p = bar.stripPoint(e.locationInWindow)
        if !moving && (abs(p.x - x0) > 3 || abs(e.locationInWindow.y - (downY ?? 0)) > 6) {
            moving = true
            bar.beginDrag(self, at: x0)
        }
        if moving { bar.drag(self, to: p, window: e.locationInWindow) }
    }
    override func mouseUp(with e: NSEvent) {
        if moving { bar?.endDrag(self, window: e.locationInWindow) }
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
        // Right to left before the split's count: the bell, the activity dot, the lease badge.
        if model.bell && !model.active, let img = TabItem.tinted("bell-s", TabItem.bellColor) {
            img.draw(in: NSRect(x: end - 12, y: (bounds.height - 12) / 2, width: 12, height: 12), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            end -= 12 + Design.tabInnerGap
        }
        if model.activity && !model.active {
            Design.tx3.setFill()
            NSBezierPath(ovalIn: NSRect(x: end - 5, y: (bounds.height - 5) / 2, width: 5, height: 5)).fill()
            end -= 5 + Design.tabInnerGap
        }
        if let l = model.lent {
            let codex = model.lentCls == "codex"
            let tc = codex ? NSColor(srgbRed: 0x6B / 255, green: 0xB5 / 255, blue: 1, alpha: 1) : NSColor(srgbRed: 0xDA / 255, green: 0x8F / 255, blue: 1, alpha: 1)
            let bg = codex ? NSColor(srgbRed: 64 / 255, green: 156 / 255, blue: 1, alpha: 0.2) : NSColor(srgbRed: 191 / 255, green: 90 / 255, blue: 242 / 255, alpha: 0.22)
            let a = NSAttributedString(string: l, attributes: [.font: TabItem.lentFont, .foregroundColor: tc])
            let bw = 6 + 12 + 4 + ceil(a.size().width) + 6
            let r = NSRect(x: end - bw, y: (bounds.height - 18) / 2, width: bw, height: 18)
            bg.setFill()
            NSBezierPath(roundedRect: r, xRadius: 4, yRadius: 4).fill()
            TabItem.tinted("holds", tc)?.draw(in: NSRect(x: r.minX + 6, y: r.midY - 6, width: 12, height: 12), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            a.draw(at: NSPoint(x: r.minX + 22, y: r.midY - a.size().height / 2))
            end -= bw + Design.tabInnerGap
        }
        x = text(nameText(), x: x, maxX: end)
        if showSub, let s = subText(), x + Design.tabInnerGap < end - 2 {
            _ = text(s, x: x + Design.tabInnerGap, maxX: end)
        }
    }

    /// An icon of shared/icons in one colour.
    static func tinted(_ name: String, _ c: NSColor) -> NSImage? {
        guard let src = SharedIcons.image(name, color: "tx", size: 12, dark: true) else { return nil }
        let img = NSImage(size: src.size)
        img.lockFocus()
        src.draw(at: .zero, from: .zero, operation: .sourceOver, fraction: 1)
        c.set()
        NSRect(origin: .zero, size: src.size).fill(using: .sourceAtop)
        img.unlockFocus()
        return img
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
