// The Settings window's Hand-off tab (SET-005, SET-006, SET-007): the
// hub's own settings for every project, which until now only the browser
// board's gear card edited (hub/public/app.js hsHtml(), asHtml(),
// prCardHtml()), the same fields, limits and words:
//
// - Hand-off: on or off (off greys the line and the ceiling, Hand off now
//   still works), the clean-point line and the ceiling on one track with
//   two thumbs (dragged, or the arrows on a focused thumb) and a stepper
//   each, 10 to 95 in steps of 5, the ceiling always at least 5 above the
//   line; the context window (200k or 1M) the tokens are counted against;
//   a fresh session after a hand-off. GET and POST /api/settings/handoff,
//   only the keys that changed, one save at a time; a refused save says
//   why and the controls go back to what is stored.
// - New sessions: start them with Claude or Codex (POST
//   /api/settings/assistant, the hub's note when the one picked is not
//   installed), the Codex model to fall back on, and the folder new
//   projects go in (Change opens the folder dialog on this Mac, POST
//   /api/settings/projects-root; locked while MC_PROJECTS_ROOT sets it).
//
// The foot says what happened: "Saves as you change it", "Saved", or why
// not. The tab is read when it opens and every 3 s while it shows, so a
// change made on the board or the phone shows here.

import AppKit

/// What the Hand-off tab holds between drawings.
struct HandoffState {
    static let keys = ["handoffEnabled", "handoffThreshold", "handoffCeiling", "contextWindow", "handoffAutoStart"]
    static let min = 10, max = 95, gap = 5, step = 5
    /// What the hub has stored, and what the controls show (the same, or a change on its way).
    var stored: [String: Any]?
    var cur: [String: Any]?
    var saving = false
    var again = false
    /// idle, saved, saved-as, saved-model, saved-root, error, noboard.
    var foot = "idle"
    var err = ""
    var assistant: [String: Any]?
    var root: [String: Any]?
    var rootWaiting = false
    var rootErr = ""
    var modelBad = false
    /// Rule suggestions (GET /api/settings/repeats): on, locked, the last run; a change on its way; why it failed.
    var repeats: [String: Any]?
    var repeatsBusy = false
    var repeatsErr = ""

    var on: Bool { cur?["handoffEnabled"] as? Bool ?? true }
    var line: Int { (cur?["handoffThreshold"] as? NSNumber)?.intValue ?? 50 }
    var ceiling: Int { (cur?["handoffCeiling"] as? NSNumber)?.intValue ?? 70 }
    var window: Int { (cur?["contextWindow"] as? NSNumber)?.intValue ?? 200000 }
    var fresh: Bool { cur?["handoffAutoStart"] as? Bool ?? true }

    /// "500k", "1M", "1.5M" (the board's hsTok).
    static func tok(_ n: Double) -> String {
        if n >= 1e6 { let m = (n / 1e6 * 100).rounded() / 100; return (m == m.rounded() ? "\(Int(m))" : "\(m)") + "M" }
        return "\(Int((n / 1000).rounded()))k"
    }
    static func up(_ v: Int) -> Int { v / step * step + step }
    static func down(_ v: Int) -> Int { Int((Double(v) / Double(step)).rounded(.up)) * step - step }
}

extension SettingsWindow {
    // MARK: reading

