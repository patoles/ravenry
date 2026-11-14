// The small views the sidebar, the panel and the pages are made of, in the
// desktop's styles (apps/desktop/src/renderer/app.css): a box with a token
// background, ring and radius (.sec, .grp, .ss), a row that lights on hover
// and when selected (.ss, .idl, .vrow), the buttons (.btn, .btn.pri, .btn.sm,
// .lk, .icon-btn), labels and icons. Colours are the tokens', for the
// appearance in effect, redrawn when it changes.

import AppKit

class Flipped: NSView {
    override var isFlipped: Bool { true }
}

/// A box: a token's background, an inner ring, a radius.
class Box: Flipped {
    var fill: String? { didSet { needsDisplay = true } }
    var ring: String? { didSet { needsDisplay = true } }
    /// A colour no token names (the middle's rgba(255,255,255,.06)).
    var rawFill: NSColor? { didSet { needsDisplay = true } }
    var ringWidth: CGFloat = 1
    var radius: CGFloat = 0 { didSet { needsDisplay = true } }
    var dropShadow = false
    /// A box around a borderless text field: its ring turns --work while the
    /// field has the keyboard, from the moment it gets it (Tab, a click), not
    /// only once something is typed (.field:focus; A11Y-004). FocusRings.
    var ringsOnFocus = false { didSet { if ringsOnFocus, let w = window { FocusRings.watch(w) } } }
    /// The ring and width before the keyboard came (put back when it goes).
    fileprivate var beforeFocus: (String?, CGFloat)?
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if ringsOnFocus, let w = window { FocusRings.watch(w) }
    }

    init(fill: String? = nil, ring: String? = nil, radius: CGFloat = 0) {
        self.fill = fill; self.ring = ring; self.radius = radius
        super.init(frame: .zero)
        wantsLayer = true
    }
    required init?(coder: NSCoder) { fatalError() }
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        guard let l = layer else { return }
        effectiveAppearance.performAsCurrentDrawingAppearance {
            l.backgroundColor = fill.map { Design.color($0).cgColor } ?? rawFill?.cgColor
            l.borderColor = ring.map { Design.color($0).cgColor } ?? nil
            l.borderWidth = ring == nil ? 0 : ringWidth
            l.cornerRadius = radius
            if dropShadow {
                l.shadowColor = NSColor.black.cgColor
                l.shadowOpacity = 0.45
                l.shadowRadius = 30
                l.shadowOffset = CGSize(width: -24, height: 0)
                l.masksToBounds = false
            }
        }
    }
    override func viewDidChangeEffectiveAppearance() { needsDisplay = true }
}

/// The keyboard's place on a text field drawn as its box's ring: each
/// window's first responder watched (key-value observed); a field editor
/// working for a field inside a box with ringsOnFocus lights that box.
enum FocusRings {
    private static var watching: [ObjectIdentifier: NSKeyValueObservation] = [:]
    private static var lit: [ObjectIdentifier: Box] = [:]
    static func watch(_ w: NSWindow) {
        let id = ObjectIdentifier(w)
        guard watching[id] == nil else { return }
        watching[id] = w.observe(\.firstResponder, options: [.new]) { w, _ in DispatchQueue.main.async { update(w) } }
        update(w)
    }
    static func update(_ w: NSWindow) {
        let id = ObjectIdentifier(w)
        var box: Box? = nil
        if let ed = w.firstResponder as? NSTextView, ed.isFieldEditor, var v = ed.delegate as? NSView {
            while let s = v.superview { if let b = s as? Box, b.ringsOnFocus { box = b; break }; v = s }
        }
        if let old = lit[id], old !== box {
            if let (r, wd) = old.beforeFocus, old.ring == "work" { old.ring = r; old.ringWidth = wd }
            old.beforeFocus = nil
            lit[id] = nil
        }
        if let b = box {
            if lit[id] !== b { b.beforeFocus = (b.ring == "work" ? "sep" : b.ring, b.ring == "work" ? 1 : b.ringWidth); lit[id] = b }
            // A field given the keyboard again ends its editing first, which a box may answer by putting its ring back.
            if b.ring != "work" { b.ring = "work"; b.ringWidth = 1.5 }
        }
    }
}

