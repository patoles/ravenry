// --screen pages, the rows the first round left unchecked (called at the end
// of screenPages): each button pressed as the person would, its effect read
// where it lands (the sheet that opened, the page in front, the pasteboard's
// record, the hub's 200, the file on disk).
//
// - PAGE-016: a link button asks "Open this address?" with the address, Open
//   in the browser opens it; an open of another page brings it to the front;
//   of a page that is not there says No page called X; of a project, its view.
// - PAGE-017: Ship's Copy the ship command copies the command, says Copied.
// - PAGE-005: a project's page trusted, then its file changed: read only
//   again, "changed since you trusted it", its buttons off.
// - PLAN-008: a project's TODO.md with boxes is an objective (its heading,
//   "1 of 3", updated N min ago), and the file is never touched.
// - IDEA-009: a brainstorm that came back wrong says so, and Clear puts it away.

import AppKit

extension SelfTestBoard {
    private var fpc: FilePage { board.files }
    private func openPageC(_ key: String) -> Bool {
        if let r = board.sidebar.rows["page:\(key)"] { click(r) } else { board.openPage(key, board.hub.state?.pages.first { $0.key == key }?.label ?? key) }
        return wait(10) { self.fpc.key == key && self.fpc.view?["key"] as? String == key && self.board.root.middle === self.fpc }
    }
    private func pressC(_ name: String) {
        if let b = fpc.pb[name] as? NSButton ?? fpc.buttons[name] { b.performClick(nil) }
        else if let v = fpc.pb[name] as? PressBox { v.onPress?() }
        settle(0.2)
    }
    private func idleC() { _ = wait(10) { self.fpc.pending == 0 }; settle(0.3) }

