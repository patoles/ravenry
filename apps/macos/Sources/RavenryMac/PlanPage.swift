// A plan, and a new plan drafted from the brief (PLAN rows), as the
// Electron app draws them (inapp.ts plan() and newPlan(); app.css .ia-ps,
// .ia-meta, .ia-gate, .ia-fieldset).
//
// - A plan: the hub's list of the plans a project's page shows (each
//   project's planPages, planfmt.mjs, which the Electron app worked out
//   itself as planOf): the one asked for by title, else the first (the
//   running one, else the brief's last). Its state, Pause or Resume, its
//   goal, the gate it waits at with its choices or a field, its steps
//   with their proofs, Open in the brief and Show its session.
// - A new plan: GET /api/plan/draft, read again every 2 s while it shows.
//   The goal field, what it starts from (the brief's first task list),
//   Draft the plan; while drafting, Stop; a draft: its steps, its
//   questions, Start the plan and Discard.

import AppKit

/// .ia-ps .bx: a box, ticked on --ok, ringed --work for the step it is on.
final class StepBox: NSView {
    let done: Bool, now: Bool
    init(done: Bool, now: Bool) {
        self.done = done; self.now = now
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 15).isActive = true
        heightAnchor.constraint(equalToConstant: 15).isActive = true
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func draw(_ r: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            if done {
                Design.color("ok").setFill()
                NSBezierPath(roundedRect: bounds, xRadius: 4, yRadius: 4).fill()
                let p = NSBezierPath()
                p.move(to: NSPoint(x: 4, y: 7.8)); p.line(to: NSPoint(x: 6.6, y: 10.3)); p.line(to: NSPoint(x: 11, y: 5))
                p.lineWidth = 1.7; p.lineCapStyle = .round; p.lineJoinStyle = .round
                NSColor.white.setStroke(); p.stroke()
            } else {
                let p = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.75, dy: 0.75), xRadius: 3.4, yRadius: 3.4)
                p.lineWidth = 1.5
                Design.color(now ? "work" : "tx3").setStroke(); p.stroke()
            }
        }
    }
}

/// .ia-ps: a step, its box, its words and its proofs (or a draft step's detail).
func stepRow(_ text: String, sub: [String], done: Bool, now: Bool) -> Box {
    let words = vstack([wrap(text, Fonts.pt(13), done ? "tx2" : "tx")] + sub.map { wrap($0, Fonts.pt(12), "tx3") }, spacing: 2)
    words.setContentHuggingPriority(.init(1), for: .horizontal)
    let bx = StepBox(done: done, now: now)
    let col = Flipped()
    col.translatesAutoresizingMaskIntoConstraints = false
    col.addSubview(bx)
    NSLayoutConstraint.activate([col.widthAnchor.constraint(equalToConstant: 20), bx.leadingAnchor.constraint(equalTo: col.leadingAnchor), bx.topAnchor.constraint(equalTo: col.topAnchor, constant: 2)])
    let row = NSStackView(views: [col, words])
    row.orientation = .horizontal
    row.alignment = .top
    row.spacing = 8
    col.heightAnchor.constraint(equalTo: row.heightAnchor).isActive = true
    return boxed(row, fill: now ? "work-t" : nil, radius: 8, insets: NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10))
}

final class PlanPage: FormPage {
    enum Mode: Equatable { case plan, new }
    var openBrief: ((String) -> Void)?
    var showSession: ((String) -> Bool)?
    var openPlan: ((String) -> Void)?
    private(set) var mode = Mode.plan
    private(set) var project = ""
    private(set) var title: String?
    private var state: HubState?
    /// GET /api/plan/draft's draft, for `draftFor`.
    private(set) var draft: [String: Any]?
    private(set) var draftFor = ""

    func show(_ pid: String, mode m: Mode, title tt: String? = nil, state st: HubState?) {
        if pid != project || m != mode || tt != title { dirty(); scroll.contentView.scroll(to: .zero) }
        project = pid; mode = m; title = tt; state = st
        if m == .new { if draftFor != pid { draft = nil }; load(); poll(2) } else { poll(nil) }
        redraw()
    }
    /// The self-test's: the state it gave kept through the hub's refreshes.
    var holdState = false
    func refresh(_ st: HubState?) { if !holdState { state = st }; redraw() }