/// A row that opens what it stands for: lit on hover (--sel), and when
/// selected with its ring (--selring). It opens on the press, as the
/// desktop's rows do (rowPress), and on Enter.
class Row: Box {
    var onOpen: (() -> Void)?
    var selected = false { didSet { restyle() } }
    var hoverFill = "sel"
    /// Lit on hover (a section's head that folds is not: its words light instead).
    var hoverFills = true
    private(set) var hovering = false { didSet { restyle(); onHover?(hovering) } }
    var onHover: ((Bool) -> Void)?
    /// The rows' key, for the self-test and the accessibility tree.
    var key = ""

    init(radius: CGFloat = 7) {
        super.init(radius: radius)
        setAccessibilityRole(.button)
        setAccessibilityElement(true)
    }
    required init?(coder: NSCoder) { fatalError() }
    private func restyle() {
        fill = selected || hovering && hoverFills ? hoverFill : nil
        ring = selected ? "selring" : nil
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for t in trackingAreas { removeTrackingArea(t) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with e: NSEvent) { hovering = true }
    override func mouseExited(with e: NSEvent) { hovering = false }
    override func mouseDown(with e: NSEvent) { onOpen?() }
    override func resetCursorRects() { handCursor(onOpen != nil) }
    /// The whole row takes the press (its labels and stacks are its
    /// drawing), except its own buttons (the pin).
    override func hitTest(_ p: NSPoint) -> NSView? {
        guard let v = super.hitTest(p) else { return nil }
        var x: NSView? = v
        while let c = x, c !== self { if c is NSButton { return v }; x = c.superview }
        // A session's name in its words opens that session.
        if LinkField.takes(v, p, from: superview) { return v }
        return self
    }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { onOpen?(); return true }
    /// The row picked (the session in front, the file shown) says so to VoiceOver.
    override func isAccessibilitySelected() -> Bool { selected }

    /// Its right-click (and Control-click) menu, built when asked.
    var menuItems: (() -> NSMenu?)?
    override func menu(for e: NSEvent) -> NSMenu? { menuItems?() ?? super.menu(for: e) }
    override func accessibilityPerformShowMenu() -> Bool {
        guard let m = menuItems?() else { return false }
        m.popUp(positioning: nil, at: NSPoint(x: 12, y: bounds.height - 4), in: self)
        return true
    }

    // The keyboard (rows are tabindex 0 in the Electron app): Tab reaches a
    // row, Return or Space opens it. A click never takes the keyboard from
    // the terminal: only Tab (a key press) gives it to a row.
    override var acceptsFirstResponder: Bool { onOpen != nil && NSApp.currentEvent?.type == .keyDown }
    override var canBecomeKeyView: Bool { onOpen != nil }
    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: radius, yRadius: radius).fill() }
    override func keyDown(with e: NSEvent) {
        // Return, Enter, Space.
        if [36, 76, 49].contains(e.keyCode), e.modifierFlags.intersection([.command, .control, .option]).isEmpty { onOpen?(); return }
        super.keyDown(with: e)
    }
}

/// A label that keeps its whole width (a chip, a tag, a time, a count):
/// the CSS flex: none of the Electron app. Beside a name made with
/// `yields(_:)`, the name gives up its room first and is cut, never this.
func fixedLabel(_ s: String, _ font: NSFont, _ color: String = "tx") -> NSTextField {
    let f = label(s, font, color)
    f.setContentCompressionResistancePriority(.required, for: .horizontal)
    f.setContentHuggingPriority(.required, for: .horizontal)
    return f
}

/// A one-line label that is the first to be cut in its row (flex: 1;
/// min-width: 0), and with `fill` takes the row's free width, so what
/// follows it lines up on the right. Its whole text is its tooltip.
@discardableResult
func yields(_ f: NSTextField, fill: Bool = true) -> NSTextField {
    f.setContentCompressionResistancePriority(.init(200), for: .horizontal)
    if fill { f.setContentHuggingPriority(.init(2), for: .horizontal) }
    if f.toolTip == nil, !f.stringValue.isEmpty { f.toolTip = f.stringValue }
    return f
}

