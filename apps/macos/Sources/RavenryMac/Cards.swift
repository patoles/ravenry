// The checkpoint cards at the top of the session panel, as the Electron
// app draws them (apps/desktop/src/renderer/cards.ts, app.css .cp, .opt,
// .kv, .risk, .sfld, .prom, .cmd-edit; phase2.css .ptiles): a question with
// one answer per line and number keys, a command with its folder, machine
// and pane, Edit (the changed part tinted, the hub's guess rules applied at
// each keystroke) and Refuse with a reason, a secret typed into a field in
// the card, a drive's three answers, a pick's pictures small with Open side
// by side, and what each says once it closed. Every word about the
// checkpoint is the hub's (cp.words), its tokens filled by its fixed rule.
//
// A card is built once per checkpoint and state and kept, so a new board
// state never builds it again under the person's hands. The secret lives
// only in its field: cleared when the field loses the keyboard or the card
// leaves the window, and taken from it straight into the answer.

import AppKit

/// What a card keeps between draws (cards.ts UI).
final class CardUI {
    var editing = false
    var edit = ""
    var refusing = false
    var reason = ""
    var busy = false
    var error: String?
    var draft = ""
    var reveal = false
    var stamp: String { "\(editing)\(refusing)\(busy)\(error ?? "")\(reveal)" }
}

/// What a card needs from the panel.
struct CardCtx {
    var hub: HubClient
    /// Posts an answer (POST /api/checkpoints/answer).
    var answer: (String, [String: Any]) -> Void
    /// Something on the card changed (editing, refusing): it is built again.
    var changed: (String) -> Void
    var openPicker: (String) -> Void
    /// The hub alerts the phone too.
    var phoneToo: Bool
    /// A pane's name as the tabs say it, when this window has it.
    var paneName: (String) -> String?
}

/// Text that wraps in the card's width.
private func cardText(_ s: String, _ font: NSFont, _ color: String = "tx", select: Bool = true) -> NSTextField {
    let l = label(s, font, color, lines: 0, select: select)
    l.preferredMaxLayoutWidth = PanelView.width - 56
    return l
}

/// "waiting 2 min", "waiting 1 h", "just now" (checkpoints.ts waiting).
func cpWaiting(_ cp: [String: Any]) -> String {
    guard let d = When.date(cp["created_at"] as? String) else { return "" }
    let ms = When.now().timeIntervalSince(d) * 1000
    if !(ms >= 60000) { return t("checkpoint.justNow") }
    let m = Int(ms / 60000)
    return m < 60 ? t("checkpoint.waitingMin", ["n": "\(m)"]) : t("checkpoint.waitingH", ["n": "\(m / 60)"])
}

/// The words' tokens filled for this app: on the hub's computer, answers carried as "desktop" (checkpoints.ts fill).
func cpFill(_ s: String, _ w: [String: Any], pane: String? = nil) -> String {
    let m = w["machine"] as? [String: Any] ?? [:]
    let a = w["after"] as? [String: Any] ?? [:]
    let wh = a["where"] as? [String: Any] ?? [:]
    let mine = (wh["by"] as? String) == "desktop"
    return s.replacingOccurrences(of: "{machine}", with: m["here"] as? String ?? "this Mac")
        .replacingOccurrences(of: "{ranOn}", with: m["here"] as? String ?? "this Mac")
        .replacingOccurrences(of: "{where}", with: (mine ? wh["mine"] : wh["other"]) as? String ?? "here")
        .replacingOccurrences(of: "{time}", with: When.clock(a["at"] as? String))
        .replacingOccurrences(of: "{pane}", with: pane ?? (w["drive"] as? [String: Any])?["pane"] as? String ?? "a pane")
}

/// Whether a typed secret can be sent: 4 to 4096 bytes on one line (PROTOCOL.md, checkpoint.answer; input validation, kept in the client).
func secretProblem(_ v: String) -> String? {
    if v.contains("\n") || v.contains("\r") { return t("checkpoint.secretOneLine") }
    let n = v.utf8.count
    if n == 0 { return t("checkpoint.secretEmpty") }
    if n < 4 { return t("checkpoint.secretShort") }
    if n > 4096 { return t("checkpoint.secretLong") }
    return nil
}

/// Where an edited command differs from the proposed one: the range in the edited text (UTF-16), or nil.
func changedRange(_ orig: String, _ edited: String) -> NSRange? {
    if orig == edited { return nil }
    let o = Array(orig.utf16), e = Array(edited.utf16)
    var s = 0
    while s < o.count, s < e.count, o[s] == e[s] { s += 1 }
    var x = 0
    while x < o.count - s, x < e.count - s, o[o.count - 1 - x] == e[e.count - 1 - x] { x += 1 }
    return NSRange(location: s, length: e.count - x - s)
}

/// The warnings for the command that would run: the hub's for the proposed
/// one; for an edit, the agent's own and the first of the hub's guess rules
/// that matches (words.guess, regular expressions as data).
func warningsFor(_ cp: [String: Any], _ w: [String: Any], _ command: String?) -> [[String: Any]] {
    let hubs = w["warnings"] as? [[String: Any]] ?? []
    guard let c = command, c != (cp["command"] as? String), let g = w["guess"] as? [String: Any] else { return hubs }
    var out = hubs.filter { $0["from"] as? String == "agent" }
    for r in g["rules"] as? [[String: Any]] ?? [] {
        let flags = r["flags"] as? String ?? ""
        guard let re = try? NSRegularExpression(pattern: r["pattern"] as? String ?? "", options: flags.contains("i") ? [.caseInsensitive] : []) else { continue }
        if re.firstMatch(in: c, range: NSRange(c.startIndex..., in: c)) != nil {
            out.append(["from": "ravenry", "label": g["label"] as? String ?? "", "text": r["text"] as? String ?? ""])
            break
        }
    }
    return out
}

