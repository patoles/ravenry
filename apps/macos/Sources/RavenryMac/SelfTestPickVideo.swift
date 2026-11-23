// A pick's videos (the pickvideo round, 2026-11-16; sidetest.mjs --screen
// pickvideo): an agent in a pane of a test daemon waits on a real `ravenry
// pick` of a video (A), a page that holds a video as a data: URI (B), a
// picture (C) and a second video (D), which the hub keeps and serves (the
// agent's files are changed and removed once it has: its copies are the only
// source). The card is built first from the agent's daemon's own copy (no
// `video`, no `videoType`: it reaches the window before the hub's, as on
// 2026-11-16 and 2026-11-17), then the hub's; the fixture puts it on a demo session so the panel shows its card. Each check drives the control as the
// person would and reads where it lands: the card's first frames, a click
// that plays the video up close (the player's time moves on), the page's
// video playing the same way, Circle a part stopping it on a frame, a ring
// dragged on that frame, the answer the hub takes (region with t), and,
// after the run, what the agent got (sidetest.mjs).

import AppKit
import AVFoundation
import VideoToolbox

extension SelfTestBoard {
    /// The agents' daemon the card first reaches the window from (its own copy), by a name of the self-test's.
    static let pvAgentsDaemon = "sidetest-agents-daemon"
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
        // SIDETEST_PICK_MIX (sidetest.mjs): the card sent to the person's Mac, a VP9, a VP8 and an AV1 .webm.
        if (cp["_want"] as? [String: Any])?["mix"] as? Bool == true { screenPickVideoMix(cp); return }
        board.hub.testCheckpoints = cps
        settle(0.5)
        let key = "\(cp["projectId"] as? String ?? "")/\(cp["surfaceId"] as? String ?? "")"
        let pk = board.picker, pl = pk.video
        let vs = cp["variants"] as? [[String: Any]] ?? []
        let vurl = { (n: Int) in n < vs.count ? vs[n]["video"] as? String ?? "" : "" }
        // The videos' own sizes (sidetest.mjs, from ffprobe): the first frames must be theirs.
        let wantSizes = (cp["_want"] as? [String: Any])?["sizes"] as? [String] ?? ["640x360", "640x360"]
        check("pv_fixture", vs.count == 4 && vurl(0).hasSuffix("/variants/0") && vurl(1).hasSuffix("/variants/1?as=video") && vurl(2).isEmpty && vurl(3).hasSuffix("/variants/3"), vs.map { "\($0["type"] ?? "?") \($0["video"] ?? "-")" }.joined(separator: ", "))

