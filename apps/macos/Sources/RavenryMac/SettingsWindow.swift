// The Settings window, as the Electron app draws it (apps/desktop/src/
// settings/settings.ts and settings.css): 720 wide, the title and the tabs
// (shared/settings/settings.json `tabs`: Appearance, Behavior, Hand-off,
// Skills) on the window's colour, then a form of rows (the label at the
// right of a 170 column, the controls, a hint under them), its height
// following the tab, its top kept where it is. Every control writes the
// shared settings file (Settings.swift) and the window draws again from
// what is saved. Hand-off (SettingsHandoff.swift): the hub's own settings
// for every project. Skills: the Ravenry skill and its hooks per
// assistant, as the hub sends them (GET /api/setup/skills?ravenryd=,
// skills.withHooks), read again every 3 s while the tab shows, so a setup
// made elsewhere shows; Install, Remove and Set up posted to the hub.
// Every control takes the keyboard: Tab moves through them, Space or
// Return presses, the arrows move a segment or a slider.

import AppKit

final class SettingsWindow: NSObject, NSWindowDelegate {
    /// Something Settings shows changed (the skill, the hooks, the hand-off,
    /// the assistant, a setting): every window's panel, sidebar and pages
    /// read it again at once, while Settings is still open. `object`: what
    /// changed ("skills", "hooks", "handoff", "assistant", "settings").
    static let changed = Notification.Name("RavenrySettingsChanged")
    static func said(_ what: String) { NotificationCenter.default.post(name: changed, object: what) }
    let window: NSWindow
    let store: SettingsStore
    weak var hub: HubClient?
    private(set) var tab = "appearance"
    private let head = Box(fill: "win")
    private let body = Flipped()
    private let titleLabel = label("", Fonts.pt(13, Fonts.w650))
    private(set) var tabButtons: [String: TapBox] = [:]
    /// Every control by name, for the self-test ("follow", "theme:nord", "cursor:bar", "skill:claude" ...).
    var controls: [String: NSView] = [:]
    private(set) var skills: [[String: Any]] = []
    private(set) var skillsRead = false
    private(set) var busy: String?
    private(set) var skillError: String?
    private(set) var scrollbackBad = false
    /// The monospace families installed (NSFontManager), with the one in use.
    private(set) lazy var fonts: [String] = NSFontManager.shared.availableFontFamilies.filter { f in
        guard !f.hasPrefix("."), let font = NSFont(name: f, size: 12) else { return false }
        return font.isFixedPitch || NSFontManager.shared.traits(of: font).contains(.fixedPitchFontMask)
    }
    let offscreen: Bool
    /// The hand-off tab's state (SettingsHandoff.swift).
    var ho = HandoffState()
    private var poll: Timer?

