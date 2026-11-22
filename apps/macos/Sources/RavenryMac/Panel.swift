// The session panel on the right, as the Electron app draws it
// (apps/desktop/src/renderer/app.ts renderPanel, sessionPanel, shellPanel,
// projectPanel; cards.ts for a checkpoint; app.css .panel, .p-h, .sec):
// the head (the project, the assistant, pin, hide), the state in words and
// since when, the setup lines, a checkpoint's card in the hub's words
// (cp.words) or the question with its quick answers, the context with Hand
// off now, the last hand-off, the latest picture, the brief (its goal and
// Next from brief.nextParts), the plan, and for a pane of this window's
// daemon what was typed there (pane.inputs). Every answer is the person's
// click, posted to the hub as the desktop posts it.

import AppKit

/// What the first-launch step set up for an assistant on this Mac (GET /api/setup/skills), and
/// whether the panel can turn a missing one on in place (else its line points to Settings):
/// not hooks Ravenry has no file for, nor hooks Codex's own config turns off, nor a skill folder
/// that holds someone else's skill.
struct SetupLines: Equatable {
    var hooks: Bool, skill: Bool
    var hooksHere = true, skillHere = true
}

final class PanelView: Box {
    static let width: CGFloat = 296

    struct Host {
        var hub: HubClient
        var pinned: (String) -> Bool
        var togglePin: (String) -> Void
        var hide: () -> Void
        var openPicture: (HubProject, [String: Any]) -> Void
        var openPage: (String, String) -> Void
        var inputs: (String) -> [[String: Any]]?
        var setup: (String) -> SetupLines?
        var toast: (String) -> Void
        var answered: () -> Void
        /// A pane's name as the tabs say it, when this window has it.
        var paneName: (String) -> String? = { _ in nil }
        /// A pick opens side by side in the middle.
        var openPicker: (String, Int?) -> Void = { _, _ in }
        /// "Who can type here" for a pane of this daemon, and taking a grant back (Lent.swift).
        var whoCanType: (String) -> [WhoRow] = { _ in [] }
        var revoke: (String, String) -> Void = { _, _ in }
        /// "Opened by you, 16:58, in paper-boat".
        var opened: (String) -> String? = { _ in nil }
        /// What the agent in a pane last reported (the daemon's pane.agent), else nil.
        var report: (String) -> [String: Any]? = { _ in nil }
        /// The agent whose own pane it is ("Claude"), else nil.
        var ownerOf: (String) -> String? = { _ in nil }
        /// The version of the older daemon a pane of this window runs on, when
        /// it drains for a newer one (Daemons.swift), else nil.
        var olderDaemon: (String) -> String? = { _ in nil }
        /// A move of this session id is under way.
        var moving: (String) -> Bool = { _ in false }
        /// A local session in a pane: its worktree's cards and the files it changed (Review.swift).
        var extras: (HubProject, HubSession, (([NSView?]) -> NSView), ((String?, NSView?, [NSView?]) -> NSView)) -> [NSView] = { _, _, _, _ in [] }
        /// A pane of this window in front (its tab); false when the window has no such pane.
        var showPane: (String) -> Bool = { _ in false }
        /// A pane's labels (ravenry.session: the hub started it as a session).
        var paneLabels: (String) -> [String: String]? = { _ in nil }
        /// Who a Source is (an agent by its session, the person as You), and where it works.
        var whoOf: ([String: Any]?) -> (who: String, place: String?) = { s in (s?["kind"] as? String == "person" || s == nil ? "You" : "An agent", nil) }
        /// Draw the window again (an answer the panel waited for came).
        var redraw: () -> Void = {}
        /// What a drive card says of its pane and who asks (cardCtx.drive).
        var driveFacts: ([String: Any]) -> DriveFacts? = { _ in nil }
        /// New project from a folder (NewProjectPage.swift).
        var newProject: (NewProjectPage.From) -> Void = { _ in }
    }

    var host: Host?
    private let head = Flipped()
    private let body = StackScroll(spacing: 12, insets: NSEdgeInsets(top: 14, left: 14, bottom: 16, right: 14))
    private var signature = ""
    /// Each card's own state (busy, its error, a draft, editing) and the card built for it.
    private var cardUI: [String: CardUI] = [:]
    private var cardViews: [String: CheckpointCard] = [:]
    /// The card on show, for the self-test and the number keys.
    private(set) var shownCard: CheckpointCard?
    /// What it shows, for the self-test: session, project, shell, none.
    private(set) var shows = "none"
    private(set) var key = ""
    private(set) var buttons: [String: RButton] = [:]
    private(set) var pictureView: NSImageView?
    /// The latest picture drawn last, by project: kept on show while a new one is read.
    private var shownPicture: [String: NSImage] = [:]

    init() {
        super.init(fill: "sheet", ring: "sheet-ring", radius: 11)
        layer?.masksToBounds = true
        addSubview(head)
        addSubview(body)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Session panel")
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        head.frame = NSRect(x: 0, y: 0, width: bounds.width, height: 40)
        body.frame = NSRect(x: 0, y: 40, width: bounds.width, height: max(0, bounds.height - 40))
    }

    // MARK: the head (.p-h)

    private func setHead(_ name: String, tag: String?, machine: String?, pinKey: String?, setupKey: String? = nil) {
        head.subviews.forEach { $0.removeFromSuperview() }
        let line = Box(fill: "sep")
        line.frame = NSRect(x: 0, y: 39, width: 4000, height: 1)
        head.addSubview(line)
        // The name gives up its room first; the machine and the chip stay whole (.p-h .n flex 1).
        var items: [NSView?] = [yields(label(name, Fonts.pt(13.5, Fonts.w650)), fill: false)]
        if let m = machine { items.append(hstack([SharedIconsView.machine(), fixedLabel(m, Fonts.pt(11.5, .medium), "tx2")], spacing: 4)) }
        if let tg = tag {
            let chip = tagView(tg)
            if let sk = setupKey {
                // The setup lines on demand: the chip names the assistant they are about.
                let open = setupOpen.contains(sk)
                (chip as? Box)?.fill = open ? "card2" : nil
                let tap = TapBox(radius: 5) { [weak self] in
                    guard let self else { return }
                    if self.setupOpen.contains(sk) { self.setupOpen.remove(sk) } else { self.setupOpen.insert(sk) }
                    self.signature = ""; self.host?.redraw()
                }
                tap.addSubview(chip)
                chip.translatesAutoresizingMaskIntoConstraints = false
                NSLayoutConstraint.activate([chip.leadingAnchor.constraint(equalTo: tap.leadingAnchor), chip.trailingAnchor.constraint(equalTo: tap.trailingAnchor), chip.topAnchor.constraint(equalTo: tap.topAnchor), chip.bottomAnchor.constraint(equalTo: tap.bottomAnchor)])
                tap.toolTip = t("panel.setupTip")
                tap.setAccessibilityLabel(t("panel.setupTip"))
                setupChip = tap
                items.append(tap)
            } else { items.append(chip) }
        }
        items.append(spring())
        if let k = pinKey, let h = host {
            let on = h.pinned(k)
            let b = RButton(on ? t("side.unpin") : t("side.pin"), .icon, small: true, icon: "pin")
            b.on = on
            b.run = { h.togglePin(k) }
            buttons["pin"] = b
            items.append(b)
        }
        let hide = RButton(t("panel.hide"), .icon, icon: "chevron")
        hide.run = { [weak self] in self?.host?.hide() }
        buttons["hide"] = hide
        items.append(hide)
        let s = hstack(items, spacing: 8, insets: NSEdgeInsets(top: 0, left: 16, bottom: 0, right: 8))
        s.frame = NSRect(x: 0, y: 0, width: bounds.width, height: 39)
        s.translatesAutoresizingMaskIntoConstraints = true
        s.autoresizingMask = [.width]
        head.addSubview(s)
    }

    // MARK: drawing

