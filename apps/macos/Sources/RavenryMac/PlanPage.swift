// A plan, and a new plan drafted from the brief (PLAN rows), as the
// Electron app draws them (inapp.ts plan() and newPlan(); app.css .ia-ps,
// .ia-meta, .ia-gate, .ia-fieldset).
//
// - A plan: the hub's list of the plans a project's page shows (each
//   project's planPages, planfmt.mjs, which the Electron app worked out
//   itself as planOf): the one asked for by title, else the first (the
//   running one, else the brief's last). Its state, Pause or Resume, its
//   goal, the gate it waits at with its choices or a field, its steps
//   with their proofs, Open in the brief and Show its session. A gate
//   the file alone passed (the agent ticked it, or took it out of the
//   brief: planGate.fileOnly) says so, with Reopen and Confirm (POST
//   /api/plan/reopen, confirm), as the hub's browser board has it
//   (hub/public/app.js gateTopHtml). Change the plan (POST
//   /api/plan/change) opens the running plan as a draft to change.
// - A new plan: GET /api/plan/draft, read again every 2 s while it shows.
//   The goal field, what it starts from (the brief's first task list),
//   Draft the plan, or Write the plan yourself (POST /api/plan/own); while
//   drafting, Stop; a draft: what was said, its steps (a comment on one,
//   POST /api/plan/revise { comment }), its questions, bigger changes in
//   words (revise { message }), Start the plan (Save the changes for a
//   running plan changed) and Discard (the board's plSheetHtml).

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
    /// Write the plan yourself, before there is a draft.
    private(set) var own = false
    /// The step a comment is being written on, by its id.
    private(set) var commentFor: String?
    /// "Write it yourself" pressed over a draft: asked once in the page.
    private(set) var dropAsk = false
    /// Stop the plan was pressed: the question under the buttons, until Stop or Cancel (PLAN-007).
    private(set) var askStop = false
    /// A new plan page opened for this project (after Change the plan).
    var openNewPlan: ((String) -> Void)?

    func show(_ pid: String, mode m: Mode, title tt: String? = nil, state st: HubState?) {
        if pid != project || m != mode || tt != title { dirty(); scroll.contentView.scroll(to: .zero); own = false; commentFor = nil; dropAsk = false }
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
        let sig = "\(project)|\(ttl)|\(st)|\(busy)|\(running)|\(stableText(gate))|" + steps.map { "\($0["state"] ?? "")\($0["text"] ?? "")\(stableText($0["proofs"]))" }.joined(separator: ",") + "|\(stableText(plan["goal"]))|\(p.sessions.count)|\(askStop)"
        setHeadPill(ttl, pillV, extra)
        draw(sig) {
            var rows: [NSView] = []
            let meta = hstack([label(p.name, Fonts.pt(12.5), "tx2"), (plan["started"] as? String).map { label(t("plan.started", ["when": $0]), Fonts.pt(12.5), "tx2") }, label(t("plan.nDone", ["done": "\(done)", "n": "\(steps.count)"]), Fonts.pt(12.5), "tx2"), spring()], spacing: 12)
            rows.append(meta)
            if let g = plan["goal"] as? String, !g.isEmpty { rows.append(secBox(t("plan.goal"), [wrap(md: t("plan.quoted", ["text": g]), Fonts.pt(12.5))])) }
            if let g = gate, let fo = g["fileOnly"] as? String {
                rows.append(self.fileOnly(p, g, fo))
            } else if let g = gate {
                let choices = g["choices"] as? [String] ?? []
                var inner: [NSView?] = [wrap(md: g["question"] as? String ?? "", Fonts.pt(12.5))]
                if !choices.isEmpty {
                    inner.append(acts(choices.enumerated().map { i, c in
                        let b = RButton(c, .primary) { [weak self] in self?.post("answer", ["choice": c]) { _ in self?.toast?(t("plan.sentChoice", ["choice": c])) } }
                        b.isEnabled = busy.isEmpty; buttons["choice\(i)"] = b; return b
                    }))
                } else {
                    // A field of this question's own: what was typed for one question never shows under the next.
                    let key = PlanPage.gateKey(g)
                    gateField = key
                    let f = field(key, t("plan.yourAnswer"))
                    let send = RButton(t("plan.send"), .primary) { [weak self] in self?.sendGate(key) }
                    send.isEnabled = busy.isEmpty
                    f.onReturn = { [weak self] in self?.sendGate(key) }
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
            // Change the plan (PLAN-006): the running plan as a draft to change; with the actions, so the head keeps the title whole.
            var ch: RButton? = nil
            if running && ["running", "paused", "gate"].contains(st) {
                ch = RButton(t("plan.change")) { [weak self] in
                    guard let self else { return }
                    let pid = self.project
                    self.post("change") { _ in self.openNewPlan?(pid) }
                }
                ch?.isEnabled = busy.isEmpty
            }
            buttons["change"] = ch
            // Stop the plan (PLAN-007): asked first; its session finishes the step in hand and starts no other.
            var sp: RButton? = nil
            if running && ["running", "paused", "gate"].contains(st) {
                sp = RButton(t("plan.stop")) { [weak self] in self?.askStop = true; self?.dirty(); self?.redraw() }
                sp?.isEnabled = busy.isEmpty && !askStop
            }
            buttons["stop"] = sp
            rows.append(acts([ob, ss, ch, sp]))
            if askStop, sp != nil {
                let yes = RButton(t("plan.stop"), .no) { [weak self] in
                    guard let self else { return }
                    self.askStop = false
                    self.post("stop") { j in self.toast?(t("plan.stopped") + ((j["via"] as? String) == "brief" ? " " + t("plan.briefOnly") : "")) }
                }
                let no = RButton(t("newplan.cancel")) { [weak self] in self?.askStop = false; self?.dirty(); self?.redraw() }
                yes.isEnabled = busy.isEmpty
                buttons["stopYes"] = yes; buttons["stopNo"] = no
                rows.append(secBox(nil, [wrap(t("plan.stopAsk", ["title": ttl]), Fonts.pt(12.5)), acts([yes, no])], ring: "bad"))
            } else { buttons["stopYes"] = nil; buttons["stopNo"] = nil }
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

    /// The field of the gate's own words, by its step and question.
    static func gateKey(_ g: [String: Any]) -> String { "gate:\(g["n"].map { "\($0)" } ?? ""):\(g["question"] as? String ?? "")" }
    /// The key of the gate field drawn last (the self-test types in it).
    private(set) var gateField = ""

    private func sendGate(_ key: String) {
        if need(key, t("plan.typeAnswer")) { return }
        let tx = typed(key)
        post("answer", ["text": tx]) { [weak self] _ in self?.clear(key); self?.toast?(t("plan.sent")) }
    }

    /// The assistant a project's sessions run (its own, else Claude), by its short word (Assistants.swift).
    private func who(_ p: HubProject) -> String { Assistants.short(p.s("assistant")) }
    /// The assistant Plans run on (state.assistants.print).
    private var printWho: String { Assistants.short((state?.raw["assistants"] as? [String: Any])?["print"] as? String) }

    /// A gate the file alone passed (ticked in BRIEF.md, or taken out of it):
    /// what the file says, and the person's Reopen or Confirm.
    private func fileOnly(_ p: HubProject, _ g: [String: Any], _ kind: String) -> NSView {
        let ticked = kind == "ticked"
        let words = g["text"] as? String ?? ""
        let lower = words.prefix(1).lowercased() + words.dropFirst()
        let ans = (g["fileAnswer"] as? String).map { $0.replacingOccurrences(of: "^\"|\"$", with: "", options: .regularExpression) }
        let why = ticked ? t("plan.fileTickedWhy", ["answer": ans.map { t("plan.fileAnswer", ["answer": $0]) } ?? "", "who": who(p)])
            : t("plan.fileRemovedWhy", ["who": who(p)])
        let note = hstack([Icon("lock", "you", size: 13), label(t(ticked ? "plan.fileTicked" : "plan.fileRemoved"), Fonts.pt(12.5, .semibold), "you"), spring()], spacing: 6)
        note.setAccessibilityElement(true)
        note.setAccessibilityLabel(t(ticked ? "plan.fileTicked" : "plan.fileRemoved"))
        let reopen = RButton(t(ticked ? "plan.reopen" : "plan.putBack"), .primary) { [weak self] in
            self?.post("reopen") { j in self?.toast?(t("plan.reopened") + ((j["via"] as? String) == "brief" ? " " + t("plan.briefOnly") : "")) }
        }
        let confirm = RButton(t(ticked ? "plan.confirmPassed" : "plan.confirmOut")) { [weak self] in
            self?.post("confirm") { _ in self?.toast?(t("plan.confirmed")) }
        }
        reopen.isEnabled = busy.isEmpty; confirm.isEnabled = busy.isEmpty
        buttons["reopen"] = reopen; buttons["confirm"] = confirm
        return secBox(t("plan.waits"), [note, wrap(md: g["question"] as? String ?? words, Fonts.pt(13, .semibold)),
                                         wrap(t("plan.yourWords", ["text": lower]), Fonts.pt(12), "tx2"), wrap(why, Fonts.pt(12.5), "tx2"),
                                         acts([reopen, confirm])], ring: "you")
    }

    private func post(_ what: String, _ body: [String: Any] = [:], done: (([String: Any]) -> Void)? = nil) {
        var b = body; b["projectId"] = project
        act(what, "/api/plan/\(what)", b, done: done)
    }

    // MARK: a new plan

    private func drawNew(_ p: HubProject?) {
        let name = p?.name ?? project
        let d = draftFor == project ? draft : nil
        let change = d?["mode"] as? String == "change"
        if change { setHead(title: t("newplan.changeTitle"), src: t("newplan.changeSrc", ["name": name])) }
        else { setHead(title: t("panel.newPlan"), src: t("newplan.src", ["name": name])) }
        let steps = d?["steps"] as? [[String: Any]] ?? []
        let busyD = d?["busy"] as? [String: Any]
        let sig = "new|\(project)|\(busy)|\(own)|\(commentFor ?? "")|\(dropAsk)|\(d.map { stableText($0) } ?? "-")|\(p?.brief.map { stableText($0["plan"]) + stableText($0["goal"]) } ?? "")"
        draw(sig) {
            if let bz = busyD {
                let who = Assistants.short(bz["who"] as? String)
                let stop = RButton(t("newplan.stop")) { [weak self] in self?.post("halt") }
                stop.isEnabled = busy.isEmpty; buttons["stop"] = stop
                var rows: [NSView] = []
                if let th = thread(d) { rows.append(th) }
                rows += [secBox(nil, [wrap(t(bz["what"] as? String == "revise" ? "newplan.revising" : "newplan.drafting", ["who": who]), Fonts.pt(12.5))]), acts([stop])]
                return rows
            }
            if let d, !steps.isEmpty { return draftRows(d, steps, change: change, p) }
            if own { return ownRows(d) }
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
            let ownB = RButton(t("newplan.ownSwitch"), .link) { [weak self] in self?.own = true; self?.redraw(); self?.focus("own") }
            buttons["draft"] = draftB; buttons["cancel"] = cancel; buttons["ownMode"] = ownB
            var rows: [NSView] = [
                vstack([label(t("newplan.what"), Fonts.pt(12, Fonts.w650), "tx2"), f], spacing: 6),
                vstack([label(t("newplan.from"), Fonts.pt(12, Fonts.w650), "tx2"), from], spacing: 6),
            ]
            if let e = d?["error"] as? String, !e.isEmpty { rows.append(wrap(e, Fonts.pt(12.5), "bad")) }
            rows.append(acts([draftB, cancel, label(t("newplan.readFirst"), Fonts.pt(12), "tx3")]))
            rows.append(acts([ownB]))
            return rows
        }
    }

    /// The keyboard in a field once it is drawn.
    private func focus(_ id: String) {
        DispatchQueue.main.async { [weak self] in if let f = self?.fields[id]?.field { self?.window?.makeFirstResponder(f) } }
    }

    /// Write the plan yourself: the person's own words, which the planner turns into steps.
    private func ownRows(_ d: [String: Any]?) -> [NSView] {
        let f = field("own", t("newplan.ownPh"), area: true, height: 140)
        let go = RButton(t("newplan.turnIntoSteps"), .primary) { [weak self] in
            guard let self else { return }
            if self.need("own", t("newplan.writeFirst")) { return }
            self.post("own", ["text": self.typed("own")]) { _ in self.clear("own") }
        }
        go.isEnabled = busy.isEmpty
        let back = RButton(t("newplan.letDraft", ["who": printWho]), .link) { [weak self] in self?.own = false; self?.redraw(); self?.focus("goal") }
        let cancel = RButton(t("newplan.cancel")) { [weak self] in self?.onClose?() }
        buttons["own"] = go; buttons["goalMode"] = back; buttons["cancel"] = cancel
        var rows: [NSView] = [vstack([label(t("newplan.own"), Fonts.pt(12, Fonts.w650), "tx2"), f, wrap(t("newplan.ownHint", ["who": printWho]), Fonts.pt(12), "tx3")], spacing: 6)]
        if let e = d?["error"] as? String, !e.isEmpty { rows.append(wrap(e, Fonts.pt(12.5), "bad")) }
        rows.append(acts([go, cancel, label(t("newplan.readFirst"), Fonts.pt(12), "tx3")]))
        rows.append(acts([back]))
        return rows
    }

    /// What was said while planning: the person's words, the planner's replies.
    private func thread(_ d: [String: Any]?) -> NSView? {
        let th = (d?["thread"] as? [[String: Any]] ?? []).filter { !($0["local"] as? Bool ?? false) }
        if th.isEmpty { return nil }
        let rows: [NSView] = th.map { m in
            let text = m["text"] as? String ?? ""
            if m["who"] as? String == "you" { return CappedText(text, Fonts.pt(12.5), "tx", maxW: 560, fill: "card2") }
            let revised = m["revised"] as? Bool ?? false
            let body = revised ? "**\(t("newplan.revised"))** " + text.replacingOccurrences(of: "^Revised\\.\\s*", with: "", options: [.regularExpression, .caseInsensitive]) : text
            return wrap(md: body, Fonts.pt(12.5), "tx2")
        }
        return secBox(t("newplan.talk"), rows)
    }

    /// A draft: what was said, the steps (each with its comment), the questions, bigger changes, Start.
    private func draftRows(_ d: [String: Any], _ steps: [[String: Any]], change: Bool, _ p: HubProject?) -> [NSView] {
        var rows: [NSView] = []
        if let th = thread(d) { rows.append(th) }
        let goal = (d["goal"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        rows.append(secBox(t(change ? "newplan.thePlan" : "newplan.draft"), [label(d["title"] as? String ?? t("panel.plan"), Fonts.pt(12.5, .bold)), goal.map { wrap(md: t("plan.quoted", ["text": $0]), Fonts.pt(12), "tx2") }]))
        let marks = d["marks"] as? [String: Any] ?? [:]
        rows.append(vstack(steps.enumerated().map { i, s in stepWithComment(s, i + 1, mark: marks[s["id"] as? String ?? ""] as? String) }, spacing: 2))
        for (qi, q) in (d["questions"] as? [[String: Any]] ?? []).enumerated() {
            let ans = q["answer"] as? String
            let opts = (q["options"] as? [String] ?? []).enumerated().map { oi, o in
                let b = RButton(o, ans == o ? .primary : .normal) { [weak self] in self?.post("edit", ["answer": ["id": q["id"] as? String ?? "", "option": o]]) }
                b.isEnabled = busy.isEmpty; b.setAccessibilityValue(ans == o); buttons["q\(qi)o\(oi)"] = b; return b
            }
            rows.append(secBox(t("newplan.question"), [wrap(q["text"] as? String ?? "", Fonts.pt(12.5)), acts(opts)]))
        }
        if let e = d["error"] as? String, !e.isEmpty { rows.append(wrap(e, Fonts.pt(12.5), "bad")) }
        // Bigger changes, in words.
        let chat = field("chat", t(change || !marks.isEmpty ? "newplan.chatPhMore" : "newplan.chatPh"), area: true, height: 52)
        let send = RButton(t("newplan.chatSend")) { [weak self] in
            guard let self else { return }
            if self.need("chat", t("newplan.sayChangeFirst")) { return }
            self.post("revise", ["message": self.typed("chat")]) { _ in self.clear("chat") }
        }
        send.isEnabled = busy.isEmpty
        buttons["chat"] = send
        let bar = NSStackView(views: [chat, send])
        bar.orientation = .horizontal; bar.alignment = .bottom; bar.spacing = 10
        rows.append(bar)
        let pid = project
        let start = RButton(t(change ? "newplan.saveChanges" : "newplan.start"), .primary) { [weak self] in
            guard let self else { return }
            self.post("start") { j in
                if change { self.toast?((j["via"] as? String) == "brief" ? t("newplan.changedBrief") : t("newplan.changed", ["name": p?.name ?? pid])) }
                else { self.toast?(t("newplan.started")) }
                self.openPlan?(pid)
            }
        }
        start.isEnabled = busy.isEmpty && (d["canStart"] as? Bool ?? false)
        let discard = RButton(t("newplan.discard")) { [weak self] in self?.post("discard") }
        discard.isEnabled = busy.isEmpty
        buttons["start"] = start; buttons["discard"] = discard
        let open = (d["openQuestions"] as? NSNumber)?.intValue ?? 0
        let foot = open > 0 ? t("newplan.answerFirst") : commentFor != nil ? t("newplan.footComment", ["who": printWho]) : t(change ? "newplan.footChange" : "newplan.footNew")
        rows.append(acts([start, discard, label(foot, Fonts.pt(12), "tx3")]))
        if !change {
            if dropAsk {
                let yes = RButton(t("newplan.dropIt"), .primary) { [weak self] in
                    guard let self else { return }
                    self.post("discard") { _ in self.dropAsk = false; self.own = true; self.dirty(); self.redraw(); self.focus("own") }
                }
                let no = RButton(t("newplan.keepIt")) { [weak self] in self?.dropAsk = false; self?.redraw() }
                yes.isEnabled = busy.isEmpty
                buttons["dropIt"] = yes; buttons["keepIt"] = no
                rows.append(secBox(nil, [wrap(t("newplan.dropDraft"), Fonts.pt(12.5), "tx2"), acts([yes, no])]))
            } else {
                let mine = RButton(t("newplan.writeItYourself"), .link) { [weak self] in self?.dropAsk = true; self?.redraw() }
                buttons["writeOwn"] = mine
                rows.append(acts([mine]))
            }
        }
        return rows
    }

    /// A draft step: its box and words, Added or Updated, its branches and choices, and a comment on it.
    private func stepWithComment(_ s: [String: Any], _ n: Int, mark: String?) -> NSView {
        let kind = s["kind"] as? String ?? "do"
        let kw = ["do", "done", "branch", "gate"].contains(kind) ? t("plan.kind.\(kind)") : t("plan.kind.do")
        let locked = s["locked"] as? Bool ?? false
        var sub: [String] = []
        if let dt = s["detail"] as? String, !dt.isEmpty { sub.append(dt) }
        for a in s["arms"] as? [[String: Any]] ?? [] { sub.append(t("newplan.armIf", ["if": a["if"] as? String ?? "", "then": a["then"] as? String ?? ""])) }
        if kind == "gate", let ch = s["choices"] as? [String], !ch.isEmpty, (s["rule"] as? String ?? "").isEmpty { sub.append(t("newplan.choices", ["list": ch.joined(separator: ", or ")])) }
        if locked { sub.append(t("newplan.locked")) }
        let row = stepRow(t("plan.step", ["kind": kw, "text": s["text"] as? String ?? ""]), sub: sub, done: locked, now: false)
        // The step takes the room; Added or Updated and Comment sit at the right, on its first line.
        row.setContentHuggingPriority(.init(1), for: .horizontal)
        let id = s["id"] as? String ?? ""
        var line: [NSView?] = [row, spring()]
        let atTop = { (v: NSView) in hstack([v], spacing: 0, insets: NSEdgeInsets(top: 7, left: 0, bottom: 0, right: 0)) }
        if let m = mark { line.append(atTop(pill(t(m == "add" ? "newplan.added" : "newplan.updated"), "work"))) }
        if !locked {
            let c = RButton(t("newplan.comment"), .link) { [weak self] in
                guard let self else { return }
                self.commentFor = self.commentFor == id ? nil : id
                self.clear("comment")
                self.redraw()
                if self.commentFor != nil { self.focus("comment") }
            }
            c.setAccessibilityLabel(t("newplan.commentOn", ["n": "\(n)"]))
            c.isEnabled = busy.isEmpty
            buttons["comment:\(id)"] = c
            line.append(atTop(c))
        }
        let top = hstack(line, spacing: 8)
        top.alignment = .top
        guard commentFor == id else { return top }
        let f = field("comment", t("newplan.commentPh"), area: true, height: 52)
        let add = RButton(t("newplan.addComment"), .primary, small: true) { [weak self] in
            guard let self else { return }
            if self.need("comment", t("newplan.commentFirst")) { return }
            let text = self.typed("comment")
            self.commentFor = nil
            self.post("revise", ["comment": ["step": id, "text": text]]) { _ in self.clear("comment") }
        }
        let cancel = RButton(t("brief.noteCancel"), small: true) { [weak self] in self?.commentFor = nil; self?.clear("comment"); self?.redraw() }
        add.isEnabled = busy.isEmpty
        buttons["commentAdd"] = add; buttons["commentCancel"] = cancel
        return vstack([top, hstack([f], spacing: 0, insets: NSEdgeInsets(top: 4, left: 28, bottom: 0, right: 0)), hstack([spring(), cancel, add], spacing: 8)], spacing: 6)
    }
}