/// An assistant's chip (.as-tag): ringed, never squeezed.
func assistantChip(_ s: String, color: String = "tx2", ring: String = "sep") -> Box {
    let b = boxed(fixedLabel(s, Fonts.pt(11, .semibold), color), fill: nil, ring: ring, radius: 5, insets: NSEdgeInsets(top: 3, left: 7, bottom: 3, right: 7))
    b.setContentHuggingPriority(.required, for: .horizontal)
    b.setContentCompressionResistancePriority(.required, for: .horizontal)
    b.setAccessibilityElement(true)
    b.setAccessibilityLabel(s)
    return b
}

func label(_ s: String, _ font: NSFont, _ color: String = "tx", lines: Int = 1, select: Bool = false) -> NSTextField {
    // A LinkField: a session's name in a Markdown line (label(md:)) opens it on a press.
    let f = lines == 1 ? LinkField(labelWithString: s) : LinkField(wrappingLabelWithString: s)
    f.font = font
    f.textColor = Design.color(color)
    f.isSelectable = select
    f.maximumNumberOfLines = lines
    f.lineBreakMode = lines == 1 ? .byTruncatingTail : .byWordWrapping
    f.cell?.truncatesLastVisibleLine = true
    f.setContentCompressionResistancePriority(.init(260), for: .horizontal)
    f.setContentHuggingPriority(.defaultHigh, for: .vertical)
    f.backgroundColor = .clear
    f.drawsBackground = false
    // The desktop's line height (1.4) for a line of text.
    if lines == 1 { f.heightAnchor.constraint(greaterThanOrEqualToConstant: ceil(font.pointSize * 1.4)).isActive = true }
    return f
}

/// An icon of shared/icons in a token's colour, drawn again when the
/// appearance changes.
final class Icon: NSImageView {
    var name: String { didSet { reload() } }
    var tint: String { didSet { reload() } }
    let side: CGFloat
    init(_ name: String, _ tint: String = "tx2", size: CGFloat = 14) {
        self.name = name; self.tint = tint; self.side = size
        super.init(frame: NSRect(x: 0, y: 0, width: size, height: size))
        imageScaling = .scaleProportionallyUpOrDown
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: size).isActive = true
        heightAnchor.constraint(equalToConstant: size).isActive = true
        reload()
    }
    required init?(coder: NSCoder) { fatalError() }
    private func reload() {
        var dark = true
        effectiveAppearance.performAsCurrentDrawingAppearance { dark = NSAppearance.currentDrawing().bestMatch(from: [.darkAqua, .aqua]) == .darkAqua }
        image = SharedIcons.image(name, color: tint, size: side, dark: dark)
    }
    override func viewDidChangeEffectiveAppearance() { reload() }
    /// A button's icon (Close's x) leaves the press to its button: an image
    /// view takes a press itself, so a press on the x of a Close did nothing.
    override func hitTest(_ p: NSPoint) -> NSView? { superview is NSControl ? nil : super.hitTest(p) }
}

/// The desktop's buttons: .btn (grey), .btn.pri (blue), .sm, .lk (a link),
/// .icon-btn (an icon, lit on hover), each a real NSButton for the
/// keyboard and VoiceOver.
final class RButton: NSButton {
    enum Kind { case normal, primary, ghost, link, icon, no, quiet }
    let kind: Kind
    let small: Bool
    var run: (() -> Void)?
    var on = false { didSet { needsDisplay = true } }
    /// Lit while on with --sel and a --selring ring (.icon-btn.m-foot.on), not only its icon in tx.
    var onFill = false { didSet { needsDisplay = true } }
    /// Its words in this token's colour instead of its kind's (a name to click, .phc-nm).
    var titleColor: String? { didSet { setTitle(title) } }
    var titleSize: CGFloat? { didSet { setTitle(title) } }
    var iconView: Icon?
    /// An icon of shared/icons before the title (.btn svg), in the title's colour.
    var lead: String? { didSet { leadImage(); invalidateIntrinsicContentSize() } }
    /// The "opens outside" mark after the title (a box with an arrow out of it), in the title's colour.
    var external = false { didSet { externalImage(); invalidateIntrinsicContentSize(); needsDisplay = true } }
    /// The mark as the button's image, after its title (the cell draws it, as it draws a lead icon).
    private func externalImage() {
        guard external else { return }
        let c: NSColor = kind == .primary && titleColor == nil ? .white : Design.color(titleColor ?? (kind == .link ? "link" : "btn-tx"))
        image = NSImage(size: NSSize(width: 11, height: 11), flipped: true) { _ in
            let k: CGFloat = 11 / 12
            let pt = { (x: CGFloat, y: CGFloat) in NSPoint(x: x * k, y: y * k) }
            let p = NSBezierPath()
            p.move(to: pt(5, 2)); p.line(to: pt(2, 2)); p.line(to: pt(2, 10)); p.line(to: pt(10, 10)); p.line(to: pt(10, 7))
            p.move(to: pt(7, 2)); p.line(to: pt(10, 2)); p.line(to: pt(10, 5))
            p.move(to: pt(10, 2)); p.line(to: pt(5.5, 6.5))
            p.lineWidth = 1.4; p.lineCapStyle = .round; p.lineJoinStyle = .round
            c.setStroke(); p.stroke()
            return true
        }
        imagePosition = .imageTrailing
        imageHugsTitle = true
    }
    /// The lead icon as the button's image, before its title, in the title's colour for the appearance in effect.
    private func leadImage() {
        guard let ln = lead else { image = nil; return }
        let tok = kind == .primary ? "tx" : kind == .ghost || kind == .quiet ? "tx2" : "btn-tx"
        let dark = kind == .primary || effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        image = SharedIcons.image(ln, color: tok, size: 14, dark: dark)
        imagePosition = .imageLeading
        imageHugsTitle = true
    }
    private var hover = false { didSet { needsDisplay = true } }

