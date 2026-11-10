// The checkpoint cards' self-test (sidetest.mjs --screen cards): one open
// checkpoint of each kind with the hub's words (cards-fixture.mjs, read
// from RAVENRY_MAC_CARDS), each on a session of the demo hub. Each check
// presses the card as the person would (a number key, a button, typing in
// its field) and reads the answer the window posted (its body; a secret
// only as its length). The demo hub does not hold these checkpoints, so
// each answer comes back refused and the card says so.

import AppKit

extension SelfTestBoard {
    private var card: CheckpointCard? { board.panel.shownCard }
    private func lastAnswer(after n: Int) -> [String: Any]? {
        board.hub.sentBodies.dropFirst(n).last { $0.path == "/api/checkpoints/answer" }?.body
    }
    private func answered(_ n: Int) -> Bool { wait(4) { self.lastAnswer(after: n) != nil } && wait(4) { self.card?.buttons.values.allSatisfy { $0.isEnabled } ?? true } }
    private func json(_ d: [String: Any]?) -> String {
        guard let d, let j = try? JSONSerialization.data(withJSONObject: d, options: [.sortedKeys]) else { return "nil" }
        return String(decoding: j, as: UTF8.self)
    }
    private func keyDown(_ v: NSView, _ chars: String, code: UInt16 = 0, mods: NSEvent.ModifierFlags = []) {
        // A field already being typed in keeps its edit (focusing it again would end it).
        if (v as? NSTextField)?.currentEditor() == nil { window.makeFirstResponder(v) }
        if let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                    context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code) { window.sendEvent(e) }
        settle(0.2)
    }
    private func type(_ f: NSTextField, _ s: String) {
        if f.currentEditor() == nil { window.makeFirstResponder(f) }
        f.currentEditor()?.insertText(s)
        settle(0.1)
    }

    /// The card's pictures at 1280 (docked) and 900 (over the terminal), dark and light.
    private func cardPictures(_ name: String, _ key: String) {
        for (w, h) in [(CGFloat(1280), CGFloat(820)), (900, 760)] {
            size(w, h)
            board.pickSession(key, why: "test")
            for dark in [true, false] {
                NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                settle(0.3)
                board.render(force: true)
                settle(0.4)
                picture("native-\(name)-\(Int(w))-\(dark ? "dark" : "light").png")
                let sq = squeezed(window.contentView!)
                check("\(name)_no_squeezed_text_\(Int(w))_\(dark ? "dark" : "light")", sq.isEmpty, sq.prefix(4).joined(separator: " | "))
            }
        }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        size(1280, 820)
        board.pickSession(key, why: "test")
        settle(0.3)
    }

    func screenCards() {
        guard let fx = ProcessInfo.processInfo.environment["RAVENRY_MAC_CARDS"], let d = try? Data(contentsOf: URL(fileURLWithPath: fx)),
              let cps = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] else { check("cards_fixture", false, "no RAVENRY_MAC_CARDS"); return }
        board.hub.testCheckpoints = cps
        settle(0.5)
        let keyOf = { (kind: String) -> String in
            let c = cps.first { $0["kind"] as? String == kind } ?? [:]
            return "\(c["projectId"] as? String ?? "")/\(c["surfaceId"] as? String ?? "")"
        }

        // Ask: one answer per line with its number key, or your own words.
        board.pickSession(keyOf("ask"), why: "test")
        check("ask_card_shown", wait(4) { self.card?.kind == "ask" }, board.panel.key)
        check("ask_checked_decisions", card?.checked != nil && card.map { self.shows($0, "Checked your decisions first") && self.shows($0, "\"Test on the pond before the bath\" today") && self.shows($0, "\"The hull stays level on every slope under 10...\"") } ?? false,
              card.map { texts($0).joined(separator: " | ") } ?? "")
        check("ask_options_with_keys", card?.opts.count == 3 && card?.opts["2"]?.text == "Keep it level", card?.opts.keys.sorted().joined(separator: ",") ?? "")
        var n = board.hub.sentBodies.count
        if let c = card { keyDown(c, "2") }
        check("ask_number_key_answers", answered(n) && (lastAnswer(after: n)?["choice"] as? Int) == 1 && lastAnswer(after: n)?["by"] as? String == "desktop", json(lastAnswer(after: n)))
        check("ask_refused_answer_said", wait(4) { self.card.map { self.shows($0, "did not take the answer") } ?? false })
        n = board.hub.sentBodies.count
        card?.opts["3"]?.press()
        check("ask_option_click_answers", answered(n) && (lastAnswer(after: n)?["choice"] as? Int) == 2, json(lastAnswer(after: n)))
        n = board.hub.sentBodies.count
        if let c = card { keyDown(c, "7") }
        settle(0.3)
        check("ask_key_past_options_ignored", lastAnswer(after: n) == nil)
        n = board.hub.sentBodies.count
        if let c = card { keyDown(c, "1", mods: .command) }
        check("ask_cmd_number_not_an_answer", lastAnswer(after: n) == nil)
        if let f = card?.sendField { type(f.field, "Tilt it, but only half the slope"); f.send() }
        check("ask_own_words_sent", answered(n) && lastAnswer(after: n)?["text"] as? String == "Tilt it, but only half the slope", json(lastAnswer(after: n)))
        cardPictures("cards-ask", keyOf("ask"))

        // Approve: the command, its folder, machine and pane, the warnings, Run, Edit, Refuse.
        board.pickSession(keyOf("approve"), why: "test")
        check("approve_card_shown", wait(4) { self.card?.kind == "approve" })
        check("approve_details", card.map { shows($0, "npm publish --tag beta") && shows($0, "This Mac") && shows($0, "A new one") && shows($0, "NOTES_CHANNEL") && shows($0, "Claude warns:") && shows($0, "Claude says:") } ?? false,
              card.map { texts($0).joined(separator: " | ") } ?? "")
        check("approve_buttons", card.map { $0.buttons["run"] != nil && $0.buttons["edit"] != nil && $0.buttons["refuse"] != nil } ?? false, card?.buttons.keys.sorted().joined(separator: ",") ?? "")
        cardPictures("cards-approve", keyOf("approve"))
        n = board.hub.sentBodies.count
        card?.buttons["run"]?.performClick(nil)
        check("approve_run_posts", answered(n) && lastAnswer(after: n)?["approve"] as? Bool == true && lastAnswer(after: n)?["command"] == nil, json(lastAnswer(after: n)))
        card?.buttons["edit"]?.performClick(nil)
        check("approve_edit_opens_editor", wait(3) { self.card?.editor != nil && self.card?.editor?.string == "npm publish --tag beta" && self.window.firstResponder === self.card?.editor }, "\(String(describing: window.firstResponder))")
        if let e = card?.editor {
            e.setSelectedRange(NSRange(location: e.string.utf16.count, length: 0))
            e.insertText(" --dry-run", replacementRange: e.selectedRange())
            settle(0.2)
        }
        let tinted = card?.editor?.textStorage.map { ts -> Bool in
            var r = NSRange(); let c = ts.attribute(.backgroundColor, at: 23, effectiveRange: &r) as? NSColor
            return c != nil && r.location == 22 && r.length == 10
        } ?? false
        check("approve_edit_tints_change", tinted)
        if let e = card?.editor { e.setSelectedRange(NSRange(location: 0, length: e.string.utf16.count)); e.insertText("git push --force origin main", replacementRange: e.selectedRange()); settle(0.2) }
        check("approve_edit_guess_for_edit", card.map { shows($0, "Ravenry's guess:") } ?? false, card.map { texts($0).filter { $0.contains("guess") || $0.contains("warns") }.joined(separator: "|") } ?? "")
        if let e = card?.editor { e.setSelectedRange(NSRange(location: 0, length: e.string.utf16.count)); e.insertText("npm publish --tag beta --dry-run", replacementRange: e.selectedRange()); settle(0.2) }
        n = board.hub.sentBodies.count
        if let e = card?.editor { keyDown(e, "\r", code: 36, mods: .command) }
        check("approve_cmd_enter_runs_edited", answered(n) && lastAnswer(after: n)?["command"] as? String == "npm publish --tag beta --dry-run" && lastAnswer(after: n)?["approve"] as? Bool == true, json(lastAnswer(after: n)))
        check("approve_edit_kept_after_refusal", card?.editor?.string == "npm publish --tag beta --dry-run")
        cardPictures("cards-edit", keyOf("approve"))
        if let e = card?.editor { keyDown(e, "\u{1b}", code: 53) }
        check("approve_escape_ends_edit", wait(3) { self.card?.editor == nil && self.card?.buttons["edit"] != nil })
        card?.buttons["refuse"]?.performClick(nil)
        check("approve_refuse_asks_why", wait(3) { self.card?.reasonField != nil } && card.map { shows($0, "is told you said no") } ?? false)
        n = board.hub.sentBodies.count
        if let f = card?.reasonField { type(f.field, "Wait for the release notes"); f.send() }
        check("approve_refuse_with_reason", answered(n) && lastAnswer(after: n)?["decline"] as? Bool == true && lastAnswer(after: n)?["reason"] as? String == "Wait for the release notes", json(lastAnswer(after: n)))
        n = board.hub.sentBodies.count
        if let f = card?.reasonField { f.field.stringValue = ""; f.send() }
        check("approve_refuse_without_reason", answered(n) && lastAnswer(after: n)?["decline"] as? Bool == true && lastAnswer(after: n)?["reason"] == nil, json(lastAnswer(after: n)))
        card?.buttons["back"]?.performClick(nil)
        check("approve_refuse_back", wait(3) { self.card?.reasonField == nil && self.card?.buttons["run"] != nil })

        // Secret: typed into the card's field, never kept; sent only when it can be one.
        board.pickSession(keyOf("secret"), why: "test")
        check("secret_card_shown", wait(4) { self.card?.kind == "secret" } && card.map { shows($0, "npx wrangler secret put TILES_TOKEN") && shows($0, "as $TILES_TOKEN") && shows($0, "Not kept in logs") } ?? false,
              card.map { texts($0).joined(separator: " | ") } ?? "")
        settle(0.6)
        check("secret_field_secure", card?.secret?.field is NSSecureTextField && card?.secret?.field.placeholderAttributedString?.string == "Paste or type the token")
        n = board.hub.sentBodies.count
        if let s = card?.secret { type(s.field, "abc"); card?.sendSecret() }
        settle(0.3)
        check("secret_too_short_not_sent", lastAnswer(after: n) == nil && card?.secret?.characters == 3, "\(card?.secret?.characters ?? -1) \(String(describing: window.firstResponder)) \(json(lastAnswer(after: n)))")
        if let s = card?.secret { s.field.currentEditor()?.insertText("_tiles_9f8e7d") ; settle(0.1) }
        check("secret_counts_characters", card?.secret?.count.stringValue == "16 characters", card?.secret?.count.stringValue ?? "")
        cardPictures("cards-secret", keyOf("secret"))
        if let s = card?.secret { type(s.field, "abc_tiles_9f8e7d") }
        card?.secret?.eye.performClick(nil)
        check("secret_show_keeps_text", card?.secret?.reveal == true && card?.secret?.field.stringValue == "abc_tiles_9f8e7d" && card?.secret?.secure.stringValue == "", card?.secret?.field.stringValue ?? "")
        card?.secret?.eye.performClick(nil)
        check("secret_hide_keeps_text", card?.secret?.reveal == false && card?.secret?.field.stringValue == "abc_tiles_9f8e7d")
        n = board.hub.sentBodies.count
        card?.buttons["secretSend"]?.performClick(nil)
        check("secret_sent_and_field_empty", answered(n) && lastAnswer(after: n)?["secret"] as? String == "(16 characters)" && (card?.secret?.field.stringValue ?? "") == "", json(lastAnswer(after: n)))
        if let s = card?.secret { type(s.field, "left_behind_123") }
        window.makeFirstResponder(nil)
        settle(0.2)
        check("secret_cleared_on_blur", (card?.secret?.field.stringValue ?? "x") == "" && card?.secret?.count.stringValue == "")
        n = board.hub.sentBodies.count
        if let s = card?.secret { type(s.field, "typed_then_enter") ; keyDown(s.field, "\r", code: 36) }
        check("secret_enter_sends", answered(n) && lastAnswer(after: n)?["secret"] as? String == "(16 characters)", json(lastAnswer(after: n)))
        n = board.hub.sentBodies.count
        card?.buttons["notNow"]?.performClick(nil)
        check("secret_not_now_declines", answered(n) && lastAnswer(after: n)?["decline"] as? Bool == true && lastAnswer(after: n)?["secret"] == nil, json(lastAnswer(after: n)))

        // Pick: the pictures small, Open side by side (or 1 to 3), then the pick in the middle.
        board.pickSession(keyOf("pick"), why: "test")
        check("pick_card_shown", wait(4) { self.card?.kind == "pick" } && card?.tiles.count == 3 && card.map { shows($0, "or press 1, 2, 3") } ?? false)
        check("pick_card_pictures", wait(6) { self.card?.tiles.allSatisfy { $0.image != nil } ?? false })
        cardPictures("cards-pick", keyOf("pick"))
        if let c = card { keyDown(c, "2") }
        let pk = board.picker
        check("pick_key_opens_picker", wait(3) { if case .page(let k, _) = self.board.front { return k.hasPrefix("pick:") } else { return false } } && board.root.middle === pk && board.root.wideMiddle,
              "\(board.front)")
        check("pick_picker_pictures", wait(6) { pk.images.count == 3 && pk.images.allSatisfy { $0.image != nil } })
        check("pick_send_waits_for_pick", pk.buttons["send"]?.isEnabled == false && pk.buttons["send"]?.title == "Pick one first")
        keyDown(pk, "2")
        check("pick_number_key_picks", pk.picked == 1 && pk.buttons["send"]?.title == "Send B" && pk.buttons["pick2"]?.title == "Picked")
        pk.buttons["pick3"]?.performClick(nil)
        check("pick_button_picks", pk.picked == 2 && pk.buttons["send"]?.title == "Send C")
        pk.buttons["circle"]?.performClick(nil)
        check("pick_circle_mode", pk.circling && pk.images.allSatisfy { $0.drawing } && pk.buttons["circle"]?.title == "Drag on a picture")
        // A drag on picture B draws the ring, picks it, and asks for the note.
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
        check("pick_drag_rings_and_picks", pk.picked == 1 && pk.region.map { abs($0.minX - 0.3) < 0.01 && abs($0.width - 0.3) < 0.01 && abs($0.height - 0.4) < 0.01 } == true && !pk.circling, "\(String(describing: pk.region))")
        pk.circle(1, NSRect(x: 0.3, y: 0.3, width: 0.3, height: 0.4), note: "Keep this bow, but rounder")
        check("pick_note_counts", pk.buttons["send"]?.title == "Send B, with 1 note")
        pk.extra.stringValue = "Make it from the blue paper"
        n = board.hub.sentBodies.count
        pictures("cards-picker")
        board.openPicker(cps.first { $0["kind"] as? String == "pick" }?["id"] as? String ?? "")
        pk.buttons["send"]?.performClick(nil)
        let pb = lastAnswer(after: n)?["pick"] as? [String: Any]
        check("pick_send_posts_pick", wait(4) { self.lastAnswer(after: n) != nil } && (lastAnswer(after: n)?["pick"] as? [String: Any])?["label"] as? String == "V hull"
              && json(pb?["region"] as? [String: Any]) == "{\"h\":0.4,\"w\":0.3,\"x\":0.3,\"y\":0.3}" && (pb?["note"] as? String) == "Keep this bow, but rounder\n\nMake it from the blue paper", json(lastAnswer(after: n)))
        check("pick_refused_said", wait(4) { pk.error != nil && !pk.busy }, pk.error ?? "")
        n = board.hub.sentBodies.count
        pk.buttons["none"]?.performClick(nil)
        check("pick_none_declines", wait(4) { self.lastAnswer(after: n) != nil } && lastAnswer(after: n)?["decline"] as? Bool == true && lastAnswer(after: n)?["reason"] as? String == "Make it from the blue paper", json(lastAnswer(after: n)))
        _ = wait(4) { !pk.busy }
        keyDown(pk, "\u{1b}", code: 53)
        check("pick_escape_closes", wait(3) { self.board.front == .session(keyOf("pick")) || self.board.front == .tab }, "\(board.front)")
        board.panel.shownCard?.buttons["openPicker"]?.performClick(nil)
        check("pick_open_button", wait(3) { self.board.root.middle === pk && !pk.isHidden }, "\(board.front)")
        pk.buttons["close"]?.performClick(nil)
        check("pick_close_button", wait(3) { if case .page = self.board.front { return false }; return true }, "\(board.front)")
        board.hub.testCheckpoints = nil
    }
}
