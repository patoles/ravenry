// The audit's unproven rows, driven on a demo hub that really holds what
// they act on (scripts/sidetest.mjs --screen proofs, then --screen proofs2
// on the same hub and daemon, a relaunch). Each check presses the real
// control and reads the effect where it lands: the hub's answer to the
// POST, the file written, the hub's state, the fake cmux's typed text.
//
//   PANEL-006  the panel's hand-off: its text from the hub's timeline and
//              "Read by this session" from the hub's handoffRecent
//   ONB-003    the pick hint under the picker's title, its x, the mark
//   ONB-006    (proofs2) after a relaunch no hint comes back
//   PAGE-003   a page item's file changed under the screen: the button
//              posts the old hash, the hub's 409 is said, the page reads
//              again, a second press lands
//   PAGE-010   Rules: a repeated ask (seeded as a model run leaves it) made
//              a rule, and rules from project memory saved, on real ids
//   PLAN-004   Stop while the plan drafts; a draft started in a session at
//              its prompt
//
// RAVENRY_MAC_PROOFS names a JSON file with the demo's paths (sidetest.mjs).

import AppKit

extension SelfTestBoard {
    private var proofsEnv: [String: String] {
        guard let p = ProcessInfo.processInfo.environment["RAVENRY_MAC_PROOFS"], let d = FileManager.default.contents(atPath: p),
              let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: String] else { return [:] }
        return j
    }
    private func readFile(_ p: String) -> String { (try? String(contentsOfFile: p, encoding: .utf8)) ?? "" }
    /// The hub's answer to the first POST of `path` sent at or after `seq` (its status, 0 for none), waited for.
    private func hubCode(_ path: String, after seq: Int, _ t: Double = 10) -> Int {
        var c = 0
        _ = wait(t) { if let a = self.board.hub.answers.first(where: { $0.seq >= seq && $0.path == path }) { c = a.code; return true }; return false }
        return c
    }
    private func hintIn(_ v: NSView, _ id: String) -> NSView? {
        if v.identifier?.rawValue == "hint-\(id)", !v.isHiddenOrHasHiddenAncestor { return v }
        for x in v.subviews { if let f = hintIn(x, id) { return f } }
        return nil
    }
    private func pickFixture() -> [String: Any]? {
        guard let fx = ProcessInfo.processInfo.environment["RAVENRY_MAC_CARDS"], let d = FileManager.default.contents(atPath: fx),
              let cps = (try? JSONSerialization.jsonObject(with: d)) as? [[String: Any]] else { return nil }
        board.hub.testCheckpoints = cps
        return cps.first { $0["kind"] as? String == "pick" }
    }
    private func buttonIn(_ v: NSView, label: String) -> NSButton? {
        if let b = v as? NSButton, b.accessibilityLabel() == label { return b }
        for x in v.subviews { if let f = buttonIn(x, label: label) { return f } }
        return nil
    }

    func screenProofs() {
        let e = proofsEnv
        let hub = board.hub
        size(1280, 820)

        // MARK: PANEL-006: the hand-off and "Read by this session", from the hub
        let hp = e["handoffProject"] ?? ""
        _ = wait(15) { (hub.state?.project(hp)?.raw["handoffRecent"] as? [String: Any]) != nil }
        if let p = hub.state?.project(hp), let s = p.sessions.first {
            let ho = p.timeline.first { $0["from"] as? String == "brief" }
            board.pickSession("\(p.id)/\(s.surfaceId)", why: "test")
            if !board.panelVisible { board.togglePanel() }
            settle(0.6)
            let words = (ho?["text"] as? String ?? "").prefix(40)
            check("panel_handoff_text_from_hub", !words.isEmpty && shows(board.panel, String(words)) && shows(board.panel, t("panel.handOff")),
                  "timeline: \(words); panel: \(texts(board.panel).filter { $0.contains(t("panel.handOff")) || $0.contains(String(words.prefix(12))) }.prefix(3))")
            check("panel_handoff_read_by_session", shows(board.panel, t("panel.readBySession")),
                  "hub handoffRecent \(String(describing: (p.raw["handoffRecent"] as? [String: Any])?["resumedAt"] ?? "none"))")
            pictures("proofs-handoff")
        } else { check("panel_handoff_project", false, "no project \(hp) with a session") }

        // MARK: ONB-003: the pick hint, its x, the hub's mark
        let hintsLoaded = wait(10) { Hints.shared.loaded }
        // The sidebar's needs-you hint goes first (one at a time), as the person would dismiss it.
        if Hints.shared.current == "needs-you" || !Hints.shared.done.contains("needs-you") { Hints.shared.dismiss("needs-you") }
        settle(0.4)
        guard let pick = pickFixture(), let pid = pick["id"] as? String else { check("onb_pick_fixture", false); finishProofs(); return }
        settle(0.5)
        board.openPicker(pid)
        let pk = board.picker
        settle(0.6)
        let hint = hintIn(pk, "pick")
        check("onb_pick_hint_shown", hintsLoaded && hint != nil && hint.map { shows($0, t("hint.pickB")) && shows($0, t("hint.learnMore")) } == true,
              "loaded \(Hints.shared.loaded) done \(Hints.shared.done.sorted()) current \(Hints.shared.current ?? "-")")
        if hint != nil { picture("native-proofs-pick-hint-1280.png") }
        let seq = hub.sent.count
        if let h = hint, let x = buttonIn(h, label: t("hint.dismiss")) { x.performClick(nil) }
        let code = hubCode("/api/onboarding", after: seq)
        let body = hub.sentBodies.dropFirst(seq).first { $0.path == "/api/onboarding" }?.body
        check("onb_pick_hint_dismissed_marked", hintIn(pk, "pick") == nil && (200..<300).contains(code) && ((body?["hints"] as? [String: Any])?["pick"] as? Bool) == true,
              "hub \(code) body \(body.map { "\($0)" } ?? "none")")
        var marks: [String: Any] = [:]
        var got = false
        hub.get("/api/onboarding") { c, j in if c == 200 { marks = j["hints"] as? [String: Any] ?? [:] }; got = true }
        check("onb_pick_hint_on_hub", wait(5) { got } && marks["pick"] as? Bool == true, "\(marks)")
        pk.buttons["close"]?.performClick(nil)
        settle(0.3)
        board.openPicker(pid)
        settle(0.6)
        check("onb_pick_hint_once", hintIn(board.picker, "pick") == nil)
        board.picker.buttons["close"]?.performClick(nil)
        board.hub.testCheckpoints = nil
        settle(0.3)

        // MARK: PAGE-003: changed under the screen
        let fp = board.files
        let bugFile = e["bugFile"] ?? ""
        let opened = { (key: String) -> Bool in
            self.board.openPage(key, self.board.hub.state?.pages.first { $0.key == key }?.label ?? key)
            return self.wait(10) { fp.key == key && fp.view?["key"] as? String == key && self.board.root.middle === fp }
        }
        _ = wait(15) { hub.state?.pages.contains { $0.key == "bugs" } == true }
        let pageOpen = opened("bugs")
        _ = wait(5) { fp.pb["item:dock-clip.md:Mark fixed"] != nil }
        check("page_drawn_with_item", pageOpen && fp.pb["item:dock-clip.md:Mark fixed"] != nil, fp.pb.keys.filter { $0.hasPrefix("item:") }.sorted().prefix(6).joined(separator: ","))
        // Someone (an agent, an editor) changes the item's status under the screen.
        let was = readFile(bugFile)
        try? was.replacingOccurrences(of: "status: new", with: "status: fixing").write(toFile: bugFile, atomically: true, encoding: .utf8)
        let L = board.log.count
        var s2 = hub.sent.count
        (fp.pb["item:dock-clip.md:Mark fixed"] as? NSButton)?.performClick(nil)
        let c409 = hubCode("/api/pages/item/set", after: s2)
        let said = wait(5) { self.toasts(since: L).contains { $0.contains("It changed since you saw it") } }
        check("page_changed_since_said", c409 == 409 && said && readFile(bugFile).contains("status: fixing"),
              "hub \(c409); toasts \(toasts(since: L)); file \(readFile(bugFile).contains("status: fixing") ? "kept fixing" : "changed")")
        // The page read the item again: its new status, and a press now lands.
        let rowStatus = { () -> String? in
            for s in ((fp.view?["drawn"] as? [String: Any])?["sections"] as? [[String: Any]]) ?? [] {
                for r in s["rows"] as? [[String: Any]] ?? [] where r["file"] as? String == "dock-clip.md" { return r["status"] as? String }
            }
            return nil
        }
        check("page_read_again_after_conflict", wait(8) { rowStatus() == "fixing" }, "status drawn \(rowStatus() ?? "none")")
        _ = wait(10) { fp.pending == 0 }
        settle(0.4)
        s2 = hub.sent.count
        (fp.pb["item:dock-clip.md:Mark fixed"] as? NSButton)?.performClick(nil)
        let c200 = hubCode("/api/pages/item/set", after: s2)
        check("page_second_press_lands", c200 == 200 && wait(5) { self.readFile(bugFile).contains("status: fixed") }, "hub \(c200); file status \(readFile(bugFile).components(separatedBy: "\n").first { $0.hasPrefix("status:") } ?? "-")")

        // MARK: PAGE-010: a repeated ask made a rule, rules from project memory saved (real ids)
        let global = e["globalClaudeMd"] ?? ""
        let rulesOpen = opened("rules")
        if let tab = fp.pb["tab:1"] as? NSButton { tab.performClick(nil) } else if let tab = fp.pb["tab:1"] as? PressBox { tab.onPress?() }
        let suggested = wait(15) { fp.drawnTab == 1 && fp.pb["item:use-pnpm:Add rule"] != nil }
        check("rules_repeat_row_from_hub", rulesOpen && suggested && shows(fp, "Use pnpm, not npm"), fp.pb.keys.filter { $0.hasPrefix("item:") || $0.hasPrefix("mem:") }.sorted().joined(separator: ","))
        twoPicturesProofs("proofs-rules")
        (fp.pb["item:use-pnpm:Add rule"] as? NSButton)?.performClick(nil)
        let sheet = wait(3) { fp.sheetKind == "rule" }
        s2 = hub.sent.count
        (fp.pb["sheet:ok"] as? NSButton)?.performClick(nil)
        let cr = hubCode("/api/repeats/use-pnpm", after: s2)
        check("rules_repeat_saved_in_claude_md", sheet && cr == 200 && wait(5) { self.readFile(global).contains("Use pnpm, not npm") }, "sheet \(sheet) hub \(cr); \(global): \(readFile(global).suffix(120))")
        _ = wait(10) { fp.pending == 0 }
        // Rules from project memory: Every project, and the project only.
        let memGlobal = e["memGlobal"] ?? "", memLocal = e["memLocal"] ?? ""
        _ = wait(10) { fp.pb["mem:\(memGlobal):global"] != nil && fp.pb["mem:\(memLocal):local"] != nil }
        s2 = hub.sent.count
        (fp.pb["mem:\(memGlobal):global"] as? NSButton)?.performClick(nil)
        let cg = hubCode("/api/rules/\(memGlobal)", after: s2)
        check("rules_memory_every_project_written", cg == 200 && wait(5) { self.readFile(global).contains("Keep commit titles under 60 characters") }, "hub \(cg)")
        _ = wait(10) { fp.pb["mem:\(memLocal):local"] != nil && fp.pending == 0 }
        s2 = hub.sent.count
        (fp.pb["mem:\(memLocal):local"] as? NSButton)?.performClick(nil)
        let cl = hubCode("/api/rules/\(memLocal)", after: s2)
        let projectMd = e["projectClaudeMd"] ?? ""
        check("rules_memory_this_project_written", cl == 200 && wait(5) { self.readFile(projectMd).contains("Tilt the hull, never the deck") } && !readFile(global).contains("Tilt the hull, never the deck"),
              "hub \(cl); \(projectMd): \(readFile(projectMd).suffix(120))")

        // MARK: PLAN-004: Stop while it drafts, then a draft started
        let pg = board.plan
        let planPid = e["planProject"] ?? "paper-boat"
        board.openNewPlan(planPid)
        _ = wait(5) { pg.draftFor == planPid && pg.fields["goal"] != nil }
        if let f = pg.fields["goal"] { typeIn(f, "Make the boat tilt with the street") }
        s2 = hub.sent.count
        pg.buttons["draft"]?.performClick(nil)
        let cd = hubCode("/api/plan/draft", after: s2)
        let drafting = wait(8) { pg.buttons["stop"]?.window != nil && pg.buttons["stop"]?.isEnabled == true }
        check("plan_drafting_shows_stop", cd == 200 && drafting, "hub \(cd); \(texts(pg).prefix(6).joined(separator: " | "))")
        s2 = hub.sent.count
        pg.buttons["stop"]?.performClick(nil)
        let ch = hubCode("/api/plan/halt", after: s2)
        // Stopped at the hub: not busy, and the stub's draft (5 s) never lands.
        var hubDraft: [String: Any]? = nil
        let readDraft = { () -> Bool in
            var done = false
            hub.get("/api/plan/draft?projectId=\(planPid)") { _, j in hubDraft = j["draft"] as? [String: Any]; done = true }
            return self.wait(5) { done }
        }
        _ = wait(4) { pg.buttons["stop"]?.window == nil }
        settle(6.5)
        _ = readDraft()
        let steps = (hubDraft?["steps"] as? [Any])?.count ?? 0
        let notBusy = hubDraft?["busy"] == nil || hubDraft?["busy"] is NSNull
        check("plan_stop_while_drafting", ch == 200 && notBusy && steps == 0 && pg.buttons["start"]?.window == nil,
              "hub \(ch); draft busy \(String(describing: hubDraft?["busy"])) steps \(steps)")
        // A draft again, its questions answered, Start: the plan goes to the session at its prompt.
        if pg.fields["goal"]?.field.stringValue.isEmpty ?? true, let f = pg.fields["goal"] { typeIn(f, "Make the boat tilt with the street") }
        if pg.buttons["draft"]?.window == nil { board.openNewPlan(planPid); _ = wait(5) { pg.buttons["draft"]?.window != nil } }
        if let f = pg.fields["goal"], f.field.stringValue.isEmpty { typeIn(f, "Make the boat tilt with the street") }
        pg.buttons["draft"]?.performClick(nil)
        let drafted = wait(40) { pg.buttons["start"]?.window != nil }
        for qi in 0..<4 {
            guard let b = pg.buttons["q\(qi)o0"] else { break }
            _ = wait(8) { pg.busy.isEmpty && b.isEnabled }
            b.performClick(nil)
            _ = wait(8) { pg.busy.isEmpty && (pg.buttons["q\(qi)o0"]?.accessibilityValue() as? Bool) == true }
        }
        _ = wait(8) { pg.buttons["start"]?.isEnabled == true }
        s2 = hub.sent.count
        let Lp = board.log.count
        pg.buttons["start"]?.performClick(nil)
        let cs = hubCode("/api/plan/start", after: s2, 20)
        let brief = readFile(e["planBrief"] ?? "")
        let fake = readFile(e["fakeCmux"] ?? "")
        let sf = e["planSurface"] ?? ""
        let sent = (((try? JSONSerialization.jsonObject(with: Data(fake.utf8))) as? [String: Any])?["prompts"] as? [String: Any])?[sf] as? [String: Any]
        let typed = (sent?["sent"] as? [String] ?? []).joined(separator: "\n")
        check("plan_start_reaches_session", drafted && cs == 200 && brief.contains("Long notes on the paths") && typed.contains("Long notes on the paths"),
              "drafted \(drafted) hub \(cs) \(board.hub.answers.last { $0.path == "/api/plan/start" }.map { "\($0.code)" } ?? ""); brief has it \(brief.contains("Long notes on the paths")); typed into \(sf): \(typed.prefix(140)); toasts \(toasts(since: Lp)); page \(texts(pg).suffix(4))")
        // Started: the page shows the plan running in the brief (the hub's state names it a moment after).
        check("plan_page_after_start", wait(10) { self.shows(pg, "Long notes on the paths") && !self.shows(pg, t("plan.gone")) }, texts(pg).prefix(8).joined(separator: " | "))
        finishProofs()
    }

    private func twoPicturesProofs(_ name: String) {
        for (w, h, dark) in [(CGFloat(1280), CGFloat(820), true), (900, 760, false)] {
            size(w, h)
            NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            settle(0.4)
            board.render(force: true)
            settle(0.3)
            picture("native-\(name)-\(Int(w))-\(dark ? "dark" : "light").png")
        }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        size(1280, 820)
    }

    private func finishProofs() {}

    /// ONB-006: the app again on the same hub (sidetest.mjs starts it after
    /// --screen proofs): the hints dismissed in the first run stay gone.
    func screenProofs2() {
        let loaded = wait(10) { Hints.shared.loaded }
        check("onb_relaunch_marks_read", loaded && Hints.shared.done.isSuperset(of: ["pick", "needs-you"]), "done \(Hints.shared.done.sorted())")
        settle(1.0)
        board.render(force: true)
        settle(0.4)
        check("onb_relaunch_no_needs_you_hint", hintIn(board.sidebar, "needs-you") == nil)
        if let pick = pickFixture(), let pid = pick["id"] as? String {
            settle(0.5)
            board.openPicker(pid)
            settle(0.6)
            check("onb_relaunch_no_pick_hint", board.root.middle === board.picker && hintIn(board.picker, "pick") == nil, "\(board.front)")
            board.picker.buttons["close"]?.performClick(nil)
        } else { check("onb_relaunch_pick_fixture", false) }
    }
}