/// .opt: an answer on its own line, its number key before it.
final class OptRow: Box {
    var run: (() -> Void)?
    var enabled = true { didSet { alphaValue = enabled ? 1 : 0.5 } }
    let text: String
    init(_ n: Int?, _ text: String, sub: String? = nil, no: Bool = false, run: @escaping () -> Void) {
        self.text = text
        self.run = run
        super.init(fill: "btn", radius: 7)
        translatesAutoresizingMaskIntoConstraints = false
        var items: [NSView?] = []
        if let k = n, k <= 9 {
            let kb = Box(ring: "sep", radius: 4)
            kb.translatesAutoresizingMaskIntoConstraints = false
            let kl = label("\(k)", Fonts.pt(10.5, Fonts.w650), "tx3")
            kl.translatesAutoresizingMaskIntoConstraints = false
            kb.addSubview(kl)
            NSLayoutConstraint.activate([kb.widthAnchor.constraint(equalToConstant: 17), kb.heightAnchor.constraint(equalToConstant: 17),
                                         kl.centerXAnchor.constraint(equalTo: kb.centerXAnchor), kl.centerYAnchor.constraint(equalTo: kb.centerYAnchor)])
            items.append(kb)
        }
        let tl = label(text, Fonts.pt(13, .medium), no ? "bad" : "btn-tx", lines: 0)
        tl.preferredMaxLayoutWidth = PanelView.width - 56 - 50
        items.append(sub.map { vstack([tl, label($0, Fonts.pt(11.5), "tx3", lines: 0)], spacing: 2) } ?? tl)
        items.append(spring())
        let s = hstack(items, spacing: 9, insets: NSEdgeInsets(top: 7, left: 10, bottom: 7, right: 10))
        s.alignment = .centerY
        s.translatesAutoresizingMaskIntoConstraints = false
        addSubview(s)
        NSLayoutConstraint.activate([s.leadingAnchor.constraint(equalTo: leadingAnchor), s.trailingAnchor.constraint(equalTo: trailingAnchor),
                                     s.topAnchor.constraint(equalTo: topAnchor), s.bottomAnchor.constraint(equalTo: bottomAnchor),
                                     heightAnchor.constraint(greaterThanOrEqualToConstant: 34)])
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(text)
    }
    required init?(coder: NSCoder) { fatalError() }
    func press() { if enabled { run?() } }
    override func mouseDown(with e: NSEvent) { press() }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { press(); return true }
}

/// A text view that tells Esc and Cmd+Enter (the command being edited).
final class KeyTextView: NSTextView {
    var onEscape: (() -> Void)?
    var onCommandReturn: (() -> Void)?
    var onReturn: (() -> Void)?
    override func keyDown(with e: NSEvent) {
        if e.keyCode == 53 { onEscape?(); return }
        if e.keyCode == 36 || e.keyCode == 76 {
            if e.modifierFlags.contains(.command), let f = onCommandReturn { f(); return }
            if !e.modifierFlags.contains(.shift), let f = onReturn { f(); return }
        }
        super.keyDown(with: e)
    }
}

/// A one-line field in an .fld box, with a send button at its end (an ask's own words, a drive's "something else").
final class SendField: Box, NSTextFieldDelegate {
    let field = NSTextField(string: "")
    let go: RButton
    var onChange: ((String) -> Void)?
    var onSend: ((String) -> Void)?
    var onEscape: (() -> Void)?
    /// Enter sends an empty field too (a refusal's optional reason).
    var allowEmpty = false
    init(_ placeholder: String, text: String, button: Bool = true) {
        go = RButton(t("checkpoint.send"), .icon, small: true, icon: "send")
        super.init(fill: "input", ring: "sep", radius: 7)
        translatesAutoresizingMaskIntoConstraints = false
        field.stringValue = text
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = Fonts.pt(12.5)
        field.textColor = Design.color("tx")
        field.placeholderAttributedString = NSAttributedString(string: placeholder, attributes: [.font: Fonts.pt(12.5), .foregroundColor: Design.color("tx3")])
        field.setAccessibilityLabel(placeholder)
        field.delegate = self
        field.cell?.isScrollable = true
        field.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        go.refusesFirstResponder = true
        go.run = { [weak self] in self?.send() }
        let s = hstack([field, button ? go : nil], spacing: 6, insets: NSEdgeInsets(top: 4, left: 10, bottom: 4, right: 4))
        s.alignment = .centerY
        s.translatesAutoresizingMaskIntoConstraints = false
        addSubview(s)
        NSLayoutConstraint.activate([s.leadingAnchor.constraint(equalTo: leadingAnchor), s.trailingAnchor.constraint(equalTo: trailingAnchor),
                                     s.centerYAnchor.constraint(equalTo: centerYAnchor), heightAnchor.constraint(equalToConstant: 34)])
    }
    required init?(coder: NSCoder) { fatalError() }
    func send() {
        let v = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if v.isEmpty && !allowEmpty { if field.currentEditor() == nil { window?.makeFirstResponder(field) }; return }
        onSend?(v)
    }
    func controlTextDidBeginEditing(_ n: Notification) { ring = "work"; ringWidth = 1.5 }
    func controlTextDidEndEditing(_ n: Notification) { ring = "sep"; ringWidth = 1 }
    func controlTextDidChange(_ n: Notification) { onChange?(field.stringValue) }
    func control(_ c: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) { send(); return true }
        if sel == #selector(NSResponder.cancelOperation(_:)), let f = onEscape { f(); return true }
        return false
    }
    override func mouseDown(with e: NSEvent) { window?.makeFirstResponder(field) }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
}

