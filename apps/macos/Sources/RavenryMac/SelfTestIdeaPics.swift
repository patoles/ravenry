// --screen idea: pictures dropped and pasted on an idea, and Kill (IDEA-008).
// A drop is AppKit's own call on the page with a pasteboard of the test's
// (never the person's clipboard), at a point over the reply field or over
// the idea's title; a paste is Cmd+V through the window with that pasteboard.
// Each must reach the hub (a ref's file comes only with its 200) and land: the picture
// with the next message, or the idea's picture changed in GET /api/ideas.

import AppKit

/// A drop as AppKit hands it to a view: its pasteboard and where it is (window points).
private final class IdeaDrop: NSObject, NSDraggingInfo {
    let draggingPasteboard: NSPasteboard
    let draggingDestinationWindow: NSWindow?
    let draggingLocation: NSPoint
    init(_ pb: NSPasteboard, _ w: NSWindow, at p: NSPoint) { draggingPasteboard = pb; draggingDestinationWindow = w; draggingLocation = p }
    var draggingSourceOperationMask: NSDragOperation { .copy }
    var draggedImageLocation: NSPoint { .zero }
    var draggedImage: NSImage? { nil }
    var draggingSource: Any? { nil }
    var draggingSequenceNumber: Int { 7 }
    func slideDraggedImage(to screenPoint: NSPoint) {}
    var draggingFormation: NSDraggingFormation = .default
    var animatesToDestination = false
    var numberOfValidItemsForDrop = 1
    func enumerateDraggingItems(options: NSDraggingItemEnumerationOptions = [], for view: NSView?, classes: [AnyClass], searchOptions: [NSPasteboard.ReadingOptionKey: Any] = [:], using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
    var springLoadingHighlight: NSSpringLoadingHighlight { .none }
    func resetSpringLoading() {}
}

extension SelfTestBoard {
    private func pngFile(_ name: String, _ c: NSColor) -> URL {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 120, pixelsHigh: 80, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        c.setFill(); NSRect(x: 0, y: 0, width: 120, height: 80).fill()
        NSGraphicsContext.restoreGraphicsState()
        let u = dir.appendingPathComponent(name)
        try? rep.representation(using: .png, properties: [:])?.write(to: u)
        return u
    }