    init(store: SettingsStore, hub: HubClient?, offscreen: Bool) {
        self.store = store; self.hub = hub; self.offscreen = offscreen
        // A window AppKit leaves where it is put: off every screen, AppKit would move a plain one onto a screen.
        let w = TerminalWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 600), styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
        w.allowOffscreen = offscreen
        window = w
        super.init()
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.title = t("side.settings")
        let root = Flipped()
        window.contentView = root
        root.addSubview(head)
        root.addSubview(body)
        store.onChange = { [weak self] in self?.draw() }
        poll = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.tick() }
    }

    /// While the window shows: the skills (a setup made by onboarding, an
    /// agent or by hand) and the hand-off settings (the board's or another
    /// client's change) read again.
    private func tick() {
        guard window.isVisible else { return }
        if tab == "skills" && busy == nil { readSkills() }
        if tab == "handoff" { readHandoff(quiet: true) }
    }

    /// Opens it on a tab (Cmd+, and the sidebar's Settings), or brings it to the front.
    func show(_ tab: String? = nil) {
        if let x = tab { self.tab = x }
        draw()
        if offscreen {
            window.setFrameOrigin(NSPoint(x: -20000, y: -20000))
            window.orderBack(nil)
        } else {
            if !window.isVisible { window.center() }
            window.makeKeyAndOrderFront(nil)
        }
        if self.tab == "skills" { readSkills() }
        if self.tab == "handoff" { readHandoff() }
    }

    func pick(_ t: String) {
        guard t != tab, tabs.contains(where: { $0.0 == t }) else { return }
        tab = t
        draw()
        if t == "skills" { readSkills() }
        if t == "handoff" { readHandoff() }
    }

    // MARK: drawing

    /// The tabs in shared/settings/settings.json's order.
    let tabs: [(String, String)] = {
        let ids = SettingsStore.spec["tabs"] as? [String] ?? ["appearance", "behavior", "handoff", "skills"]
        return ids.map { ($0, "set.\($0)") }
    }()

    func draw() {
        // The keyboard stays on the control it was on (the window is drawn again after each change).
        let keep = window.firstResponder.flatMap { r in controls.first { $0.value === r }?.key }
        controls = [:]
        titleLabel.stringValue = t("set.\(tab)")
        window.title = titleLabel.stringValue
        // .sw-tb: the title centred, the tabs (92 wide, 7 round, --sel and --work when picked).
        head.subviews.forEach { $0.removeFromSuperview() }
        head.ring = nil
        var tv: [NSView] = []
        for (id, key) in tabs {
            let on = id == tab
            let b = TapBox(fill: on ? "sel" : nil, radius: 7) { [weak self] in self?.pick(id) }
            b.arrows = { [weak self] d in self?.step(tab: d) }
            let col = vstackC([Icon("settings-\(id)", on ? "work" : "tx2", size: 22), label(t(key), Fonts.pt(11.5), on ? "work" : "tx2")], spacing: 3)
            b.addSubview(col)
            NSLayoutConstraint.activate([b.widthAnchor.constraint(equalToConstant: 92), col.centerXAnchor.constraint(equalTo: b.centerXAnchor),
                                         col.topAnchor.constraint(equalTo: b.topAnchor, constant: 6), col.bottomAnchor.constraint(equalTo: b.bottomAnchor, constant: -5)])
            b.setAccessibilityRole(.radioButton); b.setAccessibilityLabel(t(key)); b.setAccessibilityValue(on)
            tabButtons[id] = b
            tv.append(b)
        }
        let strip = hstack(tv, spacing: 4)
        let hv = vstackC([titleLabel, strip], spacing: 8)
        head.addSubview(hv)
        let line = Box(fill: "sep")
        line.translatesAutoresizingMaskIntoConstraints = false
        head.addSubview(line)
        head.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([hv.topAnchor.constraint(equalTo: head.topAnchor, constant: 10), hv.centerXAnchor.constraint(equalTo: head.centerXAnchor),
                                     hv.bottomAnchor.constraint(equalTo: head.bottomAnchor, constant: -8),
                                     line.leadingAnchor.constraint(equalTo: head.leadingAnchor), line.trailingAnchor.constraint(equalTo: head.trailingAnchor),
                                     line.bottomAnchor.constraint(equalTo: head.bottomAnchor), line.heightAnchor.constraint(equalToConstant: 1)])
        // .sw-b: 18 above, 28 at the sides, 22 below.
        body.subviews.forEach { $0.removeFromSuperview() }
        let rows: [NSView] = tab == "appearance" ? appearance() : tab == "behavior" ? behavior() : tab == "handoff" ? handoffPane() : skillsPane()
        let st = vstack(rows, spacing: 0, insets: NSEdgeInsets(top: 18, left: 28, bottom: 22, right: 28))
        body.addSubview(st)
        let root = window.contentView!
        let w: CGFloat = 720
        let hw = head.widthAnchor.constraint(equalToConstant: w), sw = st.widthAnchor.constraint(equalToConstant: w)
        NSLayoutConstraint.activate([hw, sw, st.leadingAnchor.constraint(equalTo: body.leadingAnchor), st.topAnchor.constraint(equalTo: body.topAnchor)])
        head.layoutSubtreeIfNeeded(); st.layoutSubtreeIfNeeded(); st.layoutSubtreeIfNeeded()
        let hh = head.fittingSize.height, bh = st.fittingSize.height
        head.frame = NSRect(x: 0, y: 0, width: w, height: hh)
        body.frame = NSRect(x: 0, y: hh, width: w, height: bh)
        // The traffic lights sit at 14, 12 (Electron's trafficLightPosition): the head starts under the title bar's top.
        // The new height keeps the window's top where it is (setContentSize keeps its bottom).
        let size = NSSize(width: w, height: hh + bh)
        if root.frame.size != size {
            let old = window.frame
            var f = window.frameRect(forContentRect: NSRect(origin: .zero, size: size))
            f.origin = NSPoint(x: old.minX, y: old.maxY - f.height)
            window.setFrame(f, display: true)
        }
        root.frame.size = size
        if let k = keep, let v = controls[k], v.window === window { window.makeFirstResponder(v) }
        window.recalculateKeyViewLoop()
    }

    /// Ctrl+Tab and the arrows on the tabs: the next or the previous tab.
    func step(tab d: Int) {
        guard let i = tabs.firstIndex(where: { $0.0 == tab }) else { return }
        let n = tabs[(i + d + tabs.count) % tabs.count].0
        pick(n)
        if let b = tabButtons[n] { window.makeFirstResponder(b) }
    }

    // MARK: rows (.fr2: a 170 column for the label at its right, 14 apart, 10 above and below, a line above)

    func row(_ text: String, _ ctl: [NSView], line extra: NSView? = nil, hint: String? = nil, join: Bool = false, first: Bool = false) -> NSView {
        let lb = label(text, Fonts.pt(13), "tx")
        lb.alignment = .right
        lb.translatesAutoresizingMaskIntoConstraints = false
        lb.widthAnchor.constraint(equalToConstant: 170).isActive = true
        var col: [NSView] = [hstack(ctl + [spring()], spacing: 10)]
        if let x = extra { col.append(hstack([x, spring()], spacing: 0)) }
        if let h = hint { col.append(wrap(h, Fonts.pt(11.5), "tx3")) }
        let right = vstack(col, spacing: 4)
        let line = hstack([lb, right], spacing: 14)
        line.alignment = hint == nil ? .centerY : .firstBaseline
        if hint != nil { line.alignment = .top; lb.setContentHuggingPriority(.required, for: .vertical) }
        let top: CGFloat = join || first ? 0 : 10
        let r = vstack([line], spacing: 0, insets: NSEdgeInsets(top: top, left: 0, bottom: 10, right: 0))
        if !(join || first) {
            let sep = Box(fill: "sep")
            sep.translatesAutoresizingMaskIntoConstraints = false
            r.addSubview(sep)
            NSLayoutConstraint.activate([sep.leadingAnchor.constraint(equalTo: r.leadingAnchor), sep.trailingAnchor.constraint(equalTo: r.trailingAnchor),
                                         sep.topAnchor.constraint(equalTo: r.topAnchor), sep.heightAnchor.constraint(equalToConstant: 1)])
        }
        return r
    }

    /// .sec: a section's title (12, 650, tx2), 16 above after a row.
    func sec(_ text: String, sub: String? = nil, after: Bool) -> NSView {
        var v: [NSView] = [label(text, Fonts.pt(12, Fonts.w650), "tx2")]
        if let s = sub { v.append(label(s, Fonts.pt(12), "tx3")) }
        return hstack(v + [spring()], spacing: 6, insets: NSEdgeInsets(top: after ? 16 : 0, left: 0, bottom: 8, right: 0))
    }

    // MARK: Appearance

    private func appearance() -> [NSView] {
        let s = store
        let size = s.int("fontSize"), r = SettingsStore.range("fontSize")
        let pop = PopBox(s.string("fontFamily")) { [weak self] in self?.fontMenu() ?? NSMenu() }
        controls["font"] = pop
        let minus = TapBox(fill: "btn", radius: 0) { [weak self] in if size > r.min { self?.set(["fontSize": size - 1]) } }
        let plus = TapBox(fill: "btn", radius: 0) { [weak self] in if size < r.max { self?.set(["fontSize": size + 1]) } }
        minus.put(label("\u{2212}", Fonts.pt(13), size <= r.min ? "tx3" : "tx"), w: 26)
        plus.put(label("+", Fonts.pt(13), size >= r.max ? "tx3" : "tx"), w: 26)
        minus.setAccessibilityLabel(t("set.smaller")); plus.setAccessibilityLabel(t("set.bigger"))
        let value = Box(fill: "input")
        value.translatesAutoresizingMaskIntoConstraints = false
        let vl = label("\(size)", Fonts.pt(13).withTabularDigits)
        value.addSubview(vl)
        vl.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([value.widthAnchor.constraint(equalToConstant: 40), vl.centerXAnchor.constraint(equalTo: value.centerXAnchor), vl.centerYAnchor.constraint(equalTo: value.centerYAnchor)])
        value.setAccessibilityLabel(t("set.fontSize"))
        let stp = Box(ring: "sep", radius: 6)
        stp.translatesAutoresizingMaskIntoConstraints = false
        stp.wantsLayer = true; stp.layer?.masksToBounds = true
        let sr = hstack([minus, value, plus], spacing: 0)
        stp.addSubview(sr)
        pinAll(sr, stp)
        sr.heightAnchor.constraint(equalToConstant: 26).isActive = true
        controls["smaller"] = minus; controls["bigger"] = plus; controls["size"] = vl
        var out: [NSView] = [
            row(t("set.font"), [pop, stp], line: label(t("set.fontKeys"), Fonts.pt(12), "tx3"), first: true),
            row("", [preview()], join: true),
        ]
        let follow = s.bool("themeFollowsSystem")
        let cb = CheckRow(t("set.follow"), on: follow) { [weak self] on in self?.set(["themeFollowsSystem": on]) }
        controls["follow"] = cb
        out.append(row(t("set.theme"), [cb], hint: follow ? t("set.followOn") : t("set.followOff")))
        let dark = s.themes.filter { $0.appearance == "dark" }, light = s.themes.filter { $0.appearance == "light" }
        if follow {
            out.append(row(t("set.forDark"), [grid(dark, s.string("themeDark"), "themeDark")], join: true))
            out.append(row(t("set.forLight"), [grid(light, s.string("themeLight"), "themeLight")], join: true))
        } else {
            out.append(row(t("set.use"), [grid(dark + light, s.string("themeAlways"), "themeAlways")], join: true))
        }
        let blink = CheckRow(t("set.blink"), on: s.bool("cursorBlink")) { [weak self] on in self?.set(["cursorBlink": on]) }
        controls["blink"] = blink
        let imp = RButton(t("set.import"), .normal, small: true) { [weak self] in self?.importTheme() }
        controls["import"] = imp
        let impNote = label(importNote?.text ?? t("set.importHint"), Fonts.pt(12), importNote == nil ? "tx3" : importNote!.bad ? "bad" : "tx2")
        controls["importNote"] = impNote
        out.append(row("", [imp, impNote], join: true))
        out.append(row(t("set.cursor"), [segm("cursor", s.string("cursorStyle"), [("block", "set.block"), ("bar", "set.bar"), ("underline", "set.underline")], key: "cursorStyle"), blink], hint: t("set.cursorHint")))
        // The pane effect and the launch's Ink (Shaders.swift, Ink.swift).
        out.append(row(t("set.paneEffect"), [segm("fx", s.string("paneEffect"), [("off", "set.off"), ("bloom", "set.fxBloom"), ("crt", "set.fxCrt")], key: "paneEffect")], hint: t("set.fxHint")))
        let ink = CheckRow(t("set.launchInk"), on: s.bool("launchInk")) { [weak self] on in self?.set(["launchInk": on]) }
        controls["launchInk"] = ink
        out.append(row(t("set.opening"), [ink], hint: t("set.launchInkHint")))
        return out
    }

    /// What the last import said (Electron's note beside the button).
    private(set) var importNote: (text: String, bad: Bool)?

    /// Import: a file picked (off every screen, RAVENRY_SETTINGS_IMPORT's,
    /// as the Electron app's tests), made a theme by the hub, saved here.
    func importTheme() {
        if offscreen {
            guard let f = ProcessInfo.processInfo.environment["RAVENRY_SETTINGS_IMPORT"], !f.isEmpty else { return }
            importFile(URL(fileURLWithPath: f))
            return
        }
        let p = NSOpenPanel()
        p.title = t("set.importTitle")
        p.prompt = t("set.importButton")
        p.canChooseFiles = true
        p.canChooseDirectories = false
        p.allowsMultipleSelection = false
        p.beginSheetModal(for: window) { [weak self] r in
            if r == .OK, let u = p.url { self?.importFile(u) }
        }
    }

    private func importFile(_ u: URL) {
        let bad = { [weak self] (s: String) in self?.importNote = (s, true); self?.draw() }
        if let n = (try? FileManager.default.attributesOfItem(atPath: u.path))?[.size] as? Int, n > 1024 * 1024 { return bad(t("set.importBig")) }
        let text: String
        do { text = try String(contentsOf: u, encoding: .utf8) } catch { return bad(t("set.importUnread", ["file": u.lastPathComponent, "why": error.localizedDescription])) }
        guard let hub else { return bad(t("set.importNot")) }
        hub.post("/api/settings/theme-import", ["text": text, "fileName": u.lastPathComponent]) { [weak self] code, j in
            guard let self else { return }
            guard code == 200, let th = j["theme"] as? [String: Any], let slug = j["slug"] as? String,
                  let info = self.store.importTheme(th, slug: slug) else { return bad(j["error"] as? String ?? t("set.importNot")) }
            self.importNote = (t("set.imported", ["name": info.name, "appearance": info.appearance]), false)
            self.draw()
        }
    }

    private func fontMenu() -> NSMenu {
        let m = NSMenu()
        let cur = store.string("fontFamily")
        for f in Array(Set(fonts + [cur])).sorted(by: { $0.localizedCompare($1) == .orderedAscending }) {
            let it = NSMenuItem(title: f, action: #selector(fontPicked(_:)), keyEquivalent: "")
            it.target = self
            it.state = f == cur ? .on : .off
            m.addItem(it)
        }
        return m
    }
    @objc func fontPicked(_ it: NSMenuItem) { set(["fontFamily": it.title]) }

    /// .prev: the theme in use, its colours, the font and the cursor as set.
    private func preview() -> NSView {
        let th = store.pickTheme(dark: effectiveDark) ?? SettingsStore.builtIn.first
        let c = th?.colors ?? [:]
        let font = NSFont(name: store.string("fontFamily"), size: CGFloat(store.int("fontSize"))) ?? NSFont.monospacedSystemFont(ofSize: CGFloat(store.int("fontSize")), weight: .regular)
        let a = NSMutableAttributedString()
        func add(_ s: String, _ k: String = "foreground") { a.append(NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: css(c[k] ?? c["foreground"] ?? "#FFFFFF")])) }
        add("~/code/landing-page", "blue"); add(" "); add("main", "magenta"); add(" $ npm test\n")
        add(" "); add("\u{2713}", "green"); add(" src/nav.test.tsx "); add("(6)", "brightBlack"); add("   "); add("\u{2717}", "red"); add(" src/header.test.tsx "); add("(4)", "brightBlack"); add("\n")
        add(" "); add("warn", "yellow"); add(" 0O il1 {}[] => != 23:59 ")
        let para = NSMutableParagraphStyle(); para.lineHeightMultiple = 1.2
        a.addAttribute(.paragraphStyle, value: para, range: NSRange(location: 0, length: a.length))
        let tx = label("", font)
        tx.attributedStringValue = a
        tx.lineBreakMode = .byClipping
        tx.maximumNumberOfLines = 3
        let cur = CursorMark(style: store.string("cursorStyle"), color: css(c["cursor"] ?? "#FFFFFF"), font: font)
        let b = Box(ring: "sep", radius: 8)
        b.rawFill = css(c["background"] ?? "#000000")
        b.translatesAutoresizingMaskIntoConstraints = false
        b.addSubview(tx); b.addSubview(cur)
        tx.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([tx.leadingAnchor.constraint(equalTo: b.leadingAnchor, constant: 12), tx.topAnchor.constraint(equalTo: b.topAnchor, constant: 10),
                                     tx.bottomAnchor.constraint(equalTo: b.bottomAnchor, constant: -10), tx.trailingAnchor.constraint(lessThanOrEqualTo: b.trailingAnchor, constant: -12),
                                     cur.leadingAnchor.constraint(equalTo: tx.trailingAnchor, constant: -2), cur.lastBaselineAnchor.constraint(equalTo: tx.lastBaselineAnchor, constant: store.string("cursorStyle") == "underline" ? 3 : 2)])
        b.setAccessibilityLabel(t("set.preview", ["theme": th?.name ?? ""]))
        controls["preview"] = b
        b.widthAnchor.constraint(equalToConstant: 720 - 56 - 170 - 14).isActive = true
        return b
    }

    private var effectiveDark: Bool { (NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) ?? .darkAqua) == .darkAqua }

    /// .thg: four a line, each the theme's colours over its name; the one picked ringed in --work.
    private func grid(_ list: [ThemeInfo], _ current: String, _ key: String) -> NSView {
        var lines: [NSView] = []
        let cw: CGFloat = (720 - 56 - 170 - 14 - 3 * 8) / 4
        for i in stride(from: 0, to: list.count, by: 4) {
            let cards = list[i..<min(i + 4, list.count)].map { th -> NSView in
                let on = th.id == current
                let card = TapBox(ring: on ? "work" : "sep", radius: 7) { [weak self] in self?.set([key: th.id]) }
                card.ringWidth = on ? 2 : 1
                card.wantsLayer = true; card.layer?.masksToBounds = true
                let c = th.colors
                let mono = NSFont(name: "SF Mono", size: 10.5) ?? NSFont.monospacedSystemFont(ofSize: 10.5, weight: .regular)
                let a = NSMutableAttributedString()
                for (s, k) in [("~/code", "blue"), (" $ ls\n", "foreground"), ("src", "green"), ("  README.md", "foreground")] {
                    a.append(NSAttributedString(string: s, attributes: [.font: mono, .foregroundColor: css(c[k] ?? c["foreground"] ?? "#FFF")]))
                }
                let sw = Box(); sw.rawFill = css(c["background"] ?? "#000")
                sw.translatesAutoresizingMaskIntoConstraints = false
                let st = label("", mono); st.attributedStringValue = a; st.maximumNumberOfLines = 2; st.lineBreakMode = .byClipping
                sw.addSubview(st); st.translatesAutoresizingMaskIntoConstraints = false
                NSLayoutConstraint.activate([sw.heightAnchor.constraint(equalToConstant: 38), st.leadingAnchor.constraint(equalTo: sw.leadingAnchor, constant: 8), st.topAnchor.constraint(equalTo: sw.topAnchor, constant: 6), st.trailingAnchor.constraint(lessThanOrEqualTo: sw.trailingAnchor, constant: -4)])
                let nm = Box(fill: "card")
                let nl = label(th.name, Fonts.pt(11.5, on ? .semibold : .regular), on ? "tx" : "tx2")
                nl.lineBreakMode = .byTruncatingTail
                nm.addSubview(nl); nl.translatesAutoresizingMaskIntoConstraints = false; nm.translatesAutoresizingMaskIntoConstraints = false
                NSLayoutConstraint.activate([nl.leadingAnchor.constraint(equalTo: nm.leadingAnchor, constant: 8), nl.trailingAnchor.constraint(lessThanOrEqualTo: nm.trailingAnchor, constant: -8), nl.topAnchor.constraint(equalTo: nm.topAnchor, constant: 4), nl.bottomAnchor.constraint(equalTo: nm.bottomAnchor, constant: -4)])
                let col = vstack([sw, nm], spacing: 0)
                card.addSubview(col)
                pinAll(col, card)
                card.widthAnchor.constraint(equalToConstant: cw).isActive = true
                card.setAccessibilityRole(.radioButton); card.setAccessibilityLabel(th.name); card.setAccessibilityValue(on)
                card.toolTip = th.credit ?? th.name
                controls["theme:\(key):\(th.id)"] = card
                return card
            }
            lines.append(hstack(cards + [spring()], spacing: 8))
        }
        return vstack(lines, spacing: 8)
    }

    /// .segm: the choices on --card, the one picked on --btn.
    private func segm(_ name: String, _ value: String, _ items: [(String, String)], key: String) -> NSView {
        seg(name, value, items.map { ($0.0, t($0.1)) }) { [weak self] v in self?.set([key: v]) }
    }

    /// A segmented choice of words; `pick` runs for a choice other than the one picked. The arrows move it.
    func seg(_ name: String, _ value: String, _ items: [(String, String)], enabled: Bool = true, pick: @escaping (String) -> Void) -> NSView {
        let g = Box(fill: "card", radius: 7)
        g.translatesAutoresizingMaskIntoConstraints = false
        let vals = items.map { $0.0 }
        let bs = items.map { v, word -> NSView in
            let on = v == value
            let b = TapBox(fill: on ? "btn" : nil, radius: 5) { if !on && enabled { pick(v) } }
            b.arrows = { [weak self] d in
                guard enabled, let i = vals.firstIndex(of: value) else { return }
                let j = i + d
                guard j >= 0, j < vals.count else { return }
                pick(vals[j])
                if let x = self?.controls["\(name):\(vals[j])"] { self?.window.makeFirstResponder(x) }
            }
            if on { b.ring = "sep"; b.ringWidth = 0.5 }
            b.put(label(word, Fonts.pt(12.5), on ? "tx" : "tx2"), pad: 12, h: 24)
            b.setAccessibilityRole(.radioButton); b.setAccessibilityLabel(word); b.setAccessibilityValue(on)
            controls["\(name):\(v)"] = b
            return b
        }
        let r = hstack(bs, spacing: 2, insets: NSEdgeInsets(top: 2, left: 2, bottom: 2, right: 2))
        g.addSubview(r)
        pinAll(r, g)
        g.setContentHuggingPriority(.required, for: .horizontal)
        g.alphaValue = enabled ? 1 : 0.45
        return g
    }

    // MARK: Behavior

    private func behavior() -> [NSView] {
        let s = store
        let meta = s.string("optionAsMeta")
        let metaHint = meta == "off" ? t("set.metaOff") : meta == "both" ? t("set.metaBoth") : t("set.metaSide")
        let copy = CheckRow(t("set.copyOnSelectBox"), on: s.bool("copyOnSelect")) { [weak self] on in self?.set(["copyOnSelect": on]) }
        let links = CheckRow(t("set.linksBox"), on: s.bool("openLinksSingleClick")) { [weak self] on in self?.set(["openLinksSingleClick": on]) }
        let bounce = CheckRow(t("set.bounce"), on: s.bool("bellBounceDock"), enabled: s.string("bell") != "off") { [weak self] on in self?.set(["bellBounceDock": on]) }
        let close = CheckRow(t("set.closingBox"), on: s.bool("confirmCloseBusy")) { [weak self] on in self?.set(["confirmCloseBusy": on]) }
        controls["copy"] = copy; controls["links"] = links; controls["bounce"] = bounce; controls["close"] = close
        let sb = ScrollbackField(s.int("scrollback"))
        sb.bad = scrollbackBad
        sb.commit = { [weak self] text in self?.commitScrollback(text) }
        controls["scrollback"] = sb
        let bellRow = vstack([hstack([segm("bell", s.string("bell"), [("visual", "set.visual"), ("sound", "set.sound"), ("off", "set.off")], key: "bell"), spring()], spacing: 0), hstack([bounce, spring()], spacing: 0)], spacing: 10)
        return [
            sec(t("set.keyboard"), after: false),
            row(t("set.optionMeta"), [segm("meta", meta, [("off", "set.off"), ("left", "set.left"), ("right", "set.right"), ("both", "set.both")], key: "optionAsMeta")], hint: metaHint, first: true),
            row(t("set.copyOnSelect"), [copy]),
            row(t("set.links"), [links], hint: s.bool("openLinksSingleClick") ? t("set.linksOn") : t("set.linksOff")),
            sec(t("set.terminal"), after: true),
            row(t("set.scrollback"), [sb, label(t("set.lines"), Fonts.pt(13))], hint: t("set.scrollbackHint"), first: true),
            row(t("set.bell"), [bellRow]),
            row(t("set.closing"), [close], hint: t("set.closingHint")),
        ]
    }

    /// The scrollback typed: a whole number of lines in its range ("10,000" too), else the field turns red.
    func commitScrollback(_ text: String) {
        let r = SettingsStore.range("scrollback")
        let n = Int(text.replacingOccurrences(of: "[\\s,._']", with: "", options: .regularExpression))
        guard let n, n >= r.min, n <= r.max else { scrollbackBad = true; draw(); return }
        scrollbackBad = false
        if n != store.int("scrollback") { set(["scrollback": n]) } else { draw() }
    }

    // MARK: Skills

    /// The stable ravenryd the hooks name (AppInstall.hookRavenryd), not the one inside the app.
    private var ravenryd: String { AppInstall.shared.hookRavenryd }

    func readSkills() {
        let q = "/api/setup/skills?ravenryd=\(ravenryd.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")"
        hub?.get(q) { [weak self] code, j in
            guard let self else { return }
            let was = self.skillsRead
            self.skillsRead = true
            let got = code == 200 ? j["skills"] as? [[String: Any]] ?? [] : []
            // Drawn again only when something changed (the 3 s read too).
            let same = was && (got as NSArray).isEqual(to: self.skills)
            self.skills = got
            if self.tab == "skills" && !same { self.draw() }
        }
    }

    private func skillsPane() -> [NSView] {
        func line(_ r: [String: Any], hooks: Bool) -> NSView {
            let kind = r["kind"] as? String ?? "", found = r["found"] as? Bool ?? false
            let ours = r["ours"] as? Bool ?? false, inst = r["installed"] as? Bool ?? false, hk = r["hooks"] as? String ?? "unavailable"
            let status: String, ok: Bool
            if !found { status = t("set.notHere"); ok = false }
            else if hooks { status = hk == "on" ? t("set.hooksOn") : hk == "off" ? t("set.hooksOff") : t("set.needsBoard"); ok = hk == "on" }
            else if ours { status = (r["version"] as? String).map { t("set.installedVersion", ["version": $0]) } ?? t("set.installed"); ok = true }
            else { status = inst ? t("set.someoneElse") : t("set.notInstalled"); ok = false }
            let icon = Box(fill: "btn", radius: 6)
            icon.translatesAutoresizingMaskIntoConstraints = false
            let ic = Icon("shell", "tx2", size: 14)
            icon.addSubview(ic); ic.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([icon.widthAnchor.constraint(equalToConstant: 26), icon.heightAnchor.constraint(equalToConstant: 26), ic.centerXAnchor.constraint(equalTo: icon.centerXAnchor), ic.centerYAnchor.constraint(equalTo: icon.centerYAnchor)])
            let words = vstack([label(r["name"] as? String ?? kind, Fonts.pt(13)), wrap(status, Fonts.pt(11.5), ok ? "ok" : "tx3")], spacing: 2)
            var items: [NSView] = [icon, words]
            let id = hooks ? "h:\(kind)" : kind
            let show = hooks ? found && hk != "unavailable" : found && !(inst && !ours)
            if show {
                let on = hooks ? hk == "on" : ours
                let b = RButton(on ? t("set.remove") : hooks ? t("set.setUp") : t("set.install"), .normal, small: true) { [weak self] in
                    if hooks { self?.setHooks(kind, !on) } else { self?.setSkill(kind, !on) }
                }
                b.isEnabled = busy != id
                controls[hooks ? "hooks:\(kind)" : "skill:\(kind)"] = b
                items.append(b)
            }
            return hstack(items, spacing: 10, insets: NSEdgeInsets(top: 8, left: 0, bottom: 8, right: 0))
        }
        func hint(_ s: String) -> NSView {
            let w = wrap(s, Fonts.pt(11.5), "tx3")
            w.widthAnchor.constraint(lessThanOrEqualToConstant: 420).isActive = true
            return hstack([w, spring()], spacing: 0, insets: NSEdgeInsets(top: 8, left: 0, bottom: 0, right: 0))
        }
        var out: [NSView] = [sec(t("set.skills"), sub: t("set.thisMac"), after: false)]
        if skills.isEmpty { out.append(hint(skillsRead ? t("set.needsBoard") : t("set.reading"))) }
        out += skills.map { line($0, hooks: false) }
        out.append(hint(t("set.skillsHint")))
        out.append(sec(t("set.hooksTitle"), after: true))
        out += skills.map { line($0, hooks: true) }
        out.append(hint(t("set.hooksHint")))
        if let e = skillError { out.append(hstack([wrap(e, Fonts.pt(12), "bad")], spacing: 0, insets: NSEdgeInsets(top: 6, left: 0, bottom: 0, right: 0))) }
        return out
    }

    private func setSkill(_ kind: String, _ on: Bool) {
        busy = kind; skillError = nil; draw()
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        let body: [String: Any] = on ? ["kind": kind, "on": true, "ravenryd": ravenryd, "version": version] : ["kind": kind, "on": false]
        hub?.post("/api/setup/skills", body) { [weak self] code, j in self?.done(code, j) }
    }

    private func setHooks(_ kind: String, _ on: Bool) {
        busy = "h:\(kind)"; skillError = nil; draw()
        var body: [String: Any] = ["ravenryd": ravenryd, "only": kind]
        if !on { body["remove"] = true }
        hub?.post("/api/setup/hooks", body) { [weak self] code, j in self?.done(code, j) }
    }

    private func done(_ code: Int, _ j: [String: Any]) {
        let what = busy?.hasPrefix("h:") == true ? "hooks" : "skills"
        busy = nil
        SettingsWindow.said(what)
        if code != 200 { skillError = j["error"] as? String ?? t("set.needsBoard") }
        readSkills()
        draw()
    }

    // MARK: writing

    func set(_ patch: [String: Any]) {
        if let e = store.set(patch) { NSLog("settings: \(e)") }
        SettingsWindow.said("settings")
        draw()
    }

    func windowWillClose(_ n: Notification) {}
    func windowDidBecomeKey(_ n: Notification) { tick() }
}