/// The secret's field (.sfld): the secret lives only in it, never copied
/// elsewhere; cleared when it loses the keyboard; take() hands it to the
/// one answer call and clears it.
final class SecretBox: Box, NSTextFieldDelegate {
    let secure = NSSecureTextField(string: "")
    let shown = NSTextField(string: "")
    let count = label("", Fonts.pt(11.5).withTabularDigits, "tx3")
    let eye: RButton
    var onSend: (() -> Void)?
    private(set) var reveal: Bool
    private var swapping = false
    init(_ placeholder: String, reveal: Bool) {
        self.reveal = reveal
        eye = RButton(reveal ? t("checkpoint.secretHide") : t("checkpoint.secretShow"), .icon, small: true, icon: reveal ? "eye-off" : "eye")
        super.init(fill: "input", ring: "sep", radius: 7)
        translatesAutoresizingMaskIntoConstraints = false
        for f in [secure, shown] as [NSTextField] {
            f.isBordered = false
            f.drawsBackground = false
            f.focusRingType = .none
            f.font = Fonts.pt(13)
            f.textColor = Design.color("tx")
            f.placeholderAttributedString = NSAttributedString(string: placeholder, attributes: [.font: Fonts.pt(12.5), .foregroundColor: Design.color("tx3")])
            f.setAccessibilityLabel(placeholder)
            f.delegate = self
            f.cell?.isScrollable = true
            f.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        }
        secure.isHidden = reveal
        shown.isHidden = !reveal
        eye.refusesFirstResponder = true
        eye.run = { [weak self] in self?.toggle() }
        let s = hstack([secure, shown, count, eye], spacing: 6, insets: NSEdgeInsets(top: 0, left: 10, bottom: 0, right: 4))
        s.alignment = .centerY
        s.translatesAutoresizingMaskIntoConstraints = false
        addSubview(s)
        NSLayoutConstraint.activate([s.leadingAnchor.constraint(equalTo: leadingAnchor), s.trailingAnchor.constraint(equalTo: trailingAnchor),
                                     s.centerYAnchor.constraint(equalTo: centerYAnchor), heightAnchor.constraint(equalToConstant: 36)])
    }
    required init?(coder: NSCoder) { fatalError() }
    var field: NSTextField { reveal ? shown : secure }
    /// How many characters are in the field (never which).
    var characters: Int { field.stringValue.count }
    var problem: String? { secretProblem(field.stringValue) }
    func clear() {
        if secure.stringValue.isEmpty && shown.stringValue.isEmpty { return }
        secure.stringValue = ""
        shown.stringValue = ""
        recount()
    }
    /// The secret, for the answer call only; the field is empty when this returns.
    func take() -> String {
        let v = field.stringValue
        clear()
        return v
    }
    private func recount() {
        let n = characters
        count.stringValue = n == 0 ? "" : n == 1 ? t("checkpoint.character") : t("checkpoint.characters", ["n": "\(n)"])
    }
    /// Show it or hide it: the text moves to the other field, the keyboard with it.
    func toggle() {
        swapping = true
        let from = field
        reveal.toggle()
        let to = field
        to.stringValue = from.stringValue
        from.stringValue = ""
        from.isHidden = true
        to.isHidden = false
        window?.makeFirstResponder(to)
        if let ed = to.currentEditor() { ed.selectedRange = NSRange(location: to.stringValue.utf16.count, length: 0) }
        swapping = false
        eye.setAccessibilityLabel(reveal ? t("checkpoint.secretHide") : t("checkpoint.secretShow"))
        eye.toolTip = reveal ? t("checkpoint.secretHide") : t("checkpoint.secretShow")
        eye.iconView?.name = reveal ? "eye-off" : "eye"
    }
    func controlTextDidBeginEditing(_ n: Notification) { ring = "work"; ringWidth = 1.5 }
    /// Focus left the field (another part of the window, another app): what was typed goes.
    func controlTextDidEndEditing(_ n: Notification) {
        ring = "sep"; ringWidth = 1
        if !swapping { clear() }
    }
    func controlTextDidChange(_ n: Notification) {
        // A paste with a line break at the end keeps the key, not the break.
        let v = field.stringValue
        if v.hasSuffix("\n") || v.hasSuffix("\r") { field.stringValue = v.replacingOccurrences(of: "[\\r\\n]+$", with: "", options: .regularExpression) }
        recount()
    }
    func control(_ c: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) { onSend?(); return true }
        return false
    }
    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); if window == nil { clear() } }
    override func mouseDown(with e: NSEvent) { window?.makeFirstResponder(field) }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
}

/// One checkpoint's card (.sec.cp), built for its state and what the person did on it.
final class CheckpointCard: Box {
    let id: String
    let key: String
    private let cp: [String: Any]
    private let w: [String: Any]
    private let u: CardUI
    private let ctx: CardCtx
    /// What the self-test presses: the card's buttons and answers by name.
    private(set) var buttons: [String: RButton] = [:]
    private(set) var opts: [String: OptRow] = [:]
    private(set) var sendField: SendField?
    private(set) var secret: SecretBox?
    private(set) var editor: KeyTextView?
    private(set) var reasonField: SendField?
    private(set) var tiles: [CoverImage] = []
    private var warnStack: NSStackView?
    private var waitingLabel: NSTextField?
    private var focusView: NSView?

    var kind: String { w["kind"] as? String ?? "other" }

