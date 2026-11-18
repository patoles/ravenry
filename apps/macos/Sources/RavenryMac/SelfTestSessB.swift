// sidetest.mjs --screen sessb: the sessions and sidebar rows the first
// sessions round left unproven, each driven through its control and read
// where it lands (the hub's state and answer, the stand-in's pane and log,
// the files it wrote), on a demo hub in Ravenry mode whose sessions start in
// panes of this test's daemon (scripts/sessb-fixture.mjs). Then --screen
// sessb2: the app started again with no board, which comes up later.

import AppKit

extension SelfTestBoard {
    // MARK: helpers

    /// What the driver's stand-ins logged: one record each (its pid, pane, folder, kind, args).
    private func standIns() -> [[String: Any]] {
        let text = ask(["do": "log"])?["text"] as? String ?? ""
        return text.split(separator: "\n").compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
    }
    private func paneScreen(_ pane: String) -> String { ask(["do": "pane", "pane": pane])?["screen"] as? String ?? "" }
    private func sessKey(_ project: String, where pick: (HubSession) -> Bool = { _ in true }) -> String? {
        guard let p = board.hub.state?.project(project), let s = p.sessions.first(where: pick) else { return nil }
        return "\(project)/\(s.surfaceId)"
    }
    private func find<T: NSView>(_ v: NSView, _ type: T.Type, _ ok: (T) -> Bool = { _ in true }) -> T? {
        if let x = v as? T, !x.isHiddenOrHasHiddenAncestor, ok(x) { return x }
        for s in v.subviews { if let f = find(s, type, ok) { return f } }
        return nil
    }
    private func reasonShown() -> String? {
        find(board.panel, NSTextField.self) { $0.identifier?.rawValue == "state-reason" }?.stringValue
    }
    /// Keys through the window to whatever has its keyboard, as the person types.
    private func typeWindow(_ s: String) {
        var codes: [String: UInt16] = [:]
        for (k, name) in KeyCodes.table {
            if name.hasPrefix("Key") { codes[name.dropFirst(3).lowercased()] = k }
            if name.hasPrefix("Digit") { codes[String(name.dropFirst(5))] = k }
        }
        codes[" "] = 0x31; codes["."] = 0x2F; codes["-"] = 0x1B; codes["/"] = 0x2C; codes[","] = 0x2B
        for ch in s {
            let c = String(ch)
            let lower = c.lowercased()
            guard let code = codes[lower] else { continue }
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                if let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: c != lower ? [.shift] : [], timestamp: ProcessInfo.processInfo.systemUptime,
                                            windowNumber: window.windowNumber, context: nil, characters: c, charactersIgnoringModifiers: lower,
                                            isARepeat: false, keyCode: code) {
                    window.sendEvent(e)
                }
            }
        }
        settle(0.2)
    }
    /// The terminal view of a pane, its tab brought to the front.
    private func termOf(_ pane: String) -> TerminalView? {
        _ = board.showPane(pane)
        settle(0.4)
        return find(window.contentView!, TerminalView.self) { $0.pane == pane }
    }
    /// A key a terminal gets from the keyboard (Backspace, Return).
    private func termKey(_ v: TerminalView, _ chars: String, _ code: UInt16) {
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            if let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                        context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code) {
                if type == .keyDown { v.keyDown(with: e) } else { v.keyUp(with: e) }
            }
        }
        settle(0.1)
    }
    /// A menu item's action, as AppKit sends it when the person picks it.
    private func pickItem(_ m: NSMenu?, _ title: String) -> Bool {
        guard let i = m?.items.first(where: { $0.title == title || $0.title.hasPrefix(title) }), i.isEnabled, let a = i.action else { return false }
        NSApp.sendAction(a, to: i.target, from: i)
        settle(0.4)
        return true
    }
    /// The tracking area's enter or exit, handed to its owner as AppKit does (a window off every screen has no pointer).
    private func hover(_ v: NSView, _ type: NSEvent.EventType) {
        v.updateTrackingAreas()
        guard let ta = v.trackingAreas.first else { return }
        let p = v.convert(NSPoint(x: v.bounds.midX, y: v.bounds.midY), to: nil)
        if let e = NSEvent.enterExitEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
                                          eventNumber: 0, trackingNumber: 0, userData: Unmanaged.passUnretained(ta).toOpaque()) {
            if type == .mouseEntered { (ta.owner as? NSResponder)?.mouseEntered(with: e) } else { (ta.owner as? NSResponder)?.mouseExited(with: e) }
        }
        settle(0.2)
    }

    func screenSessB() {
        let hub = board.hub
        let sb = board.sidebar
        check("sb_state", wait(40) { (hub.state?.projects.filter { !$0.sessions.isEmpty }.count ?? 0) >= 4 && hub.state?.project("harbour-light") != nil },
              "\(hub.state?.projects.map { "\($0.id):\($0.sessions.count)" } ?? [])")
        check("sb_ravenry_mode", (hub.state?.raw["board"] as? [String: Any])?["kind"] as? String == "ravenry", "\(hub.state?.raw["board"] ?? "none")")
        sbReasons()
        sbBackground()
        sbEnded()
        sbQuestionToast()
        sbWaitingOn()
        sbProjectPage()
        sbReply()
        sbCodex()
        sbNewSession()
        sbLease()
        sbFreshStart()
        sbHandOffMenus()
        sbWentOn()
        sbRowHover()
        sbListEnd()
        sbDiscard()
        if reasonScreenLater { sbReasonScreen() }
        sbFrontForRelaunch()
    }

    // MARK: an ended cmux session in front: Continue this conversation, not Move here

    private func sbEnded() {
        guard let st = board.hub.state, let f = st.projects.lazy.compactMap({ p in p.sessions.first { $0.sessionId != nil && $0.pane == nil && $0.machine == nil && p.machine == nil && ($0.term ?? "").lowercased() == "cmux" && $0.group == "idle" }.map { (p, $0) } }).first
                ?? st.projects.lazy.compactMap({ p in p.sessions.first { $0.sessionId != nil && $0.pane == nil && $0.machine == nil && p.machine == nil && ($0.term ?? "").lowercased() == "cmux" && $0.group != "work" }.map { (p, $0) } }).first,
              let sid = f.1.sessionId else { check("sb_ended_offers_continue", false, "no session in cmux"); return }
        let key = "\(f.0.id)/\(f.1.surfaceId)"
        board.pickSession(key, why: "test")
        settle(0.5)
        let before = board.outside.buttons["move"]?.title ?? "none"
        _ = ask(["do": "endcmux", "sid": sid])
        let ov = board.outside
        let shown = wait(25) { ov.buttons["move"]?.title == t("project.continue") }
        check("sb_ended_offers_continue", shown && ov.noteText == t("else.continueNote") && shows(ov, "It ended there") && ov.buttons["open"] == nil && ov.buttons["move"]?.isEnabled == true,
              "before \(before); now \(ov.buttons["move"]?.title ?? "none") enabled \(ov.buttons["move"]?.isEnabled ?? false); note \(ov.noteText ?? "none"); " + texts(ov).prefix(4).joined(separator: " | "))
        pictures("sessb-ended")
        let n0 = standIns().count
        if let b = ov.buttons["move"] { click(b) }
        check("sb_ended_continue_posted", wait(15) { self.board.hub.sentBodies.contains { $0.path == "/api/sessions/move" && $0.body["sessionId"] as? String == sid } && self.board.hub.inFlight == 0 })
        let resumed = wait(25) { self.standIns().dropFirst(n0).contains { (($0["args"] as? [String]) ?? []).contains(sid) } }
        check("sb_ended_continue_resumed", resumed, "\(standIns().dropFirst(n0).map { "\($0["args"] ?? "")" })")
    }

    // MARK: TERM-069: the session read only in the middle that was in front comes back in front after a relaunch

    private func sbFrontForRelaunch() {
        board.toTerminal()
        guard let st = board.hub.state, let f = st.projects.lazy.compactMap({ p in p.sessions.first { $0.pane == nil && $0.machine == nil && p.machine == nil && ($0.term ?? "").lowercased() == "cmux" }.map { (p, $0) } }).first else {
            check("sb_front_kept", false, "no session in cmux"); return
        }
        let key = "\(f.0.id)/\(f.1.surfaceId)"
        if let r = board.sidebar.rows[key] { click(r) } else { board.pickSession(key, why: "test") }
        settle(0.5)
        board.render(force: true)
        settle(0.5)
        try? key.write(to: dir.appendingPathComponent("sessb-front.txt"), atomically: true, encoding: .utf8)
        check("sb_front_kept", board.front == .session(key), "\(board.front)")
    }

    // MARK: --screen sessb3: the app again on the same data folder, daemon and board

    func screenSessB3() {
        let want = (try? String(contentsOf: dir.appendingPathComponent("sessb-front.txt"), encoding: .utf8)) ?? ""
        let back = wait(30) { self.board.front == .session(want) }
        check("sb3_relaunch_front_session", !want.isEmpty && back && board.root.middle === board.outside, "want \(want); front \(board.front)")
        picture("native-sessb3-relaunch-1280-dark.png")
    }

    /// SESS-035: a session whose state the hub read from its screen.
    private func sbReasonScreen() {
        guard let g = board.hub.state?.projects.lazy.compactMap({ p in p.sessions.first { $0.raw["source"] as? String != nil && $0.raw["source"] as? String != "events" && !($0.raw["reasons"] as? [Any] ?? []).isEmpty }.map { (p, $0) } }).first else {
            check("sb_reason_screen", false, "no session read from its screen: \(board.hub.state?.projects.flatMap { $0.sessions.map { "\($0.surfaceId.prefix(8)) \($0.raw["source"] ?? "-")" } } ?? [])"); return
        }
        board.pickSession("\(g.0.id)/\(g.1.surfaceId)", why: "test")
        let w = t("panel.reasonScreen", ["why": (g.1.raw["reasons"] as? [String] ?? []).joined(separator: "; ")])
        check("sb_reason_screen", wait(5) { self.reasonShown() == w }, "shown \(reasonShown() ?? "none"); the hub's source \(g.1.raw["source"] ?? "-")")
    }

    // MARK: SESS-035, SESS-007: the state's reason, from the hooks first

    private func sbReasons() {
        guard let st = board.hub.state, let f = st.projects.lazy.compactMap({ p in p.sessions.first { $0.sessionId != nil && $0.raw["source"] as? String == "events" }.map { (p, $0) } }).first else {
            check("sb_reason_events", false, "no session with hook events"); return
        }
        let key = "\(f.0.id)/\(f.1.surfaceId)"
        board.pickSession(key, why: "test")
        let want = t("panel.reasonEvents", ["why": (f.1.raw["reasons"] as? [String] ?? []).joined(separator: "; ")])
        check("sb_reason_events", wait(5) { self.reasonShown()?.hasPrefix("From hook events: ") == true } && reasonShown() == want,
              "shown \(reasonShown() ?? "none"); the hub's source \(f.1.raw["source"] ?? "-"), reasons \(f.1.raw["reasons"] ?? "-")")
        pictures("sessb-reason")
        // A session whose state the hub read from its screen (no hook event placed it).
        if let g = board.hub.state?.projects.lazy.compactMap({ p in p.sessions.first { $0.raw["source"] as? String != nil && $0.raw["source"] as? String != "events" && !($0.raw["reasons"] as? [Any] ?? []).isEmpty }.map { (p, $0) } }).first {
            board.pickSession("\(g.0.id)/\(g.1.surfaceId)", why: "test")
            let w = t("panel.reasonScreen", ["why": (g.1.raw["reasons"] as? [String] ?? []).joined(separator: "; ")])
            check("sb_reason_screen", wait(5) { self.reasonShown() == w }, "shown \(reasonShown() ?? "none"); the hub's source \(g.1.raw["source"] ?? "-")")
        } else { reasonScreenLater = true }
    }

    // MARK: SESS-037: waiting on background tasks reads Working

    private func sbBackground() {
        guard let st = board.hub.state, let f = st.projects.lazy.compactMap({ p in p.sessions.first { $0.sessionId != nil && $0.group != "work" && $0.raw["source"] as? String == "events" }.map { (p, $0) } }).first,
              let sid = f.1.sessionId else { check("sb_bg_working", false, "no session at rest"); return }
        let key = "\(f.0.id)/\(f.1.surfaceId)"
        _ = ask(["do": "events", "sid": sid, "events": [["event": "UserPromptSubmit", "prompt": "Run the long import in the background"], ["event": "Stop", "ends_on_question": false, "background_tasks": 2]]])
        let working = wait(20) { self.board.hub.state?.sidebar(has: key, in: "work") ?? false }
        board.pickSession(key, why: "test")
        check("sb_bg_working", working && wait(5) { self.reasonShown()?.contains("waiting on 2 background tasks") == true } && sb(key, inSection: "work"),
              "row in work: \(working); reason \(reasonShown() ?? "none")")
        pictures("sessb-background")
        _ = ask(["do": "events", "sid": sid, "events": [["event": "Stop", "ends_on_question": false, "background_tasks": 0]]])
        check("sb_bg_done_leaves_working", wait(20) { !(self.board.hub.state?.sidebar(has: key, in: "work") ?? true) } && !sb(key, inSection: "work"),
              "\(board.hub.state?.find(key)?.session.group ?? "-")")
    }
    /// The row drawn inside that section's box.
    private func sb(_ key: String, inSection g: String) -> Bool {
        board.render(force: true)
        settle(0.3)
        guard let row = board.sidebar.rows[key] else { return false }
        var v: NSView? = row.superview
        while let x = v { if let b = x as? Box, b.fill == "\(g)-t" { return true }; v = x.superview }
        return false
    }

    // MARK: SESS-039: Waiting on others, set by hand in the brief

    private func sbWaitingOn() {
        let pid = "old-notes"
        _ = ask(["do": "brief", "project": pid, "append": "\nWaiting on: the designer\n"])
        let moved = wait(20) { self.board.hub.state?.sections.first { $0.group == "wait" }?.projects.contains { $0.id == pid } ?? false }
        let drawn = sb("project:\(pid)", inSection: "wait")
        board.pickProject(pid)
        settle(0.5)
        check("sb_waiting_on_by_hand", moved && drawn && shows(board.projectPage, "Waiting on the designer"),
              "in the hub's wait section \(moved), drawn there \(drawn); page: \(texts(board.projectPage).prefix(4).joined(separator: " | "))")
        pictures("sessb-waiting-on")
        _ = ask(["do": "brief", "project": pid, "replace": ["\nWaiting on: the designer\n", "\n"]])
        check("sb_waiting_on_removed", wait(20) { !(self.board.hub.state?.sections.first { $0.group == "wait" }?.projects.contains { $0.id == pid } ?? false) } && !sb("project:\(pid)", inSection: "wait"),
              "\(board.hub.state?.sections.map { "\($0.group): \($0.projects.map(\.id))" } ?? [])")
    }

    // MARK: SESS-046 the folder in Finder, SESS-042 Revive, SESS-043 the project's assistant

    private func sbProjectPage() {
        let pp = board.projectPage
        board.pickProject("old-notes")
        _ = wait(8) { pp.buttons["revive"] != nil && pp.buttons["folder"] != nil }
        pictures("sessb-project")
        // The folder: Finder opens it (the hub's stand-in `open`, its log).
        if let b = pp.buttons["folder"] { click(b) }
        check("sb_open_folder_posted", wait(5) { self.board.hub.sentBodies.contains { $0.path == "/api/project/open-folder" && $0.body["projectId"] as? String == "old-notes" } })
        let opened = ask(["do": "open"])?["text"] as? String ?? ""
        check("sb_open_folder_finder", opened.contains("Projects/old-notes"), opened.trimmingCharacters(in: .whitespacesAndNewlines))

        // Revive: a new tab running Claude on the brief.
        let before = Set(board.ws.paneIDs())
        let n0 = standIns().count
        guard let rv = pp.buttons["revive"], rv.isEnabled else { check("sb_revive_posted", false, "no Revive: \(pp.buttons.keys.sorted())"); return }
        click(rv)
        check("sb_revive_posted", wait(15) { self.board.hub.sentBodies.contains { $0.path == "/api/project/revive" } && self.board.hub.inFlight == 0 })
        let started = wait(20) { self.standIns().count > n0 }
        let rec = standIns().dropFirst(n0).first ?? [:]
        let pane = rec["pane"] as? String ?? ""
        let args = (rec["args"] as? [String] ?? []).joined(separator: " ")
        check("sb_revive_runs_on_brief", started && rec["kind"] as? String == "claude" && (rec["cwd"] as? String ?? "").hasSuffix("/old-notes") && args.contains("Read BRIEF.md (Hand-off section first)"),
              "\(rec)")
        let tab = wait(10) { self.board.ws.paneIDs().contains(pane) && !before.contains(pane) && self.board.ws.tabs.contains { $0.host == pane } }
        check("sb_revive_tab_here", tab && paneScreen(pane).contains("asked: Read BRIEF.md"), "pane \(pane) a tab: \(tab); screen: \(paneScreen(pane).split(separator: "\n").prefix(2).joined(separator: " / "))")
        reviveKey = wait(20) { self.sessKey("old-notes") { $0.pane == pane && $0.sessionId != nil } != nil } ? sessKey("old-notes") { $0.pane == pane } : nil
        revivePane = pane
        check("sb_revive_on_board", reviveKey != nil, "\(board.hub.state?.project("old-notes")?.sessions.map { "\($0.surfaceId) \($0.pane ?? "-")" } ?? [])")

        // harbour-light's next sessions start with Codex.
        board.pickProject("harbour-light")
        _ = wait(8) { pp.assistantSwitch != nil && pp.buttons["revive"] != nil }
        guard let seg = pp.assistantSwitch else { check("sb_assistant_posted", false, "no switch"); return }
        let s0 = board.hub.sent.count
        seg.selectedSegment = 1
        _ = seg.sendAction(seg.action, to: seg.target)
        check("sb_assistant_posted", wait(5) { self.board.hub.sentBodies.dropFirst(s0).contains { $0.path == "/api/project/assistant" && $0.body["assistant"] as? String == "codex" } })
        check("sb_assistant_saved", wait(10) { self.board.hub.state?.project("harbour-light")?.raw["assistantWants"] as? String == "codex" },
              "\(board.hub.state?.project("harbour-light")?.raw["assistantWants"] ?? "-")")
        if let p = board.hub.state?.project("harbour-light") { pp.show(p) }
        settle(0.4)
        check("sb_assistant_shown", pp.assistantSwitch?.selectedSegment == 1 && (pp.buttons["revive"]?.toolTip ?? "").contains("Codex"), pp.buttons["revive"]?.toolTip ?? "")
        pictures("sessb-project-codex")
        let n1 = standIns().count
        if let b = pp.buttons["revive"] { click(b) }
        check("sb_codex_revive_posted", wait(15) { self.board.hub.sentBodies.contains { $0.path == "/api/project/revive" && $0.body["projectId"] as? String == "harbour-light" } && self.board.hub.inFlight == 0 })
        let codex = wait(20) { self.standIns().dropFirst(n1).contains { $0["kind"] as? String == "codex" } }
        let crec = standIns().dropFirst(n1).first { $0["kind"] as? String == "codex" } ?? standIns().dropFirst(n1).first ?? [:]
        check("sb_codex_runs", codex && (crec["cwd"] as? String ?? "").hasSuffix("/harbour-light"), "\(crec)")
        codexPane = crec["pane"] as? String ?? ""
    }

    // MARK: SESS-026, SESS-045: no Reply in the panel of a session in a pane of this window (its terminal is how to
    // type there); the Reply of a session in another terminal, its file and the half-typed refusal: --screen reply

    private func sbReply() {
        guard let key = reviveKey, let pane = revivePane else { check("sb_reply_box_not_in_pane", false, "no revived session"); return }
        board.pickSession(key, why: "test")
        if !board.panelVisible { _ = self.key("b", [.command, .option]) }
        _ = wait(5) { self.board.render(force: true); return self.board.panel.key == key }
        settle(0.5)
        let s = board.hub.state?.find(key)?.session
        check("sb_reply_box_not_in_pane", board.panel.key == key && board.front == .tab && s?.pane == pane && find(board.panel, ReplyBox.self) == nil
              && s.map { ReplyBox.canType(board.hub.state!, $0) } == true && s?.raw["live"] as? Bool == true,
              "\(board.panel.shows) \(board.front), pane \(s?.pane ?? "-"), live \(s?.raw["live"] ?? "-"); " + texts(board.panel).prefix(12).joined(separator: " | "))
        pictures("sessb-no-reply")
    }

    // MARK: SESS-008: a Codex session on this board, its permission request Needs you and an alert

    private func sbCodex() {
        let pane = codexPane ?? ""
        let found = wait(25) { self.sessKey("harbour-light") { $0.pane == pane && $0.assistant == "codex" && $0.group == "you" } != nil }
        guard found, let key = sessKey("harbour-light", where: { $0.pane == pane }) else {
            check("sb_codex_needs_you", false, "\(board.hub.state?.project("harbour-light")?.sessions.map { "\($0.pane ?? "-") \($0.assistant ?? "-") \($0.group)" } ?? [])"); return
        }
        let chip = board.sidebar.tags[key].flatMap { $0 }.map { texts($0).joined() } ?? ""
        check("sb_codex_needs_you", sb(key, inSection: "you") && chip == "Codex", "chip \(chip); in you \(sb(key, inSection: "you")); line \(board.hub.state?.find(key)?.session.raw["reasons"] ?? "-")")
        // The alert: the app says it needs you (a toast with Show, as for any arrival not in front).
        // Its arrival said: a toast with Show, or the panel opening when it is the session in front (never a toast about that one).
        let said = board.log.filter { $0.hasPrefix("arrived \(key)") || ($0.hasPrefix("toast ") && $0.contains("harbour-light") && $0.contains("needs you")) }
        check("sb_codex_alert", !said.isEmpty, said.joined(separator: " | ") + "; toasts: " + board.toastTexts.joined(separator: " | "))
        board.pickSession(key, why: "test")
        settle(0.5)
        check("sb_codex_reason", reasonShown()?.hasPrefix("From hook events:") == true, reasonShown() ?? "none")
        pictures("sessb-codex")
    }

    // MARK: SESS-041: a session the hub starts reads the brief and the decisions on record

    private func sbNewSession() {
        guard let folder = board.hub.state?.project("lighthouse")?.folder else { check("sb_new_session_prompt", false, "no lighthouse"); return }
        let st = board.start
        let n0 = standIns().count
        board.openStart(folder)
        _ = wait(8) { st.controls["go"] != nil && st.folder == folder }
        // The hub's assistants read (Found, signed in) before Start.
        _ = wait(10) { self.shows(st, "Found") }
        click(st.go)
        _ = wait(4) { st.setup != nil || self.board.hub.sentBodies.contains { $0.path == "/api/sessions/start" } }
        if st.setup != nil, let b = st.controls["notNow"] as? NSView { click(b) }
        check("sb_new_session_posted", wait(15) { self.board.hub.sentBodies.contains { $0.path == "/api/sessions/start" && $0.body["folder"] as? String == folder } && self.board.hub.inFlight == 0 },
              "\(board.front) \(st.go.title): " + texts(st).prefix(14).joined(separator: " | "))
        let started = wait(20) { self.standIns().count > n0 }
        let rec = standIns().dropFirst(n0).first ?? [:]
        let args = (rec["args"] as? [String] ?? []).joined(separator: " ")
        check("sb_new_session_prompt", started && args.contains("BRIEF.md") && args.contains("Hand-off") && args.contains("2 decisions on record"), args)
        newPane = rec["pane"] as? String
        if let pane = rec["pane"] as? String { check("sb_new_session_pane_says", wait(8) { self.paneScreen(pane).contains("2 decisions") }, paneScreen(pane).split(separator: "\n").prefix(3).joined(separator: " / ")) }
    }

    /// A session's row pressed once the board lists it (by its session id): its tab, as the person opens it.
    private func openRow(of sid: String) {
        board.toTerminal()
        guard wait(20, { self.board.hub.state?.projects.contains { $0.sessions.contains { $0.sessionId == sid } } ?? false }),
              let p = board.hub.state?.projects.first(where: { $0.sessions.contains { $0.sessionId == sid } }), let s = p.sessions.first(where: { $0.sessionId == sid }) else { return }
        let key = "\(p.id)/\(s.surfaceId)"
        // An idle project's line under Idle folded: the head pressed first, as the person would.
        if board.hub.state?.sections.first(where: { $0.group == "idle" })?.projects.contains(where: { $0.id == p.id }) == true, board.sidebar.idleFolded, let h = board.sidebar.idleHead { click(h) }
        _ = wait(5) { self.board.render(force: true); return self.board.sidebar.rows[key] != nil || self.board.sidebar.rows["project:\(p.id)"] != nil }
        if let r = board.sidebar.rows[key] { click(r) }
        else if let r = board.sidebar.rows["project:\(p.id)"] {
            // An idle project is one line: its page's Show the session.
            click(r)
            if wait(5, { self.board.projectPage.buttons["show"] != nil }), let b = board.projectPage.buttons["show"] { click(b) }
        }
        settle(0.5)
    }

    // MARK: SESS-031: a lent pane on the rows, from the daemon's lease

    private func sbLease() {
        guard let a = revivePane, let b = newPane,
              wait(20, { self.sessKey("old-notes") { $0.pane == a } != nil && self.sessKey("lighthouse") { $0.pane == b } != nil }),
              let ka = sessKey("old-notes", where: { $0.pane == a }), let kb = sessKey("lighthouse", where: { $0.pane == b }) else {
            check("sb_lease_using", false, "no two sessions in panes: \(revivePane ?? "-") \(newPane ?? "-")"); return
        }
        let sb = board.sidebar
        // Claude in old-notes starts a pane of its own, the dev server.
        guard let ta = termOf(a) else { check("sb_lease_using", false, "no terminal for \(a)"); return }
        typeKeys(ta, "make dev\r")
        let made = wait(15) { self.paneScreen(a).contains("> made p") }
        // Claude in lighthouse leases it: the person is asked first (its card, the number key: Allow once).
        guard let tb = termOf(b) else { check("sb_lease_using", false, "no terminal for \(b)"); return }
        typeKeys(tb, "wait dev\r")
        board.pickSession(kb, why: "test")
        if !board.panelVisible { _ = self.key("b", [.command, .option]) }
        let asked = wait(20) { self.board.render(force: true); return self.board.panel.shownCard != nil }
        if asked, let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                              context: nil, characters: "1", charactersIgnoringModifiers: "1", isARepeat: false, keyCode: 0x12) {
            board.panel.focusCard()
            board.panel.keyDown(with: e)
        }
        let held = wait(15) { self.paneScreen(b).contains("> holds p") }
        board.toTerminal()
        let using = wait(10) { self.board.render(force: true); return self.shows(sb.rows[kb] ?? NSView(), "Using dev server") }
        check("sb_lease_using", made && asked && held && using, "made \(made), asked \(asked), held \(held); row: \(texts(sb.rows[kb] ?? NSView()).joined(separator: " | ")); pane: \(paneScreen(b).split(separator: "\n").filter { $0.hasPrefix(">") }.suffix(2).joined(separator: " / "))")
        // old-notes, which started it, asks for it too: it waits behind lighthouse.
        if let ta2 = termOf(a) { typeKeys(ta2, "wait dev\r") }
        board.toTerminal()
        let waiting = wait(20) { self.board.render(force: true); return self.shows(sb.rows[ka] ?? NSView(), "Waiting for dev server, Claude has it") }
        check("sb_lease_waiting", waiting, "row: \(texts(sb.rows[ka] ?? NSView()).joined(separator: " | ")); pane: \(paneScreen(a).split(separator: "\n").filter { $0.hasPrefix(">") }.suffix(2).joined(separator: " / "))")
        picture("native-sessb-lease-1280-dark.png")
    }

    // MARK: SESS-024 a fresh session that did not start (the shell asked something): the line, Retry, Copy command

    private func sbFreshNotStarted(key: String, sid: String, folder: String, surfaceId: String) {
        let err = "The fresh session didn't start: the terminal was asking something. Retry, or copy the command."
        let q = "[oh-my-zsh] Would you like to update? [Y/n]"
        let cmd = "cd '\(folder)' && claude 'Read the Hand-off section of BRIEF.md and continue from it.'"
        _ = ask(["do": "marker", "sid": sid, "cwd": folder, "surfaceId": surfaceId, "error": err, "question": q, "command": cmd])
        let failed = wait(20) { self.board.hub.state?.find(key)?.session.handoff?["resumeError"] as? String == err }
        board.pickSession(key, why: "test")
        if !board.panelVisible { _ = self.key("b", [.command, .option]) }
        let shown = wait(8) { self.board.render(force: true); return self.board.panel.buttons["retryFresh"] != nil && self.board.panel.buttons["copyFresh"] != nil }
        check("sb_fresh_not_started_line", failed && shown && shows(board.panel, "Hand-off written to BRIEF.md. " + err) && shows(board.panel, "Its tab asks: \"\(q)\". Ravenry never answers that for you.")
              && board.panel.buttons["startFresh"] == nil,
              "failed \(failed), buttons \(board.panel.buttons.keys.sorted()); " + texts(board.panel).prefix(18).joined(separator: " | "))
        pictures("sessb-fresh-not-started")
        // Copy command: the hub's command to the clipboard (off every screen recorded, the clipboard untouched).
        let n0c = Outside.record?.count ?? 0
        if let b = board.panel.buttons["copyFresh"] { click(b) }
        let copied = wait(3) { (Outside.record ?? []).dropFirst(n0c).contains("copy \(cmd)") }
        check("sb_fresh_copy_command", copied, (Outside.record ?? []).dropFirst(n0c).joined(separator: " | "))
        // Retry: the same start, by hand (POST /api/handoff/start): the stand-in starts, and the hand-off is resumed once it is seen.
        let n0 = standIns().count
        if let b = board.panel.buttons["retryFresh"] { click(b) }
        let posted = wait(20) { self.board.hub.sentBodies.contains { $0.path == "/api/handoff/start" && $0.body["sessionId"] as? String == sid } && self.board.hub.inFlight == 0 }
        let started = wait(25) { self.standIns().count > n0 }
        let rec = standIns().dropFirst(n0).first ?? [:]
        let resumed = wait(25) { self.board.hub.state?.projects.flatMap(\.sessions).contains { $0.sessionId == sid && $0.handoff?["state"] as? String == "resumed" } == true }
        check("sb_fresh_retry", posted && started && resumed && ((rec["args"] as? [String]) ?? []).joined(separator: " ").contains("Read the Hand-off section"), "posted \(posted), started \(started), resumed \(resumed); \(rec)")
    }

    // MARK: SESS-044 Start fresh session, SESS-024 the fresh session started by itself

    private func sbFreshStart() {
        guard let st = board.hub.state, let f = st.projects.lazy.compactMap({ p in p.sessions.first { $0.sessionId != nil && $0.ctx != nil && $0.pane == nil && p.machine == nil && $0.machine == nil }.map { (p, $0) } }).first,
              let sid = f.1.sessionId, let folder = f.0.folder else { check("sb_fresh_offered", false, "no session with a context"); return }
        let key = "\(f.0.id)/\(f.1.surfaceId)"
        sbFreshNotStarted(key: key, sid: sid, folder: folder, surfaceId: f.1.surfaceId)
        _ = ask(["do": "marker", "sid": sid, "cwd": folder, "surfaceId": f.1.surfaceId])
        let written = wait(20) { self.board.hub.state?.find(key)?.session.handoff?["state"] as? String == "written" && (self.board.hub.state?.find(key)?.session.handoff?["resumeError"] as? String) == nil }
        board.pickSession(key, why: "test")
        if !board.panelVisible { _ = self.key("b", [.command, .option]) }
        let offered = wait(8) { self.board.render(force: true); return self.board.panel.buttons["startFresh"] != nil }
        check("sb_fresh_offered", written && offered && shows(board.panel, "Start the fresh session when you are ready"),
              "written \(written), autoStart \(board.hub.state?.find(key)?.session.handoff?["autoStart"] ?? "-"); " + texts(board.panel).prefix(16).joined(separator: " | "))
        pictures("sessb-fresh")
        let n0 = standIns().count
        if let b = board.panel.buttons["startFresh"] { click(b) }
        check("sb_fresh_posted", wait(20) { self.board.hub.sentBodies.contains { $0.path == "/api/handoff/start" && $0.body["sessionId"] as? String == sid } && self.board.hub.inFlight == 0 })
        let started = wait(25) { self.standIns().count > n0 }
        let rec = standIns().dropFirst(n0).first ?? [:]
        let pane = rec["pane"] as? String ?? ""
        freshRec = rec
        // The old session was in front (its view: it ran in cmux): the window lands on the fresh one by itself, its
        // tab in front, its row lit, the panel on it (2026-11-18: "after a handoff the old session stays focused").
        sbLandsOnFresh(from: key, sid: rec["sid"] as? String ?? "", pane: pane, check: "sb_handoff_lands_on_fresh", picture: "sessb-handoff-lands")
        openRow(of: rec["sid"] as? String ?? "")
        check("sb_fresh_resumes", started && (rec["cwd"] as? String).map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path == URL(fileURLWithPath: folder).resolvingSymlinksInPath().path } == true
              && wait(10) { self.board.ws.tabs.contains { $0.host == pane || $0.guest == pane } } && wait(15) { self.board.hub.state?.find(key)?.session.handoff?["state"] as? String == "resumed" || self.board.hub.state?.projects.flatMap(\.sessions).contains { $0.sessionId == sid && $0.handoff?["state"] as? String == "resumed" } == true },
              "\(rec); its tab \(board.ws.tabs.contains { $0.host == pane || $0.guest == pane }); tabs \(board.ws.tabs.map { "\($0.host)\($0.guest.map { "+" + $0 } ?? "")" }); panes \(board.ws.paneIDs())")

        // With "a fresh session after" on, a written hand-off starts its fresh session by itself, in a pane here.
        var on = false
        board.hub.post("/api/settings/handoff", ["handoffAutoStart": true]) { code, _ in on = code == 200 }
        _ = wait(5) { on }
        guard let g = board.hub.state?.projects.lazy.compactMap({ p in p.sessions.first { $0.sessionId != nil && $0.sessionId != sid && $0.pane == nil && $0.machine == nil && p.machine == nil && p.folder != nil }.map { (p, $0) } }).first,
              let sid2 = g.1.sessionId else { check("sb_auto_fresh", false, "no second session"); return }
        let n1 = standIns().count
        _ = ask(["do": "marker", "sid": sid2, "cwd": g.0.folder!, "surfaceId": g.1.surfaceId])
        let front0 = board.frontKey
        let auto = wait(30) { self.standIns().count > n1 }
        let r2 = standIns().dropFirst(n1).first ?? [:]
        let p2 = r2["pane"] as? String ?? ""
        autoRec = r2
        // Not the session in front (another project's fresh session is): the front stays where the person is.
        let listed2 = wait(20) { self.board.hub.state?.projects.contains { $0.sessions.contains { $0.sessionId == r2["sid"] as? String } } ?? false }
        settle(1.5)
        check("sb_handoff_front_stays", listed2 && front0 != nil && board.frontKey == front0, "front before \(front0 ?? "-"), after \(board.frontKey ?? "-"); listed \(listed2)")
        openRow(of: r2["sid"] as? String ?? "")
        check("sb_auto_fresh", auto && wait(10) { self.board.ws.tabs.contains { $0.host == p2 || $0.guest == p2 } } && ((r2["args"] as? [String]) ?? []).joined(separator: " ").contains("BRIEF.md"), "\(r2); tabs \(board.ws.tabs.map { "\($0.host)\($0.guest.map { "+" + $0 } ?? "")" })")
        sbHandOffFromTab()
        board.hub.post("/api/settings/handoff", ["handoffAutoStart": false]) { _, _ in }
    }

    /// The window lands on a hand-off's fresh session: in front as its tab (`pane`), the board's key on it, its row lit
    /// (or its project's, folded) and the panel on it, the old session (`from`) left.
    private func sbLandsOnFresh(from: String, sid: String, pane: String, check name: String, picture: String, beside old: String? = nil) {
        func freshKey() -> String? {
            guard let st = board.hub.state, let p = st.projects.first(where: { $0.sessions.contains { $0.sessionId == sid } }),
                  let s = p.sessions.first(where: { $0.sessionId == sid }) else { return nil }
            return "\(p.id)/\(s.surfaceId)"
        }
        let landed = wait(25) {
            guard let k = freshKey() else { return false }
            return self.board.front == .tab && self.board.ws.active?.has(pane) == true && self.board.frontKey == k
        }
        board.render(force: true)
        settle(0.5)
        let k = freshKey() ?? "-"
        let sb = board.sidebar
        let lit = sb.rows[k]?.selected == true || (sb.rows[k] == nil && sb.rows["project:\(k.split(separator: "/").first ?? "")"]?.selected == true)
        let panelOn = !board.panelVisible || board.panel.key == k
        var placed = true
        if let old, let oi = board.ws.tabs.firstIndex(where: { $0.has(old) }), let ni = board.ws.tabs.firstIndex(where: { $0.has(pane) }) { placed = ni == oi + 1 } else if old != nil { placed = false }
        check(name, landed && lit && panelOn && placed && board.frontKey != from,
              "front \(board.front) key \(board.frontKey ?? "-") want \(k) (was \(from)); active has fresh pane \(board.ws.active?.has(pane) ?? false); row lit \(lit); panel \(board.panel.key); tabs \(board.ws.tabs.map { $0.host })\(old.map { "; beside \($0): \(placed)" } ?? "")")
        pictures(picture)
    }

    /// A session in a pane here, its tab in front, hands off: the fresh session's tab opens right after it and comes
    /// in front (the hub starts it in a new pane next to the old one, as Hand off now, the hook or the phone would).
    private func sbHandOffFromTab() {
        guard let key = reviveKey, let pane = revivePane, let f = board.hub.state?.find(key), let sid = f.session.sessionId, let folder = f.project.folder,
              board.ws.tabs.contains(where: { $0.has(pane) }) else { check("sb_handoff_tab_beside", false, "no session in a pane here: \(reviveKey ?? "-")"); return }
        board.pickSession(key, why: "test")
        guard wait(5, { self.board.front == .tab && self.board.ws.active?.has(pane) == true }) else { check("sb_handoff_tab_beside", false, "its tab did not come in front: \(board.front)"); return }
        let n0 = standIns().count
        _ = ask(["do": "marker", "sid": sid, "cwd": folder, "surfaceId": f.session.surfaceId])
        let started = wait(30) { self.standIns().count > n0 }
        let rec = standIns().dropFirst(n0).first ?? [:]
        guard started, let fresh = rec["pane"] as? String, let fsid = rec["sid"] as? String else { check("sb_handoff_tab_beside", false, "no fresh session started: \(rec)"); return }
        sbLandsOnFresh(from: key, sid: fsid, pane: fresh, check: "sb_handoff_tab_beside", picture: "sessb-handoff-tab", beside: pane)
    }

    // MARK: SESS-016: a session in a pane here that went on in another terminal: Move here resumes the latest in a new pane

    private func sbWentOn() {
        // A fresh session still on the board in its pane (closing a project's sessions may have ended one).
        let listed = { (r: [String: Any]) in self.board.hub.state?.projects.contains { $0.sessions.contains { $0.sessionId == r["sid"] as? String && $0.pane == r["pane"] as? String } } ?? false }
        let rec = [freshRec, autoRec].first(where: listed) ?? freshRec
        guard let sid = rec["sid"] as? String, let cwd = rec["cwd"] as? String, let pane = rec["pane"] as? String,
              wait(15, { self.board.hub.state?.projects.contains { $0.sessions.contains { $0.sessionId == sid && $0.pane == pane } } ?? false }) else {
            check("sb_went_on_said", false, "no fresh session in a pane: \(freshRec)"); return
        }
        _ = ask(["do": "wenton", "sid": sid, "cwd": cwd])
        func find() -> (key: String, s: HubSession)? {
            guard let p = board.hub.state?.projects.first(where: { $0.sessions.contains { $0.sessionId == sid && $0.movedOn != nil } }), let s = p.sessions.first(where: { $0.sessionId == sid && $0.movedOn != nil }) else { return nil }
            return ("\(p.id)/\(s.surfaceId)", s)
        }
        guard wait(30, { find() != nil }), let f = find() else {
            check("sb_went_on_said", false, "\(board.hub.state?.projects.flatMap { $0.sessions.filter { $0.sessionId == sid }.map { "\($0.surfaceId) movedOn \($0.raw["movedOn"] ?? "-") pane \($0.pane ?? "-")" } } ?? [])"); return
        }
        board.pickSession(f.key, why: "test")
        if !board.panelVisible { _ = self.key("b", [.command, .option]) }
        let said = wait(8) { self.board.render(force: true); return self.board.panel.buttons["move"] != nil && self.shows(self.board.panel, "cmux") }
        check("sb_went_on_said", said, texts(board.panel).prefix(10).joined(separator: " | "))
        pictures("sessb-went-on")
        let n0 = standIns().count
        if let b = board.panel.buttons["move"] { click(b) }
        check("sb_went_on_move_posted", wait(15) { self.board.hub.sentBodies.contains { $0.path == "/api/sessions/move" && $0.body["sessionId"] as? String == sid } && self.board.hub.inFlight == 0 })
        let resumed = wait(25) { self.standIns().dropFirst(n0).contains { (($0["args"] as? [String]) ?? []).contains(sid) && ($0["pane"] as? String) != pane } }
        check("sb_went_on_resumed_new_pane", resumed, "\(standIns().dropFirst(n0).map { "\($0["pane"] ?? "") \($0["args"] ?? "")" })")
    }

    // MARK: SESS-025 Hand off now, SESS-030 a row's and a project row's right-click menus

    private func sbHandOffMenus() {
        let sb = board.sidebar
        board.toTerminal()
        board.render(force: true)
        settle(0.4)
        // From the panel: Hand off now.
        guard let st = board.hub.state, let f = st.projects.lazy.compactMap({ p in p.sessions.first { $0.sessionId != nil && $0.ctx != nil && !$0.handoffQueued && $0.handoff?["state"] as? String != "written" && $0.handoff?["state"] as? String != "resumed" }.map { (p, $0) } }).first else {
            check("sb_handoff_panel_posted", false, "no session to hand off"); return
        }
        let key = "\(f.0.id)/\(f.1.surfaceId)"
        board.pickSession(key, why: "test")
        if !board.panelVisible { _ = self.key("b", [.command, .option]) }
        _ = wait(5) { self.board.panel.buttons["handoff"] != nil }
        if let b = board.panel.buttons["handoff"] { click(b) }
        check("sb_handoff_panel_posted", wait(8) { self.board.hub.sentBodies.contains { $0.path == "/api/handoff" && $0.body["surfaceId"] as? String == f.1.surfaceId } })
        check("sb_handoff_panel_queued", wait(15) { self.board.hub.state?.find(key)?.session.handoffQueued == true } && wait(5) { self.board.render(force: true); return self.board.panel.buttons["handoff"]?.isEnabled == false },
              "\(board.hub.state?.find(key)?.session.handoff ?? [:])")

        // A session row's menu: Open, Pin, Unpin, Hand off now, Open brief, Sessions and memory.
        board.toTerminal()
        board.render(force: true)
        settle(0.3)
        guard let g = board.hub.state?.projects.lazy.compactMap({ p in p.sessions.first { $0.sessionId != nil && $0.ctx != nil && !$0.handoffQueued && $0.handoff?["state"] as? String != "written" && $0.handoff?["state"] as? String != "resumed" && p.brief != nil && sb.rows["\(p.id)/\($0.surfaceId)"] != nil }.map { (p, $0) } }).first,
              let row = sb.rows["\(g.0.id)/\(g.1.surfaceId)"] else { check("sb_menu_open", false, "no row"); return }
        let k2 = "\(g.0.id)/\(g.1.surfaceId)"
        check("sb_menu_open", pickItem(row.menuItems?(), t("sess.open")) && wait(4) { self.board.panel.key == k2 && sb.rows[k2]?.selected == true }, "\(board.front) panel \(board.panel.key)")
        check("sb_menu_pin", pickItem(sb.rows[k2]?.menuItems?(), t("side.pin")) && board.pinned.contains(k2), "pinned \(board.pinned)")
        check("sb_menu_unpin", pickItem(sb.rows[k2]?.menuItems?(), t("side.unpin")) && !board.pinned.contains(k2), "pinned \(board.pinned)")
        _ = pickItem(sb.rows[k2]?.menuItems?(), t("session.handOffNow"))
        check("sb_menu_handoff_posted", wait(8) { self.board.hub.sentBodies.contains { $0.path == "/api/handoff" && $0.body["surfaceId"] as? String == g.1.surfaceId } })
        check("sb_menu_handoff_queued", wait(15) { self.board.hub.state?.find(k2)?.session.handoffQueued == true }, "\(board.hub.state?.find(k2)?.session.handoff ?? [:])")
        check("sb_menu_open_brief", pickItem(sb.rows[k2]?.menuItems?(), t("panel.openBrief")) && wait(4) { if case .brief(let id, _) = self.board.front { return id == g.0.id }; return false }, "\(board.front)")
        check("sb_menu_sessions", pickItem(sb.rows[k2]?.menuItems?(), t("sess.manage")) && wait(4) { self.board.front == .page("sessions", t("sess.title")) }, "\(board.front)")

        // A project row's menu: Open, Open brief, Close its sessions, Sessions and memory, New project.
        board.toTerminal()
        board.render(force: true)
        settle(0.3)
        guard let pk = sb.rows.keys.sorted().first(where: { $0.hasPrefix("project:") && board.hub.state?.project(String($0.dropFirst(8)))?.brief != nil }) else { check("sb_project_menu_open", false, "no project row: \(sb.rows.keys.sorted())"); return }
        let pid = String(pk.dropFirst(8))
        check("sb_project_menu_open", pickItem(sb.rows[pk]?.menuItems?(), t("sess.open")) && wait(4) { self.board.panel.key == pk || self.board.front == .project(pid) || (self.board.frontKey ?? "").hasPrefix("\(pid)/") }, "\(board.front)")
        check("sb_project_menu_open_brief", pickItem(sb.rows[pk]?.menuItems?(), t("panel.openBrief")) && wait(4) { if case .brief(let id, _) = self.board.front { return id == pid }; return false }, "\(board.front)")
        check("sb_project_menu_sessions", pickItem(sb.rows[pk]?.menuItems?(), t("sess.manage")) && wait(4) { self.board.front == .page("sessions", t("sess.title")) }, "\(board.front)")
        board.toTerminal(); board.render(force: true); settle(0.3)
        check("sb_project_menu_new_project", pickItem(sb.rows[pk]?.menuItems?(), t("side.newProjectDots")) && wait(4) { "\(self.board.front)".contains("newproject") }, "\(board.front)")
        // Close its sessions, on a project row whose sessions can go (a project at rest with its process).
        board.toTerminal(); board.render(force: true); settle(0.3)
        // Quiet for 36 s, a session in a Ravenry pane is idle and can go (the fresh sessions just started).
        var closable: String?
        _ = wait(60) {
            self.board.render(force: true)
            closable = sb.rows.keys.sorted().first { k in
                guard k.hasPrefix("project:"), let m = sb.rows[k]?.menuItems?() else { return false }
                return m.items.contains { $0.title.hasPrefix("Close") && $0.isEnabled }
            }
            return closable != nil
        }
        if let ck = closable, let m = sb.rows[ck]?.menuItems?(), let item = m.items.first(where: { $0.title.hasPrefix("Close") && $0.isEnabled }) {
            let cid = String(ck.dropFirst(8))
            let ids = board.hub.state?.sessionProcs.filter { $0.projectId == cid && $0.canClose }.compactMap(\.sessionId) ?? []
            let title = item.title
            if let a = item.action { NSApp.sendAction(a, to: item.target, from: item) }
            check("sb_project_menu_close_posted", wait(8) { self.board.hub.sentBodies.contains { $0.path == "/api/sessions/close" && Set(($0.body["ids"] as? [String]) ?? []) == Set(ids) } }, "\(title): \(ids)")
            check("sb_project_menu_closed", wait(30) { !(self.board.hub.state?.sessionProcs.contains { ids.contains($0.sessionId ?? "-") } ?? true) }, "\(board.hub.state?.sessionProcs.filter { $0.projectId == cid }.map(\.label) ?? [])")
        } else {
            check("sb_project_menu_close_posted", false, "no project row with sessions that can close: " + sb.rows.keys.filter { $0.hasPrefix("project:") }.map { k in "\(k) [\(sb.rows[k]?.menuItems?()?.items.map { "\($0.title)\($0.isEnabled ? "" : " (off)")" }.joined(separator: ", ") ?? "")]" }.joined(separator: "; "))
        }
    }

    // MARK: SESS-034: the pin on hover, the tooltip

    private func sbRowHover() {
        let sb = board.sidebar
        board.toTerminal(); board.render(force: true); settle(0.3)
        guard let key = sb.rows.keys.sorted().first(where: { $0.contains("/") && !board.pinned.contains($0) && sb.pins[$0] != nil }), let row = sb.rows[key], let r = board.hub.state?.sections.flatMap({ $0.projects.flatMap(\.rows) }).first(where: { $0.key == key }) else {
            check("sb_hover_pin", false, "no unpinned row"); return
        }
        let before = (sb.pins[key]?.isHidden ?? false, sb.pcs[key]?.isHidden ?? true)
        hover(row, .mouseEntered)
        let during = (sb.pins[key]?.isHidden ?? true, sb.pcs[key]?.isHidden ?? false)
        picture("native-sessb-hover-1280-dark.png")
        hover(row, .mouseExited)
        let after = (sb.pins[key]?.isHidden ?? false, sb.pcs[key]?.isHidden ?? true)
        check("sb_hover_pin", before == (true, false) && during == (false, true) && after == (true, false), "pin hidden/percent hidden: before \(before), over \(during), after \(after)")
        let tip = [r.name, r.mark?.text ?? r.line].compactMap { $0 }.joined(separator: "\n")
        check("sb_row_tooltip", row.toolTip == tip && !(row.toolTip ?? "").isEmpty, row.toolTip ?? "none")
    }

    // MARK: SESS-033: New project last, the fade and the scroller with more rows below

    private func sbListEnd() {
        let sb = board.sidebar
        board.toTerminal(); board.render(force: true); settle(0.3)
        guard let np = sb.newProjectButton else { check("sb_new_project_row_opens", false, "no New project row"); return }
        click(np)
        check("sb_new_project_row_opens", wait(4) { "\(self.board.front)".contains("newproject") }, "\(board.front)")
        board.toTerminal()
        let f0 = sb.flashes
        size(1280, 480)
        board.render(force: true)
        settle(0.6)
        let sv = sb.listView
        let more = (sv.documentView?.frame.height ?? 0) > sv.contentView.bounds.height + 2
        check("sb_list_fade_below", more && sb.fadeShown && sv.hasVerticalScroller, "rows \(Int(sv.documentView?.frame.height ?? 0)) pt in \(Int(sv.contentView.bounds.height)); fade \(sb.fadeShown)")
        // A change of the rows draws the list again: the scroller flashes.
        board.hub.testPatch = { st in var st = st; st["generatedAt"] = ISO8601DateFormatter().string(from: Date()); return st }
        board.render(force: true)
        settle(0.6)
        check("sb_list_scroller_flashed", sb.flashes > f0, "flashed \(sb.flashes - f0) times")
        picture("native-sessb-fade-1280-dark.png")
        // Scrolled to its end: the fade goes, and New project is the last row.
        sv.contentView.scroll(to: NSPoint(x: 0, y: max(0, (sv.documentView?.frame.height ?? 0) - sv.contentView.bounds.height)))
        sv.reflectScrolledClipView(sv.contentView)
        settle(0.3)
        check("sb_list_fade_gone_at_end", !sb.fadeShown, "fade \(sb.fadeShown)")
        board.hub.testPatch = nil
        size(1280, 820)
    }

    // MARK: SESS-019: a question's toast stays until it is answered

    private func sbQuestionToast() {
        board.toTerminal()
        board.toastStack.clear()
        settle(0.3)
        let working = board.hub.state?.projects.filter { p in p.sessions.contains { $0.group == "work" && $0.pane == nil && $0.sessionId != nil } }.map(\.id) ?? []
        let candidates = working + ["paper-boat", "notes-app", "garden-planner", "recipe-box", "weather-widget"]
        guard let pid = ask(["do": "arrive", "projects": candidates, "question": "Paint the lamp room red, or white?"])?["project"] as? String else { check("sb_question_toast_stays", false, "no arrival: \(SelfTestBoard.lastAnswer)"); return }
        let key = wait(20, { self.board.hub.state?.project(pid)?.sessions.contains { self.board.hub.state?.sidebar(has: "\(pid)/\($0.surfaceId)", in: "you") ?? false } ?? false })
            ? board.hub.state?.project(pid)?.sessions.first(where: { self.board.hub.state?.sidebar(has: "\(pid)/\($0.surfaceId)", in: "you") ?? false }).map { "\(pid)/\($0.surfaceId)" } : nil
        let l0 = board.log.count
        let shown = wait(10) { self.board.toastTexts.contains { $0.contains("Paint the lamp room") } }
        settle(14)
        let stays = board.toastTexts.contains { $0.contains("Paint the lamp room") }
        check("sb_question_toast_stays", key != nil && shown && stays, "on \(pid) \(key ?? "-"): shown \(shown), still there 14 s later \(stays); " + board.log.dropFirst(l0).filter { $0.hasPrefix("arrived") || $0.hasPrefix("toast") || $0.hasPrefix("state") }.prefix(6).joined(separator: " | "))
        // Answered (its next prompt): the toast goes.
        if let k = key, let sid = board.hub.state?.find(k)?.session.sessionId {
            _ = ask(["do": "events", "sid": sid, "events": [["event": "UserPromptSubmit", "prompt": "White"]]])
        }
        check("sb_question_toast_goes_answered", wait(20) { !self.board.toastTexts.contains { $0.contains("Paint the lamp room") } }, board.toastTexts.joined(separator: " | "))
    }

    // MARK: SESS-047: Discard a worktree session's copy

    private func sbDiscard() {
        // A session in its own copy: New session in a folder another session works in (SESS-010).
        // A demo project (a git repository) another session works in: the Start page offers its own copy.
        let st = board.start
        let n0 = standIns().count
        var picked: (HubProject, String)?
        for id in ["notes-app", "paper-boat", "garden-planner", "weather-widget"] {
            guard let p = board.hub.state?.project(id), let folder = p.folder, p.machine == nil else { continue }
            board.openStart(folder)
            _ = wait(8) { st.controls["go"] != nil && st.folder == folder }
            _ = wait(10) { self.shows(st, "Found") }
            if let l = st.controls["ownCopy"] as? NSView { click(l) }
            if shows(st, "It gets its own copy of the code") { picked = (p, folder); break }
        }
        guard let (p, folder) = picked else { check("sb_discard_worktree", false, "no folder another session works in: " + texts(st).prefix(8).joined(separator: " | ")); return }
        let s0 = board.hub.sent.count
        let said = texts(st).prefix(10).joined(separator: " | ") + " go \(st.go.isEnabled ? "on" : "off") in window \(st.go.window != nil)"
        // Start, pressed again if the page drew itself anew under the press (no toast over it).
        board.toastStack.clear()
        for _ in 0..<3 where !board.hub.sentBodies.dropFirst(0).contains(where: { $0.path == "/api/sessions/start" && $0.body["worktree"] as? Bool == true }) && st.setup == nil {
            _ = wait(5) { (st.controls["go"] as? RButton)?.window != nil && (st.controls["go"] as? RButton)?.isEnabled == true }
            if let g = st.controls["go"] as? RButton { click(g) }
            _ = wait(3) { st.setup != nil || self.board.hub.sentBodies.contains { $0.path == "/api/sessions/start" && $0.body["worktree"] as? Bool == true } }
        }
        _ = wait(4) { st.setup != nil || self.board.hub.sentBodies.contains { $0.path == "/api/sessions/start" && $0.body["worktree"] as? Bool == true } }
        if st.setup != nil, let b = st.controls["notNow"] as? NSView { click(b) }
        _ = wait(30) { self.board.hub.sentBodies.contains { $0.path == "/api/sessions/start" && $0.body["worktree"] as? Bool == true } && self.board.hub.inFlight == 0 }
        _ = wait(30) { self.standIns().count > n0 }
        let diag = "\(p.id): \(said); sent \(board.hub.sent.dropFirst(s0).joined(separator: ", ")) answered \(codes("/api/sessions/start", since: s0)); front \(board.front); "
        let rec = standIns().dropFirst(n0).first ?? [:]
        let pane = rec["pane"] as? String ?? ""
        let found = wait(25) { self.board.hub.state?.project(p.id)?.sessions.contains { $0.pane == pane && $0.worktree?["state"] as? String == "open" } ?? false }
        guard found, let s = board.hub.state?.project(p.id)?.sessions.first(where: { $0.pane == pane }), let wt = s.worktree, let branch = wt["branch"] as? String, let wfolder = wt["folder"] as? String else {
            check("sb_discard_worktree", false, diag + "no worktree session: \(rec); \(board.hub.state?.project(p.id)?.sessions.map { "\($0.pane ?? "-") \($0.worktree?["state"] ?? "-")" } ?? [])"); return
        }
        let g0 = ask(["do": "git", "repo": folder]) ?? [:]
        check("sb_discard_worktree", (g0["worktrees"] as? String ?? "").contains(wfolder.replacingOccurrences(of: "/private/var", with: "/var")) || (g0["worktrees"] as? String ?? "").contains((wfolder as NSString).lastPathComponent),
              "\(branch) at \(wfolder); git: \((g0["worktrees"] as? String ?? "").replacingOccurrences(of: "\n", with: " / "))")
        let key = "\(p.id)/\(s.surfaceId)"
        board.pickSession(key, why: "test")
        if !board.panelVisible { _ = self.key("b", [.command, .option]) }
        let ok = wait(10) { self.board.render(force: true); return self.board.worktrees.buttons["discard"] != nil }
        guard ok, let d = board.worktrees.buttons["discard"] else { check("sb_discard_offered", false, texts(board.panel).prefix(20).joined(separator: " | ")); return }
        check("sb_discard_offered", true)
        click(d)
        check("sb_discard_asks", wait(4) { self.board.render(force: true); return self.board.worktrees.buttons["discardYes"] != nil } && shows(board.panel, "without merging"), texts(board.panel).prefix(20).joined(separator: " | "))
        pictures("sessb-discard")
        if let y = board.worktrees.buttons["discardYes"] { click(y) }
        check("sb_discard_posted", wait(20) { self.board.hub.sentBodies.contains { $0.path.hasSuffix("/discard") } && self.board.hub.inFlight == 0 })
        let g1 = ask(["do": "git", "repo": folder]) ?? [:]
        let short = branch
        check("sb_discard_gone", !(g1["worktrees"] as? String ?? "").contains((wfolder as NSString).lastPathComponent) && !(g1["branches"] as? String ?? "").contains(short) && (g1["head"] as? String) == (g0["head"] as? String),
              "worktrees: \((g1["worktrees"] as? String ?? "").replacingOccurrences(of: "\n", with: " / ")); branches: \((g1["branches"] as? String ?? "").replacingOccurrences(of: "\n", with: " ")); main \(g1["head"] ?? "-") was \(g0["head"] ?? "-")")
    }

    // MARK: --screen sessb2: no board at the start, then it comes up (SESS-032)

    func screenSessB2() {
        let sb = board.sidebar
        settle(2)
        // A first run with no tab: the shell the window opened, closed from its tab's x.
        for tb in board.ws.tabs { board.ws.bar.onClose?(tb.id) }
        _ = wait(5) { self.board.ws.tabs.isEmpty }
        board.render(force: true)
        settle(0.3)
        check("sb2_board_down_line", sb.emptyText == t("side.emptyNoBoard") && !board.hub.reachable, sb.emptyText ?? "no line")
        let shown = sb.footButtons.filter { $0.value.window != nil && !$0.value.isHiddenOrHasHiddenAncestor }.keys.sorted()
        func alpha(_ v: NSView?) -> CGFloat { var a: CGFloat = 1; var x = v; while let y = x { a *= y.alphaValue; x = y.superview }; return a }
        let pageAlpha = sb.rows.filter { $0.key.hasPrefix("page:") }.map { alpha($0.value) }
        check("sb2_first_run_dimmed", sb.firstRun && board.ws.tabs.isEmpty && shown == ["side.learn", "side.machines", "side.settings"] && !pageAlpha.isEmpty && pageAlpha.allSatisfy { $0 < 0.6 },
              "first run \(sb.firstRun), tabs \(board.ws.tabs.count), foot shown \(shown), pages' alpha \(pageAlpha)")
        picture("native-sessb2-down-1280-dark.png")
        // The panel with nothing in front: its pick line.
        board.panel.update(state: board.hub.state, front: nil, pane: nil, force: true)
        check("sb2_panel_pick_line", board.panel.shows == "none" && shows(board.panel, t("panel.pick")), texts(board.panel).joined(separator: " | "))
        _ = ask(["do": "hubup"], timeout: 60)
        check("sb2_line_changes_with_board", wait(30) { self.board.render(force: true); return self.board.hub.reachable && sb.emptyText != t("side.emptyNoBoard") }, sb.emptyText ?? "rows")
        picture("native-sessb2-up-1280-dark.png")
    }

    // The screen's own state between its parts.
    private var reviveKey: String? { get { SBState.reviveKey } set { SBState.reviveKey = newValue } }
    private var revivePane: String? { get { SBState.revivePane } set { SBState.revivePane = newValue } }
    private var codexPane: String? { get { SBState.codexPane } set { SBState.codexPane = newValue } }
    private var freshRec: [String: Any] { get { SBState.freshRec } set { SBState.freshRec = newValue } }
    private var autoRec: [String: Any] { get { SBState.autoRec } set { SBState.autoRec = newValue } }
    private var newPane: String? { get { SBState.newPane } set { SBState.newPane = newValue } }
    private var reasonScreenLater: Bool { get { SBState.reasonScreenLater } set { SBState.reasonScreenLater = newValue } }
}

