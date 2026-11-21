// Suggested answers and the session's model (scripts/sidetest.mjs --screen
// answers), on the demo hub:
// - arrival 1: paper-boat hands back the real "B, C, or keep A?" message of
//   the pictures round; the hub reads its options (hub/server/answers.mjs),
//   the panel shows them as buttons (B, the one recommended, first), and a
//   press on "Keep A: today" types exactly "Keep A" into its session (the
//   prompt the stand-in cmux plays, through POST /api/send);
// - the model: garden-planner's row chip says "Opus 5.5" at 284 pt and
//   "Opus" at 220, the panel head "Claude Opus 5.5"; arrival 2 grows its
//   transcript by a /model switch and a reply on Sonnet 4.6, and the chip
//   and the head follow;
// - New session's Model: Start in garden-planner with Opus picked runs the
//   stand-in with `--model opus` (its argv, written by itself in a pane of
//   this test's daemon) and the hub remembers it for the project.
// Pictures of the panel, the sidebar at 284 and 220 and New session, dark and light.

import AppKit

extension SelfTestBoard {
    private var answersEnv: [String: Any] {
        (ProcessInfo.processInfo.environment["RAVENRY_MAC_ANSWERS"]?.data(using: .utf8)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
    }

    /// What the stand-in cmux typed into a surface's prompt (each Enter one entry).
    private func sentTo(_ surface: String) -> [String] {
        guard let f = answersEnv["fake"] as? String, let d = FileManager.default.contents(atPath: f),
              let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return [] }
        return (((j["prompts"] as? [String: Any])?[surface] as? [String: Any])?["sent"] as? [String]) ?? []
    }

    private func chipText(_ key: String) -> String {
        guard let c = board.sidebar.tags[key] ?? nil else { return "" }
        func walk(_ v: NSView) -> [String] { ((v as? NSTextField).map { [$0.stringValue] } ?? []) + v.subviews.flatMap(walk) }
        return walk(c).joined()
    }

    private func sidebarAt(_ w: CGFloat) {
        board.sidebar.onResize?(w)
        settle(0.3)
        board.render(force: true)
        settle(0.3)
    }

    /// The panel, the sidebar at 284 and 220, dark and light.
    private func answersPictures(_ name: String) {
        for w in [CGFloat(284), 220] {
            sidebarAt(w)
            for dark in [true, false] {
                NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                settle(0.3)
                board.render(force: true)
                settle(0.4)
                picture("native-\(name)-\(Int(w))-\(dark ? "dark" : "light").png")
            }
        }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        sidebarAt(284)
    }

