// The sessions rows the panel and the project page carry beyond what the
// Electron app draws, as the hub's browser board has them (hub/public/app.js):
//
// - the state's reason under the state line (SESS-035, renderDetail's why):
//   "From hook events: ...", "Read from the screen: ...", or the plan gate's;
// - Reply (SESS-026, SESS-045, the composer): the person's own words typed
//   into the session from outside its terminal (POST /api/send), with files
//   saved in the project's .inbox (POST /api/inbox/<project>) and their
//   paths sent with them; the hub's refusal shown under the box (a
//   half-typed prompt, SESS-036);
// - Start fresh session for a written hand-off when the fresh session is
//   not started by itself (SESS-044, POST /api/handoff/start).

import AppKit
import UniformTypeIdentifiers

/// Where a session's state came from, in words (app.js: SOURCE, the plan gate's why); nil with no reason given.
func stateReason(_ p: HubProject, _ s: HubSession) -> String? {
    if let g = p.raw["planGate"] as? [String: Any], p.raw["plan"] != nil, (p.raw["primary"] as? String).map({ $0 == s.surfaceId }) ?? true {
        let n = "\((g["n"] as? NSNumber)?.intValue ?? 0)"
        let fileOnly = g["fileOnly"]
        if fileOnly as? String == "removed" { return t("panel.reasonGateRemoved") }
        if let f = fileOnly, !(f is NSNull), (f as? Bool) != false { return t("panel.reasonGateFile", ["n": n]) }
        if g["unforeseen"] as? Bool == true { return t("panel.reasonGateUnforeseen", ["n": n]) }
        let text = g["text"] as? String ?? ""
        return t("panel.reasonGate", ["n": n, "text": text.prefix(1).lowercased() + text.dropFirst()])
    }
    let reasons = (s.raw["reasons"] as? [Any] ?? []).compactMap { $0 as? String }.filter { !$0.isEmpty }
    guard !reasons.isEmpty else { return nil }
    let why = reasons.joined(separator: "; ")
    return (s.raw["source"] as? String) == "events" ? t("panel.reasonEvents", ["why": why]) : t("panel.reasonScreen", ["why": why])
}

/// The reason's line, small, under the state line.
func reasonLine(_ p: HubProject, _ s: HubSession, width: CGFloat) -> NSTextField? {
    guard let r = stateReason(p, s) else { return nil }
    let l = label(r, Fonts.pt(11.5), "tx3", lines: 4, select: true)
    l.preferredMaxLayoutWidth = width
    l.identifier = NSUserInterfaceItemIdentifier("state-reason")
    l.setAccessibilityLabel(r)
    return l
}

/// A written hand-off's line and its Start fresh session (app.js handoffButton, handoffCard).
enum FreshStart {
    /// "written" with the fresh session left to the person, or with its start failed.
    static func state(_ s: HubSession) -> (offer: Bool, line: String?) {
        guard let h = s.handoff, h["state"] as? String == "written" else { return (false, nil) }
        let file = h["fileName"] as? String ?? "BRIEF.md"
        if let e = h["resumeError"] as? String, !e.isEmpty { return (false, t("panel.handOffNotStarted", ["file": file, "why": e])) }
        if h["autoStart"] as? Bool == false { return (true, t("panel.handOffWritten", ["file": file])) }
        return (false, nil)
    }

    static func start(_ hub: HubClient?, _ p: HubProject, _ s: HubSession, say: @escaping (String) -> Void) {
        guard let sid = s.sessionId else { return }
        hub?.post("/api/handoff/start", ["projectId": p.id, "sessionId": sid]) { code, j in
            say(code == 200 ? t("panel.freshStarted", ["where": j["surfaceRef"] as? String ?? t("panel.aNewTab")]) : (j["error"] as? String ?? "\(code)"))
        }
    }
}

/// Reply: words and files for a session, typed into its prompt by the hub.
final class ReplyBox: Box, NSTextFieldDelegate {
    final class File {
        let name: String
        var path: String?
        var short: String?
        var pending = true
        init(_ name: String) { self.name = name }
    }
    /// What each session's box holds while the panel draws again (by its key).
    static var drafts: [String: String] = [:]
    static var files: [String: [File]] = [:]
    static var errors: [String: String] = [:]
    /// The box on show for a key, so a file saved later shows in it.
    private static var live: [String: ReplyBox] = [:]
    /// The box drawn last (the self-test drives it).
    private(set) static weak var shown: ReplyBox?