// MARK: small views

/// A centred column.
func vstackC(_ views: [NSView], spacing: CGFloat) -> NSStackView {
    let s = NSStackView(views: views)
    s.orientation = .vertical
    s.alignment = .centerX
    s.spacing = spacing
    s.translatesAutoresizingMaskIntoConstraints = false
    return s
}

func pinAll(_ v: NSView, _ p: NSView) {
    v.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([v.leadingAnchor.constraint(equalTo: p.leadingAnchor), v.trailingAnchor.constraint(equalTo: p.trailingAnchor),
                                 v.topAnchor.constraint(equalTo: p.topAnchor), v.bottomAnchor.constraint(equalTo: p.bottomAnchor)])
}

/// A CSS colour of a theme file: #RGB, #RRGGBB, #RRGGBBAA or rgba(r, g, b, a).
func css(_ s: String) -> NSColor {
    let x = s.trimmingCharacters(in: .whitespaces)
    if x.hasPrefix("rgb") {
        let n = x.components(separatedBy: CharacterSet(charactersIn: "0123456789.").inverted).filter { !$0.isEmpty }.compactMap { Double($0) }
        guard n.count >= 3 else { return .white }
        return NSColor(srgbRed: n[0] / 255, green: n[1] / 255, blue: n[2] / 255, alpha: n.count > 3 ? n[3] : 1)
    }
    var h = x.hasPrefix("#") ? String(x.dropFirst()) : x
    if h.count == 3 { h = h.map { "\($0)\($0)" }.joined() }
    guard let v = UInt64(h, radix: 16), h.count == 6 || h.count == 8 else { return .white }
    let rgb = h.count == 8 ? v >> 8 : v
    let a = h.count == 8 ? Double(v & 0xFF) / 255 : 1
    return NSColor(srgbRed: Double((rgb >> 16) & 0xFF) / 255, green: Double((rgb >> 8) & 0xFF) / 255, blue: Double(rgb & 0xFF) / 255, alpha: a)
}