    func screenAnswers() {
        let hub = board.hub
        size(1280, 820)
        sidebarAt(284)

        // MARK: the model on the row and in the panel head
        let gk = "garden-planner/sf-1"
        check("ans_model_on_session", wait(10) { hub.state?.find(gk)?.session.modelTitle == "Claude Opus 5.5" }, "\(hub.state?.find(gk)?.session.raw["model"] ?? "none")")
        check("ans_chip_wide", wait(5) { self.chipText(gk) == "Opus 5.5" }, "chip \(chipText(gk)) at \(Int(board.sidebar.bounds.width)) pt")
        sidebarAt(220)
        check("ans_chip_narrow", wait(5) { self.chipText(gk) == "Opus" }, "chip \(chipText(gk)) at \(Int(board.sidebar.bounds.width)) pt")
        sidebarAt(284)
        check("ans_chip_wide_again", wait(5) { self.chipText(gk) == "Opus 5.5" }, "chip \(chipText(gk))")
        board.pickSession(gk, why: "test")
        check("ans_panel_head_model", wait(5) { self.shows(self.board.panel, "Claude Opus 5.5") }, texts(board.panel).prefix(6).joined(separator: " | "))
        answersPictures("answers-model")

        // MARK: suggested answers from the message: buttons, the key typed
        check("ans_arrived", arrival(1))
        let pk = "paper-boat/sf-3"
        let want = ["B: the app", "C: the app with an alert…", "Keep A: today"]
        let quick = { () -> [[String: Any]] in (hub.state?.find(pk)?.session.words["quick"] as? [[String: Any]]) ?? [] }
        check("ans_quick_from_hub", wait(20) { quick().compactMap { $0["label"] as? String } == want } && quick().compactMap { $0["text"] as? String } == ["B", "C", "Keep A"],
              "\(quick())")
        board.pickSession(pk, why: "test")
        check("ans_buttons_drawn", wait(6) { want.allSatisfy { self.board.panel.buttons["quick:\($0)"] != nil } },
              board.panel.buttons.keys.filter { $0.hasPrefix("quick") }.sorted().joined(separator: ","))
        answersPictures("answers-panel")
        let before = sentTo("sf-3")
        let n = hub.sent.count
        board.panel.buttons["quick:Keep A: today"]?.performClick(nil)
        check("ans_press_posts", wait(6) { hub.answers.contains { $0.seq >= n && $0.path == "/api/send" && $0.code == 200 && !$0.faked } },
              "\(sentSince(n)) \(hub.answers.filter { $0.seq >= n }.map { "\($0.path) \($0.code)" })")
        check("ans_press_types_the_key", wait(6) { self.sentTo("sf-3").count > before.count } && sentTo("sf-3").last == "Keep A", "sent \(sentTo("sf-3"))")

        // MARK: /model in the session: the chip and the head follow with its next reply
        check("ans_model_switch_arrived", arrival(2))
        check("ans_chip_follows_model", wait(20) { self.board.render(); return self.chipText(gk) == "Sonnet 4.6" }, "chip \(chipText(gk)); hub \(hub.state?.find(gk)?.session.raw["model"] ?? "none")")
        board.pickSession(gk, why: "test")
        check("ans_head_follows_model", wait(5) { self.board.render(force: true); return self.shows(self.board.panel, "Claude Sonnet 4.6") }, texts(board.panel).prefix(6).joined(separator: " | "))
        sidebarAt(220)
        check("ans_chip_follows_narrow", wait(5) { self.chipText(gk) == "Sonnet" }, "chip \(chipText(gk))")
        sidebarAt(284)

        // MARK: New session's Model: started with it, remembered for the project
        let st = board.start
        var live: [String: Any]?
        hub.get("/api/setup/start") { code, j in live = code == 200 ? j : [:] }
        _ = wait(8) { live != nil }
        guard var a0 = live, let fs0 = a0["folders"] as? [[String: Any]], let garden = fs0.first(where: { $0["name"] as? String == "garden-planner" })?["path"] as? String else {
            check("ans_start_hub_answer", false, "\(live ?? [:])"); return
        }
        check("ans_start_menus", ((a0["models"] as? [String: Any])?["claude"] as? [[String: Any]])?.first?["label"] as? String == "Claude Code's default"
              && ((a0["models"] as? [String: Any])?["claude"] as? [[String: Any]])?.contains { $0["id"] as? String == "opus" && $0["label"] as? String == "Opus 5.5" } == true,
              "\(a0["models"] ?? "none")")
        // This board's assistants as found and set up (the Start screen's own checks cover the rest).
        a0["assistants"] = [["kind": "claude", "name": "Claude Code", "found": true, "signedIn": true, "path": "/usr/local/bin/claude"]]
        hub.testAnswers["/api/setup/start"] = a0
        // Start opened on a folder asks with it (StartView): the same answer there, or the board's own
        // list comes back (OpenCode, no sign-in, offered first).
        let startAsked = "/api/setup/start?folder=\(garden.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")"
        hub.testAnswers[startAsked] = a0
        hub.testAnswers["/api/onboarding"] = ["setup": ["claude": true]]
        board.openStart(garden)
        check("ans_start_opens", wait(6) { self.board.front == .start && st.folder == garden && st.assistant == "claude" && st.controls["model"] != nil },
              "\(board.front) \(st.folder ?? "-") \(st.assistant ?? "-") \(st.controls.keys.sorted())")
        let pop = st.controls["model"] as? NSPopUpButton
        check("ans_start_menu_drawn", pop?.itemTitles.first == "Claude Code's default" && pop?.itemTitles.contains("Opus 5.5") == true && pop?.indexOfSelectedItem == 0
              && shows(st, t("start.modelNote")), "\(pop?.itemTitles ?? []) selected \(pop?.indexOfSelectedItem ?? -1)")
        if let p = pop, let i = p.itemTitles.firstIndex(of: "Opus 5.5") {
            p.selectItem(at: i)
            _ = p.sendAction(p.action, to: p.target)
        }
        check("ans_start_model_picked", wait(3) { st.modelChoice == "opus" && (st.controls["model"] as? NSPopUpButton)?.titleOfSelectedItem == "Opus 5.5" }, st.modelChoice)
        for (w, h) in [(CGFloat(1280), CGFloat(820)), (900, 760)] {
            size(w, h)
            for dark in [true, false] {
                NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                settle(0.4); board.render(force: true); settle(0.4)
                picture("native-answers-start-\(Int(w))-\(dark ? "dark" : "light").png")
            }
        }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        size(1280, 820)
        // Its own copy or right in the folder: right in it (a worktree is the Start screen's own check).
        if let l = st.controls["inFolder"] { click(l) }
        let argv = answersEnv["argv"] as? String ?? ""
        let lines = { () -> [String] in ((try? String(contentsOfFile: argv, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init) }
        let n2 = hub.sent.count
        click(st.go)
        check("ans_start_posted", wait(10) { hub.answers.contains { $0.seq >= n2 && $0.path == "/api/sessions/start" && $0.code == 200 && !$0.faked } },
              "\(sentSince(n2)) \(hub.answers.filter { $0.seq >= n2 }.map { "\($0.path) \($0.code)" }) \(st.error ?? "")")
        check("ans_start_runs_with_model", wait(15) { lines().contains { $0.hasPrefix("--model opus ") } }, "argv \(lines())")
        // The hub's own answer from here on: what it remembered.
        hub.testAnswers[startAsked] = nil
        var reg: [String: Any]?
        _ = wait(8) {
            hub.get("/api/setup/start?folder=\(garden.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? garden)") { _, j in reg = j }
            settle(0.3)
            return ((reg?["folders"] as? [[String: Any]])?.first { $0["path"] as? String == garden }?["models"] as? [String: Any])?["claude"] as? String == "opus"
        }
        check("ans_start_model_remembered", ((reg?["folders"] as? [[String: Any]])?.first { $0["path"] as? String == garden }?["models"] as? [String: Any])?["claude"] as? String == "opus"
              && wait(8) { (hub.state?.project("garden-planner")?.raw["models"] as? [String: Any])?["claude"] as? String == "opus" },
              "\(((reg?["folders"] as? [[String: Any]])?.first { $0["path"] as? String == garden })?["models"] ?? "none") state \(hub.state?.project("garden-planner")?.raw["models"] ?? "none")")
        hub.testAnswers = [:]
    }
}