    /// The three settings from the hub; `quiet`: the 3 s read, drawn again only when something changed.
    func readHandoff(quiet: Bool = false) {
        guard let hub else { ho.foot = "noboard"; draw(); return }
        if ho.stored == nil, let s = hub.state?.raw["settings"] as? [String: Any], s["handoffThreshold"] != nil {
            // The state's copy first, so the tab is not empty while the GET is on its way.
            let st = Dictionary(uniqueKeysWithValues: HandoffState.keys.compactMap { k in s[k].map { (k, $0) } })
            if st.count == HandoffState.keys.count { ho.stored = st; ho.cur = st }
        }
        hub.get("/api/settings/repeats") { [weak self] code, j in
            guard let self, code == 200, !self.ho.repeatsBusy else { return }
            let same = self.ho.repeats.map { ($0 as NSDictionary).isEqual(to: j) } ?? false
            self.ho.repeats = j
            if !same && self.tab == "handoff" { self.draw() }
        }
        hub.get("/api/settings/handoff") { [weak self] code, j in
            guard let self else { return }
            guard code == 200, let s = j["settings"] as? [String: Any] else {
                if self.ho.stored == nil { self.ho.foot = "noboard"; if self.tab == "handoff" { self.draw() } }
                return
            }
            let st = Dictionary(uniqueKeysWithValues: HandoffState.keys.compactMap { k in s[k].map { (k, $0) } })
            // A change on its way wins over what the board had before it.
            guard !self.ho.saving else { return }
            let same = (st as NSDictionary).isEqual(to: self.ho.stored ?? [:]) && (st as NSDictionary).isEqual(to: self.ho.cur ?? [:])
            if self.ho.foot == "noboard" { self.ho.foot = "idle" }
            self.ho.stored = st; self.ho.cur = st
            if self.tab == "handoff" && !(quiet && same) { self.draw() }
        }
        hub.get("/api/settings/assistant") { [weak self] code, j in
            guard let self, code == 200 else { return }
            let same = (j as NSDictionary).isEqual(to: self.ho.assistant ?? [:])
            self.ho.assistant = j
            if self.tab == "handoff" && !same { self.draw() }
        }
        hub.get("/api/settings/projects-root") { [weak self] code, j in
            guard let self, code == 200 else { return }
            let same = (j as NSDictionary).isEqual(to: self.ho.root ?? [:])
            self.ho.root = j
            if self.tab == "handoff" && !same && !self.ho.rootWaiting { self.draw() }
        }
    }

    // MARK: writing

    /// A change from a control: shown at once, saved (one save at a time, only the keys that differ).
    func handoffChange(_ patch: [String: Any]) {
        guard ho.cur != nil else { return }
        for (k, v) in patch { ho.cur?[k] = v }
        draw()
        handoffSave()
    }

    private func handoffSave() {
        if ho.saving { ho.again = true; return }
        guard let cur = ho.cur, let stored = ho.stored, let hub else { return }
        var diff: [String: Any] = [:]
        for k in HandoffState.keys where !((cur[k] as? NSObject)?.isEqual(stored[k]) ?? false) { diff[k] = cur[k] }
        guard !diff.isEmpty else { return }
        ho.saving = true
        hub.post("/api/settings/handoff", diff) { [weak self] code, j in
            guard let self else { return }
            self.ho.saving = false
            if code == 200, let s = j["settings"] as? [String: Any] {
                let st = Dictionary(uniqueKeysWithValues: HandoffState.keys.compactMap { k in s[k].map { (k, $0) } })
                self.ho.stored = st
                if !self.ho.again { self.ho.cur = st }
                self.ho.foot = "saved"
                SettingsWindow.said("handoff")
            } else {
                self.ho.cur = self.ho.stored
                self.ho.again = false
                self.ho.foot = "error"
                self.ho.err = sentence(j["error"] as? String ?? t("page.didNotWork"))
            }
            if self.ho.again { self.ho.again = false; self.handoffSave(); return }
            self.draw()
        }
    }

    private func assistantChange(_ patch: [String: Any], foot: String) {
        hub?.post("/api/settings/assistant", patch) { [weak self] code, j in
            guard let self else { return }
            if code == 200 {
                var a = self.ho.assistant ?? [:]
                for (k, v) in j where k != "ok" && k != "backup" { a[k] = v }
                if patch["codexModel"] != nil && j["codexModel"] == nil { a["codexModel"] = NSNull() }
                self.ho.assistant = a
                self.ho.foot = foot
                self.ho.modelBad = false
                SettingsWindow.said("assistant")
            } else {
                self.ho.foot = "error"
                self.ho.err = sentence(j["error"] as? String ?? t("page.didNotWork"))
                if patch["codexModel"] != nil { self.ho.modelBad = true }
            }
            self.draw()
        }
    }

