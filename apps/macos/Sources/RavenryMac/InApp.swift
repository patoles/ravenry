// What the Electron app's own pages share (inapp.ts head(), app.css .pg-h,
// .pg-src, .pg-b): a page over the middle and the right columns (no tab
// strip, no panel), its head with a back link, a title and the line under
// it, more buttons, and Close; its body under it, padded 22 at the sides.

import AppKit

class InAppPage: Box {
    /// Close: back to what was in front before (Board.back()).
    var onClose: (() -> Void)?
    let head = Flipped()
    let body = Flipped()
    private(set) var closeButton: RButton!
    /// What the self-test presses: the page's buttons by name.
    var buttons: [String: RButton] = [:]

    init() {
        super.init(fill: "sheet")
        addSubview(head)
        addSubview(body)
    }
    required init?(coder: NSCoder) { fatalError() }

    /// The head: a back link, a title (20 bold), the line under it (12, tx3), more, and Close.
    func setHead(title: String?, src: String?, back: (String, () -> Void)? = nil, extra: [NSView] = []) {
        head.subviews.forEach { $0.removeFromSuperview() }
        var col: [NSView?] = []
        if let t0 = title { col.append(label(t0, Fonts.pt(20, .bold))) }
        if let s = src { col.append(label(s, Fonts.pt(12), "tx3")) }
        let tt = vstack(col, spacing: 4)
        tt.setContentHuggingPriority(.init(1), for: .horizontal)
        tt.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        var row: [NSView?] = []
        if let (name, run) = back {
            let b = RButton(name, .ghost, small: true, run: run)
            b.setTitle("‹  " + name)
            buttons["back"] = b
            row.append(b)
        }
        let close = RButton(t("page.close"), .icon, icon: "close") { [weak self] in self?.onClose?() }
        closeButton = close
        buttons["close"] = close
        // .pg-h: 18 above in the Electron app's sheet, under its 12 of window drag area.
        let h = hstack(row + [tt, spring()] + extra + [close], spacing: 8, insets: NSEdgeInsets(top: title == nil ? 22 : 30, left: 22, bottom: 14, right: 22))
        h.translatesAutoresizingMaskIntoConstraints = true
        h.autoresizingMask = [.width]
        head.addSubview(h)
        needsLayout = true
    }

    /// The head's height for the width it has.
    var headHeight: CGFloat { head.subviews.first.map { $0.fittingSize.height } ?? 0 }

    override func layout() {
        super.layout()
        let hh = ceil(headHeight)
        head.frame = NSRect(x: 0, y: 0, width: bounds.width, height: hh)
        head.subviews.first?.frame = head.bounds
        body.frame = NSRect(x: 0, y: hh, width: bounds.width, height: max(0, bounds.height - hh))
        layoutBody()
    }

    /// Lays out the body's views in `body.bounds` (each page its own).
    func layoutBody() {}
}

/// A view that draws an image as `object-fit: cover` in rounded corners,
/// and opens on a press.
final class CoverImage: NSView {
    var image: NSImage? { didSet { needsDisplay = true } }
    var radius: CGFloat = 0
    var fillColor = NSColor.black
    var dim: CGFloat = 1 { didSet { needsDisplay = true } }
    var onClick: (() -> Void)?
    override var isFlipped: Bool { true }
    override func draw(_ r: NSRect) {
        NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius).addClip()
        fillColor.setFill()
        bounds.fill()
        guard let img = image, img.size.width > 0, img.size.height > 0 else { return }
        let k = max(bounds.width / img.size.width, bounds.height / img.size.height)
        let w = img.size.width * k, h = img.size.height * k
        img.draw(in: NSRect(x: (bounds.width - w) / 2, y: (bounds.height - h) / 2, width: w, height: h), from: .zero, operation: .sourceOver, fraction: dim, respectFlipped: true, hints: nil)
    }
    override func mouseDown(with e: NSEvent) { onClick?() }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { onClick?(); return true }
}