    init(_ title: String, _ kind: Kind = .normal, small: Bool = false, icon: String? = nil, run: (() -> Void)? = nil) {
        self.kind = kind; self.small = small; self.run = run
        super.init(frame: .zero)
        isBordered = false
        bezelStyle = .regularSquare
        setButtonType(.momentaryChange)
        wantsLayer = true
        target = self
        action = #selector(fire)
        translatesAutoresizingMaskIntoConstraints = false
        if let i = icon {
            let v = Icon(i, kind == .icon ? "tx2" : "tx3", size: small ? 14 : 15)
            iconView = v
            addSubview(v)
            v.centerXAnchor.constraint(equalTo: centerXAnchor).isActive = true
            v.centerYAnchor.constraint(equalTo: centerYAnchor).isActive = true
            self.title = ""
            setAccessibilityLabel(title)
            toolTip = title
            let side: CGFloat = small ? 26 : 30
            widthAnchor.constraint(equalToConstant: side).isActive = true
            heightAnchor.constraint(equalToConstant: side).isActive = true
        } else {
            self.title = title
            setTitle(title)
            if kind != .link { heightAnchor.constraint(greaterThanOrEqualToConstant: small ? 28 : 32).isActive = true }
        }
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
    }
    required init?(coder: NSCoder) { fatalError() }

