// A plain program's status (SESS-056): a build or a deploy that reports
// itself with OSC 7501 is one more session row under the project whose
// folder it runs in (hub/server/sidebar.mjs, a row's `program`), with Shell
// where a session says its model and its progress where the context is;
// done or failed, the row stays until the person opens it. The words the
// window says of one, in one place.

import AppKit

enum ProgramWords {
    /// What it waits for, after its command ("npm run deploy needs you to sign in").
    static func need(_ kind: String?) -> String {
        switch kind {
        case "auth": return "needs you to sign in"
        case "permission": return "needs your permission"
        case "question": return "asks you something"
        default: return "needs you"
        }
    }

    /// The panel's state line: "npm run deploy needs you to sign in since 14:09", "make release failed at 14:10".
    static func state(_ p: ProgramInfo, command: String) -> String {
        switch p.state {
        case "blocked": return "\(command) \(need(p.kind)) since \(When.clock(p.since))"
        case "failed": return "\(command) failed at \(When.clock(p.since))"
        case "done": return "\(command) done at \(When.clock(p.since))"
        default: return "\(command) is working" + (p.progress.map { ", \($0)%" } ?? "")
        }
    }

    /// Where the state came from: "From the program: it said so 3 min ago".
    static func said(_ since: String?) -> String {
        let a = When.ago(since)
        return "From the program: it said so \(a == "now" ? "just now" : "\(a) ago")"
    }

    /// The row's word in the percent's place: its progress, or Done, Failed.
    static func rowWord(_ state: String, progress: Int?) -> String {
        switch state {
        case "done": return "Done"
        case "failed": return "Failed"
        default: return progress.map { "\($0)%" } ?? ""
        }
    }
    /// Its colour: green done, red failed, else the percent's grey.
    static func rowColor(_ state: String) -> String { state == "done" ? "ok" : state == "failed" ? "bad" : "tx3" }

    static let reply = "Reply"
    static let replyPlaceholder = "Type it into the pane"
    static let replyHint = "Or type in the terminal."
    static let shell = "Shell"
    static let notTyped = "Nothing was typed"
}

/// The program's Reply (SESS-056): what the person types goes into its
/// pane with Enter, through the hub's person-only POST /api/program/reply.
final class ProgramReplyBox: Box, NSTextFieldDelegate {
    /// What each program's box holds while the panel draws again, and its last error (by its key).
    static var drafts: [String: String] = [:]
    static var errors: [String: String] = [:]
    let key: String
    private let project: HubProject
    private let session: HubSession
    private weak var hub: HubClient?
    private let say: (String) -> Void
    let field = NSTextField()
    private(set) var sendButton: RButton!
    private let err = label("", Fonts.pt(12), "bad", lines: 4, select: true)
    private(set) var busy = false

    init(key: String, project: HubProject, session: HubSession, hub: HubClient?, width: CGFloat, say: @escaping (String) -> Void) {
        self.key = key; self.project = project; self.session = session; self.hub = hub; self.say = say
        super.init(fill: "card", radius: 10)
        field.placeholderString = ProgramWords.replyPlaceholder
        field.stringValue = ProgramReplyBox.drafts[key] ?? ""
        field.font = Fonts.pt(12.5)
        field.isBordered = true
        field.bezelStyle = .roundedBezel
        field.usesSingleLineMode = true
        field.lineBreakMode = .byTruncatingTail
        field.delegate = self
        field.setAccessibilityLabel(ProgramWords.reply)
        let send = RButton(t("panel.send"), .primary, small: true) { [weak self] in self?.send() }
        sendButton = send
        err.preferredMaxLayoutWidth = width - 28
        let title = label(ProgramWords.reply, Fonts.pt(12, Fonts.w650), "tx2")
        let hint = label(ProgramWords.replyHint, Fonts.pt(12), "tx3")
        let st = vstack([title, field, err, hstack([hint, spring(), send], spacing: 6)], spacing: 8, insets: NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14))
        addSubview(st)
        st.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([st.leadingAnchor.constraint(equalTo: leadingAnchor), st.trailingAnchor.constraint(equalTo: trailingAnchor),
                                     st.topAnchor.constraint(equalTo: topAnchor), st.bottomAnchor.constraint(equalTo: bottomAnchor),
                                     field.widthAnchor.constraint(equalTo: st.widthAnchor, constant: -28)])
        identifier = NSUserInterfaceItemIdentifier("program-reply")
        refresh()
    }
    required init?(coder: NSCoder) { fatalError() }

    private func refresh() {
        let e = ProgramReplyBox.errors[key]
        err.stringValue = e ?? ""
        err.isHidden = e == nil
        sendButton.isEnabled = !busy
    }

    func controlTextDidChange(_ n: Notification) { ProgramReplyBox.drafts[key] = field.stringValue }

    /// Return sends.
    func control(_ c: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) { send(); return true }
        return false
    }

    /// Types the words and Enter into the program's pane; an error stays under the field.
    func send() {
        let text = field.stringValue
        guard !busy, !text.isEmpty, let hub else { return }
        busy = true
        ProgramReplyBox.errors[key] = nil
        refresh()
        let k = key
        hub.post("/api/program/reply", ["projectId": project.id, "surfaceId": session.surfaceId, "text": text]) { [weak self] code, j in
            self?.busy = false
            if code == 200 {
                ProgramReplyBox.drafts[k] = nil
                self?.field.stringValue = ""
            } else {
                ProgramReplyBox.errors[k] = "\(ProgramWords.notTyped): \(j["error"] as? String ?? "the board answered \(code)")"
            }
            self?.refresh()
        }
    }
}