    init(_ cp: [String: Any], ui: CardUI, ctx: CardCtx, key: String) {
        self.cp = cp
        self.id = cp["id"] as? String ?? ""
        self.w = cp["words"] as? [String: Any] ?? [:]
        self.u = ui
        self.ctx = ctx
        self.key = key
        super.init(fill: "card", ring: "you", radius: 10)
        translatesAutoresizingMaskIntoConstraints = false
        let open = (cp["state"] as? String) == "open"
        let rows: [NSView?] = open ? openRows() : afterRows()
        let st = vstack(rows, spacing: 10)
        st.translatesAutoresizingMaskIntoConstraints = false
        addSubview(st)
        NSLayoutConstraint.activate([st.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14), st.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
                                     st.topAnchor.constraint(equalTo: topAnchor, constant: 12), st.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12)])
        if !open { ring = nil }
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("\(w["heading"] as? String ?? ""): \(kind == "approve" ? cp["command"] as? String ?? "" : w["head"] as? String ?? "")")
    }
    required init?(coder: NSCoder) { fatalError() }

    /// The times in it moved on.
    func refresh() { waitingLabel?.stringValue = kind == "pick" ? cpWaiting(cp).replacingOccurrences(of: "waiting ", with: "") : cpWaiting(cp) }

    /// Where the keyboard goes when the card is opened: the secret's field, the editor, the reason, else the card (number keys answer).
    func focus() {
        guard let win = window else { return }
        win.makeFirstResponder(focusView ?? self)
    }

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func mouseDown(with e: NSEvent) { window?.makeFirstResponder(self) }
    override func keyDown(with e: NSEvent) { if !numberKey(e.charactersIgnoringModifiers ?? "", e.modifierFlags) { super.keyDown(with: e) } }

    /// A number key typed while the card has the keyboard: its answer (cards.ts cardKey).
    @discardableResult
    func numberKey(_ key: String, _ mods: NSEvent.ModifierFlags = []) -> Bool {
        if !mods.intersection([.command, .control, .option]).isEmpty || u.busy { return false }
        guard (cp["state"] as? String) == "open", let n = Int(key), key.count == 1, n >= 1 else { return false }
        switch kind {
        case "drive":
            // As the Electron app: 1 once, 2 for the session (when it may), 3 refuse.
            let hasSession = (w["drive"] as? [String: Any])?["session"] is String
            guard n <= 3, n != 2 || hasSession else { return false }
            ctx.answer(id, n == 1 ? ["approve": true, "allow": "once"] : n == 2 ? ["approve": true, "allow": "session"] : ["decline": true])
            return true
        case "pick":
            if n > (cp["variants"] as? [Any] ?? []).count || n > 4 { return false }
            ctx.openPicker(id)
            return true
        case "ask":
            let options = cp["options"] as? [String] ?? []
            guard n <= 9, n - 1 < options.count else { return false }
            ctx.answer(id, ["choice": n - 1])
            return true
        default: return false
        }
    }

    // MARK: open cards

    private func header(_ icon: String, short: Bool = false, heading: String? = nil) -> NSView {
        let wl = label(short ? cpWaiting(cp).replacingOccurrences(of: "waiting ", with: "") : cpWaiting(cp), Fonts.pt(12, .medium).withTabularDigits, "tx3")
        waitingLabel = wl
        let hl = label(heading ?? w["heading"] as? String ?? "", Fonts.pt(12, Fonts.w650), "you")
        hl.setContentCompressionResistancePriority(.init(700), for: .horizontal)
        wl.setContentCompressionResistancePriority(.init(700), for: .horizontal)
        return hstack([Icon(icon, "you", size: 14), hl, spring(), wl], spacing: 6)
    }

    private func footer() -> NSView {
        var items: [NSView?] = []
        if ctx.phoneToo { items += [Icon("phone-s", "tx3", size: 12), label(t("checkpoint.phoneToo"), Fonts.pt(11.5), "tx3")] }
        items.append(spring())
        if let exp = When.date(cp["expires_at"] as? String) {
            let c = Calendar.current.dateComponents([.hour, .minute], from: exp)
            items.append(label(t("checkpoint.givesUp", ["time": String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)]), Fonts.pt(11.5).withTabularDigits, "tx3"))
        }
        return hstack(items, spacing: 6)
    }

    private func errorLine() -> NSView? { u.error.map { cardText($0, Fonts.pt(12), "bad") } }

    private func button(_ name: String, _ title: String, _ kind: RButton.Kind, run: @escaping () -> Void) -> RButton {
        let b = RButton(title, kind, small: true, run: run)
        b.isEnabled = !u.busy
        b.refusesFirstResponder = true
        buttons[name] = b
        return b
    }

    private func openRows() -> [NSView?] {
        switch kind {
        case "ask": return askRows()
        case "approve": return approveRows()
        case "secret": return secretRows()
        case "drive": return driveRows()
        case "pick": return pickRows()
        default: return otherRows()
        }
    }

    private func question() -> NSView { cardText(w["head"] as? String ?? "", Fonts.pt(14, .semibold)) }
    private func body() -> NSView? {
        guard let b = (w["checks"] as? [String: Any])?["text"] as? String ?? w["body"] as? String else { return nil }
        return cardText(b, Fonts.pt(12.5), "tx2")
    }

    private func askRows() -> [NSView?] {
        var rows: [NSView?] = [header("ask"), question(), body()]
        let options = cp["options"] as? [String] ?? []
        if !options.isEmpty {
            rows.append(vstack(options.enumerated().map { i, o -> NSView in
                let r = OptRow(i + 1, o) { [weak self] in self?.ctx.answer(self?.id ?? "", ["choice": i]) }
                r.enabled = !u.busy
                opts["\(i + 1)"] = r
                return r
            }, spacing: 6))
        }
        if cp["free_text"] as? Bool ?? false {
            let f = SendField(t("checkpoint.ownWords"), text: u.draft)
            f.onChange = { [weak self] s in self?.u.draft = s }
            f.onSend = { [weak self] s in self?.ctx.answer(self?.id ?? "", ["text": String(s.prefix(4096))]) }
            f.field.isEnabled = !u.busy
            sendField = f
            rows.append(f)
            if options.isEmpty { focusView = f.field }
        }
        rows += [errorLine(), footer()]
        return rows
    }

    /// Refuse, with a reason if the person types one: Enter or Refuse sends, Escape or Back closes it.
    private func refuseRows() -> [NSView?] {
        let who = w["whoMid"] as? String ?? "the agent"
        let f = SendField(t("checkpoint.whyNot", ["who": who]), text: u.reason, button: false)
        f.onChange = { [weak self] s in self?.u.reason = s }
        let go = { [weak self] in
            guard let self else { return }
            let r = f.field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            self.ctx.answer(self.id, r.isEmpty ? ["decline": true] : ["decline": true, "reason": String(r.prefix(1000))])
        }
        f.allowEmpty = true
        f.onSend = { _ in go() }
        f.onEscape = { [weak self] in self?.u.refusing = false; self.map { $0.ctx.changed($0.id) } }
        reasonField = f
        focusView = f.field
        return [f,
                hstack([button("refuseSend", t("checkpoint.refuse"), .no, run: go),
                        button("back", t("checkpoint.back"), .normal) { [weak self] in self?.u.refusing = false; self.map { $0.ctx.changed($0.id) } }, spring()], spacing: 6),
                errorLine(),
                label(t("checkpoint.toldNo", ["who": w["who"] as? String ?? "The agent"]), Fonts.pt(11.5), "tx3", lines: 0)]
    }

    private func refuseButton() -> RButton {
        // .btn.sm.ghost.no: no fill, its words red.
        let b = button("refuse", t("checkpoint.refuse"), .ghost) { [weak self] in
            guard let self else { return }
            self.u.refusing = true; self.u.editing = false; self.u.error = nil
            self.ctx.changed(self.id)
        }
        b.titleColor = "bad"
        return b
    }

    private func commandBlock(_ s: String, muted: Bool = false) -> NSView {
        let l = label(s, Fonts.mono(12), "", lines: 0, select: true)
        l.textColor = NSColor(srgbRed: 0xF2 / 255, green: 0xF2 / 255, blue: 0xF4 / 255, alpha: 1)
        l.preferredMaxLayoutWidth = PanelView.width - 56 - 22
        let b = boxed(l, fill: "term-bg", radius: 7, insets: NSEdgeInsets(top: 9, left: 11, bottom: 9, right: 11))
        if muted { b.alphaValue = 0.55 }
        return b
    }

    private func kv(_ pairs: [(String, NSView)], keyWidth: CGFloat = 52) -> NSView {
        let keys = pairs.map { label($0.0, Fonts.pt(12), "tx3") }
        let g = NSGridView(views: zip(keys, pairs).map { [$0.0, $0.1.1] })
        // A variable's name is never cut: the column widens to it.
        let kw = max(keyWidth, keys.map { ceil($0.intrinsicContentSize.width) }.max() ?? 0)
        g.column(at: 0).width = kw
        // The values wrap in what the key column leaves.
        for (_, v) in pairs { (v as? NSTextField)?.preferredMaxLayoutWidth = PanelView.width - 56 - kw - 8 }
        g.rowSpacing = 5
        g.columnSpacing = 8
        g.yPlacement = .top
        return g
    }

    private func approveRows() -> [NSView?] {
        let command = cp["command"] as? String ?? ""
        var rows: [NSView?] = [header("run")]
        if u.editing {
            let tv = KeyTextView()
            tv.isRichText = false
            tv.font = Fonts.mono(12)
            tv.textColor = Design.color("tx")
            tv.drawsBackground = false
            tv.isAutomaticQuoteSubstitutionEnabled = false
            tv.isAutomaticDashSubstitutionEnabled = false
            tv.isAutomaticTextReplacementEnabled = false
            tv.isContinuousSpellCheckingEnabled = false
            tv.textContainerInset = NSSize(width: 7, height: 9)
            tv.isVerticallyResizable = true
            tv.isHorizontallyResizable = false
            tv.textContainer?.widthTracksTextView = true
            tv.maxSize = NSSize(width: 1000, height: 400)
            tv.string = u.edit
            tv.setAccessibilityLabel("The command to run")
            tv.onEscape = { [weak self] in self?.u.editing = false; self.map { $0.ctx.changed($0.id) } }
            tv.onCommandReturn = { [weak self] in self?.runEdited() }
            let box = Box(fill: "input", ring: "work", radius: 7)
            box.ringWidth = 1.5
            box.translatesAutoresizingMaskIntoConstraints = false
            tv.translatesAutoresizingMaskIntoConstraints = false
            box.addSubview(tv)
            let lines = max(1, u.edit.components(separatedBy: "\n").count)
            let hc = box.heightAnchor.constraint(equalToConstant: 0)
            NSLayoutConstraint.activate([tv.leadingAnchor.constraint(equalTo: box.leadingAnchor), tv.trailingAnchor.constraint(equalTo: box.trailingAnchor),
                                         tv.topAnchor.constraint(equalTo: box.topAnchor), tv.bottomAnchor.constraint(equalTo: box.bottomAnchor), hc])
            let fit = { [weak tv, weak hc] in
                guard let tv, let hc, let lm = tv.layoutManager, let tc = tv.textContainer else { return }
                lm.ensureLayout(for: tc)
                hc.constant = max(40, ceil(lm.usedRect(for: tc).height) + 18)
            }
            hc.constant = max(40, CGFloat(lines) * 18 + 18)
            editor = tv
            NotificationCenter.default.addObserver(forName: NSText.didChangeNotification, object: tv, queue: .main) { [weak self, weak tv] _ in
                guard let self, let tv else { return }
                self.u.edit = tv.string
                self.tint(tv, command)
                self.setWarnings(warningsFor(self.cp, self.w, tv.string))
                fit()
            }
            tint(tv, command)
            DispatchQueue.main.async { fit() }
            focusView = tv
            rows.append(box)
        } else {
            rows.append(commandBlock(command))
        }
        let m = w["machine"] as? [String: Any] ?? [:]
        let remote = m["remote"] as? Bool ?? false
        let cwd = (cp["cwd"] as? String).map { $0.hasPrefix(NSHomeDirectory()) ? "~" + $0.dropFirst(NSHomeDirectory().count) : $0 } ?? ""
        var pairs: [(String, NSView)] = [
            (t("checkpoint.folder"), cardText(cwd, Fonts.mono(12))),
            (t("checkpoint.machine"), remote ? hstack([Icon("machine", "tx2", size: 12), label(m["here"] as? String ?? "", Fonts.pt(12.5))], spacing: 4) : cardText(m["line"] as? String ?? "", Fonts.pt(12.5))),
            (t("checkpoint.pane"), cardText((cp["pane"] as? String).map { t("checkpoint.paneBeside", ["pane": ctx.paneName($0) ?? $0]) } ?? t("checkpoint.paneNew"), Fonts.pt(12.5))),
        ]
        // A page's run button passes the item's values as variables: shown as they are, never inside the command.
        for (k, v) in (cp["env"] as? [String: Any] ?? [:]).sorted(by: { $0.key < $1.key }) { pairs.append((k, cardText("\(v)", Fonts.mono(12)))) }
        rows.append(kv(pairs))
        let ws = vstack([], spacing: 6)
        warnStack = ws
        setWarnings(warningsFor(cp, w, u.editing ? u.edit : command))
        rows.append(ws)
        if let why = cp["why"] as? String, !why.isEmpty {
            let a = NSMutableAttributedString(string: t("checkpoint.whoSays", ["who": w["who"] as? String ?? "The agent"]) + " ", attributes: [.font: Fonts.pt(12.5), .foregroundColor: Design.color("tx3")])
            a.append(NSAttributedString(string: why, attributes: [.font: Fonts.pt(12.5), .foregroundColor: Design.color("tx2")]))
            let l = cardText("", Fonts.pt(12.5), "tx2")
            l.attributedStringValue = a
            rows.append(l)
        }
        if u.refusing && !u.editing { return rows + refuseRows() }
        if u.editing {
            rows.append(hstack([button("runEdited", t("checkpoint.runEdited"), .primary) { [weak self] in self?.runEdited() },
                                button("cancel", t("checkpoint.cancel"), .normal) { [weak self] in self?.u.editing = false; self.map { $0.ctx.changed($0.id) } }, spring()], spacing: 6))
            rows.append(errorLine())
            rows.append(label(t("checkpoint.toldChanged", ["who": w["who"] as? String ?? "The agent"]), Fonts.pt(11.5), "tx3"))
            return rows
        }
        rows.append(hstack([button("run", cpFill(w["runLabel"] as? String ?? t("checkpoint.run"), w), .primary) { [weak self] in self.map { $0.ctx.answer($0.id, ["approve": true]) } },
                            button("edit", t("checkpoint.edit"), .normal) { [weak self] in
                                guard let self else { return }
                                self.u.editing = true; self.u.edit = command; self.u.error = nil
                                self.ctx.changed(self.id)
                            },
                            refuseButton(), spring()], spacing: 6))
        rows += [errorLine(), footer()]
        return rows
    }

    private func setWarnings(_ list: [[String: Any]]) {
        guard let ws = warnStack else { return }
        for v in ws.arrangedSubviews { ws.removeArrangedSubview(v); v.removeFromSuperview() }
        for x in list {
            let a = NSMutableAttributedString(string: (x["label"] as? String ?? "") + " ", attributes: [.font: Fonts.pt(12, .medium), .foregroundColor: Design.color("tx2")])
            a.append(NSAttributedString(string: x["text"] as? String ?? "", attributes: [.font: Fonts.pt(12, .medium), .foregroundColor: Design.color("you")]))
            let l = label("", Fonts.pt(12), "you", lines: 0, select: true)
            l.preferredMaxLayoutWidth = PanelView.width - 56 - 20
            l.attributedStringValue = a
            let row = hstack([Icon("warn", "you", size: 14), l], spacing: 6)
            row.alignment = .top
            ws.addArrangedSubview(row)
        }
        ws.isHidden = list.isEmpty
    }

    /// The editor's text, its changed part tinted (--chg).
    private func tint(_ tv: NSTextView, _ orig: String) {
        guard let ts = tv.textStorage else { return }
        let all = NSRange(location: 0, length: ts.length)
        ts.beginEditing()
        ts.removeAttribute(.backgroundColor, range: all)
        ts.addAttributes([.font: Fonts.mono(12), .foregroundColor: Design.color("tx")], range: all)
        if let r = changedRange(orig, tv.string), r.length > 0, NSMaxRange(r) <= ts.length { ts.addAttribute(.backgroundColor, value: Design.color("chg"), range: r) }
        ts.endEditing()
    }

    func runEdited() {
        let command = cp["command"] as? String ?? ""
        let v = (editor?.string ?? u.edit).replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
        if v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { if let e = editor { window?.makeFirstResponder(e) }; return }
        ctx.answer(id, v == command ? ["approve": true] : ["approve": true, "command": v])
    }

    private func secretRows() -> [NSView?] {
        let who = w["whoMid"] as? String ?? "the agent"
        let sec = cp["secret"] as? [String: Any] ?? [:]
        let toPane = sec["to"] as? String == "input"
        let noun = (w["secret"] as? [String: Any])?["noun"] as? String ?? "secret"
        var rows: [NSView?] = [header("key"), question()]
        if toPane {
            let pane = (sec["pane"] as? String).flatMap { ctx.paneName($0) ?? $0 } ?? "a pane"
            let s = t("checkpoint.typedInto", ["pane": pane])
            let a = NSMutableAttributedString(string: s, attributes: [.font: Fonts.pt(12.5), .foregroundColor: Design.color("tx2")])
            a.addAttributes([.foregroundColor: Design.color("tx"), .font: Fonts.pt(12.5, .medium)], range: (s as NSString).range(of: pane))
            let l = cardText("", Fonts.pt(12.5), "tx2"); l.attributedStringValue = a
            rows.append(l)
        } else {
            let cmd = cp["command"] as? String ?? ""
            let a = NSMutableAttributedString(string: t("checkpoint.secretFor", ["command": ""]), attributes: [.font: Fonts.pt(12.5), .foregroundColor: Design.color("tx2")])
            a.append(NSAttributedString(string: cmd, attributes: [.font: Fonts.mono(12), .foregroundColor: Design.color("tx")]))
            if let c = cp["cwd"] as? String {
                let cw = c.hasPrefix(NSHomeDirectory()) ? "~" + c.dropFirst(NSHomeDirectory().count) : c
                a.append(NSAttributedString(string: t("checkpoint.secretIn", ["cwd": String(cw)]), attributes: [.font: Fonts.pt(12.5), .foregroundColor: Design.color("tx2")]))
            }
            if sec["to"] as? String == "env", let env = sec["env"] as? String {
                a.append(NSAttributedString(string: t("checkpoint.secretAs", ["env": env]), attributes: [.font: Fonts.pt(12.5), .foregroundColor: Design.color("tx2")]))
            }
            let l = cardText("", Fonts.pt(12.5), "tx2"); l.attributedStringValue = a
            rows.append(l)
        }
        let box = SecretBox(t("checkpoint.secretPaste", ["noun": noun]), reveal: u.reveal)
        box.secure.isEnabled = !u.busy
        box.shown.isEnabled = !u.busy
        box.onSend = { [weak self] in self?.sendSecret() }
        box.eye.run = { [weak self, weak box] in box?.toggle(); self?.u.reveal = box?.reveal ?? false }
        secret = box
        focusView = box.field
        rows.append(box)
        let prom = { (s: String) -> NSView in
            let l = label(s, Fonts.pt(12), "tx2", lines: 0)
            l.preferredMaxLayoutWidth = PanelView.width - 56 - 20
            let r = hstack([Icon("lock", "ok", size: 13), l], spacing: 7)
            r.alignment = .top
            return r
        }
        rows.append(vstack([prom(toPane ? t("checkpoint.toProgram", ["who": who]) : t("checkpoint.toCommand", ["who": who])), prom(t("checkpoint.notKept"))], spacing: 4))
        rows.append(hstack([button("secretSend", t("checkpoint.secretSend"), .primary) { [weak self] in self?.sendSecret() },
                            button("notNow", t("checkpoint.notNow"), .ghost) { [weak self] in
                                guard let self else { return }
                                self.secret?.clear()
                                self.ctx.answer(self.id, ["decline": true])
                            }, spring()], spacing: 6))
        rows += [errorLine(), footer()]
        return rows
    }

    /// The only place the secret leaves its field: straight into the answer.
    func sendSecret() {
        guard let box = secret else { return }
        if box.problem != nil { if box.field.currentEditor() == nil { window?.makeFirstResponder(box.field) }; return }
        ctx.answer(id, ["secret": box.take()])
    }

    private func driveRows() -> [NSView?] {
        let d = w["drive"] as? [String: Any] ?? [:]
        let who = w["who"] as? String ?? "The agent"
        var rows: [NSView?] = [header("keyboard", heading: "\(who) \(d["wants"] as? String ?? "")"), cardText(cpFill(d["title"] as? String ?? "", w), Fonts.pt(14, .semibold))]
        let pane = d["pane"] as? String ?? ""
        rows.append(kv([(t("checkpoint.pane"), cardText(pane, Fonts.pt(12.5, .semibold)))], keyWidth: 60))
        let input = (cp["drive"] as? [String: Any])?["input"] as? String ?? ""
        if !input.isEmpty, d["action"] as? String != "type" { rows.append(commandBlock(input)) }
        if !input.isEmpty, d["action"] as? String == "type" {
            rows.append(label(t("checkpoint.wouldPress"), Fonts.pt(12, Fonts.w650), "tx2"))
            rows.append(commandBlock(input.replacingOccurrences(of: "\r", with: " ⏎ ").replacingOccurrences(of: "\n", with: " ⏎ ")))
        }
        if let why = (cp["drive"] as? [String: Any])?["reason"] as? String { rows.append(cardText("\(t("checkpoint.whoSays", ["who": who])) \(why)", Fonts.pt(12.5), "tx2")) }
        var list: [NSView] = []
        let opt = { [self] (n: Int, text: String, sub: String?, reply: [String: Any], no: Bool) in
            let r = OptRow(n, text, sub: sub, no: no) { [weak self] in self.map { $0.ctx.answer($0.id, reply) } }
            r.enabled = !u.busy
            opts["\(n)"] = r
            list.append(r)
        }
        opt(1, d["once"] as? String ?? "Allow once", nil, ["approve": true, "allow": "once"], false)
        if let s = d["session"] as? String { opt(2, s, d["sessionSub"] as? String, ["approve": true, "allow": "session"], false) }
        opt(d["session"] is String ? 3 : 2, t("checkpoint.refuse"), nil, ["decline": true], true)
        rows.append(vstack(list, spacing: 6))
        let f = SendField(t("checkpoint.tellElse", ["who": who]), text: u.reason)
        f.onChange = { [weak self] s in self?.u.reason = s }
        f.onSend = { [weak self] s in self.map { $0.ctx.answer($0.id, ["decline": true, "reason": String(s.prefix(1000))]) } }
        sendField = f
        rows += [f, errorLine(), footer()]
        return rows
    }

    private func pickRows() -> [NSView?] {
        let vs = cp["variants"] as? [[String: Any]] ?? []
        let names = w["variants"] as? [[String: Any]] ?? []
        var rows: [NSView?] = [header("pick", short: true), question()]
        var cells: [NSView] = []
        for (n, v) in vs.enumerated() {
            let letter = n < names.count ? names[n]["letter"] as? String ?? "\(n + 1)" : "\(n + 1)"
            let name = v["label"] as? String ?? ""
            let img = CoverImage()
            img.radius = 6
            img.fillColor = Design.color("card2")
            img.toolTip = "Open \(name) side by side"
            img.onClick = { [weak self] in self.map { $0.ctx.openPicker($0.id) } }
            img.setAccessibilityLabel(name)
            img.translatesAutoresizingMaskIntoConstraints = false
            img.heightAnchor.constraint(equalTo: img.widthAnchor, multiplier: 10.0 / 16).isActive = true
            ctx.hub.data("/api/checkpoints/\(id)/variants/\(n)") { [weak img] d in img?.image = d.flatMap(NSImage.init(data:)) }
            tiles.append(img)
            let frame = Box(ring: "sep", radius: 6)
            frame.translatesAutoresizingMaskIntoConstraints = false
            frame.addSubview(img)
            let badge = boxed(label(letter, Fonts.pt(10.5, .bold), ""), fill: nil, radius: 5, insets: NSEdgeInsets(top: 1, left: 5, bottom: 1, right: 5))
            badge.rawFill = NSColor(srgbRed: 20 / 255, green: 20 / 255, blue: 22 / 255, alpha: 0.82)
            (badge.subviews.first as? NSTextField)?.textColor = .white
            frame.addSubview(badge)
            NSLayoutConstraint.activate([img.leadingAnchor.constraint(equalTo: frame.leadingAnchor), img.trailingAnchor.constraint(equalTo: frame.trailingAnchor),
                                         img.topAnchor.constraint(equalTo: frame.topAnchor), img.bottomAnchor.constraint(equalTo: frame.bottomAnchor),
                                         badge.leadingAnchor.constraint(equalTo: frame.leadingAnchor, constant: 5), badge.topAnchor.constraint(equalTo: frame.topAnchor, constant: 5)])
            let cap = label("\(letter). \(name)", Fonts.pt(12), "tx2")
            cells.append(vstack([frame, cap], spacing: 5))
        }
        let openB = button("openPicker", t("pick.openSide"), .primary) { [weak self] in self.map { $0.ctx.openPicker($0.id) } }
        let open = vstack([openB, label(t("pick.orPress", ["keys": vs.indices.map { "\($0 + 1)" }.joined(separator: ", ")]), Fonts.pt(11.5), "tx3")], spacing: 6)
        open.alignment = .centerX
        if vs.count % 2 == 1 { cells.append(vstack([spring(), open, spring()], spacing: 0)) }
        var grid: [NSView] = []
        var i = 0
        while i < cells.count {
            let a = cells[i], b = i + 1 < cells.count ? cells[i + 1] : NSView()
            let r = NSStackView(views: [a, b])
            r.orientation = .horizontal
            r.distribution = .fillEqually
            r.alignment = .top
            r.spacing = 8
            grid.append(r)
            i += 2
        }
        rows.append(vstack(grid, spacing: 8))
        if vs.count % 2 == 0 { rows.append(hstack([open, spring()], spacing: 0)) }
        rows.append(footer())
        return rows
    }

    private func otherRows() -> [NSView?] {
        var rows: [NSView?] = [header("ask"), question(), body(), cardText(t("checkpoint.unknownKind"), Fonts.pt(12.5), "tx2")]
        if u.refusing { return rows + refuseRows() }
        rows += [hstack([refuseButton(), spring()], spacing: 0), errorLine(), footer()]
        return rows
    }

    // MARK: after

    private func afterRows() -> [NSView?] {
        let a = w["after"] as? [String: Any] ?? [:]
        let ok = a["ok"] as? Bool ?? false
        return [hstack([Icon(ok ? "done" : "ended", ok ? "ok" : "tx2", size: 14), label(cpFill(a["head"] as? String ?? "", w), Fonts.pt(12, Fonts.w650), ok ? "ok" : "tx2"), spring(),
                        label(When.clock(a["at"] as? String), Fonts.pt(12, .medium), "tx3")], spacing: 7),
                (a["small"] as? String).map { cardText($0, Fonts.pt(12), "tx3") },
                (a["big"] as? String).map { cardText($0, Fonts.pt(14, .semibold)) },
                (a["command"] as? String).map { commandBlock($0, muted: true) },
                cardText(cpFill(a["text"] as? String ?? "", w), Fonts.pt(12.5), "tx2")]
    }
}