    /// Draws what is in front; nothing when nothing it shows changed.
    func update(state: HubState?, front: String?, pane: (id: String, name: String, cwd: String, command: [String])?, force: Bool = false) {
        let minute = Int(When.now().timeIntervalSince1970 / 60)
        var parts: [Any] = [front ?? "", minute, pane?.id ?? "", pane?.name ?? ""]
        if let st = state, let k = front {
            if let f = st.find(k) {
                var s = f.session.raw
                for x in ["screen", "screenAt", "conversation", "live"] { s[x] = nil }
                var p = f.project.raw
                p["sessions"] = nil
                parts += [s, p, host?.hub.card(of: f.project, f.session) ?? [:], st.threshold, host?.pinned(k) ?? false,
                          host?.setup(f.session.assistant ?? "").map { "\($0.hooks)\($0.skill)\($0.hooksHere)\($0.skillHere)" } ?? "",
                          f.session.pane.flatMap { host?.olderDaemon($0) } ?? "", f.session.sessionId.map { host?.moving($0) ?? false } ?? false]
            } else if k.hasPrefix("project:"), let p = st.project(String(k.dropFirst(8))) {
                var pr = p.raw; pr["sessions"] = nil
                parts.append(pr)
                parts.append(lastConv[p.id].map { ($0.last ?? [:]) as Any } ?? "asking")
            }
        }
        if let id = pane?.id {
            parts.append(host?.inputs(id)?.count ?? -1)
            parts += [lastKnown[id] != nil, host?.paneLabels(id)?["ravenry.session"] ?? "", typedUI[id].map { "\($0.filter)\($0.whole)" } ?? "", pane.map { folderFree($0.cwd, state) } ?? false]
            if front == nil || state?.find(front!) == nil { parts += [host?.report(id) ?? [:], host?.hub.card(pane: id) ?? [:]] }
        }
        parts.append(cardUI.map { "\($0.key)\($0.value.stamp)" }.sorted())
        if let id = loose { parts += [id, host?.hub.card(id: id) ?? [:]] }
        // The JSON itself, never Data's hashValue: that hashes the first 80 bytes only, so a
        // new checkpoint id of the same length (the next card for the session) kept the old signature.
        let sig = (try? JSONSerialization.data(withJSONObject: parts, options: [.sortedKeys, .fragmentsAllowed])).map { String(decoding: $0, as: UTF8.self) } ?? UUID().uuidString
        // A field being typed in keeps its place: drawn again only when its card changed.
        if !force, sig == signature { return }
        // (Its signature is not kept: once the field lets go, the change put off is drawn.
        // Kept, a question that came while the person typed in the card before never showed.)
        if !force, let r = window?.firstResponder as? NSTextView, r.isDescendant(of: self), front == key {
            return
        }
        signature = sig
        key = front ?? ""
        buttons = [:]
        programLines = [:]
        pictureView = nil
        shownCard = nil
        var rows: [NSView] = []
        // A loose checkpoint (a page's run button): its card, until it is answered or something else comes to the front.
        // What is in front: a session or a page, else the tab's pane (a tab's front comes as nil).
        let here = "\(front ?? "")|\(front == nil ? pane?.id ?? "" : "")"
        if loose != nil, looseFront == nil { looseFront = here }
        if loose != nil, here != looseFront { loose = nil; looseFront = nil }
        // From the state, or the daemons' alone while the board has sent nothing (LocalCheckpoints.swift);
        // once answered, how it ended (PANEL-024), until something else comes to the front.
        let looseCp = loose.flatMap { id in host?.hub.card(id: id) }
        if loose != nil, looseCp == nil, host?.hub.checkpoints != nil { loose = nil; looseFront = nil }
        if let c = looseCp {
            shows = "loose"
            setHead(c["project"] as? String ?? t("panel.waitingForYou"), tag: (c["assistant"] as? String).map(assistantName), machine: c["machine"] as? String, pinKey: nil)
            rows = DaemonCheckpoints.isOpen(c) ? [stateLine("you", t("panel.needsSince", ["time": When.clock(c["created_at"] as? String)])), card(c)] : [card(c)]
        } else if let k = front, let f = state?.find(k), let pg = f.session.program {
            // A plain program (SESS-056): its command, Shell, and what it said.
            shows = "program"
            setHead(pg.command ?? f.session.topic ?? f.project.name, tag: ProgramWords.shell, machine: f.session.machine ?? f.project.machine, pinKey: nil)
            rows = programBody(f.project, f.session, pg, key: k, pane: pane)
        } else if let st = state, let k = front, let f = st.find(k) {
            shows = "session"
            // Kept by its pane: when it leaves the board, its tab's panel still says what it was.
            if let pid = f.session.pane, f.session.machine == nil, f.project.machine == nil {
                var pr = f.project.raw; pr["sessions"] = nil
                lastKnown[pid] = (pr, f.session.raw)
            }
            // "Claude Opus 5.5": the assistant and the model it runs (hub/server/models.mjs), the assistant alone before it named one.
            // The setup lines are the hub's rows (GET /api/setup/skills), for any assistant it lists.
            let local = f.session.machine == nil && f.project.machine == nil && Assistants.isKnown(f.session.assistant)
            setHead(f.project.name, tag: f.session.modelTitle ?? f.session.assistant.map(assistantName), machine: f.session.machine ?? f.project.machine, pinKey: k, setupKey: local ? k : nil)
            rows = sessionBody(st, f.project, f.session, key: k, pane: pane)
        } else if let st = state, let k = front, k.hasPrefix("project:"), let p = st.project(String(k.dropFirst(8))) {
            shows = "project"
            setHead(p.name, tag: nil, machine: p.machine, pinKey: nil)
            rows = projectBody(p)
        } else if let k = front, k.hasPrefix("project:"), state != nil {
            // It left the board while in front (renderProject, projectPanel).
            shows = "gone"
            setHead(t("panel.project"), tag: nil, machine: nil, pinKey: nil)
            rows = [para(t("project.gone"), "tx2")]
        } else if let pn = pane, let known = lastKnown[pn.id] {
            // The session that ran in this pane left the board (offBoardPanel).
            shows = "offboard"
            let p = HubProject(known.project), s = HubSession(known.session)
            setHead(p.name, tag: s.assistant.map(assistantName), machine: s.machine ?? p.machine, pinKey: nil)
            rows = offBoardBody(p, s)
            if let h = host { rows.append(whoCanType(pn.id, h.whoCanType(pn.id))) }
            if let typed = typedHere(pn.id) { rows.append(typed) }
        } else if let pn = pane, let kind = newSessionKind(pn) {
            // Started as a session (ravenry.session), before the board lists it (newSessionPanel).
            shows = "new"
            setHead(t("panel.newSession"), tag: kind.isEmpty ? nil : assistantName(kind), machine: nil, pinKey: nil, setupKey: kind.isEmpty ? nil : "new:\(pn.id)")
            rows = newSessionBody(pn, kind: kind)
        } else if let pn = pane {
            shows = "shell"
            setHead(pn.name, tag: host?.ownerOf(pn.id).map { t("lease.ownPane", ["who": $0]) } ?? "Shell", machine: nil, pinKey: nil)
            rows = shellBody(pn)
        } else {
            shows = "none"
            setHead("Session", tag: nil, machine: nil, pinKey: nil)
            rows = [label(t("panel.pick"), Fonts.pt(12), "tx3", lines: 4)]
        }
        body.set(rows)
    }

    /// The assistant's tag as the hub lists it ("Claude"), else the kind with a capital.
    private func assistantName(_ a: String) -> String { Assistants.word(a) ?? a }

    private func tagView(_ s: String) -> NSView {
        let b = assistantChip(s)
        headChip = b
        return b
    }
    /// The head's chip, for the self-test.
    private(set) weak var headChip: NSView?
    /// The chip that opens the setup lines on demand.
    private(set) weak var setupChip: TapBox?