    /// Change: the folder dialog on this window (off every screen, RAVENRY_SETTINGS_PROJECTS_ROOT's folder), then the hub.
    func changeRoot() {
        guard !ho.rootWaiting else { return }
        func save(_ path: String) {
            ho.rootWaiting = true; ho.rootErr = ""; draw()
            hub?.post("/api/settings/projects-root", ["path": path, "from": "chosen"]) { [weak self] code, j in
                guard let self else { return }
                self.ho.rootWaiting = false
                if code == 200 { var v = j; v["ok"] = nil; v["backup"] = nil; self.ho.root = v; self.ho.foot = "saved-root"; SettingsWindow.said("settings") }
                else { self.ho.rootErr = t("ho.notSaved", ["why": sentence(j["error"] as? String ?? t("page.didNotWork"))]) }
                self.draw()
            }
        }
        if offscreen {
            if let f = ProcessInfo.processInfo.environment["RAVENRY_SETTINGS_PROJECTS_ROOT"], !f.isEmpty { save(f) }
            return
        }
        let p = NSOpenPanel()
        p.title = t("ho.rootTitle")
        p.prompt = t("ho.rootButton")
        p.canChooseFiles = false
        p.canChooseDirectories = true
        p.canCreateDirectories = true
        p.allowsMultipleSelection = false
        if let path = ho.root?["path"] as? String { p.directoryURL = URL(fileURLWithPath: (path as NSString).expandingTildeInPath) }
        p.beginSheetModal(for: window) { r in if r == .OK, let u = p.url { save(u.path) } }
    }

    // MARK: drawing