/// A box that runs on a press (the offscreen window is not key: acts on mouseDown).
final class TapBox: Box {
    var run: (() -> Void)?
    init(fill: String? = nil, ring: String? = nil, radius: CGFloat, run: @escaping () -> Void) {
        self.run = run
        super.init(fill: fill, ring: ring, radius: radius)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityElement(true)
        if accessibilityRole() == nil || accessibilityRole() == .group { setAccessibilityRole(.button) }
    }
    required init?(coder: NSCoder) { fatalError() }
    /// A view in its middle, `pad` at the sides (or a fixed width `w`), `h` high.
    func put(_ v: NSView, pad: CGFloat = 0, w: CGFloat? = nil, h: CGFloat = 26) {
        addSubview(v)
        v.translatesAutoresizingMaskIntoConstraints = false
        var cs = [v.centerXAnchor.constraint(equalTo: centerXAnchor), v.centerYAnchor.constraint(equalTo: centerYAnchor), heightAnchor.constraint(equalToConstant: h)]
        if let w { cs.append(widthAnchor.constraint(equalToConstant: w)) } else { cs.append(widthAnchor.constraint(equalTo: v.widthAnchor, constant: 2 * pad)) }
        NSLayoutConstraint.activate(cs)
    }
    func press() { run?() }
    /// The left and right arrows while it has the keyboard (a tab, a segment): -1 or +1.
    var arrows: ((Int) -> Void)?
    override func mouseDown(with e: NSEvent) { run?() }
    override func resetCursorRects() { handCursor(run != nil) }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { run?(); return true }
    // The keyboard: Tab reaches it, Space or Return presses it, the arrows step.
    override var acceptsFirstResponder: Bool { run != nil }
    override var canBecomeKeyView: Bool { run != nil }
    override func becomeFirstResponder() -> Bool { needsDisplay = true; noteFocusRingMaskChanged(); return true }
    override func resignFirstResponder() -> Bool { noteFocusRingMaskChanged(); return true }
    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius).fill() }
    override func keyDown(with e: NSEvent) { if !keyPress(e, press: { [weak self] in self?.press() }, arrows: arrows) { super.keyDown(with: e) } }
}

