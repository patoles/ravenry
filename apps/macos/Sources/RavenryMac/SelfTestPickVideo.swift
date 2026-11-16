// A pick's videos (the pickvideo round, 2026-11-16; sidetest.mjs --screen
// pickvideo): an agent in a pane of a test daemon waits on a real `ravenry
// pick` of a video (A), a page that holds a video as a data: URI (B), a
// picture (C) and a second video (D), which the hub keeps and serves (the
// agent's files are changed and removed once it has: its copies are the only
// source). The card is built first from a copy with no `video` (a daemon's
// own, which reaches the window before the hub's, as on 2026-11-16), then
// the hub's; the fixture puts it on a demo session so the panel shows its card. Each check drives the control as the
// person would and reads where it lands: the card's first frames, a click
// that plays the video up close (the player's time moves on), the page's
// video playing the same way, Circle a part stopping it on a frame, a ring
// dragged on that frame, the answer the hub takes (region with t), and,
// after the run, what the agent got (sidetest.mjs).

import AppKit
import AVFoundation

extension SelfTestBoard {
    private func pvMouse(_ type: NSEvent.EventType, _ p: NSPoint) {
        if let e = NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                      context: nil, eventNumber: 0, clickCount: 1, pressure: 1) { window.sendEvent(e) }
    }
    private func pvJSON(_ d: Any?) -> String {
        guard let d, let j = try? JSONSerialization.data(withJSONObject: d, options: [.sortedKeys]) else { return "nil" }
        return String(decoding: j, as: UTF8.self)
    }

    func screenPickVideo() {
        guard let fx = ProcessInfo.processInfo.environment["RAVENRY_MAC_CARDS"], let d = try? Data(contentsOf: URL(fileURLWithPath: fx)),
              let cps = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]], let cp = cps.first, let id = cp["id"] as? String else { check("pv_fixture", false, "no RAVENRY_MAC_CARDS"); return }
        size(1280, 820)
        board.hub.testCheckpoints = cps
        settle(0.5)
        let key = "\(cp["projectId"] as? String ?? "")/\(cp["surfaceId"] as? String ?? "")"
        let pk = board.picker, pl = pk.video
        let vs = cp["variants"] as? [[String: Any]] ?? []
        let vurl = { (n: Int) in n < vs.count ? vs[n]["video"] as? String ?? "" : "" }
        // The videos' own sizes (sidetest.mjs, from ffprobe): the first frames must be theirs.
        let wantSizes = (cp["_want"] as? [String: Any])?["sizes"] as? [String] ?? ["640x360", "640x360"]
        check("pv_fixture", vs.count == 4 && vurl(0).hasSuffix("/variants/0") && vurl(1).hasSuffix("/variants/1?as=video") && vurl(2).isEmpty && vurl(3).hasSuffix("/variants/3"), vs.map { "\($0["type"] ?? "?") \($0["video"] ?? "-")" }.joined(separator: ", "))

        // The card built from a copy with no `video` (a daemon's own, first in the window), then the hub's:
        // each video's first frame with the play mark from the first copy on, the page's once the hub's came.
        var first = cp
        first["variants"] = vs.map { v -> [String: Any] in var x = v; x["video"] = nil; return x }
        board.hub.testCheckpoints = [first]
        settle(0.5)
        board.pickSession(key, why: "test")
        let card = { self.board.panel.shownCard }
        let early = wait(20) { card()?.kind == "pick" && card()?.tiles.count == 4 && card()?.tiles[0].image != nil && card()?.tiles[3].image != nil }
        let et = card()?.tiles ?? []
        check("pv_card_from_daemon_copy", early && et.count == 4 && et[0].playMark && et[3].playMark && !et[2].playMark, "tiles \(et.map { $0.image.map { "\(Int($0.size.width))x\(Int($0.size.height))" } ?? "none" }) marks \(et.map { $0.playMark })")
        board.hub.testCheckpoints = cps
        settle(0.5)
        board.render(force: true)
        let tilesIn = wait(20) { card()?.kind == "pick" && card()?.tiles.count == 4 && card()?.tiles.allSatisfy { $0.image != nil } == true }
        let tiles = card()?.tiles ?? []
        let sizes = tiles.map { $0.image.map { "\(Int($0.size.width))x\(Int($0.size.height))" } ?? "none" }
        check("pv_card_first_frames", tilesIn && tiles.count == 4 && tiles[0].playMark && tiles[1].playMark && !tiles[2].playMark && tiles[3].playMark && sizes[0] == wantSizes[0] && sizes[1] == wantSizes[0] && sizes[3] == wantSizes[min(1, wantSizes.count - 1)],
              "\(sizes.joined(separator: ", ")) want \(wantSizes) marks \(tiles.map { $0.playMark })")
        pictures("pickvideo-card")

        // A click on A's frame: up close, it plays (muted, looping, with its controls); its time moves on.
        if tiles.count == 4 { click(tiles[0]) }
        check("pv_card_click_opens_player", wait(6) { self.board.root.middle === pk && pk.viewing == 0 && !pl.isHidden && pk.zoom.isHidden }, "viewing \(String(describing: pk.viewing)) player hidden \(pl.isHidden)")
        _ = wait(10) { pl.player?.currentItem?.status == .readyToPlay && pl.time > 0.05 }
        let a0 = pl.time
        settle(1.5)
        let a1 = pl.time
        check("pv_click_plays_time_advances", a1 > a0 + 0.8 && pl.playing && pl.player?.isMuted == true && pl.playerView.controlsStyle == .inline && pl.url == vurl(0),
              "time \(a0) to \(a1) after 1.5 s, rate \(pl.player?.rate ?? -1), muted \(pl.player?.isMuted ?? false), url \(pl.url)")
        window.contentView?.layoutSubtreeIfNeeded()
        let vr = pl.videoRect
        check("pv_player_at_fit", "\(Int(pl.natural.width))x\(Int(pl.natural.height))" == wantSizes[0] && vr.minX >= -0.5 && vr.maxX <= pl.bounds.width + 0.5 && vr.minY >= -0.5 && vr.maxY <= pl.bounds.height + 0.5 && (abs(vr.width - pl.bounds.width) < 1 || abs(vr.height - pl.bounds.height) < 1),
              "natural \(pl.natural), video \(vr.integral) in \(pl.bounds.integral)")
        check("pv_strip_marks", pk.thumbs.count == 4 && pk.thumbs[0].playMark && pk.thumbs[1].playMark && !pk.thumbs[2].playMark && pk.thumbs[3].playMark)
        // Space pauses and plays it.
        window.makeFirstResponder(pk)
        if let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: " ", charactersIgnoringModifiers: " ", isARepeat: false, keyCode: 49) { window.sendEvent(e) }
        settle(0.3)
        let p0 = pl.time
        settle(0.6)
        check("pv_space_pauses", !pl.playing && abs(pl.time - p0) < 0.02, "rate \(pl.player?.rate ?? -1), time \(p0) then \(pl.time)")
        if let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: " ", charactersIgnoringModifiers: " ", isARepeat: false, keyCode: 49) { window.sendEvent(e) }
        settle(0.5)
        check("pv_space_plays", pl.playing && pl.time > p0 + 0.2, "rate \(pl.player?.rate ?? -1), time \(pl.time)")
        pictures("pickvideo-playing")

        // Next: B, the page that holds a video, plays its video the same way.
        pk.buttons["next"]?.performClick(nil)
        _ = wait(10) { pk.viewing == 1 && pl.url == vurl(1) && pl.time > 0.05 }
        let b0 = pl.time
        settle(1.2)
        check("pv_page_video_plays", pk.viewing == 1 && pl.url == vurl(1) && !pl.isHidden && pl.time > b0 + 0.6, "viewing \(String(describing: pk.viewing)) url \(pl.url) time \(b0) to \(pl.time)")
        // One plays at a time (the pickvideo round's fourth part): back and forth between A and B five times,
        // the one left stopped (its player paused, its time still), the one come to playing on.
        var switches: [String] = []
        for r in 1...5 {
            for (button, n) in [("previous", 0), ("next", 1)] {
                let left = pl.player, leftT = pl.time
                pk.buttons[button]?.performClick(nil)
                _ = wait(10) { pk.viewing == n && pl.url == vurl(n) && pl.time > 0.05 }
                let t0 = pl.time
                settle(1.0)
                let ok = pk.viewing == n && pl.url == vurl(n) && pl.playing && pl.time > t0 + 0.4 && left !== pl.player && (left?.rate ?? 0) == 0
                    && abs((left?.currentTime().seconds ?? leftT) - leftT) < 0.3
                switches.append("\(r)\(n == 0 ? "A" : "B") \(ok ? "ok" : "NO: rate left \(left?.rate ?? -1), time \(String(format: "%.2f", t0)) to \(String(format: "%.2f", pl.time))")")
            }
        }
        check("pv_switch_one_plays_left_stops", switches.allSatisfy { $0.hasSuffix("ok") }, switches.joined(separator: ", "))
        // C, a picture: the zoom as before, the player gone.
        pk.buttons["next"]?.performClick(nil)
        check("pv_picture_in_zoom", pk.viewing == 2 && pl.isHidden && !pk.zoom.isHidden && pl.player == nil, "viewing \(String(describing: pk.viewing)) player \(pl.player == nil ? "gone" : "kept")")
        // D, the second video, whose agent's file is gone: it plays from the hub's copy.
        pk.buttons["next"]?.performClick(nil)
        _ = wait(15) { pk.viewing == 3 && pl.url == vurl(3) && pl.time > 0.05 }
        let d0 = pl.time
        settle(1.2)
        check("pv_second_video_plays_source_gone", pk.viewing == 3 && pl.url == vurl(3) && pl.time > d0 + 0.6, "viewing \(String(describing: pk.viewing)) url \(pl.url) time \(d0) to \(pl.time)")
        pk.buttons["previous"]?.performClick(nil)
        pk.buttons["previous"]?.performClick(nil)
        _ = wait(10) { pl.url == vurl(1) && pl.time > 0.4 }
        settle(0.4)

        // Circle a part: B stops on the frame shown, no controls; a drag on it is the ring, in fractions of the video's frame.
        pk.buttons["circle"]?.performClick(nil)
        settle(0.3)
        let stopped = pl.time
        settle(0.5)
        check("pv_circle_stops_on_frame", pk.circling && pl.still && !pl.playing && abs(pl.time - stopped) < 0.02 && pl.playerView.controlsStyle == .none && pl.ring.drawing, "circling \(pk.circling) still \(pl.still) rate \(pl.player?.rate ?? -1) time \(stopped) then \(pl.time)")
        window.contentView?.layoutSubtreeIfNeeded()
        let rr = pl.ring
        let mid = rr.convert(NSPoint(x: rr.bounds.midX, y: rr.bounds.midY), to: nil)
        let a = NSPoint(x: mid.x - 60, y: mid.y + 30), b = NSPoint(x: mid.x + 60, y: mid.y - 30) // window points (y up)
        let hit = window.contentView?.hitTest(window.contentView!.convert(a, from: nil))
        pvMouse(.leftMouseDown, a)
        pvMouse(.leftMouseDragged, mid)
        pvMouse(.leftMouseDragged, b)
        pvMouse(.leftMouseUp, b)
        settle(0.3)
        let r4 = { (x: CGFloat) in (x * 10000).rounded() / 10000 }
        let W = rr.bounds.width, H = rr.bounds.height
        let want = NSRect(x: r4((W / 2 - 60) / W), y: r4((H / 2 - 30) / H), width: r4(120 / W), height: r4(60 / H))
        let got = pk.region ?? .zero
        check("pv_ring_routes_to_ring", hit === rr, "hit \(hit.map { String(describing: type(of: $0)) } ?? "none")")
        check("pv_ring_fractions_of_frame", pk.picked == 1 && !pk.circling && abs(got.minX - want.minX) < 0.00015 && abs(got.minY - want.minY) < 0.00015 && abs(got.width - want.width) < 0.00015 && abs(got.height - want.height) < 0.00015,
              "frame \(W)x\(H), want \(want), got \(got)")
        check("pv_ring_has_frame_time", pk.regionT.map { abs($0 - stopped) < 0.01 } == true && pl.still && abs(pl.time - stopped) < 0.02, "t \(String(describing: pk.regionT)), stopped at \(stopped), shown \(pl.time)")
        check("pv_note_field_pinned", wait(2) { pk.vnote != nil && self.window.firstResponder is NSTextView }, "\(String(describing: pk.vnote)) \(String(describing: window.firstResponder))")
        if let ed = window.firstResponder as? NSTextView { ed.insertText("Slower here", replacementRange: NSRange(location: NSNotFound, length: 0)) }
        settle(0.2)
        check("pv_send_counts_note", pk.buttons["send"]?.title == "Send B, with 1 note", pk.buttons["send"]?.title ?? "")
        window.makeFirstResponder(pk)
        settle(0.3)
        pictures("pickvideo-circled")

        // Send: the pick, its ring on the frame with the frame's second, the note; the hub takes it.
        let sent = board.hub.sentBodies.count
        pk.buttons["send"]?.performClick(nil)
        let last = { self.board.hub.sentBodies.dropFirst(sent).last { $0.path == "/api/checkpoints/answer" }?.body }
        _ = wait(6) { last() != nil }
        let p = last()?["pick"] as? [String: Any]
        let reg = p?["region"] as? [String: Any]
        let tt = (reg?["t"] as? NSNumber)?.doubleValue
        check("pv_send_posts_region_t", last()?["id"] as? String == id && p?["label"] as? String == "Take two" && p?["note"] as? String == "Slower here" && tt.map { abs($0 - stopped) < 0.01 } == true
              && (reg?["w"] as? NSNumber)?.doubleValue == Double(want.width), "\(pvJSON(last()))")
        check("pv_send_landed", wait(6) { self.board.hub.answers.last { $0.seq >= sent && $0.path == "/api/checkpoints/answer" }?.code == 200 }, "hub answered \(lastStatus("/api/checkpoints/answer") ?? 0)")
        // The region and its second for the agent's check (sidetest.mjs reads it from the result).
        check("pv_region_for_agent \(pvJSON(reg))", true)
        board.hub.testCheckpoints = nil
    }
}
