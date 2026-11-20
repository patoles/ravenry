// The hover highlight follows the pointer when the left column scrolls
// under it (scripts/sidetest.mjs --screen hoverscroll; Hover in
// Views.swift). The pointer is a point in the window (Hover.testPointer:
// the window is off every screen and the real pointer is never moved): a
// row lit as AppKit lights it when the pointer arrives, then the list
// scrolled under the still pointer (a trackpad's scroll events); after each,
// exactly the row under the pointer is lit, the one it left is not; the same
// on the idle lines, after the list's rows are drawn again, and with the
// pointer over no row (nothing lit). A picture of the sidebar after the
// scroll, sidebar-hoverscroll-dark-284.png.

import AppKit
import ImageIO

extension SelfTestBoard {
    /// Every Hovers view in the sidebar's list drawn now.
    private func listHovers() -> [NSView] {
        func walk(_ v: NSView) -> [NSView] { (v is Hovers && !v.isHiddenOrHasHiddenAncestor ? [v] : []) + v.subviews.flatMap(walk) }
        return board.sidebar.listView.documentView.map(walk) ?? []
    }
    /// The views lit now: told mouseEntered and lit (a Row's own hovering too).
    private func litHovers() -> [NSView] { listHovers().filter { Hover.isLit($0) || ($0 as? Row)?.hovering == true } }
    /// The views whose drawn place holds the window point `p`, inside the list's visible part (worked out from the frames alone).
    private func hoversAt(_ p: NSPoint) -> [NSView] {
        let clip = board.sidebar.listView.contentView
        guard clip.convert(clip.bounds, to: nil).contains(p) else { return [] }
        return listHovers().filter { ($0 as? Hovers)?.takesHover == true && $0.convert($0.bounds, to: nil).contains(p) }
    }
    private func names(_ vs: [NSView]) -> String { vs.map { ($0 as? Row).map { $0.key.isEmpty ? "row" : $0.key } ?? String(describing: type(of: $0)) }.joined(separator: ", ") }

