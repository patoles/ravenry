// The self-test of Ink and the pane effects (scripts/inkcheck.mjs, which
// runs `--sidetest OUT --screen ink` several times on a throwaway daemon and
// the demo hub, RAVENRY_MAC_INK=1). RAVENRY_MAC_INK_CASE says which launch
// this is:
//
// - launch (the daemon had no shell): New session in front and Ink played
//   over it, its frames drawn with iTime going up to 3.4 s, the last frame
//   the window itself; played again, a mouse press on a folder row half way
//   ends it at once and the row is picked, a key ends it too; the mark lands
//   on the start screen's real icon; the Opening switch and the pane effects
//   pressed with the mouse in Settings, the settings file read back; a
//   pane's drawn pixels change with each effect, are the same as before with
//   it off, and an idle pane with an effect does not draw. Pictures of Ink
//   at 0.5, 1.4, 2.2, 2.9 s and its end at 1280 and 900, its frames for a
//   GIF, and a pane with each effect.
// - restored, off, reduced: Ink did not play (tabs came back, the setting
//   is off, Reduce motion is on), and why.

import AppKit

extension SelfTestBoard {
    func screenInk() {
        let rec = InkLaunch.record
        let mode = ProcessInfo.processInfo.environment["RAVENRY_MAC_INK_CASE"] ?? "launch"
        let want = ["restored": "tabs restored", "off": "setting off", "reduced": "reduced motion"]
        if let why = want[mode] {
            check("ink_\(mode)_not_played", rec.decided == why && rec.played == 0 && InkLaunch.current == nil, "decided \(rec.decided), played \(rec.played)")
            let front = mode == "restored" ? board.front == .tab : board.front == .start
            check("ink_\(mode)_front", front && board.ws.tabs.count >= 1, "\(board.front), \(board.ws.tabs.count) tabs")
            picture("ink-\(mode).png")
            return
        }
        guard let rw = (NSApp.delegate as? AppDelegate)?.windows.first else { check("ink_window", false); return }
        let st = board.start

        // The launch: no tab came back, so New session and Ink.
        check("ink_launch_plays", rec.decided == "play" && rec.played == 1, "decided \(rec.decided), played \(rec.played)")
        check("ink_launch_opens_start", board.front == .start && board.ws.tabs.count == 1 && board.ws.restoredNone, "\(board.front), \(board.ws.tabs.count) tabs")
        _ = wait(8) { rec.ended != nil }
        let ts = rec.times
        let rising = zip(ts, ts.dropFirst()).allSatisfy { $1 >= $0 }
        check("ink_launch_ran_to_end", rec.ended == "done" && ts.count >= 60 && rising && (ts.first ?? 1) < 0.1 && ts.last == InkOverlay.duration,
              "\(ts.count) frames, iTime \(String(format: "%.3f", ts.first ?? -1)) to \(String(format: "%.3f", ts.last ?? -1)), ended \(rec.ended ?? "-") at \(String(format: "%.2f", rec.endedAt)) s")
        let gaps = zip(ts, ts.dropFirst()).map { $1 - $0 }.sorted()
        let med = { (a: [Double]) in a.isEmpty ? 0 : a[a.count / 2] }
        check("ink_frame_times", true, String(format: "frame %.2f ms median, %.2f ms max (CPU, offscreen, waited for the GPU); window picture %.1f ms median, %d taken; iTime step median %.1f ms, max %.1f ms",
                                              med(rec.frameMs.sorted()), rec.frameMs.max() ?? 0, med(rec.snapshotMs.sorted()), rec.snapshots, med(gaps) * 1000, (gaps.last ?? 0) * 1000) + "; pictures at " + rec.snapshotAt.joined(separator: ", "))
        if let last = rec.lastFrame, let after = rec.afterEnd, last.count == after.bytes.count {
            let diff = zip(last, after.bytes).reduce(0) { max($0, abs(Int($1.0) - Int($1.1))) }
            let n = zip(last, after.bytes).filter { $0 != $1 }.count
            check("ink_last_frame_is_start_screen", diff == 0, "\(after.w)x\(after.h) px, \(n) bytes differ, at most by \(diff)")
            if let img = InkOverlay.image(after.bytes, after.w, after.h) { save(img, "ink-after-end.png") }
            if let img = InkOverlay.image(last, after.w, after.h) { save(img, "ink-last-frame.png") }
        } else { check("ink_last_frame_is_start_screen", false, "no frame kept") }
        // How long a picture of the window takes, each way (the layers' is the one used).
        if let probe = InkOverlay(board: board, offscreen: true), let root = window.contentView {
            probe.isHidden = true; probe.frame = root.bounds; root.addSubview(probe)
            for byLayer in [false, true] {
                InkOverlay.pictureByLayer = byLayer
                let t0 = CACurrentMediaTime()
                let pic = probe.windowPicture()
                let ms = (CACurrentMediaTime() - t0) * 1000
                check("ink_picture_\(byLayer ? "layer" : "cache")", pic != nil, String(format: "%.1f ms", ms))
                if let p = pic, let img = InkOverlay.image(p.bytes, p.w, p.h) { save(img, "ink-picture-\(byLayer ? "layer" : "cache").png") }
            }
            InkOverlay.pictureByLayer = true
            probe.removeFromSuperview()
        }
        check("ink_overlay_gone", InkLaunch.current?.superview == nil && !(window.contentView?.subviews.contains { $0 is InkOverlay } ?? true))

        // The start screen's folders (the demo hub's), to press one.
        _ = wait(8) { st.controls.keys.filter { $0.hasPrefix("folder:") }.count >= 2 }
        let rows = st.controls.filter { $0.key.hasPrefix("folder:") }.sorted { $0.key < $1.key }
        guard let pick = rows.first(where: { ($0.value as? Row)?.selected == false }) else { check("ink_start_rows", false, "\(st.controls.keys.sorted())"); return }
        let pickPath = String(pick.key.dropFirst("folder:".count))

        // Played again: a press on a folder row half way ends it at once, and the row is picked.
        size(1280, 820)
        var o = InkLaunch.play(on: rw, offscreen: true)
        _ = wait(4) { (rec.times.last ?? 0) >= 1.0 }
        let atPress = rec.times.last ?? 0
        let p = pick.value.convert(NSPoint(x: pick.value.bounds.midX, y: pick.value.bounds.midY), to: nil)
        check("ink_press_reaches_start_under_it", window.contentView?.hitTest(window.contentView!.superview!.convert(p, from: nil)).map { $0 === pick.value || $0.isDescendant(of: pick.value) } == true)
        post(.leftMouseDown, at: p); post(.leftMouseUp, at: p)
        pump(1.5) { rec.ended != nil }
        let framesAfter = rec.times.count
        pump(0.3)
        check("ink_click_ends_it", rec.ended == "click" && o?.superview == nil && rec.times.count == framesAfter && atPress < 2.0,
              "ended \(rec.ended ?? "-") at \(String(format: "%.2f", rec.endedAt)) s (pressed at iTime \(String(format: "%.2f", atPress))), frames after: \(rec.times.count - framesAfter)")
        check("ink_click_taken_by_start", st.folder == pickPath && (st.controls[pick.key] as? Row)?.selected == true, "folder \(st.folder ?? "-"), wanted \(pickPath)")

        // And a key: a letter, then Esc (which New session takes: it goes back to the terminal).
        func key(_ ch: String, _ code: UInt16) {
            if let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                        context: nil, characters: ch, charactersIgnoringModifiers: ch, isARepeat: false, keyCode: code) { NSApp.postEvent(e, atStart: false) }
            pump(1.5) { rec.ended != nil }
        }
        o = InkLaunch.play(on: rw, offscreen: true)
        _ = wait(4) { (rec.times.last ?? 0) >= 1.0 }
        var keyAt = rec.times.last ?? 0
        key("a", 0)
        check("ink_key_ends_it", rec.ended == "key" && o?.superview == nil && keyAt < 2.0 && board.front == .start,
              "ended \(rec.ended ?? "-") at \(String(format: "%.2f", rec.endedAt)) s (pressed at iTime \(String(format: "%.2f", keyAt))), \(board.front)")
        o = InkLaunch.play(on: rw, offscreen: true)
        _ = wait(4) { (rec.times.last ?? 0) >= 1.0 }
        keyAt = rec.times.last ?? 0
        let n0 = rec.times.count
        key("\u{1b}", 53)
        check("ink_esc_ends_it_with_start", (rec.ended == "key" || rec.ended == "left") && o?.superview == nil && board.front == .tab && rec.times.count - n0 <= 1,
              "ended \(rec.ended ?? "-") at \(String(format: "%.2f", rec.endedAt)) s (pressed at iTime \(String(format: "%.2f", keyAt))), \(rec.times.count - n0) frames after, \(board.front)")
        board.openStart(nil)
        _ = wait(5) { st.controls.keys.contains { $0.hasPrefix("folder:") } }