/// Space and Return press; the left and right arrows step (`arrows`). True when the key was taken.
func keyPress(_ e: NSEvent, press: () -> Void, arrows: ((Int) -> Void)? = nil) -> Bool {
    switch e.keyCode {
    case 49, 36, 76: press(); return true
    case 123, 125: if let a = arrows { a(-1); return true }
    case 124, 126: if let a = arrows { a(1); return true }
    default: break
    }
    return false
}

/// .pop: what is picked and the up-down chevron on --btn; a press opens the menu over it.
final class PopBox: Box {
    let makeMenu: () -> NSMenu
    init(_ title: String, menu: @escaping () -> NSMenu) {
        self.makeMenu = menu
        super.init(fill: "btn", ring: "sep", radius: 6)
        translatesAutoresizingMaskIntoConstraints = false
        let l = label(title, Fonts.pt(13))
        l.setContentCompressionResistancePriority(.required, for: .horizontal)
        let r = hstack([l, UpDown()], spacing: 8, insets: NSEdgeInsets(top: 0, left: 10, bottom: 0, right: 8))
        addSubview(r)
        pinAll(r, self)
        heightAnchor.constraint(equalToConstant: 26).isActive = true
        setAccessibilityElement(true); setAccessibilityRole(.popUpButton); setAccessibilityLabel(t("set.font")); setAccessibilityValue(title)
        setContentHuggingPriority(.required, for: .horizontal)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func mouseDown(with e: NSEvent) { open() }
    override func resetCursorRects() { handCursor() }
    private func open() { makeMenu().popUp(positioning: nil, at: NSPoint(x: 0, y: bounds.height + 2), in: self) }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { open(); return true }
    override var acceptsFirstResponder: Bool { true }
    override var canBecomeKeyView: Bool { true }
    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill() }
    override func keyDown(with e: NSEvent) { if !keyPress(e, press: { open() }, arrows: { [weak self] _ in self?.open() }) { super.keyDown(with: e) } }
}