    func setTitle(_ s: String) {
        title = s
        let size: CGFloat = titleSize ?? (kind == .link ? 12 : small ? 12 : 13)
        let color: String = titleColor ?? (kind == .primary ? "" : kind == .link ? "link" : kind == .ghost || kind == .quiet ? "tx2" : kind == .no ? "bad" : "btn-tx")
        let c: NSColor = kind == .primary && titleColor == nil ? .white : Design.color(color)
        attributedTitle = NSAttributedString(string: s, attributes: [.font: Fonts.pt(size, .medium), .foregroundColor: isEnabled ? c : c.withAlphaComponent(0.5)])
        invalidateIntrinsicContentSize()
    }
    override var isEnabled: Bool { didSet { if iconView == nil { setTitle(title) }; if isEnabled != oldValue { window?.invalidateCursorRects(for: self) } } }
    /// Every button, links and icons too, shows the pointing hand while it can be pressed (Cursors.swift).
    override func resetCursorRects() { handCursor(isEnabled) }
    override var intrinsicContentSize: NSSize {
        if iconView != nil { return NSSize(width: small ? 26 : 30, height: small ? 26 : 30) }
        let t = attributedTitle.size()
        if kind == .link { return NSSize(width: ceil(t.width), height: ceil(t.height)) }
        return NSSize(width: ceil(t.width) + (small ? 20 : 26) + (lead == nil ? 0 : 20) + (external ? 17 : 0), height: small ? 28 : 32)
    }
    @objc private func fire() { run?() }
    // The keyboard's ring (A11Y-004): the button's own rounded shape, whatever its kind draws.
    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { let r = layer?.cornerRadius ?? 6; NSBezierPath(roundedRect: bounds, xRadius: r, yRadius: r).fill() }
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        guard let l = layer else { return }
        effectiveAppearance.performAsCurrentDrawingAppearance {
            var bg: NSColor? = nil
            switch kind {
            case .primary: bg = Design.color("work")
            case .normal, .no: bg = Design.color("btn")
            case .icon: bg = hover || on ? (hover ? Design.color("sel") : nil) : nil
            case .ghost, .link, .quiet: bg = nil
            }
            if hover && (kind == .primary || kind == .normal || kind == .no), let b = bg { bg = b.blended(withFraction: 0.12, of: .white) }
            l.backgroundColor = isEnabled ? bg?.cgColor : bg?.withAlphaComponent(0.5).cgColor
            l.cornerRadius = 7
            let light = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .aqua
            l.borderWidth = kind == .quiet || light && (kind == .normal || kind == .no) ? 1 : 0
            l.borderColor = Design.color("sep").cgColor
            if kind == .icon && on && onFill {
                l.backgroundColor = Design.color("sel").cgColor
                l.borderWidth = 1
                l.borderColor = Design.color("selring").cgColor
            }
        }
        iconView?.tint = kind == .icon ? (hover || on ? "tx" : "tx2") : iconView?.tint ?? "tx3"
    }
    override func draw(_ r: NSRect) {
        guard iconView == nil else { return }
        let t = attributedTitle
        let s = t.size()
        guard lead != nil, let img = image else { t.draw(at: NSPoint(x: (bounds.width - s.width) / 2, y: (bounds.height - s.height) / 2)); return }
        let x0 = (bounds.width - s.width - 20) / 2
        img.draw(in: NSRect(x: x0, y: (bounds.height - 14) / 2, width: 14, height: 14), from: .zero, operation: .sourceOver, fraction: isEnabled ? 1 : 0.5, respectFlipped: true, hints: nil)
        t.draw(at: NSPoint(x: x0 + 20, y: (bounds.height - s.height) / 2))
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for t in trackingAreas { removeTrackingArea(t) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with e: NSEvent) { hover = true }
    override func mouseExited(with e: NSEvent) { hover = false }
    override func viewDidChangeEffectiveAppearance() { if iconView == nil { setTitle(title) }; if lead != nil { leadImage() }; if external { externalImage() }; needsDisplay = true }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
}

/// A stack laid out top to bottom, its children as wide as it.
func vstack(_ views: [NSView?], spacing: CGFloat = 0, insets: NSEdgeInsets = NSEdgeInsetsZero) -> NSStackView {
    let s = NSStackView(views: views.compactMap { $0 })
    s.orientation = .vertical
    s.alignment = .leading
    s.spacing = spacing
    s.edgeInsets = insets
    s.translatesAutoresizingMaskIntoConstraints = false
    s.detachesHiddenViews = true
    for v in s.arrangedSubviews where !(v is RButton) {
        v.translatesAutoresizingMaskIntoConstraints = false
        v.widthAnchor.constraint(equalTo: s.widthAnchor, constant: -(insets.left + insets.right)).isActive = true
    }
    return s
}

/// A stack laid out left to right, centred.
func hstack(_ views: [NSView?], spacing: CGFloat = 8, insets: NSEdgeInsets = NSEdgeInsetsZero) -> NSStackView {
    let s = NSStackView(views: views.compactMap { $0 })
    s.orientation = .horizontal
    s.alignment = .centerY
    s.spacing = spacing
    s.edgeInsets = insets
    s.translatesAutoresizingMaskIntoConstraints = false
    s.detachesHiddenViews = true
    return s
}

/// A space that takes what is left (.sp).
func spring() -> NSView {
    let v = NSView()
    v.translatesAutoresizingMaskIntoConstraints = false
    v.setContentHuggingPriority(.init(1), for: .horizontal)
    v.setContentCompressionResistancePriority(.init(1), for: .horizontal)
    return v
}

