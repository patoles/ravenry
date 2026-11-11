// Onboarding checks of the 2026-11-11 audit, on real panes of the test's
// daemon (sidetest --screen learn, called from screenLearn):
//
// - ONB-005: Try it on a card with a message: the hub's start answers with a
//   pane of this window (a shell at its prompt standing in for the assistant,
//   through testPostAnswers: the demo hub's fake cmux makes no pane); the
//   message lands on its input line once its screen is still, and is not run.
// - ONB-010: Try it's ways of failing in words: the hub refusing the start,
//   no Claude Code and no Codex, and a pane that never settles: after 40 s
//   the message is on the clipboard and the toast says so.

import AppKit

extension SelfTestBoard {
    /// A new tab of this window running `command` (a shell when nil); its pane once drawn.
    private func newPaneTab(_ command: [String]?) -> String? {
        let ws = board.ws
        let before = Set(ws.tabs.map { $0.host })
        ws.newTab(in: nil, program: command.map { Workspace.Program(command: $0, name: "stand-in", agent: nil) })
        guard wait(8, { ws.tabs.contains { !before.contains($0.host) } }), let p = ws.tabs.first(where: { !before.contains($0.host) })?.host else { return nil }
        _ = wait(8) { !(ws.boxes[p]?.term.screen.text().trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) }
        return p
    }
    private func paneText(_ p: String) -> String { board.ws.boxes[p]?.term.screen.text() ?? "" }

    func learnTryChecks() {
        let pg = board.learn
        let hub = board.hub
        let msg = t("learn.panes.message")
        let flat = { (s: String) in s.replacingOccurrences(of: "\n", with: "").replacingOccurrences(of: " ", with: "") }
        // ONB-005: the message ready in the input, not sent.
        guard let shell = newPaneTab(nil) else { check("learn_try_pane", false, "no new shell"); return }
        hub.testPostAnswers["/api/sessions/start"] = (200, ["ok": true, "pane": ["id": shell]])
        board.openLearn()
        var L = board.log.count
        pg.buttons["try-panes"]?.performClick(nil)
        check("learn_try_message_in_input", wait(12) { self.board.log.dropFirst(L).contains("try: message ready in \(shell)") } && wait(4) { flat(self.paneText(shell)).contains(flat(String(msg.prefix(40)))) },
              paneText(shell).suffix(300).description)
        settle(2.5)
        let after = paneText(shell)
        check("learn_try_message_not_sent", board.front == .tab && !after.contains("command not found") && !after.contains("zsh: ") && after.components(separatedBy: "~ > ").count == 2,
              after.suffix(300).description)
        // ONB-010: the hub refuses the start: its words.
        hub.testPostAnswers["/api/sessions/start"] = (500, ["error": "the folder is gone"])
        board.openLearn()
        L = board.log.count
        pg.buttons["try-panes"]?.performClick(nil)
        check("learn_try_failed_words", wait(6) { self.toasts(since: L).contains(t("learn.failed", ["why": "the folder is gone"])) }, toasts(since: L).joined(separator: ","))
        // No Claude Code and no Codex on this Mac.
        hub.testAnswers["/api/setup/start"] = ["ok": true, "folders": [], "assistants": [["kind": "claude", "found": false], ["kind": "codex", "found": false]]]
        board.openLearn()
        L = board.log.count
        let n = hub.sent.count
        pg.buttons["try-panes"]?.performClick(nil)
        check("learn_try_no_assistant_words", wait(6) { self.toasts(since: L).contains(t("learn.noAssistant")) } && !sentSince(n).contains("POST /api/sessions/start"), toasts(since: L).joined(separator: ","))
        hub.testAnswers["/api/setup/start"] = nil
        // A pane that never settles: the clipboard after 40 s.
        guard let busy = newPaneTab(["/bin/sh", "-c", "while :; do date +%s.%N; sleep 0.2; done"]) else { check("learn_try_busy_pane", false); return }
        hub.testPostAnswers["/api/sessions/start"] = (200, ["ok": true, "pane": ["id": busy]])
        board.openLearn()
        L = board.log.count
        let o = Outside.record?.count ?? 0
        let t0 = Date()
        pg.buttons["try-panes"]?.performClick(nil)
        let fell = wait(50) { self.toasts(since: L).contains(t("learn.onClipboard")) }
        let secs = Date().timeIntervalSince(t0)
        check("learn_try_clipboard_after_40s", fell && secs >= 40 && (Outside.record?.dropFirst(o).contains("copy \(msg)") ?? false) && !flat(paneText(busy)).contains(flat(String(msg.prefix(40)))),
              String(format: "%.1f s, toasts %@", secs, toasts(since: L).joined(separator: ",")))
        hub.testPostAnswers["/api/sessions/start"] = nil
        // The board not running.
        hub.testDown = true
        board.openLearn()
        L = board.log.count
        let n2 = hub.sent.count
        pg.buttons["try-panes"]?.performClick(nil)
        check("learn_try_no_board_words", wait(4) { self.toasts(since: L).contains(t("learn.noBoard")) } && !sentSince(n2).contains("POST /api/sessions/start"), toasts(since: L).joined(separator: ","))
        hub.testDown = false
        // The filmstrip's card with no terminal open.
        for tb in board.ws.tabs { board.ws.closeTab(tb) }
        _ = wait(6) { self.board.ws.tabs.isEmpty }
        board.openLearn()
        L = board.log.count
        pg.buttons["try-film"]?.performClick(nil)
        check("learn_try_film_needs_words", board.ws.tabs.isEmpty && wait(3) { self.toasts(since: L).contains(t("learn.filmNeeds")) }, "\(board.ws.tabs.count) tabs, \(toasts(since: L))")
        board.ws.newTab(in: nil)
        _ = wait(6) { !self.board.ws.tabs.isEmpty }
    }
}