    override func load() {
        guard mode == .new, let hub else { return }
        let pid = project
        hub.get("/api/plan/draft?projectId=\(pid.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? pid)") { [weak self] code, j in
            guard let self, self.project == pid else { return }
            self.draft = code == 200 ? j["draft"] as? [String: Any] : nil
            self.draftFor = pid
            self.redraw()
        }
    }

    /// The plan to show and whether it runs (the hub's planPages; an older hub: the running one).
    static func pick(_ p: HubProject, title: String?) -> (plan: [String: Any], running: Bool)? {
        if let pages = p.raw["planPages"] as? [[String: Any]] {
            let x = title.flatMap { tt in pages.first { $0["title"] as? String == tt } } ?? (title == nil ? pages.first : nil)
            return x.flatMap { e in (e["plan"] as? [String: Any]).map { ($0, e["running"] as? Bool ?? false) } }
        }
        return p.plan.map { ($0, true) }
    }

    override func redraw() {
        let p = state?.project(project)
        if mode == .new { drawNew(p); return }
        guard let p, let (plan, running) = PlanPage.pick(p, title: title) else {
            setHead(title: t("panel.plan"), src: p?.name ?? project)
            draw("gone|\(p != nil)") {
                [wrap(t("plan.gone"), Fonts.pt(13), "tx2"), p.map { pp in acts([RButton(t("plan.openBrief")) { [weak self] in self?.openBrief?(pp.id) }]) }].compactMap { $0 }
            }
            return
        }
        let steps = plan["steps"] as? [[String: Any]] ?? []
        let st = plan["state"] as? String ?? "running"
        let isDone = { (s: [String: Any]) in ["done", "skip"].contains(s["state"] as? String ?? "") }
        let done = steps.filter(isDone).count
        let cur = steps.firstIndex { !isDone($0) }
        let gate = running ? p.raw["planGate"] as? [String: Any] : nil
        let tone = ["running": "work", "gate": "you", "done": "ok", "stopped": "bad"][st]
        let pillV = pill(t("plan.state.\(st)") == "plan.state.\(st)" ? st : t("plan.state.\(st)"), tone)
        var extra: [NSView] = []
        if running && st == "running" { let b = RButton(t("plan.pause")) { [weak self] in self?.post("pause") }; b.isEnabled = busy.isEmpty; buttons["pause"] = b; extra.append(b) }
        else if running && st == "paused" { let b = RButton(t("plan.resume")) { [weak self] in self?.post("resume") }; b.isEnabled = busy.isEmpty; buttons["resume"] = b; extra.append(b) }
        else { buttons["pause"] = nil; buttons["resume"] = nil }
        let ttl = plan["title"] as? String ?? t("panel.plan")
        let sig = "\(project)|\(ttl)|\(st)|\(busy)|\(running)|\(stableText(gate))|" + steps.map { "\($0["state"] ?? "")\($0["text"] ?? "")\(stableText($0["proofs"]))" }.joined(separator: ",") + "|\(stableText(plan["goal"]))|\(p.sessions.count)"
        setHeadPill(ttl, pillV, extra)
        draw(sig) {
            var rows: [NSView] = []
            let meta = hstack([label(p.name, Fonts.pt(12.5), "tx2"), (plan["started"] as? String).map { label(t("plan.started", ["when": $0]), Fonts.pt(12.5), "tx2") }, label(t("plan.nDone", ["done": "\(done)", "n": "\(steps.count)"]), Fonts.pt(12.5), "tx2"), spring()], spacing: 12)
            rows.append(meta)
            if let g = plan["goal"] as? String, !g.isEmpty { rows.append(secBox(t("plan.goal"), [wrap(md: t("plan.quoted", ["text": g]), Fonts.pt(12.5))])) }
            if let g = gate {
                let choices = g["choices"] as? [String] ?? []
                var inner: [NSView?] = [wrap(md: g["question"] as? String ?? "", Fonts.pt(12.5))]
                if !choices.isEmpty {
                    inner.append(acts(choices.enumerated().map { i, c in
                        let b = RButton(c, .primary) { [weak self] in self?.post("answer", ["choice": c]) { _ in self?.toast?(t("plan.sentChoice", ["choice": c])) } }
                        b.isEnabled = busy.isEmpty; buttons["choice\(i)"] = b; return b
                    }))
                } else {
                    let f = field("gate", t("plan.yourAnswer"))
                    let send = RButton(t("plan.send"), .primary) { [weak self] in self?.sendGate() }
                    send.isEnabled = busy.isEmpty
                    f.onReturn = { [weak self] in self?.sendGate() }
                    buttons["send"] = send
                    inner.append(hstack([f, send], spacing: 10))
                }
                rows.append(secBox(t("plan.waits"), inner, ring: "you"))
            }
            let list = vstack(steps.enumerated().map { i, s in
                let kind = s["kind"] as? String ?? "do"
                let kw = ["do", "done", "branch", "gate"].contains(kind) ? t("plan.kind.\(kind)") : t("plan.kind.do")
                let proofs = (s["proofs"] as? [[String: Any]] ?? []).map { t("plan.proof", ["text": $0["text"] as? String ?? ""]) }
                return stepRow(t("plan.step", ["kind": kw, "text": s["text"] as? String ?? ""]), sub: proofs, done: isDone(s), now: i == cur)
            }, spacing: 2)
            rows.append(list)
            let ob = RButton(t("plan.openInBrief")) { [weak self] in self?.openBrief?(p.id) }
            buttons["openBrief"] = ob
            var ss: RButton? = nil
            if !p.sessions.isEmpty {
                ss = RButton(t("plan.showSession")) { [weak self] in if self?.showSession?(p.id) == false { self?.toast?(t("plan.noSession")) } }
            }
            buttons["showSession"] = ss
            rows.append(acts([ob, ss]))
            return rows
        }
    }