/// A view inside a box with padding (a .sec, a .grp).
func boxed(_ content: NSView, fill: String?, ring: String? = nil, radius: CGFloat, insets: NSEdgeInsets) -> Box {
    let b = Box(fill: fill, ring: ring, radius: radius)
    b.translatesAutoresizingMaskIntoConstraints = false
    content.translatesAutoresizingMaskIntoConstraints = false
    b.addSubview(content)
    NSLayoutConstraint.activate([
        content.leadingAnchor.constraint(equalTo: b.leadingAnchor, constant: insets.left),
        content.trailingAnchor.constraint(equalTo: b.trailingAnchor, constant: -insets.right),
        content.topAnchor.constraint(equalTo: b.topAnchor, constant: insets.top),
        content.bottomAnchor.constraint(equalTo: b.bottomAnchor, constant: -insets.bottom),
    ])
    return b
}

/// A scroll view whose document is a vertical stack as wide as it.
final class StackScroll: NSScrollView {
    let stack: NSStackView
    private var minWidthConstraint: NSLayoutConstraint?
    /// The least width of its rows (a diff's longest line): wider than the view, it scrolls sideways.
    var minWidth: CGFloat = 0 { didSet { minWidthConstraint?.constant = minWidth } }
    init(spacing: CGFloat, insets: NSEdgeInsets) {
        stack = vstack([], spacing: spacing, insets: insets)
        super.init(frame: .zero)
        drawsBackground = false
        hasVerticalScroller = true
        autohidesScrollers = true
        scrollerStyle = .overlay
        horizontalScrollElasticity = .none
        let doc = Flipped()
        doc.translatesAutoresizingMaskIntoConstraints = false
        doc.addSubview(stack)
        documentView = doc
        // As wide as the view, or `minWidth` when that is more (it then scrolls sideways).
        let fit = doc.trailingAnchor.constraint(equalTo: contentView.trailingAnchor)
        fit.priority = .init(999)
        minWidthConstraint = doc.widthAnchor.constraint(greaterThanOrEqualToConstant: 0)
        NSLayoutConstraint.activate([
            doc.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            fit, minWidthConstraint!,
            doc.widthAnchor.constraint(greaterThanOrEqualTo: contentView.widthAnchor),
            doc.topAnchor.constraint(equalTo: contentView.topAnchor),
            stack.leadingAnchor.constraint(equalTo: doc.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: doc.trailingAnchor),
            stack.topAnchor.constraint(equalTo: doc.topAnchor),
            stack.bottomAnchor.constraint(equalTo: doc.bottomAnchor),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }

    /// Its rows replaced, the place it was scrolled to kept.
    func set(_ views: [NSView]) {
        let y = contentView.bounds.origin.y
        for v in stack.arrangedSubviews { stack.removeArrangedSubview(v); v.removeFromSuperview() }
        let ins = stack.edgeInsets
        for v in views {
            v.translatesAutoresizingMaskIntoConstraints = false
            stack.addArrangedSubview(v)
            v.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -(ins.left + ins.right)).isActive = true
        }
        stack.layoutSubtreeIfNeeded()
        contentView.scroll(to: NSPoint(x: 0, y: min(y, max(0, (documentView?.frame.height ?? 0) - contentView.bounds.height))))
        reflectScrolledClipView(contentView)
    }
}

/// A menu item that runs a closure.
final class MenuAction: NSObject {
    private let run: () -> Void
    private init(_ run: @escaping () -> Void) { self.run = run }
    @objc func fire(_ sender: Any?) { run() }
    static func item(_ title: String, _ run: (() -> Void)?) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: run == nil ? nil : #selector(fire(_:)), keyEquivalent: "")
        if let r = run { let a = MenuAction(r); i.target = a; i.representedObject = a }
        return i
    }
}

/// A fade from clear to the window's colour: the list goes on under it.
final class FadeEdge: NSView {
    private let g = CAGradientLayer()
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.addSublayer(g)
        setAccessibilityElement(false)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func hitTest(_ p: NSPoint) -> NSView? { nil }
    override func layout() { super.layout(); recolour() }
    override func viewDidChangeEffectiveAppearance() { recolour() }
    private func recolour() {
        CATransaction.begin(); CATransaction.setDisableActions(true)
        g.frame = bounds
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let c = Design.color("win")
            g.colors = [c.withAlphaComponent(0).cgColor, c.withAlphaComponent(0.85).cgColor]
        }
        // Flipped: the clear end on top.
        g.startPoint = CGPoint(x: 0.5, y: 0); g.endPoint = CGPoint(x: 0.5, y: 1)
        CATransaction.commit()
    }
    override var frame: NSRect { didSet { recolour() } }
}

