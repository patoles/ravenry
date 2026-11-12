// The hand-off card (2026-11-12, the person: "The hand-off card is a wall of
// text, not really useful"), run inside --screen proofs on the project whose
// brief has a hand-off (sidetest.mjs). A long entry is written into the
// brief as a session would, with a first sentence that only names a session;
// then each check reads the effect where it lands:
//
//   ho_card_hub_line        the hub's timeline text: the next sentence, short, no id or name
//   ho_card_hub_full        the whole entry kept in `full`
//   ho_card_drawn_two_lines the panel's card draws at most two lines, cut at a word with "…"
//   ho_card_caps_whole_entry the card's own cap holds on the whole entry (an older hub's text)
//   ho_card_older_hub_line  OlderHub.swift gives an older hub's state the same line
//   cursor_handoff_card     the pointing hand over the card
//   ho_card_opens_brief     a press opens the brief, scrolled to its Hand-off heading
//   ho_card_brief_whole     the brief page shows the entry whole

import AppKit

extension SelfTestBoard {
    static let longHandoff = "Session 25204b9f (ravenry-1d) is main. Native 0.1.37+00eedd8 installed 00:39 (integration: 5d1bfe4 schema and types, b6bd411 quits on SIGTERM with a dialog up, 5b80f8c bump, 00eedd8 three flakes; selftest 185/185, sidetest 36 runs 2021 checks 0 failed, scripts pass, installcheck 20/23 = 3 update steps need a same-version Electron build). Launched clean, app.log 'launch: native app 0.1.37', board 200, doctor all good, 0.1.36 daemon had no panes. Rollback: the scratchpad's rollback zip. build4 running: scope 1 the remaining screens, scope 2 the five hub phone tests over loopback. Then main integrates 0.1.38."

