// The tab strip and the terminal area (sidetest.mjs --screen strip): the
// fold buttons at both ends of the strip, a crowded strip that scrolls
// instead of cutting names, a session's tab that closes without ending
// the session and reads as that session, a shell another client makes
// becoming a tab at once (and another window's not), the terminal's right
// click menu, the find bar in the app's colours with a selection's words,
// a tab dragged onto an edge of the pane in front to split it, and the
// window with no tab left. --screen startlocal: New session with the board
// down (folders and assistants read here, the assistant in a pane of this
// window) and the access card while macOS asks.

import AppKit

extension SelfTestBoard {
    private func paneRunning(_ id: String) -> Bool {
        guard let r = try? board.ws.conn.call("pane.list", ["hidden": true], timeout: 3) else { return false }
        return (r["panes"] as? [[String: Any]] ?? []).contains { $0["id"] as? String == id && ($0["state"] as? String ?? "running") == "running" }
    }

    private func newPane(_ labels: [String: String], name: String, command: [String]? = nil) -> String? {
        var p: [String: Any] = ["cols": 80, "rows": 24, "name": name, "labels": labels, "cwd": board.ws.home]
        if let c = command { p["command"] = c }
        return ((try? board.ws.conn.call("pane.new", p, timeout: 5))?["pane"] as? [String: Any])?["id"] as? String
    }

