// The phone button's card (PHONE-001, PHONE-002, PHONE-006; ALERT-006), as
// the Electron app draws it (phonecard.ts, phonecard.css): over the window
// above the sidebar's phone mark, 420 wide. The switch for phone access, the
// Ravenry app's QR code with its one-time code and check number, every
// device signed in (an app's name renamed with a click) with Sign out, and
// New key. GET /api/phone, read again every 2 s while it is open; each
// device's name and line are the hub's (`line`, phone.mjs deviceLine).
// Escape closes it, as does a press outside it.

import AppKit

/// .phc-tg: the access switch, 44 by 26, --work when on.
final class AccessToggle: NSView {
    var on = false { didSet { needsDisplay = true; setAccessibilityValue(on) } }
    var enabled = true { didSet { needsDisplay = true } }
    var run: (() -> Void)?
    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 44).isActive = true
        heightAnchor.constraint(equalToConstant: 26).isActive = true
        setAccessibilityElement(true)
        setAccessibilityRole(.checkBox)
        setAccessibilitySubrole(.switch)
        setAccessibilityLabel(t("phone.access"))
    }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ r: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            (on ? Design.color("work") : Design.color("card2")).withAlphaComponent(enabled ? 1 : 0.5).setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 13, yRadius: 13).fill()
            NSColor.white.withAlphaComponent(enabled ? 1 : 0.5).setFill()
            NSBezierPath(ovalIn: NSRect(x: on ? bounds.width - 23 : 3, y: 3, width: 20, height: 20)).fill()
        }
    }
    override func mouseDown(with e: NSEvent) { if enabled { run?() } }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { if enabled { run?() }; return true }
}

final class PhoneCard: Box, NSTextFieldDelegate {
    var hub: HubClient?
    var toast: ((String) -> Void)?
    var onClose: (() -> Void)?
    /// GET /api/phone, nil until read.
    private(set) var data: [String: Any]?
    private(set) var busy = false
    /// The device whose name is being typed.
    private(set) var editing: String?
    private(set) var buttons: [String: RButton] = [:]
    let toggle = AccessToggle()
    private(set) var nameField: NSTextField?
    private var timer: Timer?
    private var qr: (String, NSImage?)?
    private var drawn = ""
    private let stack = vstack([], spacing: 0)
    /// Held by the self-test: its shapes are not read again.
    private var held = false
    var isOpen: Bool { !isHidden && superview != nil }

