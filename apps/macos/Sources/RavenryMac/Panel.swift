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
        var setup: (String) -> (hooks: Bool, skill: Bool)?
        var toast: (String) -> Void
        var answered: () -> Void
        /// A pane's name as the tabs say it, when this window has it.
        var paneName: (String) -> String? = { _ in nil }
        /// A pick opens side by side in the middle.
        var openPicker: (String) -> Void = { _ in }
        /// "Who can type here" for a pane of this daemon, and taking a grant back (Lent.swift).
        var whoCanType: (String) -> [WhoRow] = { _ in [] }
        var revoke: (String, String) -> Void = { _, _ in }
        /// "Opened by you, 16:58, in paper-boat".
        var opened: (String) -> String? = { _ in nil }
        /// What the agent in a pane last reported (the daemon's pane.agent), else nil.
        var report: (String) -> [String: Any]? = { _ in nil }
        /// The agent whose own pane it is ("Claude"), else nil.
        var ownerOf: (String) -> String? = { _ in nil }
        /// A local session in a pane: its worktree's cards and the files it changed (Review.swift).
        var extras: (HubProject, HubSession, (([NSView?]) -> NSView), ((String?, NSView?, [NSView?]) -> NSView)) -> [NSView] = { _, _, _, _ in [] }
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

    private func setHead(_ name: String, tag: String?, machine: String?, pinKey: String?) {
        head.subviews.forEach { $0.removeFromSuperview() }
        let line = Box(fill: "sep")
        line.frame = NSRect(x: 0, y: 39, width: 4000, height: 1)
        head.addSubview(line)
        var items: [NSView?] = [label(name, Fonts.pt(13.5, Fonts.w650))]
        if let m = machine { items.append(hstack([SharedIconsView.machine(), label(m, Fonts.pt(11.5, .medium), "tx2")], spacing: 4)) }
        if let tg = tag { items.append(tagView(tg)) }
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
                for x in ["screen", "screenAt", "conversation", "reasons", "live"] { s[x] = nil }
                var p = f.project.raw
                p["sessions"] = nil
                parts += [s, p, st.checkpoint(of: f.project, f.session) ?? [:], st.threshold, host?.pinned(k) ?? false,
                          host?.setup(f.session.assistant ?? "").map { "\($0.hooks)\($0.skill)" } ?? ""]
            } else if k.hasPrefix("project:"), let p = st.project(String(k.dropFirst(8))) {
                var pr = p.raw; pr["sessions"] = nil
                parts.append(pr)
            }
        }
        if let id = pane?.id {
            parts.append(host?.inputs(id)?.count ?? -1)
            if front == nil || state?.find(front!) == nil { parts += [host?.report(id) ?? [:], state?.checkpoint(pane: id) ?? [:]] }
        }
        parts.append(cardUI.map { "\($0.key)\($0.value.stamp)" }.sorted())
        let sig = (try? JSONSerialization.data(withJSONObject: parts, options: [.sortedKeys, .fragmentsAllowed])).map { String($0.hashValue) } ?? UUID().uuidString
        // A field being typed in keeps its place: drawn again only when its card changed.
        if !force, sig == signature { return }
        if !force, let r = window?.firstResponder as? NSTextView, r.isDescendant(of: self), front == key {
            signature = sig
            return
        }
        signature = sig
        key = front ?? ""
        buttons = [:]
        pictureView = nil
        shownCard = nil
        var rows: [NSView] = []
        if let st = state, let k = front, let f = st.find(k) {
            shows = "session"
            setHead(f.project.name, tag: f.session.assistant.map(assistantName), machine: f.session.machine ?? f.project.machine, pinKey: k)
            rows = sessionBody(st, f.project, f.session, key: k, pane: pane)
        } else if let st = state, let k = front, k.hasPrefix("project:"), let p = st.project(String(k.dropFirst(8))) {
            shows = "project"
            setHead(p.name, tag: nil, machine: p.machine, pinKey: nil)
            rows = projectBody(p)
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

    private func assistantName(_ a: String) -> String { a == "claude" ? "Claude" : a == "codex" ? "Codex" : a.prefix(1).uppercased() + a.dropFirst() }

    private func tagView(_ s: String) -> NSView {
        let b = boxed(label(s, Fonts.pt(11, .semibold), "tx2"), fill: nil, ring: "sep", radius: 5, insets: NSEdgeInsets(top: 3, left: 7, bottom: 3, right: 7))
        b.setContentHuggingPriority(.required, for: .horizontal)
        return b
    }

    /// .sec: a card, its head line and its rows.
    private func sec(_ title: String?, right: NSView? = nil, _ rows: [NSView?], ring: String? = nil) -> NSView {
        var items: [NSView?] = []
        if let tt = title { items.append(hstack([label(tt, Fonts.pt(12, Fonts.w650), "tx2"), spring(), right], spacing: 8)) }
        items += rows
        let b = boxed(vstack(items, spacing: 8), fill: "card", ring: ring, radius: 10, insets: NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14))
        return b
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

    private func check(_ on: Bool, _ yes: String, _ no: String) -> NSView {
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
        var items: [NSView?] = [dot, label(on ? yes : no, Fonts.pt(12), "tx2")]
        if !on { items.append(RButton(t("side.settings"), .link) { [weak self] in self?.host?.openPage("settings", t("side.settings")) }) }
        return hstack(items, spacing: 7)
    }

    // MARK: a session

    private func sessionBody(_ st: HubState, _ p: HubProject, _ s: HubSession, key: String, pane: (id: String, name: String, cwd: String, command: [String])?) -> [NSView] {
        var out: [NSView] = []
        let cp = st.checkpoint(of: p, s)
        out.append(statusLine(p, s, cp: cp))
        // Open in two terminals, or went on in another: one click puts it in one place.
        if let other = s.alsoOpen ?? s.movedOn {
            let move = RButton(t("move.here"), .primary, small: true) { [weak self] in self?.move(p, s, keep: "ravenry") }
            buttons["move"] = move
            var acts: [NSView?] = [move]
            if s.alsoOpen != nil { acts.append(RButton(t("move.keep", ["other": other]), small: true) { [weak self] in self?.move(p, s, keep: "outside") }) }
            acts.append(spring())
            out.append(sec(nil, [para(s.alsoOpen != nil ? t("panel.alsoOpen", ["other": other]) : t("panel.wentOn", ["other": other])), hstack(acts, spacing: 8)]))
        }
        // What the first-launch step set up for its assistant, on this machine.
        if cp == nil, s.machine == nil, p.machine == nil, let a = s.assistant, a == "claude" || a == "codex", let sl = host?.setup(a) {
            out.append(sec(t("panel.thisSession"), [check(sl.hooks, t("panel.alertsOn"), t("panel.alertsOff")), check(sl.skill, t("panel.skillOn"), t("panel.skillOff"))]))
        }
        if let c = cp { out.append(card(c)) }
        let w = s.words
        let q = (w["headline"] as? String) ?? (w["question"] as? String) ?? (w["line"] as? String) ?? ""
        let quick = (w["quick"] as? [[String: Any]] ?? []).prefix(6)
        let dialog = w["dialog"] as? [String] ?? []
        if cp == nil, s.group == "you", !q.isEmpty || !dialog.isEmpty || !quick.isEmpty {
            var rows: [NSView?] = [q.isEmpty ? nil : para(q, size: 13)]
            if !dialog.isEmpty { let d = label(dialog.joined(separator: "\n"), Fonts.mono(11.5), "tx2", lines: 0); d.preferredMaxLayoutWidth = PanelView.width - 56; rows.append(d) }
            if !quick.isEmpty {
                let bs = quick.map { o -> NSView in
                    let l = o["label"] as? String ?? ""
                    let choice = o["choice"] as? NSNumber
                    let b = RButton(l, small: true) { [weak self] in self?.send(p, s, l, choice) }
                    buttons["quick:\(l)"] = b
                    return b
                }
                rows.append(flow(bs))
            }
            out.append(sec(nil, rows, ring: "you"))
        }
        if s.pane != nil, s.machine == nil, p.machine == nil, let h = host {
            out += h.extras(p, s, { [weak self] rows in self?.sec(nil, rows, ring: "you") ?? NSView() }, { [weak self] t0, r, rows in self?.sec(t0, right: r, rows) ?? NSView() })
        }
        if let c = s.ctx {
            let th = st.threshold
            let pct = max(0, min(100, c.pct))
            let bar = Box(fill: "card2", radius: 2.5)
            bar.translatesAutoresizingMaskIntoConstraints = false
            bar.heightAnchor.constraint(equalToConstant: 5).isActive = true
            let f = Box(fill: pct >= th ? "you" : "tx2", radius: 2.5)
            let mk = Box(fill: "you", radius: 1)
            mk.toolTip = t("panel.handOffLine", ["pct": "\(Int(th))"])
            bar.addSubview(f); bar.addSubview(mk)
            bar.postsFrameChangedNotifications = true
            let place = { [weak bar, weak f, weak mk] in
                guard let b = bar else { return }
                f?.frame = NSRect(x: 0, y: 0, width: b.bounds.width * pct / 100, height: 5)
                mk?.frame = NSRect(x: b.bounds.width * th / 100 - 1, y: -3, width: 2, height: 11)
            }
            NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: bar, queue: .main) { _ in place() }
            let hand = RButton(t("session.handOffNow"), small: true) { [weak self] in self?.handOff(p, s) }
            buttons["handoff"] = hand
            out.append(sec(t("panel.context"), right: label(t("panel.tokensOf", ["used": When.tokens(c.tokens), "window": When.tokens(c.window)]), Fonts.pt(12, .semibold).withTabularDigits),
                           [bar, hstack([label(t("panel.handsOffAt", ["pct": "\(Int(th))"]), Fonts.pt(12), "tx3"), spring(), hand], spacing: 8)]))
        }
        // Over the terminal on a narrow window, a card keeps the panel short.
        if cp != nil, superview.map({ _ in isOverlay }) ?? false { return out }
        if let ho = p.timeline.first(where: { $0["from"] as? String == "brief" }) {
            out.append(sec(t("panel.handOff"), right: (ho["when"] as? String).map { label($0, Fonts.pt(12, .medium), "tx3") },
                           [para(ho["text"] as? String ?? ""), p.handoffRecent ? check(true, t("panel.readBySession"), "") : nil]))
        }
        if let pics = p.brief?["pictures"] as? [[String: Any]], let pic = pics.filter({ $0["url"] is String }).last {
            let n = pics.filter { $0["url"] is String }.count
            let gallery = RButton(n > 1 ? t("panel.galleryCount", ["n": "\(n)"]) : t("panel.gallery"), .link) { [weak self] in self?.host?.openPage("gallery:\(p.id)", t("panel.gallery")) }
            let img = PictureThumb()
            img.toolTip = t("panel.seeLarge")
            img.setAccessibilityLabel(pic["alt"] as? String ?? t("panel.seeLarge"))
            img.onClick = { [weak self] in self?.host?.openPicture(p, pic) }
            pictureView = img
            if let u = pic["url"] as? String { host?.hub.data(u) { d in img.image = d.flatMap(NSImage.init(data:)) } }
            out.append(sec(t("panel.latestPicture"), right: gallery, [img, (pic["alt"] as? String).map { label($0, Fonts.pt(12), "tx3", lines: 2) }]))
        }
        if let b = p.brief, (b["goal"] as? String) != nil || (b["next"] as? String) != nil {
            let n = b["nextParts"] as? [String: Any] ?? [:]
            let items = n["items"] as? [String] ?? []
            let older = (n["older"] as? NSNumber)?.intValue ?? 0
            var rows: [NSView?] = []
            if let g = b["goal"] as? String {
                rows.append(label(t("panel.goal"), Fonts.pt(11, .semibold), "tx3"))
                let gl = label(g.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: ""), Fonts.pt(12.5))
                gl.toolTip = g
                rows.append(gl)
            }
            if !items.isEmpty {
                rows.append(label(t("panel.next"), Fonts.pt(11, .semibold), "tx3"))
                for x in items { let l = label("•  " + x, Fonts.pt(12.5)); l.toolTip = x; rows.append(l) }
            }
            let open = RButton(t("panel.openBrief"), .link) { [weak self] in self?.host?.openPage("brief:\(p.id)", t("panel.brief")) }
            buttons["brief"] = open
            rows.append(hstack([open, older > 0 ? label(t(older == 1 ? "panel.olderEntry" : "panel.olderEntries", ["n": "\(older)"]), Fonts.pt(12), "tx3") : nil, spring()], spacing: 0))
            out.append(sec(t("panel.brief"), rows))
        }
        let plan = p.plan
        let planB = RButton(plan != nil ? t("panel.openPlan") : t("panel.newPlan"), small: true) { [weak self] in
            self?.host?.openPage(plan != nil ? "plan:\(p.id)" : "newplan:\(p.id)", plan != nil ? t("panel.plan") : t("panel.newPlan"))
        }
        buttons["plan"] = planB
        out.append(sec(t("panel.plan"), right: label(plan == nil ? t("panel.planNone") : p.planGate ? t("panel.planGate") : t("panel.planRunning"), Fonts.pt(12, .medium), "tx3"),
                       [plan.map { para(($0["title"] as? String) ?? ($0["name"] as? String) ?? t("panel.planRunningLine")) } ?? para(t("panel.planBlurb"), "tx2", size: 12),
                        hstack([planB, spring()], spacing: 0)]))
        if let pn = pane, let typed = typedHere(pn.id) { out.append(typed) }
        return out
    }

    var isOverlay = false

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

    private func typedHere(_ pane: String) -> NSView? {
        guard let recs = host?.inputs(pane) else { return nil }
        let last = recs.suffix(4).reversed()
        var rows: [NSView?] = []
        if last.isEmpty { rows.append(label(t("page.nothingTyped"), Fonts.pt(12), "tx3")) }
        for r in last {
            let src = r["source"] as? [String: Any] ?? [:]
            let person = src["kind"] as? String == "person"
            let who = person ? "You" : (src["name"] as? String ?? (src["agent"] as? String) ?? "An agent")
            let text = (r["masked"] as? Bool ?? false) && (r["text"] as? String ?? "").isEmpty ? "Hidden: a password or a secret" : (r["text"] as? String ?? "")
            rows.append(hstack([label(When.clock(r["at"] as? String), Fonts.pt(11.5).withTabularDigits, "tx3"), label(who, Fonts.pt(12, .semibold), person ? "tx" : "work"),
                                label(text.replacingOccurrences(of: "\r", with: " ⏎ ").replacingOccurrences(of: "\n", with: " ⏎ "), Fonts.mono(11.5), "tx2")], spacing: 6))
        }
        return sec(t("panel.typedHere"), rows)
    }

    // MARK: a project, a shell

    private func projectBody(_ p: HubProject) -> [NSView] {
        var out: [NSView] = []
        if let g = (p.brief?["goal"] as? String) { out.append(sec(t("panel.goal"), [para(g)])) }
        if let f = p.folderShort { out.append(sec(nil, [label(f, Fonts.pt(12), "tx3")])) }
        return out
    }

    private func shellBody(_ pn: (id: String, name: String, cwd: String, command: [String])) -> [NSView] {
        var out: [NSView] = []
        if let o = host?.opened(pn.id) { out.append(hstack([Icon("shell", "tx3", size: 13), label(o, Fonts.pt(12), "tx3", lines: 2)], spacing: 7)) }
        // What the agent in it reported through the daemon (app.ts shellPanel): its state, or a question's card.
        let cp = host?.hub.state?.checkpoint(pane: pn.id)
        if let line = reportLine(host?.report(pn.id), cp: cp) { out.append(line) }
        if let c = cp { out.append(card(c)) }
        else if let m = (host?.report(pn.id)?["need"] as? [String: Any])?["message"] as? String, !m.isEmpty {
            let q = boxed(para(m, size: 13), fill: "card", ring: "you", radius: 10, insets: NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14))
            q.setAccessibilityLabel(m)
            out.append(q)
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
            if r.value != "always" { name.append(Box(fill: r.who.cls == "claude" || r.who.cls == "codex" ? "work" : "idle", radius: 3.5)) }
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
        let key = "\(cp["state"] as? String ?? "")|\(w["state"] as? String ?? "")|\(u.stamp)|\(phoneToo)|\((cp["checked"] as? [[String: Any]])?.compactMap { $0["id"] as? String }.joined(separator: ",") ?? "")"
        if let had = cardViews[id], had.key == key { had.refresh(); shownCard = had; return had }
        guard let h = host else { return NSView() }
        let ctx = CardCtx(hub: h.hub,
                          answer: { [weak self] id, reply in self?.answer(id, reply) },
                          changed: { [weak self] id in self?.cardChanged(id) },
                          openPicker: { id in h.openPicker(id) },
                          phoneToo: phoneToo,
                          paneName: { h.paneName($0) })
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
        var body = reply
        body["id"] = id
        body["by"] = "desktop"
        h.hub.post("/api/checkpoints/answer", body) { [weak self] code, j in
            guard let self else { return }
            u.busy = false
            if code == 200 {
                u.editing = false; u.refusing = false; u.reason = ""; u.draft = ""
            } else {
                let why = j["error"] as? String ?? "the board answered \(code)"
                u.error = t("checkpoint.failed", ["why": why])
            }
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

    private func handOff(_ p: HubProject, _ s: HubSession) {
        host?.hub.post("/api/handoff", ["projectId": p.id, "surfaceId": s.surfaceId]) { [weak self] code, j in
            self?.host?.toast(code == 200 ? t("session.handOffQueued") : (j["error"] as? String ?? "\(code)"))
        }
    }

    var onMove: ((HubProject, HubSession, String) -> Void)?
    private func move(_ p: HubProject, _ s: HubSession, keep: String) { onMove?(p, s, keep) }
}

/// A pop-up's change, run by its closure.
final class PopTarget: NSObject {
    static let shared = PopTarget()
    var run: [ObjectIdentifier: () -> Void] = [:]
    @objc func changed(_ p: NSPopUpButton) { run[ObjectIdentifier(p)]?() }
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
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { onClick?(); return true }
}

enum SharedIconsView {
    static func machine() -> NSView { Icon("machine", "tx3", size: 12) }
}