/// The pop-up's chevron (9 by 12, up and down, --tx3), settings.ts I.CHEV.
final class UpDown: NSView {
    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 9).isActive = true
        heightAnchor.constraint(equalToConstant: 12).isActive = true
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func draw(_ r: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let p = NSBezierPath()
            p.move(to: NSPoint(x: 2, y: 4.5)); p.line(to: NSPoint(x: 4.5, y: 2)); p.line(to: NSPoint(x: 7, y: 4.5))
            p.move(to: NSPoint(x: 2, y: 7.5)); p.line(to: NSPoint(x: 4.5, y: 10)); p.line(to: NSPoint(x: 7, y: 7.5))
            p.lineWidth = 1.4; p.lineCapStyle = .round; p.lineJoinStyle = .round
            Design.color("tx3").setStroke(); p.stroke()
        }
    }
}

/// .cbx: a box (15, 4 round, --work with a white tick when on) and its words; the whole is pressed.
final class CheckRow: Flipped {
    private(set) var on: Bool
    let enabled: Bool
    let run: (Bool) -> Void
    init(_ text: String, on: Bool, enabled: Bool = true, run: @escaping (Bool) -> Void) {
        self.on = on; self.enabled = enabled; self.run = run
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        let mark = CheckMark(on)
        let r = hstack([mark, label(text, Fonts.pt(13))], spacing: 8)
        addSubview(r)
        pinAll(r, self)
        alphaValue = enabled ? 1 : 0.45
        setAccessibilityElement(true); setAccessibilityRole(.checkBox); setAccessibilityLabel(text); setAccessibilityValue(on)
        setContentHuggingPriority(.required, for: .horizontal)
    }
    required init?(coder: NSCoder) { fatalError() }
    func press() { if enabled { run(!on) } }
    override func mouseDown(with e: NSEvent) { press() }
    override func resetCursorRects() { handCursor() }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { press(); return true }
    override var acceptsFirstResponder: Bool { enabled }
    override var canBecomeKeyView: Bool { enabled }
    // The ring around the box only, as a checkbox's.
    override var focusRingMaskBounds: NSRect { NSRect(x: 0, y: (bounds.height - 15) / 2, width: 15, height: 15) }
    override func drawFocusRingMask() { NSBezierPath(roundedRect: focusRingMaskBounds, xRadius: 4, yRadius: 4).fill() }
    override func keyDown(with e: NSEvent) { if !keyPress(e, press: { press() }) { super.keyDown(with: e) } }
}

