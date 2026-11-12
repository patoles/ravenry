// The phone button's card (PHONE-001, PHONE-002, PHONE-006; ALERT-006), as
// the Electron app draws it (phonecard.ts, phonecard.css): over the window
// above the sidebar's phone mark, 420 wide. The switch for phone access, the
// Ravenry app's QR code with its one-time code and check number, every
// device signed in (an app's name renamed with a click) with Sign out, and
// New key. GET /api/phone, read again every 2 s while it is open; each
// device's name and line are the hub's (`line`, phone.mjs deviceLine).
// Escape closes it, as does a press outside it.
//
// Away from home (PHONE-011, PHONE-013 to PHONE-016; hub/server/tailnet.mjs,
// the mockup's variant B): under the code, the addresses (Home Wi-Fi, then
// ravenry's name on the person's Tailscale while it is on), and a switch
// with what it is doing: Sign in with Tailscale (the hub answers with the
// sign-in page, opened in the browser), waiting with Open the sign-in page
// again and Cancel, on with Sign out, the sign-in that did not finish with
// Try again, and no internet.

import AppKit

/// .phc-tg: the access switch, 44 by 26, --work when on.
final class AccessToggle: NSView {
    var on = false { didSet { needsDisplay = true; setAccessibilityValue(on) } }
    var enabled = true { didSet { needsDisplay = true } }
    var run: (() -> Void)?
    init(label: String = t("phone.access")) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 44).isActive = true
        heightAnchor.constraint(equalToConstant: 26).isActive = true
        setAccessibilityElement(true)
        setAccessibilityRole(.checkBox)
        setAccessibilitySubrole(.switch)
        setAccessibilityLabel(label)
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
    override func resetCursorRects() { handCursor(enabled) }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { if enabled { run?() }; return true }
}

/// .spin: a ring with a lit quarter, turning (still under Reduce motion).
/// Drawn (not layers), so the self-test's pictures show it as the screen does.
final class Spin: NSView {
    private var angle: CGFloat = 0
    private var timer: Timer?
    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 15, height: 15))
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 15).isActive = true
        heightAnchor.constraint(equalToConstant: 15).isActive = true
        setAccessibilityElement(false)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ r: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let ring = NSBezierPath(ovalIn: NSRect(x: 1, y: 1, width: 13, height: 13))
            ring.lineWidth = 2
            Design.color("tx3").withAlphaComponent(0.55).setStroke()
            ring.stroke()
            let arc = NSBezierPath()
            arc.appendArc(withCenter: NSPoint(x: 7.5, y: 7.5), radius: 6.5, startAngle: 45 - angle, endAngle: 135 - angle)
            arc.lineWidth = 2
            arc.lineCapStyle = .round
            Design.color("tx").setStroke()
            arc.stroke()
        }
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        timer?.invalidate(); timer = nil
        guard window != nil, !Motion.reduced else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 20, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.angle = (self.angle + 18).truncatingRemainder(dividingBy: 360)
            self.needsDisplay = true
        }
    }
}