    /// The hub can type into it (server/index.mjs sendMessage): a Ravenry pane, or a terminal it reads,
    /// never a cmux tab while the board runs in another terminal (cmux is read only then).
    static func canType(_ st: HubState, _ s: HubSession) -> Bool {
        if s.cannot != nil { return false }
        if s.pane != nil { return true }
        let board = (st.raw["board"] as? [String: Any])?["kind"] as? String ?? "cmux"
        if (s.term ?? "").lowercased() == "cmux" && board != "cmux" { return false }
        return s.terminal == true
    }

    let key: String
    private let project: HubProject
    private let session: HubSession
    private weak var hub: HubClient?
    private let say: (String) -> Void
    let field = NSTextField()
    private(set) var sendButton: RButton!
    private(set) var attachButton: RButton!
    private let chips = NSStackView()
    private let err = label("", Fonts.pt(12), "bad", lines: 4, select: true)
    private(set) var busy = false

    init(key: String, project: HubProject, session: HubSession, hub: HubClient?, width: CGFloat, say: @escaping (String) -> Void) {
        self.key = key; self.project = project; self.session = session; self.hub = hub; self.say = say
        super.init(fill: "card", radius: 10)
        field.placeholderString = t("panel.replyPlaceholder", ["who": session.assistant == "codex" ? "Codex" : "Claude"])
        field.stringValue = ReplyBox.drafts[key] ?? ""
        field.font = Fonts.pt(12.5)
        field.isBordered = true
        field.bezelStyle = .roundedBezel
        field.usesSingleLineMode = false
        field.cell?.wraps = true
        field.cell?.isScrollable = false
        field.maximumNumberOfLines = 5
        field.lineBreakMode = .byWordWrapping
        field.preferredMaxLayoutWidth = width - 28
        field.delegate = self
        field.toolTip = t("panel.replyTip")
        field.setAccessibilityLabel(t("panel.reply"))
        let send = RButton(t("panel.send"), .primary, small: true) { [weak self] in self?.send() }
        sendButton = send
        let attach = RButton(t("panel.attach"), .link) { [weak self] in self?.pick() }
        attach.titleSize = 12
        attach.toolTip = t("panel.attachTip")
        attachButton = attach
        chips.orientation = .vertical
        chips.alignment = .leading
        chips.spacing = 4
        err.preferredMaxLayoutWidth = width - 28
        let title = label(t("panel.reply"), Fonts.pt(12, Fonts.w650), "tx2")
        let st = vstack([title, field, chips, err, hstack([attach, spring(), send], spacing: 6)], spacing: 8, insets: NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14))
        addSubview(st)
        st.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([st.leadingAnchor.constraint(equalTo: leadingAnchor), st.trailingAnchor.constraint(equalTo: trailingAnchor),
                                     st.topAnchor.constraint(equalTo: topAnchor), st.bottomAnchor.constraint(equalTo: bottomAnchor),
                                     field.widthAnchor.constraint(equalTo: st.widthAnchor, constant: -28)])
        registerForDraggedTypes([.fileURL])
        identifier = NSUserInterfaceItemIdentifier("reply-box")
        ReplyBox.live[key] = self
        ReplyBox.shown = self
        refresh()
    }
    required init?(coder: NSCoder) { fatalError() }

    /// The chips and the error as they are now.
    func refresh() {
        chips.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for f in ReplyBox.files[key] ?? [] {
            let name = label(f.pending ? t("panel.saving", ["name": f.name]) : (f.short ?? f.name), Fonts.mono(11.5), "tx2", lines: 1)
            name.lineBreakMode = .byTruncatingMiddle
            let x = RButton(t("panel.removeFile", ["name": f.name]), .icon, small: true, icon: "close")
            x.run = { [weak self, weak f] in
                guard let self, let f else { return }
                ReplyBox.files[self.key]?.removeAll { $0 === f }
                self.refresh()
            }
            chips.addArrangedSubview(boxed(hstack([yields(name, fill: false), x], spacing: 4), fill: "card2", radius: 6, insets: NSEdgeInsets(top: 2, left: 8, bottom: 2, right: 2)))
        }
        chips.isHidden = (ReplyBox.files[key] ?? []).isEmpty
        let e = ReplyBox.errors[key]
        err.stringValue = e ?? ""
        err.isHidden = e == nil
        sendButton.isEnabled = !busy
    }

    // MARK: typing

    func controlTextDidChange(_ n: Notification) { ReplyBox.drafts[key] = field.stringValue }

    // The panel drawn again while the person types (a state, a card): the new box takes the keyboard back, the caret at the end.
    private static var refocus: String?
    override func viewWillMove(toWindow w: NSWindow?) {
        if w == nil, field.currentEditor() != nil { ReplyBox.refocus = key }
        super.viewWillMove(toWindow: w)
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let w = window, ReplyBox.refocus == key else { return }
        ReplyBox.refocus = nil
        DispatchQueue.main.async { [weak self] in
            guard let self, self.window === w else { return }
            w.makeFirstResponder(self.field)
            if let ed = self.field.currentEditor() { ed.selectedRange = NSRange(location: (self.field.stringValue as NSString).length, length: 0) }
        }
    }

    /// Return sends; Option+Return starts a new line.
    func control(_ c: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) { send(); return true }
        if sel == #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)) { textView.insertText("\n", replacementRange: textView.selectedRange()); return true }
        return false
    }

    // MARK: files

    private func pick() {
        guard let w = window else { return }
        let p = NSOpenPanel()
        p.canChooseFiles = true
        p.canChooseDirectories = false
        p.allowsMultipleSelection = true
        p.beginSheetModal(for: w) { [weak self] r in
            guard r == .OK else { return }
            self?.add(p.urls)
        }
    }

    override func draggingEntered(_ s: NSDraggingInfo) -> NSDragOperation { urls(s.draggingPasteboard).isEmpty ? [] : .copy }
    override func performDragOperation(_ s: NSDraggingInfo) -> Bool {
        let u = urls(s.draggingPasteboard)
        guard !u.isEmpty else { return false }
        add(u)
        return true
    }
    private func urls(_ pb: NSPasteboard) -> [URL] {
        (pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []).filter { u in
            var dir: ObjCBool = false
            return FileManager.default.fileExists(atPath: u.path, isDirectory: &dir) && !dir.boolValue
        }
    }

    /// Saves each file in the project's .inbox, one at a time, a chip each while it saves.
    func add(_ urls: [URL]) {
        let k = key, pid = project.id
        for u in urls {
            let f = File(u.lastPathComponent)
            ReplyBox.files[k, default: []].append(f)
            guard let d = try? Data(contentsOf: u) else {
                ReplyBox.files[k]?.removeAll { $0 === f }
                say(t("panel.couldNotSave", ["name": f.name, "why": "it could not be read"]))
                continue
            }
            hub?.postBytes("/api/inbox/\(pid.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? pid)", d, filename: f.name) { [weak self] code, j in
                if code == 200, let path = j["path"] as? String {
                    f.path = path; f.short = j["short"] as? String ?? path; f.pending = false
                } else {
                    ReplyBox.files[k]?.removeAll { $0 === f }
                    self?.say(t("panel.couldNotSave", ["name": f.name, "why": j["error"] as? String ?? "\(code)"]))
                }
                ReplyBox.live[k]?.refresh()
            }
        }
        refresh()
    }

    // MARK: sending

    func send() {
        let fs = ReplyBox.files[key] ?? []
        if fs.contains(where: { $0.pending }) { say(t("panel.stillSaving")); return }
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty && fs.isEmpty { say(t("panel.typeFirst")); return }
        guard !busy else { return }
        busy = true
        ReplyBox.errors[key] = nil
        refresh()
        let k = key, name = project.name
        hub?.post("/api/send", ["projectId": project.id, "surfaceId": session.surfaceId, "text": text, "paths": fs.compactMap { $0.path }]) { [weak self] code, j in
            self?.busy = false
            if code == 200 {
                ReplyBox.drafts[k] = nil
                ReplyBox.files[k] = nil
                ReplyBox.live[k]?.field.stringValue = ""
                let n = fs.count
                let files = n == 0 ? "" : n == 1 ? t("panel.withFile") : t("panel.withFiles", ["n": "\(n)"])
                self?.say(t("panel.typedInto", ["name": name, "files": files, "later": (j["delivered"] as? String) == "now" ? "" : t("panel.afterStep")]))
            } else {
                // Said where the person answered: under the box (a half-typed prompt, a closed tab).
                ReplyBox.errors[k] = j["error"] as? String ?? "The board answered \(code)."
            }
            ReplyBox.live[k]?.refresh()
        }
    }
}