    /// The head with the title and its pill on one line (.pg-h h2 .ia-pill).
    private func setHeadPill(_ title: String, _ p: NSView, _ extra: [NSView]) {
        setHead(title: title, src: nil, extra: extra)
        // The pill beside the title: the title's stack gets it.
        if let h = head.subviews.first as? NSStackView, let tt = h.arrangedSubviews.first(where: { ($0 as? NSStackView)?.orientation == .vertical }) as? NSStackView,
           let tl = tt.arrangedSubviews.first {
            tt.removeArrangedSubview(tl); tl.removeFromSuperview()
            let line = hstack([tl, p], spacing: 8)
            tt.insertArrangedSubview(line, at: 0)
        }
    }

    private func sendGate() {
        if need("gate", t("plan.typeAnswer")) { return }
        let tx = typed("gate")
        post("answer", ["text": tx]) { [weak self] _ in self?.clear("gate"); self?.toast?(t("plan.sent")) }
    }

    private func post(_ what: String, _ body: [String: Any] = [:], done: (([String: Any]) -> Void)? = nil) {
        var b = body; b["projectId"] = project
        act(what, "/api/plan/\(what)", b, done: done)
    }

    // MARK: a new plan

    private func drawNew(_ p: HubProject?) {
        let name = p?.name ?? project
        setHead(title: t("panel.newPlan"), src: t("newplan.src", ["name": name]))
        let d = draftFor == project ? draft : nil
        let steps = d?["steps"] as? [[String: Any]] ?? []
        let busyD = d?["busy"] as? [String: Any]
        let sig = "new|\(project)|\(busy)|\(d.map { stableText($0) } ?? "-")|\(p?.brief.map { stableText($0["plan"]) + stableText($0["goal"]) } ?? "")"
        draw(sig) {
            if let bz = busyD {
                let who = bz["who"] as? String == "codex" ? "Codex" : "Claude"
                let stop = RButton(t("newplan.stop")) { [weak self] in self?.post("halt") }
                stop.isEnabled = busy.isEmpty; buttons["stop"] = stop
                return [secBox(nil, [wrap(t("newplan.drafting", ["who": who]), Fonts.pt(12.5))]), acts([stop])]
            }
            if let d, !steps.isEmpty {
                var rows: [NSView] = []
                let goal = (d["goal"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                rows.append(secBox(t("newplan.draft"), [label(d["title"] as? String ?? t("panel.plan"), Fonts.pt(12.5, .bold)), goal.map { wrap(md: t("plan.quoted", ["text": $0]), Fonts.pt(12), "tx2") }]))
                rows.append(vstack(steps.map { s in
                    let kind = s["kind"] as? String ?? "do"
                    let kw = ["do", "done", "branch", "gate"].contains(kind) ? t("plan.kind.\(kind)") : t("plan.kind.do")
                    return stepRow(t("plan.step", ["kind": kw, "text": s["text"] as? String ?? ""]), sub: (s["detail"] as? String).map { [$0] } ?? [], done: false, now: false)
                }, spacing: 2))
                for (qi, q) in (d["questions"] as? [[String: Any]] ?? []).enumerated() {
                    let ans = q["answer"] as? String
                    let opts = (q["options"] as? [String] ?? []).enumerated().map { oi, o in
                        let b = RButton(o, ans == o ? .primary : .normal) { [weak self] in self?.post("edit", ["answer": ["id": q["id"] as? String ?? "", "option": o]]) }
                        b.isEnabled = busy.isEmpty; b.setAccessibilityValue(ans == o); buttons["q\(qi)o\(oi)"] = b; return b
                    }
                    rows.append(secBox(t("newplan.question"), [wrap(q["text"] as? String ?? "", Fonts.pt(12.5)), acts(opts)]))
                }
                if let e = d["error"] as? String, !e.isEmpty { rows.append(wrap(e, Fonts.pt(12.5), "bad")) }
                let start = RButton(t("newplan.start"), .primary) { [weak self] in
                    guard let self else { return }
                    let pid = self.project
                    self.post("start") { _ in self.toast?(t("newplan.started")); self.openPlan?(pid) }
                }
                start.isEnabled = busy.isEmpty && (d["canStart"] as? Bool ?? false)
                let discard = RButton(t("newplan.discard")) { [weak self] in self?.post("discard") }
                discard.isEnabled = busy.isEmpty
                buttons["start"] = start; buttons["discard"] = discard
                let open = (d["openQuestions"] as? NSNumber)?.intValue ?? 0
                rows.append(acts([start, discard, open > 0 ? label(t("newplan.answerFirst"), Fonts.pt(12), "tx3") : nil]))
                return rows
            }
            let objectives = (p?.brief?["plan"] as? [[String: Any]] ?? []).filter { !($0["plan"] as? Bool ?? false) }
            let o = objectives.first
            let open = (o?["tasks"] as? [[String: Any]] ?? []).filter { $0["state"] as? String != "done" }.prefix(4)
            let f = field("goal", t("newplan.whatHint"), area: true)
            let from: NSView
            if let o {
                from = secBox(nil, [label(o["title"] as? String ?? "", Fonts.pt(12), "tx3")] + (open.isEmpty ? [wrap(t("newplan.allDone"), Fonts.pt(12), "tx2")] : open.map { wrap($0["text"] as? String ?? "", Fonts.pt(12.5)) }), ring: nil)
            } else {
                let g = p?.brief?["goal"] as? String
                from = secBox(nil, [wrap(md: g.map { t("newplan.fromGoal", ["goal": $0]) } ?? t("newplan.noPlan"), Fonts.pt(12), "tx2")])
            }
            let draftB = RButton(t("newplan.draftIt"), .primary) { [weak self] in
                guard let self else { return }
                if self.need("goal", t("newplan.sayFirst")) { return }
                self.post("draft", ["goal": self.typed("goal")]) { _ in self.clear("goal") }
            }
            draftB.isEnabled = busy.isEmpty
            let cancel = RButton(t("newplan.cancel")) { [weak self] in self?.onClose?() }
            buttons["draft"] = draftB; buttons["cancel"] = cancel
            var rows: [NSView] = [
                vstack([label(t("newplan.what"), Fonts.pt(12, Fonts.w650), "tx2"), f], spacing: 6),
                vstack([label(t("newplan.from"), Fonts.pt(12, Fonts.w650), "tx2"), from], spacing: 6),
            ]
            if let e = d?["error"] as? String, !e.isEmpty { rows.append(wrap(e, Fonts.pt(12.5), "bad")) }
            rows.append(acts([draftB, cancel, label(t("newplan.readFirst"), Fonts.pt(12), "tx3")]))
            return rows
        }
    }
}