    func handoffPane() -> [NSView] {
        var out: [NSView] = [sec(t("ho.title"), sub: t("ho.everyProject"), after: false)]
        guard ho.cur != nil else {
            let words = ho.foot == "noboard" ? t("set.needsBoard") : t("set.reading")
            out.append(row("", [wrap(words, Fonts.pt(12), "tx3")], first: true))
            return out
        }
        let on = ho.on, L = ho.line, C = ho.ceiling, W = Double(ho.window)
        let auto = CheckRow(t("ho.auto"), on: on) { [weak self] v in self?.handoffChange(["handoffEnabled": v]) }
        controls["ho:on"] = auto
        out.append(row(t("ho.handOff"), [auto], hint: on ? t("ho.onHint") : t("ho.offHint"), first: true))

        // The track and its two steppers, greyed while off.
        let track = HandoffTrack(line: L, ceiling: C, enabled: on)
        track.moved = { [weak self] l, c in self?.trackMoved(l, c) }
        track.ended = { [weak self] l, c in self?.handoffChange(["handoffThreshold": l, "handoffCeiling": c]) }
        controls["ho:track"] = track
        let zero = label("0", Fonts.pt(11).withTabularDigits, "tx3"), whole = label(HandoffState.tok(W), Fonts.pt(11).withTabularDigits, "tx3")
        let scale = hstack([zero, spring(), whole], spacing: 0, insets: NSEdgeInsets(top: 0, left: 4, bottom: 0, right: 4))
        scale.widthAnchor.constraint(equalToConstant: HandoffTrack.width).isActive = true
        let lim = (tMinus: HandoffState.down(L) < HandoffState.min, tPlus: HandoffState.up(L) > C - HandoffState.gap,
                   cMinus: HandoffState.down(C) < L + HandoffState.gap, cPlus: HandoffState.up(C) > HandoffState.max)
        let lineRow = stepRow("t", dot: "you", words: t("ho.line"), value: L, W: W, enabled: on, minusOff: lim.tMinus, plusOff: lim.tPlus) { [weak self] d in
            self?.handoffChange(["handoffThreshold": d < 0 ? HandoffState.down(L) : HandoffState.up(L)])
        }
        let ceilRow = stepRow("c", dot: "bad", words: t("ho.ceiling"), value: C, W: W, enabled: on, minusOff: lim.cMinus, plusOff: lim.cPlus) { [weak self] d in
            self?.handoffChange(["handoffCeiling": d < 0 ? HandoffState.down(C) : HandoffState.up(C)])
        }
        var col: [NSView] = [track, scale, lineRow, ceilRow]
        if on && (lim.tPlus || lim.cMinus) {
            let h = wrap(t("ho.gapHint", ["n": "\(HandoffState.gap)"]), Fonts.pt(11.5), "tx3")
            h.widthAnchor.constraint(lessThanOrEqualToConstant: HandoffTrack.width).isActive = true
            col.append(h)
        }
        let block = vstack(col, spacing: 6)
        block.setCustomSpacing(0, after: track)
        block.setCustomSpacing(10, after: scale)
        block.alphaValue = on ? 1 : 0.5
        out.append(row("", [block], join: true))

        let win = seg("ho:window", W >= 1_000_000 ? "1m" : "200k", [("200k", "200k"), ("1m", "1M")]) { [weak self] v in
            self?.handoffChange(["contextWindow": v == "1m" ? 1_000_000 : 200_000])
        }
        out.append(row(t("ho.window"), [win], hint: t("ho.windowHint")))
        let fresh = CheckRow(t("ho.freshBox"), on: ho.fresh) { [weak self] v in self?.handoffChange(["handoffAutoStart": v]) }
        controls["ho:fresh"] = fresh
        out.append(row(t("ho.after"), [fresh], hint: t("ho.freshHint")))

        // New sessions: the assistant, Codex's fallback model, where new projects go.
        out.append(sec(t("ho.newSessions"), sub: t("ho.everyProject"), after: true))
        let a = ho.assistant ?? (hub?.state?.raw["assistants"] as? [String: Any]) ?? [:]
        let startWith = a["startWith"] as? String == "codex" ? "codex" : "claude"
        let who = seg("ho:as", startWith, [("claude", "Claude"), ("codex", "Codex")]) { [weak self] v in
            self?.assistantChange(["startWith": v], foot: "saved-as")
        }
        // The one picked is not installed: the board starts the other, and says so under the switch.
        let fallback = a["fallback"] as? Bool == true ? (a["note"] as? String).flatMap { $0.isEmpty ? nil : $0 } : nil
        let note = fallback.map { n -> NSView in let w = wrap(n, Fonts.pt(12), "you"); controls["ho:as:note"] = w; return w }
        out.append(row(t("ho.startWith"), [who], line: note, hint: t("ho.startHint"), first: true))
        let model = ModelField(a["codexModel"] as? String ?? "")
        model.bad = ho.modelBad
        model.commit = { [weak self] s in
            guard let self else { return }
            let now = (self.ho.assistant?["codexModel"] as? String) ?? ""
            if s == now { self.ho.modelBad = false; self.draw(); return }
            self.assistantChange(["codexModel": s], foot: "saved-model")
        }
        controls["ho:model"] = model
        out.append(row(t("ho.codexModel"), [model], hint: t("ho.codexModelHint")))
        out.append(rootRow())
        out += repeatsRows()

        // The foot: what the last change did.
        let foot: NSView
        switch ho.foot {
        case "saved", "saved-as", "saved-model", "saved-root":
            let words = ho.foot == "saved" ? t("ho.saved") : ho.foot == "saved-as" && fallback == nil ? t("ho.savedAs", ["name": startWith == "codex" ? "Codex" : "Claude Code"]) : t("ho.savedPlain")
            foot = hstack([symbol("checkmark", "ok", 11), label(words, Fonts.pt(12), "ok")], spacing: 6)
        case "error": foot = wrap(t("ho.notSaved", ["why": ho.err]), Fonts.pt(12), "bad")
        default: foot = label(t("ho.foot"), Fonts.pt(12), "tx3")
        }
        controls["ho:foot"] = foot
        out.append(hstack([foot, spring()], spacing: 0, insets: NSEdgeInsets(top: 14, left: 184, bottom: 0, right: 0)))
        return out
    }

