// A pick's pictures up close (the pickzoom round, 2026-11-15; sidetest.mjs
// --screen pickzoom): an agent in a pane of a test daemon waits on a real
// `ravenry pick` of four big sheets, which the hub keeps and serves; the
// fixture puts it on a demo session so the panel shows its card. Each check
// drives the control as the person would (a click on the card's picture, the
// picture, the arrows, the strip, a trackpad pinch and two-finger pan, Ctrl
// and the wheel, the keys, a ring dragged while zoomed) and reads where it
// lands: the picker's viewer, the zoom's magnification and place, the ring's
// fractions of the whole picture, the answer the hub takes (200), and, after
// the run, what the agent got (sidetest.mjs).

import AppKit

extension SelfTestBoard {
    private func pzKey(_ chars: String, code: UInt16 = 0, mods: NSEvent.ModifierFlags = []) {
        if let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                    context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code) { window.sendEvent(e) }
        settle(0.2)
    }
    private func pzMouse(_ type: NSEvent.EventType, _ p: NSPoint, mods: NSEvent.ModifierFlags = []) {
        if let e = NSEvent.mouseEvent(with: type, location: p, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                      context: nil, eventNumber: 0, clickCount: 1, pressure: 1) { window.sendEvent(e) }
    }
    /// A scroll (with Ctrl, a zoom) of (dx, dy) lines at a point of `v`. A trackpad's two-finger
    /// pan comes in phases, which the scroll view follows with the screen's display link, and an
    /// offscreen window has no screen (AppKit raises "Can't resume an NSScrollingConcurrentVBLMonitor
    /// with nil screen"): the same scroll view's scrolling is driven by the wheel's lines here.
    private func pzScroll(_ v: NSView, at p: NSPoint, dx: Int32, dy: Int32, ctrl: Bool = false) -> NSEvent? {
        guard let ev = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else { return nil }
        ev.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(window.windowNumber))
        if ctrl { ev.flags = .maskControl }
        // Where the pointer is: the point of the view, in the displays' top-left coordinates.
        let s = window.convertPoint(toScreen: v.convert(p, to: nil))
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        ev.location = CGPoint(x: s.x, y: top - s.y)
        return NSEvent(cgEvent: ev)
    }
    /// A pan of the zoomed picture by (dx, dy) points: the scroll view's own scrolling, given the
    /// wheel's lines. An offscreen window is on no screen, and AppKit then lands no scroll (it
    /// moves the clip on the screen's refresh): there the clip is moved as the scroll would, by
    /// the same points through its own rule (CentringClip), and the detail says so.
    private func pzPan(_ z: ZoomView, at p: NSPoint, dx: CGFloat, dy: CGFloat) -> String {
        let o = z.contentView.bounds.origin
        if let e = pzScroll(z, at: p, dx: Int32(-dx / 10), dy: Int32(-dy / 10)) { z.scrollWheel(with: e) }
        window.displayIfNeeded()
        settle(0.3)
        if z.contentView.bounds.origin != o { return "scrolled by the wheel" }
        let c = z.contentView
        c.scroll(to: c.constrainBoundsRect(NSRect(origin: NSPoint(x: o.x + dx / z.magnification, y: o.y + dy / z.magnification), size: c.bounds.size)).origin)
        z.reflectScrolledClipView(c)
        settle(0.2)
        return "window on \(window.screen == nil ? "no screen" : "a screen"): the clip moved as the scroll would"
    }
    private func pzJSON(_ d: Any?) -> String {
        guard let d, let j = try? JSONSerialization.data(withJSONObject: d, options: [.sortedKeys]) else { return "nil" }
        return String(decoding: j, as: UTF8.self)
    }

    func screenPickZoom() {
        guard let fx = ProcessInfo.processInfo.environment["RAVENRY_MAC_CARDS"], let d = try? Data(contentsOf: URL(fileURLWithPath: fx)),
              let cps = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]], let cp = cps.first, let id = cp["id"] as? String else { check("pz_fixture", false, "no RAVENRY_MAC_CARDS"); return }
        // A wheel's lines scroll at once, not animated over the screen's refreshes (an offscreen window has none).
        UserDefaults.standard.set(false, forKey: "NSScrollAnimationEnabled")
        size(1280, 820)
        board.hub.testCheckpoints = cps
        settle(0.5)
        let key = "\(cp["projectId"] as? String ?? "")/\(cp["surfaceId"] as? String ?? "")"
        let pk = board.picker, z = pk.zoom
        let n = (cp["variants"] as? [Any] ?? []).count
        check("pz_fixture", n == 4, "\(n) variants, id \(id)")

        // Side by side: each picture whole (never cropped to its 16:10 well), drawn as the hub sent it.
        board.openPicker(id)
        check("pz_side_pictures", wait(10) { pk.images.count == 4 && pk.images.allSatisfy { $0.image != nil } }, "\(pk.images.map { $0.image?.size ?? .zero })")
        window.contentView?.layoutSubtreeIfNeeded()
        let whole = pk.images.enumerated().map { (i, v) -> (Bool, String) in
            guard let img = v.image else { return (false, "\(i): none") }
            let pr = v.pictureRect, b = v.bounds
            let inside = pr.minX >= -0.5 && pr.minY >= -0.5 && pr.maxX <= b.width + 0.5 && pr.maxY <= b.height + 0.5
            let same = abs(pr.width / pr.height - img.size.width / img.size.height) < 0.01
            let touches = abs(pr.width - b.width) < 1 || abs(pr.height - b.height) < 1
            return (inside && same && touches, "\(i): picture \(Int(img.size.width))x\(Int(img.size.height)) drawn \(Int(pr.width))x\(Int(pr.height)) in \(Int(b.width))x\(Int(b.height))")
        }
        check("pz_side_whole", whole.allSatisfy { $0.0 }, whole.map { $0.1 }.joined(separator: "; "))
        let pd = pickDrawn(pk)
        check("pz_side_whole_pixels", pd.ok, pd.detail)
        pictures("pickzoom-side")
        // A click on a picture side by side opens it up close.
        if pk.images.count > 2 { click(pk.images[2]) }
        check("pz_side_click_opens_viewer", pk.viewing == 2 && !z.isHiddenOrHasHiddenAncestor && pk.scroll.isHidden, "viewing \(String(describing: pk.viewing))")
        pk.buttons["all"]?.performClick(nil)
        check("pz_all_back_to_side", pk.viewing == nil && !pk.scroll.isHidden && z.isHiddenOrHasHiddenAncestor)
        pk.buttons["close"]?.performClick(nil)
        settle(0.3)

        // The panel's card: a click on picture B opens the viewer on B, at its fit.
        board.pickSession(key, why: "test")
        let card = { self.board.panel.shownCard }
        check("pz_card_shown", wait(6) { card()?.kind == "pick" && card()?.tiles.count == 4 && card()?.tiles.allSatisfy { $0.image != nil } == true }, board.panel.key)
        if let c = card(), c.tiles.count > 1 { click(c.tiles[1]) }
        check("pz_card_click_opens_viewer", wait(4) { self.board.root.middle === pk && pk.viewing == 1 }, "\(board.front) viewing \(String(describing: pk.viewing))")
        _ = wait(8) { z.picture.image != nil && (z.picture.image?.size.width ?? 0) > 2000 }
        settle(0.3)
        window.contentView?.layoutSubtreeIfNeeded()
        let shown = { (z.convert(z.picture.bounds, from: z.picture), z.contentView.frame) }
        var (pr, vr) = shown()
        check("pz_viewer_at_fit", !z.zoomed && pr.minX >= vr.minX - 0.5 && pr.maxX <= vr.maxX + 0.5 && pr.minY >= vr.minY - 0.5 && pr.maxY <= vr.maxY + 0.5 && (abs(pr.width - vr.width) < 1 || abs(pr.height - vr.height) < 1) && pk.chip.isHidden,
              "picture \(pr.integral) view \(vr.integral) mag \(z.magnification)")
        check("pz_viewer_head", pk.buttons["all"]?.title == "‹  All 4" && pk.buttons["pick2"]?.title == "Pick B" && pk.thumbs.count == 4, "\(pk.buttons["all"]?.title ?? "") \(pk.buttons["pick2"]?.title ?? "")")
        pictures("pickzoom-fit")

        // A click zooms in around the point clicked: the picture's point under the pointer stays there.
        let vp = NSPoint(x: z.bounds.width * 0.62, y: z.bounds.height * 0.3)
        let wp = z.convert(vp, to: nil)
        let before = z.picture.convert(wp, from: nil), m0 = z.magnification
        click(z, at: vp)
        let after = z.picture.convert(wp, from: nil)
        check("pz_click_zooms_at_point", z.zoomed && z.magnification > m0 * 1.5 && hypot(after.x - before.x, after.y - before.y) * z.magnification < 1.5,
              "mag \(m0) to \(z.magnification), picture point \(before) to \(after)")
        check("pz_chip_says", !pk.chip.isHidden && pk.chip.pct.stringValue == "\(Int((z.magnification * 100).rounded()))%", pk.chip.pct.stringValue)
        // Two fingers pan.
        var o0 = z.contentView.bounds.origin
        let how = pzPan(z, at: vp, dx: 60, dy: 80)
        check("pz_two_finger_pan", z.contentView.bounds.origin != o0 && z.zoomed && !pk.chip.isHidden, "origin \(o0) to \(z.contentView.bounds.origin) (\(how))")
        // Ctrl and the wheel: up zooms in, around the pointer.
        var m1 = z.magnification
        let cw = pzScroll(z, at: vp, dx: 0, dy: 3, ctrl: true)
        if let e = cw { z.scrollWheel(with: e) }
        settle(0.2)
        check("pz_ctrl_wheel_zooms", z.magnification > m1 * 1.05, "mag \(m1) to \(z.magnification) (fit \(z.fit), max \(z.maxMagnification), image \(z.picture.image != nil)), event \(cw.map { "\($0.scrollingDeltaY) ctrl \($0.modifierFlags.contains(.control)) at \($0.locationInWindow)" } ?? "nil")")
        // The keys: - out, + in, 0 fits; the chip fits too.
        window.makeFirstResponder(pk)
        var m2 = z.magnification
        pzKey("-")
        let mMinus = z.magnification
        pzKey("+")
        check("pz_keys_zoom", mMinus < m2 && z.magnification > mMinus, "mag \(m2), - \(mMinus), + \(z.magnification)")
        pzKey("0")
        check("pz_key_0_fits", !z.zoomed && pk.chip.isHidden, "mag \(z.magnification)")
        click(z, at: vp)
        if !pk.chip.isHidden { click(pk.chip) }
        check("pz_chip_fits", !z.zoomed && pk.chip.isHidden)
        // A pinch zooms around the pointer.
        // (Last of the zooms: the scroll view settles a made-up gesture's end on a later turn of the loop.)
        click(z, at: vp)
        m2 = z.magnification
        for (m, ph) in [(CGFloat(0.1), Int64(1)), (0.2, 2), (0.0, 4)] { if let e = pinchEvent(m, phase: ph) { z.magnify(with: e) } }
        settle(0.6)
        check("pz_pinch_zooms", z.magnification > m2 * 1.1, "mag \(m2) to \(z.magnification)")
        window.makeFirstResponder(pk)
        pzKey("0")
        settle(0.3)
        if z.zoomed { pzKey("0") }
        // Next, Previous, the arrows, the strip: each picture at its own fit.
        click(z, at: vp)
        pk.buttons["next"]?.performClick(nil)
        _ = wait(4) { (z.picture.image?.size.width ?? 0) > 1000 }
        check("pz_next", pk.viewing == 2 && !z.zoomed && z.url.hasSuffix("/variants/2?as=png"), "viewing \(String(describing: pk.viewing)) \(z.url)")
        pk.buttons["previous"]?.performClick(nil)
        check("pz_previous", pk.viewing == 1 && !z.zoomed)
        window.makeFirstResponder(pk)
        pzKey("\u{F703}", code: 124)
        check("pz_right_arrow", pk.viewing == 2)
        pzKey("\u{F702}", code: 123)
        check("pz_left_arrow", pk.viewing == 1)
        if pk.thumbs.count == 4 { click(pk.thumbs[3]) }
        check("pz_strip_goes", pk.viewing == 3, "viewing \(String(describing: pk.viewing))")
        // Pick from the viewer: the number keys and the bar's Pick.
        window.makeFirstResponder(pk)
        pzKey("3")
        check("pz_number_key_picks", pk.picked == 2 && pk.viewing == 2 && pk.buttons["send"]?.title == "Send C" && pk.buttons["pick3"]?.title == "Picked", "picked \(String(describing: pk.picked)) send \(pk.buttons["send"]?.title ?? "")")
        if pk.thumbs.count == 4 { click(pk.thumbs[1]) }
        pk.buttons["pick2"]?.performClick(nil)
        check("pz_pick_button_picks", pk.picked == 1 && pk.viewing == 1 && pk.buttons["send"]?.title == "Send B" && pk.thumbs.count == 4)
        // Esc: a zoomed picture fits, then side by side, then a click on B there opens it again.
        click(z, at: vp)
        window.makeFirstResponder(pk)
        pzKey("\u{1b}", code: 53)
        check("pz_escape_fits", pk.viewing == 1 && !z.zoomed)
        pzKey("\u{1b}", code: 53)
        check("pz_escape_side_by_side", pk.viewing == nil && board.root.middle === pk && !pk.scroll.isHidden)
        if pk.images.count > 1 { click(pk.images[1]) }
        check("pz_side_click_opens_b", pk.viewing == 1)
        _ = wait(4) { (z.picture.image?.size.width ?? 0) > 2000 }

        // Circle a part while zoomed: at 100% (the picture's own size) with
        // its point (0.6, 0.3) in the middle of the view, a drag from 40 x 20
        // points up-left of the middle to as much down-right is, in
        // fractions of the whole picture, (0.6 W - 40) / W, (0.3 H - 20) / H,
        // 80 / W, 40 / H.
        let W = z.picture.bounds.width, H = z.picture.bounds.height
        z.zoom(to: 1, keeping: NSPoint(x: 0.6 * W, y: 0.3 * H), at: NSPoint(x: z.contentView.bounds.width * z.magnification / 2, y: z.contentView.bounds.height * z.magnification / 2))
        pk.zoomMoved()
        settle(0.2)
        let mag = z.magnification
        pk.buttons["circle"]?.performClick(nil)
        check("pz_circle_mode_while_zoomed", pk.circling && pk.pickRing.drawing && z.zoomed && pk.buttons["circle"]?.title == "Drag on a picture", "circling \(pk.circling) zoomed \(z.zoomed)")
        let clip = z.contentView
        let mid = clip.convert(NSPoint(x: clip.bounds.midX, y: clip.bounds.midY), to: nil)
        let a = NSPoint(x: mid.x - 40, y: mid.y + 20), b = NSPoint(x: mid.x + 40, y: mid.y - 20) // window points (y up)
        let hit = window.contentView?.hitTest(window.contentView!.convert(a, from: nil))
        pzMouse(.leftMouseDown, a)
        pzMouse(.leftMouseDragged, NSPoint(x: mid.x, y: mid.y))
        pzMouse(.leftMouseDragged, b)
        pzMouse(.leftMouseUp, b)
        settle(0.3)
        // The picture's point in the middle, from the clip (origin in the picture's points) and the magnification.
        let c0 = NSPoint(x: clip.bounds.midX, y: clip.bounds.midY)
        let r4 = { (x: CGFloat) in (x * 10000).rounded() / 10000 }
        let want = NSRect(x: r4((c0.x - 40 / mag) / W), y: r4((c0.y - 20 / mag) / H), width: r4(80 / mag / W), height: r4(40 / mag / H))
        let got = pk.region ?? .zero
        check("pz_ring_routes_to_ring", hit === pk.pickRing, "hit \(hit.map { String(describing: type(of: $0)) } ?? "none")")
        check("pz_ring_fractions_of_whole", pk.picked == 1 && !pk.circling && abs(got.minX - want.minX) < 0.00015 && abs(got.minY - want.minY) < 0.00015 && abs(got.width - want.width) < 0.00015 && abs(got.height - want.height) < 0.00015
              && abs(c0.x - 0.6 * W) < 1 && abs(c0.y - 0.3 * H) < 1 && abs(mag - 1) < 0.001,
              "mag \(mag), middle \(c0) of \(W)x\(H), want \(want), got \(got)")
        check("pz_ring_drawn_on_picture", pk.pickRing.region == pk.region && abs(pk.pickRing.mag - z.magnification) < 0.0001)
        // The note, typed in the pinned field beside the ring.
        check("pz_note_field_pinned", wait(2) { pk.vnote != nil && self.window.firstResponder is NSTextView }, "\(String(describing: pk.vnote)) \(String(describing: window.firstResponder))")
        if let ed = window.firstResponder as? NSTextView { ed.insertText("Make Allow the bigger button", replacementRange: NSRange(location: NSNotFound, length: 0)) }
        settle(0.2)
        check("pz_send_counts_note", pk.buttons["send"]?.title == "Send B, with 1 note", pk.buttons["send"]?.title ?? "")
        pictures("pickzoom-circled")
        // The note follows the ring through a pan.
        let ringOn = { () -> NSRect in let g = pk.region ?? .zero, pb = z.picture.bounds; return pk.convert(NSRect(x: g.minX * pb.width, y: g.minY * pb.height, width: g.width * pb.width, height: g.height * pb.height), from: z.picture) }
        window.makeFirstResponder(pk)
        settle(0.2)
        let n0 = pk.vnote.map { pk.convert($0.bounds, from: $0) } ?? .zero, r0 = ringOn()
        o0 = z.contentView.bounds.origin
        let how2 = pzPan(z, at: vp, dx: 0, dy: 60)
        settle(0.2)
        let n1 = pk.vnote.map { pk.convert($0.bounds, from: $0) } ?? .zero, r1 = ringOn()
        check("pz_note_follows_ring", z.contentView.bounds.origin != o0 && abs((n1.minY - n0.minY) - (r1.minY - r0.minY)) < 1.5 && abs(n1.minX - r1.maxX - 10) < 1.5 && !(pk.vnote?.isHidden ?? true),
              "ring \(r0.integral) to \(r1.integral), note \(n0.integral) to \(n1.integral) (\(how2))")
        (pr, vr) = shown()
        // Send: the pick, its ring in fractions of the whole picture, the note; the hub takes it.
        let sent = board.hub.sentBodies.count
        pk.buttons["send"]?.performClick(nil)
        let last = { self.board.hub.sentBodies.dropFirst(sent).last { $0.path == "/api/checkpoints/answer" }?.body }
        _ = wait(6) { last() != nil }
        let p = last()?["pick"] as? [String: Any]
        let wantJSON = pzJSON(["x": NSDecimalNumber(string: String(format: "%.4f", Double(want.minX))), "y": NSDecimalNumber(string: String(format: "%.4f", Double(want.minY))),
                               "w": NSDecimalNumber(string: String(format: "%.4f", Double(want.width))), "h": NSDecimalNumber(string: String(format: "%.4f", Double(want.height)))])
        check("pz_send_posts", last()?["id"] as? String == id && p?["label"] as? String == "Alerts" && pzJSON(p?["region"]) == wantJSON && p?["note"] as? String == "Make Allow the bigger button",
              "\(pzJSON(last())) want region \(wantJSON)")
        check("pz_send_landed", wait(6) { self.board.hub.answers.last { $0.seq >= sent && $0.path == "/api/checkpoints/answer" }?.code == 200 }, "hub answered \(lastStatus("/api/checkpoints/answer") ?? 0)")
        // The region for the agent's check (sidetest.mjs reads it from the result).
        check("pz_region_for_agent \(wantJSON)", true)
        board.hub.testCheckpoints = nil
    }
}