    init() {
        super.init(fill: "sheet", ring: "sheet-ring", radius: 12)
        translatesAutoresizingMaskIntoConstraints = true
        addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor), stack.topAnchor.constraint(equalTo: topAnchor)])
        toggle.run = { [weak self] in
            guard let self else { return }
            self.post("/api/phone/access", ["on": !(self.data?["access"] as? Bool ?? false)], t("phone.accessFailed"))
        }
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(t("phone.title"))
    }
    required init?(coder: NSCoder) { fatalError() }

    override func updateLayer() {
        super.updateLayer()
        // box-shadow: 0 20px 60px rgba(0,0,0,.4), over the ring.
        layer?.masksToBounds = false
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.4
        layer?.shadowRadius = 30
        layer?.shadowOffset = CGSize(width: 0, height: -20)
        // Over the terminals' and the pages' layers, whatever was added after it.
        layer?.zPosition = 100
    }

    /// Opened over `root`, its bottom left 8 above and 8 left of the mark.
    func open(in root: NSView, above anchor: NSView) {
        held = false
        if superview !== root { removeFromSuperview(); root.addSubview(self, positioned: .above, relativeTo: nil) }
        isHidden = false
        data = nil
        drawn = ""
        place(above: anchor)
        paint()
        load()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.load() }
    }

    func close() {
        timer?.invalidate(); timer = nil
        editing = nil
        isHidden = true
        removeFromSuperview()
        onClose?()
    }

    private weak var anchor: NSView?
    /// The mark it sits over, found again (the sidebar draws its foot again on each change).
    var anchorOf: (() -> NSView?)?
    func place(above a: NSView? = nil) {
        if let a { anchor = a }
        if anchor?.window == nil, let b = anchorOf?() { anchor = b }
        guard let root = superview, let a = anchor, a.window != nil else { return }
        let r = a.convert(a.bounds, to: root)
        // Laid out at its width first (twice: the wrapped words take their width, then their height).
        if frame.width != 420 { frame.size.width = 420 }
        layoutSubtreeIfNeeded(); stack.needsLayout = true; layoutSubtreeIfNeeded()
        let h = ceil(stack.fittingSize.height)
        let x = max(8, r.minX - 8)
        // Above the mark: the root is flipped or not, the card's bottom 8 above its top.
        let y = root.isFlipped ? max(8, r.minY - 8 - h) : r.maxY + 8
        frame = NSRect(x: x, y: y, width: 420, height: h)
        // Its distance to the window's foot kept as the window changes size.
        autoresizingMask = root.isFlipped ? [.maxXMargin, .minYMargin] : [.maxXMargin, .maxYMargin]
    }

    /// The self-test's: the card as the hub sends it, kept.
    func apply(_ j: [String: Any]) { held = true; timer?.invalidate(); timer = nil; data = j; drawn = ""; paint() }

    private func load() {
        guard !held else { return }
        hub?.get("/api/phone") { [weak self] code, j in
            guard let self, self.isOpen, !self.held else { return }
            if code == 200 { self.data = j } else { var d = self.data ?? [:]; d["app"] = nil; self.data = d }
            if self.editing == nil { self.paint() }
        }
    }

    private func post(_ p: String, _ body: [String: Any], _ fail: String) {
        guard !busy, let hub else { return }
        busy = true; drawn = ""; paint()
        hub.post(p, body) { [weak self] code, j in
            guard let self else { return }
            if code != 200 { self.toast?(j["error"] as? String ?? fail) }
            else if !self.held, j["access"] != nil { self.data = j }
            else if !self.held, let d = j["devices"], self.data != nil { self.data?["devices"] = d }
            self.busy = false
            self.drawn = ""
            self.paint()
            self.load()
        }
    }

    override func cancelOperation(_ sender: Any?) { if editing != nil { finishEdit(save: false) } else { close() } }
    override func keyDown(with e: NSEvent) { if e.keyCode == 53 { cancelOperation(nil) } else { super.keyDown(with: e) } }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    // A press inside the card stays in it (what is under it does not get it).
    override func mouseDown(with e: NSEvent) {}

    /// Draws the card again from what it has (only when that changed).
    func paint() {
        let d = data
        let on = d?["access"] as? Bool ?? false
        let sig = "\(busy)|\(editing ?? "")|\(d.map { stableText($0).hashValue } ?? 0)"
        if sig == drawn { return }
        drawn = sig
        for v in stack.arrangedSubviews { stack.removeArrangedSubview(v); v.removeFromSuperview() }
        buttons = [:]
        nameField = nil
        toggle.on = on
        toggle.enabled = d != nil && !busy
        var rows: [NSView] = []
        // .phc-h
        rows.append(hstack([label(t("phone.title"), Fonts.pt(14, .bold)), spring(), toggle], spacing: 10, insets: NSEdgeInsets(top: 14, left: 16, bottom: 10, right: 16)))
        let app = on ? d?["app"] as? [String: Any] : nil
        let svg = app?["svg"] as? String
        if let s = svg, qr?.0 != s { qr = (s, Self.qrImage(s)) }
        let line = { (s: String) -> NSView in
            let w = wrap(s, Fonts.pt(13), "tx2")
            return self.padded(w, NSEdgeInsets(top: 6, left: 16, bottom: 14, right: 16))
        }
        if d == nil { rows.append(line(t("phone.asking"))) }
        else if let a = app, svg != nil, let img = qr?.1 {
            let iv = NSImageView()
            iv.image = img
            iv.imageScaling = .scaleProportionallyUpOrDown
            iv.setAccessibilityLabel("QR code that pairs the Ravenry app")
            iv.translatesAutoresizingMaskIntoConstraints = false
            iv.widthAnchor.constraint(equalToConstant: 150).isActive = true
            iv.heightAnchor.constraint(equalToConstant: 150).isActive = true
            let q = boxed(iv, fill: nil, radius: 10, insets: NSEdgeInsets(top: 8, left: 8, bottom: 8, right: 8))
            q.rawFill = .white
            let code = label(a["code"] as? String ?? "", NSFont.monospacedSystemFont(ofSize: 15, weight: .semibold), "tx", select: true)
            code.attributedStringValue = NSAttributedString(string: a["code"] as? String ?? "", attributes: [.font: NSFont.monospacedSystemFont(ofSize: 15, weight: .semibold), .foregroundColor: Design.color("tx"), .kern: 0.75])
            let check = NSMutableAttributedString(string: t("phone.check") + " ", attributes: [.font: Fonts.pt(12.5), .foregroundColor: Design.color("tx2")])
            check.append(NSAttributedString(string: a["check"] as? String ?? "", attributes: [.font: Fonts.pt(12.5, .bold).withTabularDigits, .foregroundColor: Design.color("tx")]))
            let chk = wrap("", Fonts.pt(12.5), "tx2")
            chk.text.attributedStringValue = check
            let info = vstack([label(t("phone.scan"), Fonts.pt(13.5, .bold)), wrap(t("phone.where"), Fonts.pt(12.5), "tx2"), label(t("phone.orType"), Fonts.pt(12.5), "tx2"), code, chk], spacing: 8)
            info.setHuggingPriority(.init(1), for: .horizontal)
            let r = NSStackView(views: [q, info])
            r.orientation = .horizontal; r.alignment = .top; r.spacing = 16
            r.edgeInsets = NSEdgeInsets(top: 6, left: 16, bottom: 14, right: 16)
            r.translatesAutoresizingMaskIntoConstraints = false
            rows.append(r)
        } else { rows.append(line(on ? t("phone.noAddress") : t("phone.off"))) }
        // .phc-dev
        let devs = d?["devices"] as? [[String: Any]] ?? []
        if !devs.isEmpty {
            var dr: [NSView] = []
            for x in devs {
                let id = x["id"] as? String ?? ""
                let l = x["line"] as? [String: Any] ?? [:]
                let name = l["name"] as? String ?? x["name"] as? String ?? ""
                let sub = label(l["sub"] as? String ?? "", Fonts.pt(12), "tx2")
                let nm: NSView
                if l["renamable"] as? Bool != true { nm = label(name, Fonts.pt(13)) }
                else if editing == id {
                    let f = NSTextField(string: name)
                    f.font = Fonts.pt(13); f.textColor = Design.color("tx"); f.isBordered = false; f.focusRingType = .none
                    f.drawsBackground = true; f.backgroundColor = Design.color("input")
                    f.setAccessibilityLabel(t("phone.nameLabel"))
                    f.delegate = self
                    f.translatesAutoresizingMaskIntoConstraints = false
                    nameField = f
                    nm = boxed(f, fill: "input", ring: "selring", radius: 6, insets: NSEdgeInsets(top: 2, left: 6, bottom: 2, right: 6))
                } else {
                    let b = RButton(name, .link) { [weak self] in self?.editing = id; self?.drawn = ""; self?.paint(); if let f = self?.nameField { self?.window?.makeFirstResponder(f); f.currentEditor()?.selectAll(nil) } }
                    b.isEnabled = !busy
                    // .phc-nm: the name in the text's colour, not a link's.
                    b.titleColor = "tx"
                    b.titleSize = 13
                    b.toolTip = t("phone.rename")
                    buttons["rename-\(id)"] = b
                    nm = b
                }
                let col = vstack([nm, sub], spacing: 1)
                col.setHuggingPriority(.init(1), for: .horizontal)
                let so = RButton(t("phone.signOut"), small: true) { [weak self] in self?.post("/api/phone/devices/revoke", ["id": id], t("phone.revokeFailed")) }
                so.isEnabled = !busy
                buttons["signOut-\(id)"] = so
                col.setContentHuggingPriority(.init(1), for: .horizontal)
                dr.append(hstack([col, spring(), so], spacing: 10, insets: NSEdgeInsets(top: 8, left: 16, bottom: 8, right: 16)))
            }
            rows.append(sepLine())
            rows.append(padded(vstack(dr, spacing: 0), NSEdgeInsets(top: 6, left: 0, bottom: 6, right: 0)))
        }
        // .phc-f
        let nk = RButton(t("phone.newKey"), small: true) { [weak self] in self?.post("/api/phone/new-key", [:], t("phone.newKeyFailed")) }
        nk.toolTip = t("phone.newKeyTip")
        nk.isEnabled = d != nil && !busy
        buttons["newKey"] = nk
        let foot = wrap(on ? t("phone.footOn") : t("phone.footOff"), Fonts.pt(12.5), "tx2")
        rows.append(sepLine())
        rows.append(hstack([foot, spring(), nk], spacing: 10, insets: NSEdgeInsets(top: 10, left: 16, bottom: 12, right: 16)))
        for v in rows {
            stack.addArrangedSubview(v)
            v.translatesAutoresizingMaskIntoConstraints = false
            v.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        stack.layoutSubtreeIfNeeded()
        place()
    }

    private func sepLine() -> NSView {
        let l = Box(fill: "sep")
        l.translatesAutoresizingMaskIntoConstraints = false
        l.heightAnchor.constraint(equalToConstant: 1).isActive = true
        return l
    }
    private func padded(_ v: NSView, _ i: NSEdgeInsets) -> NSView { boxed(v, fill: nil, radius: 0, insets: i) }

    /// The hub's QR picture, taken only when it is a plain SVG.
    static func qrImage(_ s: String) -> NSImage? {
        guard s.hasPrefix("<svg"), s.range(of: "<script|on\\w+=|href=", options: [.regularExpression, .caseInsensitive]) == nil else { return nil }
        return NSImage(data: Data(s.utf8))
    }

    // An app's name: Enter keeps it, Escape the old one, leaving the field keeps it too.
    func control(_ c: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) { finishEdit(save: true); return true }
        if sel == #selector(NSResponder.cancelOperation(_:)) { finishEdit(save: false); return true }
        return false
    }
    func controlTextDidEndEditing(_ n: Notification) { if editing != nil { finishEdit(save: true) } }

    func finishEdit(save: Bool) {
        guard let id = editing else { return }
        let v = (nameField?.stringValue ?? "").replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        let old = ((data?["devices"] as? [[String: Any]])?.first { $0["id"] as? String == id }?["line"] as? [String: Any])?["name"] as? String
        editing = nil
        drawn = ""
        if save && !v.isEmpty && v != old { post("/api/phone/devices/rename", ["id": id, "name": String(v.prefix(60))], t("phone.renameFailed")) }
        else { paint() }
        window?.makeFirstResponder(self)
    }
}
