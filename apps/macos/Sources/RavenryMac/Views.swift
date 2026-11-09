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

/// A row that opens what it stands for: lit on hover (--sel), and when
/// selected with its ring (--selring). It opens on the press, as the
/// desktop's rows do (rowPress), and on Enter.
class Row: Box {
    var onOpen: (() -> Void)?
    var selected = false { didSet { restyle() } }
    var hoverFill = "sel"
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
        fill = selected || hovering ? hoverFill : nil
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
    /// The whole row takes the press (its labels and stacks are its
    /// drawing), except its own buttons (the pin).
    override func hitTest(_ p: NSPoint) -> NSView? {
        guard let v = super.hitTest(p) else { return nil }
        var x: NSView? = v
        while let c = x, c !== self { if c is NSButton { return v }; x = c.superview }
        return self
    }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { onOpen?(); return true }
}

func label(_ s: String, _ font: NSFont, _ color: String = "tx", lines: Int = 1, select: Bool = false) -> NSTextField {
    let f = lines == 1 ? NSTextField(labelWithString: s) : NSTextField(wrappingLabelWithString: s)
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
    override var isEnabled: Bool { didSet { if iconView == nil { setTitle(title) } } }
    override var intrinsicContentSize: NSSize {
        if iconView != nil { return NSSize(width: small ? 26 : 30, height: small ? 26 : 30) }
        let t = attributedTitle.size()
        if kind == .link { return NSSize(width: ceil(t.width), height: ceil(t.height)) }
        return NSSize(width: ceil(t.width) + (small ? 20 : 26) + (lead == nil ? 0 : 20), height: small ? 28 : 32)
    }
    @objc private func fire() { run?() }
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
    override func mouseEntered(with e: NSEvent) { hover = true; if kind == .link { NSCursor.pointingHand.push() } }
    override func mouseExited(with e: NSEvent) { hover = false; if kind == .link { NSCursor.pop() } }
    override func viewDidChangeEffectiveAppearance() { if iconView == nil { setTitle(title) }; if lead != nil { leadImage() }; needsDisplay = true }
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
        NSLayoutConstraint.activate([
            doc.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            doc.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
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