    /// Rule suggestions (PAGE-018): the daily run, off until turned on here, never by a phone or an agent.
    private func repeatsRows() -> [NSView] {
        var out: [NSView] = [sec(t("rep.title"), sub: t("set.thisMac"), after: true)]
        let rp = ho.repeats
        let on = rp?["on"] as? Bool ?? false, locked = rp?["locked"] as? Bool ?? false
        let box = CheckRow(t("rep.box"), on: on, enabled: rp != nil && !locked && !ho.repeatsBusy) { [weak self] v in self?.repeatsChange(v) }
        controls["rep:on"] = box
        var hint = locked ? t("rep.locked") : on ? t("rep.onHint") : t("rep.offHint")
        if let last = rp?["lastRun"] as? [String: Any], let at = last["at"] as? String {
            let when = When.day(at) ?? at
            hint += " " + (last["ok"] as? Bool == false ? t("rep.ranFailed", ["when": when]) : t("rep.ranOk", ["when": when]))
        }
        if !ho.repeatsErr.isEmpty { hint = t("rep.failed", ["why": ho.repeatsErr]) }
        out.append(row(t("rep.label"), [box], hint: hint, first: true))
        return out
    }

    private func repeatsChange(_ on: Bool) {
        guard let hub, !ho.repeatsBusy else { return }
        ho.repeatsBusy = true; ho.repeatsErr = ""
        draw()
        hub.post("/api/settings/repeats", ["on": on]) { [weak self] code, j in
            guard let self else { return }
            self.ho.repeatsBusy = false
            if code == 200 { self.ho.repeats = j } else { self.ho.repeatsErr = j["error"] as? String ?? "\(code)" }
            self.draw()
        }
    }

    /// A dot, the words, the tokens it stands for, and the stepper (− 50% +).
    private func stepRow(_ k: String, dot: String, words: String, value: Int, W: Double, enabled: Bool, minusOff: Bool, plusOff: Bool, step: @escaping (Int) -> Void) -> NSView {
        let d = Box(fill: dot, radius: 4)
        d.translatesAutoresizingMaskIntoConstraints = false
        d.widthAnchor.constraint(equalToConstant: 8).isActive = true
        d.heightAnchor.constraint(equalToConstant: 8).isActive = true
        let name = label(words, Fonts.pt(13))
        name.setContentCompressionResistancePriority(.required, for: .horizontal)
        let tok = label(t("ho.past", ["n": HandoffState.tok(W * Double(value) / 100), "of": HandoffState.tok(W)]), Fonts.pt(12).withTabularDigits, "tx3")
        controls["ho:\(k):tok"] = tok
        let minus = TapBox(fill: "btn", radius: 0) { if enabled && !minusOff { step(-1) } }
        let plus = TapBox(fill: "btn", radius: 0) { if enabled && !plusOff { step(1) } }
        minus.put(label("\u{2212}", Fonts.pt(13), !enabled || minusOff ? "tx3" : "tx"), w: 26)
        plus.put(label("+", Fonts.pt(13), !enabled || plusOff ? "tx3" : "tx"), w: 26)
        minus.arrows = { d in if enabled { if d < 0 && !minusOff { step(-1) } else if d > 0 && !plusOff { step(1) } } }
        plus.arrows = minus.arrows
        minus.setAccessibilityLabel(t("ho.lower", ["what": words])); plus.setAccessibilityLabel(t("ho.raise", ["what": words]))
        let vbox = Box(fill: "input")
        vbox.translatesAutoresizingMaskIntoConstraints = false
        let vl = label("\(value)%", Fonts.pt(13).withTabularDigits)
        vbox.addSubview(vl)
        vl.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([vbox.widthAnchor.constraint(equalToConstant: 46), vl.centerXAnchor.constraint(equalTo: vbox.centerXAnchor), vl.centerYAnchor.constraint(equalTo: vbox.centerYAnchor)])
        controls["ho:\(k):value"] = vl
        controls["ho:\(k):minus"] = minus; controls["ho:\(k):plus"] = plus
        let box = Box(ring: "sep", radius: 6)
        box.translatesAutoresizingMaskIntoConstraints = false
        box.wantsLayer = true; box.layer?.masksToBounds = true
        let sr = hstack([minus, vbox, plus], spacing: 0)
        box.addSubview(sr)
        pinAll(sr, box)
        sr.heightAnchor.constraint(equalToConstant: 26).isActive = true
        let r = hstack([d, name, spring(), tok, box], spacing: 10)
        r.widthAnchor.constraint(equalToConstant: HandoffTrack.width).isActive = true
        return r
    }