        // The card built from the agent's daemon's own copy (no `video`, no `videoType`: first in the window), then
        // the hub's: each video's first frame with the play mark from the first copy on, the page's once the hub's came.
        // (It reaches the window as a daemon's checkpoint does, worded by the window: Hub.daemonCheckpoint.)
        if let own = cp["_daemon"] as? [String: Any] {
            board.hub.testCheckpoints = []
            board.hub.daemonCheckpoint(own, socket: Self.pvAgentsDaemon)
        } else {
            var first = cp
            first["variants"] = vs.map { v -> [String: Any] in var x = v; x["video"] = nil; x["videoType"] = nil; return x }
            board.hub.testCheckpoints = [first]
        }
        settle(0.5)
        board.pickSession(key, why: "test")
        let card = { self.board.panel.shownCard }
        let early = wait(20) { card()?.kind == "pick" && card()?.tiles.count == 4 && card()?.tiles[0].image != nil && card()?.tiles[3].image != nil }
        let et = card()?.tiles ?? []
        // SIDETEST_PICK_CANT (sidetest.mjs): videos this Mac cannot decode (AV1 on an M1): each shows the still that says so.
        let cantMode = (cp["_want"] as? [String: Any])?["cant"] as? Bool ?? false
        if cantMode { screenPickVideoCant(cp, card: card, vurl: vurl); return }
        check("pv_card_from_daemon_copy", early && et.count == 4 && et[0].playMark && et[3].playMark && !et[2].playMark, "tiles \(et.map { $0.image.map { "\(Int($0.size.width))x\(Int($0.size.height))" } ?? "none" }) marks \(et.map { $0.playMark }), \(cp["_daemon"] is [String: Any] ? "the daemon's own copy" : "a copy with no video and no videoType")")
        board.hub.testCheckpoints = cps
        // The hub's copy alone from here (its answer goes to the hub).
        board.hub.dropDaemon(Self.pvAgentsDaemon)
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
        _ = wait(10) { pl.ready && pl.time > 0.05 }
        let a0 = pl.time
        settle(1.5)
        let a1 = pl.time
        check("pv_click_plays_time_advances", a1 > a0 + 0.8 && pl.playing && pl.muted && pl.controlsShown && pl.url == vurl(0) && !pl.cantPlay,
              "time \(a0) to \(a1) after 1.5 s, playing \(pl.playing), muted \(pl.muted), controls \(pl.controlsShown), url \(pl.url), engine \(String(describing: pl.engine))")
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
        check("pv_space_pauses", !pl.playing && abs(pl.time - p0) < 0.02 && p0 > 0.2, "playing \(pl.playing), time \(p0) then \(pl.time)")
        if let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: " ", charactersIgnoringModifiers: " ", isARepeat: false, keyCode: 49) { window.sendEvent(e) }
        settle(0.5)
        check("pv_space_plays", pl.playing && pl.time > p0 + 0.2, "playing \(pl.playing), time \(pl.time)")
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
                let left = pl.shown
                pk.buttons[button]?.performClick(nil)
                _ = wait(10) { pk.viewing == n && pl.url == vurl(n) && pl.time > 0.05 }
                let t0 = pl.time
                settle(1.0)
                // The one left was let go (paused, its video dropped); the one come to plays.
                let ok = pk.viewing == n && pl.url == vurl(n) && pl.playing && pl.time > t0 + 0.4 && left != pl.shown && pl.letGo.contains(left)
                switches.append("\(r)\(n == 0 ? "A" : "B") \(ok ? "ok" : "NO: left \(left) let go \(pl.letGo.contains(left)), time \(String(format: "%.2f", t0)) to \(String(format: "%.2f", pl.time))")")
            }
        }
        check("pv_switch_one_plays_left_stops", switches.allSatisfy { $0.hasSuffix("ok") }, switches.joined(separator: ", "))
        // C, a picture: the zoom as before, the player gone.
        pk.buttons["next"]?.performClick(nil)
        check("pv_picture_in_zoom", pk.viewing == 2 && pl.isHidden && !pk.zoom.isHidden && pl.player == nil && pl.engine == nil, "viewing \(String(describing: pk.viewing)) player \(pl.player == nil && pl.engine == nil ? "gone" : "kept")")
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

        // The pick's Close while B plays: the video stops and is let go, not left playing behind the view
        // in front. The pick come back (the back stack's again): B plays up close again.
        let closing = pl.shown
        pk.buttons["close"]?.performClick(nil)
        let gone = wait(3) { self.board.root.middle !== pk && pl.player == nil && pl.web?.isHidden != false && pl.url.isEmpty && !pl.playing }
        check("pv_close_lets_go", gone && pl.letGo.contains(closing), "middle is picker \(board.root.middle === pk), player \(pl.player == nil ? "gone" : "kept"), web shown \(pl.web?.isHidden == false), url \(pl.url), playing \(pl.playing), let go \(pl.letGo.contains(closing))")
        board.openPicker(id)
        _ = wait(10) { pk.viewing == 1 && pl.url == vurl(1) && pl.time > 0.05 }
        let r0 = pl.time
        settle(1.0)
        check("pv_back_plays_again", pk.viewing == 1 && pl.url == vurl(1) && !pl.isHidden && pl.playing && pl.time > r0 + 0.4, "viewing \(String(describing: pk.viewing)) url \(pl.url) playing \(pl.playing) time \(r0) to \(pl.time)")

        // Circle a part: B stops on the frame shown, no controls; a drag on it is the ring, in fractions of the video's frame.
        pk.buttons["circle"]?.performClick(nil)
        settle(0.3)
        let stopped = pl.time
        settle(0.5)
        check("pv_circle_stops_on_frame", pk.circling && pl.still && !pl.playing && stopped > 0.2 && abs(pl.time - stopped) < 0.02 && !pl.controlsShown && pl.ring.drawing, "circling \(pk.circling) still \(pl.still) playing \(pl.playing) time \(stopped) then \(pl.time)")
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
        // Answered, the pick closes and its video is let go (no player, no web page left playing).
        check("pv_send_lets_go", wait(3) { self.board.root.middle !== pk && pl.player == nil && pl.web?.isHidden != false && pl.url.isEmpty && !pl.playing },
              "middle is picker \(board.root.middle === pk), player \(pl.player == nil ? "gone" : "kept"), web shown \(pl.web?.isHidden == false), url \(pl.url)")
        // The region and its second for the agent's check (sidetest.mjs reads it from the result).
        check("pv_region_for_agent \(pvJSON(reg))", true)
        board.hub.testCheckpoints = nil
    }

    /// A pick whose videos this Mac cannot decode (SIDETEST_PICK_CANT, AV1 on an M1 or M2): the card's tiles, the
    /// strip and the viewer show the still that says "This video can't play here", with no play mark and no player
    /// waiting; the picture still shows, and the pick can still be sent.
    private func screenPickVideoCant(_ cp: [String: Any], card: () -> CheckpointCard?, vurl: (Int) -> String) {
        let pk = board.picker, pl = pk.video
        board.hub.testCheckpoints = [cp]
        settle(0.5)
        board.render(force: true)
        let still = wait(25) { card()?.tiles.count == 4 && [0, 1, 3].allSatisfy { card()?.tiles[$0].image != nil && card()?.tiles[$0].playMark == false } && card()?.tiles[2].image != nil }
        let tiles = card()?.tiles ?? []
        let cant = [0, 1, 3].map { PickVideos.shared.cant(vurl($0)) }
        check("pv_cant_card_stills", still && cant.allSatisfy { $0 }, "images \(tiles.map { $0.image != nil }) marks \(tiles.map { $0.playMark }) cant \(cant)")
        pictures("pickvideo-cant-card")
        if tiles.count == 4 { click(tiles[0]) }
        let shown = wait(10) { self.board.root.middle === pk && pk.viewing == 0 && pl.cantPlay }
        settle(1.0)
        check("pv_cant_viewer_still", shown && pl.cantPlay && !pl.playing && pl.player == nil && pl.web?.isHidden != false && pk.thumbs.count == 4 && !pk.thumbs[0].playMark, "viewing \(String(describing: pk.viewing)) cant \(pl.cantPlay) playing \(pl.playing)")
        pictures("pickvideo-cant-viewer")
        pk.buttons["next"]?.performClick(nil)
        check("pv_cant_page_video_still", wait(10) { pk.viewing == 1 && pl.cantPlay }, "viewing \(String(describing: pk.viewing)) cant \(pl.cantPlay)")
        pk.buttons["next"]?.performClick(nil)
        check("pv_cant_picture_shows", wait(5) { pk.viewing == 2 && pl.isHidden && !pk.zoom.isHidden })
        board.hub.testCheckpoints = nil
    }

    /// The card sent to the person's Mac on 2026-11-17 (SIDETEST_PICK_MIX: A a VP9, B a VP8, C an AV1 .webm), as
    /// it reaches the window: first the agent's daemon's own copy (no `video`, no `videoType`), then the hub's. Each
    /// video this Mac decodes shows its first frame with the play mark and plays up close; one it cannot (AV1 with no
    /// AV1 decoder) shows the still that says "This video can't play here" at once, and never takes another's place.
    private func screenPickVideoMix(_ cp: [String: Any]) {
        let pk = board.picker, pl = pk.video
        let vs = cp["variants"] as? [[String: Any]] ?? []
        let vurl = { (n: Int) in n < vs.count ? vs[n]["video"] as? String ?? "" : "" }
        let codecs = vs.map { ($0["label"] as? String ?? "").lowercased() }
        // What this Mac decodes: WebKit plays VP8 and VP9 itself; AV1 only with the chip's decoder.
        let av1 = VTIsHardwareDecodeSupported(kCMVideoCodecType_AV1)
        let want = codecs.map { $0 == "av1" ? av1 : $0 == "vp8" || $0 == "vp9" || $0 == "h264" }
        let own = cp["_daemon"] as? [String: Any]
        let ownTypes = ((own?["variants"] as? [[String: Any]]) ?? []).map { $0["videoType"] as? String ?? "none" }
        check("pvm_fixture", vs.count == 3 && (0..<3).allSatisfy { vurl($0).hasSuffix("/variants/\($0)") } && own != nil,
              "\(codecs) videos \((0..<vs.count).map(vurl)), the daemon's own copy \(own == nil ? "missing" : "with types \(ownTypes)"), AV1 decoder \(av1)")
        guard let own else { return }
        let key = "\(cp["projectId"] as? String ?? "")/\(cp["surfaceId"] as? String ?? "")"
        board.hub.testCheckpoints = []
        board.hub.daemonCheckpoint(own, socket: Self.pvAgentsDaemon)
        settle(0.3)
        board.pickSession(key, why: "test")
        let card = { self.board.panel.shownCard }
        let t0 = Date()
        // Each tile settles: a first frame with the play mark, or the still with none.
        let settled = { (n: Int) -> Bool in
            guard let tl = card()?.tiles, tl.count == 3, tl[n].image != nil else { return false }
            return PickVideos.shared.cant(vurl(n)) ? !tl[n].playMark : tl[n].playMark
        }
        var at = [Double?](repeating: nil, count: 3)
        // As the person sees it 3 s after the card came (the day it was sent: B and C blank, a play mark on nothing).
        _ = wait(3) {
            for n in 0..<3 where at[n] == nil && settled(n) { at[n] = Date().timeIntervalSince(t0) }
            return false
        }
        let early = (0..<3).map { n -> String in
            guard let tl = card()?.tiles, n < tl.count else { return "\(codecs[n]) no tile" }
            return "\(codecs[n]) \(tl[n].image == nil ? "blank" : PickVideos.shared.cant(vurl(n)) ? "still" : "frame")\(tl[n].playMark ? " with play mark" : "")"
        }
        pictures("pickvideo-mix-at-3s")
        _ = wait(37) {
            for n in 0..<3 where at[n] == nil && settled(n) { at[n] = Date().timeIntervalSince(t0) }
            return at.allSatisfy { $0 != nil }
        }
        let tiles = card()?.tiles ?? []
        let cant = (0..<3).map { PickVideos.shared.cant(vurl($0)) }
        let shown = (0..<3).map { n -> String in
            guard n < tiles.count, let i = tiles[n].image else { return "\(codecs[n]) blank" }
            return "\(codecs[n]) \(cant[n] ? "still" : "frame") \(Int(i.size.width))x\(Int(i.size.height))\(tiles[n].playMark ? " with play mark" : "") at \(at[n].map { String(format: "%.1f s", $0) } ?? "never")"
        }
        check("pvm_card_from_daemon_copy", tiles.count == 3 && (0..<3).allSatisfy { at[$0] != nil && cant[$0] == !want[$0] }, shown.joined(separator: ", "))
        // No tile is left blank: each first frame, and each still (its type refused at once), within 3 s.
        check("pvm_no_blank_tile", (0..<3).allSatisfy { (at[$0] ?? 99) < 3 }, "at 3 s: \(early.joined(separator: ", "))")
        pictures("pickvideo-mix-card")
        // The hub's copy (its `video`, `videoType`): the tiles stay as they are.
        board.hub.testCheckpoints = [cp]
        board.hub.dropDaemon(Self.pvAgentsDaemon)
        settle(0.5)
        board.render(force: true)
        _ = wait(5) { (0..<3).allSatisfy { settled($0) } }
        let after = (0..<3).map { PickVideos.shared.cant(vurl($0)) }
        check("pvm_hub_copy_keeps_tiles", after == cant && (0..<3).allSatisfy { settled($0) }, "cant \(after)")
        // Up close: each one this Mac decodes plays (its time moves on), the other shows the still.
        let open = card()?.tiles ?? []
        if open.count == 3 { click(open[1]) }
        _ = wait(6) { self.board.root.middle === pk && pk.viewing == 1 }
        var seen: [String] = []
        for n in [1, 0, 2] {
            while let v = pk.viewing, v != n { pk.buttons[v < n ? "next" : "previous"]?.performClick(nil); settle(0.2); if pk.viewing == v { break } }
            if want[n] {
                _ = wait(12) { pk.viewing == n && pl.url == vurl(n) && pl.ready && pl.time > 0.05 }
                let a = pl.time
                settle(1.2)
                let ok = pk.viewing == n && pl.url == vurl(n) && !pl.cantPlay && pl.playing && pl.time > a + 0.6
                seen.append("\(codecs[n]) \(ok ? "plays" : "NO") (time \(String(format: "%.2f", a)) to \(String(format: "%.2f", pl.time)), cant \(pl.cantPlay), engine \(String(describing: pl.engine)))")
                check("pvm_\(codecs[n])_plays", ok, seen.last ?? "")
            } else {
                let ok = wait(6) { pk.viewing == n && pl.cantPlay } && !pl.playing && pl.player == nil && pl.web?.isHidden != false
                seen.append("\(codecs[n]) \(ok ? "still" : "NO") (cant \(pl.cantPlay), playing \(pl.playing))")
                check("pvm_\(codecs[n])_still_up_close", ok, seen.last ?? "")
                pictures("pickvideo-mix-cant")
            }
            if n == 1 { pictures("pickvideo-mix-vp8") }
        }
        board.hub.testCheckpoints = nil
    }
}