final class CheckMark: NSView {
    let on: Bool
    init(_ on: Bool) {
        self.on = on
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 15).isActive = true
        heightAnchor.constraint(equalToConstant: 15).isActive = true
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func draw(_ r: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            if on {
                Design.color("work").setFill()
                NSBezierPath(roundedRect: bounds, xRadius: 4, yRadius: 4).fill()
                let p = NSBezierPath()
                p.move(to: NSPoint(x: 4.5, y: 7.8)); p.line(to: NSPoint(x: 6.5, y: 9.8)); p.line(to: NSPoint(x: 10.5, y: 5.4))
                p.lineWidth = 1.8; p.lineCapStyle = .round; p.lineJoinStyle = .round
                NSColor.white.setStroke(); p.stroke()
            } else {
                let p = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.75, dy: 0.75), xRadius: 3.4, yRadius: 3.4)
                p.lineWidth = 1.5
                Design.color("tx3").setStroke(); p.stroke()
            }
        }
    }
}

/// The preview's cursor: a block, a bar or an underline in the theme's cursor colour.
final class CursorMark: NSView {
    init(style: String, color: NSColor, font: NSFont) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.backgroundColor = color.cgColor
        let em = font.pointSize
        let w: CGFloat = style == "bar" ? 2 : em * 0.6, h: CGFloat = style == "underline" ? 2 : em * 1.15
        widthAnchor.constraint(equalToConstant: w).isActive = true
        heightAnchor.constraint(equalToConstant: h).isActive = true
    }
    required init?(coder: NSCoder) { fatalError() }
}

