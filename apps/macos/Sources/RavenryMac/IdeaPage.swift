// An idea's thread (IDEA-003 to IDEA-006), as the Electron app draws it
// (inapp.ts idea(); app.css .ia-title, .ia-thread, .ia-msg, .ia-reply),
// with what only the hub's browser board had (hub/public/app.js
// renderIdeaPanel, renderMockups, mockupAct, attachRef, attachPicture):
// GET /api/ideas, read again every 2 s while it shows. Its stage, name,
// pitch and picture; its mockup rounds (the picture of the variant looked
// at, the round's three, Pick, What to change next and Another round,
// Stop while one is drawn: POST /api/ideas/:id/mockups, mockups/pick,
// mockups/stop); the thread (yours in a bubble, the assistant's as plain
// words, the pictures it drew); the reply field, the pictures that go
// with it (Add a picture: POST /api/ideas/:id/ref, a file chosen in
// Finder's dialog) and Send (say); Mockup round, Greenlight and Park it
// (mockups, update), Set its picture (image) and, once greenlit, Promote to
// project (the New project form, from the idea); Kill (POST
// /api/ideas/:id/kill: off every lane, kept in the archive). A picture
// dropped or pasted (Cmd+V) on the reply field goes with the next message,
// anywhere else on the page it is the idea's picture, as on the browser board.

import AppKit
import UniformTypeIdentifiers

extension HubClient {
    /// POST a file's bytes (a picture) as the board's page posts a File: its
    /// name in X-Filename. Nothing with RAVENRY_MAC_HUB_READONLY=1.
    func postBytes(_ path: String, _ data: Data, filename: String, _ done: @escaping (Int, [String: Any]) -> Void) {
        guard ProcessInfo.processInfo.environment["RAVENRY_MAC_HUB_READONLY"] != "1" else { done(0, ["error": "This window is read only (RAVENRY_MAC_HUB_READONLY)."]); return }
        guard let b = base, let u = URL(string: b.absoluteString + path) else { done(0, ["error": "No board."]); return }
        var r = URLRequest(url: u)
        r.httpMethod = "POST"
        r.timeoutInterval = 60
        r.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        r.setValue("1", forHTTPHeaderField: "X-Ravenry")
        r.setValue(filename.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "picture", forHTTPHeaderField: "X-Filename")
        URLSession.shared.uploadTask(with: r, from: data) { d, resp, e in
            let j = d.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] } ?? (e.map { ["error": $0.localizedDescription] } ?? [:])
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            DispatchQueue.main.async { done(code, j) }
        }.resume()
    }
}

/// A variant of a round, small: its picture, its letter and title, a tick when it is the idea's picture.
final class MockThumb: Flipped {
    let pic = CoverImage()
    let line: NSTextField
    var on = false { didSet { pic.layer?.borderWidth = on ? 2 : 0 } }
    var onPress: (() -> Void)?
    init(_ title: String, cover: Bool) {
        line = label((cover ? "\u{2713} " : "") + title, Fonts.pt(11.5, .medium), cover ? "ok" : "tx2")
        line.lineBreakMode = .byTruncatingTail
        super.init(frame: .zero)
        pic.radius = 6; pic.fit = false; pic.fillColor = Design.color("card2")
        pic.wantsLayer = true; pic.layer?.cornerRadius = 6; pic.layer?.borderColor = Design.color("work").cgColor
        line.translatesAutoresizingMaskIntoConstraints = true
        addSubview(pic); addSubview(line)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(title)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func layout() {
        super.layout()
        pic.frame = NSRect(x: 0, y: 0, width: bounds.width, height: max(0, bounds.height - 20))
        line.frame = NSRect(x: 0, y: bounds.height - 17, width: bounds.width, height: 16)
    }
    /// A press anywhere on it is its own, not its picture's.
    override func hitTest(_ p: NSPoint) -> NSView? { frame.contains(p) ? self : nil }
    override func mouseDown(with e: NSEvent) { onPress?() }
    override func resetCursorRects() { handCursor(onPress != nil) }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { onPress?(); return true }
}

final class IdeaPage: FormPage {
    var openIdeas: (() -> Void)?
    /// Promote to project: the New project form from this idea (its id, name, pitch).
    var promote: ((String, String, String) -> Void)?
    private(set) var id = ""
    /// GET /api/ideas's list, nil until read.
    private(set) var ideas: [[String: Any]]?
    private var images: [String: NSImage] = [:]
    private var asked = Set<String>()
    /// The round looked at (nil: the latest) and the variant in it (nil: the idea's picture, else the picked one, else A).
    private(set) var mkRound: Int?
    private(set) var mkView: Int?
    /// The pictures that go with the next message (POST ref's answers): file and url.
    private(set) var refs: [(file: String, url: String)] = []
    /// A picture on its way to the hub.
    private(set) var uploading = false
    /// The variant views of the round shown, for the self-test.
    private(set) var thumbs: [MockThumb] = []
    /// Finder's own dialog for pictures (true: several); the self-test answers it.
    lazy var choosePictures: (Bool, @escaping ([URL]) -> Void) -> Void = { [weak self] many, done in
        let p = NSOpenPanel()
        p.canChooseFiles = true
        p.canChooseDirectories = false
        p.allowsMultipleSelection = many
        p.allowedContentTypes = [.png, .jpeg, .gif, .webP]
        if let w = self?.window { p.beginSheetModal(for: w) { r in done(r == .OK ? p.urls : []) } }
        else if options.offscreen { done([]) } // never a panel on the screen of a run off every screen
        else { p.begin { r in done(r == .OK ? p.urls : []) } }
    }

