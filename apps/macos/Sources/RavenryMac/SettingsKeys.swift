// Settings, Keys (SET-018): every action a person can give a key, grouped
// by menu in the form of Behavior (the name at the right of a 170 column,
// its key beside it), from the list of actions (Actions.swift). A click on
// a key, then the new keys: Esc keeps the old one, Delete leaves it with
// none. A key another action has is said in red beside it, with Use it
// here (the other is left with none); a key without Command (the
// terminal's), one macOS keeps, or one an action keeps for good is refused
// with a plain line. A changed key says what it was, with Reset; Reset All
// Keys puts every key back. Saved as the setting `keys` (Settings.swift);
// the menus follow at once (KeyMap).

import AppKit

/// What the Keys tab is doing: the action taking a new key, and what the last keys came to.
struct KeysState {
    /// The action whose key is being pressed.
    var recording: String?
    /// A refusal said in red (keys without Command, macOS's, an action's that keeps them).
    var note: String?
    /// A key another action has: the key and that action, waiting for Use it here.
    var hit: (KeyStroke, String)?
    /// The list, kept so a redraw keeps where it was scrolled.
    var scroll: NSScrollView?
    var scrollY: CGFloat = 0
}

extension SettingsWindow {
    /// The tab's rows: the intro, each menu's actions, then All keys; in a list that scrolls.
    func keysPane() -> [NSView] {
        if let s = keys.scroll { keys.scrollY = s.contentView.bounds.origin.y }
        let km = KeyMap.shared
        var rows: [NSView] = []
        let intro = label(t("keys.intro", ["palette": km.stroke("palette")?.symbols ?? ""]), Fonts.pt(12.5), "tx3")
        rows.append(hstack([intro, spring()], spacing: 0, insets: NSEdgeInsets(top: 0, left: 0, bottom: 12, right: 0)))
        var firstGroup = true
        for menu in Actions.keysOrder {
            let list = Actions.all.filter { a in a.menu == menu && a.rebind && (a.only?() ?? true) }
            guard !list.isEmpty else { continue }
            if !firstGroup { rows.append(keysLine()) }
            rows.append(hstack([label(menu == "Board" ? t("pal.board") : menu, Fonts.pt(13, .bold), "tx2"), spring()], spacing: 0,
                               insets: NSEdgeInsets(top: firstGroup ? 0 : 4, left: 0, bottom: 6, right: 0)))
            firstGroup = false
            for a in list { rows += keyRow(a) }
        }
        rows.append(keysLine())
        let n = km.changedCount
        let all = RButton(t("keys.resetAll"), .normal, small: true) { [weak self] in self?.resetAllKeys() }
        all.isEnabled = n > 0
        controls["keysResetAll"] = all
        let said = label(n == 0 ? t("keys.noneChanged") : t(n == 1 ? "keys.changed1" : "keys.changed", ["n": "\(n)"]), Fonts.pt(12.5), "tx3")
        controls["keysChanged"] = said
        rows.append(keysRowShape(t("keys.all"), [all, said], height: 34))

        // The list in a view that scrolls, as tall as the screen leaves it.
        let doc = Flipped()
        let st = vstack(rows, spacing: 0)
        st.setCustomSpacing(12, after: rows[0])
        doc.addSubview(st)
        st.translatesAutoresizingMaskIntoConstraints = false
        let w: CGFloat = 720 - 56
        NSLayoutConstraint.activate([st.leadingAnchor.constraint(equalTo: doc.leadingAnchor), st.topAnchor.constraint(equalTo: doc.topAnchor), st.widthAnchor.constraint(equalToConstant: w)])
        st.layoutSubtreeIfNeeded()
        let h = st.fittingSize.height
        doc.frame = NSRect(x: 0, y: 0, width: w, height: h)
        let sv = NSScrollView()
        sv.drawsBackground = false
        sv.hasVerticalScroller = true
        sv.autohidesScrollers = true
        sv.scrollerStyle = .overlay
        sv.documentView = doc
        sv.translatesAutoresizingMaskIntoConstraints = false
        let visible = (window.screen ?? NSScreen.main)?.visibleFrame.height ?? 900
        let most = max(320, min(663, visible - 97 - 40 - 80))
        NSLayoutConstraint.activate([sv.widthAnchor.constraint(equalToConstant: w), sv.heightAnchor.constraint(equalToConstant: min(h, most))])
        keys.scroll = sv
        controls["keysList"] = sv
        return [sv]
    }

    /// Back where the list was scrolled, after a redraw (SettingsWindow.draw).
    func keysScrolledBack() {
        guard let sv = keys.scroll, let doc = sv.documentView else { return }
        let y = min(keys.scrollY, max(0, doc.frame.height - sv.contentView.bounds.height))
        sv.contentView.scroll(to: NSPoint(x: 0, y: y))
        sv.reflectScrolledClipView(sv.contentView)
        // The key being pressed keeps the keyboard.
        if let id = keys.recording, let c = controls["key:\(id)"], c.window === window { window.makeFirstResponder(c) }
    }

