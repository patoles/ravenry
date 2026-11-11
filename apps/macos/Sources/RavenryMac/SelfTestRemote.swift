// The cards' and the machines' round (scripts/machinetest.mjs, --screen
// remote): the demo hub follows this test's ravenryd (it words and holds its
// checkpoints, as the person's board does) and reaches a second test ravenryd
// as the machine "testbox" through a fake ssh. Each check drives the real
// control (a mouse press through the window, keys through the window) and
// reads the effect where it lands: what the asking command printed, the file
// a run wrote, the machine's own pane, the hub's answer.
//
// - PANEL-024: a card answered, withdrawn and out of time says how it ended,
//   in the hub's words, and a late open copy never brings it back.
// - The who copy: a drive's "Or tell the agent something else".
// - PAGE-006: a project page's Build is headed with the page and the button.
// - MACH-007: New session on testbox; MACH-006: its terminal, live, typed
//   into; MACH-005: a question asked there, answered from the panel.

import AppKit

extension SelfTestBoard {
    private var remote: [String: Any] {
        guard let s = ProcessInfo.processInfo.environment["RAVENRY_MAC_REMOTE"], let j = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any] else { return [:] }
        return j
    }

    /// The machine's ravenry command line, with its environment (never this Mac's daemon).
    private func onMachine(_ args: [String]) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: remote["rd"] as? String ?? "")
        p.arguments = [args[0], "--no-start"] + args.dropFirst()
        p.environment = remote["env"] as? [String: String] ?? [:]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = out
        try? p.run()
        let d = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(decoding: d, as: UTF8.self)
    }

    /// A check, said in app.log as it is made (the run is long).
    private func rc(_ name: String, _ ok: Bool, _ detail: String = "") {
        NSLog("remote check %@ %@ %@", ok ? "pass" : "FAIL", name, String(detail.prefix(700)))
        check(name, ok, detail)
    }

    private func file(_ path: String) -> String { (try? String(contentsOfFile: path, encoding: .utf8)) ?? "" }

    private func sendLine(_ pane: String, _ text: String) {
        board.ws.conn(of: pane).request("pane.send", ["pane": pane, "input": [["text": text, "mode": "paste"], ["key": "Enter"]]])
    }

    /// Keys through the window, to whatever has the keyboard (as the person types).
    private func typeIntoWindow(_ s: String) {
        var codes: [String: UInt16] = [:]
        for (k, name) in KeyCodes.table {
            if name.hasPrefix("Key") { codes[name.dropFirst(3).lowercased()] = k }
            if name.hasPrefix("Digit") { codes[String(name.dropFirst(5))] = k }
        }
        codes[" "] = 0x31; codes["\r"] = 0x24; codes["."] = 0x2F; codes["-"] = 0x1B; codes["/"] = 0x2C
        for ch in s {
            let c = String(ch)
            guard let code = codes[c] else { continue }
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                if let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                            windowNumber: window.windowNumber, context: nil, characters: c, charactersIgnoringModifiers: c,
                                            isARepeat: false, keyCode: code) {
                    window.sendEvent(e)
                }
            }
        }
        settle(0.2)
    }

    /// A press and a release at the middle of a view, as the window gets them: the release queued
    /// first, so a button's tracking loop finds it (the board's click sends it after, which a button waits for forever).
    private func press(_ v: NSView) {
        window.contentView?.layoutSubtreeIfNeeded()
        v.scrollToVisible(v.bounds)
        let p = v.convert(NSPoint(x: v.bounds.midX, y: v.bounds.midY), to: nil)
        let now = ProcessInfo.processInfo.systemUptime
        let ev = { (type: NSEvent.EventType, at: TimeInterval) in NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: at,
                                                                    windowNumber: self.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) }
        guard let down = ev(.leftMouseDown, now), let up = ev(.leftMouseUp, now + 0.05) else { return }
        // A button tracks the press in a loop of its own, reading the queue: the release is queued while it waits.
        // Any other view takes the release as sent.
        // A button's own click (its press tracking reads the window server's queue, which a window off every screen does not feed).
        if let b = v as? NSButton { b.performClick(nil) } else { window.sendEvent(down); window.sendEvent(up) }
        NSLog("remote press %@ %@", String(describing: type(of: v)), (v as? NSButton)?.title ?? "")
        settle(0.3)
    }

    /// The window, with the machine's terminal drawn at its place (Metal draws offscreen).
    private func livePicture(_ name: String) {
        guard let root = window.contentView, let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { return }
        root.cacheDisplay(in: root.bounds, to: rep)
        let s: CGFloat = 2
        let w = Int(root.bounds.width * s), h = Int(root.bounds.height * s)
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
              let base = rep.cgImage else { return }
        ctx.setFillColor(CGColor(gray: 0, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.draw(base, in: CGRect(x: 0, y: 0, width: w, height: h))
        if let v = board.outside.live?.view, v.window != nil, !v.isHiddenOrHasHiddenAncestor, let img = v.snapshotImage() {
            let r = v.convert(v.bounds, to: root)
            ctx.draw(img, in: CGRect(x: r.minX * s, y: CGFloat(h) - r.maxY * s, width: r.width * s, height: r.height * s))
        }
        if board.root.panelMode == .overlay, let p = board.root.panel, let r2 = p.bitmapImageRepForCachingDisplay(in: p.bounds) {
            p.cacheDisplay(in: p.bounds, to: r2)
            let r = p.convert(p.bounds, to: root)
            if let img = r2.cgImage { ctx.draw(img, in: CGRect(x: r.minX * s, y: CGFloat(h) - r.maxY * s, width: r.width * s, height: r.height * s)) }
        }
        guard let img = ctx.makeImage() else { return }
        try? NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent(name))
    }

    /// The rows the terminal view holds now, as text.
    private func termText(_ v: TerminalView) -> String { v.screen.text() }

    func screenRemote() {
        let hub = board.hub, ws = board.ws, pn = board.panel
        let out = remote["out"] as? String ?? dir.path
        let bin = Bundle.main.bundlePath + "/Contents/MacOS/ravenryd"
        size(1440, 900)

        // MARK: PANEL-024, a card answered: it says so, and a late copy never reopens it
        board.toTerminal()
        guard let first = ws.tabs.first else { rc("rc_tabs", false); return }
        ws.show(first)
        board.render(force: true)
        settle(0.6)
        let shell = first.host
        let ask1 = out + "/ask1.out"
        sendLine(shell, "'\(bin)' ask 'Paint the hull blue?' --option 'Blue' --option 'Red' > '\(ask1)' 2>&1")
        rc("rc_ask_card", wait(12) { self.board.render(force: true); return pn.shownCard?.kind == "ask" && self.shows(pn, "Paint the hull blue?") }, texts(pn).prefix(8).joined(separator: " | "))
        let id1 = hub.checkpoint(pane: shell)?["id"] as? String ?? ""
        rc("rc_ask_held_by_hub", wait(10) { (hub.state?.checkpoints ?? []).contains { $0["id"] as? String == id1 && ($0["words"] as? [String: Any])?["heading"] != nil } }, id1)
        let s0 = hub.sentBodies.count
        if let o = pn.shownCard?.opts["1"] {
            let p = o.convert(NSPoint(x: o.bounds.midX, y: o.bounds.midY), to: nil)
            var chain: [String] = []
            var x: NSView? = o
            while let v = x { chain.append("\(type(of: v)) \(NSStringFromRect(v.convert(v.bounds, to: nil))) hidden \(v.isHidden)"); x = v.superview }
            var hc: [String] = []
            var y: NSView? = window.contentView?.hitTest(p)
            while let v = y { hc.append("\(type(of: v)) \(NSStringFromRect(v.convert(v.bounds, to: nil))) \(v.identifier?.rawValue ?? "")"); y = v.superview }
            NSLog("remote debug opt %@ hit chain %@ || opt chain %@", NSStringFromPoint(p), hc.joined(separator: " <- "), chain.joined(separator: " <- "))
            press(o)
        }
        rc("rc_answer_lands", wait(10) { self.file(ask1).contains("Blue") }, "sent: \(hub.sentBodies.dropFirst(s0).map { "\($0.path) \($0.body)" }) panel: \(texts(pn).joined(separator: " | "))")
        rc("rc_answered_card", wait(6) { self.board.render(force: true); return pn.shownCard != nil && self.shows(pn, "Answered") && self.shows(pn, "Blue") && self.shows(pn, "You answered here.") },
              texts(pn).prefix(10).joined(separator: " | "))
        livePicture("native-cards-answered-1440-dark.png")
        // The hub's state from before the answer reached it, again: the card stays as it ended.
        if let open = (hub.state?.checkpoints ?? []).first(where: { $0["id"] as? String == id1 }) {
            var late = open
            late["state"] = "open"
            late["words"] = (open["words"] as? [String: Any]).map { w -> [String: Any] in var x = w; x["state"] = "open"; return x }
            hub.testPatch = { r in var r = r; var l = r["checkpoints"] as? [[String: Any]] ?? []; l.removeAll { $0["id"] as? String == id1 }; l.append(late); r["checkpoints"] = l; return r }
            hub.testCheckpoints = nil
            hub.testCheckpoints = nil
        }
        settle(1.5)
        board.render(force: true)
        settle(0.3)
        let lateOpen = hub.checkpoint(pane: shell)
        rc("rc_late_copy_stays_closed", lateOpen == nil && shows(pn, "Answered") && !shows(pn, "Needs you since"), "\(lateOpen?["state"] ?? "none") | \(texts(pn).prefix(6).joined(separator: " | "))")
        hub.testPatch = nil

        // Withdrawn, then out of time.
        sendLine(shell, "'\(bin)' ask 'Sand the deck first?' --option 'Yes' --option 'No' > /dev/null 2>&1 &")
        rc("rc_ask2_card", wait(10) { self.board.render(force: true); return self.shows(pn, "Sand the deck first?") && pn.shownCard?.kind == "ask" })
        let id2 = hub.checkpoint(pane: shell)?["id"] as? String ?? ""
        sendLine(shell, "'\(bin)' checkpoint \(id2) --cancel --reason 'Done by hand'")
        rc("rc_withdrawn_card", wait(10) { self.board.render(force: true); return self.shows(pn, "Withdrawn") && self.shows(pn, "Done by hand") }, texts(pn).prefix(8).joined(separator: " | "))
        livePicture("native-cards-withdrawn-1440-dark.png")
        sendLine(shell, "'\(bin)' ask 'Varnish tonight?' --option 'Yes' --timeout 3s > /dev/null 2>&1")
        rc("rc_ask3_card", wait(10) { self.board.render(force: true); return self.shows(pn, "Varnish tonight?") && pn.shownCard?.kind == "ask" })
        rc("rc_expired_card", wait(15) { self.board.render(force: true); return self.shows(pn, "Nobody answered") }, texts(pn).prefix(8).joined(separator: " | "))
        livePicture("native-cards-expired-1440-dark.png")
        // Kept half an hour: still there after another few renders, until another opens.
        settle(1)
        board.render(force: true)
        rc("rc_closed_card_kept", shows(pn, "Nobody answered") && hub.closed.forPane(shell, machine: nil) != nil)

        // MARK: the who copy: a drive from a generic agent
        ws.newTab(nil)
        guard wait(5, { ws.tabs.count >= 2 && ws.active !== first }), let second = ws.active else { rc("rc_second_tab", false); return }
        settle(0.8)
        sendLine(second.host, "'\(bin)' send \(shell) --typed 'echo driven' > /dev/null 2>&1 &")
        ws.show(first)
        board.render(force: true)
        let driveSeen = wait(12) { self.board.render(force: true); return pn.shownCard?.kind == "drive" || (hub.checkpoints ?? []).contains { $0["kind"] as? String == "drive" && DaemonCheckpoints.isOpen($0) } }
        if pn.shownCard?.kind != "drive", let d = (hub.checkpoints ?? []).first(where: { $0["kind"] as? String == "drive" && DaemonCheckpoints.isOpen($0) }), let did = d["id"] as? String {
            // Its card where it shows: the pane it asks to type into, else on its own.
            if let p = d["pane"] as? String, let tb = ws.tab(showing: p) { ws.show(tb) } else { board.showCheckpoint(did) }
            board.render(force: true)
            _ = wait(4) { pn.shownCard?.kind == "drive" }
        }
        let ph = pn.shownCard?.sendField?.field.placeholderString ?? pn.shownCard?.sendField?.field.placeholderAttributedString?.string ?? ""
        rc("rc_drive_tell_else_mid", driveSeen && ph == "Or tell the agent something else", "placeholder \"\(ph)\" seen \(driveSeen) kind \(pn.shownCard?.kind ?? "none") cps \((hub.checkpoints ?? []).map { "\($0["kind"] ?? "")/\($0["state"] ?? "")/\($0["pane"] ?? "")" })")
        livePicture("native-cards-drive-1440-dark.png")
        if let r = pn.shownCard?.opts.values.first(where: { $0.text == t("checkpoint.refuse") }) { press(r) }
        settle(0.5)
        // The panel's cards on real checkpoints (SelfTestRemotePanel.swift).
        remotePanel(shell: shell, other: second.host)

        // MARK: PAGE-006, a project page's run
        let dk = hub.state?.pages.first { $0.project != nil && $0.label == "Deploys" }?.key ?? ""
        board.openPage(dk, "Deploys")
        let fp = board.files
        rc("rc_page_open", wait(10) { fp.key == dk && self.board.root.middle === fp }, dk)
        _ = wait(10) { fp.pb["bar:trust"] != nil || fp.buttons["page:Build"]?.isEnabled == true }
        if let tr = fp.pb["bar:trust"] { press(tr) }
        rc("rc_page_trusted", wait(10) { fp.buttons["page:Build"]?.isEnabled == true })
        let runFile = remote["runFile"] as? String ?? ""
        if let b = fp.buttons["page:Build"] { press(b) }
        rc("rc_run_card_heading", wait(12) { self.board.render(force: true); return pn.shows == "loose" && pn.shownCard?.kind == "approve" && self.shows(pn, "Deploys") && !self.shows(pn, "The agent wants to run") },
              texts(pn).prefix(8).joined(separator: " | "))
        livePicture("native-cards-page-run-1440-dark.png")
        if let b = pn.shownCard?.buttons["run"] { press(b) }
        rc("rc_run_ran", wait(12) { FileManager.default.fileExists(atPath: runFile) }, "\(pn.shownCard?.buttons.keys.sorted().joined(separator: ",") ?? "") \(runFile)")
        rc("rc_run_after_card", wait(10) { self.board.render(force: true); return pn.shows == "loose" && (self.shows(pn, "Ran on") || self.shows(pn, "Running on")) && !self.texts(pn).joined(separator: " ").lowercased().contains("agent") },
              texts(pn).prefix(8).joined(separator: " | "))
        livePicture("native-cards-page-ran-1440-dark.png")

        // MARK: MACH-007, a session started on testbox
        rc("rc_machine_up", wait(25) { (hub.state?.raw["machines"] as? [[String: Any]] ?? []).contains { $0["name"] as? String == "testbox" && $0["state"] as? String == "connected" } },
              "\(hub.state?.raw["machines"] ?? "none")")
        board.openStart(nil)
        let st = board.start
        rc("rc_start_where_row", wait(8) { st.controls["machine:testbox"] != nil && st.controls["machine:"] != nil }, st.controls.keys.sorted().joined(separator: ","))
        if let m = st.controls["machine:testbox"] { press(m) }
        let rproj = remote["rproj"] as? String ?? ""
        rc("rc_start_machine_folder", wait(4) { st.machine == "testbox" && st.folder == rproj && st.controls["folder:\(rproj)"] != nil } && st.go.title.contains("on testbox"), "\(st.machine ?? "nil") \(st.folder ?? "nil") \(st.go.title)")
        livePicture("native-start-machine-1440-dark.png")
        let n0 = hub.sentBodies.count
        press(st.go)
        rc("rc_start_posted_machine", wait(6) { hub.sentBodies.dropFirst(n0).contains { $0.path == "/api/sessions/start" && $0.body["machine"] as? String == "testbox" && $0.body["folder"] as? String == rproj } },
              hub.sentBodies.dropFirst(n0).map { "\($0.path) \($0.body)" }.joined(separator: " / "))
        let opened = wait(20) { if case .session = self.board.front { return self.board.outside.live != nil }; return false }
        let remotePanes = onMachine(["ls", "--json"])
        rc("rc_start_pane_on_machine", opened && remotePanes.contains(rproj) && remotePanes.contains("ravenry.session"), "\(board.front) \(remotePanes.prefix(400))")

        // MACH-009: the folder on testbox said against testbox's home, never this Mac's (the hub's folderShort, the panel).
        let rlab = hub.state?.project("remote-lab")
        rc("rc_machine_folder_their_home", rlab?.folderShort == "~/remote-lab" && wait(6) { self.board.render(force: true); return self.shows(self.board.panel, "~/remote-lab") && !self.shows(self.board.panel, rproj) },
           "\(rlab?.folderShort ?? "nil") | \(texts(board.panel).prefix(14).joined(separator: " | "))")
        // MARK: MACH-006, its terminal live, typed into
        guard let live = board.outside.live else { rc("rc_live", false); return }
        rc("rc_live_connected", wait(20) { live.state == "live" && live.view?.channel ?? 0 != 0 }, "\(live.state) \(live.why)")
        guard let v = live.view else { return }
        rc("rc_live_drawn", wait(15) { self.termText(v).contains("stand-in ready") }, termText(v).suffix(300).description)
        rc("rc_live_has_keyboard", window.firstResponder === v, "\(String(describing: window.firstResponder))")
        typeIntoWindow("echo typed 42\r")
        let shown = onMachine(["capture", live.pane])
        rc("rc_live_typing_lands", wait(10) { self.onMachine(["capture", live.pane]).contains("typed 42\n") || self.onMachine(["capture", live.pane]).components(separatedBy: "typed 42").count > 2 }, shown.suffix(300).description)
        rc("rc_live_typed_is_person", onMachine(["inputs", live.pane]).contains("person  echo typed 42"), onMachine(["inputs", live.pane]).suffix(300).description)
        rc("rc_live_shows_output", wait(8) { self.termText(v).components(separatedBy: "typed 42").count >= 3 }, termText(v).suffix(300).description)
        board.render(force: true)
        settle(0.5)
        livePicture("native-machine-live-1440-dark.png")

        // MARK: MACH-005, a question asked there, answered from the panel
        typeIntoWindow("sh ask.sh\r")
        let key = { () -> String? in if case .session(let k) = self.board.front { return k }; return nil }() ?? ""
        rc("rc_remote_card", wait(15) { self.board.render(force: true); return pn.shownCard?.kind == "ask" && self.shows(pn, "Launch the boat from testbox?") },
              "\(key) | \(texts(pn).prefix(8).joined(separator: " | "))")
        let rid = (hub.checkpoints ?? []).first { $0["title"] as? String == "Launch the boat from testbox?" }
        rc("rc_remote_card_machine", rid?["machine"] as? String == "testbox", "\(rid?["machine"] ?? "nil")")
        livePicture("native-machine-card-1440-dark.png")
        let n1 = hub.sent.count
        if let o = pn.shownCard?.opts["1"] { press(o) }
        let ansFile = rproj + "/ans.txt"
        rc("rc_remote_answer_lands", wait(12) { self.file(ansFile).contains("Launch") }, "\(file(ansFile)) \(hub.sent.dropFirst(n1).joined(separator: ","))")
        rc("rc_remote_answered_card", wait(8) { self.board.render(force: true); return self.shows(pn, "Answered") }, texts(pn).prefix(8).joined(separator: " | "))
        livePicture("native-machine-answered-1440-dark.png")
        // A kind this version does not know (SelfTestRemotePanel.swift).
        remotePanelEnd()
    }
}
