// The panel's cards on real checkpoints, in the cards' and machines' round
// (scripts/machinetest.mjs, --screen remote, called from screenRemote): agents
// in the test daemon's shells ask, propose a command, ask for a secret, show a
// pick and type into another pane; each check presses the card as the person
// would and reads the effect where it lands (the file the approved command or
// the secret's program wrote, what the asking command printed, the pane that
// was typed into, the daemon's own record of the checkpoint, the tab in front).
//
// - PANEL-017: an approve from a pane says it runs "A new one, beside <pane>";
//   Run runs it, and (PANEL-024) its finished card's Show in the terminal
//   brings the run's pane to the front.
// - PANEL-019: a secret of two lines or over 4 KiB is never sent; 4 KiB is.
// - PANEL-021: a drive says what it would press, in order; Allow once types it,
//   For this session lets the next one through without asking, Refuse with
//   "Or tell X something else" gives the agent the words.
// - PANEL-025: a card's head says how long it waits, its foot Gives up at
//   HH:MM (the agent's timeout) and On your phone too with phone alerts on.
// - PANEL-026: a kind this version does not know is said, Refuse only, and
//   Refuse declines it in the daemon.
// - PANEL-030: a pick answered, the agent's files deleted: the pick opened
//   again (Open side by side) still draws its pictures, from the hub's copies.
//   Its card leaves the panel once answered, as in the Electron app. Its B
//   is an HTML page, drawn as a picture by the hub (variants/1?as=png).

import AppKit