/// A drop as AppKit hands it to a view (performDragOperation), its files on a pasteboard of its own.
final class TestDrop: NSObject, NSDraggingInfo {
    let draggingPasteboard: NSPasteboard
    init(_ urls: [URL]) {
        draggingPasteboard = NSPasteboard(name: NSPasteboard.Name("ravenry-selftest-drop-\(UUID().uuidString)"))
        draggingPasteboard.clearContents()
        draggingPasteboard.writeObjects(urls as [NSURL])
    }
    var draggingDestinationWindow: NSWindow? { nil }
    var draggingSourceOperationMask: NSDragOperation { .copy }
    var draggingLocation: NSPoint { .zero }
    var draggedImageLocation: NSPoint { .zero }
    var draggedImage: NSImage? { nil }
    var draggingSource: Any? { nil }
    var draggingSequenceNumber: Int { 1 }
    func slideDraggedImage(to screenPoint: NSPoint) {}
    var draggingFormation: NSDraggingFormation = .default
    var animatesToDestination = false
    var numberOfValidItemsForDrop = 1
    func enumerateDraggingItems(options enumOpts: NSDraggingItemEnumerationOptions = [], for view: NSView?, classes classArray: [AnyClass], searchOptions: [NSPasteboard.ReadingOptionKey: Any] = [:], using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
    var springLoadingHighlight: NSSpringLoadingHighlight { .none }
    func resetSpringLoading() {}
}

extension SelfTestBoard {
    /// ONB-009 with the board down (sidetest --screen startlocal, after its own
    /// checks): a folder dropped on New session is picked and Start runs there;
    /// with no Claude Code and no Codex on the PATH, the button opens a shell.
    func startLocalDropAndShell(_ st: StartView, home: String) {
        func real(_ p: String?) -> String? { p.map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path } }
        let fm = FileManager.default
        let dropped = "\(home)/Elsewhere/gamma"
        try? fm.createDirectory(atPath: dropped, withIntermediateDirectories: true)
        board.openStart(nil)
        _ = wait(3) { st.local }
        let drop = TestDrop([URL(fileURLWithPath: dropped)])
        let took = st.draggingEntered(drop) == .copy && st.performDragOperation(drop)
        check("local_drop_folder_picked", took && wait(3) { st.folder == dropped && st.go.title == "Start Claude in gamma" }, "\(st.folder ?? "-") \(st.go.title)")
        let fileDrop = TestDrop([URL(fileURLWithPath: "\(home)/.claude.json")])
        check("local_drop_file_refused", st.draggingEntered(fileDrop) == [] && !st.performDragOperation(fileDrop) && st.folder == dropped)
        var n = board.ws.tabs.count
        let sent0 = board.hub.sentBodies.count
        click(st.go)
        check("local_drop_started_there", wait(5) { self.board.ws.tabs.count == n + 1 && self.board.front == .tab } && board.ws.paneInfo(board.ws.active?.host ?? "")?.cwd == dropped
              && !board.hub.sentBodies.dropFirst(sent0).contains { $0.path == "/api/sessions/start" }, "\(board.ws.paneInfo(board.ws.active?.host ?? "")?.cwd ?? "-")")
        // No assistant on the PATH.
        st.localEnv = ["PATH": "/usr/bin:/bin"]
        board.openStart(nil)
        _ = wait(3) { st.local }
        let beta = "\(home)/Projects/beta"
        if st.folder != beta, let r = st.controls["folder:\(beta)"] { click(r) }
        check("local_no_assistant_shell_offered", wait(3) { st.go.title == "Open a shell in beta" }, st.go.title)
        pictures("start-local-no-assistant")
        n = board.ws.tabs.count
        click(st.go)
        let pane = { self.board.ws.active?.host ?? "" }
        check("local_no_assistant_shell_opens", wait(5) { self.board.ws.tabs.count == n + 1 && self.board.front == .tab } && real(board.ws.paneInfo(pane())?.cwd) == real(beta)
              && board.ws.paneInfo(pane())?.labels["ravenry.agent"] == nil && !board.hub.sentBodies.dropFirst(sent0).contains { $0.path == "/api/sessions/start" },
              "\(board.ws.paneInfo(pane())?.command ?? []) \(board.ws.paneInfo(pane())?.cwd ?? "-")")
    }
}

