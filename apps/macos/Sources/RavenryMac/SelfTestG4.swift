// Group 4's self-tests (scripts/sidetest.mjs --screen settings, gallery,
// decisions): the Settings window's Hand-off tab against the demo hub's
// own /api/settings routes (read back from the hub, never from the
// window), the keyboard on the window's controls, the skills read again.

import AppKit

extension SelfTestBoard {
    /// GET from the hub, waited for (what the hub stored, not what the window shows).
    func hubGet(_ path: String) -> [String: Any] {
        var got: [String: Any]?
        board.hub.get(path) { _, j in got = j }
        _ = wait(5) { got != nil }
        return got ?? [:]
    }
    func hubHandoff() -> [String: Any] { hubGet("/api/settings/handoff")["settings"] as? [String: Any] ?? [:] }

    /// A key pressed on whatever has the window's keyboard.
    func keyIn(_ w: NSWindow, _ code: UInt16, _ chars: String = "", mods: NSEvent.ModifierFlags = []) {
        guard let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber,
                                       context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code) else { return }
        (w.firstResponder ?? w).keyDown(with: e)
        settle(0.2)
    }

    func screenSettingsHandoff() {
        let sw = board.settings
        let root = sw.window.contentView!
        func tap(_ v: NSView?) {
            if let c = v as? CheckRow { c.press() } else if let b = v as? TapBox { b.press() } else if let b = v as? NSButton { b.performClick(nil) } else { check("ho_control_missing", false) }
            settle(0.15)
        }
        func savedNow(_ k: String) -> Any? { hubHandoff()[k] }
        func num(_ k: String) -> Int { (savedNow(k) as? NSNumber)?.intValue ?? -1 }

        // The tab is in the window's list, in the shared file's order, and keeps the window's top.
        check("ho_tab_listed", sw.tabs.map { $0.0 } == ["appearance", "behavior", "handoff", "skills"] && sw.tabButtons["handoff"] != nil, sw.tabs.map { $0.0 }.joined(separator: ","))
        let top0 = sw.window.frame.maxY
        tap(sw.tabButtons["handoff"])
        check("ho_tab_opens", sw.tab == "handoff" && sw.window.title == t("set.handoff"), sw.tab)
        let before = hubHandoff()
        check("ho_reads_hub", wait(6) { sw.ho.cur != nil && sw.ho.line == (before["handoffThreshold"] as? NSNumber)?.intValue && sw.ho.window == (before["contextWindow"] as? NSNumber)?.intValue }
              && shows(root, t("ho.auto")) && shows(root, t("ho.line")) && shows(root, t("ho.ceiling")) && shows(root, t("ho.root")), "\(before) | " + texts(root).joined(separator: " | "))
        check("ho_window_top_kept", abs(sw.window.frame.maxY - top0) < 0.5, "\(top0) to \(sw.window.frame.maxY)")
        check("ho_values_drawn", (sw.controls["ho:t:value"] as? NSTextField)?.stringValue == "\(sw.ho.line)%" && (sw.controls["ho:c:value"] as? NSTextField)?.stringValue == "\(sw.ho.ceiling)%"
              && shows(root, t("ho.past", ["n": HandoffState.tok(Double(sw.ho.window) * Double(sw.ho.line) / 100), "of": HandoffState.tok(Double(sw.ho.window))])))
        _ = wait(4) { sw.ho.root != nil && sw.ho.assistant != nil }
        settle(0.3)
        settingsPictures("settings-handoff")

        // The line's plus: saved on the hub.
        let L0 = sw.ho.line, C0 = sw.ho.ceiling
        var s0 = board.hub.sent.count
        tap(sw.controls["ho:t:plus"])
        check("ho_line_plus_saved", wait(5) { num("handoffThreshold") == L0 + 5 } && sentSince(s0).contains("POST /api/settings/handoff") && wait(3) { sw.ho.foot == "saved" && self.shows(root, t("ho.saved")) },
              "\(num("handoffThreshold")) \(sentSince(s0))")
        // The ceiling's thumb dragged to 85; the line's dragged past it stops 5 below.
        (sw.controls["ho:track"] as? HandoffTrack)?.drag("c", toPercent: 85)
        check("ho_drag_ceiling_saved", wait(5) { num("handoffCeiling") == 85 } && (sw.controls["ho:c:value"] as? NSTextField)?.stringValue == "85%", "\(num("handoffCeiling"))")
        (sw.controls["ho:track"] as? HandoffTrack)?.drag("t", toPercent: 95)
        check("ho_drag_line_stops_below_ceiling", wait(5) { num("handoffThreshold") == 80 } && sw.ho.line == 80, "\(num("handoffThreshold"))")
        check("ho_gap_hint", shows(root, t("ho.gapHint", ["n": "5"])))
        // The keyboard: the thumb takes the arrows (the line down 5).
        if let tr = sw.controls["ho:track"] as? HandoffTrack {
            sw.window.makeFirstResponder(tr)
            keyIn(sw.window, 123)
            check("ho_arrow_moves_thumb", wait(5) { num("handoffThreshold") == 75 }, "\(num("handoffThreshold"))")
        }
        // The context window and a fresh session after.
        tap(sw.controls["ho:window:200k"])
        check("ho_window_saved", wait(5) { num("contextWindow") == 200000 } && wait(2) { self.shows(root, t("ho.past", ["n": "150k", "of": "200k"])) }, texts(root).filter { $0.contains("tokens") }.joined(separator: " | "))
        let fresh0 = sw.ho.fresh
        tap(sw.controls["ho:fresh"])
        check("ho_fresh_saved", wait(5) { savedNow("handoffAutoStart") as? Bool == !fresh0 })
        // Off: saved, the track and the steppers greyed and still, the words say Hand off now works.
        tap(sw.controls["ho:on"])
        check("ho_off_saved", wait(5) { savedNow("handoffEnabled") as? Bool == false } && wait(2) { self.shows(root, t("ho.offHint")) } && (sw.controls["ho:track"] as? HandoffTrack)?.enabled == false)
        let lOff = sw.ho.line
        tap(sw.controls["ho:t:plus"])
        settle(0.5)
        check("ho_off_steppers_still", sw.ho.line == lOff && num("handoffThreshold") == lOff)
        settingsPictures("settings-handoff-off")
        tap(sw.controls["ho:on"])
        check("ho_on_again", wait(5) { savedNow("handoffEnabled") as? Bool == true })
        // A refused save: the reason, and the control back to what is stored.
        board.hub.testPostAnswers["/api/settings/handoff"] = (400, ["error": "The ceiling must stay above the line"])
        let l1 = sw.ho.line
        tap(sw.controls["ho:t:minus"])
        check("ho_refused_said", wait(3) { sw.ho.foot == "error" } && shows(root, t("ho.notSaved", ["why": "The ceiling must stay above the line."])) && sw.ho.line == l1, texts(root).suffix(3).joined(separator: " | "))
        board.hub.testPostAnswers.removeValue(forKey: "/api/settings/handoff")
        // Changed elsewhere (the board, the phone): shown within the 3 s read.
        var done = false
        board.hub.post("/api/settings/handoff", ["handoffThreshold": 40]) { _, _ in done = true }
        _ = wait(5) { done }
        check("ho_change_elsewhere_shown", wait(6) { sw.ho.line == 40 && (sw.controls["ho:t:value"] as? NSTextField)?.stringValue == "40%" }, "\(sw.ho.line)")

        // New sessions: the assistant, the Codex model, the projects' folder.
        s0 = board.hub.sent.count
        tap(sw.controls["ho:as:codex"])
        check("ho_assistant_saved", wait(5) { self.hubGet("/api/settings/assistant")["startWith"] as? String == "codex" } && sentSince(s0).contains("POST /api/settings/assistant") && sw.controls["ho:as:codex"]?.accessibilityValue() as? Bool == true,
              "\(hubGet("/api/settings/assistant"))")
        settingsPictures("settings-handoff-codex", widths: false)
        tap(sw.controls["ho:as:claude"])
        _ = wait(5) { self.hubGet("/api/settings/assistant")["startWith"] as? String == "claude" }
        if let mf = sw.controls["ho:model"] as? ModelField {
            mf.field.stringValue = "gpt-test-1"
            mf.commit?("gpt-test-1")
            check("ho_codex_model_saved", wait(5) { self.hubGet("/api/settings/assistant")["codexModel"] as? String == "gpt-test-1" || sw.ho.foot == "saved-model" }, "\(hubGet("/api/settings/assistant"))")
            (sw.controls["ho:model"] as? ModelField)?.commit?("not a model!")
            check("ho_codex_model_refused_red", wait(5) { sw.ho.modelBad } && (sw.controls["ho:model"] as? ModelField)?.ring == "bad" && sw.ho.foot == "error", sw.ho.err)
            (sw.controls["ho:model"] as? ModelField)?.commit?("")
            _ = wait(5) { !sw.ho.modelBad }
        } else { check("ho_codex_model_field", false) }
        if let want = ProcessInfo.processInfo.environment["RAVENRY_SETTINGS_PROJECTS_ROOT"] {
            tap(sw.controls["ho:root:change"])
            let name = (want as NSString).lastPathComponent
            check("ho_root_saved", wait(6) { (self.hubGet("/api/settings/projects-root")["path"] as? String ?? "").hasSuffix(name) } && wait(3) { ((sw.controls["ho:root:path"] as? NSTextField)?.stringValue ?? "").hasSuffix(name) } && shows(root, t("ho.rootChosen")),
                  "\(hubGet("/api/settings/projects-root"))")
        } else { check("ho_root_env", false, "no RAVENRY_SETTINGS_PROJECTS_ROOT") }

        // The keyboard on every control: the tabs, the boxes and the segments are key views; Space presses; the arrows move a segment.
        sw.window.makeFirstResponder(sw.tabButtons["handoff"])
        var loop: [NSView] = []
        var v: NSView? = sw.window.firstResponder as? NSView
        while let x = v, loop.count < 60 { if loop.contains(where: { $0 === x }) { break }; loop.append(x); v = x.nextValidKeyView }
        let has = { (k: String) in loop.contains { $0 === sw.controls[k] } }
        check("ho_tab_key_loop", has("ho:on") && has("ho:track") && has("ho:fresh") && has("ho:window:200k") && loop.contains { $0 === sw.tabButtons["skills"] }, "\(loop.count) views")
        if let on = sw.controls["ho:on"] { sw.window.makeFirstResponder(on) }
        keyIn(sw.window, 49, " ")
        check("ho_space_presses_box", wait(5) { savedNow("handoffEnabled") as? Bool == false } && sw.window.firstResponder === sw.controls["ho:on"], "\(String(describing: sw.window.firstResponder))")
        keyIn(sw.window, 49, " ")
        _ = wait(5) { savedNow("handoffEnabled") as? Bool == true }
        if let w = sw.controls["ho:window:200k"] { sw.window.makeFirstResponder(w) }
        keyIn(sw.window, 124)
        check("ho_arrow_moves_segment", wait(5) { num("contextWindow") == 1000000 })
        if let b = sw.tabButtons["handoff"] { sw.window.makeFirstResponder(b) }
        keyIn(sw.window, 123)
        check("ho_arrow_moves_tab", sw.tab == "behavior" && sw.window.firstResponder === sw.tabButtons["behavior"], sw.tab)
        let sq = squeezed(root)
        check("ho_no_squeezed_text", sq.isEmpty, sq.joined(separator: " | "))
        // Learn's Try it starts what Start them with says, in the last folder used on this Mac.
        let start: [String: Any] = ["assistants": [["kind": "claude", "found": true], ["kind": "codex", "found": true]], "folders": [["path": "/f/first"]]]
        let st = HubState(["assistants": ["startWith": "codex"], "projects": [["id": "p1", "name": "p1", "folder": "/f/p1"], ["id": "p2", "name": "p2", "folder": "/f/p2", "machine": "devbox"]]])
        let c1 = LearnPage.tryChoice(start: start, state: st, lastProject: "p1"), c2 = LearnPage.tryChoice(start: start, state: HubState([:]), lastProject: "p2")
        let c3 = LearnPage.tryChoice(start: ["assistants": [["kind": "claude", "found": false], ["kind": "codex", "found": true]]], state: nil, lastProject: nil)
        check("learn_try_it_choice", c1?.kind == "codex" && c1?.folder == "/f/p1" && c2?.kind == "claude" && c2?.folder == "/f/first" && c3?.kind == "codex" && c3?.folder == NSHomeDirectory(),
              "\(String(describing: c1)) \(String(describing: c2)) \(String(describing: c3))")
        // Back as the demo had it.
        var put = false
        var back: [String: Any] = [:]
        for k in HandoffState.keys { back[k] = before[k] }
        board.hub.post("/api/settings/handoff", back) { _, _ in put = true }
        _ = wait(5) { put }
        _ = (L0, C0)
    }

    /// Skills: a setup made outside the window shows within the 3 s read; the rows say they are being read first.
    func screenSettingsSkillsFollow() {
        // Before the hub's first answer: being read, not "needs the board".
        let fresh = SettingsWindow(store: board.settings.store, hub: nil, offscreen: true)
        fresh.pick("skills")
        check("set_skills_reading_first", shows(fresh.window.contentView!, t("set.reading")) && !shows(fresh.window.contentView!, t("set.needsBoard")), texts(fresh.window.contentView!).joined(separator: " | "))
        fresh.window.close()
        let sw = board.settings
        let root = sw.window.contentView!
        guard let row = sw.skills.first(where: { $0["kind"] as? String == "claude" && $0["found"] as? Bool == true }) else { check("set_skills_follow_row", false, "\(sw.skills)"); return }
        let was = row["ours"] as? Bool ?? false
        let rd = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/ravenryd").path
        let body: [String: Any] = was ? ["kind": "claude", "on": false] : ["kind": "claude", "on": true, "ravenryd": rd, "version": "0.0.0"]
        var done = false
        board.hub.post("/api/setup/skills", body) { _, _ in done = true }
        _ = wait(5) { done }
        check("set_skills_follow_outside", wait(6) { (sw.skills.first { $0["kind"] as? String == "claude" }?["ours"] as? Bool ?? false) == !was }
              && shows(root, was ? t("set.notInstalled") : t("set.installed")), texts(root).joined(separator: " | "))
        done = false
        board.hub.post("/api/setup/skills", was ? ["kind": "claude", "on": true, "ravenryd": rd, "version": "0.0.0"] : ["kind": "claude", "on": false]) { _, _ in done = true }
        _ = wait(5) { done }
        _ = wait(6) { (sw.skills.first { $0["kind"] as? String == "claude" }?["ours"] as? Bool ?? false) == was }
        settle(0.3)
    }

    // MARK: the gallery: the grid by keyboard, the whole card, Ctrl and the wheel, Escape, pictures asked for as they scroll in

    func screenGalleryMore() {
        let g = board.gallery
        board.openGallery("garden-planner", at: nil)
        settle(0.5)
        check("gallery_grid_rings_first", g.at == nil && g.lit == 0 && g.cards.first?.lit == true, "lit \(String(describing: g.lit))")
        check("gallery_grid_takes_keys", wait(2) { self.window.firstResponder === g }, "\(String(describing: window.firstResponder))")
        check("gallery_grid_whole_picture", wait(5) { g.cards.allSatisfy { $0.image != nil } })
        pictures("gallery-ringed")
        // The caption is part of the button.
        if g.cards.count > 1 { click(g.cards[1].caption) }
        check("gallery_caption_opens", g.at == 1, "at \(String(describing: g.at))")
        // Escape in the viewer: back to the grid, ringed on the one it showed.
        window.makeFirstResponder(g)
        keyIn(window, 53)
        check("gallery_escape_to_grid", g.at == nil && g.lit == 1, "at \(String(describing: g.at)) lit \(String(describing: g.lit))")
        // The keyboard on the grid: the arrows move the ring, Return opens.
        window.makeFirstResponder(g)
        keyIn(window, 123)
        check("gallery_arrow_moves_ring", g.lit == 0 && g.cards[0].lit && !g.cards[1].lit)
        keyIn(window, 36, "\r")
        check("gallery_return_opens", g.at == 0)
        keyIn(window, 124)
        check("gallery_arrow_next_picture", g.at == 1)
        keyIn(window, 123)
        check("gallery_arrow_previous_picture", g.at == 0)
        // Ctrl and the wheel zooms around the pointer; Escape fits again, then goes back.
        let z = g.zoom
        _ = wait(5) { z.picture.image != nil }
        settle(0.3)
        let mid = NSPoint(x: z.bounds.midX, y: z.bounds.midY)
        if let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: 40, wheel2: 0, wheel3: 0) {
            cg.flags = .maskControl
            cg.location = CGPoint(x: 0, y: 0)
            if let e = NSEvent(cgEvent: cg) {
                // The pointer over the middle of the picture.
                let wp = z.convert(mid, to: nil)
                if let moved = NSEvent.mouseEvent(with: .mouseMoved, location: wp, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0) { _ = moved }
                z.scrollWheel(with: e)
            }
        }
        check("picture_ctrl_wheel_zooms", z.zoomed, "mag \(z.magnification) fit \(z.fit)")
        let plain = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: 40, wheel2: 0, wheel3: 0).flatMap { NSEvent(cgEvent: $0) }
        let m0 = z.magnification
        if let e = plain { z.scrollWheel(with: e) }
        check("picture_plain_wheel_scrolls", z.magnification == m0)
        window.makeFirstResponder(g)
        keyIn(window, 53)
        check("picture_escape_fits", !z.zoomed && g.at == 0)
        keyIn(window, 24, "+")
        check("picture_plus_zooms", z.zoomed)
        keyIn(window, 29, "0")
        check("picture_zero_fits", !z.zoomed)
        keyIn(window, 53)
        check("picture_escape_then_grid", g.at == nil && g.lit == 0)

        // Many pictures: asked for as their cards come into view, a spinner (never a black card) until each arrives.
        guard let p0 = board.hub.state?.project("garden-planner"), let first = GalleryPic.of(p0).first else { check("gallery_many_fixture", false); return }
        let many: [[String: Any]] = (0..<60).map { i in ["url": first.url + (first.url.contains("?") ? "&" : "?") + "n=\(i)", "name": "shot-\(i).png", "at": "2026-11-10T10:\(String(format: "%02d", i % 60)):00Z"] }
        let keepPatch = board.hub.testPatch
        board.hub.testPatch = { r in
            var r = keepPatch?(r) ?? r
            var ps = r["projects"] as? [[String: Any]] ?? []
            if let i = ps.firstIndex(where: { $0["id"] as? String == "garden-planner" }) {
                var b = ps[i]["brief"] as? [String: Any] ?? [:]
                b["gallery"] = many
                ps[i]["brief"] = b
                r["projects"] = ps
            }
            return r
        }
        let cps = board.hub.testCheckpoints; board.hub.testCheckpoints = cps
        let f0 = g.cache.fetched.count
        board.openGallery("garden-planner", at: nil)
        size(1280, 820)
        settle(1.5)
        let asked = g.cache.fetched.count - f0
        check("gallery_lazy_first_screen", g.cards.count == 60 && asked > 0 && asked <= 30, "\(asked) of 60 asked")
        check("gallery_lazy_placeholder_not_black", g.cards.allSatisfy { $0.image != nil || $0.loading || $0.failed } && g.cards.contains { $0.loading })
        pictures("gallery-many")
        if let last = g.cards.last { last.scrollToVisible(last.bounds) }
        settle(1.5)
        let lastURL = g.pics.last?.url ?? ""
        check("gallery_lazy_scroll_loads", g.cache.fetched.contains(lastURL) && wait(5) { g.cards.last?.image != nil }, "\(g.cache.fetched.count - f0) asked")
        board.hub.testPatch = keepPatch
        board.hub.testCheckpoints = board.hub.testCheckpoints
        settle(0.5)
    }

    // MARK: Decisions: the person's own, added, edited, removed

    func screenDecisionsMore() {
        let pg = board.decisions
        board.openDecisions()
        _ = wait(5) { pg.view != nil }
        func ledger(_ q: String) -> [[String: Any]] {
            let j = hubGet("/api/decisions?page=1&show=all&search=" + (q.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""))
            return (j["days"] as? [[String: Any]] ?? []).flatMap { $0["items"] as? [[String: Any]] ?? [] }
        }
        guard let add = pg.buttons["add"] else { check("dec_add_button", false); return }
        add.performClick(nil)
        settle(0.3)
        check("dec_add_opens_card", pg.editing == "new" && pg.fields["ed:quote"] != nil && shows(pg, t("dec.addTitle")), texts(pg).prefix(8).joined(separator: " | "))
        // Save with nothing written: said, nothing sent.
        var s0 = board.hub.sent.count
        pg.buttons["save"]?.performClick(nil)
        check("dec_add_needs_words", !sentSince(s0).contains("POST /api/decisions/add") && pg.editing == "new")
        pg.fields["ed:quote"]?.text = "Seed trays stay on the south window until May."
        pg.fields["ed:scope"]?.text = "seed trays"
        if let i = pg.editMenu.items.firstIndex(where: { $0.title == "garden-planner" }) { pg.editMenu.performActionForItem(at: i) }
        check("dec_add_project_picked", pg.editProject == "garden-planner")
        settle(0.2)
        pictures("decisions-add")
        s0 = board.hub.sent.count
        pg.buttons["save"]?.performClick(nil)
        check("dec_add_saved_on_hub", wait(6) { ledger("south window").first.map { $0["project"] as? String == "garden-planner" && $0["scope"] as? String == "seed trays" && $0["by"] as? String == "person" } ?? false }
              && sentSince(s0).contains("POST /api/decisions/add"), "\(ledger("south window"))")
        check("dec_add_shown", wait(6) { pg.editing == nil && self.shows(pg, "Seed trays stay on the south window until May.") && self.shows(pg, t("dec.youAdded")) }, texts(pg).prefix(12).joined(separator: " | "))
        guard let id = ledger("south window").first?["id"] as? String else { check("dec_add_id", false); return }
        // Edit: the same card in its place, only what changed sent.
        _ = wait(5) { pg.buttons["edit:\(id)"] != nil }
        pg.buttons["edit:\(id)"]?.performClick(nil)
        settle(0.3)
        check("dec_edit_opens_in_place", pg.editing == id && pg.fields["ed:quote"]?.text == "Seed trays stay on the south window until May." && pg.editProject == "garden-planner")
        pg.fields["ed:quote"]?.text = "Seed trays stay on the south window until mid-May."
        pg.editMenu.performActionForItem(at: 0)
        s0 = board.hub.sent.count
        pg.buttons["save"]?.performClick(nil)
        let body = board.hub.sentBodies.last { $0.path == "/api/decisions/edit" }?.body ?? [:]
        check("dec_edit_saved_on_hub", wait(6) { ledger("mid-May").first.map { ($0["id"] as? String == id) && ($0["project"] is NSNull || $0["project"] == nil) } ?? false }
              && body["scope"] == nil && body["quote"] as? String == "Seed trays stay on the south window until mid-May.", "\(body) \(ledger("mid-May"))")
        check("dec_edit_shown", wait(6) { pg.editing == nil && self.shows(pg, "until mid-May.") })
        // Remove (a decision that replaced another, past its minute): asked on the card first; Keep it
        // leaves it; Remove takes it off the ledger and the one it replaced holds again.
        let all = ledger("")
        guard let r = all.first(where: { !($0["gone"] as? Bool ?? false) && !($0["replaces"] as? [[String: Any]] ?? []).isEmpty && $0["undo_until"] == nil }),
              let rid = r["id"] as? String, let oldId = (r["replaces"] as? [[String: Any]])?.first?["id"] as? String else { check("dec_remove_fixture", false, "\(all)"); return }
        let rq = r["quote"] as? String ?? ""
        _ = wait(5) { pg.buttons["remove:\(rid)"] != nil }
        s0 = board.hub.sent.count
        pg.buttons["remove:\(rid)"]?.performClick(nil)
        settle(0.2)
        check("dec_remove_asks_first", pg.removing == rid && shows(pg, t("dec.removeAskBack")) && !sentSince(s0).contains("POST /api/decisions/remove"), texts(pg).prefix(14).joined(separator: " | "))
        pictures("decisions-remove-ask")
        pg.buttons["keep:\(rid)"]?.performClick(nil)
        check("dec_remove_keep", pg.removing == nil && ledger("").contains { $0["id"] as? String == rid })
        pg.buttons["remove:\(rid)"]?.performClick(nil)
        pg.buttons["confirm:\(rid)"]?.performClick(nil)
        check("dec_remove_done", wait(6) { !ledger("").contains { $0["id"] as? String == rid } && !self.shows(pg, rq) } && sentSince(s0).contains("POST /api/decisions/remove"))
        check("dec_remove_old_holds_again", ledger("").first { $0["id"] as? String == oldId }.map { !($0["gone"] as? Bool ?? true) } ?? false)
    }

    // MARK: Machines: a card's head and facts wrap instead of squeezing

    func screenMachinesWrap() {
        let pg = board.machines
        var bad: [String] = [], wrapped = 0, rows = 0
        for (w, h) in [(CGFloat(900), CGFloat(760)), (720, 700)] {
            size(w, h)
            settle(0.5)
            board.render(force: true)
            settle(0.4)
            func walk(_ v: NSView) {
                if let f = v as? FlowRow, !f.isHiddenOrHasHiddenAncestor {
                    rows += 1
                    let fr = f.subviews.map { $0.frame }
                    if fr.contains(where: { $0.maxX > f.bounds.width + 0.5 || $0.minX < -0.5 }) { bad.append("out \(Int(w))") }
                    for i in fr.indices { for j in fr.indices where j > i && fr[i].insetBy(dx: 1, dy: 1).intersects(fr[j].insetBy(dx: 1, dy: 1)) { bad.append("overlap \(Int(w))") } }
                    if Set(fr.map { Int($0.minY) }).count > 1 && f.subviews.count > 1 { wrapped += 1 }
                }
                v.subviews.forEach(walk)
            }
            walk(pg)
            let sq = squeezed(window.contentView!)
            if !sq.isEmpty { bad.append("squeezed \(Int(w)): " + sq.prefix(2).joined(separator: ",")) }
            if w == 720 { picture("native-machines-720-dark.png") }
        }
        check("machines_head_wraps", rows > 0 && bad.isEmpty && wrapped > 0, "\(rows) rows, \(wrapped) wrapped, \(bad.prefix(4))")
        size(1280, 820)
        settle(0.4)
    }
}