/// .inp: the scrollback's lines ("10,000"), 90 wide; Return or leaving it commits, Escape puts it back; red when wrong.
final class ScrollbackField: Box, NSTextFieldDelegate {
    let field: NSTextField
    var commit: ((String) -> Void)?
    var bad = false { didSet { ring = bad ? "bad" : "sep" } }
    private let value: Int
    init(_ n: Int) {
        value = n
        field = NSTextField(string: ScrollbackField.fmt(n))
        super.init(fill: "input", ring: "sep", radius: 6)
        translatesAutoresizingMaskIntoConstraints = false
        field.isBordered = false; field.drawsBackground = false; field.focusRingType = .none
        field.font = Fonts.pt(13).withTabularDigits
        field.delegate = self
        field.setAccessibilityLabel(t("set.scrollbackLines"))
        let r = SettingsStore.range("scrollback")
        toolTip = t("set.scrollbackRange", ["min": ScrollbackField.fmt(r.min), "max": ScrollbackField.fmt(r.max)])
        addSubview(field)
        field.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([widthAnchor.constraint(equalToConstant: 90), heightAnchor.constraint(equalToConstant: 26),
                                     field.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 9), field.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -9),
                                     field.centerYAnchor.constraint(equalTo: centerYAnchor)])
    }
    required init?(coder: NSCoder) { fatalError() }
    static func fmt(_ n: Int) -> String { let f = NumberFormatter(); f.numberStyle = .decimal; f.locale = Locale(identifier: "en_US"); return f.string(from: n as NSNumber) ?? "\(n)" }
    func controlTextDidEndEditing(_ n: Notification) { commit?(field.stringValue) }
    func control(_ c: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) { commit?(field.stringValue); return true }
        if sel == #selector(NSResponder.cancelOperation(_:)) { field.stringValue = ScrollbackField.fmt(value); bad = false; return true }
        return false
    }
}