extension SelfTestBoard {
    /// ONB-006, the first run (--screen proofs): New session's step 2 answered Not now, the hub's mark posted.
    func onbStep2Answered() {
        let st = board.start
        board.openStart(nil)
        _ = wait(6) { st.controls["go"] != nil && st.folder != nil }
        click(st.go)
        let shown = wait(8) { st.setup != nil }
        let n = board.hub.sentBodies.count
        if let b = st.controls["notNow"] { click(b) }
        check("onb_step2_answered_first_run", shown && wait(8) { self.board.hub.sentBodies.dropFirst(n).contains { $0.path == "/api/onboarding" && $0.body["setup"] != nil } }
              && board.hub.answers.contains { $0.path == "/api/onboarding" && $0.code == 200 }, "shown \(shown) \(board.hub.sentBodies.dropFirst(n).map(\.path))")
        _ = wait(6) { self.board.hub.inFlight == 0 }
    }

    /// ONB-006, the app again on the same board (--screen proofs2): Learn did not open by itself, and
    /// New session's Start goes straight to the hub's start, with no step 2.
    func onbRelaunchLearnAndStep2() {
        check("onb_relaunch_learn_closed", board.front != .page("side.learn", t("learn.title")) && !board.log.contains("learn") && board.root.middle !== board.learn, "\(board.front)")
        let st = board.start
        board.openStart(nil)
        _ = wait(6) { st.controls["go"] != nil && st.folder != nil }
        let n = board.hub.sentBodies.count
        var sawStep2 = false
        click(st.go)
        let started = wait(10) { if st.setup != nil { sawStep2 = true }; return self.board.hub.sentBodies.dropFirst(n).contains { $0.path == "/api/sessions/start" } }
        check("onb_relaunch_no_step2", started && !sawStep2 && st.setup == nil && !board.hub.sentBodies.dropFirst(n).contains { $0.path == "/api/onboarding" },
              "\(board.hub.sentBodies.dropFirst(n).map(\.path)) step2 \(sawStep2)")
        _ = wait(6) { self.board.hub.inFlight == 0 }
    }
}