/// .ico: a filled circle with a "!" (the colour of what it says: bad, you).
final class AlertMark: NSView {
    let tone: String
    init(_ tone: String) {
        self.tone = tone
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 15).isActive = true
        heightAnchor.constraint(equalToConstant: 15).isActive = true
    }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ r: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            Design.color(tone).setFill()
            NSBezierPath(ovalIn: NSRect(x: 0.5, y: 0.5, width: 14, height: 14)).fill()
            let p = NSBezierPath()
            let top: CGFloat = isFlipped ? 4 : 11, mid: CGFloat = isFlipped ? 8.4 : 6.6, dot: CGFloat = isFlipped ? 10.9 : 4.1
            p.move(to: NSPoint(x: 7.5, y: top)); p.line(to: NSPoint(x: 7.5, y: mid))
            p.move(to: NSPoint(x: 7.5, y: dot)); p.line(to: NSPoint(x: 7.5, y: dot + (isFlipped ? 0.3 : -0.3)))
            p.lineWidth = 1.9; p.lineCapStyle = .round
            NSColor.black.withAlphaComponent(0.78).setStroke(); p.stroke()
        }
    }
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
    /// Away from home's switch (hub/server/tailnet.mjs).
    let awayToggle = AccessToggle(label: t("phone.away.title"))
    private(set) var nameField: NSTextField?
    private var timer: Timer?
    private var qr: (String, NSImage?)?
    /// The board in the phone's browser (PHONE-012): its QR code (`/?k=<key>`) in place of the app's.
    private(set) var browser = false
    /// The browser QR drawn, for the self-test.
    private(set) weak var browserQrView: NSImageView?
    private var bqr: (String, NSImage?)?
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
        awayToggle.run = { [weak self] in
            guard let self else { return }
            self.post("/api/phone/away", ["on": !((self.data?["away"] as? [String: Any])?["on"] as? Bool ?? false)], t("phone.away.notChanged"))
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
    /// The self-test's: the hub's card read again, as when nothing was applied.
    func release() { held = false; load() }

    private func load() {
        guard !held else { return }
        hub?.get("/api/phone") { [weak self] code, j in
            guard let self, self.isOpen, !self.held else { return }
            if code == 200 { self.data = j } else { var d = self.data ?? [:]; d["app"] = nil; self.data = d }
            if self.editing == nil { self.paint() }
        }
    }

    private func post(_ p: String, _ body: [String: Any], _ fail: String, then: (([String: Any]) -> Void)? = nil) {
        guard !busy, let hub else { return }
        busy = true; drawn = ""; paint()
        hub.post(p, body) { [weak self] code, j in
            guard let self else { return }
            if code == 200 { then?(j) }
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
        let sig = "\(busy)|\(editing ?? "")|\(browser)|\(d.map { stableText($0).hashValue } ?? 0)"
        if sig == drawn { return }
        drawn = sig
        for v in stack.arrangedSubviews { stack.removeArrangedSubview(v); v.removeFromSuperview() }
        buttons = [:]
        nameField = nil
        toggle.on = on
        toggle.enabled = d != nil && !busy
        var rows: [NSView] = []
        let away = d?["away"] as? [String: Any]
        let aState = away?["state"] as? String ?? "off"
        let reach = on && (aState == "on" || aState == "offline")
        let sysTs = d?["systemTailscale"] as? Bool ?? false
        // .phc-h
        rows.append(hstack([label(t("phone.title"), Fonts.pt(14, .bold)), spring(), toggle], spacing: 10, insets: NSEdgeInsets(top: 14, left: 16, bottom: 10, right: 16)))
        let app = on ? d?["app"] as? [String: Any] : nil
        let svg = app?["svg"] as? String
        if let s = svg, qr?.0 != s { qr = (s, Self.qrImage(s)) }
        let line = { (s: String) -> NSView in
            let w = wrap(s, Fonts.pt(13), "tx2")
            return self.padded(w, NSEdgeInsets(top: 6, left: 16, bottom: 14, right: 16))
        }
        let bsvg = on ? d?["svg"] as? String : nil
        if let s = bsvg, bqr?.0 != s { bqr = (s, Self.qrImage(s)) }
        let link = { (title: String, key: String, to: Bool) -> NSView in
            let b = RButton(title, .link) { [weak self] in self?.browser = to; self?.drawn = ""; self?.paint() }
            b.titleSize = 12.5
            self.buttons[key] = b
            return hstack([b, spring()], spacing: 0, insets: NSEdgeInsets(top: 10, left: 16, bottom: 12, right: 16))
        }
        if d == nil { rows.append(line(t("phone.asking"))) }
        else if browser, bsvg != nil, let img = bqr?.1 {
            let iv = NSImageView()
            iv.image = img
            iv.imageScaling = .scaleProportionallyUpOrDown
            iv.setAccessibilityLabel(t("phone.browserQr"))
            iv.translatesAutoresizingMaskIntoConstraints = false
            iv.widthAnchor.constraint(equalToConstant: 150).isActive = true
            iv.heightAnchor.constraint(equalToConstant: 150).isActive = true
            browserQrView = iv
            let q = boxed(iv, fill: nil, radius: 10, insets: NSEdgeInsets(top: 8, left: 8, bottom: 8, right: 8))
            q.rawFill = .white
            // The whole address, broken where it must (the key itself never shown).
            let addr = label(((d?["address"] as? String) ?? "") + "••••••••", NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular), "tx3", lines: 2)
            addr.lineBreakMode = .byCharWrapping
            addr.preferredMaxLayoutWidth = 210
            let info = vstack([label(t("phone.browserScan"), Fonts.pt(13.5, .bold)), wrap(t("phone.browserWhere"), Fonts.pt(12.5), "tx2"), addr], spacing: 8)
            info.setHuggingPriority(.init(1), for: .horizontal)
            let r = NSStackView(views: [q, info])
            r.orientation = .horizontal; r.alignment = .top; r.spacing = 16
            r.edgeInsets = NSEdgeInsets(top: 6, left: 16, bottom: 14, right: 16)
            r.translatesAutoresizingMaskIntoConstraints = false
            rows.append(r)
            rows.append(link(t("phone.appLink"), "appCode", false))
        }
        // An app code with nowhere to reach this computer (no Wi-Fi, no Tailscale address) is not shown: the line says why (PHONE-011).
        else if let a = app, svg != nil, let img = qr?.1, !((a["hosts"] as? [String])?.isEmpty ?? false) {
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
            let info = vstack([label(t("phone.scan"), Fonts.pt(13.5, .bold)), wrap(t(reach ? "phone.whereAway" : sysTs ? "phone.where" : "phone.whereHome"), Fonts.pt(12.5), "tx2"), label(t("phone.orType"), Fonts.pt(12.5), "tx2"), code, chk], spacing: 8)
            info.setHuggingPriority(.init(1), for: .horizontal)
            let r = NSStackView(views: [q, info])
            r.orientation = .horizontal; r.alignment = .top; r.spacing = 16
            r.edgeInsets = NSEdgeInsets(top: 6, left: 16, bottom: 14, right: 16)
            r.translatesAutoresizingMaskIntoConstraints = false
            // The code's picture and its padding below it, whatever the words beside it take.
            r.heightAnchor.constraint(greaterThanOrEqualTo: q.heightAnchor, constant: 20).isActive = true
            rows.append(r)
            // .addr: where the phone finds this Mac, the Wi-Fi first, then ravenry on Tailscale.
            var addr: [NSView] = []
            if let w = d?["wifi"] as? String, !w.isEmpty { addr.append(addressRow(t("phone.addrHome"), w)) }
            if reach, let h = away?["host"] as? String, !h.isEmpty { addr.append(addressRow(t("phone.addrAway"), h)) }
            if aState == "on" { addr.append(wrap(t("phone.addrNote"), Fonts.pt(12.5), "tx2")) }
            if !addr.isEmpty { rows.append(vstack(addr, spacing: 6, insets: NSEdgeInsets(top: 0, left: 16, bottom: bsvg != nil ? 4 : 14, right: 16))) }
            if bsvg != nil { rows.append(link(t("phone.browserLink"), "browser", true)) }
        } else { rows.append(line(on ? t("phone.noAddress") : t("phone.off"))) }
        // .aw: Away from home, while phone access is on.
        if on, d != nil {
            rows.append(sepLine())
            rows.append(awayBlock(away ?? [:]))
        }
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
        let foot = wrap(!on ? t("phone.footOff") : reach ? t("phone.footOnAway") : sysTs ? t("phone.footOn") : t("phone.footOnHome"), Fonts.pt(12.5), "tx2")
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

    /// .ar: a name in grey 108 wide, then the address in mono.
    private func addressRow(_ k: String, _ v: String) -> NSView {
        let key = label(k, Fonts.pt(12.5), "tx2")
        key.translatesAutoresizingMaskIntoConstraints = false
        key.widthAnchor.constraint(equalToConstant: 108).isActive = true
        let val = label(v, NSFont.monospacedSystemFont(ofSize: 12, weight: .regular), "tx", select: true)
        val.lineBreakMode = .byCharWrapping
        let r = NSStackView(views: [key, val])
        r.orientation = .horizontal; r.alignment = .firstBaseline; r.spacing = 10
        r.translatesAutoresizingMaskIntoConstraints = false
        return r
    }

    /// .st: a mark (a spinner, or a circle with "!") and a line in its colour.
    private func stateLine(_ mark: NSView, _ s: String, _ color: String) -> NSView {
        let w = wrap(s, Fonts.pt(13, .semibold), color)
        let r = NSStackView(views: [mark, w])
        r.orientation = .horizontal; r.alignment = .top; r.spacing = 8
        r.translatesAutoresizingMaskIntoConstraints = false
        return r
    }

    /// The sign-in page the hub answered with, opened in the browser.
    private func signIn() {
        post("/api/phone/away/signin", [:], t("phone.away.notChanged")) { j in
            if let u = (j["away"] as? [String: Any])?["authURL"] as? String { Outside.open(u) }
        }
    }

    /// Away from home: its switch and what it is doing (the mockup's variant B).
    private func awayBlock(_ a: [String: Any]) -> NSView {
        let st = a["state"] as? String ?? "off"
        awayToggle.on = a["on"] as? Bool ?? false
        awayToggle.enabled = !busy
        let sub: NSView
        switch st {
        case "off": sub = wrap(t("phone.away.off"), Fonts.pt(12.5), "tx2")
        case "on", "offline":
            let name = a["name"] as? String ?? "ravenry", acct = a["account"] as? String ?? ""
            let whole = t("phone.away.reachable", ["name": name, "account": acct])
            let m = NSMutableAttributedString(string: whole, attributes: [.font: Fonts.pt(12.5), .foregroundColor: Design.color("tx2")])
            if let r = whole.range(of: name) { m.addAttributes([.font: NSFont.monospacedSystemFont(ofSize: 12.5, weight: .regular), .foregroundColor: Design.color("tx")], range: NSRange(r, in: whole)) }
            let w = wrap(whole, Fonts.pt(12.5), "tx2")
            w.text.attributedStringValue = m
            sub = w
        default: sub = wrap(t("phone.away.about"), Fonts.pt(12.5), "tx2")
        }
        let words = vstack([label(t("phone.away.title"), Fonts.pt(13.5, .bold)), sub], spacing: 1)
        words.setHuggingPriority(.init(1), for: .horizontal)
        let head = NSStackView(views: [words, awayToggle])
        head.orientation = .horizontal; head.alignment = .centerY; head.spacing = 10
        head.translatesAutoresizingMaskIntoConstraints = false
        var items: [NSView] = [head]
        let note = { (k: String) -> NSView in wrap(t(k), Fonts.pt(12.5), "tx2") }
        let primary = { (title: String, key: String) -> NSView in
            let b = RButton(title, .primary, small: true) { [weak self] in self?.signIn() }
            b.external = true
            b.isEnabled = !self.busy
            self.buttons[key] = b
            return hstack([b, spring()], spacing: 0)
        }
        switch st {
        case "ready":
            items += [primary(t("phone.away.signIn"), "awaySignIn"), note("phone.away.signInNote")]
        case "starting":
            items.append(stateLine(Spin(), t("phone.away.joining"), "tx"))
        case "waiting":
            items.append(stateLine(Spin(), t("phone.away.waiting"), "tx"))
            let again = RButton(t("phone.away.openAgain"), .link) { [weak self] in
                if let u = (self?.data?["away"] as? [String: Any])?["authURL"] as? String { Outside.open(u) }
            }
            again.titleSize = 12.5
            let cancel = RButton(t("phone.away.cancel"), small: true) { [weak self] in self?.post("/api/phone/away/cancel", [:], t("phone.away.notChanged")) }
            cancel.isEnabled = !busy
            buttons["awayOpenAgain"] = again; buttons["awayCancel"] = cancel
            items.append(hstack([again, cancel, spring()], spacing: 14))
        case "on":
            let so = RButton(t("phone.away.signOut"), small: true) { [weak self] in
                self?.post("/api/phone/away/signout", [:], t("phone.away.notChanged")) { j in
                    if j["removed"] as? Bool == false { self?.toast?(t("phone.away.leftListed")) }
                }
            }
            so.toolTip = t("phone.away.signOutTip")
            so.isEnabled = !busy
            buttons["awaySignOut"] = so
            let n = note("phone.away.onlyYou")
            items.append(hstack([n, spring(), so], spacing: 10))
        case "failed":
            items += [stateLine(AlertMark("bad"), a["error"] as? String ?? t("phone.away.failed"), "bad"), primary(t("phone.away.tryAgain"), "awayTryAgain")]
        case "offline":
            items += [stateLine(AlertMark("you"), t("phone.away.offline"), "you"), note("phone.away.offlineNote")]
        default: break
        }
        return vstack(items, spacing: 9, insets: NSEdgeInsets(top: 12, left: 16, bottom: 14, right: 16))
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