/// The one-time hints (app.ts F): said once, at the thing they are about,
/// with Learn more and an x; dismissed either way, never again. The marks
/// are the hub's (GET and POST /api/onboarding `hints`: "needs-you",
/// "agent-pane", "pick"), shared with the Electron app. One at a time.
final class Hints {
    static let shared = Hints()
    static let changed = Notification.Name("RavenryHintsChanged")
    var hub: HubClient?
    private(set) var done = Set<String>()
    private(set) var loaded = false
    /// The hint on screen now (the first that asked).
    private(set) var current: String?
    /// The Learn card each points at.
    static let card = ["needs-you": "needs", "agent-pane": "panes", "pick": "pick"]

    func load() {
        hub?.get("/api/onboarding") { [weak self] code, j in
            guard let self, code == 200 else { return }
            self.done = Set(((j["hints"] as? [String: Any]) ?? [:]).filter { ($0.value as? Bool) == true }.map { $0.key })
            self.loaded = true
            NotificationCenter.default.post(name: Hints.changed, object: nil)
        }
    }

    /// Whether `id` shows now: read, not dismissed, and no other hint on screen.
    func wants(_ id: String) -> Bool {
        guard loaded, !done.contains(id), current == nil || current == id else { return false }
        current = id
        return true
    }

    /// Its thing went from the screen: another may show.
    func gone(_ id: String) { if current == id { current = nil } }

    func dismiss(_ id: String) {
        done.insert(id)
        if current == id { current = nil }
        hub?.post("/api/onboarding", ["hints": [id: true]]) { _, _ in }
        NotificationCenter.default.post(name: Hints.changed, object: nil)
    }
}

/// A one-time hint (.hint): its words (the first part bold) on --work, Learn more, and an x.
func hintView(_ id: String, bold: String, text: String, width: CGFloat, learn: @escaping (String) -> Void) -> NSView {
    let a = NSMutableAttributedString(string: bold + " ", attributes: [.font: Fonts.pt(12.5, .semibold), .foregroundColor: NSColor.white])
    a.append(NSAttributedString(string: text, attributes: [.font: NSFont.systemFont(ofSize: 12.5, weight: .regular), .foregroundColor: NSColor.white]))
    let words = label("", Fonts.pt(12.5), "tx", lines: 0)
    words.allowsEditingTextAttributes = true
    words.attributedStringValue = a
    words.preferredMaxLayoutWidth = max(100, width - 24)
    // White on --work in both appearances (no token is white in both): plain buttons.
    let more = PlainButton { Hints.shared.dismiss(id); learn(Hints.card[id] ?? "") }
    more.attributedTitle = NSAttributedString(string: t("hint.learnMore"), attributes: [.font: Fonts.pt(12.5, .semibold), .foregroundColor: NSColor.white, .underlineStyle: NSUnderlineStyle.single.rawValue])
    let x = PlainButton { Hints.shared.dismiss(id) }
    x.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: t("hint.dismiss"))?.withSymbolConfiguration(.init(pointSize: 11, weight: .semibold))
    x.contentTintColor = .white
    x.toolTip = t("hint.dismiss")
    x.setAccessibilityLabel(t("hint.dismiss"))
    let b = boxed(vstack([words, hstack([more, spring(), x], spacing: 8)], spacing: 6), fill: "work", radius: 9, insets: NSEdgeInsets(top: 9, left: 12, bottom: 7, right: 8))
    b.setAccessibilityElement(true)
    b.setAccessibilityRole(.group)
    b.setAccessibilityLabel("\(bold) \(text)")
    b.identifier = NSUserInterfaceItemIdentifier("hint-\(id)")
    return b
}

/// A borderless button that runs a closure (a hint's Learn more and x), drawn as its title or image says.
final class PlainButton: NSButton {
    var run: () -> Void
    init(_ run: @escaping () -> Void) {
        self.run = run
        super.init(frame: .zero)
        isBordered = false
        bezelStyle = .regularSquare
        title = ""
        target = self
        action = #selector(fire)
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc private func fire() { run() }
    override func resetCursorRects() { handCursor() }
    // The keyboard's ring (A11Y-004) around what it draws (a hint's Learn more, its x).
    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { NSBezierPath(roundedRect: bounds, xRadius: 4, yRadius: 4).fill() }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
}
