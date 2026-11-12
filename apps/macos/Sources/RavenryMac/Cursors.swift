// The pointer over the window, one rule for every view: a thing that does
// something when pressed (a button, a link, a row, a thumbnail, a tab, a
// link in text) shows the pointing hand; text that can be selected shows
// the I-beam, with the hand over a link in it; anything else the arrow.
//
// AppKit gives the cursor rects of every view in the window, also of one
// another view lies over: the terminal's I-beam, under a page laid over
// the stage, came back over the page's back link and buttons (the maintainer
// on 0.1.34: "Back navigation cursor stays the text cursor"). So each view's
// rects leave out what views over it take presses on (uncovered), and the
// window asks for them again when what lies over what changes
// (cursorRectsAgain).

import AppKit

extension NSRect {
    /// What is left of this rect around another: up to four rects.
    func minus(_ o: NSRect) -> [NSRect] {
        let i = intersection(o)
        if i.isEmpty { return [self] }
        return [NSRect(x: minX, y: minY, width: width, height: i.minY - minY),
                NSRect(x: minX, y: i.maxY, width: width, height: maxY - i.maxY),
                NSRect(x: minX, y: i.minY, width: i.minX - minX, height: i.height),
                NSRect(x: i.maxX, y: i.minY, width: maxX - i.maxX, height: i.height)]
            .filter { $0.width > 0 && $0.height > 0 }
    }
}

extension NSView {
    /// The parts of r (in this view) the pointer reaches: inside what shows
    /// of the view, and not under a view laid over it that takes presses
    /// (a later sibling of it or of one of its superviews; a view that lets
    /// presses through, a focus ring or a drop zone, covers nothing).
    func uncovered(_ r: NSRect) -> [NSRect] {
        var parts = [r.intersection(visibleRect)].filter { !$0.isEmpty }
        var v: NSView = self
        while let s = v.superview, !parts.isEmpty {
            if let i = s.subviews.firstIndex(where: { $0 === v }) {
                for o in s.subviews[(i + 1)...] where !o.isHidden && o.alphaValue > 0.01 && !o.frame.isEmpty {
                    guard o.hitTest(NSPoint(x: o.frame.midX, y: o.frame.midY)) != nil else { continue }
                    let f = convert(o.frame, from: s)
                    parts = parts.flatMap { $0.minus(f) }
                }
            }
            v = s
        }
        return parts
    }

    /// Whether a point of the view (its coordinates) is under a view laid over it.
    func covered(_ p: NSPoint) -> Bool { !uncovered(bounds).contains { $0.contains(p) } }

    /// The pointing hand over the whole view, where nothing lies over it:
    /// what every view that does something on a press calls from its
    /// resetCursorRects.
    func handCursor(_ on: Bool = true) {
        guard on else { return }
        for r in uncovered(bounds) { addCursorRect(r, cursor: .pointingHand) }
    }

    /// The I-beam over r but the hand over the links in it: selectable text with links.
    func textCursor(_ r: NSRect, links: [NSRect]) {
        var text = uncovered(r)
        for l in links { text = text.flatMap { $0.minus(l) } }
        for t in text { addCursorRect(t, cursor: .iBeam) }
        for l in links { for u in uncovered(l) { addCursorRect(u, cursor: .pointingHand) } }
    }
}

extension NSWindow {
    /// What lies over what changed (a page over the terminal, the
    /// filmstrip's frame, the panel over the window): every view's cursor
    /// rects are asked for again.
    func cursorRectsAgain() {
        guard let root = contentView?.superview ?? contentView else { return }
        func walk(_ v: NSView) { invalidateCursorRects(for: v); v.subviews.forEach(walk) }
        walk(root)
    }
}