    /// Scrolled so a row shows (the self-test's pictures, a key being pressed).
    func keysShow(_ id: String) {
        guard let sv = keys.scroll, let c = controls["key:\(id)"] else { return }
        sv.layoutSubtreeIfNeeded()
        let r = c.convert(c.bounds, to: sv.documentView)
        // Shown whole already: left where it is.
        if sv.contentView.bounds.contains(r) { return }
        sv.contentView.scroll(to: NSPoint(x: 0, y: max(0, min(r.minY - 40, (sv.documentView?.frame.height ?? 0) - sv.contentView.bounds.height))))
        sv.reflectScrolledClipView(sv.contentView)
        keys.scrollY = sv.contentView.bounds.origin.y
    }

    /// The list from its top (the intro line).
    func keysScrollTop() {
        guard let sv = keys.scroll else { return }
        sv.contentView.scroll(to: .zero)
        sv.reflectScrolledClipView(sv.contentView)
        keys.scrollY = 0
    }

    private func keysLine() -> NSView {
        let l = Box(fill: "sep")
        l.translatesAutoresizingMaskIntoConstraints = false
        l.heightAnchor.constraint(equalToConstant: 1).isActive = true
        let r = vstack([l], spacing: 0, insets: NSEdgeInsets(top: 10, left: 0, bottom: 10, right: 0))
        l.widthAnchor.constraint(equalTo: r.widthAnchor).isActive = true
        return r
    }

    /// .kr: the name at the right of the 170 column, 14 apart, then the controls; 29 high at least.
    private func keysRowShape(_ name: String, _ ctl: [NSView], height: CGFloat = 29) -> NSView {
        let lb = label(name, Fonts.pt(13), "tx")
        lb.alignment = .right
        lb.translatesAutoresizingMaskIntoConstraints = false
        lb.widthAnchor.constraint(equalToConstant: 170).isActive = true
        let r = hstack([lb] + ctl + [spring()], spacing: 0)
        r.setCustomSpacing(14, after: lb)
        for (i, v) in ctl.enumerated() where i + 1 < ctl.count { r.setCustomSpacing(12, after: v) }
        r.alignment = .centerY
        r.heightAnchor.constraint(greaterThanOrEqualToConstant: height).isActive = true
        return r
    }

    /// An action's row: its key (or None), what it was with Reset when changed; while its keys are
    /// pressed, "Press keys" and what Esc and Delete do, or what the keys came to.
    private func keyRow(_ a: AppAction) -> [NSView] {
        let km = KeyMap.shared
        let now = km.stroke(a.id)
        let rec = keys.recording == a.id
        let hit = rec ? keys.hit : nil
        let chip: KeyChip
        if let h = hit { chip = KeyChip(h.0.symbols, style: .hit) }
        else if rec { chip = KeyChip(t("keys.press"), style: .recording) }
        else if let s = now { chip = KeyChip(s.symbols, style: .key) }
        else { chip = KeyChip(t("keys.none"), style: .none) }
        chip.recording = rec
        chip.onPress = { [weak self] in self?.startKeys(a.id) }
        chip.onKey = { [weak self] e in self?.keysPressed(a.id, e) ?? false }
        chip.setAccessibilityLabel(t("keys.a11y", ["action": a.title, "key": now?.symbols ?? t("keys.none")]))
        controls["key:\(a.id)"] = chip
        var ctl: [NSView] = [chip]
        var out: [NSView] = []
        if let h = hit, let other = Actions.byId[h.1] {
            let red = label(t("keys.taken", ["key": h.0.symbols, "action": other.title]), Fonts.pt(12.5), "bad")
            controls["keyNote"] = red
            ctl.append(red)
            out.append(keysRowShape(a.title, ctl))
            let use = RButton(t("keys.useHere"), .normal, small: true) { [weak self] in self?.useKeysHere() }
            controls["keyUse"] = use
            let then = label(t("keys.leavesNone", ["action": other.title]), Fonts.pt(12.5), "tx3")
            let line = hstack([label(t("keys.otherKeys"), Fonts.pt(12.5), "tx3"), use, then], spacing: 8)
            out.append(keysRowShape("", [line]))
            return out
        }
        if rec {
            let said = keys.note.map { label($0, Fonts.pt(12.5), "bad") }
                ?? label(now.map { t("keys.escKeeps", ["key": $0.symbols]) } ?? t("keys.escNone"), Fonts.pt(12.5), "tx3")
            controls["keyNote"] = said
            ctl.append(said)
        } else if km.isChanged(a.id) {
            let was = a.defaultStroke.map { t("keys.was", ["key": $0.symbols]) } ?? t("keys.wasNone")
            ctl.append(label(was, Fonts.pt(12.5), "tx3"))
            let reset = RButton(t("keys.reset"), .link) { [weak self] in self?.resetKey(a.id) }
            reset.titleSize = 12.5
            controls["keyReset:\(a.id)"] = reset
            ctl.append(reset)
        }
        out.append(keysRowShape(a.title, ctl))
        return out
    }