    func ideaPicturesAndKill(_ pg: IdeaPage) {
        let hub = board.hub
        let pb = NSPasteboard(name: NSPasteboard.Name("ravenry-sidetest-idea-\(ProcessInfo.processInfo.processIdentifier)"))
        pg.pasteboard = pb
        defer { pg.pasteboard = .general; pb.releaseGlobally() }
        let item = { pg.ideas?.first { $0["id"] as? String == pg.id } }
        // A picture goes up as bytes (HubClient.postBytes), outside the posts the hub client logs: what lands is
        // the hub's answer itself (a ref's file only on its 200) and the idea's picture in GET /api/ideas.
        let took = { (n: Int, what: String) in what == "kill" ? hub.answers.contains { $0.seq >= n && $0.path == "/api/ideas/\(pg.id)/kill" && $0.code == 200 } : true }
        let idle = { _ = self.wait(20) { pg.busy.isEmpty && !pg.uploading } }
        // IDEA-010: the round asked for above, on a board with no Playwright Chromium (the test's HOME): it ends saying what is missing, with Try again.
        check("idea_round_without_chromium_says_why", wait(60) { self.texts(pg).contains { $0.contains("did not come back") && $0.contains("Chromium") } && pg.buttons["mkRetry"] != nil },
              texts(pg).filter { $0.contains("Round") }.joined(separator: " | "))
        window.contentView?.layoutSubtreeIfNeeded()
        let center = { (v: NSView) in v.convert(NSPoint(x: v.bounds.midX, y: v.bounds.midY), to: nil) }

        // Dropped on the reply field: it goes with the next message.
        idle()
        var n = hub.sent.count, refs = pg.refs.count
        pb.clearContents()
        pb.writeObjects([pngFile("drop-ref.png", .systemTeal) as NSURL])
        if let box = pg.fields["say"] { _ = pg.performDragOperation(IdeaDrop(pb, window, at: center(box))) }
        check("idea_drop_on_reply_goes_with_message", wait(10) { took(n, "ref") && pg.refs.count == refs + 1 }, "refs \(pg.refs.count) \(sentSince(n))")
        // Pasted (Cmd+V) in the reply field: the same.
        idle()
        n = hub.sent.count; refs = pg.refs.count
        pb.clearContents()
        pb.writeObjects([pngFile("paste-ref.png", .systemPink) as NSURL])
        if let f = pg.fields["say"]?.field { window.makeFirstResponder(f) }
        let cmdV = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: "v", charactersIgnoringModifiers: "v", isARepeat: false, keyCode: 9)!
        let pastedInReply = window.performKeyEquivalent(with: cmdV)
        check("idea_paste_in_reply_goes_with_message", pastedInReply && wait(10) { took(n, "ref") && pg.refs.count == refs + 1 }, "taken \(pastedInReply) refs \(pg.refs.count) \(sentSince(n))")
        settle(0.3)
        pictures("idea-refs")
        // Dropped anywhere else on the idea: its picture.
        idle()
        n = hub.sent.count
        let img0 = item()?["img"] as? String
        pb.clearContents()
        pb.writeObjects([pngFile("drop-cover.png", .systemOrange) as NSURL])
        let title = pg.scroll.stack.arrangedSubviews.first ?? pg
        _ = pg.performDragOperation(IdeaDrop(pb, window, at: center(title)))
        check("idea_drop_sets_picture", wait(10) { took(n, "image") } && wait(10) { pg.load(); return (item()?["img"] as? String).map { $0 != img0 } ?? false }, "img \(img0 ?? "nil") -> \(item()?["img"] as? String ?? "nil") \(sentSince(n))")
        // Pasted with the keyboard on the page, not in a field: its picture too, an image's own data (a screenshot copied).
        idle()
        n = hub.sent.count
        let img1 = item()?["img"] as? String
        pb.clearContents()
        pb.setData(try? Data(contentsOf: pngFile("paste-cover.png", .systemGreen)), forType: .png)
        window.makeFirstResponder(pg)
        let pastedOnPage = window.performKeyEquivalent(with: cmdV)
        check("idea_paste_sets_picture", pastedOnPage && wait(10) { took(n, "image") } && wait(10) { pg.load(); return (item()?["img"] as? String).map { $0 != img1 } ?? false }, "taken \(pastedOnPage) img \(img1 ?? "nil") -> \(item()?["img"] as? String ?? "nil")")
        // Words on the pasteboard stay a paste of words.
        n = hub.sent.count
        pb.clearContents()
        pb.setString("just words", forType: .string)
        if let f = pg.fields["say"]?.field { window.makeFirstResponder(f) }
        check("idea_paste_words_not_a_picture", !window.performKeyEquivalent(with: cmdV) || !sentSince(n).contains { $0.contains("/ref") || $0.contains("/image") }, sentSince(n).joined(separator: ","))

        // IDEA-008: Kill: the hub's 200, off every lane (archived), back on Ideas with the toast.
        idle()
        n = hub.sent.count
        let L = board.log.count
        let name = item()?["name"] as? String ?? ""
        pg.buttons["kill"]?.performClick(nil)
        check("idea_kill_posts", wait(6) { took(n, "kill") }, sentSince(n).joined(separator: ","))
        var archived: Any? = nil
        hub.get("/api/ideas") { code, j in archived = ((j["ideas"] as? [[String: Any]] ?? []).first { $0["id"] as? String == "demo-tidepool" }).map { $0["archived"] ?? false } ?? "gone" }
        check("idea_kill_off_the_lanes", wait(6) { archived != nil } && ((archived as? Bool) == true || (archived as? String) == "gone"), "\(String(describing: archived))")
        check("idea_kill_back_to_ideas", wait(4) { if case .page(let k, _) = self.board.front { return !k.hasPrefix("idea:") }; return false } && toasts(since: L).contains(t("idea.killed", ["name": name])),
              "\(board.front) \(toasts(since: L))")
    }
}