    func pagesScopeC() {
        // MARK: PAGE-016
        check("c_harbour_opens", openPageC("harbour") && wait(5) { self.shows(self.fpc, "Mooring rings") }, texts(fpc).prefix(8).joined(separator: " | "))
        pressC("item:mooring.md:Read more")
        check("c_link_asks_first", fpc.sheetKind == "link" && fpc.sheetView.map { shows($0, t("pg.openAddress")) && shows($0, "https://example.com/harbour/moorings") } == true,
              "\(fpc.sheetKind) \(texts(fpc.sheetView ?? fpc).joined(separator: " | ").prefix(200))")
        twoPicturesC("pages-link")
        let o0 = Outside.record?.count ?? 0
        pressC("sheet:ok")
        check("c_link_opens_in_browser", Outside.record?.dropFirst(o0).contains("open https://example.com/harbour/moorings") == true && fpc.sheetView == nil, Outside.record?.suffix(2).joined(separator: ", ") ?? "")
        // Cancel opens nothing.
        pressC("item:mooring.md:Read more")
        let o1 = Outside.record?.count ?? 0
        pressC("sheet:cancel")
        check("c_link_cancel_opens_nothing", (Outside.record?.count ?? 0) == o1 && fpc.sheetView == nil)
        pressC("item:mooring.md:See the notes")
        check("c_open_another_page", wait(10) { self.fpc.key == "notes" && self.fpc.view?["key"] as? String == "notes" }, "\(board.front) \(fpc.key)")
        _ = openPageC("harbour")
        let L = board.log.count
        pressC("item:mooring.md:Lost page")
        check("c_open_no_such_page", toasts(since: L).contains(t("pg.noPage", ["page": "nowhere"])) && fpc.key == "harbour", toasts(since: L).joined(separator: ","))
        pressC("item:mooring.md:Its boat")
        check("c_open_a_project", wait(6) { self.board.frontKey?.hasPrefix("paper-boat") == true || { if case .page(let k, _) = self.board.front { return k.contains("paper-boat") }; return false }() }, "\(board.front) \(board.frontKey ?? "")")

        // MARK: PAGE-017
        check("c_ship_opens", openPageC("ship"))
        let card = fpc.pb.keys.first { $0.hasPrefix("card:") && $0.hasSuffix("/garden-planner") } ?? ""
        let copyKey = "item:" + card.dropFirst(5) + ":Copy the ship command"
        _ = wait(5) { self.fpc.pb[copyKey] != nil || self.fpc.buttons[copyKey] != nil }
        let L2 = board.log.count, o2 = Outside.record?.count ?? 0
        pressC(copyKey)
        check("c_ship_copy_command", Outside.record?.dropFirst(o2).contains("copy ! npm run ship -- --tag garden") == true && toasts(since: L2).last == t("pg.copied"),
              "\(copyKey) present \(fpc.pb[copyKey] != nil || fpc.buttons[copyKey] != nil); \(Outside.record?.suffix(2).joined(separator: ", ") ?? "")")

        // MARK: PLAN-008
        let todo = (board.hub.state?.project("notes-app")?.folder ?? "/nowhere") + "/TODO.md"
        let before = try? String(contentsOfFile: todo, encoding: .utf8)
        check("c_objectives_opens", openPageC("objectives"))
        let rowText = { self.texts(self.fpc).filter { $0.contains("To do") || $0.contains("1 of 3") || $0.hasPrefix("updated") } }
        check("c_todo_is_an_objective", wait(8) { let x = self.texts(self.fpc); return x.contains("To do") && x.contains("1 of 3") && x.contains { $0.hasPrefix("updated ") } },
              rowText().joined(separator: " | ") + " || " + texts(fpc).prefix(30).joined(separator: " | "))
        twoPicturesC("objectives-todo")
        check("c_todo_file_untouched", before != nil && (try? String(contentsOfFile: todo, encoding: .utf8)) == before)

        // MARK: PAGE-005: trusted, then the file changed under it
        let dk = board.hub.state?.pages.first { $0.project != nil && $0.label == "Deploys" }?.key ?? board.hub.state?.pages.first { $0.project != nil }?.key ?? ""
        _ = openPageC(dk)
        if fpc.pb["bar:trust"] != nil { pressC("bar:trust") }
        _ = wait(8) { self.fpc.buttons["page:Build"]?.isEnabled == true }
        idleC()
        let file = fpc.view?["file"] as? String ?? ""
        if let h = FileHandle(forWritingAtPath: file) { h.seekToEndOfFile(); h.write(Data("# Changed by a pull.\n".utf8)); try? h.close() }
        check("c_trust_asked_again_after_change", wait(15) { _ = self.openPageC(dk); return self.shows(self.fpc, t("pg.trustChanged")) && self.fpc.buttons["page:Build"]?.isEnabled == false },
              "\(file) | \(texts(fpc).prefix(10).joined(separator: " | "))")
        twoPicturesC("pages-trust-changed")

        // MARK: IDEA-009: a brainstorm that came back wrong (the stub answers prose for BADJSON), then Clear
        check("c_ideas_opens", openPageC("ideas"))
        if let f = fpc.fields["seed"] { typeIn(f, "a harbour game BADJSON") }
        let n0 = board.hub.sent.count
        pressC("bs:go")
        check("c_brainstorm_wrong_said", wait(30) { self.board.render(); return self.texts(self.fpc).contains { $0.contains("not with 3 directions") } && self.fpc.pb["bs:clear"] != nil },
              "\(sentSince(n0)) | \(texts(fpc).prefix(12).joined(separator: " | "))")
        twoPicturesC("ideas-brainstorm-wrong")
        let n1 = board.hub.sent.count
        pressC("bs:clear")
        var stored: Any? = nil
        check("c_brainstorm_clear_posts", wait(5) { self.board.hub.answers.contains { $0.seq >= n1 && $0.path == "/api/ideas/brainstorm/clear" && $0.code == 200 } }, sentSince(n1).joined(separator: ","))
        board.hub.get("/api/ideas") { _, j in stored = j["brainstormError"] ?? NSNull() }
        check("c_brainstorm_cleared_for_good", wait(5) { stored != nil } && stored is NSNull && wait(5) { !self.texts(self.fpc).contains { $0.contains("not with 3 directions") } && self.fpc.pb["bs:clear"] == nil },
              "\(String(describing: stored))")
    }

    private func twoPicturesC(_ name: String) {
        for (w, h, dark) in [(CGFloat(1280), CGFloat(820), true), (900, 760, false)] {
            size(w, h)
            NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            settle(0.4); board.render(force: true); settle(0.5)
            picture("native-\(name)-\(Int(w))-\(dark ? "dark" : "light").png")
        }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        size(1280, 820)
    }
}