    override init() {
        super.init()
        registerForDraggedTypes([.fileURL, .png, .tiff])
    }
    required init?(coder: NSCoder) { fatalError() }

    func show(_ ideaId: String) {
        if ideaId != id { dirty(); scroll.contentView.scroll(to: .zero); mkRound = nil; mkView = nil; refs = []; clear("mkNote") }
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

    /// A picture as wide as `w` at most and never larger than it is, in rounded corners.
    private func picture(_ u: String, maxW: CGFloat, radius: CGFloat = 8) -> (NSView, NSSize) {
        let v = CoverImage()
        v.image = image(u); v.radius = radius; v.fit = true; v.fillColor = .clear
        let sz = image(u)?.size ?? NSSize(width: maxW, height: maxW * 0.62)
        let w = min(maxW, max(1, sz.width))
        return (v, NSSize(width: w, height: (w * sz.height / max(1, sz.width)).rounded()))
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
        let m = it["mockups"] as? [String: Any]
        let job = m?["job"] as? [String: Any]
        let drawing = job != nil
        let rounds = m?["rounds"] as? [[String: Any]] ?? []
        let secs = When.date(job?["startedAt"] as? String).map { Int(Date().timeIntervalSince($0)) } ?? 0
        let sig = "\(id)|\(stage)|\(busy)|\(uploading)|\(pending)|\(drawing ? secs : -1)|\(it["name"] ?? "")|\(it["pitch"] ?? "")|\(it["img"] ?? "")|\(images.count)|\(mkRound ?? 0)|\(mkView ?? -1)|\(refs.map(\.file))|\(m.map { stableText($0) } ?? "")|" + thread.map { "\($0["who"] ?? "")\($0["at"] ?? "")\($0["text"] ?? "")" }.joined(separator: ",")
        let sigHead = "\(stage)"
        if sigHead != headSig || buttons["back"] == nil { headSig = sigHead; setHead(title: nil, src: nil, back: back, extra: [pill(stageWord, tone)]) }
        draw(sig) {
            var rows: [NSView] = []
            let title = wrap(it["name"] as? String ?? "", Fonts.pt(18, .bold))
            rows.append(title)
            if let p = it["pitch"] as? String, !p.isEmpty { rows.append(wrap(p, Fonts.pt(13), "tx2")) }
            // Its picture, while it has no mockup rounds (with them, the Mockups card shows it).
            if rounds.isEmpty, let u = it["img"] as? String {
                let (v, s) = picture(u, maxW: 360)
                v.setAccessibilityElement(true); v.setAccessibilityLabel(it["alt"] as? String ?? "")
                rows.append(WrapRow([(v, s)]))
            }
            if let m, drawing || !rounds.isEmpty || m["error"] is [String: Any] { rows.append(mockups(it, m, secs: secs, pending: pending)) }
            var th: [NSView] = []
            if thread.isEmpty { th.append(wrap(t("idea.nothing"), Fonts.pt(13), "tx3")) }
            for msg in thread {
                let who = msg["who"] as? String ?? "claude"
                let whoWord = ["you", "board", "codex", "claude"].contains(who) ? t("idea.who.\(who)") : Assistants.of(who)?.short ?? t("idea.who.claude")
                let line = label(t("idea.whoWhen", ["who": whoWord, "when": When.day(msg["at"] as? String) ?? ""]), Fonts.pt(12), "tx3")
                let err = msg["error"] as? Bool ?? false
                let text = msg["text"] as? String ?? ""
                var parts: [NSView?] = [line]
                // .ia-msg .bd: line-height 1.55.
                parts.append(spaced(CappedText(text, Fonts.pt(13), err ? "bad" : who == "you" ? "tx" : "tx2", fill: who == "you" ? "card2" : nil), 1.55))
                // .ia-imgs: wrapping, each at most 220 wide and never larger than it is.
                let pics = (msg["images"] as? [String] ?? []).map { picture($0, maxW: 220) }
                if !pics.isEmpty { parts.append(WrapRow(pics, gap: 8)) }
                th.append(vstack(parts, spacing: 4))
            }
            if pending { th.append(label(t("idea.answering"), Fonts.pt(12), "tx3")) }
            if drawing && rounds.isEmpty { th.append(label(t("idea.drawing"), Fonts.pt(12), "tx3")) }
            rows.append(vstack(th, spacing: 12))
            // The pictures that go with the next message, each with its remove.
            if !refs.isEmpty {
                let chips = refs.enumerated().map { k, r -> (NSView, NSSize) in
                    let (v, _) = picture(r.url, maxW: 64, radius: 6)
                    (v as? CoverImage)?.fit = false
                    let x = RButton(t("idea.removeRef", ["n": "\(k + 1)"]), .icon, small: true, icon: "close") { [weak self] in self?.refs.remove(at: k); self?.redraw() }
                    buttons["unref\(k)"] = x
                    x.wantsLayer = true
                    x.layer?.backgroundColor = Design.color("card").cgColor
                    x.layer?.cornerRadius = 11
                    let box = Flipped()
                    v.frame = NSRect(x: 0, y: 6, width: 64, height: 48)
                    v.translatesAutoresizingMaskIntoConstraints = true
                    box.addSubview(v)
                    x.translatesAutoresizingMaskIntoConstraints = true
                    x.frame = NSRect(x: 48, y: 0, width: 22, height: 22)
                    box.addSubview(x)
                    return (box, NSSize(width: 72, height: 56))
                }
                rows.append(WrapRow(chips, gap: 6))
            }
            let f = field("say", t("idea.reply"), area: true, height: 60)
            let send = RButton(t("idea.send"), .primary) { [weak self] in self?.say() }
            send.isEnabled = busy.isEmpty && !pending && !uploading
            buttons["send"] = send
            let attach = RButton(t("idea.attach"), .link) { [weak self] in self?.attachRefs() }
            attach.toolTip = t("idea.attachTip")
            attach.isEnabled = !uploading
            buttons["attach"] = attach
            let reply = NSStackView(views: [f, send])
            reply.orientation = .horizontal; reply.alignment = .bottom; reply.spacing = 10
            // Add a picture under the field: it goes with the message typed there.
            rows.append(vstack([reply, hstack([attach, spring()], spacing: 0)], spacing: 6))
            var mock: RButton? = nil
            if rounds.isEmpty {
                mock = RButton(t("idea.mockup")) { [weak self] in self?.post("mockups", [:]) { _ in self?.toast?(t("idea.mockupSent")) } }
                mock?.isEnabled = busy.isEmpty && !drawing
            }
            buttons["mockup"] = mock
            var green: RButton? = nil, park: RButton? = nil, prom: RButton? = nil
            if stage != "green" { green = RButton(t("idea.greenlight")) { [weak self] in self?.post("update", ["stage": "green"]) { _ in self?.toast?(t("idea.greenlit")) } }; green?.isEnabled = busy.isEmpty }
            if stage != "park" { park = RButton(t("idea.park")) { [weak self] in self?.post("update", ["stage": "park"]) { _ in self?.toast?(t("idea.parked")) } }; park?.isEnabled = busy.isEmpty }
            if stage == "green" {
                let name = it["name"] as? String ?? "", pitch = it["pitch"] as? String ?? "", iid = id
                prom = RButton(t("idea.promote"), .primary) { [weak self] in self?.promote?(iid, name, pitch) }
            }
            let setPic = RButton(t("idea.setPicture")) { [weak self] in self?.setPicture() }
            setPic.toolTip = t("idea.setPictureTip")
            setPic.isEnabled = !uploading
            let name = it["name"] as? String ?? ""
            let kill = RButton(t("idea.kill"), .no) { [weak self] in
                self?.post("kill", [:]) { _ in self?.toast?(t("idea.killed", ["name": name])); self?.openIdeas?() }
            }
            kill.isEnabled = busy.isEmpty
            buttons["greenlight"] = green; buttons["park"] = park; buttons["promote"] = prom; buttons["setPicture"] = setPic; buttons["kill"] = kill
            rows.append(acts([prom, mock, green, park, setPic, kill]))
            return rows
        }
    }
    private var headSig = ""

    /// The Mockups card: the round being drawn (Stop), one that did not come back (Try again), or a round's pictures (Pick, Another round).
    private func mockups(_ it: [String: Any], _ m: [String: Any], secs: Int, pending: Bool) -> NSView {
        let rounds = m["rounds"] as? [[String: Any]] ?? []
        let who = Assistants.short((m["job"] as? [String: Any])?["who"] as? String)
        if let job = m["job"] as? [String: Any] {
            let stop = RButton(t("idea.stopRound")) { [weak self] in self?.post("mockups/stop", [:]) { _ in self?.toast?(t("idea.roundStopped")) } }
            stop.isEnabled = busy.isEmpty
            buttons["mkStop"] = stop
            let note = (job["note"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let took = secs < 60 ? "\(secs) s" : "\(secs / 60) min \(secs % 60) s"
            return secBox(t("idea.mockups"), [label(t("idea.round", ["n": "\(job["round"] ?? "")"]), Fonts.pt(12), "tx2"),
                                               hstack([wrap(t("idea.drawingN", ["who": who, "secs": took]), Fonts.pt(12.5), "work"), stop], spacing: 10),
                                               note.map { wrap(t("idea.yourNote", ["note": $0]), Fonts.pt(12), "tx3") }])
        }
        if let e = m["error"] as? [String: Any], rounds.isEmpty || mkRound == nil {
            let again = RButton(t("idea.tryAgain"), .primary) { [weak self] in
                var b: [String: Any] = ["note": e["note"] as? String ?? ""]
                if let f = e["from"] as? [String: Any] { b["from"] = f }
                self?.post("mockups", b) { _ in self?.toast?(t("idea.mockupSent")) }
            }
            again.isEnabled = busy.isEmpty && !pending
            buttons["mkRetry"] = again
            if rounds.isEmpty { return secBox(t("idea.mockups"), [wrap(e["text"] as? String ?? "", Fonts.pt(12.5), "bad"), acts([again])]) }
        }
        let r = rounds.first { ($0["n"] as? NSNumber)?.intValue == mkRound } ?? rounds.last!
        let n = (r["n"] as? NSNumber)?.intValue ?? rounds.count
        let vs = r["variants"] as? [[String: Any]] ?? []
        let img = it["img"] as? String
        let coverIdx = vs.firstIndex { $0["img"] as? String == img }
        let pickedIdx = vs.firstIndex { $0["key"] as? String == r["picked"] as? String }
        let view = min(max(0, mkView ?? coverIdx ?? pickedIdx ?? 0), max(0, vs.count - 1))
        var rows: [NSView?] = []
        if rounds.count > 1 {
            rows.append(acts(rounds.map { x in
                let k = (x["n"] as? NSNumber)?.intValue ?? 0
                let b = RButton(t("idea.round", ["n": "\(k)"]), k == n ? .primary : .normal, small: true) { [weak self] in self?.mkRound = k; self?.mkView = nil; self?.redraw() }
                b.setAccessibilityValue(k == n)
                buttons["mkRound\(k)"] = b
                return b
            }))
        } else { rows.append(label(t("idea.round", ["n": "\(n)"]), Fonts.pt(12), "tx2")) }
        if vs.indices.contains(view) {
            let v = vs[view]
            let key = (v["key"] as? String ?? "").uppercased()
            let isCover = v["img"] as? String == img
            if let u = v["img"] as? String { let (pv, sz) = picture(u, maxW: 560); pv.setAccessibilityElement(true); pv.setAccessibilityLabel(t("idea.variant", ["key": key, "title": v["title"] as? String ?? ""])); rows.append(WrapRow([(pv, sz)])) }
            let pick = RButton(isCover ? t("idea.picked") : t("idea.pick"), isCover ? .normal : .primary, small: true) { [weak self] in
                self?.post("mockups/pick", ["round": n, "key": v["key"] as? String ?? ""]) { _ in self?.toast?(t("idea.pickedToast", ["key": key])) }
            }
            pick.isEnabled = busy.isEmpty && !isCover
            buttons["mkPick"] = pick
            let words = vstack([label(t("idea.variant", ["key": key, "title": v["title"] as? String ?? ""]), Fonts.pt(13, .semibold)), wrap(v["note"] as? String ?? "", Fonts.pt(12.5), "tx2")], spacing: 3)
            words.setContentHuggingPriority(.init(1), for: .horizontal)
            let line = hstack([words, spring(), pick], spacing: 10); line.alignment = .top
            rows.append(line)
        }
        thumbs = vs.enumerated().map { i, x in
            let th = MockThumb("\((x["key"] as? String ?? "").uppercased())  \(x["title"] as? String ?? "")", cover: x["img"] as? String == img)
            th.pic.image = (x["img"] as? String).flatMap { image($0) }
            th.on = i == view
            th.onPress = { [weak self] in self?.mkRound = n; self?.mkView = i; self?.redraw() }
            return th
        }
        rows.append(WrapRow(thumbs.map { ($0, NSSize(width: 150, height: 114)) }, gap: 8))
        let note = field("mkNote", t("idea.changeNext"))
        let again = RButton(t("idea.anotherRound")) { [weak self] in
            guard let self else { return }
            let from = pickedIdx.map { vs[$0] } ?? (vs.indices.contains(view) ? vs[view] : nil)
            var b: [String: Any] = ["note": self.typed("mkNote")]
            if let f = from { b["from"] = ["round": n, "key": f["key"] as? String ?? ""] }
            self.post("mockups", b) { _ in self.clear("mkNote"); self.mkRound = nil; self.mkView = nil; self.toast?(t("idea.mockupSent")) }
        }
        again.isEnabled = busy.isEmpty && !pending
        note.onReturn = { [weak again] in again?.performClick(nil) }
        buttons["mkAgain"] = again
        rows.append(hstack([note, again], spacing: 8))
        let ms = (r["ms"] as? NSNumber)?.intValue
        let tookS = ms.map { s in let x = s / 1000; return x < 60 ? "\(x) s, " : "\(x / 60) min \(x % 60) s, " } ?? ""
        let model = (r["model"] as? String).flatMap { $0.lowercased().contains("sonnet") ? nil : $0 } ?? "Sonnet"
        rows.append(wrap(t("idea.roundFoot", ["n": "\(n)", "took": tookS, "model": model, "folder": m["folder"] as? String ?? ""]), Fonts.pt(11.5), "tx3"))
        return secBox(t("idea.mockups"), rows)
    }

    private func say() {
        if typed("say").isEmpty && refs.isEmpty { _ = need("say", t("idea.typeReply")); return }
        post("say", ["text": typed("say"), "images": refs.map(\.file)]) { [weak self] _ in self?.clear("say"); self?.refs = [] }
    }

    /// Add a picture: each file chosen goes to the hub (POST ref) and with the next message.
    private func attachRefs() {
        choosePictures(true) { [weak self] urls in
            guard let self, !urls.isEmpty else { return }
            self.upload(urls, path: "ref") { j in if let f = j["file"] as? String, let u = j["url"] as? String { self.refs.append((f, u)) } }
        }
    }

    /// Set its picture: the file chosen is the idea's card picture (POST image).
    private func setPicture() {
        choosePictures(false) { [weak self] urls in
            guard let self, let u = urls.first else { return }
            self.upload([u], path: "image") { _ in self.toast?(t("idea.pictureSet")) }
        }
    }

    private func upload(_ urls: [URL], path what: String, _ each: @escaping ([String: Any]) -> Void) {
        uploadData(urls.map { u in (u.lastPathComponent, { try? Data(contentsOf: u) }) }, path: what, each)
    }

    // MARK: pictures dropped or pasted

    /// The pasteboard Cmd+V reads (the self-test's own, never the person's clipboard there).
    var pasteboard = NSPasteboard.general

    /// Pictures on a pasteboard: image files (png, jpg, gif, webp), else an image's own data (a screenshot copied).
    static func pictures(_ pb: NSPasteboard) -> [(String, () -> Data?)] {
        let ok = Set(["png", "jpg", "jpeg", "gif", "webp"])
        let files = (pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []).filter { ok.contains($0.pathExtension.lowercased()) }
        if !files.isEmpty { return files.map { u in (u.lastPathComponent, { try? Data(contentsOf: u) }) } }
        if let png = pb.data(forType: .png) { return [("pasted.png", { png })] }
        if let tiff = pb.data(forType: .tiff), let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) { return [("pasted.png", { png })] }
        return []
    }

    /// Over the reply field (its box): the pictures go with the next message; anywhere else, the first is the idea's picture.
    private func took(_ pics: [(String, () -> Data?)], onReply: Bool) -> Bool {
        guard !pics.isEmpty, !id.isEmpty else { return false }
        if onReply { uploadData(pics, path: "ref") { [weak self] j in if let f = j["file"] as? String, let u = j["url"] as? String { self?.refs.append((f, u)) } } }
        else { uploadData([pics[0]], path: "image") { [weak self] _ in self?.toast?(t("idea.pictureSet")) } }
        return true
    }

    private func onReply(_ windowPoint: NSPoint) -> Bool {
        guard let box = fields["say"], box.window != nil else { return false }
        return box.convert(box.bounds, to: nil).insetBy(dx: -8, dy: -8).contains(windowPoint)
    }

    override func draggingEntered(_ s: NSDraggingInfo) -> NSDragOperation { IdeaPage.pictures(s.draggingPasteboard).isEmpty ? [] : .copy }
    override func draggingUpdated(_ s: NSDraggingInfo) -> NSDragOperation { draggingEntered(s) }
    override func performDragOperation(_ s: NSDraggingInfo) -> Bool { took(IdeaPage.pictures(s.draggingPasteboard), onReply: onReply(s.draggingLocation)) }

    /// Cmd+V with pictures on the pasteboard and no words: in the reply field they go with the next message, else the first is the idea's picture.
    override func performKeyEquivalent(with e: NSEvent) -> Bool {
        if e.type == .keyDown, e.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command, e.charactersIgnoringModifiers == "v", window != nil, !isHiddenOrHasHiddenAncestor,
           pasteboard.string(forType: .string) == nil || !(pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) ?? []).isEmpty {
            let fr = window?.firstResponder as? NSView
            let inPage = fr.map { $0 === self || $0.isDescendant(of: self) || ((fr as? NSTextView)?.delegate as? NSView)?.isDescendant(of: self) == true } ?? false
            let inReply = (fr as? NSTextView)?.delegate === fields["say"]?.field
            if inPage, took(IdeaPage.pictures(pasteboard), onReply: inReply) { return true }
        }
        return super.performKeyEquivalent(with: e)
    }

    private func uploadData(_ items: [(String, () -> Data?)], path what: String, _ each: @escaping ([String: Any]) -> Void) {
        guard let hub, !uploading else { return }
        uploading = true
        dirty(); redraw()
        var left = items
        func next() {
            guard let (name, data) = left.first else { uploading = false; dirty(); redraw(); load(); return }
            left.removeFirst()
            guard let d = data() else { toast?(t("idea.notPicture")); next(); return }
            hub.postBytes("/api/ideas/\(enc)/\(what)", d, filename: name) { [weak self] code, j in
                guard let self else { return }
                if code == 200 { each(j); if what == "ref" { self.toast?(t("idea.refAdded")) } } else { self.toast?(j["error"] as? String ?? t("page.didNotWork")) }
                next()
            }
        }
        next()
    }

    private var enc: String { id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? id }

    private func post(_ what: String, _ body: [String: Any], done: (([String: Any]) -> Void)? = nil) {
        act(what, "/api/ideas/\(enc)/\(what)", body, done: done)
    }
}