extension SelfTestBoard {
    private var rpEnv: [String: Any] {
        guard let s = ProcessInfo.processInfo.environment["RAVENRY_MAC_REMOTE"], let j = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any] else { return [:] }
        return j
    }

    private func pc(_ name: String, _ ok: Bool, _ detail: String = "") {
        NSLog("remote check %@ %@ %@", ok ? "pass" : "FAIL", name, String(detail.prefix(700)))
        check(name, ok, detail)
    }

    private func fileText(_ path: String) -> String { (try? String(contentsOfFile: path, encoding: .utf8)) ?? "" }

    private func typeLine(_ pane: String, _ text: String) {
        board.ws.conn(of: pane).request("pane.send", ["pane": pane, "input": [["text": text, "mode": "paste"], ["key": "Enter"]]])
    }

    /// This test's ravenry, as an agent runs it (never the person's daemon: the test's runtime folder).
    private func ravenry(_ args: [String]) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: Bundle.main.bundlePath + "/Contents/MacOS/ravenryd")
        p.arguments = args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = out
        try? p.run()
        let d = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(decoding: d, as: UTF8.self)
    }

    /// A button's own click, or a press and release at a view's middle (as screenRemote's press).
    private func pressIt(_ v: NSView) {
        window.contentView?.layoutSubtreeIfNeeded()
        v.scrollToVisible(v.bounds)
        if let b = v as? NSButton { b.performClick(nil); settle(0.3); return }
        let p = v.convert(NSPoint(x: v.bounds.midX, y: v.bounds.midY), to: nil)
        let now = ProcessInfo.processInfo.systemUptime
        for (type, at) in [(NSEvent.EventType.leftMouseDown, now), (.leftMouseUp, now + 0.05)] {
            if let e = NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: at, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) { window.sendEvent(e) }
        }
        settle(0.3)
    }

    /// The open checkpoint whose title starts with `title`, as the hub or this window's daemon lists it.
    private func cpTitled(_ title: String) -> [String: Any]? {
        (board.hub.checkpoints ?? []).last { ($0["title"] as? String ?? "").hasPrefix(title) || ($0["command"] as? String ?? "").contains(title) }
    }

    /// The card of the checkpoint titled so, in front: its pane's tab shown, else the checkpoint on its own.
    private func cardFor(_ title: String, _ timeout: TimeInterval = 12) -> CheckpointCard? {
        let pn = board.panel
        _ = wait(timeout) {
            guard let c = self.cpTitled(title), let id = c["id"] as? String else { return false }
            if pn.shownCard?.id == id { return true }
            if let p = c["pane"] as? String, let tb = self.board.ws.tab(showing: p) { self.board.ws.show(tb) } else { self.board.showCheckpoint(id) }
            self.board.render(force: true)
            return pn.shownCard?.id == id
        }
        guard let c = cpTitled(title), pn.shownCard?.id == c["id"] as? String else { return nil }
        return pn.shownCard
    }

    private func cardText(_ c: CheckpointCard?) -> String { c.map { texts($0).joined(separator: " | ") } ?? "no card" }

    /// The daemon's own record of a checkpoint (`ravenry checkpoint ID`).
    private func daemonSays(_ id: String) -> String { ravenry(["checkpoint", id, "--json"]) }

    /// Keys through the window to what has the keyboard, as the person types (letters, digits, space, Enter, - and .).
    private func typeKeys(_ s: String) {
        var codes: [String: UInt16] = [:]
        for (k, name) in KeyCodes.table {
            if name.hasPrefix("Key") { codes[name.dropFirst(3).lowercased()] = k }
            if name.hasPrefix("Digit") { codes[String(name.dropFirst(5))] = k }
        }
        codes[" "] = 0x31; codes["\r"] = 0x24; codes["."] = 0x2F; codes["-"] = 0x1B
        for ch in s {
            let c = String(ch)
            guard let code = codes[c] else { continue }
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                if let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                            context: nil, characters: c, charactersIgnoringModifiers: c, isARepeat: false, keyCode: code) { window.sendEvent(e) }
            }
        }
        settle(0.2)
    }

    /// A new shell tab, in front: its pane.
    private func freshTab() -> String? {
        let ws = board.ws, n = ws.tabs.count
        ws.newTab(nil)
        guard wait(5, { ws.tabs.count > n }), let t = ws.active else { return nil }
        settle(0.8)
        return t.host
    }

    func remotePanel(shell: String, other: String) {
        let ws = board.ws, hub = board.hub, pn = board.panel
        let out = rpEnv["out"] as? String ?? dir.path
        let bin = Bundle.main.bundlePath + "/Contents/MacOS/ravenryd"
        let q = { (s: String) in "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

        // MARK: PANEL-025, a card's timing (asked first: its "waiting 2 min" is read at the end)
        guard let third = freshTab(), let thirdTab = ws.tab(showing: third) else { pc("pc_third_tab", false); return }
        let asked = Date()
        typeLine(third, "\(q(bin)) ask 'Lower the mast for the night?' --option 'Lower it' --option 'Leave it up' --timeout 10m > \(q(out + "/timing.out")) 2>&1 &")
        let tc = cardFor("Lower the mast")
        let tcp = cpTitled("Lower the mast")
        let exp = When.date(tcp?["expires_at"] as? String)
        let hm = exp.map { let c = Calendar.current.dateComponents([.hour, .minute], from: $0); return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0) } ?? "none"
        pc("pc_timing_gives_up_at", tc != nil && exp.map { abs($0.timeIntervalSince(asked) - 600) < 20 } == true && shows(tc!, "Gives up at \(hm)"), "\(hm) expires \(tcp?["expires_at"] ?? "nil") | \(cardText(tc))")
        let alerts = hub.state?.raw["alerts"] as? [String: Any] ?? [:]
        pc("pc_timing_phone_too", tc.map { shows($0, "On your phone too") } == true && alerts["enabled"] as? Bool == true && alerts["configured"] as? Bool == true, "alerts \(alerts) | \(cardText(tc))")
        pc("pc_timing_just_now", tc.map { shows($0, "just now") } == true, cardText(tc))

        // MARK: PANEL-017 and PANEL-024: an approve beside its pane, run, Show in the terminal
        guard let ap = freshTab(), let apTab = ws.tab(showing: ap) else { pc("pc_approve_tab", false); return }
        let ranFile = out + "/beside.txt"
        typeLine(ap, "\(q(bin)) approve --why 'The hull is dry.' -- /bin/sh -c \(q("echo beside-ran | tee " + q(ranFile) + "; sleep 8")) > \(q(out + "/approve.out")) 2>&1 &")
        let ac = cardFor("beside-ran")
        pc("pc_approve_beside_pane", ac?.kind == "approve" && ac.map { shows($0, "A new one, beside ") } == true, cardText(ac))
        let apId = ac?.id ?? ""
        if let b = ac?.buttons["run"] { pressIt(b) }
        pc("pc_approve_run_ran", wait(12) { self.fileText(ranFile).contains("beside-ran") }, "\(daemonSays(apId).prefix(300))")
        let runPane = { () -> String? in
            let c = (hub.checkpoints ?? []).first { $0["id"] as? String == apId }
            return (c?["run"] as? [String: Any])?["pane"] as? String ?? ((c?["words"] as? [String: Any])?["after"] as? [String: Any])?["runPane"] as? String
        }
        // The keyboard back in the asking pane, the run's beside it: Show in the terminal gives it to the run's.
        _ = ws.tab(showing: ap)
        ws.show(apTab)
        _ = wait(6) { self.board.render(force: true); return pn.shownCard?.id == apId && pn.shownCard?.buttons["showRun"] != nil }
        let afterCard = pn.shownCard
        let cpNow = (hub.checkpoints ?? []).first { $0["id"] as? String == apId }
        pc("pc_run_card_show_in_terminal", afterCard?.buttons["showRun"] != nil && runPane() != nil,
           "run pane \(runPane() ?? "nil") known \(runPane().map { ws.paneInfo($0) != nil } ?? false) machine \(String(describing: cpNow?["machine"])) state \(cpNow?["state"] ?? "") | \(cardText(afterCard))")
        board.render(force: true)
        settle(0.4)
        picture("native-cards-run-show-1440-dark.png")
        let before = ws.active?.focusedPane ?? ""
        if let b = afterCard?.buttons["showRun"] { pressIt(b) }
        pc("pc_show_in_terminal_fronts_run", before == ap && wait(6) { runPane().map { rp in ws.active?.focusedPane == rp && (ws.active?.host == rp || ws.active?.guest == rp) } ?? false },
           "before \(before) now \(ws.active?.focusedPane ?? "nil") (host \(ws.active?.host ?? "nil") guest \(ws.active?.guest ?? "none")) run \(runPane() ?? "nil")")
        // The run ended: its pane closes in the window, the card says it ran, and Show in the terminal brings the ended pane back with what it printed.
        let ranCard = { () -> CheckpointCard? in pn.shownCard?.id == apId ? pn.shownCard : nil }
        ws.show(apTab)
        _ = wait(20) { self.board.render(force: true); return ranCard().map { self.shows($0, "Ran on") } == true && ws.active?.guest != runPane() }
        pc("pc_ran_card_show_in_terminal", ranCard()?.buttons["showRun"] != nil && ws.tabs.allSatisfy { $0.host != runPane() && $0.guest != runPane() },
           "\(cardText(ranCard()).prefix(200)) | tabs \(ws.tabs.map { "\($0.host)/\($0.guest ?? "-")" })")
        board.render(force: true); settle(0.3)
        picture("native-cards-ran-show-1440-dark.png")
        if let b = ranCard()?.buttons["showRun"] { pressIt(b) }
        pc("pc_ran_pane_shown_after_end", wait(8) { runPane().map { rp in ws.active?.host == rp || ws.active?.guest == rp } ?? false }
           && wait(8) { (ws.focusedView?.screen.text() ?? "").contains("beside-ran") },
           "active \(ws.active?.host ?? "nil") run \(runPane() ?? "nil") known \(runPane().map { ws.paneInfo($0) != nil } ?? false) daemon: \(ravenry(["ls"]).suffix(400))")
        board.render(force: true); settle(0.3)
        picture("native-cards-ran-pane-1440-dark.png")

        // MARK: PANEL-019: a secret of two lines, or over 4 KiB, is never sent; 4 KiB is
        guard let se = freshTab() else { pc("pc_secret_tab", false); return }
        let secFile = out + "/secret.txt"
        typeLine(se, "\(q(bin)) secret 'Paste the long harbour key' --env HARBOUR_KEY -- /bin/sh -c \(q("printf %s \"$HARBOUR_KEY\" > " + q(secFile))) > \(q(out + "/secret.out")) 2>&1 &")
        let sc0 = cardFor("Paste the long harbour key")
        // The card in the panel now (it is built again when what it shows changes).
        var sc: CheckpointCard? { pn.shownCard?.id == sc0?.id ? pn.shownCard : sc0 }
        var typedCount = -1
        let typeSecret = { (s: String) in
            guard let box = sc?.secret else { return }
            defer { typedCount = box.characters }
            // The keyboard out (a secret's field empties when it leaves) and back in, then typed.
            self.window.makeFirstResponder(nil)
            self.settle(0.1)
            self.window.makeFirstResponder(box.field)
            box.field.currentEditor()?.insertText(s)
            self.settle(0.2)
        }
        let sentAfter = { (n: Int) in hub.sentBodies.dropFirst(n).contains { $0.path.contains("checkpoint") && $0.path.contains("answer") } }
        var n = hub.sentBodies.count
        typeSecret("north_key\nsouth_key")
        let twoLines = sc?.secret?.field.stringValue ?? ""
        sc?.buttons["secretSend"].map { pressIt($0) }
        settle(0.5)
        let sentTwo = sentAfter(n)
        n = hub.sentBodies.count
        typeSecret(String(repeating: "k", count: 4097))
        let over = typedCount
        sc?.buttons["secretSend"].map { pressIt($0) }
        settle(0.5)
        pc("pc_secret_over_4k_not_sent", sc != nil && !sentAfter(n) && fileText(secFile).isEmpty && over == 4097, "\(over) characters typed, sent \(sentAfter(n))")
        // Typed into the field, a line break ends the edit (and a secret is cleared when its field loses the keyboard);
        // held in the field as a paste leaves it, it is said to be one line and never sent.
        let typedTwo = sc != nil && !sentTwo && fileText(secFile).isEmpty
        n = hub.sentBodies.count
        if let box = sc?.secret { window.makeFirstResponder(box.field); box.field.stringValue = "north_key\nsouth_key" }
        let held = sc?.secret?.field.stringValue ?? ""
        let heldProblem = sc?.secret?.problem
        sc?.sendSecret()
        settle(0.5)
        pc("pc_secret_two_lines_not_sent", typedTwo && held.contains("\n") && heldProblem == t("checkpoint.secretOneLine") && !sentAfter(n) && fileText(secFile).isEmpty,
           "typed: \(twoLines.count) characters kept; held \(held.count) characters, problem \(heldProblem ?? "none"); sent \(sentAfter(n))")
        n = hub.sentBodies.count
        typeSecret(String(repeating: "k", count: 4096))
        sc?.buttons["secretSend"].map { pressIt($0) }
        pc("pc_secret_4k_sent", wait(10) { self.fileText(secFile).count == 4096 }, "file \(fileText(secFile).count) bytes; field \(sc?.secret?.characters ?? -1) problem \(sc?.secret?.problem ?? "none"); sent \(sentAfter(n)); \(cardText(sc).prefix(200))")

        // MARK: PANEL-021: a drive, its keys in order; Allow once, Or tell it something else, For this session
        // The other tab's shell reports as a Claude session, so it may be let in for its session.
        typeLine(other, "printf '%s' '{\"hook_event_name\":\"SessionStart\",\"session_id\":\"d1d1d1d1-0000-4000-8000-0000000000d1\",\"cwd\":\"/tmp\",\"source\":\"startup\"}' | \(q(bin)) hook --assistant claude >/dev/null 2>&1")
        settle(1)
        let once = out + "/drive-once.txt", sess = out + "/drive-session.txt", free = out + "/drive-free.txt"
        let driveCard = { () -> CheckpointCard? in
            _ = self.wait(12) {
                guard let d = (hub.checkpoints ?? []).first(where: { $0["kind"] as? String == "drive" && DaemonCheckpoints.isOpen($0) }), let did = d["id"] as? String else { return false }
                if pn.shownCard?.id == did { return true }
                if let p = d["pane"] as? String, let tb = ws.tab(showing: p) { ws.show(tb) } else { self.board.showCheckpoint(did) }
                self.board.render(force: true)
                return pn.shownCard?.id == did
            }
            guard let open = (hub.checkpoints ?? []).first(where: { $0["kind"] as? String == "drive" && DaemonCheckpoints.isOpen($0) }) else { return nil }
            return pn.shownCard?.id == open["id"] as? String ? pn.shownCard : nil
        }
        typeLine(other, "\(q(bin)) send \(shell) --paste \(q("echo drive-once > " + q(once))) --key Enter --reason 'To mark the hull dry' > \(q(out + "/drive1.out")) 2>&1 &")
        let d1 = driveCard()
        // The keys after the text, in order: the text, then Enter's chip (an attachment drawn as a key).
        let keysRow = d1.map { texts($0).first { $0.contains("drive-once") } ?? "" } ?? ""
        pc("pc_drive_would_press_in_order", d1.map { shows($0, "It would press, in order") } == true && keysRow.hasPrefix("echo drive-once") && keysRow.trimmingCharacters(in: .whitespaces).hasSuffix("\u{FFFC}"), keysRow)
        pc("pc_drive_reason_said", d1.map { shows($0, "To mark the hull dry") } == true, cardText(d1))
        pc("pc_drive_three_answers", d1?.opts["1"] != nil && d1?.opts["2"] != nil && d1?.opts["3"] != nil, d1.map { $0.opts.map { "\($0.key)=\($0.value.text)" }.sorted().joined(separator: ", ") } ?? "")
        board.render(force: true)
        settle(0.3)
        picture("native-cards-drive-keys-1440-dark.png")
        if let o = d1?.opts["1"] { pressIt(o) }
        pc("pc_drive_allow_once_types", wait(10) { self.fileText(once).contains("drive-once") }, "\(fileText(out + "/drive1.out").prefix(200))")
        // Once is once: the next asks again, and is refused with words for it.
        let told = out + "/drive-told.out"
        typeLine(other, "\(q(bin)) send \(shell) --paste 'echo never' --key Enter > \(q(told)) 2>&1; echo EXIT $? >> \(q(told))")
        let d4 = driveCard()
        if let f = d4?.sendField {
            window.makeFirstResponder(f.field)
            f.field.currentEditor()?.insertText("Leave the hull, it is still wet")
            settle(0.2)
            f.go.performClick(nil)
        }
        pc("pc_drive_tell_else_reaches_agent", d4 != nil && wait(10) { self.fileText(told).contains("Leave the hull, it is still wet") && self.fileText(told).contains("EXIT") }, "\(cardText(d4).prefix(120)) || \(fileText(told).prefix(300))")
        typeLine(other, "\(q(bin)) send \(shell) --paste \(q("echo drive-session > " + q(sess))) --key Enter > \(q(out + "/drive2.out")) 2>&1 &")
        let d2 = driveCard()
        if let o = d2?.opts["2"] { pressIt(o) }
        pc("pc_drive_allow_session_types", wait(10) { self.fileText(sess).contains("drive-session") }, "\(cardText(d2).prefix(300))")
        typeLine(other, "\(q(bin)) send \(shell) --paste \(q("echo drive-free > " + q(free))) --key Enter > \(q(out + "/drive3.out")) 2>&1 &")
        let freeLanded = wait(8) { self.fileText(free).contains("drive-free") }
        pc("pc_drive_session_needs_no_ask", freeLanded && !(hub.checkpoints ?? []).contains { $0["kind"] as? String == "drive" && DaemonCheckpoints.isOpen($0) }, "landed \(freeLanded)")

        // MARK: PANEL-011: Typed here on the shell the agents typed into: who, the filter, the whole log, "While <who> had it"
        typeLine(other, "\(q(bin)) lease \(shell) --ttl 60s > \(q(out + "/lease.out")) 2>&1 &")
        let leased = wait(10) { ws.paneInfo(shell)?.lease != nil }
        // The person types into the shell through the window (render.input, logged as the person), while the agent holds it.
        if let t = ws.tab(showing: shell) { ws.show(t) }
        board.toTerminal()
        settle(0.5)
        if let v = ws.focusedView { window.makeFirstResponder(v) }
        for line in ["echo one", "echo two", "echo while-lent"] { typeKeys(line + "\r"); settle(0.4) }
        settle(1)
        let typedTexts = { () -> String in self.board.render(force: true); return self.texts(pn).joined(separator: " | ") }
        pc("pc_typed_while_had_it", leased && wait(10) { typedTexts().contains("echo while-lent") && typedTexts().contains("While Claude had it") }, "leased \(leased) | \(typedTexts().suffix(400))")
        let pick = { (i: Int) in
            guard let seg = pn.typedFilter else { return }
            seg.selectedSegment = i
            _ = seg.sendAction(seg.action, to: seg.target)
            self.settle(0.3)
        }
        pick(1)
        pc("pc_typed_filter_agents", wait(4) { typedTexts().contains("echo drive-free") && !typedTexts().contains("echo while-lent") } && pn.typedFilter?.selectedSegment == 1, typedTexts().suffix(300).description)
        pick(2)
        pc("pc_typed_filter_you", wait(4) { typedTexts().contains("echo while-lent") && !typedTexts().contains("drive-free") } && pn.typedFilter?.selectedSegment == 2, typedTexts().suffix(300).description)
        board.render(force: true); settle(0.3)
        picture("native-panel-typed-you-1440-dark.png")
        pick(0)
        // The records shown: each starts with its time (HH:MM) in the Typed here section.
        let records = { () -> Int in self.board.render(force: true); return self.texts(pn).filter { $0.range(of: "^\\d\\d:\\d\\d$", options: .regularExpression) != nil }.count }
        let few = records()
        if let b = pn.buttons["typedWhole"] { pressIt(b) }
        let whole = records()
        pc("pc_typed_whole_log", whole > few && pn.buttons["typedWhole"]?.title == t("panel.typedFew"), "\(few) then \(whole) | \(pn.buttons["typedWhole"]?.title ?? "none")")
        if let b = pn.buttons["typedWhole"] { pressIt(b) }
        pc("pc_typed_show_last_few", wait(4) { records() == few } && pn.buttons["typedWhole"]?.title == t("panel.typedWhole"), "\(records()) | \(pn.buttons["typedWhole"]?.title ?? "none")")
        typeLine(other, "\(q(bin)) lease \(shell) --release > /dev/null 2>&1")

        // MARK: PANEL-030: a pick answered, the agent's pictures deleted, the closed card still shows the one picked
        guard let pkPane = freshTab(), let pkTab = ws.tab(showing: pkPane) else { pc("pc_pick_tab", false); return }
        // B is an HTML page: the hub draws it to a picture for this app (GET .../variants/1?as=png), which draws no web page.
        let picA = out + "/sail-a.png", picB = out + "/sail-b.html"
        try? "<!doctype html><html><body style=\"margin:0;background:#2659e6\"><h1 style=\"color:#fff;font:40px sans-serif;padding:40px\">Blue sail</h1></body></html>".write(toFile: picB, atomically: true, encoding: .utf8)
        for (f, c) in [(picA, NSColor(srgbRed: 0.85, green: 0.2, blue: 0.2, alpha: 1))] {
            let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 160, pixelsHigh: 100, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            c.setFill(); NSRect(x: 0, y: 0, width: 160, height: 100).fill()
            NSGraphicsContext.restoreGraphicsState()
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: f))
        }
        // AGENT-026: an image, an .html page and a shot of a pane (pane:ID), one described in the agent's words.
        typeLine(pkPane, "\(q(bin)) pick 'Which sail colour?' --variant \(q("Red sail=" + picA)) --variant \(q("Blue sail=" + picB)) --variant \(q("The pane=pane:" + pkPane)) --describe \(q("Blue sail=Drawn from a page by the board")) > \(q(out + "/pick.out")) 2>&1 &")
        let pkc = cardFor("Which sail colour?")
        let pkId = pkc?.id ?? ""
        pc("pc_pick_html_variant_drawn", wait(20) { pkc?.tiles.count == 3 && pkc?.tiles.allSatisfy { $0.image != nil } == true }, "tiles \(pkc?.tiles.map { $0.image != nil } ?? [])")
        board.render(force: true)
        settle(0.3)
        picture("native-cards-pick-html-1440-dark.png")
        let pk = board.picker
        if let c = pkc { c.numberKey("2") }
        pc("pc_pick_three_kinds_drawn", wait(8) { pk.images.count == 3 && pk.images.allSatisfy { $0.image != nil } } && shows(pk, "The pane") && shows(pk, "Drawn from a page by the board"),
           "images \(pk.images.map { $0.image != nil }) | \(texts(pk).prefix(14).joined(separator: " | "))")
        pk.buttons["pick2"].map { pressIt($0) }
        // A ring dragged on B, as a mouse does, then its note: the label, the region and the note printed for the agent.
        pk.buttons["circle"].map { pressIt($0) }
        if pk.images.count > 1 {
            let im = pk.images[1]
            window.contentView?.layoutSubtreeIfNeeded()
            let at = { (x: CGFloat, y: CGFloat) in im.convert(NSPoint(x: im.bounds.width * x, y: im.bounds.height * y), to: nil) }
            for (type, p) in [(NSEvent.EventType.leftMouseDown, at(0.3, 0.3)), (.leftMouseDragged, at(0.5, 0.5)), (.leftMouseUp, at(0.6, 0.7))] {
                guard let e = NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else { continue }
                switch type {
                case .leftMouseDown: im.mouseDown(with: e)
                case .leftMouseDragged: im.mouseDragged(with: e)
                default: im.mouseUp(with: e)
                }
            }
            settle(0.3)
        }
        let ringed = pk.picked == 1 && pk.region.map { abs($0.minX - 0.3) < 0.01 && abs($0.width - 0.3) < 0.01 && abs($0.height - 0.4) < 0.01 } == true
        if let r = pk.region { pk.circle(1, r, note: "This blue, a little darker") }
        pk.buttons["send"].map { pressIt($0) }
        pc("pc_pick_answered", wait(10) { self.fileText(out + "/pick.out").contains("Blue sail") }, fileText(out + "/pick.out").prefix(200).description)
        pc("pc_pick_printed_label_region_note", ringed && wait(5) { let o = self.fileText(out + "/pick.out"); return o.contains("Blue sail\nregion 0.3000 0.3000 0.3000 0.4000\nnote This blue, a little darker") },
           "ringed \(ringed) \(String(describing: pk.region)) | \(fileText(out + "/pick.out").prefix(300))")
        try? FileManager.default.removeItem(atPath: picA)
        try? FileManager.default.removeItem(atPath: picB)
        // Its card leaves the panel once answered (a pick has nothing more to say there, as in the Electron app).
        board.toTerminal()
        ws.show(pkTab)
        board.render(force: true)
        settle(0.5)
        pc("pc_pick_card_leaves_panel", pn.shownCard?.id != pkId, "card \(pn.shownCard?.id ?? "none")")
        // Open side by side again (the card's Open, the board's openPicker): the pictures, from the hub's copies, the agent's files gone.
        board.openPicker(pkId)
        let blueAt = { (im: NSImage?) -> Bool in
            guard let tiff = im?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let c = rep.colorAt(x: rep.pixelsWide / 2, y: rep.pixelsHigh / 2)?.usingColorSpace(.sRGB) else { return false }
            return c.blueComponent > 0.6 && c.redComponent < 0.4
        }
        pc("pc_pick_closed_still_shows_pictures", !pkId.isEmpty && !FileManager.default.fileExists(atPath: picB) && wait(4) { self.board.root.middle === pk }
           && wait(8) { pk.images.count == 3 && pk.images.allSatisfy { $0.image != nil } } && blueAt(pk.images[1].image) && pk.buttons["send"]?.isEnabled == false,
           "\(board.front) images \(pk.images.map { $0.image != nil }) blue \(pk.images.count > 1 ? blueAt(pk.images[1].image) : false)")
        board.render(force: true)
        settle(0.4)
        picture("native-cards-pick-closed-1440-dark.png")
        board.toTerminal()

        // MARK: PANEL-025 again: two minutes on, the head says so
        ws.show(thirdTab)
        let left = 125 - Date().timeIntervalSince(asked)
        if left > 0 { settle(left) }
        let tc2 = cardFor("Lower the mast")
        board.render(force: true)
        settle(0.3)
        pc("pc_timing_waiting_2_min", tc2.map { shows($0, "waiting 2 min") } == true, cardText(tc2))
        picture("native-cards-timing-1440-dark.png")
        if let o = tc2?.opts["1"] { pressIt(o) }
        _ = wait(6) { self.fileText(out + "/timing.out").contains("Lower it") }
        if let t = ws.tab(showing: shell) { ws.show(t) }
    }

    /// On testbox, after the machine's checks: PANEL-026, a kind this version does not know; PANEL-027, the daemon that asked gone.
    func remotePanelEnd() {
        let hub = board.hub, pn = board.panel
        // The testbox session in front (MACH-005 left it there), picked again for PANEL-027.
        let boxKey: String? = { if case .session(let k) = board.front { return k }; return hub.state?.project("remote-lab")?.sessions.first.map { "remote-lab/\($0.surfaceId)" } }()
        let rd = rpEnv["rd"] as? String ?? "", renv = rpEnv["env"] as? [String: String] ?? [:]
        let onBox = { (args: [String]) -> String in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: rd)
            p.arguments = [args[0], "--no-start"] + args.dropFirst()
            p.environment = renv
            let o = Pipe()
            p.standardOutput = o; p.standardError = o
            try? p.run()
            let d = o.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            return String(decoding: d, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let showLoose = { (id: String) -> CheckpointCard? in
            _ = self.wait(12) {
                guard (hub.checkpoints ?? []).contains(where: { $0["id"] as? String == id }) else { return false }
                if pn.shownCard?.id != id { self.board.showCheckpoint(id) }
                self.board.render(force: true)
                return pn.shownCard?.id == id
            }
            return pn.shownCard?.id == id ? pn.shownCard : nil
        }

        // MARK: PANEL-026: a newer kind, as a newer ravenryd would send it (the daemon here makes only the kinds it knows,
        // so a real ask on testbox reaches the app as kind "future"): said, Refuse only, and Refuse declines it there.
        hub.testPatch = { r in
            var r = r
            r["checkpoints"] = (r["checkpoints"] as? [[String: Any]] ?? []).map { c in
                guard c["title"] as? String == "Raise the new kite sail?" else { return c }
                // As the hub words a kind it does not know (cpwords.mjs withWords on kind "future"): kind other, "The agent is waiting".
                var x = c; x["kind"] = "future"; x["options"] = nil
                var w = x["words"] as? [String: Any] ?? [:]
                w["kind"] = "other"; w["heading"] = "The agent is waiting"; w["top"] = "The agent is waiting"
                x["words"] = w
                return x
            }
            return r
        }
        let fid = onBox(["ask", "Raise the new kite sail?", "--option", "Yes", "--no-wait"]).components(separatedBy: "\n").last ?? ""
        let fc = showLoose(fid)
        pc("pc_unknown_kind_said", fc?.kind == "other" && (hub.checkpoints ?? []).contains { $0["id"] as? String == fid && $0["kind"] as? String == "future" } && fc.map { shows($0, "This version of Ravenry does not know this kind of question. You can only refuse it.") } == true
           && fc?.buttons["refuse"] != nil && fc?.opts.isEmpty == true, "id \(fid) | \(cardText(fc)) | buttons \(fc?.buttons.keys.sorted() ?? [])")
        board.render(force: true)
        settle(0.3)
        picture("native-cards-unknown-1440-dark.png")
        if let b = fc?.buttons["refuse"] { pressIt(b) }
        _ = wait(3) { pn.shownCard?.reasonField != nil }
        if let f = pn.shownCard?.reasonField { f.send() }
        pc("pc_unknown_kind_refused", wait(10) { onBox(["checkpoint", fid, "--json"]).contains("\"declined\"") }, onBox(["checkpoint", fid, "--json"]).prefix(300).description)
        hub.testPatch = nil

        // MARK: PANEL-027: the daemon that asked goes away before an answer. The hub keeps the card closed as lost
        // (checkpoints.mjs dropDaemon), so its card says why it can no longer be answered instead of vanishing.
        let lid = onBox(["ask", "Haul the boat out?", "--option", "Haul it", "--no-wait"]).components(separatedBy: "\n").last ?? ""
        let lc = showLoose(lid)
        let lostCard = { () -> CheckpointCard? in pn.shownCard?.id == lid ? pn.shownCard : nil }
        pc("pc_lost_card_open", lc?.kind == "ask" && lc?.opts["1"] != nil, "\(lid) | \(texts(pn).prefix(8).joined(separator: " | "))")
        for d in (try? JSONSerialization.jsonObject(with: Data(onBox(["daemons", "--json"]).utf8)) as? [[String: Any]]) ?? [] {
            if let pid = d["pid"] as? Int { kill(pid_t(pid), SIGKILL) }
        }
        pc("pc_lost_card_says_why", wait(20) { self.board.render(force: true); if lostCard() == nil { self.board.showCheckpoint(lid) }; return lostCard().map { self.shows($0, "Not reachable") && self.shows($0, "ravenryd on testbox is not reachable any more") && $0.opts.isEmpty } ?? false },
           "\(lid) | \(texts(pn).prefix(10).joined(separator: " | ")) | cps \((hub.checkpoints ?? []).map { "\($0["id"] ?? "")/\($0["state"] ?? "")" })")
        var got: (Int, String) = (0, "")
        hub.post("/api/checkpoints/answer", ["id": lid, "choice": 0, "by": "desktop"]) { code, j in got = (code, j["error"] as? String ?? "") }
        pc("pc_lost_answer_refused_said", wait(5) { got.0 != 0 } && got.0 == 409 && got.1.contains("not reachable"), "\(got)")
        picture("native-cards-lost-1440-dark.png")
    }
}
