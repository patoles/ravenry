// The panel's Reply (sidetest.mjs --screen reply; SESS-026, SESS-036,
// SESS-045): it shows only for a session this window cannot type into, one
// in another terminal (here the demo's cmux, whose surfaces play Claude
// Code's prompt box, fake-cmux "prompts") or one shown read only; for a
// session in a pane this window draws it is not there, the terminal is how
// to type there. On a cmux session: a file dropped on the box is saved in the
// project's .inbox, the words typed and Send go to the hub (200) with its
// path (sidetest.mjs reads what the prompt box got); over half-typed text in
// its prompt the hub refuses (409) and the box says so; cleared (at arrival
// 1 the driver empties that prompt), the same reply goes.

import AppKit

/// A drop as AppKit hands it to a view: its pasteboard.
private final class ReplyDrag: NSObject, NSDraggingInfo {
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

extension SelfTestBoard {
    private func replyBox() -> ReplyBox? {
        func walk(_ v: NSView) -> ReplyBox? {
            if let b = v as? ReplyBox, !b.isHiddenOrHasHiddenAncestor { return b }
            for s in v.subviews { if let f = walk(s) { return f } }
            return nil
        }
        return walk(board.panel)
    }
    private func replyType(_ s: String) {
        guard let b = replyBox() else { return }
        b.field.stringValue = ""
        window.makeFirstResponder(b.field)
        b.field.currentEditor()?.insertText(s)
        settle(0.2)
    }

    func screenReply() {
        let b = board, hub = board.hub
        // A session in a pane this window draws: its tab in front, no Reply in its panel.
        let pane = b.ws.tabs.first?.host ?? ""
        hub.testPatch = { st in
            var st = st
            var ps = st["projects"] as? [[String: Any]] ?? []
            for i in ps.indices where ps[i]["id"] as? String == "notes-app" {
                var ss = ps[i]["sessions"] as? [[String: Any]] ?? []
                if !ss.isEmpty { ss[0]["pane"] = pane; ss[0]["term"] = "ravenry" }
                ps[i]["sessions"] = ss
            }
            st["projects"] = ps
            return st
        }
        hub.testCheckpoints = []
        let paneKey = hub.state?.project("notes-app")?.sessions.first.map { "notes-app/\($0.surfaceId)" } ?? ""
        b.pickSession(paneKey, why: "test")
        settle(0.5)
        b.render(force: true)
        settle(0.3)
        let ps = hub.state?.find(paneKey)?.session
        check("reply_pane_session_in_its_tab", b.front == .tab && ps?.pane == pane && b.panel.key == paneKey && ps.map { ReplyBox.canType(hub.state!, $0) } == true,
              "front \(b.front), panel \(b.panel.key), pane \(ps?.pane ?? "-")")
        check("reply_pane_session_no_box", replyBox() == nil, texts(b.panel).prefix(14).joined(separator: " | "))
        pictures("reply-pane-session")
        hub.testPatch = nil
        hub.testCheckpoints = nil

        // A session in cmux: the box, a file dropped, words typed, Send.
        let k1 = "garden-planner/sf-1"
        b.pickSession(k1, why: "test")
        check("reply_outside_box", wait(8) { b.render(force: true); return self.replyBox() != nil } && b.front == .session(k1), "\(b.front): " + texts(b.panel).prefix(12).joined(separator: " | "))
        guard let box = replyBox() else { return }
        let png = URL(fileURLWithPath: out).deletingLastPathComponent().appendingPathComponent("old-page.png")
        try? FileManager.default.removeItem(at: png)
        if let img = NSImage(size: NSSize(width: 40, height: 30), flipped: false, drawingHandler: { r in NSColor.systemTeal.setFill(); r.fill(); return true }).tiffRepresentation,
           let rep = NSBitmapImageRep(data: img), let d = rep.representation(using: .png, properties: [:]) { try? d.write(to: png) }
        let pb = NSPasteboard(name: NSPasteboard.Name("reply-drop-\(ProcessInfo.processInfo.processIdentifier)"))
        pb.clearContents()
        pb.writeObjects([png as NSURL])
        let dropped = box.performDragOperation(ReplyDrag(pasteboard: pb, window: window))
        pb.releaseGlobally()
        let saved = wait(10) { (ReplyBox.files[k1] ?? []).contains { !$0.pending && $0.path != nil } }
        let path = ReplyBox.files[k1]?.first?.path ?? ""
        check("reply_attach_saved_in_inbox", dropped && saved && path.contains("garden-planner/.inbox/old-page"), "dropped \(dropped), saved \(saved): \(path)")
        replyType("Use the photo of the old page")
        check("reply_typed", replyBox()?.field.stringValue == "Use the photo of the old page", replyBox()?.field.stringValue ?? "no box")
        pictures("reply-outside")
        var s0 = hub.sent.count
        if let sb = replyBox()?.sendButton { _ = sb.accessibilityPerformPress() }
        check("reply_posted", wait(15) { self.codes("/api/send", since: s0) == [200] }
              && hub.sentBodies.contains { $0.path == "/api/send" && ($0.body["paths"] as? [String]) == [path] && ($0.body["text"] as? String ?? "").contains("Use the photo of the old page") },
              "the hub \(codes("/api/send", since: s0))")
        // The demo's paper-boat waits with "abc" half typed in its prompt: refused, said under the box, nothing typed.
        let k3 = "paper-boat/sf-3"
        b.pickSession(k3, why: "test")
        _ = wait(8) { b.render(force: true); return self.replyBox() != nil }
        replyType("Go ahead")
        s0 = hub.sent.count
        if let sb = replyBox()?.sendButton { _ = sb.accessibilityPerformPress() }
        _ = wait(15) { !self.codes("/api/send", since: s0).isEmpty }
        let refusal = ReplyBox.errors[k3] ?? ""
        check("reply_half_typed_refused", codes("/api/send", since: s0) == [409] && refusal.contains("There is half-typed text in its prompt") && (replyBox().map { shows($0, "half-typed text") } ?? false),
              "the hub \(codes("/api/send", since: s0)): \(refusal)")
        pictures("reply-refused")
        // Cleared in its prompt (the driver), the same reply goes.
        check("reply_arrival", arrival(1))
        b.pickSession(k3, why: "test")
        _ = wait(5) { self.replyBox() != nil }
        if replyBox()?.field.stringValue.isEmpty ?? true { replyType("Go ahead") }
        s0 = hub.sent.count
        if let sb = replyBox()?.sendButton { _ = sb.accessibilityPerformPress() }
        check("reply_after_clear_posted", wait(15) { self.codes("/api/send", since: s0) == [200] }, "the hub \(codes("/api/send", since: s0)): \(ReplyBox.errors[k3] ?? "")")
    }
}