    func screenHandoffCard(_ pid: String) {
        let hub = board.hub
        guard let p0 = hub.state?.project(pid), let file = p0.brief?["file"] as? String,
              let before = try? String(contentsOfFile: file, encoding: .utf8), let at = before.range(of: "## Hand-off\n") else {
            check("ho_card_brief", false, "no brief with a Hand-off section in \(pid)"); return
        }
        // Enough above the Hand-off that the page has to scroll to it, then the entry at the section's top.
        var md = before
        md.insert(contentsOf: "- 2026-11-12 00:45 \(SelfTestBoard.longHandoff)\n  - State: the card test's entry\n", at: at.upperBound)
        let filler = "## Background\n" + (1...40).map { "- Bed \($0) gets its own sowing window from the frost dates." }.joined(separator: "\n") + "\n\n"
        md.insert(contentsOf: filler, at: md.range(of: "## Hand-off\n")!.lowerBound)
        try? md.write(toFile: file, atomically: true, encoding: .utf8)
        defer { try? before.write(toFile: file, atomically: true, encoding: .utf8) }

        // The hub's line.
        var ho: [String: Any]?
        _ = wait(15) {
            ho = hub.state?.project(pid)?.timeline.first { $0["from"] as? String == "brief" }
            return (ho?["full"] as? String)?.hasSuffix("Then main integrates 0.1.38.") == true
        }
        let line = ho?["text"] as? String ?? ""
        check("ho_card_hub_line", line.hasPrefix("Native 0.1.37+00eedd8 installed 00:39") && line.count <= 120 && line.hasSuffix("…") && !line.contains("25204b9f") && !line.contains("ravenry-1d"),
              "\(line.count) characters: \(line)")
        check("ho_card_hub_full", (ho?["full"] as? String)?.hasPrefix("Session 25204b9f (ravenry-1d) is main. Native") == true, "full \((ho?["full"] as? String)?.count ?? 0) characters")

        // The panel's card.
        board.render(force: true)
        settle(0.6)
        let cardV = views(PressBox.self, in: board.panel) { $0.identifier?.rawValue == "handoff-card" }.first
        let field = cardV.flatMap { c in views(NSTextField.self, in: c) { $0.stringValue.hasPrefix("Native") }.first }
        let font = Fonts.pt(12.5)
        let lh = NSLayoutManager().defaultLineHeight(for: font)
        if let f = field {
            let drawn = f.stringValue
            let n = Int((f.frame.height / lh).rounded())
            let stem = String(drawn.dropLast())
            let next = line.dropFirst(stem.count).first
            check("ho_card_drawn_two_lines", (1...2).contains(n) && drawn.hasSuffix("…") && line.hasPrefix(stem) && (next == " " || next == "," || next == ";" || next == "…"),
                  "\(n) lines (\(f.frame.height) pt, a line \(lh) pt) at \(f.frame.width) pt: \(drawn)")
        } else { check("ho_card_drawn_two_lines", false, "no card text; panel: \(texts(board.panel).prefix(12))") }

        // The card's own cap on the whole entry, as an older hub sends it.
        let whole = TwoLines.cut(SelfTestBoard.longHandoff, font: font, width: PanelView.width - 56)
        let probe = label(whole, font, "tx", lines: 0)
        probe.preferredMaxLayoutWidth = PanelView.width - 56
        let ph = probe.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: PanelView.width - 56, height: 10_000)).height ?? 0
        check("ho_card_caps_whole_entry", whole.hasSuffix("…") && Int((ph / lh).rounded()) <= 2, "\(Int((ph / lh).rounded())) lines: \(whole)")

        // An older hub (no `full`, the whole entry as the text): OlderHub.swift gives the same line.
        if var raw = hub.state?.raw, var ps = raw["projects"] as? [[String: Any]] {
            for i in ps.indices { if var tl = ps[i]["timeline"] as? [[String: Any]] { for j in tl.indices where tl[j]["from"] as? String == "brief" { tl[j]["text"] = tl[j]["full"]; tl[j]["full"] = nil }; ps[i]["timeline"] = tl } }
            raw["projects"] = ps
            let filled = OlderHub().fill(raw)
            let old = ((filled["projects"] as? [[String: Any]])?.first { $0["id"] as? String == pid }?["timeline"] as? [[String: Any]])?.first { $0["from"] as? String == "brief" }
            check("ho_card_older_hub_line", (old?["text"] as? String) == line && (old?["full"] as? String)?.hasPrefix("Session 25204b9f") == true, "older hub: \(old?["text"] as? String ?? "none")")
        }

        pictures("handoff-card")

        // The pointer, then a press: the brief, at its Hand-off (the card as drawn now: the pictures drew the panel again).
        if !board.panelVisible { board.togglePanel() }
        board.render(force: true)
        settle(0.4)
        let cardNow = views(PressBox.self, in: board.panel) { $0.identifier?.rawValue == "handoff-card" }.first
        checkPointer("handoff_card", cardNow, want: "hand")
        if let c = cardNow { click(c) }
        let tv = board.brief.text
        _ = wait(10) { board.brief.focused?.lowercased() == "hand-off" && board.brief.window != nil && !board.brief.isHiddenOrHasHiddenAncestor }
        settle(0.4)
        let ns = tv.string as NSString
        let hr = ns.range(of: "\nHand-off\n")
        var shown = false, rectText = ""
        if hr.location != NSNotFound, let lm = tv.layoutManager, let tc = tv.textContainer {
            let g = lm.glyphRange(forCharacterRange: NSRange(location: hr.location + 1, length: 8), actualCharacterRange: nil)
            let r = lm.boundingRect(forGlyphRange: g, in: tc).offsetBy(dx: 0, dy: tv.textContainerOrigin.y)
            let vis = board.brief.scroll.contentView.bounds
            shown = vis.contains(r)
            rectText = "heading at y \(Int(r.minY)), view \(Int(vis.minY))..\(Int(vis.maxY))"
        }
        let y = board.brief.scroll.contentView.bounds.origin.y
        check("ho_card_opens_brief", board.brief.focused?.lowercased() == "hand-off" && shown && y > 0 && !board.brief.isHiddenOrHasHiddenAncestor,
              "focused \(board.brief.focused ?? "none"), scrolled \(Int(y)) pt, \(rectText)")
        check("ho_card_brief_whole", tv.string.contains("Then main integrates 0.1.38.") && tv.string.contains("Session 25204b9f (ravenry-1d) is main."), "brief text \(tv.string.count) characters")
        picture("native-handoff-brief-at-handoff.png")
        board.back()
        settle(0.4)
    }
}