    /// A picture as picture() takes it, with views that lie over a
    /// terminal (the find bar, a drop zone) drawn on top again: the
    /// terminal's own drawing is laid over the window's in pictures.
    func pictureOver(_ name: String, _ views: [NSView]) {
        picture(name)
        let url = dir.appendingPathComponent(name)
        guard let root = window.contentView, let data = try? Data(contentsOf: url), let rep = NSBitmapImageRep(data: data), let base = rep.cgImage else { return }
        let s: CGFloat = 2, w = base.width, h = base.height
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return }
        ctx.draw(base, in: CGRect(x: 0, y: 0, width: w, height: h))
        for v in views where v.window != nil && !v.isHiddenOrHasHiddenAncestor {
            guard let r2 = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { continue }
            v.cacheDisplay(in: v.bounds, to: r2)
            guard let img = r2.cgImage else { continue }
            let r = v.convert(v.bounds, to: root)
            ctx.draw(img, in: CGRect(x: r.minX * s, y: CGFloat(h) - r.maxY * s, width: r.width * s, height: r.height * s))
        }
        guard let out = ctx.makeImage() else { return }
        try? NSBitmapImageRep(cgImage: out).representation(using: .png, properties: [:])?.write(to: url)
    }

    /// pictures() with views drawn over the terminal (pictureOver).
    func picturesOver(_ name: String, _ views: @escaping () -> [NSView]) {
        for (w, h) in [(CGFloat(1280), CGFloat(820)), (900, 760)] {
            size(w, h)
            for dark in [true, false] {
                NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                settle(0.4)
                board.render(force: true)
                settle(0.4)
                pictureOver("native-\(name)-\(Int(w))-\(dark ? "dark" : "light").png", views())
            }
        }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        size(1280, 820)
    }

    func screenStrip() {
        let ws = board.ws, bar = ws.bar
        guard wait(10, { ws.active != nil }) else { check("strip_first_tab", false); return }
        board.render(force: true)
        settle(0.4)

        // The fold buttons: lit while what they fold shows; a click folds it, another brings it back.
        let sideOn = bar.sidebarShown, panelOn = bar.panelShown
        check("strip_fold_buttons", sideOn && bar.sideButton.superview === bar && bar.panelButton.superview === bar
              && bar.sideButton.frame.maxX < (bar.items.first?.frame.minX ?? 0) + bar.clip.frame.minX + 1 && bar.panelButton.frame.maxX <= bar.bounds.width,
              "side \(bar.sideButton.frame) panel \(bar.panelButton.frame) clip \(bar.clip.frame)")
        _ = bar.sideButton.accessibilityPerformPress(); settle(0.3)
        check("strip_sidebar_folds", wait(3) { !bar.sidebarShown && self.board.root.sideWidth == 0 } && bar.sideButton.toolTip == "Show the sidebar (⌃⌘S)",
              "\(bar.sidebarShown) \(board.root.sideWidth) \(bar.sideButton.toolTip ?? "")")
        pictures("strip-nosidebar")
        _ = bar.sideButton.accessibilityPerformPress(); settle(0.3)
        check("strip_sidebar_back", wait(3) { bar.sidebarShown && self.board.root.sideWidth > 0 })
        _ = bar.panelButton.accessibilityPerformPress(); settle(0.3)
        check("strip_panel_toggles", wait(3) { bar.panelShown != panelOn }, "before \(panelOn) now \(bar.panelShown)")
        _ = bar.panelButton.accessibilityPerformPress(); settle(0.3)
        check("strip_panel_back", wait(3) { bar.panelShown == panelOn })

        // A session's own pane (the hub's: ravenry.session), opened as a tab.
        guard let sp = newPane(["ravenry.session": "claude"], name: "Claude", command: ["/bin/sleep", "600"]), let st = ws.tab(showing: sp) else { check("strip_session_pane", false); return }
        ws.show(st)
        // The board follows it as a project's session: the tab reads as that session.
        let pid = board.hub.state?.projects.first { $0.machine == nil && !$0.sessions.isEmpty }?.id ?? ""
        board.hub.testPatch = { r in
            var r = r
            var ps = r["projects"] as? [[String: Any]] ?? []
            if let i = ps.firstIndex(where: { $0["id"] as? String == pid }), var ss = ps[i]["sessions"] as? [[String: Any]], !ss.isEmpty {
                ss[0]["pane"] = sp
                ss[0]["topic"] = "Tidy the tiles"
                ps[i]["sessions"] = ss
            }
            r["projects"] = ps
            return r
        }
        board.hub.testCheckpoints = []
        board.render(force: true)
        let pname = board.hub.state?.project(pid)?.name ?? "?"
        let m = { bar.items.first { $0.model.id == st.id }?.model }
        check("strip_session_label", wait(3) { m()?.name == "Tidy the tiles" && m()?.sub == pname }, "\(m()?.name ?? "-") / \(m()?.sub ?? "-") want \(pname)")
        check("strip_session_close_tip", m()?.closeTip == "Close the tab (the session goes on)" && bar.items.first { $0.model.id == st.id }?.close.toolTip == "Close the tab (the session goes on)", m()?.closeTip ?? "nil")
        picture("native-session-tab-1280.png")
        check("strip_shell_close_tip", bar.items.first { $0.model.id != st.id && !$0.model.id.hasPrefix("view:") }?.close.toolTip == "Close (⌘W)")

        // Many tabs: the strip scrolls, no name cut, the + in the strip, the tab in front in sight.
        size(900, 760)
        for _ in 0..<9 { ws.newTab(nil) }
        _ = wait(5) { ws.tabs.count >= 11 }
        board.render(force: true)
        settle(0.5)
        let cut = bar.items.filter { $0.frame.width + 0.5 < $0.idealWidth(withSub: false) }
        let front = bar.items.first { $0.model.active }
        let inSight = front.map { $0.frame.minX >= -0.5 && $0.frame.maxX <= bar.clip.bounds.width + 0.5 } ?? false
        check("strip_crowded_scrolls", bar.overflows && cut.isEmpty && inSight && bar.plus.frame.maxX <= bar.panelButton.frame.minX,
              "overflow \(bar.overflows) cut \(cut.map(\.model.name)) front \(front?.frame ?? .zero) clip \(bar.clip.bounds) plus \(bar.plus.frame)")
        check("strip_edge_fades", bar.clip.faded.left && !bar.clip.faded.right, "\(bar.clip.faded)")
        picture("native-strip-crowded-900.png")
        let off = bar.offset
        bar.scroll(by: -10_000)
        check("strip_wheel_scrolls", bar.offset == 0 && off > 0, "\(off) -> \(bar.offset)")
        // A tab picked with the keyboard comes into sight: the first, then the last.
        ws.select(index: 1)
        ws.select(index: ws.tabs.count - 1)
        board.render(force: true)
        settle(0.2)
        let last = bar.items.last { !$0.model.id.hasPrefix("view:") }
        check("strip_front_revealed", bar.offset > 0 && last.map { $0.frame.maxX <= bar.clip.bounds.width + 0.5 && $0.frame.minX >= -0.5 } ?? false, "\(bar.offset) \(last?.frame ?? .zero)")
        // Back to a few tabs.
        for t in ws.tabs.suffix(9) { ws.closeTab(t) }
        _ = wait(5) { ws.tabs.count <= 3 }
        size(1280, 820)

        // Closing the session's tab: the tab goes, the session runs on.
        let before = ws.tabs.count
        bar.onClose?(st.id)
        check("strip_session_tab_closes", wait(3) { ws.tabs.count == before - 1 && !ws.tabs.contains { $0.host == sp } })
        settle(0.6)
        check("strip_session_runs_on", paneRunning(sp))
        // The sidebar opens it again (tab(showing:)).
        check("strip_session_reopens", ws.tab(showing: sp) != nil)
        if let t = ws.tabs.first(where: { $0.host == sp }) { ws.show(t) }
        // Cmd+W on it: the same, the session goes on.
        ws.closeFocused()
        settle(0.6)
        check("strip_cmd_w_session", !ws.tabs.contains { $0.host == sp } && paneRunning(sp))
        board.hub.testPatch = nil
        board.hub.testCheckpoints = []
        if let t = ws.tabs.first { ws.show(t) }

        // A shell another client makes: a tab at once, at the end, the front left alone; another window's is not.
        let frontNow = ws.active
        let n0 = ws.tabs.count
        let outside = newPane(["ravenry.kind": "shell"], name: "Shell")
        check("strip_outside_shell_tab", wait(5) { ws.tabs.count == n0 + 1 && ws.tabs.last?.host == outside } && ws.active === frontNow, "\(ws.tabs.map(\.host)) \(outside ?? "-")")
        let other = newPane(["ravenry.kind": "shell", "ravenry.window": "wselftest"], name: "Shell")
        settle(1.0)
        check("strip_other_window_shell_not", other != nil && !ws.tabs.contains { $0.host == other })
        if let o = other { ws.conn.request("pane.close", ["pane": o]) }

        // The terminal's right click: Copy only with a selection, Copy Path, Split Right and Down while not split.
        board.render(force: true)
        settle(0.3)
        guard let v = ws.focusedView else { check("strip_menu_view", false); return }
        let menu = v.contextMenu(at: v.convert(NSPoint(x: 20, y: 20), to: nil))
        let items = menu.items.filter { !$0.isSeparatorItem }
        let on = Dictionary(items.map { ($0.title, $0.isEnabled) }, uniquingKeysWith: { a, _ in a })
        check("term_menu_items", items.map(\.title) == ["Copy", "Paste", "Select All", "Copy Path", "Find…", "Clear", "Split Right", "Split Down"]
              && on["Copy"] == false && on["Copy Path"] == true && on["Split Right"] == true, items.map { "\($0.title):\($0.isEnabled)" }.joined(separator: ","))
        // Copy Path: the pane's folder on the pasteboard.
        let pb = NSPasteboard(name: NSPasteboard.Name("ravenry-selftest-term-menu"))
        v.pasteboard = pb
        if let cp = items.first(where: { $0.title == "Copy Path" }), let a = cp.action { NSApp.sendAction(a, to: cp.target, from: cp) }
        check("term_menu_copy_path", pb.string(forType: .string) == ws.paneInfo(v.pane)?.cwd && pb.string(forType: .string)?.isEmpty == false, pb.string(forType: .string) ?? "nil")
        v.pasteboard = .general
        // Over a link: Open Link and Copy Link first; Copy Link puts it on the pasteboard.
        ws.conn.request("pane.send", ["pane": v.pane, "input": [["text": "echo https://ravenry.dev/strip-link", "mode": "paste"], ["key": "Enter"]]])
        _ = wait(5) { v.screen.text().components(separatedBy: "https://ravenry.dev/strip-link").count > 2 }
        let lf = v.renderer.fonts, lpad = v.renderer.padding
        v.screen.lock()
        let lrow = (0..<v.screen.rows).first { let t = v.screen.rowText($0); return t.hasPrefix("https://ravenry.dev/strip-link") } ?? -1
        v.screen.unlock()
        let lp = v.convert(NSPoint(x: lpad + 5.5 * lf.cellWidth / lf.scale, y: lpad + (CGFloat(lrow) + 0.5) * lf.cellHeight / lf.scale), to: nil)
        let lm = v.contextMenu(at: lp)
        let lt = lm.items.filter { !$0.isSeparatorItem }.map(\.title)
        check("term_menu_link_items", lrow >= 0 && Array(lt.prefix(3)) == ["Open Link", "Copy Link", "Copy"], "row \(lrow) \(lt)")
        v.pasteboard = pb
        if let cl = lm.items.first(where: { $0.title == "Copy Link" }), let a = cl.action { NSApp.sendAction(a, to: cl.target, from: cl) }
        check("term_menu_copy_link", pb.string(forType: .string) == "https://ravenry.dev/strip-link", pb.string(forType: .string) ?? "nil")
        v.pasteboard = .general
        // Split Right from the menu: the tab splits, then its menu says it cannot again.
        let host = ws.active
        if let sr = items.first(where: { $0.title == "Split Right" }), let a = sr.action { NSApp.sendAction(a, to: sr.target, from: sr) }
        check("term_menu_split", wait(5) { host?.guest != nil && ws.active === host })
        if let v2 = ws.focusedView {
            let again = v2.contextMenu(at: v2.convert(NSPoint(x: 20, y: 20), to: nil))
            check("term_menu_split_off", again.items.first { $0.title == "Split Right" }?.isEnabled == false)
        }
        // A session's pane in a split: its head shows its state's dot (here: none, a shell).
        if let g = host?.guest { ws.closePane(g) }
        _ = wait(3) { host?.guest == nil }

        // The find bar: the app's colours (light and dark), and a one-line selection fills it.
        if let v = ws.focusedView {
            ws.conn.request("pane.send", ["pane": v.pane, "input": [["text": "echo tilesetneedle", "mode": "paste"], ["key": "Enter"]]])
            _ = wait(5) { v.screen.text().contains("tilesetneedle\n") || v.screen.text().components(separatedBy: "tilesetneedle").count > 2 }
            // The word selected with the mouse, then Cmd+F: it is what the bar looks for.
            let f = v.renderer.fonts, pad = v.renderer.padding
            let cw = f.cellWidth / f.scale, chh = f.cellHeight / f.scale
            v.screen.lock()
            let row = (0..<v.screen.rows).first { let t = v.screen.rowText($0); return t.contains("tilesetneedle") && !t.contains("echo") } ?? -1
            let col = row < 0 ? 0 : (v.screen.rowText(row).range(of: "tilesetneedle").map { v.screen.rowText(row).distance(from: v.screen.rowText(row).startIndex, to: $0.lowerBound) } ?? 0)
            v.screen.unlock()
            func mouse(_ type: NSEvent.EventType, _ c: CGFloat) -> NSEvent {
                let p = v.convert(NSPoint(x: pad + c * cw, y: pad + (CGFloat(row) + 0.5) * chh), to: nil)
                return NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                          context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1)!
            }
            if row >= 0 {
                v.mouseDown(with: mouse(.leftMouseDown, CGFloat(col) + 0.1))
                for k in 1...4 { v.mouseDragged(with: mouse(.leftMouseDragged, CGFloat(col) + 0.1 + 12.8 * CGFloat(k) / 4)) }
                v.mouseUp(with: mouse(.leftMouseUp, CGFloat(col) + 12.9))
            }
            _ = wait(2) { v.screen.lock(); defer { v.screen.unlock() }; return v.screen.selection != nil }
            v.showFindBar(nil)
            check("find_from_selection", v.findBar?.field.stringValue == "tilesetneedle" && v.findNeedle == "tilesetneedle", "row \(row) col \(col) field \(v.findBar?.field.stringValue ?? "nil")")
            check("find_from_selection_counts", wait(3) { v.findCount >= 1 }, "\(v.findCount)")
            v.closeFindBar()
            NSApp.appearance = NSAppearance(named: .aqua)
            settle(0.3)
            v.showFindBar(nil)
            if let fb = v.findBar {
                fb.field.stringValue = "tilesetneedle"
                v.findChanged("tilesetneedle")
                settle(0.5)
                var card = CGColor(gray: 0, alpha: 1)
                fb.effectiveAppearance.performAsCurrentDrawingAppearance { card = Design.color("card").cgColor }
                check("find_bar_app_colours_light", fb.layer?.backgroundColor == card && fb.previous.toolTip == "Previous (⇧⌘G)" && fb.next.toolTip == "Next (⌘G)" && fb.close.toolTip == "Close (Esc)",
                      "\(String(describing: fb.layer?.backgroundColor)) vs \(card)")
                picturesOver("find") { [fb] }
            }
            NSApp.appearance = NSAppearance(named: .darkAqua)
            v.closeFindBar()
        }

        // A tab dragged down onto the right edge of the pane in front: lit, then split with it.
        guard ws.tabs.count >= 2, let hostTab = ws.active, let moving = ws.tabs.first(where: { $0 !== hostTab }),
              let item = bar.items.first(where: { $0.model.id == moving.id }) else { check("drag_split_setup", false); return }
        let stage = ws.stage
        let wp = stage.convert(NSPoint(x: stage.bounds.width - 40, y: stage.bounds.midY), to: nil)
        bar.beginDrag(item, at: item.frame.midX)
        bar.drag(item, to: NSPoint(x: item.frame.midX, y: 300), window: wp)
        check("drag_split_zone", ws.dropZone.superview === stage && ws.dropZone.side == "right" && ws.dropZone.words == "Split right" && !ws.dropZone.refused,
              "\(ws.dropZone.side) \(ws.dropZone.words)")
        pictureOver("native-drag-split-1280.png", [ws.dropZone])
        let count = ws.tabs.count
        bar.endDrag(item, window: wp)
        check("drag_split_done", ws.active === hostTab && hostTab.guest == moving.host && hostTab.side == "right" && ws.tabs.count == count - 1 && ws.dropZone.superview == nil,
              "guest \(hostTab.guest ?? "-") side \(hostTab.side) tabs \(ws.tabs.count)")
        // Another tab over a split tab: refused, and nothing changes.
        if let third = ws.tabs.first(where: { $0 !== hostTab }) ?? { ws.newTab(nil); ws.show(hostTab); return ws.tabs.first { $0 !== hostTab } }() {
            ws.dragOver(third.id, wp)
            check("drag_split_refused", ws.dropZone.refused && ws.dropZone.words == "Already split: one split per tab", ws.dropZone.words)
            check("drag_split_refused_drop", !ws.dropTab(third.id, wp) && ws.tabs.contains { $0 === third })
        }
        if let g = hostTab.guest { ws.closePane(g) }
        _ = wait(3) { hostTab.guest == nil }

        // The filmstrip: the film button while a pane is in front, the sheet under the pane.
        if let t0 = ws.tabs.first { ws.show(t0) }
        board.render(force: true)
        settle(0.3)
        guard let fv = ws.focusedView else { check("film_pane", false); return }
        for k in 1...6 { ws.conn.request("pane.send", ["pane": fv.pane, "input": [["text": "echo film line \(k)", "mode": "paste"], ["key": "Enter"]]]); settle(0.25) }
        settle(0.6)
        let stageH = ws.stage.frame.height
        check("film_button_shown", !bar.filmButton.isHidden && bar.filmButton.frame.maxX <= bar.panelButton.frame.minX && bar.filmButton.toolTip == "The last 20 seconds of this pane")
        _ = bar.filmButton.accessibilityPerformPress()
        check("film_opens", wait(10) { ws.film.isOpen && !ws.film.loading } && !ws.film.frames.isEmpty && bar.filmOn
              && abs(ws.stage.frame.height - (stageH - FilmSheet.height)) < 1 && ws.film.frame.minY >= ws.stage.frame.maxY - 0.5,
              "open \(ws.film.isOpen) frames \(ws.film.frames.count) err \(ws.film.error ?? "-") stage \(ws.stage.frame.height) was \(stageH)")
        check("film_thumbs", ws.film.controls.keys.contains { $0.hasPrefix("thumb:") } && ws.film.controls["gif"] != nil && ws.film.controls["play"] != nil, ws.film.controls.keys.sorted().joined(separator: ","))
        // (A new look reads the frames again, in its colours: each picture once they came.)
        for (w, h) in [(CGFloat(1280), CGFloat(820)), (900, 760)] {
            size(w, h)
            for dark in [true, false] {
                NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                settle(0.4)
                _ = wait(10) { !ws.film.loading }
                board.render(force: true)
                settle(0.4)
                picture("native-film-\(Int(w))-\(dark ? "dark" : "light").png")
            }
        }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        size(1280, 820)
        check("film_reads_again_in_new_colours", wait(10) { !ws.film.loading && !ws.film.frames.isEmpty })
        if let th = ws.film.controls.keys.sorted().first(where: { $0.hasPrefix("thumb:") }).flatMap({ ws.film.controls[$0] as? FilmThumb }) { th.onPress?() }
        check("film_frame_shown", ws.film.shown != nil && ws.filmView.superview === ws.stage && ws.filmView.line.hasPrefix("Showing "), ws.filmView.line)
        pictureOver("native-film-frame-1280.png", [ws.filmView])
        ws.film.step(1)
        check("film_step", ws.film.shown != nil)
        ws.filmView.back.performClick(nil)
        check("film_back_to_live", ws.film.shown == nil && ws.filmView.superview == nil)
        let gdir = dir.appendingPathComponent("film-gif")
        try? FileManager.default.createDirectory(at: gdir, withIntermediateDirectories: true)
        ws.film.testSaveDir = gdir
        (ws.film.controls["gif"] as? RButton)?.run?()
        check("film_gif_saved", wait(15) { ws.film.lastSaved != nil } && (try? Data(contentsOf: ws.film.lastSaved!))?.prefix(4) == Data("GIF8".utf8), ws.film.lastSaved?.path ?? "none")
        // A pane the board follows as a session: Send to its assistant posts the hub's filmstrip route.
        let fpid = board.hub.state?.projects.first { $0.machine == nil && !$0.sessions.isEmpty }?.id ?? ""
        let fsid = board.hub.state?.project(fpid)?.sessions.first?.surfaceId ?? ""
        let fpane = fv.pane
        board.hub.testPatch = { r in
            var r = r
            var ps = r["projects"] as? [[String: Any]] ?? []
            if let i = ps.firstIndex(where: { $0["id"] as? String == fpid }), var ss = ps[i]["sessions"] as? [[String: Any]], !ss.isEmpty {
                ss[0]["pane"] = fpane; ss[0]["assistant"] = "claude"; ps[i]["sessions"] = ss
            }
            r["projects"] = ps
            return r
        }
        board.hub.testCheckpoints = []
        board.hub.testPostAnswers["/api/sessions/\(fsid)/filmstrip"] = (200, ["ok": true])
        ws.film.paint()
        let fsn = board.hub.sentBodies.count
        (ws.film.controls["send"] as? RButton)?.run?()
        check("film_send", (ws.film.controls["send"] as? RButton)?.title == "Send to Claude" && wait(3) { ws.film.lastSent == "Claude" }
              && board.hub.sentBodies.dropFirst(fsn).contains { $0.path == "/api/sessions/\(fsid)/filmstrip" && $0.body["pane"] as? String == fpane && ($0.body["last_ms"] as? Int) == 20000 },
              "\((ws.film.controls["send"] as? RButton)?.title ?? "no send") \(board.hub.sentBodies.dropFirst(fsn).map(\.path))")
        board.hub.testPatch = nil
        board.hub.testCheckpoints = []
        board.hub.testPostAnswers = [:]
        (ws.film.controls["close"] as? RButton)?.run?()
        check("film_closes", !ws.film.isOpen && abs(ws.stage.frame.height - stageH) < 1 && !bar.filmOn)

        // A big busy pane, as a long Claude tab in a 1200 x 1000 pt pane at 2x: 153 x 60 of dense
        // text and a line redrawn ten times a second. All its frames as PNGs at 26 px are far over
        // the daemon's 12 MiB (330 KB each): the strip opens with the pictures that fit, says how
        // many, and every frame's time on the track.
        let busy = "head -c 8800 /usr/share/dict/words | tr '\\n' ' ' | fold -w 152; echo; i=0; while :; do printf '\\r\\033[38;5;208m* Working on the tiles (%d)\\033[0m\\033[K' $i; i=$((i+1)); sleep 0.1; done"
        if let bp = newPane([:], name: "Busy", command: ["/bin/sh", "-c", busy]), let bt = ws.tab(showing: bp) {
            ws.show(bt)
            _ = try? ws.conn.call("pane.override", ["pane": bp, "cols": 153, "rows": 60, "no_wait": true], timeout: 5)
            settle(4)
            let t0 = Date()
            ws.film.load(bp)
            let read = wait(30) { !ws.film.loading }
            let took = Date().timeIntervalSince(t0)
            let f = ws.film
            let px = f.frames.first.map { "\($0.image.width)x\($0.image.height)" } ?? "-"
            check("film_big_pane", read && f.error == nil && f.frames.count >= 2 && f.total > f.frames.count && f.frames.allSatisfy { $0.thumb != nil }
                  && f.frames.last.map { $0.at > t0.addingTimeInterval(-1) } ?? false,
                  "\(f.frames.count) of \(f.total) frames pictured at \(px), read in \(String(format: "%.2f", took)) s, err \(f.error ?? "-")")
            board.render(force: true)
            settle(0.4)
            let some = (f.controls["some"] as? NSTextField)?.stringValue ?? "-"
            check("film_big_says_some", some == t("film.some", ["n": "\(f.frames.count)", "all": "\(f.total)"]) && f.controls["some"]?.isHiddenOrHasHiddenAncestor == false, some)
            // A line redrawn ten times a second is no frame half drawn (the daemon's missing_rows).
            check("film_big_not_half", !f.allMarks.contains { $0.tag == "half" } && f.allMarks.count == f.total,
                  "\(f.allMarks.filter { $0.tag == "half" }.count) of \(f.total) half drawn")
            check("film_big_thumbs", f.controls.keys.filter { $0.hasPrefix("thumb:") }.count >= 3, f.controls.keys.sorted().joined(separator: ","))
            picture("native-film-big-1280.png")
            if let th = f.controls.keys.sorted().last(where: { $0.hasPrefix("thumb:") }).flatMap({ f.controls[$0] as? FilmThumb }) { th.onPress?() }
            check("film_big_frame_shown", f.shown != nil && ws.filmView.superview === ws.stage, ws.filmView.line)
            pictureOver("native-film-big-frame-1280.png", [ws.filmView])
            ws.filmView.back.performClick(nil)
            (f.controls["close"] as? RButton)?.run?()
            ws.closePane(bp)
        } else { check("film_big_pane", false, "no pane") }
        // A redraw seen half done (the top rows erased, drawn again 150 ms later, no synchronized
        // output) is marked half drawn; the spinner line between is not.
        let torn = "draw() { printf '\\033[H'; head -c 1500 /usr/share/dict/words | tr '\\n' ' ' | fold -w 78; }; draw; i=0; while :; do "
            + "if [ $((i % 8)) = 7 ]; then printf '\\033[H'; k=0; while [ $k -lt 12 ]; do printf '\\033[2K\\033[1B'; k=$((k+1)); done; sleep 0.15; draw; fi; "
            + "printf '\\033[24;1H\\033[2K* Working (%d)' $i; i=$((i+1)); sleep 0.1; done"
        if let tp = newPane([:], name: "Torn", command: ["/bin/sh", "-c", torn]), let tt = ws.tab(showing: tp) {
            ws.show(tt)
            settle(4)
            ws.film.load(tp)
            _ = wait(30) { !ws.film.loading }
            let f = ws.film
            let half = f.allMarks.filter { $0.tag == "half" }.count
            check("film_torn_marked", f.error == nil && half >= 2 && half <= 12 && f.total >= 25, "\(half) of \(f.total) half drawn, err \(f.error ?? "-")")
            board.render(force: true)
            settle(0.4)
            picture("native-film-torn-1280.png")
            (f.controls["close"] as? RButton)?.run?()
            ws.closePane(tp)
        } else { check("film_torn_marked", false, "no pane") }
        // A strip that could not be read says so, with Try again.
        ws.film.load("pzzzzzzz")
        settle(0.3)
        check("film_failure_retry", ws.film.error == t("film.noDaemon") && ws.film.controls["retry"] != nil, ws.film.error ?? "-")
        picture("native-film-failed-1280.png")
        (ws.film.controls["close"] as? RButton)?.run?()
        // A failure reads as words, never the daemon's own.
        let raw = ConnectionError.daemon(code: "failed", message: "these frames are over 12 MiB as PNGs: ask for fewer (max_frames) or a gif")
        check("film_failure_words", Film.why(raw) == t("film.whyBig") && Film.why(.daemon(code: "not_found", message: "no pane px")) == t("film.whyClosed")
              && Film.why(.timeout) == t("film.whySlow") && Film.why(.closed) == t("film.whyLost") && Film.why(.daemon(code: "internal", message: "boom")) == t("film.whyDaemon"),
              Film.why(raw))

        // The first agent's own pane: the one-time hint, under its pane's head; dismissed, marked, never again.
        if let owner = ws.active?.host {
            let bin = Bundle.main.bundlePath + "/Contents/MacOS/ravenryd"
            ws.conn.request("pane.send", ["pane": owner, "input": [["text": "'\(bin)' new --name 'dev server' -- /bin/sleep 600 >/dev/null", "mode": "paste"], ["key": "Enter"]]])
            check("hint_shows", wait(10) { ws.hint.superview != nil && ws.hintPane != nil }
                  && ws.hint.text.stringValue.contains("opened \u{201C}dev server\u{201D}") && ws.hint.text.stringValue.contains("Watch it here, or type in it yourself."),
                  ws.hint.text.stringValue)
            let hr = ws.hint.frame, guest = ws.active?.guest.flatMap { ws.boxes[$0] }
            check("hint_under_pane_head", guest.map { g in let r = g.convert(g.bounds, to: ws.stage); return hr.minY >= r.minY + Design.headHeight && hr.minX >= r.minX } ?? false, "\(hr)")
            pictureOver("native-hint-1280.png", [ws.hint])
            let n = board.hub.sentBodies.count
            ws.hint.close.action?()
            check("hint_dismissed_marked", ws.hint.superview == nil && board.hub.sentBodies.dropFirst(n).contains { $0.path == "/api/onboarding" && ($0.body["hints"] as? [String: Any])?["agent-pane"] as? Bool == true })
            if let g = ws.active?.guest { ws.closePane(g) }
            ws.conn.request("pane.send", ["pane": owner, "input": [["text": "'\(bin)' new --name 'second' -- /bin/sleep 600 >/dev/null", "mode": "paste"], ["key": "Enter"]]])
            _ = wait(6) { ws.active?.guest != nil }
            settle(0.5)
            check("hint_once", ws.hint.superview == nil && ws.hintPane == nil)
            if let g = ws.active?.guest { ws.closePane(g) }
        }

        // Extra tabs (a read-only session, a pinned one): each right after its session's tab.
        if ws.tabs.count < 2 { ws.newTab(nil); _ = wait(5) { ws.tabs.count >= 2 } }
        let firstId = ws.tabs[0].id
        ws.extraTabs = [TabModel(id: "view:a", name: "Old notes", sub: nil, split: false, active: false, tip: "Old notes", dot: "idle", after: firstId),
                        TabModel(id: "view:b", name: "Elsewhere", sub: nil, split: false, active: true, tip: "Elsewhere", dot: "idle", after: nil),
                        TabModel(id: "view:c", name: "Brief", sub: nil, split: false, active: false, tip: "Brief", dot: "tx3", after: firstId)]
        let ids = bar.items.map(\.model.id)
        check("extra_tabs_beside_session", ids.count == ws.tabs.count + 3 && Array(ids.prefix(3)) == [firstId, "view:a", "view:c"] && ids.last == "view:b" && ws.extraTab?.id == "view:b", "\(ids)")
        ws.extraTabs = []
        ws.refresh()

        // A tab to another window's workspace, whole, its panes running, its shells labelled with that window's id; and back.
        let w2 = TerminalWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 600), styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        w2.isReleasedWhenClosed = false
        w2.allowOffscreen = true
        let ws2 = Workspace(window: w2, options: ws.options, daemons: ws.daemons, scale: ws.scale, windowId: "wselftest2")
        ws2.root.frame = NSRect(x: 0, y: 0, width: 900, height: 600)
        w2.contentView = ws2.root
        w2.setFrameOrigin(NSPoint(x: -34000, y: -30000))
        w2.orderFront(nil)
        if let mt = ws.tabs.last {
            let mp = mt.host
            let n1 = ws.tabs.count
            ws.move(mt, to: ws2)
            let label = { () -> String? in ((try? ws.conn.call("pane.list", [:], timeout: 3))?["panes"] as? [[String: Any]])?.first { $0["id"] as? String == mp }.flatMap { ($0["labels"] as? [String: String])?["ravenry.window"] } }
            check("move_tab_out", ws.tabs.count == n1 - 1 && !ws.tabs.contains { $0.host == mp } && ws2.active?.host == mp && wait(3) { label() == "wselftest2" } && paneRunning(mp), "\(label() ?? "nil")")
            settle(0.6)
            check("move_tab_not_back", !ws.tabs.contains { $0.host == mp })
            if let back = ws2.tabs.first { ws2.move(back, to: ws) }
            check("move_tab_back", ws.tabs.contains { $0.host == mp } && ws2.tabs.isEmpty && wait(3) { label() == nil } && paneRunning(mp), "\(label() ?? "nil")")
        }
        w2.orderOut(nil)

        // No tab left: the window stays, says so, and New shell brings one.
        for t in ws.tabs { ws.closeTab(t) }
        check("empty_window_stays", wait(5) { ws.tabs.isEmpty } && window.isVisible && !ws.empty.isHidden && ws.empty.superview === ws.stage, "\(ws.tabs.count) visible \(window.isVisible)")
        pictures("empty")
        click(ws.empty.button)
        check("empty_new_shell", wait(5) { ws.tabs.count == 1 && ws.active != nil } && ws.empty.isHidden)
    }

    func screenStartLocal() {
        let st = board.start
        // A home with two projects and an assistant on the PATH, signed in.
        let home = (NSTemporaryDirectory() as NSString).appendingPathComponent("ravenry-startlocal-\(getpid())")
        let fm = FileManager.default
        for (n, m) in [("alpha", ".git"), ("beta", "package.json")] {
            let d = "\(home)/Projects/\(n)"
            try? fm.createDirectory(atPath: d, withIntermediateDirectories: true)
            if m == ".git" { try? fm.createDirectory(atPath: "\(d)/.git", withIntermediateDirectories: true) } else { fm.createFile(atPath: "\(d)/\(m)", contents: Data("{}".utf8)) }
            settle(0.05)
        }
        try? fm.setAttributes([.modificationDate: Date()], ofItemAtPath: "\(home)/Projects/beta")
        try? fm.createDirectory(atPath: "\(home)/bin", withIntermediateDirectories: true)
        fm.createFile(atPath: "\(home)/bin/claude", contents: Data("#!/bin/sh\necho 'claude stand-in'\nexec /bin/sleep 600\n".utf8), attributes: [.posixPermissions: 0o755])
        fm.createFile(atPath: "\(home)/.claude.json", contents: Data(#"{"oauthAccount": {"emailAddress": "x"}}"#.utf8))
        st.localHome = home
        st.localEnv = ["PATH": "\(home)/bin:/usr/bin:/bin"]

        // The rules, read here.
        let lv = LocalStart.view(home: home, env: st.localEnv, want: nil)
        let names = (lv["folders"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }
        let asst = lv["assistants"] as? [[String: Any]] ?? []
        check("local_rules", names == ["beta", "alpha"] && lv["root"] as? String == "~/Projects"
              && asst.first?["found"] as? Bool == true && asst.first?["signedIn"] as? Bool == true && asst.last?["found"] as? Bool == false,
              "\(names) \(lv["root"] ?? "-") \(asst)")
        check("local_say_path", LocalStart.say("\(home)/Projects/beta", home: home) == "~/Projects/beta" && LocalStart.say("/opt/x", home: home) == "/opt/x")

        // Start with the board down.
        st.testBoardDown = true
        board.openStart(nil)
        check("local_start_offers", wait(3) { st.local && st.folder == "\(home)/Projects/beta" && st.assistant == "claude" } && st.go.title == "Start Claude in beta"
              && shows(st, "The board is not running") && shows(st, "Found in ~/Projects."), "\(st.folder ?? "-") \(st.go.title)")
        pictures("start-local")
        // The access card while macOS asks, with Open Files & Folders.
        st.testWaiting = "~/Documents"
        var opened = 0
        st.openPrivacy = { opened += 1 }
        st.show(folder: st.folder)
        check("local_access_card", st.controls["access"] != nil && shows(st, "macOS is asking whether Ravenry may read ~/Documents. Click Allow in the dialog.")
              && shows(st, "Privacy & Security > Files & Folders"), texts(st).prefix(10).joined(separator: " | "))
        pictures("start-access")
        if let b = st.controls["openPrivacy"] { click(b) }
        check("local_open_privacy", opened == 1)
        st.testWaiting = nil
        st.testDenied = ["~/Desktop"]
        st.show(folder: st.folder)
        check("local_denied_note", shows(st, "macOS did not let Ravenry read ~/Desktop."))
        st.testDenied = nil
        st.show(folder: st.folder)
        check("local_no_card", st.controls["access"] == nil)

        // Start: the assistant in a pane of this window, labelled as the app's, in front.
        let n = board.ws.tabs.count
        let sentBefore = board.hub.sentBodies.count
        click(st.go)
        check("local_started_tab", wait(5) { self.board.ws.tabs.count == n + 1 && self.board.front == .tab && self.board.root.middle == nil }, "\(board.ws.tabs.count) \(board.front)")
        let pane = board.ws.active?.host ?? ""
        let i = board.ws.paneInfo(pane)
        check("local_started_program", i?.command.first == "\(home)/bin/claude" && i?.labels["ravenry.agent"] == "claude" && i?.labels["ravenry.kind"] == "shell"
              && i?.cwd.hasSuffix("/Projects/beta") == true && board.ws.label(pane).name == "Claude",
              "\(i?.command ?? []) \(i?.labels ?? [:]) \(i?.cwd ?? "-") \(board.ws.label(pane).name)")
        check("local_no_board_post", !board.hub.sentBodies.dropFirst(sentBefore).contains { $0.path == "/api/sessions/start" })
        check("local_stand_in_runs", wait(5) { self.board.ws.focusedView?.screen.text().contains("claude stand-in") == true })
        st.testBoardDown = false
        try? fm.removeItem(atPath: home)
    }
}