extension SelfTestBoard {
    /// ONB-003: a one-time hint inside its region at 1440 x 900, 1024 x 700 and 720 x 480: whole, not
    /// cut by the region's edges, its words and its x on screen. `hint` and `region` are read again at
    /// each size (the views may be drawn again).
    func hintInRegion(_ name: String, hint: @escaping () -> NSView?, region: @escaping () -> NSView?) {
        var bad: [String] = []
        for (w, h) in [(CGFloat(1440), CGFloat(900)), (1024, 700), (720, 480)] {
            size(w, h)
            board.render(force: true)
            settle(0.5)
            guard let hv = hint(), let rv = region(), hv.window != nil else { bad.append("\(Int(w))x\(Int(h)): not shown"); continue }
            let r = hv.convert(hv.bounds, to: rv)
            let inside = rv.bounds.insetBy(dx: -0.5, dy: -0.5).contains(r)
            // Its visible part: what the scroll views around it leave (a hint scrolled off is not whole).
            let vis = hv.visibleRect
            let seen = vis.intersection(hv.bounds)
            let whole = abs(seen.width - hv.bounds.width) < 1 && abs(seen.height - hv.bounds.height) < 1
            if !inside || !whole || r.width < 120 { bad.append("\(Int(w))x\(Int(h)): \(r.integral) in \(rv.bounds.integral) visible \(vis.integral)") }
            if w == 720 { picture("native-\(name)-720.png") }
        }
        size(1280, 820)
        board.render(force: true)
        settle(0.3)
        check("\(name)_inside_region_1440_to_720", bad.isEmpty, bad.joined(separator: "; "))
    }
}

extension SelfTestBoard {
    /// A11Y-007 on a page drawn from the hub (Alerts, a FormPage as Machines, Ideas and the
    /// others are): a new answer from the hub draws it again; what was typed, the keyboard, the
    /// selection and the place scrolled to stay.
    func formKeepsTyping(_ pg: AlertsPage) {
        _ = wait(5) { pg.busy.isEmpty }
        size(900, 520)
        if pg.open != "telegram" { pg.buttons["telegram-toggle"]?.performClick(nil) }
        guard let f = pg.fields["tg"] else { check("a11y_form_field", false); return }
        typeIn(f, "123456:ABC typed here")
        f.field.currentEditor()?.selectedRange = NSRange(location: 7, length: 3)
        let clip = pg.scroll.contentView
        let room = (pg.scroll.documentView?.frame.height ?? 0) - clip.bounds.height
        clip.scroll(to: NSPoint(x: 0, y: min(40, max(0, room)))); pg.scroll.reflectScrolledClipView(clip)
        let y0 = clip.bounds.origin.y
        // A new state from the hub: the last Mac notification changed.
        var j = pg.setup ?? [:]
        j["desktop"] = ["enabled": true, "last": ["at": ISO8601DateFormatter().string(from: Date()), "ok": true]]
        let field0 = f.field
        pg.apply(j)
        settle(0.3)
        let ed = window.firstResponder as? NSTextView
        check("a11y_form_typing_kept_through_hub_state", pg.fields["tg"]?.text == "123456:ABC typed here" && ed != nil && ed?.delegate === pg.fields["tg"]?.field
              && ed?.selectedRange() == NSRange(location: 7, length: 3) && abs(clip.bounds.origin.y - y0) < 1 && room > 0,
              "text \(pg.fields["tg"]?.text ?? "") responder \(String(describing: window.firstResponder)) sel \(ed.map { NSStringFromRange($0.selectedRange()) } ?? "-") y \(y0) to \(clip.bounds.origin.y) room \(room) same field \(field0 === pg.fields["tg"]?.field)")
        pg.clear("tg")
        window.makeFirstResponder(nil)
        size(1280, 820)
    }
}