private enum SBState {
    static var reviveKey: String?
    static var revivePane: String?
    static var codexPane: String?
    static var reasonScreenLater = false
    static var newPane: String?
    static var freshRec: [String: Any] = [:]
    static var autoRec: [String: Any] = [:]
}

/// A drop as AppKit hands it to a view: its pasteboard.
private final class SBDrag: NSObject, NSDraggingInfo {
    let draggingPasteboard: NSPasteboard
    let draggingDestinationWindow: NSWindow?
    init(pasteboard: NSPasteboard, window: NSWindow) { draggingPasteboard = pasteboard; draggingDestinationWindow = window }
    var draggingSourceOperationMask: NSDragOperation { .copy }
    var draggingLocation: NSPoint { NSPoint(x: 100, y: 100) }
    var draggedImageLocation: NSPoint { .zero }
    var draggedImage: NSImage? { nil }
    var draggingSource: Any? { nil }
    var draggingSequenceNumber: Int { 1 }
    func slideDraggedImage(to screenPoint: NSPoint) {}
    var draggingFormation: NSDraggingFormation = .default
    var animatesToDestination = false
    var numberOfValidItemsForDrop = 1
    func enumerateDraggingItems(options enumOpts: NSDraggingItemEnumerationOptions = [], for view: NSView?, classes classArray: [AnyClass],
                                searchOptions: [NSPasteboard.ReadingOptionKey: Any] = [:],
                                using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
    var springLoadingHighlight: NSSpringLoadingHighlight { .none }
    func resetSpringLoading() {}
}