        // Pictures at 1280 and 900, and the mark on the real icon.
        for (w, h) in [(CGFloat(1280), CGFloat(820)), (900, 760)] {
            size(w, h)
            settle(0.5)
            guard let probe = InkOverlay(board: board, offscreen: true), let root = window.contentView else { check("ink_probe", false); return }
            probe.isHidden = true
            probe.frame = root.bounds
            root.addSubview(probe)
            for t in [0.5, 1.4, 2.2, 2.9, 3.4] {
                if let img = probe.picture(at: t) { save(img, "ink-\(Int(w))-\(String(format: "%.1f", t)).png") }
            }
            // The eye of the mark that landed (2.95 s) and the eye of the start screen's icon: the same blue, at the same place.
            if let r = probe.iconRect, let img = probe.picture(at: 2.95), let start = probe.windowPicture() {
                let unit = r.width * CustomShader.iconGlyph.scale / 1024
                let eye = NSPoint(x: r.minX + r.width * CustomShader.iconGlyph.x / 1024 + 65 * unit, y: r.minY + r.width * CustomShader.iconGlyph.y / 1024 + 32 * unit)
                let a = rgb(img, eye), b = rgb(InkOverlay.image(start.bytes, start.w, start.h)!, eye)
                let blue = { (c: (Int, Int, Int)) in c.2 > 200 && c.0 < 80 }
                check("ink_mark_lands_on_icon_\(Int(w))", blue(a) && blue(b), "icon at \(Int(r.minX)),\(Int(r.minY)) \(Int(r.width)) pt; eye in the frame \(a), on the screen \(b)")
            } else { check("ink_mark_lands_on_icon_\(Int(w))", false, "no icon") }
            if w == 1280 {
                // The frames of a GIF (inkcheck.mjs makes it with ffmpeg).
                let gif = dir.appendingPathComponent("ink-gif")
                try? FileManager.default.createDirectory(at: gif, withIntermediateDirectories: true)
                for i in 0...68 { if let img = probe.picture(at: Double(i) / 20) { save(img, "ink-gif/f\(String(format: "%03d", i)).png", half: true) } }
            }
            probe.removeFromSuperview()
        }

