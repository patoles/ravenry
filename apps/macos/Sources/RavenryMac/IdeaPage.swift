// An idea's thread (IDEA-003), as the Electron app draws it (inapp.ts
// idea(); app.css .ia-title, .ia-thread, .ia-msg, .ia-reply): GET
// /api/ideas, read again every 2 s while it shows. Its stage, name and
// pitch, the thread (yours in a bubble, the assistant's as plain words, the
// pictures it drew), the reply field and Send (POST /api/ideas/:id/say),
// Mockup round, Greenlight and Park it (mockups, update).

import AppKit

final class IdeaPage: FormPage {
    var openIdeas: (() -> Void)?
    private(set) var id = ""
    /// GET /api/ideas's list, nil until read.
    private(set) var ideas: [[String: Any]]?
    private var images: [String: NSImage] = [:]
    private var asked = Set<String>()

    func show(_ ideaId: String) {
        if ideaId != id { dirty(); scroll.contentView.scroll(to: .zero) }
        id = ideaId
        load()
        poll(2)
        redraw()
    }

    override func load() {
        hub?.get("/api/ideas") { [weak self] code, j in
            guard let self else { return }
            if code == 200 { self.ideas = j["ideas"] as? [[String: Any]] ?? [] }
            self.redraw()
        }
    }

    private func image(_ u: String) -> NSImage? {
        if let i = images[u] { return i }
        if !asked.contains(u), let hub {
            asked.insert(u)
            hub.data(u) { [weak self] d in
                guard let self else { return }
                if let d, let i = NSImage(data: d) { self.images[u] = i } else { self.asked.remove(u) }
                self.dirty(); self.redraw()
            }
        }
        return nil
    }

    override func redraw() {
        let back = (t("idea.ideas"), { [weak self] in self?.openIdeas?() }) as (String, () -> Void)
        guard let list = ideas else {
            setHead(title: nil, src: nil, back: back)
            draw("reading") { [wrap(t("idea.reading"), Fonts.pt(13), "tx3")] }
            return
        }
        guard let it = list.first(where: { $0["id"] as? String == id }) else {
            setHead(title: nil, src: nil, back: back)
            draw("gone|\(id)") { [wrap(t("idea.gone"), Fonts.pt(13), "tx2")] }
            return
        }
        let stage = it["stage"] as? String ?? "spark"
        let tone = ["spark": "you", "mock": "wait", "green": "ok"][stage]
        let stageWord = ["spark", "mock", "green", "park"].contains(stage) ? t("idea.stage.\(stage)") : stage
        let thread = it["thread"] as? [[String: Any]] ?? []
        let pending = it["pending"].map { !($0 is NSNull) && ($0 as? Bool ?? true) } ?? false
        let drawing = ((it["mockups"] as? [String: Any])?["job"]).map { !($0 is NSNull) } ?? false
        let sig = "\(id)|\(stage)|\(busy)|\(pending)|\(drawing)|\(it["name"] ?? "")|\(it["pitch"] ?? "")|\(images.count)|" + thread.map { "\($0["who"] ?? "")\($0["at"] ?? "")\($0["text"] ?? "")" }.joined(separator: ",")
        let sigHead = "\(stage)"
        if sigHead != headSig || buttons["back"] == nil { headSig = sigHead; setHead(title: nil, src: nil, back: back, extra: [pill(stageWord, tone)]) }
        draw(sig) {
            var rows: [NSView] = []
            let title = wrap(it["name"] as? String ?? "", Fonts.pt(18, .bold))
            rows.append(title)
            if let p = it["pitch"] as? String, !p.isEmpty { rows.append(wrap(p, Fonts.pt(13), "tx2")) }
            var th: [NSView] = []
            if thread.isEmpty { th.append(wrap(t("idea.nothing"), Fonts.pt(13), "tx3")) }
            for m in thread {
                let who = m["who"] as? String ?? "claude"
                let whoWord = ["you", "board", "codex"].contains(who) ? t("idea.who.\(who)") : t("idea.who.claude")
                let line = label(t("idea.whoWhen", ["who": whoWord, "when": When.day(m["at"] as? String) ?? ""]), Fonts.pt(12), "tx3")
                let err = m["error"] as? Bool ?? false
                let text = m["text"] as? String ?? ""
                var parts: [NSView?] = [line]
                parts.append(CappedText(text, Fonts.pt(13), err ? "bad" : who == "you" ? "tx" : "tx2", fill: who == "you" ? "card2" : nil))
                let pics = (m["images"] as? [String] ?? []).map { u -> NSView in
                    let v = CoverImage()
                    v.image = image(u); v.radius = 8; v.fillColor = .clear
                    v.translatesAutoresizingMaskIntoConstraints = false
                    let sz = image(u)?.size ?? NSSize(width: 220, height: 140)
                    v.widthAnchor.constraint(equalToConstant: 220).isActive = true
                    v.heightAnchor.constraint(equalToConstant: (220 * sz.height / max(1, sz.width)).rounded()).isActive = true
                    return v
                }
                if !pics.isEmpty { parts.append(hstack(pics + [spring()], spacing: 8)) }
                th.append(vstack(parts, spacing: 4))
            }
            if pending { th.append(label(t("idea.answering"), Fonts.pt(12), "tx3")) }
            if drawing { th.append(label(t("idea.drawing"), Fonts.pt(12), "tx3")) }
            rows.append(vstack(th, spacing: 12))
            let f = field("say", t("idea.reply"), area: true, height: 60)
            let send = RButton(t("idea.send"), .primary) { [weak self] in self?.say() }
            send.isEnabled = busy.isEmpty && !pending
            buttons["send"] = send
            let reply = NSStackView(views: [f, send])
            reply.orientation = .horizontal; reply.alignment = .bottom; reply.spacing = 10
            rows.append(reply)
            let mock = RButton(t("idea.mockup")) { [weak self] in self?.post("mockups", [:]) { _ in self?.toast?(t("idea.mockupSent")) } }
            mock.isEnabled = busy.isEmpty && !drawing
            buttons["mockup"] = mock
            var green: RButton? = nil, park: RButton? = nil
            if stage != "green" { green = RButton(t("idea.greenlight")) { [weak self] in self?.post("update", ["stage": "green"]) { _ in self?.toast?(t("idea.greenlit")) } }; green?.isEnabled = busy.isEmpty }
            if stage != "park" { park = RButton(t("idea.park")) { [weak self] in self?.post("update", ["stage": "park"]) { _ in self?.toast?(t("idea.parked")) } }; park?.isEnabled = busy.isEmpty }
            buttons["greenlight"] = green; buttons["park"] = park
            rows.append(acts([mock, green, park]))
            return rows
        }
    }
    private var headSig = ""

    private func say() {
        if need("say", t("idea.typeReply")) { return }
        post("say", ["text": typed("say")]) { [weak self] _ in self?.clear("say") }
    }

    private func post(_ what: String, _ body: [String: Any], done: (([String: Any]) -> Void)? = nil) {
        let e = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? id
        act(what, "/api/ideas/\(e)/\(what)", body, done: done)
    }
}