    // MARK: what the keys do

    /// A click on an action's key: its next keys are its new one.
    func startKeys(_ id: String) {
        keys.recording = id; keys.note = nil; keys.hit = nil
        draw()
        if let c = controls["key:\(id)"] { window.makeFirstResponder(c) }
    }

    /// The keys pressed while an action's key is being set. True: taken here.
    func keysPressed(_ id: String, _ e: NSEvent) -> Bool {
        guard keys.recording == id else { return false }
        guard let s = KeyStroke.from(e) else { return true }
        let bare = !s.cmd && !s.ctrl && !s.opt && !s.shift
        if bare && s.key == "escape" { keys = KeysState(scroll: keys.scroll, scrollY: keys.scrollY); draw(); return true }
        if bare && (s.key == "delete" || s.key == "forwarddelete") { setKey(id, nil); return true }
        let km = KeyMap.shared
        switch km.judge(s, for: id) {
        case .same: keys.recording = nil; keys.note = nil; keys.hit = nil; draw()
        case .ok: setKey(id, s)
        case .needsCommand: keys.hit = nil; keys.note = t("keys.needsCmd", ["key": s.symbols]); draw()
        case .system: keys.hit = nil; keys.note = t("keys.system", ["key": s.symbols]); draw()
        case .fixed(let what): keys.hit = nil; keys.note = t("keys.fixed", ["key": s.symbols, "action": what]); draw()
        case .taken(let other): keys.note = nil; keys.hit = (s, other); draw()
        }
        return true
    }

    /// Use it here: the key goes to this action, the other is left with none.
    func useKeysHere() {
        guard let id = keys.recording, let h = keys.hit else { return }
        setKey(id, h.0, freeing: h.1)
    }

    func setKey(_ id: String, _ s: KeyStroke?, freeing other: String? = nil) {
        keys.recording = nil; keys.note = nil; keys.hit = nil
        set(["keys": KeyMap.shared.setting(id, s, freeing: other)])
    }

    func resetKey(_ id: String) {
        keys.recording = nil; keys.note = nil; keys.hit = nil
        set(["keys": KeyMap.shared.resetting(id)])
    }

    func resetAllKeys() {
        keys.recording = nil; keys.note = nil; keys.hit = nil
        // Ids this version does not know stay (another version's keys).
        set(["keys": KeyMap.shared.changes.filter { Actions.byId[$0.key] == nil }])
    }
}

/// A key on the Keys page (.chip): on --card, letter-spaced; None ringed in --sep;
/// while keys are pressed, on --input ringed in --work.
final class KeyChip: Box {
    enum Style { case key, none, recording, hit }
    let style: Style
    let text: String
    var recording = false
    var onPress: (() -> Void)?
    var onKey: ((NSEvent) -> Bool)?

    init(_ text: String, style: Style) {
        self.style = style; self.text = text
        let rec = style == .recording || style == .hit
        super.init(fill: style == .key ? "card" : rec ? "input" : nil, ring: rec ? "work" : style == .none ? "sep" : nil, radius: 6)
        if rec { ringWidth = 2 }
        translatesAutoresizingMaskIntoConstraints = false
        let l = label("", Fonts.pt(13))
        l.attributedStringValue = NSAttributedString(string: text, attributes: [.font: Fonts.pt(13), .foregroundColor: Design.color(style == .key || style == .hit ? "tx" : "tx3"),
                                                                                .kern: style == .key || style == .hit ? 0.8 : 0])
        addSubview(l)
        l.translatesAutoresizingMaskIntoConstraints = false
        let tw = ceil(l.attributedStringValue.size().width)
        NSLayoutConstraint.activate([heightAnchor.constraint(equalToConstant: 24), widthAnchor.constraint(equalToConstant: max(72, tw + 20)),
                                     l.centerXAnchor.constraint(equalTo: centerXAnchor), l.centerYAnchor.constraint(equalTo: centerYAnchor)])
        setContentHuggingPriority(.required, for: .horizontal)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func mouseDown(with e: NSEvent) { onPress?() }
    override func resetCursorRects() { handCursor() }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { onPress?(); return true }
    override var acceptsFirstResponder: Bool { true }
    override var canBecomeKeyView: Bool { true }
    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { if !recording { NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill() } }
    override func keyDown(with e: NSEvent) {
        if recording, onKey?(e) == true { return }
        if !keyPress(e, press: { [weak self] in self?.onPress?() }) { super.keyDown(with: e) }
    }
    /// While keys are pressed, the ones with Command come here, not to the menus.
    override func performKeyEquivalent(with e: NSEvent) -> Bool {
        guard recording, window?.firstResponder === self, e.type == .keyDown else { return false }
        return onKey?(e) ?? false
    }
}