        // Settings: the Opening switch and the pane effect, pressed with the mouse.
        board.openSettings("appearance")
        let sw = board.settings
        _ = wait(3) { sw.window.isVisible && sw.tab == "appearance" }
        let file = sw.store.file
        func saved() -> [String: Any] { (file.flatMap { try? Data(contentsOf: $0) }.flatMap { try? JSONSerialization.jsonObject(with: $0) }) as? [String: Any] ?? [:] }
        func swClick(_ name: String) {
            guard let v = sw.controls[name] else { check("ink_set_control_\(name)", false, "\(sw.controls.keys.sorted())"); return }
            sw.window.contentView?.layoutSubtreeIfNeeded()
            v.scrollToVisible(v.bounds)
            let q = v.convert(NSPoint(x: v.bounds.midX, y: v.bounds.midY), to: nil)
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                if let e = NSEvent.mouseEvent(with: type, location: q, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: sw.window.windowNumber,
                                              context: nil, eventNumber: 0, clickCount: 1, pressure: 1) { sw.window.sendEvent(e) }
            }
            settle(0.2)
        }
        check("ink_set_rows_shown", shows(sw.window.contentView!, t("set.paneEffect")) && shows(sw.window.contentView!, t("set.launchInk")) && sw.controls["fx:off"]?.accessibilityValue() as? Bool == true,
              texts(sw.window.contentView!).suffix(10).joined(separator: " | "))
        swClick("launchInk")
        check("ink_set_switch_off_saved", saved()["launchInk"] as? Bool == false && sw.store.bool("launchInk") == false, "\(saved()["launchInk"] ?? "nil")")
        swClick("launchInk")
        check("ink_set_switch_on_saved", saved()["launchInk"] as? Bool == true, "\(saved()["launchInk"] ?? "nil")")
        settingsPicturesInk(sw)

        // The pane effects on the shell's pane: drawn pixels.
        board.back()
        _ = wait(3) { board.front == .tab }
        size(1280, 820)
        guard let v = board.ws.focusedView else { check("ink_pane", false); return }
        v.sendEvents([["text": "clear; for c in 31 32 33 34 35 36; do printf '\\e[1;%sm%s\\e[0m  ' $c 'Ravenry bright words'; echo; done; printf '\\e[1;97mbold white\\e[0m  \\e[2mdim\\e[0m\\n'\r"]])
        _ = wait(5) { v.screen.text().contains("bold white  dim") }
        settle(0.6)
        func drawn() -> [UInt8] {
            let n = v.drawCount
            v.draw(sync: false)
            _ = wait(1) { v.drawCount > n }
            guard let img = v.snapshotImage(), let d = img.dataProvider?.data as Data? else { return [] }
            return [UInt8](d)
        }
        let off = drawn()
        swClick("fx:bloom")
        check("ink_set_bloom_saved", saved()["paneEffect"] as? String == "bloom" && v.look.effect == .bloom, "\(saved()["paneEffect"] ?? "nil")")
        let bloom = drawn()
        picture("ink-pane-bloom.png")
        // Idle with the effect on: no draws of its own (it runs only when the pane draws).
        settle(0.3)
        let idle0 = v.drawCount
        settle(1.0)
        check("ink_effect_draws_only_with_pane", v.drawCount == idle0, "\(v.drawCount - idle0) draws in 1 s idle")
        swClick("fx:crt")
        check("ink_set_crt_saved", saved()["paneEffect"] as? String == "crt" && v.look.effect == .crt)
        let crt = drawn()
        picture("ink-pane-crt.png")
        swClick("fx:off")
        let off2 = drawn()
        picture("ink-pane-off.png")
        let px = { (a: [UInt8], b: [UInt8]) -> Int in a.count == b.count ? stride(from: 0, to: a.count, by: 4).filter { a[$0] != b[$0] || a[$0 + 1] != b[$0 + 1] || a[$0 + 2] != b[$0 + 2] }.count : -1 }
        check("ink_bloom_changes_pixels", !off.isEmpty && px(off, bloom) > 1000, "\(px(off, bloom)) of \(off.count / 4) pixels differ")
        check("ink_crt_changes_pixels", px(off, crt) > 1000 && px(bloom, crt) > 1000, "\(px(off, crt)) differ from off, \(px(bloom, crt)) from bloom")
        check("ink_off_same_pixels", !off.isEmpty && px(off, off2) == 0, "\(px(off, off2)) pixels differ")
        check("ink_off_saved", saved()["paneEffect"] as? String == "off" && v.look.effect == nil)
        check("ink_shader_errors", ShaderHost.shared.errors.isEmpty, ShaderHost.shared.errors.joined(separator: " | "))
    }

    /// The Settings window's Appearance tab, at its foot (the new rows).
    private func settingsPicturesInk(_ sw: SettingsWindow) {
        guard let root = sw.window.contentView else { return }
        if let s = root.subviews.compactMap({ $0 as? NSScrollView }).first ?? findScroll(root) { s.documentView?.scroll(NSPoint(x: 0, y: s.documentView!.bounds.height)) }
        settle(0.2)
        guard let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { return }
        root.cacheDisplay(in: root.bounds, to: rep)
        // On the window's own background, as it shows.
        let w = rep.pixelsWide, h = rep.pixelsHigh
        guard let base = rep.cgImage, let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                                          bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return }
        var bg = CGColor(gray: 0, alpha: 1)
        sw.window.effectiveAppearance.performAsCurrentDrawingAppearance { bg = (sw.window.backgroundColor.usingColorSpace(.sRGB) ?? .black).cgColor }
        ctx.setFillColor(bg)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.draw(base, in: CGRect(x: 0, y: 0, width: w, height: h))
        if let img = ctx.makeImage() { save(img, "ink-settings.png") }
    }
    private func findScroll(_ v: NSView) -> NSScrollView? {
        for s in v.subviews { if let x = s as? NSScrollView { return x }; if let x = findScroll(s) { return x } }
        return nil
    }

    /// An event through the app's queue, as the person's come (the event monitors see it).
    private func post(_ type: NSEvent.EventType, at p: NSPoint) {
        if let e = NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                      context: nil, eventNumber: 0, clickCount: 1, pressure: 1) { NSApp.postEvent(e, atStart: false) }
    }
    /// Runs the app's event loop for a while (the queue's events dispatched as NSApp.run does).
    private func pump(_ s: Double, until: () -> Bool = { false }) {
        let end = Date().addingTimeInterval(s)
        while Date() < end && !until() {
            if let e = NSApp.nextEvent(matching: .any, until: Date().addingTimeInterval(0.01), inMode: .default, dequeue: true) { NSApp.sendEvent(e) }
        }
    }

    private func save(_ img: CGImage, _ name: String, half: Bool = false) {
        var out = img
        if half, let ctx = CGContext(data: nil, width: img.width / 2, height: img.height / 2, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                     bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) {
            ctx.interpolationQuality = .high
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width / 2, height: img.height / 2))
            out = ctx.makeImage() ?? img
        }
        try? NSBitmapImageRep(cgImage: out).representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent(name))
    }

    /// A picture's colour at a point in window points (top-left origin, the picture at 2x).
    private func rgb(_ img: CGImage, _ p: NSPoint) -> (Int, Int, Int) {
        let s = CGFloat(img.width) / max(1, window.contentView?.bounds.width ?? 1)
        guard let d = img.dataProvider?.data as Data? else { return (0, 0, 0) }
        let x = Int(p.x * s), y = Int(p.y * s), i = y * img.bytesPerRow + x * 4
        guard x >= 0, y >= 0, i + 3 < d.count else { return (0, 0, 0) }
        return (Int(d[i + 2]), Int(d[i + 1]), Int(d[i]))
    }
}