    /// Mid-drag: the values and the tokens drawn in place (the window is drawn again when the thumb is let go).
    private func trackMoved(_ l: Int, _ c: Int) {
        let W = Double(ho.window)
        for (k, v) in [("t", l), ("c", c)] {
            (controls["ho:\(k):value"] as? NSTextField)?.stringValue = "\(v)%"
            (controls["ho:\(k):tok"] as? NSTextField)?.stringValue = t("ho.past", ["n": HandoffState.tok(W * Double(v) / 100), "of": HandoffState.tok(W)])
        }
    }

    /// New projects go in: the folder (a field you cannot type in), Change, and where it came from.
    private func rootRow() -> NSView {
        guard let v = ho.root ?? (hub?.state?.raw["projectsRoot"] as? [String: Any]) else {
            return row(t("ho.root"), [label(t("set.reading"), Fonts.pt(12), "tx3")])
        }
        let path = v["path"] as? String ?? ""
        let locked = v["locked"] as? Bool ?? false
        let field = Box(fill: "input", ring: "sep", radius: 6)
        field.translatesAutoresizingMaskIntoConstraints = false
        let pl = label(path, NSFont.monospacedSystemFont(ofSize: 12, weight: .regular))
        pl.lineBreakMode = .byTruncatingMiddle
        pl.isSelectable = true
        pl.toolTip = path
        controls["ho:root:path"] = pl
        let fr = hstack([symbol("folder", "tx3", 12), pl], spacing: 7, insets: NSEdgeInsets(top: 0, left: 9, bottom: 0, right: 9))
        field.addSubview(fr)
        pinAll(fr, field)
        NSLayoutConstraint.activate([field.heightAnchor.constraint(equalToConstant: 28), field.widthAnchor.constraint(equalToConstant: 360)])
        var ctl: [NSView] = [field]
        if !locked {
            let b = RButton(ho.rootWaiting ? t("ho.rootWaiting") : t("ho.change"), .normal, small: true) { [weak self] in self?.changeRoot() }
            b.isEnabled = !ho.rootWaiting
            controls["ho:root:change"] = b
            ctl.append(b)
        }
        let line: String
        if !ho.rootErr.isEmpty { line = ho.rootErr }
        else if locked { line = t("ho.rootLocked") }
        else {
            switch v["from"] as? String {
            case "chosen": line = t("ho.rootChosen")
            case "shared":
                let n = (v["count"] as? NSNumber)?.intValue ?? 0, all = (v["total"] as? NSNumber)?.intValue ?? 0
                line = all == 1 ? t("ho.rootSharedOne") : t("ho.rootShared", ["n": "\(n)", "total": "\(all)"])
            case "first-run": line = t("ho.rootFirstRun")
            default: line = v["ask"] as? Bool == true ? t("ho.rootAsk") : t("ho.rootFile")
            }
        }
        let r = row(t("ho.root"), ctl, hint: line)
        if !ho.rootErr.isEmpty, let h = findText(r, line) { h.textColor = Design.color("bad") }
        return r
    }

    private func findText(_ v: NSView, _ s: String) -> NSTextField? {
        if let f = v as? NSTextField, f.stringValue == s { return f }
        for x in v.subviews { if let f = findText(x, s) { return f } }
        return nil
    }
}

/// An SF Symbol in a token's colour.
func symbol(_ name: String, _ tint: String, _ size: CGFloat) -> NSImageView {
    let cfg = NSImage.SymbolConfiguration(pointSize: size, weight: .semibold)
    let v = NSImageView(image: NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(cfg) ?? NSImage())
    v.contentTintColor = Design.color(tint)
    v.translatesAutoresizingMaskIntoConstraints = false
    v.setContentHuggingPriority(.required, for: .horizontal)
    return v
}

/// "Refused." with its full stop, as the board writes its reasons.
func sentence(_ s: String) -> String { s.hasSuffix(".") ? s : s + "." }