    /// A trackpad's scroll of `dy` points down over the list (up when negative), as the person scrolls.
    private func wheel(_ dy: Int32) {
        guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: -dy, wheel2: 0, wheel3: 0), let e = NSEvent(cgEvent: cg) else { return }
        board.sidebar.listView.scrollWheel(with: e)
        settle(0.3)
    }

    /// Scrolls of `ns` points under the still pointer `p`, in turn: after each, the views lit are exactly those under `p`.
    private func scrollSteps(_ ns: [Int32], at p: NSPoint) -> (exact: Bool, said: String) {
        let clip = board.sidebar.listView.contentView
        var steps: [String] = []
        var allExact = true
        for n in ns {
            let y0 = clip.bounds.origin.y
            wheel(n)
            let lit = litHovers(), want = hoversAt(p)
            allExact = allExact && Set(lit.map(ObjectIdentifier.init)) == Set(want.map(ObjectIdentifier.init)) && clip.bounds.origin.y != y0
            steps.append("scroll \(n): scrolled \(Int(clip.bounds.origin.y - y0)) pt, lit [\(names(lit))], under the pointer [\(names(want))]")
        }
        return (allExact, steps.joined(separator: "; "))
    }
    /// The pointer arrives on `r`: AppKit tells the row (mouseEntered).
    private func pointerArrives(_ r: Row) -> NSPoint {
        let p = r.convert(NSPoint(x: r.bounds.midX, y: r.bounds.midY), to: nil)
        Hover.testPointer = p
        if let e = NSEvent.enterExitEvent(with: .mouseEntered, location: p, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, trackingNumber: 0, userData: nil) { r.mouseEntered(with: e) }
        settle(0.1)
        return p
    }

    func screenHoverScroll() {
        let sb = board.sidebar, list = sb.listView, clip = list.contentView
        // Short, so the list scrolls; Idle open, for more rows.
        size(1280, 760)
        board.toTerminal()
        settle(0.4)
        if sb.idleFolded, let h = sb.idleHead { click(h) }
        _ = wait(2) { !sb.idleFolded }
        board.render(force: true)
        settle(0.4)
        clip.scroll(to: .zero)
        list.reflectScrolledClipView(clip)
        settle(0.2)
        let docH = list.documentView?.frame.height ?? 0
        check("hoverscroll_list_scrolls", docH > clip.bounds.height + 60, "list \(Int(docH)) pt in \(Int(clip.bounds.height)) pt, idle open \(!sb.idleFolded)")

        // The pointer on the middle of the first session row in the upper half of
        // the list; a row further down (r2) that a scroll can bring under it.
        let top = clip.convert(clip.bounds, to: nil)
        let rows = listHovers().compactMap { $0 as? Row }.filter { $0.key.contains("/") || $0.key.hasPrefix("project:") }
        let doc = list.documentView ?? clip
        func docMid(_ r: Row) -> CGFloat { r.convert(NSPoint(x: r.bounds.midX, y: r.bounds.midY), to: doc).y }
        let maxScroll = docH - clip.bounds.height
        guard let r1 = rows.first(where: { let f = $0.convert($0.bounds, to: nil); return f.midY > top.midY && f.maxY < top.maxY }),
              let r2 = rows.first(where: { let d = docMid($0) - docMid(r1); return d > r1.bounds.height && d < maxScroll - 2 }) else {
            Hover.testPointer = nil
            return check("hoverscroll_rows_found", false, "rows \(names(rows)), list \(Int(docH)) in \(Int(clip.bounds.height))")
        }
        let d = Int32((docMid(r2) - docMid(r1)).rounded())
        let p = pointerArrives(r1)
        check("hoverscroll_lit_before", litHovers().map(ObjectIdentifier.init) == [ObjectIdentifier(r1)], "lit \(names(litHovers())), pointer on \(r1.key)")

        // Scrolled under the still pointer: half way to r2, on to r2, back to r1, down to r2 again.
        let run = scrollSteps([d / 2, d - d / 2, -d, d], at: p)
        let onR2 = hoversAt(p).contains { $0 === r2 } && r2.hovering && !r1.hovering
        check("hoverscroll_only_row_under_pointer_lit", run.exact && onR2, run.said + "; at the end \(r2.key) lit \(r2.hovering), \(r1.key) lit \(r1.hovering)")

        // The idle lines (what the person reported): the list at its end, the
        // pointer on the last idle line, scrolled up a line and down again.
        clip.scroll(to: NSPoint(x: 0, y: maxScroll))
        list.reflectScrolledClipView(clip)
        settle(0.2)
        // The pointer off the list first: nothing lit.
        Hover.testPointer = NSPoint(x: top.midX, y: top.maxY + 30)
        Hover.recheck(in: clip)
        let idleKeys = Set((board.hub.state?.sections.first { $0.group == "idle" }?.projects ?? []).map { "project:\($0.id)" })
        let idle = listHovers().compactMap { $0 as? Row }.filter { idleKeys.contains($0.key) }
        let shown = idle.filter { clip.convert(clip.bounds, to: nil).contains($0.convert($0.bounds, to: nil)) }
        if let i1 = shown.last, let i2 = shown.dropLast().last {
            let di = Int32((docMid(i2) - docMid(i1)).rounded())
            let pi = pointerArrives(i1)
            let runI = scrollSteps([di, -di, di], at: pi)
            let onI2 = hoversAt(pi).contains { $0 === i2 } && i2.hovering && !i1.hovering
            check("hoverscroll_idle_line_under_pointer_lit", runI.exact && onI2, runI.said + "; at the end \(i2.key) lit \(i2.hovering), \(i1.key) lit \(i1.hovering)")
        } else { check("hoverscroll_idle_line_under_pointer_lit", false, "idle lines shown \(names(shown)) of \(names(idle))") }

        // The list drawn again (a hub update) under the still pointer: the row under it lit, no other.
        board.render(force: true)
        settle(0.3)
        let lit2 = litHovers(), want2 = hoversAt(Hover.testPointer ?? p)
        check("hoverscroll_redraw_keeps_row_under_pointer", Set(lit2.map(ObjectIdentifier.init)) == Set(want2.map(ObjectIdentifier.init)) && !want2.isEmpty,
              "lit [\(names(lit2))], under the pointer [\(names(want2))]")

        // The sidebar after the scroll, the row under the pointer lit.
        let full = "sidebar-hoverscroll-dark-284-full.png"
        picture(full)
        let fu = dir.appendingPathComponent(full)
        if let src = CGImageSourceCreateWithURL(fu as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil),
           let cut = img.cropping(to: CGRect(x: 0, y: 0, width: min(img.width, Int(sb.frame.width * 2)), height: img.height)) {
            try? NSBitmapImageRep(cgImage: cut).representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("sidebar-hoverscroll-dark-284.png"))
            try? FileManager.default.removeItem(at: fu)
        }

        // The pointer over no row (above the list): a scroll leaves nothing lit.
        Hover.testPointer = NSPoint(x: top.midX, y: top.maxY + 30)
        wheel(-30)
        check("hoverscroll_pointer_off_rows_none_lit", litHovers().isEmpty, "lit [\(names(litHovers()))]")
        Hover.testPointer = nil
    }
}