    /// .sec: a card, its head line and its rows.
    private func sec(_ title: String?, right: NSView? = nil, _ rows: [NSView?], ring: String? = nil) -> NSView {
        var items: [NSView?] = []
        if let tt = title { items.append(hstack([label(tt, Fonts.pt(12, Fonts.w650), "tx2"), spring(), right], spacing: 8)) }
        items += rows
        let b = boxed(vstack(items, spacing: 8), fill: "card", ring: ring, radius: 10, insets: NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14))
        return b
    }

    /// para() for a line of Markdown (a goal, a next step, a question): its marks drawn.
    private func para(md s: String, _ color: String = "tx", size: CGFloat = 12.5) -> NSTextField {
        let l = label(md: s, Fonts.pt(size), color, lines: 0, select: true)
        l.preferredMaxLayoutWidth = PanelView.width - 56
        return l
    }

    private func para(_ s: String, _ color: String = "tx", size: CGFloat = 12.5) -> NSTextField {
        let l = label(s, Fonts.pt(size), color, lines: 0, select: true)
        l.preferredMaxLayoutWidth = PanelView.width - 56
        return l
    }

    /// A shell's state line from what its agent reported: Needs you since a
    /// question's time, else "Claude has a question since 14:02", "Claude is
    /// working", "Claude is done with its turn".
    private func reportLine(_ r: [String: Any]?, cp: [String: Any]?) -> NSView? {
        let g: String, text: String
        if let c = cp { g = "you"; text = t("panel.needsSince", ["time": When.clock(c["created_at"] as? String)]) }
        else {
            guard let r, let state = r["state"] as? String else { return nil }
            let who = (r["assistant"] as? String).map(assistantName) ?? t("report.theAgent")
            switch state {
            case "needs_you":
                let kind = (r["need"] as? [String: Any])?["kind"] as? String ?? "other"
                let need = t("report.need.\(["permission", "question", "auth"].contains(kind) ? kind : "other")")
                let since = (r["since"] as? String).map { t("report.since", ["time": When.clock($0)]) } ?? ""
                g = "you"; text = "\(who) \(need)\(since)"
            case "working": g = "work"; text = t("report.working", ["who": who])
            case "idle": g = "idle"; text = t("report.idle", ["who": who])
            default: return nil
            }
        }
        let c = g == "idle" ? "tx2" : g
        let l = label(text, Fonts.pt(12.5, .semibold), c, lines: 3)
        l.preferredMaxLayoutWidth = PanelView.width - 56 - 21
        let v = hstack([Icon("ring-\(g)", c, size: 14), l, spring()], spacing: 7)
        v.alignment = .top
        v.setAccessibilityElement(true)
        v.setAccessibilityLabel(text)
        return v
    }

    /// .st: the state in words and since when.
    private func statusLine(_ p: HubProject, _ s: HubSession, cp: [String: Any]?) -> NSView {
        let g: String
        let text: String
        if let c = cp {
            g = "you"; text = t("panel.needsSince", ["time": When.clock(c["created_at"] as? String)])
        } else {
            g = s.group
            switch g {
            case "you": text = t("panel.needsSince", ["time": When.clock(s.since ?? p.since)])
            case "work": text = t("panel.working")
            case "wait": text = p.waitingOn.map { t("panel.waitingOn", ["who": $0]) } ?? t("panel.waitingOthers")
            default: text = s.since.map { t("panel.idleFor", ["ago": When.ago($0)]) } ?? t("panel.idle")
            }
        }
        let c = g == "idle" ? "tx2" : g
        return hstack([Icon("ring-\(g)", c, size: 14), label(text, Fonts.pt(12.5, .semibold), c)], spacing: 7)
    }

    private func check(_ on: Bool, _ yes: String, _ no: String, fix: NSView? = nil) -> NSView {
        let dot = Box(fill: on ? "ok" : nil, ring: on ? nil : "tx3", radius: 6.5)
        dot.ringWidth = 1.5
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.widthAnchor.constraint(equalToConstant: 13).isActive = true
        dot.heightAnchor.constraint(equalToConstant: 13).isActive = true
        if on {
            let i = Icon("check", "", size: 9)
            i.image = SharedIcons.image("check", color: "win", size: 9)
            dot.addSubview(i)
            i.centerXAnchor.constraint(equalTo: dot.centerXAnchor).isActive = true
            i.centerYAnchor.constraint(equalTo: dot.centerYAnchor).isActive = true
        }
        // Its words wrap rather than cut ("Can't tell you when it waits for you." beside Settings in 304 points).
        var items: [NSView?] = [dot, wrap(on ? yes : no, Fonts.pt(12), "tx2")]
        if !on, let f = fix { items += [spring(), f] }
        else if !on { let l = RButton(t("side.settings"), .link) { [weak self] in self?.host?.openPage("settings", t("side.settings")) }; l.setContentCompressionResistancePriority(.required, for: .horizontal); items.append(l) }
        return hstack(items, spacing: 7)
    }

    // MARK: the setup lines (PANEL-003)

    /// How long a line just turned on stays green before the box fades.
    static let setupFixedShow: TimeInterval = 3
    /// Opened on demand from the head's assistant chip, by session key ("new:" and a pane id before the board lists it).
    private var setupOpen: Set<String> = []
    /// What the panel saw last, by assistant: a line that goes from off to on is "just fixed".
    private var setupSeen: [String: SetupLines] = [:]
    private var setupFixedAt: [String: Date] = [:]
    private var setupFixing: Set<String> = []
    private var setupRows: [String: NSView] = [:]
    private(set) weak var setupBox: NSView?
    private var setupShownOpen = false

    /// The lines to show: one that is off (with its fix), one just turned on (green, 3 s), or both when opened on demand.
    private func setupLines(_ kind: String, _ sl: SetupLines, open: Bool) -> [NSView] {
        if let was = setupSeen[kind] {
            if !was.hooks && sl.hooks { setupFixedAt["\(kind):hooks"] = Date(); fadeSoon(kind, "hooks") }
            if !was.skill && sl.skill { setupFixedAt["\(kind):skill"] = Date(); fadeSoon(kind, "skill") }
        }
        setupSeen[kind] = sl
        setupShownOpen = open
        func recent(_ w: String) -> Bool { setupFixedAt["\(kind):\(w)"].map { Date().timeIntervalSince($0) < Self.setupFixedShow } ?? false }
        setupRows = [:]
        var out: [NSView] = []
        for (w, on, here, yes, no) in [("hooks", sl.hooks, sl.hooksHere, t("panel.alertsOn"), t("panel.alertsOff")), ("skill", sl.skill, sl.skillHere, t("panel.skillOn"), t("panel.skillOff"))]
        where !on || open || recent(w) {
            let id = "\(kind):\(w)"
            var fix: RButton? = nil
            // Turned on in place where the app can; else the line's way is Settings (check's link).
            if !on, here {
                let b = RButton(w == "hooks" ? t("set.setUp") : t("set.install"), small: true) { [weak self] in self?.fixSetup(kind, w) }
                b.isEnabled = !setupFixing.contains(id)
                b.setContentCompressionResistancePriority(.required, for: .horizontal)
                buttons["fix:\(w)"] = b
                fix = b
            }
            let r = check(on, yes, no, fix: fix)
            setupRows[w] = r
            out.append(r)
        }
        return out
    }

    /// The fix in place: the hooks set up, the skill installed, as Settings does (POST /api/setup/hooks, /api/setup/skills).
    private func fixSetup(_ kind: String, _ what: String) {
        let id = "\(kind):\(what)"
        guard !setupFixing.contains(id), let h = host else { return }
        setupFixing.insert(id); signature = ""; h.redraw()
        let rd = AppInstall.shared.hookRavenryd
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        let path = what == "hooks" ? "/api/setup/hooks" : "/api/setup/skills"
        let body: [String: Any] = what == "hooks" ? ["ravenryd": rd, "only": kind] : ["kind": kind, "on": true, "ravenryd": rd, "version": version]
        h.hub.post(path, body) { [weak self] code, j in
            self?.setupFixing.remove(id)
            if code != 200 { h.toast(j["error"] as? String ?? t("set.needsBoard")) }
            SettingsWindow.said(what == "hooks" ? "hooks" : "skills")
            self?.signature = ""; h.redraw()
        }
    }

    /// 3 s after a line turned on: the box fades away (the line alone, when another stays off).
    private func fadeSoon(_ kind: String, _ what: String) {
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.setupFixedShow) { [weak self] in
            guard let self else { return }
            let redraw = { [weak self] in self?.signature = ""; self?.host?.redraw() }
            let sl = self.setupSeen[kind]
            let others = sl.map { what == "hooks" ? !$0.skill : !$0.hooks } ?? false
            if self.setupShownOpen { redraw(); return }
            guard let v = others ? self.setupRows[what] : (self.shows == "new" ? self.setupRows[what] : self.setupBox), v.window != nil else { redraw(); return }
            NSAnimationContext.runAnimationGroup({ c in c.duration = 0.35; v.animator().alphaValue = 0 }, completionHandler: redraw)
        }
    }

    // MARK: a session

    private func sessionBody(_ st: HubState, _ p: HubProject, _ s: HubSession, key: String, pane: (id: String, name: String, cwd: String, command: [String])?) -> [NSView] {
        var out: [NSView] = []
        let cp = st.checkpoint(of: p, s)
        out.append(statusLine(p, s, cp: cp))
        // Where that state came from (SESS-035): its hook events, its screen, or the plan.
        if let r = reasonLine(p, s, width: PanelView.width - 56) { out.append(r) }
        // Its card: the open one, else how the last one ended (PANEL-024).
        let shown = cp ?? host?.hub.card(of: p, s)
        // Open in two terminals, or went on in another: one click puts it in one place.
        if let other = s.alsoOpen ?? s.movedOn {
            let move = RButton(t("move.here"), .primary, small: true) { [weak self] in self?.move(p, s, keep: "ravenry") }
            buttons["move"] = move
            var acts: [NSView?] = [move]
            if s.alsoOpen != nil { let keep = RButton(t("move.keep", ["other": other]), small: true) { [weak self] in self?.move(p, s, keep: "outside") }; buttons["keep"] = keep; acts.append(keep) }
            acts.append(spring())
            out.append(sec(nil, [para(s.alsoOpen != nil ? t("panel.alsoOpen", ["other": other]) : t("panel.wentOn", ["other": other])), hstack(acts, spacing: 8)]))
        } else if s.machine == nil, p.machine == nil, let sid = s.sessionId, let a = s.assistant, let ak = Assistants.prefixed(a), Assistants.can(ak, "resume"),
                  let pid = s.pane, let version = host?.olderDaemon(pid) {
            // On an older daemon that drains for a newer one (an update): its
            // fixes reach the session once it runs on the newest, so one click
            // ends it there and continues the conversation in a new pane of the
            // newest, in this tab's place. Working, it stops what it is doing.
            let busy = host?.moving(sid) ?? false
            let move = RButton(busy ? t("move.moving") : t("move.here"), .primary, small: true) { [weak self] in self?.onMoveNewer?(p, s) }
            move.isEnabled = !busy
            buttons["moveNewer"] = move
            let line = s.group == "work" ? t("panel.olderRavenryBusy", ["version": version, "who": assistantName(ak)])
                : t("panel.olderRavenry", ["version": version])
            out.append(sec(nil, [para(line), hstack([move, spring()], spacing: 8)]))
        }
        // A session in a cmux workspace no project lists (hub board unCardHtml): Add to a project.
        if p.raw["unowned"] as? Bool ?? false { out.append(notInProject(st, p)) }
        // What the first-launch step set up for its assistant, on this machine.
        // Shown only when a line is off (with its fix), just turned on, or opened from the head's chip.
        if s.machine == nil, p.machine == nil, let a = s.assistant, Assistants.isKnown(a), let sl = host?.setup(a), shown == nil || setupOpen.contains(key) {
            let rows = setupLines(a, sl, open: setupOpen.contains(key))
            if !rows.isEmpty {
                let settings = RButton(t("side.settings"), .link) { [weak self] in self?.host?.openPage("settings", t("side.settings")) }
                let b = sec(t("panel.thisSession"), right: setupOpen.contains(key) ? settings : nil, rows)
                setupBox = b
                out.append(b)
            }
        }
        if let c = shown { out.append(card(c)) }
        let w = s.words
        let q = (w["headline"] as? String) ?? (w["question"] as? String) ?? (w["line"] as? String) ?? ""
        let quick = (w["quick"] as? [[String: Any]] ?? []).prefix(6)
        let dialog = w["dialog"] as? [String] ?? []
        if shown == nil, s.group == "you", !q.isEmpty || !dialog.isEmpty || !quick.isEmpty {
            var rows: [NSView?] = [q.isEmpty ? nil : para(md: q, size: 13)]
            if !dialog.isEmpty { let d = label(dialog.joined(separator: "\n"), Fonts.mono(11.5), "tx2", lines: 0); d.preferredMaxLayoutWidth = PanelView.width - 56; rows.append(d) }
            if !quick.isEmpty {
                let bs = quick.map { o -> NSView in
                    let l = o["label"] as? String ?? ""
                    let choice = o["choice"] as? NSNumber
                    // A suggested answer types its text ("B", "Keep A"); the label is the button's words ("B: the app").
                    let say = o["text"] as? String ?? l
                    let b = RButton(l, small: true) { [weak self] in self?.send(p, s, say, choice) }
                    buttons["quick:\(l)"] = b
                    return b
                }
                rows.append(flow(bs))
            }
            out.append(sec(nil, rows, ring: "you"))
        }
        // Reply: the person's own words typed into it from here, with files (SESS-026, SESS-045), only where its terminal
        // is not this window's: a session in iTerm2, Terminal or cmux, or one shown read only. A session in a pane this
        // window draws (it knows the pane) is typed into in its terminal, where a file dropped pastes its path.
        if s.machine == nil, p.machine == nil, s.raw["live"] as? Bool == true, ReplyBox.canType(st, s), let h = host, s.pane.flatMap(h.paneName) == nil {
            out.append(ReplyBox(key: key, project: p, session: s, hub: h.hub, width: PanelView.width - 28) { [weak self] in self?.host?.toast($0) })
        }
        if s.pane != nil, s.machine == nil, p.machine == nil, let h = host {
            out += h.extras(p, s, { [weak self] rows in self?.sec(nil, rows, ring: "you") ?? NSView() }, { [weak self] t0, r, rows in self?.sec(t0, right: r, rows) ?? NSView() })
        }
        if let c = s.ctx {
            let th = st.threshold
            let on = st.handoffEnabled
            let pct = max(0, min(100, c.pct))
            let bar = Box(fill: "card2", radius: 2.5)
            bar.translatesAutoresizingMaskIntoConstraints = false
            bar.heightAnchor.constraint(equalToConstant: 5).isActive = true
            let f = Box(fill: on && pct >= th ? "you" : "tx2", radius: 2.5)
            bar.addSubview(f)
            // The orange tick follows the Hand-off setting's line, and goes when hand-off is off (hub board app.js renderSheet).
            let mk: Box? = on ? Box(fill: "you", radius: 1) : nil
            if let mk { mk.toolTip = t("panel.handOffLine", ["pct": "\(Int(th))"]); bar.addSubview(mk) }
            handOffTick = mk
            bar.postsFrameChangedNotifications = true
            let place = { [weak bar, weak f, weak mk] in
                guard let b = bar else { return }
                f?.frame = NSRect(x: 0, y: 0, width: b.bounds.width * pct / 100, height: 5)
                mk?.frame = NSRect(x: b.bounds.width * th / 100 - 1, y: -3, width: 2, height: 11)
            }
            NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: bar, queue: .main) { _ in place() }
            // Asked for: it waits for a clean point (the hub board's "Hand-off queued").
            let queued = s.handoffQueued
            let hand = RButton(queued ? t("panel.handOffQueued") : t("session.handOffNow"), small: true) { [weak self] in self?.handOff(p, s) }
            hand.isEnabled = !queued
            if queued { hand.toolTip = t("panel.handOffQueuedTip") }
            buttons["handoff"] = hand
            // A written hand-off whose fresh session waits for the person, or did not start (SESS-044).
            let fresh = FreshStart.state(s)
            var startB: NSView? = fresh.offer ? RButton(t("panel.startFresh"), .primary, small: true) { [weak self] in FreshStart.start(self?.host?.hub, p, s) { self?.host?.toast($0) } } : nil
            if let b = startB as? RButton { b.toolTip = t("panel.startFreshTip"); buttons["startFresh"] = b }
            // Its start failed (SESS-052): Retry, the same start by hand, where Start fresh session goes, and
            // Copy command under the line that says why (one row would be wider than the panel).
            var copyB: RButton? = nil
            if fresh.retry {
                let retry = RButton(t("panel.retryFresh"), .primary, small: true) { [weak self] in FreshStart.start(self?.host?.hub, p, s) { self?.host?.toast($0) } }
                retry.toolTip = t("panel.retryFreshTip")
                buttons["retryFresh"] = retry
                startB = retry
                if let cmd = fresh.copy {
                    let copy = RButton(t("panel.copyFresh"), small: true) { [weak self] in FreshStart.copy(cmd) { self?.host?.toast($0) } }
                    copy.toolTip = t("panel.copyFreshTip")
                    buttons["copyFresh"] = copy
                    copyB = copy
                }
            }
            // The line itself is the way to where it is set: Settings, Hand-off.
            let line = RButton(on ? t("panel.handsOffAt", ["pct": "\(Int(th))"]) : t("panel.handOffOff"), .link) { [weak self] in self?.host?.openPage("settings:handoff", t("side.settings")) }
            line.titleSize = 12
            line.toolTip = t("panel.handOffChangeTip")
            line.setAccessibilityHelp(t("panel.handOffChangeTip"))
            buttons["handoffSettings"] = line
            out.append(sec(t("panel.context"), right: label(t("panel.tokensOf", ["used": When.tokens(c.tokens), "window": When.tokens(c.window)]), Fonts.pt(12, .semibold).withTabularDigits),
                           [bar, hstack([line, spring(), startB ?? (fresh.line == nil ? hand : nil)], spacing: 6), fresh.line.map { para($0, "tx2", size: 12) }, fresh.asks.map { para($0, "tx3", size: 11.5) }, copyB.map { hstack([$0, spring()]) }]))
        }
        // Over the terminal on a narrow window, a card keeps the panel short.
        if cp != nil, superview.map({ _ in isOverlay }) ?? false { return out }
        if let ho = p.timeline.first(where: { $0["from"] as? String == "brief" }) {
            // The hand-off card (2026-11-12): the hub's line for the entry, at most two lines cut at a word (TwoLines.swift,
            // an older hub's whole entry too); "›" after the time, and a press opens the brief at its Hand-off.
            let words = TwoLines.cut(ho["text"] as? String ?? "", font: Fonts.pt(12.5), width: PanelView.width - 56)
            let line = words.isEmpty ? nil : label(words, Fonts.pt(12.5), "tx", lines: 2)
            line?.preferredMaxLayoutWidth = PanelView.width - 56
            let head = hstack([label(t("panel.handOff"), Fonts.pt(12, Fonts.w650), "tx2"), spring(),
                               (ho["when"] as? String).map { label($0, Fonts.pt(12, .medium), "tx3") }, label("›", Fonts.pt(13), "tx3")], spacing: 8)
            let c = RavenryMac.card(vstack([head, line, p.handoffRecent ? check(true, t("panel.readBySession"), "") : nil], spacing: 8),
                         radius: 10, insets: NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14)) { [weak self] in
                self?.host?.openPage("brief:\(p.id)#handoff", t("panel.brief"))
            }
            c.identifier = NSUserInterfaceItemIdentifier("handoff-card")
            c.toolTip = t("panel.handOffOpenTip")
            out.append(c)
        }
        if let pics = p.brief?["pictures"] as? [[String: Any]], let pic = pics.filter({ $0["url"] is String }).last {
            let n = pics.filter { $0["url"] is String }.count
            let gallery = RButton(n > 1 ? t("panel.galleryCount", ["n": "\(n)"]) : t("panel.gallery"), .link) { [weak self] in self?.host?.openPage("gallery:\(p.id)", t("panel.gallery")) }
            let img = PictureThumb()
            img.toolTip = t("panel.seeLarge")
            img.setAccessibilityLabel(pic["alt"] as? String ?? t("panel.seeLarge"))
            img.onClick = { [weak self] in self?.host?.openPicture(p, pic) }
            pictureView = img
            // Read once (HubClient.picture): drawn again at once on every redraw. A new picture (a new URL)
            // is read, the one drawn before staying until it comes.
            if let u = pic["url"] as? String {
                let pid = p.id
                if let i = host?.hub.picture(u, { [weak self, weak img] i in img?.image = i; self?.shownPicture[pid] = i }) { img.image = i; shownPicture[pid] = i }
                else { img.image = shownPicture[pid] }
            }
            out.append(sec(t("panel.latestPicture"), right: gallery, [img, (pic["alt"] as? String).map { label($0, Fonts.pt(12), "tx3", lines: 2) }]))
        }
        if let b = p.brief, (b["goal"] as? String) != nil || (b["next"] as? String) != nil {
            let n = b["nextParts"] as? [String: Any] ?? [:]
            let items = n["items"] as? [String] ?? []
            let older = (n["older"] as? NSNumber)?.intValue ?? 0
            var rows: [NSView?] = []
            if let g = b["goal"] as? String {
                rows.append(label(t("panel.goal"), Fonts.pt(11, .semibold), "tx3"))
                let gl = label(md: g, Fonts.pt(12.5))
                gl.toolTip = InlineMd.plain(g)
                rows.append(gl)
            }
            if !items.isEmpty {
                rows.append(label(t("panel.next"), Fonts.pt(11, .semibold), "tx3"))
                for x in items { let l = label(md: "•  " + x, Fonts.pt(12.5)); l.toolTip = InlineMd.plain(x); rows.append(l) }
            }
            let open = RButton(t("panel.openBrief"), .link) { [weak self] in self?.host?.openPage("brief:\(p.id)", t("panel.brief")) }
            buttons["brief"] = open
            rows.append(hstack([open, older > 0 ? label(t(older == 1 ? "panel.olderEntry" : "panel.olderEntries", ["n": "\(older)"]), Fonts.pt(12), "tx3") : nil, spring()], spacing: 0))
            out.append(sec(t("panel.brief"), rows))
        }
        out.append(planCard(p))
        if let pn = pane, let typed = typedHere(pn.id) { out.append(typed) }
        return out
    }

    var isOverlay = false
    /// A checkpoint shown on its own (a page's run button), by id, and what was in front when it came.
    var loose: String? { didSet { if loose != oldValue { signature = "" } } }
    private var looseFront: String?

    /// "Not in a project": no brief, plan or notes; Add to a project joins its workspace to the one picked (POST /api/project/add-workspace).
    private func notInProject(_ st: HubState, _ p: HubProject) -> NSView {
        let list = st.projects.filter { !($0.raw["unowned"] as? Bool ?? false) && !($0.raw["loose"] as? Bool ?? false) }.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
        let add = RButton(t("panel.addToProject"), .primary, small: true)
        add.isEnabled = !list.isEmpty
        if list.isEmpty { add.toolTip = t("panel.noProjectYet") }
        add.run = { [weak self, weak add] in
            guard let self, let add else { return }
            let m = NSMenu()
            m.autoenablesItems = false
            let head = NSMenuItem(title: t("panel.addTo", ["name": p.name]), action: nil, keyEquivalent: "")
            head.isEnabled = false
            m.addItem(head)
            for x in list {
                m.addItem(MenuAction.item(x.name) { [weak self] in self?.addToProject(p, x) })
            }
            m.popUp(positioning: nil, at: NSPoint(x: 0, y: add.bounds.height + 4), in: add)
        }
        buttons["addToProject"] = add
        // New project from this folder: the form with its folder and the session's assistant; the workspace joins the new project (SESS-022).
        let ws = (p.raw["workspaces"] as? [String])?.first
        let newB = RButton(t("panel.newFromFolder"), small: true) { [weak self] in
            guard let f = p.folder else { return }
            self?.host?.newProject(NewProjectPage.From(name: p.name, folder: f, folderShort: p.folderShort ?? f, workspaceId: ws, assistant: p.mainSession?.assistant))
        }
        newB.isEnabled = p.folder != nil
        if p.folder == nil { newB.toolTip = t("panel.noFolderOwn") }
        buttons["newProject"] = newB
        return sec(t("panel.notInProject"), [para(t("panel.notInProjectText"), "tx2", size: 12), flow([add, newB])])
    }

    func addToProject(_ from: HubProject, _ to: HubProject) {
        host?.hub.post("/api/project/add-workspace", ["from": from.id, "projectId": to.id]) { [weak self] code, j in
            self?.host?.toast(code == 200 ? t("panel.addedTo", ["name": from.name, "project": j["project"] as? String ?? to.name]) : (j["error"] as? String ?? "\(code)"))
        }
    }
    /// The context bar's hand-off tick, nil when hand-off is off (for the self-test).
    private(set) weak var handOffTick: NSView?

    /// Buttons that wrap to the next line when the row is full (.qa).
    private func flow(_ views: [NSView]) -> NSView {
        var lines: [NSView] = []
        var cur: [NSView] = []
        var w: CGFloat = 0
        let max = PanelView.width - 56
        for v in views {
            let vw = v.intrinsicContentSize.width
            if !cur.isEmpty && w + 6 + vw > max { lines.append(hstack(cur + [spring()], spacing: 6)); cur = []; w = 0 }
            cur.append(v); w += (cur.count > 1 ? 6 : 0) + vw
        }
        if !cur.isEmpty { lines.append(hstack(cur + [spring()], spacing: 6)) }
        return vstack(lines, spacing: 6)
    }

    // MARK: Typed here (pane.inputs)

    /// Typed here's filter (All, Agents, You) and whether the whole log shows, by pane.
    private var typedUI: [String: (filter: Int, whole: Bool)] = [:]
    private(set) var typedFilter: NSSegmentedControl?

    private func typedHere(_ pane: String) -> NSView? {
        guard let recs = host?.inputs(pane) else { return nil }
        let u = typedUI[pane] ?? (0, false)
        let all = recs.filter { PanelView.parts($0) != nil }
        let list = all.filter { r in
            let person = (r["source"] as? [String: Any])?["kind"] as? String == "person"
            return u.filter == 0 || (u.filter == 2) == person
        }.reversed()
        let shown = u.whole ? Array(list) : Array(list.prefix(4))
        let seg = NSSegmentedControl(labels: [t("panel.typedAll"), t("panel.typedAgents"), t("panel.typedYou")], trackingMode: .selectOne, target: PopTarget.shared, action: #selector(PopTarget.segmented(_:)))
        seg.controlSize = .small
        seg.font = Fonts.pt(11)
        seg.selectedSegment = u.filter
        seg.setAccessibilityLabel(t("panel.typedFilter"))
        PopTarget.shared.run[ObjectIdentifier(seg)] = { [weak self, weak seg] in
            guard let self, let seg else { return }
            self.typedUI[pane] = (seg.selectedSegment, u.whole)
            self.signature = ""; self.host?.redraw()
        }
        typedFilter = seg
        var rows: [NSView?] = []
        if shown.isEmpty { rows.append(label(all.isEmpty ? t("page.nothingTyped") : t("panel.typedNoneFrom"), Fonts.pt(12), "tx3")) }
        for r in shown { rows.append(typedRecord(r)) }
        if list.count > 4 {
            let b = RButton(u.whole ? t("panel.typedFew") : t("panel.typedWhole"), .link) { [weak self] in
                guard let self else { return }
                self.typedUI[pane] = (u.filter, !u.whole)
                self.signature = ""; self.host?.redraw()
            }
            buttons["typedWhole"] = b
            rows.append(hstack([b, spring()], spacing: 0))
        }
        return sec(t("panel.typedHere"), right: seg, rows)
    }

    /// A record: when, who (an agent's session as a chip), what was typed with Enter as a key, and a note.
    private func typedRecord(_ r: [String: Any]) -> NSView {
        let src = r["source"] as? [String: Any]
        let person = src?["kind"] as? String == "person"
        let w: (who: String, place: String?) = person ? (t("project.you"), nil) : (host?.whoOf(src) ?? ("An agent", nil))
        let time = fixedLabel(When.clock(r["at"] as? String), Fonts.pt(11.5).withTabularDigits, "tx3")
        var head: [NSView?] = [time, fixedLabel(w.who, Fonts.pt(12, .semibold), person ? "tx" : "work")]
        if let pl = w.place { let c = assistantChip(pl); (c.subviews.first as? NSTextField)?.lineBreakMode = .byTruncatingTail; c.setContentCompressionResistancePriority(.init(240), for: .horizontal); c.subviews.first?.setContentCompressionResistancePriority(.init(240), for: .horizontal); head.append(c) }
        head.append(spring())
        // The words, Enter drawn as a key between lines.
        let a = NSMutableAttributedString(attributedString: PanelView.keysText(PanelView.parts(r) ?? []))
        if r["truncated"] as? Bool == true { a.append(NSAttributedString(string: "...", attributes: [.font: Fonts.mono(11.5), .foregroundColor: Design.color("tx3")])) }
        let tx = label("", Fonts.mono(11.5), "tx2", lines: 3, select: true)
        tx.attributedStringValue = a
        tx.preferredMaxLayoutWidth = PanelView.width - 56
        var col: [NSView?] = [hstack(head, spacing: 6), tx]
        if person, let lh = r["lease_holder"] as? [String: Any] { col.append(label(t("panel.whileHad", ["who": host?.whoOf(lh).who ?? "An agent"]), Fonts.pt(11.5), "tx3")) }
        return vstack(col, spacing: 3)
    }

    /// What a record shows as text and keys (panepanel.ts shownParts); nil when it shows nothing.
    static func parts(_ r: [String: Any]) -> [(text: String, key: Bool)]? {
        guard let s = shown(r) else { return nil }
        // An older daemon sends no `shown`: its log text, keys as <Enter>.
        if r["shown"] == nil { return keyParts(s) }
        return s.components(separatedBy: "\n").enumerated().flatMap { i, l -> [(text: String, key: Bool)] in (i > 0 ? [("Enter", true)] : []) + (l.isEmpty ? [] : [(l, false)]) }
    }

    /// Text and named keys in order (hub/public/keys.mjs keyParts): "<Ctrl+C>npm run dev<Enter>"; a raw line end is Enter.
    static func keyParts(_ text: String) -> [(text: String, key: Bool)] {
        let t = text.replacingOccurrences(of: "\r\n", with: "<Enter>").replacingOccurrences(of: "\r", with: "<Enter>").replacingOccurrences(of: "\n", with: "<Enter>")
            .replacingOccurrences(of: "\t", with: "<Tab>").replacingOccurrences(of: "\u{1b}", with: "<Esc>")
        var out: [(text: String, key: Bool)] = []
        let re = try! NSRegularExpression(pattern: "<([A-Za-z0-9+/]+)>")
        let ns = t as NSString
        var at = 0
        for m in re.matches(in: t, range: NSRange(location: 0, length: ns.length)) {
            if m.range.location > at { out.append((ns.substring(with: NSRange(location: at, length: m.range.location - at)), false)) }
            out.append((ns.substring(with: m.range(at: 1)).replacingOccurrences(of: "+", with: " "), true))
            at = m.range.location + m.range.length
        }
        if at < ns.length { out.append((ns.substring(from: at), false)) }
        return out
    }

    /// Text and keys as one line: the keys as chips.
    static func keysText(_ parts: [(text: String, key: Bool)], font: NSFont = Fonts.mono(11.5), color: String = "tx2") -> NSAttributedString {
        let a = NSMutableAttributedString()
        for p in parts {
            if p.key {
                let k = NSTextAttachment()
                k.image = keyImage(p.text)
                k.bounds = NSRect(x: 0, y: -3, width: k.image!.size.width, height: k.image!.size.height)
                a.append(NSAttributedString(string: " ", attributes: [.font: font]))
                a.append(NSAttributedString(attachment: k))
                a.append(NSAttributedString(string: " ", attributes: [.font: font]))
            } else {
                a.append(NSAttributedString(string: p.text, attributes: [.font: font, .foregroundColor: Design.color(color)]))
            }
        }
        return a
    }

    /// A key drawn as a small chip (.key).
    static func keyImage(_ s: String) -> NSImage {
        let f = Fonts.pt(10, .semibold)
        let sz = (s as NSString).size(withAttributes: [.font: f])
        let w = ceil(sz.width) + 10, h: CGFloat = 15
        return NSImage(size: NSSize(width: w, height: h), flipped: false) { r in
            let p = NSBezierPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), xRadius: 3.5, yRadius: 3.5)
            Design.color("card2").setFill(); p.fill()
            Design.color("sep").setStroke(); p.lineWidth = 1; p.stroke()
            (s as NSString).draw(at: NSPoint(x: 5, y: (h - sz.height) / 2), withAttributes: [.font: f, .foregroundColor: Design.color("tx2")])
            return true
        }
    }

    /// What Typed here shows of a record: the daemon's `shown`, the lines
    /// entered with no keys that type nothing; nil when there is nothing
    /// to show (a menu answered with arrows, a lone Esc). An older daemon
    /// sends no `shown`: its text, without the focus reports it logged.
    static func shown(_ r: [String: Any]) -> String? {
        let text = r["text"] as? String ?? "", masked = r["masked"] as? Bool ?? false
        if masked && text.isEmpty && (r["shown"] as? String ?? "").isEmpty { return "Hidden: a password or a secret" }
        guard let s = r["shown"] as? String else {
            let t = text.replacingOccurrences(of: "<Esc>[I", with: "").replacingOccurrences(of: "<Esc>[O", with: "")
            return t.isEmpty ? nil : t
        }
        return s.isEmpty ? nil : s
    }

    // MARK: a plain program (SESS-056)

    /// Its state in words (blocked, working, done, failed), what it said and when, its question
    /// with a box that types into its pane, then where it runs and who can type there.
    private func programBody(_ p: HubProject, _ s: HubSession, _ pg: ProgramInfo, key: String, pane: (id: String, name: String, cwd: String, command: [String])?) -> [NSView] {
        var out: [NSView] = []
        let cmd = pg.command ?? s.topic ?? p.name
        let g = ["blocked": "you", "working": "work", "failed": "bad", "done": "ok"][pg.state] ?? "idle"
        let c = g == "idle" ? "tx2" : g
        let l = label(ProgramWords.state(pg, command: cmd), Fonts.pt(12.5, .semibold), c, lines: 3)
        l.preferredMaxLayoutWidth = PanelView.width - 56 - 21
        let ring = Icon(["you", "work"].contains(g) ? "ring-\(g)" : "ring-idle", c, size: 14)
        let line = hstack([ring, l, spring()], spacing: 7)
        line.alignment = .top
        line.setAccessibilityElement(true)
        line.setAccessibilityLabel(l.stringValue)
        programLines["state"] = l.stringValue
        out.append(line)
        let indent = { (v: NSView) -> NSView in hstack([v], spacing: 0, insets: NSEdgeInsets(top: 0, left: 21, bottom: 0, right: 0)) }
        if pg.state == "blocked" {
            let said = label(ProgramWords.said(pg.since), Fonts.pt(12), "tx3", lines: 2)
            programLines["said"] = said.stringValue
            out.append(said)
            if let m = pg.message {
                let q = boxed(para(m, size: 13), fill: "card", ring: "you", radius: 10, insets: NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14))
                q.setAccessibilityLabel(m)
                programLines["message"] = m
                out.append(q)
            }
            if let h = host {
                let b = ProgramReplyBox(key: key, project: p, session: s, hub: h.hub, width: PanelView.width - 28) { [weak self] in self?.host?.toast($0) }
                programReply = b
                out.append(b)
            }
        } else if let m = pg.message {
            let t0 = para(m, "tx2", size: 12)
            programLines["message"] = m
            out.append(indent(t0))
        }
        if let pid = s.pane ?? pg.pane, let o = host?.opened(pid) {
            out.append(hstack([Icon("shell", "tx3", size: 13), label(o, Fonts.pt(12), "tx3", lines: 2)], spacing: 7, insets: NSEdgeInsets(top: 0, left: 4, bottom: 0, right: 0)))
        }
        // Where it runs, what, and the project it counts in.
        let folder = pg.folder ?? pane.map { tilde($0.cwd) } ?? p.folderShort ?? ""
        var rows: [NSView?] = []
        if !folder.isEmpty { rows.append(kv(t("panel.folder"), folder, mono: true)) }
        rows.append(kv(t("panel.runs"), cmd, mono: true))
        if !(p.raw["loose"] as? Bool ?? false) { rows.append(kv(t("panel.project"), p.name, mono: true)) }
        out.append(sec(nil, rows))
        if let pn = pane, pn.id == (s.pane ?? pg.pane), let h = host { out.append(whoCanType(pn.id, h.whoCanType(pn.id))) }
        return out
    }
    /// What the program's panel says, for the self-test: state, said, message.
    private(set) var programLines: [String: String] = [:]
    private(set) weak var programReply: ProgramReplyBox?

    // MARK: a project, a shell

    /// A project's last conversation (GET /api/project/last), by project: nil while asked.
    private var lastConv: [String: (at: Date, last: [String: Any]?)] = [:]
    private var lastAsking = Set<String>()
    /// The sessions seen in this window's panes, by pane: what its panel says once it leaves the board.
    private var lastKnown: [String: (project: [String: Any], session: [String: Any])] = [:]

    private func readLast(_ id: String) {
        guard !lastAsking.contains(id), Date().timeIntervalSince(lastConv[id]?.at ?? .distantPast) > 15, let h = host else { return }
        lastAsking.insert(id)
        h.hub.get("/api/project/last?projectId=\(id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? id)") { [weak self] code, j in
            guard let self else { return }
            self.lastAsking.remove(id)
            self.lastConv[id] = (Date(), code == 200 ? j["last"] as? [String: Any] : self.lastConv[id]?.last)
            if self.key == "project:\(id)" { self.signature = ""; self.host?.redraw() }
        }
    }

    func stateLine(_ g: String, _ text: String) -> NSView {
        let c = g == "idle" ? "tx2" : g
        let l = label(text, Fonts.pt(12.5, .semibold), c, lines: 3)
        l.preferredMaxLayoutWidth = PanelView.width - 56 - 21
        let v = hstack([Icon("ring-\(g)", c, size: 14), l, spring()], spacing: 7)
        v.alignment = .top
        return v
    }

    /// A small grey caption over its words (.sec p.t3.small then p).
    private func titled(_ title: String, _ text: String) -> [NSView?] {
        [label(title, Fonts.pt(11, .semibold), "tx3"), para(md: text)]
    }

    /// A project no session runs in (projectPanel): its state, goal, next, last conversation and folder.
    private func projectBody(_ p: HubProject) -> [NSView] {
        var out: [NSView] = []
        let st = projectFacts(p)
        out.append(stateLine(st.group, st.text))
        if let g = p.brief?["goal"] as? String { out.append(sec(nil, titled(t("panel.goal"), g))) }
        if let n = p.brief?["next"] as? String, !n.isEmpty { out.append(sec(nil, titled(t("panel.next"), n))) }
        readLast(p.id)
        if let c = lastConv[p.id] {
            if let l = c.last {
                let who = Assistants.short(l["assistant"] as? String)
                out.append(sec(t("panel.lastConversation"), [para(l["title"] as? String ?? ""),
                                                             label(t("panel.stopped", ["who": who, "when": When.stopped(l["stoppedAt"] as? String)]), Fonts.pt(12), "tx3")]))
            } else { out.append(sec(nil, [label(t("panel.noConversation"), Fonts.pt(12), "tx3", lines: 2)])) }
        }
        // No brief yet: write one here (BRIEF-006); its plan, at a gate too (PANEL-008).
        if p.brief == nil, p.folder != nil, p.machine == nil {
            let b = RButton(t("panel.writeBrief"), small: true) { [weak self] in self?.host?.openPage("writebrief:\(p.id)", t("panel.writeBrief")) }
            buttons["writeBrief"] = b
            out.append(sec(t("panel.brief"), [para(t("panel.noBrief"), "tx2", size: 12), hstack([b, spring()], spacing: 0)]))
        }
        if p.brief != nil || p.plan != nil { out.append(planCard(p)) }
        if let f = p.folderShort { out.append(sec(nil, [label(f, Fonts.pt(12), "tx3")])) }
        return out
    }

    /// The gate choice the panel waits on the hub for, by project.
    private var planBusy: String?
    /// Plan: Running, At a gate or None running, with Open the plan or New
    /// plan (PANEL-008). At a gate, its question and choices, answered here
    /// (POST /api/plan/answer); a gate the file alone passed is decided on the plan.
    private func planCard(_ p: HubProject) -> NSView {
        let plan = p.plan
        let planB = RButton(plan != nil ? t("panel.openPlan") : t("panel.newPlan"), small: true) { [weak self] in
            self?.host?.openPage(plan != nil ? "plan:\(p.id)" : "newplan:\(p.id)", plan != nil ? t("panel.plan") : t("panel.newPlan"))
        }
        buttons["plan"] = planB
        var rows: [NSView?] = [plan.map { para(($0["title"] as? String) ?? ($0["name"] as? String) ?? t("panel.planRunningLine")) } ?? para(t("panel.planBlurb"), "tx2", size: 12)]
        let gate = plan != nil ? p.raw["planGate"] as? [String: Any] : nil
        if let g = gate {
            if g["fileOnly"] is String { rows.append(para(t("panel.gateFile"), "you", size: 12)) }
            else {
                rows.append(para(md: g["question"] as? String ?? g["text"] as? String ?? ""))
                let choices = (g["choices"] as? [String] ?? []).enumerated().map { i, c -> NSView in
                    let b = RButton(c, i == 0 ? .primary : .normal, small: true) { [weak self] in self?.answerGate(p, c) }
                    b.isEnabled = planBusy == nil
                    buttons["gate\(i)"] = b
                    return b
                }
                if !choices.isEmpty { rows.append(flow(choices)) }
            }
        }
        rows.append(hstack([planB, spring()], spacing: 0))
        return sec(t("panel.plan"), right: label(plan == nil ? t("panel.planNone") : p.planGate ? t("panel.planGate") : t("panel.planRunning"), Fonts.pt(12, .medium), "tx3"), rows, ring: gate != nil ? "you" : nil)
    }

    /// A gate's choice pressed in the panel: written in the brief by the hub, which tells the session.
    private func answerGate(_ p: HubProject, _ choice: String) {
        guard planBusy == nil, let h = host else { return }
        planBusy = p.id
        signature = ""
        h.redraw()
        h.hub.post("/api/plan/answer", ["projectId": p.id, "choice": choice]) { [weak self] code, j in
            guard let self else { return }
            self.planBusy = nil
            self.signature = ""
            h.toast(code == 200 ? t("plan.sentChoice", ["choice": choice]) : j["error"] as? String ?? t("page.didNotWork"))
            h.redraw()
        }
    }

    /// A session that ran in this pane and left the board (offBoardPanel): not running, its topic and folder, its last turn.
    private func offBoardBody(_ p: HubProject, _ s: HubSession) -> [NSView] {
        var out: [NSView] = []
        let whereName = s.termName ?? (s.term == "ravenry" ? "Ravenry" : nil)
        out.append(stateLine("idle", whereName.map { $0 == "Ravenry" ? t("panel.notRunning") : t("panel.notRunningIn", ["where": $0]) } ?? t("panel.notRunning")))
        out.append(sec(nil, [para(s.topic ?? p.name), p.folderShort.map { label($0, Fonts.pt(12), "tx3") }]))
        if let last = s.conversation.last {
            var rows: [NSView?] = []
            if let a = last["ask"] as? String { rows.append(para(t("panel.youSaid", ["text": a.count > 140 ? String(a.prefix(139)) + "..." : a]), "tx3", size: 12)) }
            if let x = last["text"] as? String { rows.append(para(x.count > 240 ? String(x.prefix(239)) + "..." : x)) }
            if !rows.isEmpty { out.append(sec(nil, rows)) }
        }
        let canMove = s.sessionId != nil && Assistants.can(Assistants.prefixed(s.assistant ?? "claude"), "resume") && !s.surfaceId.hasPrefix("ravenry:")
        if canMove {
            let b = RButton(t("move.here"), .primary, small: true) { [weak self] in self?.move(p, s, keep: "ravenry") }
            buttons["move"] = b
            out.append(sec(nil, [para(t("panel.moveOffBoard"), "tx3", size: 12), hstack([b, spring()], spacing: 0)]))
        }
        return out
    }

    /// The assistant a pane was started for as a session ("" when the label names none), else nil.
    private func newSessionKind(_ pn: (id: String, name: String, cwd: String, command: [String])) -> String? {
        guard let l = host?.paneLabels(pn.id), let v = l["ravenry.session"] ?? l["ravenry.agent"] else { return nil }
        return Assistants.list.first { v.contains($0.id) }?.id ?? ""
    }

    private func newSessionBody(_ pn: (id: String, name: String, cwd: String, command: [String]), kind: String) -> [NSView] {
        var rows: [NSView?] = [kv(t("panel.folder"), tilde(pn.cwd), mono: true)]
        if !kind.isEmpty { rows.append(kv(t("panel.assistant"), Assistants.name(kind))) }
        if !kind.isEmpty, let sl = host?.setup(kind) { rows += setupLines(kind, sl, open: setupOpen.contains("new:\(pn.id)")) }
        var out: [NSView] = [stateLine("idle", t("panel.readyFirst")), sec(t("panel.thisSession"), rows)]
        if let typed = typedHere(pn.id) { out.append(typed) }
        return out
    }

    /// A key and its value on a line (.kv).
    private func kv(_ k: String, _ v: String, mono: Bool = false) -> NSView {
        let kl = fixedLabel(k, Fonts.pt(12), "tx3")
        kl.widthAnchor.constraint(greaterThanOrEqualToConstant: 58).isActive = true
        let vl = yields(label(v, mono ? Fonts.mono(11.5) : Fonts.pt(12), "tx2"))
        vl.lineBreakMode = .byTruncatingMiddle
        return hstack([kl, vl], spacing: 8)
    }

    private func tilde(_ p: String) -> String {
        let h = NSHomeDirectory()
        return p == h ? "~" : p.hasPrefix(h + "/") ? "~" + p.dropFirst(h.count) : p
    }

    /// A shell's folder that no project on the board uses, and that can hold one (not home, not the projects root): it offers New project from this folder.
    private func folderFree(_ cwd: String, _ st: HubState?) -> Bool {
        guard let st, !cwd.isEmpty, cwd.hasPrefix(NSHomeDirectory() + "/") else { return false }
        let real = URL(fileURLWithPath: cwd).resolvingSymlinksInPath().path
        if ["/Library", "/.ravenry", "/.claude"].contains(where: { real.hasPrefix(NSHomeDirectory() + $0) }) { return false }
        let root = ((st.raw["projectsRoot"] as? [String: Any])?["path"] as? String).map { $0.replacingOccurrences(of: "^~", with: NSHomeDirectory(), options: .regularExpression) }
        if let r = root, URL(fileURLWithPath: r).resolvingSymlinksInPath().path == real { return false }
        return !st.projects.contains { p in
            guard let f = p.folder, !(p.raw["unowned"] as? Bool ?? false) else { return false }
            let pf = URL(fileURLWithPath: f).resolvingSymlinksInPath().path
            return real == pf || real.hasPrefix(pf + "/")
        }
    }

    private func shellBody(_ pn: (id: String, name: String, cwd: String, command: [String])) -> [NSView] {
        var out: [NSView] = []
        if let o = host?.opened(pn.id) { out.append(hstack([Icon("shell", "tx3", size: 13), label(o, Fonts.pt(12), "tx3", lines: 2)], spacing: 7)) }
        // What the agent in it reported through the daemon (app.ts shellPanel): its state, or a question's card.
        let cp = host?.hub.checkpoint(pane: pn.id)
        if let line = reportLine(host?.report(pn.id), cp: cp) { out.append(line) }
        if let c = cp ?? host?.hub.card(pane: pn.id) { out.append(card(c)) }
        else if let m = (host?.report(pn.id)?["need"] as? [String: Any])?["message"] as? String, !m.isEmpty {
            let q = boxed(para(m, size: 13), fill: "card", ring: "you", radius: 10, insets: NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14))
            q.setAccessibilityLabel(m)
            out.append(q)
        }
        // Where it runs and what (shellPanel's Folder and Runs).
        if !pn.cwd.isEmpty || !pn.command.isEmpty {
            var rows: [NSView?] = [kv(t("panel.folder"), tilde(pn.cwd), mono: true), kv(t("panel.runs"), pn.command.isEmpty ? t("panel.loginShell") : shownCommand(pn.command), mono: true)]
            // A folder no project uses: a project can start from it (SESS-023).
            if folderFree(pn.cwd, host?.hub.state) {
                let b = RButton(t("panel.newFromFolder"), small: true) { [weak self] in
                    self?.host?.newProject(NewProjectPage.From(name: (pn.cwd as NSString).lastPathComponent, folder: pn.cwd, folderShort: self?.tilde(pn.cwd) ?? pn.cwd, shell: true))
                }
                buttons["newProject"] = b
                rows += [para(t("panel.folderFree"), "tx3", size: 12), hstack([b, spring()], spacing: 0)]
            }
            out.append(sec(nil, rows))
        }
        if let h = host { out.append(whoCanType(pn.id, h.whoCanType(pn.id))) }
        if let typed = typedHere(pn.id) { out.append(typed) }
        return out
    }

    /// 6 C: who can type here; an agent let for its session can be taken back.
    private(set) var whoRows: [String: NSPopUpButton] = [:]
    private func whoCanType(_ pane: String, _ rows: [WhoRow]) -> NSView {
        var grid: [[NSView]] = []
        whoRows = [:]
        for r in rows {
            var name: [NSView?] = []
            if r.value != "always" { name.append(Box(fill: Assistants.isKnown(r.who.cls) ? "work" : "idle", radius: 3.5)) }
            let col = vstack([label(r.who.who, Fonts.pt(12.5)), r.who.place.map { label($0, Fonts.pt(11.5), "tx3") }], spacing: 1)
            name.append(col)
            if let dot = name.first as? Box { dot.translatesAutoresizingMaskIntoConstraints = false; dot.widthAnchor.constraint(equalToConstant: 7).isActive = true; dot.heightAnchor.constraint(equalToConstant: 7).isActive = true }
            let left = hstack(name, spacing: 7)
            left.alignment = .top
            let right: NSView
            switch r.value {
            case "always": right = label(t("lease.always"), Fonts.pt(12), "tx3")
            case "own": right = label(t("lease.itsOwn"), Fonts.pt(12), "tx3")
            default:
                let pop = NSPopUpButton(frame: .zero, pullsDown: false)
                pop.controlSize = .small
                pop.font = Fonts.pt(12)
                pop.addItems(withTitles: [t("lease.asksEachTime"), r.grant != nil ? t("lease.canTypeSession") : t("lease.canTypeAsks")])
                pop.selectItem(at: r.grant != nil ? 1 : 0)
                pop.item(at: 1)?.isEnabled = r.grant != nil
                pop.autoenablesItems = false
                pop.setAccessibilityLabel(t("lease.whoCanType"))
                let g = r.grant
                pop.target = PopTarget.shared
                pop.action = #selector(PopTarget.changed(_:))
                PopTarget.shared.run[ObjectIdentifier(pop)] = { [weak self, weak pop] in
                    if pop?.indexOfSelectedItem == 0, let g { self?.host?.revoke(pane, g) }
                }
                whoRows[r.who.who] = pop
                right = pop
            }
            grid.append([left, right])
        }
        let g = NSGridView(views: grid)
        g.rowSpacing = 10
        g.columnSpacing = 8
        g.yPlacement = .center
        g.column(at: 1).xPlacement = .leading
        let note = label(t("lease.ownNote"), Fonts.pt(11.5), "tx3", lines: 0)
        note.preferredMaxLayoutWidth = PanelView.width - 56
        return sec(t("lease.whoCanType"), [g, note])
    }

    // MARK: a checkpoint's card, in the hub's words

    /// The card for a checkpoint, built once per state and what the person did on it, and kept.
    private func card(_ cp: [String: Any]) -> NSView {
        let id = cp["id"] as? String ?? ""
        let u = cardUI[id] ?? CardUI()
        cardUI[id] = u
        let w = cp["words"] as? [String: Any] ?? [:]
        let alerts = host?.hub.state?.raw["alerts"] as? [String: Any] ?? [:]
        let phoneToo = (alerts["enabled"] as? Bool ?? false) && (alerts["configured"] as? Bool ?? false)
        // The heading and the after line too: a page's run is worded by the hub after the daemon's copy came (PAGE-006, cards.ts cardFor).
        // Whether its run's pane is one this window has (Show in the terminal): the pane can come after the card was built.
        let runShown = ((cp["run"] as? [String: Any])?["pane"] as? String ?? (w["after"] as? [String: Any])?["runPane"] as? String).map { host?.paneName($0) != nil } ?? false
        // A pick's videos are part of it: a page's video the hub found after the card was built builds it again.
        let videos = (0..<(cp["variants"] as? [Any] ?? []).count).map { pickVideoPath(cp, $0) ?? "" }.joined(separator: ",")
        let key = "\(videos)|\(cp["state"] as? String ?? "")|\(w["state"] as? String ?? "")|\(w["heading"] as? String ?? "")|\((w["after"] as? [String: Any])?["head"] as? String ?? "")|\(u.stamp)|\(phoneToo)|\((cp["checked"] as? [[String: Any]])?.compactMap { $0["id"] as? String }.joined(separator: ",") ?? "")|\(runShown)"
        if let had = cardViews[id], had.key == key { had.refresh(); shownCard = had; return had }
        guard let h = host else { return NSView() }
        let ctx = CardCtx(hub: h.hub,
                          answer: { [weak self] id, reply in self?.answer(id, reply) },
                          changed: { [weak self] id in self?.cardChanged(id) },
                          openPicker: { id, n in h.openPicker(id, n) },
                          phoneToo: phoneToo,
                          paneName: { h.paneName($0) },
                          showPane: { h.showPane($0) },
                          driveFacts: { h.driveFacts($0) })
        let v = CheckpointCard(cp, ui: u, ctx: ctx, key: key)
        cardViews[id] = v
        shownCard = v
        return v
    }

    /// Editing, refusing: the card is built again and the keyboard put in it.
    private func cardChanged(_ id: String) {
        signature = ""
        host?.answered()
        DispatchQueue.main.async { [weak self] in self?.focusCard() }
    }

    /// Puts the keyboard in the card on show: its field, else the card (number keys answer).
    func focusCard() { shownCard?.focus() }

    /// A number key with the keyboard in the panel (not in a field): the card's answer.
    override func keyDown(with e: NSEvent) {
        if let c = shownCard, c.numberKey(e.charactersIgnoringModifiers ?? "", e.modifierFlags) { return }
        super.keyDown(with: e)
    }

    // MARK: what the person clicked, posted as the desktop posts it

    private func answer(_ id: String, _ reply: [String: Any]) {
        guard let h = host else { return }
        let u = cardUI[id] ?? CardUI()
        cardUI[id] = u
        if u.busy { return }
        u.busy = true
        u.error = nil
        signature = ""
        h.answered()
        // Through the daemon that holds it, else the hub (HubClient.answerCheckpoint); a refusal as not the person says why.
        h.hub.answerCheckpoint(id, reply) { [weak self] ok, error in
            guard let self else { return }
            u.busy = false
            if ok { u.editing = false; u.refusing = false; u.reason = ""; u.draft = "" } else { u.error = error }
            self.signature = ""
            h.answered()
        }
    }

    private func send(_ p: HubProject, _ s: HubSession, _ text: String, _ choice: NSNumber?) {
        var body: [String: Any] = ["projectId": p.id, "surfaceId": s.surfaceId]
        if let c = choice { body["choice"] = c } else { body["text"] = text }
        host?.hub.post("/api/send", body) { [weak self] code, j in
            self?.host?.toast(code == 200 ? t("panel.sent", ["label": text]) : (j["error"] as? String ?? "\(code)"))
        }
    }

    func handOff(_ p: HubProject, _ s: HubSession) {
        host?.hub.post("/api/handoff", ["projectId": p.id, "surfaceId": s.surfaceId]) { [weak self] code, j in
            // The hub words its answer: written already, asked now, or at the next stop.
            self?.host?.toast(code == 200 ? (j["say"] as? String ?? t("session.handOffQueued")) : (j["error"] as? String ?? "\(code)"))
        }
    }

    var onMove: ((HubProject, HubSession, String) -> Void)?
    /// Move here for a session on an older daemon: to the newest, at once.
    var onMoveNewer: ((HubProject, HubSession) -> Void)?
    private func move(_ p: HubProject, _ s: HubSession, keep: String) { onMove?(p, s, keep) }
}