/// The hand-off track (the board's .hs-track): 0 to 100% of the context
/// window, the band from the line to the ceiling in --you and past the
/// ceiling in --bad, a thumb on each. A thumb follows the pointer in steps
/// of 5 and stops 5 from the other; with the keyboard, Tab reaches each
/// thumb and the arrows move it.
final class HandoffTrack: NSView {
    static let width: CGFloat = 470
    private(set) var line: Int
    private(set) var ceiling: Int
    let enabled: Bool
    /// Mid-drag, and when the thumb is let go (or an arrow moved it).
    var moved: ((Int, Int) -> Void)?
    var ended: ((Int, Int) -> Void)?
    /// The thumb that has the keyboard or the pointer: "t" or "c".
    private(set) var focus: String?
    private var dragging: String?

    init(line: Int, ceiling: Int, enabled: Bool) {
        self.line = line; self.ceiling = ceiling; self.enabled = enabled
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: Self.width).isActive = true
        heightAnchor.constraint(equalToConstant: 26).isActive = true
        setAccessibilityElement(true)
        setAccessibilityRole(.slider)
        setAccessibilityLabel(t("ho.trackLabel"))
        setAccessibilityValue("\(line)%, \(ceiling)%")
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    private let inset: CGFloat = 10
    private func x(_ v: Int) -> CGFloat { inset + (bounds.width - 2 * inset) * CGFloat(v) / 100 }
    private func value(at px: CGFloat) -> Int {
        let raw = (px - inset) / max(1, bounds.width - 2 * inset) * 100
        return Int((raw / CGFloat(HandoffState.step)).rounded()) * HandoffState.step
    }

    override func draw(_ r: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let mid = bounds.midY
            let bar = NSRect(x: inset, y: mid - 3, width: bounds.width - 2 * inset, height: 6)
            Design.color("card2").setFill()
            NSBezierPath(roundedRect: bar, xRadius: 3, yRadius: 3).fill()
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(roundedRect: bar, xRadius: 3, yRadius: 3).addClip()
            Design.color("you").withAlphaComponent(0.38).setFill()
            NSRect(x: x(line), y: bar.minY, width: x(ceiling) - x(line), height: 6).fill()
            Design.color("bad").withAlphaComponent(0.38).setFill()
            NSRect(x: x(ceiling), y: bar.minY, width: bar.maxX - x(ceiling), height: 6).fill()
            NSGraphicsContext.restoreGraphicsState()
            for (k, v, c) in [("t", line, "you"), ("c", ceiling, "bad")] {
                let cx = x(v)
                let o = NSRect(x: cx - 8, y: mid - 8, width: 16, height: 16)
                if enabled && focus == k && window?.firstResponder === self {
                    Design.color("work").setStroke()
                    let f = NSBezierPath(ovalIn: o.insetBy(dx: -4.5, dy: -4.5)); f.lineWidth = 2; f.stroke()
                }
                let sh = NSShadow(); sh.shadowBlurRadius = 3; sh.shadowOffset = NSSize(width: 0, height: -1); sh.shadowColor = NSColor.black.withAlphaComponent(0.35)
                NSGraphicsContext.saveGraphicsState(); sh.set()
                NSColor.white.setFill(); NSBezierPath(ovalIn: o).fill()
                NSGraphicsContext.restoreGraphicsState()
                Design.color(c).setStroke()
                let ring = NSBezierPath(ovalIn: o.insetBy(dx: -1.25, dy: -1.25)); ring.lineWidth = 2.5; ring.stroke()
            }
        }
    }

    // MARK: the pointer

    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func mouseDown(with e: NSEvent) {
        guard enabled else { return }
        let p = convert(e.locationInWindow, from: nil)
        // The nearer thumb; on a tie, the one the pointer is past.
        let dl = abs(p.x - x(line)), dc = abs(p.x - x(ceiling))
        dragging = dl < dc || (dl == dc && p.x < x(line)) ? "t" : "c"
        focus = dragging
        window?.makeFirstResponder(self)
        drag(to: p.x)
    }
    override func mouseDragged(with e: NSEvent) { if dragging != nil { drag(to: convert(e.locationInWindow, from: nil).x) } }
    override func mouseUp(with e: NSEvent) {
        guard dragging != nil else { return }
        dragging = nil
        ended?(line, ceiling)
    }
    /// The self-test's drag: a thumb to a point of the track, let go.
    func drag(_ k: String, toPercent v: Int) {
        guard enabled else { return }
        dragging = k
        drag(to: x(v))
        dragging = nil
        ended?(line, ceiling)
    }
    private func drag(to px: CGFloat) {
        let v = value(at: px)
        if dragging == "t" { line = max(HandoffState.min, min(ceiling - HandoffState.gap, v)) }
        else { ceiling = min(HandoffState.max, max(line + HandoffState.gap, v)) }
        setAccessibilityValue("\(line)%, \(ceiling)%")
        needsDisplay = true
        moved?(line, ceiling)
    }

    // MARK: the keyboard

    override var acceptsFirstResponder: Bool { enabled }
    override var canBecomeKeyView: Bool { enabled }
    override func becomeFirstResponder() -> Bool {
        // Tab lands on the line's thumb, Shift+Tab on the ceiling's.
        if focus == nil { focus = NSApp.currentEvent?.modifierFlags.contains(.shift) == true ? "c" : "t" }
        needsDisplay = true
        return true
    }
    override func resignFirstResponder() -> Bool { focus = nil; needsDisplay = true; return true }
    override func keyDown(with e: NSEvent) {
        guard enabled else { return super.keyDown(with: e) }
        let k = focus ?? "t"
        switch e.keyCode {
        case 123, 125, 124, 126:
            let d = e.keyCode == 123 || e.keyCode == 125 ? -1 : 1
            if k == "t" { line = max(HandoffState.min, min(ceiling - HandoffState.gap, d < 0 ? HandoffState.down(line) : HandoffState.up(line))) }
            else { ceiling = min(HandoffState.max, max(line + HandoffState.gap, d < 0 ? HandoffState.down(ceiling) : HandoffState.up(ceiling))) }
            needsDisplay = true
            ended?(line, ceiling)
        case 48:
            // Tab: from the line's thumb to the ceiling's, then on to the next control.
            let back = e.modifierFlags.contains(.shift)
            if !back && k == "t" { focus = "c"; needsDisplay = true }
            else if back && k == "c" { focus = "t"; needsDisplay = true }
            else if back { window?.selectPreviousKeyView(self) } else { window?.selectNextKeyView(self) }
        default: super.keyDown(with: e)
        }
    }
}

