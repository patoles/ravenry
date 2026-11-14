// The picture viewer's zoom (PIC-002, PIC-005, PIC-006), on lighthouse's
// tall, wide and small pictures (scripts/gallery-fixture.mjs, sidetest.mjs
// --screen gallery):
// - a picture opens at its own fit (the whole picture, never a zoom left
//   from another picture or from its small copy), and zooms out to that fit
//   and no further, every way it opens;
// - a picture narrower or shorter than the view stays in its middle on
//   that axis, through the keys, a click, a pinch (during and after) and a
//   resize;
// - the zoom and the place stay to the point through new states and a new
//   picture, mid-pinch, mid-scroll and after, on the same picture.
// The pinch and the two-finger scroll are real trackpad events (CGEvent
// gesture and scroll phases) given to the scroll view's own handlers.

import AppKit

extension SelfTestBoard {
    /// A trackpad pinch step: `m` more (0.1 is 10% bigger), in phase 1 (began), 2 (changed) or 4 (ended).
    func pinchEvent(_ m: CGFloat, phase: Int64) -> NSEvent? {
        guard let ev = CGEvent(source: nil), let t = CGEventType(rawValue: 29) else { return nil }
        ev.type = t
        ev.setIntegerValueField(CGEventField(rawValue: 110)!, value: 8) // the gesture's kind: magnify
        ev.setDoubleValueField(CGEventField(rawValue: 113)!, value: Double(m))
        ev.setIntegerValueField(CGEventField(rawValue: 132)!, value: phase)
        ev.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(window.windowNumber))
        return NSEvent(cgEvent: ev)
    }

    /// A two-finger scroll step of (dx, dy) points, in phase 1 (began), 2 (changed) or 4 (ended).
    func panEvent(dx: Int32, dy: Int32, phase: Int64) -> NSEvent? {
        guard let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else { return nil }
        ev.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        ev.setIntegerValueField(CGEventField(rawValue: 99)!, value: phase)
        ev.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(window.windowNumber))
        return NSEvent(cgEvent: ev)
    }

    func screenGalleryZoom() {
        let g = board.gallery, z = g.zoom, hub = board.hub
        let pid = "lighthouse"
        size(1280, 820)
        let pics0 = GalleryPic.of(hub.state?.project(pid))
        guard let tall = pics0.firstIndex(where: { $0.name == "The whole page, tall" }), let wide = pics0.firstIndex(where: { $0.name == "The timeline, wide" }),
              let small = pics0.firstIndex(where: { $0.name == "The icon, small" }) else { check("gz_fixture", false, pics0.map { $0.name }.joined(separator: ", ")); return }
        let tallURL = pics0[tall].url, smallURL = pics0[small].url
        let sizes: [String: NSSize] = [pics0[tall].url: NSSize(width: 2880, height: 15714), pics0[wide].url: NSSize(width: 6000, height: 400), smallURL: NSSize(width: 120, height: 80)]

        // The picture in the view's points, and the area it shows in.
        func shown() -> (pic: NSRect, view: NSRect) { (z.convert(z.picture.bounds, from: z.picture), z.contentView.frame) }
        // Each axis: in the middle where the picture is smaller, else covering the view.
        func placed() -> (ok: Bool, why: String) {
            let (p, v) = shown()
            let x = p.width < v.width - 0.5 ? abs(p.midX - v.midX) < 0.75 : p.minX <= v.minX + 0.5 && p.maxX >= v.maxX - 0.5
            let y = p.height < v.height - 0.5 ? abs(p.midY - v.midY) < 0.75 : p.minY <= v.minY + 0.5 && p.maxY >= v.maxY - 0.5
            return (x && y, "pic \(p.integral) view \(v.integral)")
        }
        // The whole copy of the picture shown is in, at its fit: the whole picture, in the middle, no smaller zoom allowed.
        func wholeIn(_ url: String) -> Bool { g.cache.large[url] != nil && z.picture.image === g.cache.large[url] }
        func atFit(_ url: String) -> (ok: Bool, why: String) {
            let n = sizes[url] ?? .zero
            let (p, v) = shown()
            let whole = p.minX >= v.minX - 0.5 && p.maxX <= v.maxX + 0.5 && p.minY >= v.minY - 0.5 && p.maxY <= v.maxY + 0.5
            let ok = wholeIn(url) && z.picture.frame.size == n && abs(z.magnification - z.fit) < 0.0001 && z.minMagnification <= z.fit + 0.000001 && whole && placed().ok && !z.zoomed
            return (ok, "mag \(z.magnification) fit \(z.fit) min \(z.minMagnification) size \(z.picture.frame.size) whole \(whole) \(placed().why)")
        }
        func open(_ i: Int) { board.openGallery(pid, at: i); _ = wait(15) { wholeIn(g.pics[i].url) }; settle(0.3) }
        func plus(_ n: Int = 1) { for _ in 0..<n { window.makeFirstResponder(g); keyIn(window, 24, "+") } }
        func minus(_ n: Int = 1) { for _ in 0..<n { window.makeFirstResponder(g); keyIn(window, 27, "-") } }
        func pinch(_ steps: [CGFloat], end: Bool = true) {
            for (k, m) in steps.enumerated() { if let e = pinchEvent(m, phase: k == 0 ? 1 : 2) { z.magnify(with: e) }; settle(0.03) }
            if end, let e = pinchEvent(0, phase: 4) { z.magnify(with: e) }
            settle(0.1)
        }

        // 1. Another picture zoomed in, then a picture this window never read opens: at its own fit once its whole copy is in,
        //    and it zooms out to that fit, never stopped short of it.
        board.openGallery("garden-planner", at: 0)
        _ = wait(5) { z.picture.image != nil }
        settle(0.3)
        plus(2)
        let before = "garden \(z.magnification) (fit \(z.fit))"
        board.openGallery(pid, at: tall)
        let came = wait(15) { wholeIn(tallURL) }
        settle(0.3)
        let first = atFit(tallURL)
        check("gz_opens_at_its_fit", came && first.ok, "\(before); \(first.why)")
        plus(2)
        minus(4)
        let keysOut = z.magnification
        plus(1)
        // A real pinch's steps are a few hundredths each.
        pinch(Array(repeating: -0.05, count: 30))
        check("gz_zooms_out_to_its_fit", abs(keysOut - z.fit) < 0.0001 && atFit(tallURL).ok, "after - \(keysOut); after a pinch out \(atFit(tallURL).why)")

        // 2. Every way a picture opens, zoomed in on the one before: at its own fit.
        var ways: [String] = []
        func way(_ name: String, another: Bool = true, _ go: () -> Void) {
            plus(2)
            // Another picture's whole copy not read yet: it opens on its small copy, then the whole one comes.
            if another { g.cache.dropLarge() }
            go()
            guard let i = g.at else { ways.append("\(name): no picture"); return }
            let u = g.pics[i].url
            _ = wait(15) { wholeIn(u) }
            settle(0.3)
            let r = atFit(u)
            if !r.ok { ways.append("\(name): \(r.why)") }
        }
        open(tall)
        way("Next") { g.buttons["next"]?.performClick(nil) }
        way("Previous") { g.buttons["previous"]?.performClick(nil) }
        way("the strip") { if g.thumbs.count > small { click(g.thumbs[small]) } }
        way("Left") { window.makeFirstResponder(g); keyIn(window, 123) }
        way("Right") { window.makeFirstResponder(g); keyIn(window, 124) }
        way("Escape", another: false) { window.makeFirstResponder(g); keyIn(window, 53) }
        way("0", another: false) { window.makeFirstResponder(g); keyIn(window, 29, "0") }
        way("the grid's card") { window.makeFirstResponder(g); keyIn(window, 53); keyIn(window, 53); if g.cards.count > tall { click(g.cards[tall]) } }
        way("the last picture") { board.openGallery(pid, at: g.pics.count - 1) }
        way("the tall one again") { board.openGallery(pid, at: tall) }
        check("gz_every_way_opens_at_fit", ways.isEmpty, ways.joined(separator: " | "))

        // 3. In the middle on the axis where it is smaller: the tall one by keys and a pinch (during and after) and a resize,
        //    the wide one the same, the small one zoomed by a click off its middle.
        var off: [String] = []
        func mid(_ name: String) { let r = placed(); if !r.ok { off.append("\(name): \(r.why)") } }
        open(tall)
        mid("tall fitted")
        plus(2); mid("tall +")
        if let e = pinchEvent(0.3, phase: 1) { z.magnify(with: e) }
        mid("tall mid-pinch")
        if let e = pinchEvent(0.3, phase: 2) { z.magnify(with: e) }
        mid("tall mid-pinch 2")
        if let e = pinchEvent(0, phase: 4) { z.magnify(with: e) }
        settle(0.1); mid("tall after the pinch")
        let tallZoom = z.magnification
        pinch([-0.2]); mid("tall pinched out a little")
        size(900, 760); mid("tall zoomed, window narrower")
        size(1280, 820); mid("tall zoomed, window wider")
        minus(6); mid("tall - past its fit")
        _ = tallZoom
        open(wide)
        mid("wide fitted")
        plus(1); mid("wide +")
        pinch([0.25, 0.25]); mid("wide after a pinch")
        size(900, 760); mid("wide zoomed, window narrower")
        size(1280, 820)
        minus(6); mid("wide - past its fit")
        open(small)
        mid("small fitted")
        let sp = shown().pic
        click(z, at: NSPoint(x: sp.minX + sp.width * 0.2, y: sp.minY + sp.height * 0.25))
        settle(0.2)
        mid("small after a click off its middle (\(z.magnification))")
        plus(1); mid("small +")
        pinch([0.3]); mid("small after a pinch")
        window.makeFirstResponder(g); keyIn(window, 29, "0"); mid("small 0")
        check("gz_smaller_axis_in_the_middle", off.isEmpty && z.minMagnification <= z.fit + 0.000001, off.joined(separator: " | "))

        // Pictures: the tall one fitted, and zoomed in but still narrower than the view.
        open(tall)
        pictures("gallery-tall-fit")
        plus(3)
        mid("tall 3x in the picture")
        pictures("gallery-tall-zoomed")
        check("gz_tall_in_the_middle_after_resizes", placed().ok, placed().why)

        // 4. Zoomed and moved, mid-pinch: five new states, then a new picture first in the list: the same picture, the same
        //    zoom and the same place to the point; after the pinch ends, again; mid-scroll, again.
        let keepPatch = hub.testPatch
        // A state again, as the hub's next one (the self-test's patch and checkpoints made again).
        func newState() { let c = hub.testCheckpoints; hub.testCheckpoints = c }
        var added: [[String: Any]] = []
        func addPicture(_ n: Int) {
            added.insert(["url": smallURL + "&n=new\(n)", "name": "new-\(n).png", "at": ISO8601DateFormatter().string(from: Date())], at: 0)
            let more = added
            hub.testPatch = { r in
                var r = keepPatch?(r) ?? r
                var ps = r["projects"] as? [[String: Any]] ?? []
                if let i = ps.firstIndex(where: { $0["id"] as? String == pid }) {
                    var b = ps[i]["brief"] as? [String: Any] ?? [:]
                    // Once each (a state made again from the last one is patched again).
                    let urls = Set(more.compactMap { $0["url"] as? String })
                    b["gallery"] = more + (b["gallery"] as? [[String: Any]] ?? []).filter { !urls.contains($0["url"] as? String ?? "") }
                    ps[i]["brief"] = b
                    r["projects"] = ps
                }
                return r
            }
            newState()
            board.render()
            settle(0.4)
        }
        func states(_ n: Int) { for _ in 0..<n { newState(); board.render(); settle(0.15) } }
        func same(_ m0: CGFloat, _ r0: NSRect, _ u0: String) -> (ok: Bool, why: String) {
            let shownURL = g.at.map { g.pics[$0].url } ?? "-"
            let ok = z.magnification == m0 && z.contentView.bounds == r0 && shownURL == u0 && z.url == u0 && z.picture.image === g.cache.large[u0]
            return (ok, "mag \(m0) to \(z.magnification), seen \(r0) to \(z.contentView.bounds), picture \(u0.suffix(40)) to \(shownURL.suffix(40)) (\(z.url.suffix(40)))")
        }
        open(tall)
        plus(2)
        z.contentView.scroll(to: NSPoint(x: z.contentView.bounds.origin.x, y: z.contentView.bounds.origin.y + 900))
        z.reflectScrolledClipView(z.contentView)
        if let e = pinchEvent(0.2, phase: 1) { z.magnify(with: e) }
        if let e = pinchEvent(0.2, phase: 2) { z.magnify(with: e) }
        settle(0.1)
        var m0 = z.magnification, r0 = z.contentView.bounds
        let u0 = tallURL
        states(5)
        let s5 = same(m0, r0, u0)
        check("gz_mid_pinch_kept_through_states", s5.ok, s5.why)
        addPicture(1)
        let s6 = same(m0, r0, u0)
        check("gz_mid_pinch_kept_through_a_new_picture", s6.ok && g.pics.count == pics0.count + 1, s6.why)
        if let e = pinchEvent(0, phase: 4) { z.magnify(with: e) }
        settle(0.3)
        m0 = z.magnification; r0 = z.contentView.bounds
        states(5)
        addPicture(2)
        let s7 = same(m0, r0, u0)
        check("gz_after_pinch_kept_through_states_and_a_picture", s7.ok && (g.at.map { "\($0 + 1) of \(g.pics.count)" } ?? "") == "\(tall + 3) of \(pics0.count + 2)", s7.why)
        if let e = panEvent(dx: 0, dy: -40, phase: 1) { z.scrollWheel(with: e) }
        if let e = panEvent(dx: 0, dy: -60, phase: 2) { z.scrollWheel(with: e) }
        settle(0.1)
        m0 = z.magnification; r0 = z.contentView.bounds
        states(5)
        addPicture(3)
        let s8 = same(m0, r0, u0)
        if let e = panEvent(dx: 0, dy: 0, phase: 4) { z.scrollWheel(with: e) }
        settle(0.2)
        check("gz_mid_scroll_kept_through_states_and_a_picture", s8.ok, s8.why)
        // Back to the grid: ringed on the picture it showed, not on the one now at its old place.
        window.makeFirstResponder(g); keyIn(window, 53); keyIn(window, 53)
        check("gz_grid_rings_the_picture_shown", g.at == nil && g.lit.map { g.pics[$0].url } == u0, "lit \(String(describing: g.lit))")
        hub.testPatch = keepPatch
        newState()
        settle(0.3)
        g.closeButton.performClick(nil)
    }
}
