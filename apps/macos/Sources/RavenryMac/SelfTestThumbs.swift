// Pictures drawn again at once on a redraw (sidetest.mjs --screen cards,
// 2026-11-12). Reported: "the latest picture keeps blinking/refreshing": each
// new hub state drew the panel again with a new picture view that read the
// picture from the hub again, empty until it came. Here new hub states are
// pushed as the stream delivers them (HubClient.onState, through
// testCheckpoints): after each, before the run loop turns again, the new
// view's own drawing is the picture (its pixels, not that an image is set),
// then the window's pixels a moment later; the hub was asked for each
// picture once in all (HubClient.pictureReads, every picture request the
// app made). The same for the pick card's pictures, built again by states
// that change the card (the phone switch). Then a new latest picture (a
// new URL): read once, and the panel shows it, never empty on the way.

import AppKit

extension SelfTestBoard {
    /// RGBA bytes of `img` (part `crop`, in its pixels, top-left origin) scaled to w x h.
    private func thumbPixels(_ img: CGImage, _ w: Int, _ h: Int, crop: CGRect? = nil) -> [UInt8] {
        var px = [UInt8](repeating: 0, count: w * h * 4)
        px.withUnsafeMutableBytes { b in
            guard let ctx = CGContext(data: b.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
            ctx.interpolationQuality = .medium
            ctx.draw(crop.flatMap { img.cropping(to: $0) } ?? img, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
        return px
    }

    /// The share of points of `seen` (w x h) that match `pic` drawn as cover, centred.
    private func coverMatch(_ seen: [UInt8], _ w: Int, _ h: Int, _ pic: NSImage) -> Double {
        guard let cg = pic.cgImage(forProposedRect: nil, context: nil, hints: nil), pic.size.width > 0, pic.size.height > 0 else { return 0 }
        var want = [UInt8](repeating: 0, count: w * h * 4)
        want.withUnsafeMutableBytes { b in
            guard let ctx = CGContext(data: b.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
            let s = max(CGFloat(w) / pic.size.width, CGFloat(h) / pic.size.height)
            let dw = pic.size.width * s, dh = pic.size.height * s
            ctx.draw(cg, in: CGRect(x: (CGFloat(w) - dw) / 2, y: (CGFloat(h) - dh) / 2, width: dw, height: dh))
        }
        var same = 0
        for p in 0..<(w * h) where (0..<3).allSatisfy({ abs(Int(seen[p * 4 + $0]) - Int(want[p * 4 + $0])) <= 40 }) { same += 1 }
        return Double(same) / Double(w * h)
    }

    /// What `v` draws now (its own drawing, at once), matched with `pic` as cover: 0 when it draws nothing of it.
    private func drawsNow(_ v: NSView?, _ pic: NSImage?) -> Double {
        guard let v, let pic, v.bounds.width > 20, v.bounds.height > 20, let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return 0 }
        v.cacheDisplay(in: v.bounds, to: rep)
        guard let cg = rep.cgImage else { return 0 }
        let W = 48, H = max(8, Int((48 * v.bounds.height / v.bounds.width).rounded()))
        return coverMatch(thumbPixels(cg, W, H), W, H, pic)
    }

    /// What the window shows where `v` is (the window server's picture), matched with `pic` as cover.
    private func windowShows(_ v: NSView?, _ pic: NSImage?) -> Double {
        window.contentView?.layoutSubtreeIfNeeded()
        // In sight first: below a card, the panel's picture is under its fold.
        if let v, v.visibleRect.height < v.bounds.height - 1 { v.scrollToVisible(v.bounds); settle(0.15) }
        window.displayIfNeeded()
        guard let v, let pic, let root = window.contentView, v.window === window, let win = windowImage() else { return 0 }
        let k = CGFloat(win.width) / max(1, root.bounds.width)
        let r = v.convert(v.bounds, to: root)
        let y = root.isFlipped ? r.minY : root.bounds.height - r.maxY
        let place = CGRect(x: r.minX * k, y: y * k, width: r.width * k, height: r.height * k).integral
        let W = 48, H = max(8, Int((48 * place.height / max(1, place.width)).rounded()))
        return coverMatch(thumbPixels(win, W, H, crop: place), W, H, pic)
    }

    /// A new hub state, as the stream delivers one: `f` changes it, the checkpoints kept.
    private func pushState(_ f: @escaping ([String: Any]) -> [String: Any]) {
        let cps = board.hub.testCheckpoints
        board.hub.testPatch = f
        board.hub.testCheckpoints = cps
    }

    private func latestPictureURL(_ p: HubProject?) -> String? {
        (p?.brief?["pictures"] as? [[String: Any]])?.compactMap { $0["url"] as? String }.last
    }

    /// `pickKey`: the session whose open checkpoint is the pick (its card shows three pictures).
    func thumbsRedraw(pickKey: String) {
        let hub = board.hub
        let pct = { (x: Double) in "\(Int((x * 100).rounded()))%" }

        // MARK: the panel's latest picture
        guard let gp = hub.state?.projects.first(where: { latestPictureURL($0) != nil && !$0.sessions.isEmpty }), let s0 = gp.mainSession ?? gp.sessions.first,
              let url = latestPictureURL(gp) else { check("thumb_session_with_picture", false, "no project with a latest picture"); return }
        let key = "\(gp.id)/\(s0.surfaceId)"
        board.pickSession(key, why: "test")
        let loaded = wait(8) { self.board.panel.pictureView?.image != nil }
        let pic = board.panel.pictureView?.image
        check("thumb_shown", loaded && board.panel.key == key, "\(key): \(url)")
        var redraws = 0, notes: [String] = []
        var worstNow = 1.0, worstWin = 1.0
        for n in 1...8 {
            let before = board.panel.pictureView
            pushState { st in
                var st = st
                st["projects"] = (st["projects"] as? [[String: Any]] ?? []).map { var p = $0; p["selfTestTick"] = n; return p }
                return st
            }
            // Before the run loop turns: what a redraw draws first.
            window.contentView?.layoutSubtreeIfNeeded()
            let pv = board.panel.pictureView
            if pv !== before && pv != nil { redraws += 1 }
            let now = drawsNow(pv, pic)
            settle(0.25)
            let win = windowShows(board.panel.pictureView, pic)
            worstNow = min(worstNow, now); worstWin = min(worstWin, win)
            notes.append("\(n): \(pv !== before ? "new view" : "same view") drawn \(pct(now)) window \(pct(win))")
        }
        let reads = hub.pictureReads.filter { $0 == url }.count
        check("thumb_redrawn_per_state", redraws == 8, notes.joined(separator: " | "))
        check("thumb_never_empty_on_redraw", worstNow >= 0.9 && worstWin >= 0.6, "worst drawn at once \(pct(worstNow)), in the window \(pct(worstWin)); " + notes.joined(separator: " | "))
        check("thumb_read_once", reads == 1, "\(reads) requests for \(url) after 8 states")

        // MARK: the pick card's pictures, its card built again
        board.pickSession(pickKey, why: "test")
        _ = wait(6) { self.board.panel.shownCard?.kind == "pick" && self.board.panel.shownCard?.tiles.allSatisfy { $0.image != nil } == true }
        let vurls = (0..<(board.panel.shownCard?.tiles.count ?? 0)).map { "/api/checkpoints/\(board.panel.shownCard?.id ?? "")/variants/\($0)?as=png" }
        let vpics = board.panel.shownCard?.tiles.map { $0.image } ?? []
        var rebuilt = 0, cnotes: [String] = []
        var cWorstNow = 1.0, cWorstWin = 1.0
        for n in 1...6 {
            let before = board.panel.shownCard
            // The phone switch is part of the card (its "and on your phone"): the card is built again.
            pushState { st in
                var st = st
                var a = st["alerts"] as? [String: Any] ?? [:]
                a["enabled"] = n % 2 == 1; a["configured"] = true
                st["alerts"] = a
                st["projects"] = (st["projects"] as? [[String: Any]] ?? []).map { var p = $0; p["selfTestTick"] = 100 + n; return p }
                return st
            }
            window.contentView?.layoutSubtreeIfNeeded()
            let c = board.panel.shownCard
            if c !== before && c != nil { rebuilt += 1 }
            let now = zip(c?.tiles ?? [], vpics).map { drawsNow($0, $1) }.min() ?? 0
            settle(0.25)
            let win = zip(board.panel.shownCard?.tiles ?? [], vpics).map { windowShows($0, $1) }.min() ?? 0
            cWorstNow = min(cWorstNow, now); cWorstWin = min(cWorstWin, win)
            cnotes.append("\(n): \(c !== before ? "new card" : "same card") drawn \(pct(now)) window \(pct(win))")
        }
        let vreads = vurls.map { u in hub.pictureReads.filter { $0 == u }.count }
        check("pick_tiles_rebuilt_per_state", vurls.count == 3 && rebuilt == 6, cnotes.joined(separator: " | "))
        check("pick_tiles_never_empty_on_redraw", vurls.count == 3 && cWorstNow >= 0.9 && cWorstWin >= 0.6, "worst drawn at once \(pct(cWorstNow)), in the window \(pct(cWorstWin)); " + cnotes.joined(separator: " | "))
        check("pick_tiles_read_once", vurls.count == 3 && vreads.allSatisfy { $0 == 1 }, "requests per picture \(vreads) after 6 states")

        // MARK: a new latest picture: a new URL, read once, shown
        board.pickSession(key, why: "test")
        _ = wait(4) { self.board.panel.pictureView?.image != nil }
        guard let v0 = vurls.first, let newPic = vpics.first ?? nil else { check("thumb_new_picture", false, "no pick picture to use"); return }
        let newURL = v0 + "&selftest=new"
        var emptyOnTheWay = 0, steps = 0
        pushState { st in
            var st = st
            st["projects"] = (st["projects"] as? [[String: Any]] ?? []).map { p in
                guard p["id"] as? String == gp.id, var b = p["brief"] as? [String: Any] else { return p }
                var p = p
                b["pictures"] = (b["pictures"] as? [[String: Any]] ?? []) + [["path": "new.png", "alt": "The new picture", "url": newURL]]
                p["brief"] = b
                return p
            }
            return st
        }
        let shown = wait(8) {
            steps += 1
            if self.drawsNow(self.board.panel.pictureView, pic) < 0.9 && self.drawsNow(self.board.panel.pictureView, newPic) < 0.9 { emptyOnTheWay += 1 }
            return self.drawsNow(self.board.panel.pictureView, newPic) >= 0.9
        }
        settle(0.3)
        let winNew = windowShows(board.panel.pictureView, newPic)
        let newReads = hub.pictureReads.filter { $0 == newURL }.count
        check("thumb_new_picture_shown", shown && winNew >= 0.6 && newReads == 1 && emptyOnTheWay == 0,
              "drawn \(shown), in the window \(pct(winNew)), \(newReads) request(s) for it, \(emptyOnTheWay) of \(steps) looks neither picture")
        picture("native-thumb-new-picture.png")
        board.hub.testPatch = nil
        let cps = board.hub.testCheckpoints
        board.hub.testCheckpoints = cps
        settle(0.3)
    }
}