/// A pop-up's change, run by its closure.
final class PopTarget: NSObject {
    static let shared = PopTarget()
    var run: [ObjectIdentifier: () -> Void] = [:]
    @objc func changed(_ p: NSPopUpButton) { run[ObjectIdentifier(p)]?() }
    @objc func segmented(_ s: NSSegmentedControl) { run[ObjectIdentifier(s)]?() }
}

/// The latest picture, 16:10, its corners rounded; a click opens it large.
final class PictureThumb: NSImageView {
    var onClick: (() -> Void)?
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 7
        layer?.masksToBounds = true
        imageScaling = .scaleProportionallyUpOrDown
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: (PanelView.width - 56) * 10 / 16).isActive = true
        setAccessibilityRole(.button)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var image: NSImage? { didSet { needsDisplay = true } }
    override func draw(_ r: NSRect) {
        Design.color("card2").setFill()
        bounds.fill()
        guard let img = image else { return }
        // object-fit: cover.
        let s = img.size
        guard s.width > 0, s.height > 0 else { return }
        let k = max(bounds.width / s.width, bounds.height / s.height)
        let w = s.width * k, h = s.height * k
        img.draw(in: NSRect(x: (bounds.width - w) / 2, y: (bounds.height - h) / 2, width: w, height: h))
    }
    override func mouseDown(with e: NSEvent) { onClick?() }
    override func resetCursorRects() { handCursor(onClick != nil) }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { onClick?(); return true }
}

enum SharedIconsView {
    static func machine() -> NSView { Icon("machine", "tx3", size: 12) }
}