/// Codex's fallback model: a name typed, saved on Return or on leaving it; red when the hub refuses it.
final class ModelField: Box, NSTextFieldDelegate {
    let field: NSTextField
    var commit: ((String) -> Void)?
    var bad = false { didSet { ring = bad ? "bad" : "sep" } }
    private let value: String
    init(_ s: String) {
        value = s
        field = NSTextField(string: s)
        super.init(fill: "input", ring: "sep", radius: 6)
        translatesAutoresizingMaskIntoConstraints = false
        field.isBordered = false; field.drawsBackground = false; field.focusRingType = .none
        field.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        field.placeholderAttributedString = NSAttributedString(string: t("ho.codexModelNone"), attributes: [.font: Fonts.pt(12.5), .foregroundColor: Design.color("tx3")])
        field.delegate = self
        field.setAccessibilityLabel(t("ho.codexModel"))
        addSubview(field)
        field.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([widthAnchor.constraint(equalToConstant: 220), heightAnchor.constraint(equalToConstant: 26),
                                     field.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 9), field.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -9),
                                     field.centerYAnchor.constraint(equalTo: centerYAnchor)])
    }
    required init?(coder: NSCoder) { fatalError() }
    private var done = false
    private func send() { guard !done else { return }; done = true; commit?(field.stringValue.trimmingCharacters(in: .whitespaces)) }
    func controlTextDidEndEditing(_ n: Notification) { send() }
    func control(_ c: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) { send(); return true }
        if sel == #selector(NSResponder.cancelOperation(_:)) { field.stringValue = value; bad = false; return true }
        return false
    }
}
