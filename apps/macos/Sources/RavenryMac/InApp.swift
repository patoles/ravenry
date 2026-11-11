// What the Electron app's own pages share (inapp.ts head(), app.css .pg-h,
// .pg-src, .pg-b): a page over the middle and the right columns (no tab
// strip, no panel), its head with a back link, a title and the line under
// it, more buttons, and Close; its body under it, padded 22 at the sides.

import AppKit

/// A view the middle shows that links back to where it was opened from:
/// a page's head, the brief's, a session's view, a project's page, Start,
/// a review, a pick. Board.showMiddle sets it from its back stack as the
/// view comes in front (nil: opened from the terminal or the sidebar).
protocol BackLinked: AnyObject {
    var backLink: (name: String, run: () -> Void)? { get set }
}

/// The back link every view draws the same way: "‹  Plans", small and quiet.
/// `reusing`: the head's link before a redraw. The same button is kept when it
/// names the same place, so a press that began on it before the page was drawn
/// again (the hub's refresh) still lands (NAV-001: a rebuilt head left the press
/// on a button no longer in the window).
func backButton(_ name: String, _ run: @escaping () -> Void, reusing old: RButton? = nil) -> RButton {
    if let old, old.title == "‹  " + name { old.run = run; old.removeFromSuperview(); return old }
    let b = RButton(name, .ghost, small: true, run: run)
    b.setTitle("‹  " + name)
    b.setAccessibilityLabel(t("page.backTo", ["name": name]))
    return b
}

class InAppPage: Box, BackLinked {
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

    /// The page it was opened from, as the head's back link ("‹ Plans") when
    /// the page gives none of its own: its name and how to go back to it.
    /// Set by the board as the page comes in front (nil: no link).
    /// A new place to go back to draws the head again as it was asked last.
    var backLink: (name: String, run: () -> Void)? {
        didSet { if oldValue?.name != backLink?.name { backLinkChanged() } }
    }
    /// The back link changed: the head drawn again (a page with a head of its own draws its own).
    func backLinkChanged() { headAgain?() }
    /// The last head asked for, to draw again with a new back link.
    private var headAgain: (() -> Void)?

    /// The head: a back link, a title (20 bold), the line under it (12, tx3), more, and Close.
    func setHead(title: String?, src: String?, back: (String, () -> Void)? = nil, extra: [NSView] = [], chip: NSView? = nil, srcView: NSView? = nil, closable: Bool = true) {
        headAgain = { [weak self] in self?.setHead(title: title, src: src, back: back, extra: extra, chip: chip, srcView: srcView, closable: closable) }
        head.subviews.forEach { $0.removeFromSuperview() }
        let back = back ?? backLink.map { ($0.name, $0.run) }
        var col: [NSView?] = []
        if let t0 = title {
            let tl = label(t0, Fonts.pt(20, .bold))
            // .pg-h h2: the title, then its chip (Default page, Your copy, the project).
            col.append(chip.map { c in hstack([tl, c, spring()], spacing: 10) } ?? tl)
        }
        if let s = src { col.append(label(s, Fonts.pt(12), "tx3")) }
        if let v = srcView { col.append(v) }
        // The line 2.5 under the title (h2's line box over .pg-src's, measured against the Electron app's).
        let tt = vstack(col, spacing: 2.5)
        tt.setContentHuggingPriority(.init(1), for: .horizontal)
        tt.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        var row: [NSView?] = []
        if let (name, run) = back {
            let b = backButton(name, run, reusing: buttons["back"])
            buttons["back"] = b
            row.append(b)
        }
        let close = RButton(t("page.close"), .icon, icon: "close") { [weak self] in self?.onClose?() }
        closeButton = close
        buttons["close"] = close
        // .pg-h: 18 above in the Electron app's sheet, under its 12 of window drag area, and
        // h2's half-leading: the title's ink 31 under the sheet's top, the line's 61, the body's 111 (1280, dark).
        let h = hstack(row + [tt, spring()] + extra + (closable ? [close] : []), spacing: 8, insets: NSEdgeInsets(top: 0, left: 22, bottom: 0, right: 22))
        // Above and below it set here: a row's own top and bottom insets are not in its fitting height.
        headPad = title == nil ? (17.5, 16.5) : (20, 14.5)
        h.translatesAutoresizingMaskIntoConstraints = true
        h.autoresizingMask = [.width]
        head.addSubview(h)
        needsLayout = true
    }

    /// Room above and below the head's row.
    private var headPad: (top: CGFloat, bottom: CGFloat) = (0, 0)
    /// The head's height for the width it has.
    var headHeight: CGFloat { head.subviews.first.map { headPad.top + $0.fittingSize.height + headPad.bottom } ?? 0 }

    override func layout() {
        super.layout()
        let hh = ceil(headHeight)
        head.frame = NSRect(x: 0, y: 0, width: bounds.width, height: hh)
        head.subviews.first?.frame = NSRect(x: 0, y: headPad.top, width: bounds.width, height: max(0, hh - headPad.top - headPad.bottom))
        body.frame = NSRect(x: 0, y: hh, width: bounds.width, height: max(0, bounds.height - hh))
        layoutBody()
    }

    /// Lays out the body's views in `body.bounds` (each page its own).
    func layoutBody() {}
}

/// A view that draws an image as `object-fit: cover` in rounded corners
/// (`fit`: the whole picture, `contain`, on `fillColor` where it leaves
/// room), and opens on a press.
final class CoverImage: NSView {
    var image: NSImage? { didSet { needsDisplay = true } }
    var fit = false { didSet { needsDisplay = true } }
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
        let k = fit ? min(bounds.width / img.size.width, bounds.height / img.size.height) : max(bounds.width / img.size.width, bounds.height / img.size.height)
        let w = img.size.width * k, h = img.size.height * k
        img.draw(in: NSRect(x: (bounds.width - w) / 2, y: (bounds.height - h) / 2, width: w, height: h), from: .zero, operation: .sourceOver, fraction: dim, respectFlipped: true, hints: nil)
    }
    override func mouseDown(with e: NSEvent) { onClick?() }
    override func resetCursorRects() { handCursor(onClick != nil) }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { onClick?(); return true }
}
