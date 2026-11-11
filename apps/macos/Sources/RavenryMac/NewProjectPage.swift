// New project (SESS-023): its folder, its brief and a first session, as
// the hub's browser board makes one (hub/public/app.js openModal,
// renderFolder, submitModal; docs/design/NewProjectFolder.dc.html), with
// the same fields and words: Name, Folder (New folder, or Existing: the
// folders the board knows, or any folder chosen in Finder's dialog),
// Assistant, Kind, Goal, Done means, First milestones and Rules. Start
// posts POST /api/project/new; the hub writes the brief and opens the
// first session, and the window shows the project once the board lists it.
//
// From a folder (SESS-022, "New project from this folder"): a shell's
// folder that no project uses (the shell panel), or the folder of a
// session that is in no project (the panel's Not in a project card, whose
// cmux workspace then joins the project and nothing new is opened).
//
// From an idea (IDEA-006, the idea's Promote to project): its name, pitch
// as the goal and the Greenlit stage filled in; Start sends its id, and the
// hub moves the idea to the archive as promoted.
//
// Write the brief (BRIEF-006): the same form for a project that has none,
// without the name, folder and assistant (openModal's mode 'brief'): POST
// /api/project/brief writes it in the project's folder; nothing is started.
//
// Also here: Board.wirePanel, the hooks of the panel's checkpoints from
// this window's daemons (LocalCheckpoints.swift) and of New project.

import AppKit

final class NewProjectPage: FormPage {
    /// The folder a project starts from: a shell's, or a session's in no project (its cmux workspace joins the project).
    struct From {
        let name: String
        let folder: String
        let folderShort: String
        var workspaceId: String? = nil
        var assistant: String? = nil
        var shell = false
    }
    private(set) var from: From?
    /// Write the brief: the project that has none (the form's brief mode).
    private(set) var briefFor: HubProject?
    /// From an idea: its id, sent with Start, and the stage its brief starts at.
    private(set) var ideaId: String?
    private var ideaName: String?
    private var stage: String?
    /// The brief was written: the project's id (its brief opens).
    var onBrief: ((String) -> Void)?
    private var state: HubState?
    private var meta: [String: Any]?
    /// GET /api/project/folders: folders, ids, taken, projectsRoot.
    private(set) var known: [String: Any]?
    private var knownFailed = false
    /// "new" or "existing".
    private(set) var folderMode = "new"
    /// The existing folder picked (its full path).
    private(set) var pick: String?
    /// Folders chosen in Finder's dialog this time, first.
    private var finder: [[String: Any]] = []
    private var showAll = false
    /// "Change for this one": another parent for this project's new folder.
    private var parent: (folder: String, short: String, taken: [String])?
    private(set) var kind: String? = "Web game"
    private(set) var assistant = "claude"
    private var asDefault = "claude"
    private(set) var error: String?
    private(set) var starting = false
    /// The hub's answer to Start, for the self-test.
    private(set) var made: [String: Any]?
    /// The project was made: its id and the hub's answer.
    var onMade: ((String, [String: Any]) -> Void)?
    /// Finder's own dialog for a folder (true: the parent of a new one); the self-test answers it.
    lazy var chooseFolder: (Bool, @escaping (String?) -> Void) -> Void = { [weak self] parent, done in
        let p = NSOpenPanel()
        p.canChooseFiles = false
        p.canChooseDirectories = true
        p.canCreateDirectories = true
        p.allowsMultipleSelection = false
        p.prompt = parent ? t("np.chooseHere") : t("np.choose")
        if let w = self?.window { p.beginSheetModal(for: w) { r in done(r == .OK ? p.url?.path : nil) } }
        else if options.offscreen { done(nil) } // never a panel on the screen of a run off every screen
        else { p.begin { r in done(r == .OK ? p.url?.path : nil) } }
    }
    private(set) var segFolder: NSSegmentedControl?
    private(set) var segAssistant: NSSegmentedControl?
    private(set) var folderRows: [String: Box] = [:]

    static let kinds = ["Web game", "VR", "Unity", "Unreal", "App", "Website", "Tool or CLI", "Research", "Something else"]

    /// Write the brief for a project that has none.
    func show(brief p: HubProject, state st: HubState?) {
        show(from: nil, state: st)
        briefFor = p
        kind = nil
        dirty(); redraw()
        DispatchQueue.main.async { [weak self] in
            guard let self, let f = self.fields["goal"] else { return }
            self.window?.makeFirstResponder(f.field)
        }
    }

    /// New project from an idea: its name, its pitch as the goal, Greenlit.
    func show(idea id: String, name: String, pitch: String, state st: HubState?) {
        show(from: nil, state: st)
        ideaId = id; ideaName = name; stage = "Greenlit"
        field("name", t("np.namePh")).text = name
        field("goal", t("np.goalPh"), area: true, height: 64).text = pitch
        dirty(); redraw()
    }

    func show(from f: From?, state st: HubState?) {
        from = f
        briefFor = nil; ideaId = nil; ideaName = nil; stage = nil
        state = st
        let starts = (st?.raw["assistants"] as? [String: Any])?["startWith"] as? String
        asDefault = starts == "codex" ? "codex" : "claude"
        assistant = f?.assistant.map { $0.contains("codex") ? "codex" : "claude" } ?? asDefault
        folderMode = f != nil ? "existing" : "new"
        kind = "Web game"; pick = nil; parent = nil; finder = []; showAll = false; error = nil; made = nil; starting = false
        for k in ["name", "kindText", "goal", "doneMeans", "milestones", "rules"] { clear(k) }
        // "kite-tracker" -> "Kite Tracker".
        if let f {
            let words = f.name.replacingOccurrences(of: "[-_.]+", with: " ", options: .regularExpression).split(separator: " ")
            field("name", t("np.namePh")).text = words.map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
        }
        dirty()
        scroll.contentView.scroll(to: .zero)
        load()
        redraw()
        DispatchQueue.main.async { [weak self] in
            guard let self, let f = self.fields["name"] else { return }
            self.window?.makeFirstResponder(f.field)
        }
    }

    override func load() {
        guard let hub else { return }
        hub.get("/api/meta") { [weak self] code, j in
            guard let self else { return }
            self.meta = code == 200 ? j : ["kinds": NewProjectPage.kinds, "globalRules": [], "projectsRoot": "~/Projects"]
            self.redraw()
        }
        hub.get("/api/project/folders") { [weak self] code, j in
            guard let self else { return }
            if code == 200 { self.known = j; self.knownFailed = false } else { self.known = ["folders": [], "ids": [], "taken": []]; self.knownFailed = true }
            self.redraw()
        }
    }

    // MARK: what the form says

    static func slugify(_ s: String) -> String {
        let d = s.lowercased().decomposedStringWithCompatibilityMapping
        let x = d.replacingOccurrences(of: "[^A-Za-z0-9_]+", with: "-", options: .regularExpression)
            .replacingOccurrences(of: "^-+|-+$", with: "", options: .regularExpression)
        return x.isEmpty ? "project" : x
    }
    private static func joinNames(_ a: [String]) -> String { a.count <= 1 ? a.joined() : a.dropLast().joined(separator: ", ") + " and " + a.last! }
    private func tilde(_ p: String) -> String {
        let h = NSHomeDirectory()
        return p == h ? "~" : p.hasPrefix(h + "/") ? "~" + p.dropFirst(h.count) : p
    }
    /// The board's terminal by name ("cmux", "Ravenry") and where Start puts the first session.
    private var boardTerm: String { (state?.raw["board"] as? [String: Any])?["name"] as? String ?? "cmux" }
    private var newPlace: String { boardTerm == "Rex" ? t("np.placeRex") : boardTerm == "cmux" ? t("np.placeCmux") : t("np.placeTab", ["term": boardTerm]) }
    private var who: String { assistant == "codex" ? "Codex" : "Claude" }
    private var root: String { known?["projectsRoot"] as? String ?? meta?["projectsRoot"] as? String ?? "~/Projects" }

    private func folderList() -> [[String: Any]] {
        let fs = (known?["folders"] as? [[String: Any]] ?? []).filter { e in !finder.contains { $0["folder"] as? String == e["folder"] as? String } }
        return finder + fs
    }
    private func picked() -> [String: Any]? { pick.flatMap { p in folderList().first { $0["folder"] as? String == p } } }

    /// The id the hub will give this name (registry.uniqueId), for the brief file name in a shared folder.
    private func idFor(_ name: String) -> String {
        let ids = Set(known?["ids"] as? [String] ?? [])
        let base = NewProjectPage.slugify(name)
        var id = base, k = 2
        while ids.contains(id) { id = "\(base)-\(k)"; k += 1 }
        return id
    }

    /// A folder chosen in Finder's dialog, as the hub's folderEntry says one.
    private func entry(_ path: String) -> [String: Any] {
        let users = (state?.projects ?? []).filter { p in p.folder.map { URL(fileURLWithPath: $0).standardizedFileURL.path == URL(fileURLWithPath: path).standardizedFileURL.path } ?? false }.map(\.name)
        let parent = (path as NSString).deletingLastPathComponent
        return ["folder": path, "short": tilde(path), "name": (path as NSString).lastPathComponent, "parent": tilde(parent), "projects": users,
                "hasBrief": FileManager.default.fileExists(atPath: (path as NSString).appendingPathComponent("BRIEF.md")), "fromFinder": true]
    }

    /// The folders in a parent that already have files (a new folder of that name would not be empty).
    private static func taken(in dir: String) -> [String] {
        let fm = FileManager.default
        return ((try? fm.contentsOfDirectory(atPath: dir)) ?? []).filter { n in
            var isDir: ObjCBool = false
            let p = (dir as NSString).appendingPathComponent(n)
            guard fm.fileExists(atPath: p, isDirectory: &isDir), isDir.boolValue else { return false }
            return ((try? fm.contentsOfDirectory(atPath: p)) ?? []).contains { $0 != ".DS_Store" }
        }
    }

    // MARK: drawing

    override func redraw() {
        if let b = briefFor { setHead(title: t("np.briefTitle", ["name": b.name]), src: b.folderShort) }
        else { setHead(title: t("np.title"), src: from.map { t($0.shell ? "np.srcShell" : "np.srcFrom", ["name": $0.name]) } ?? ideaName.map { t("np.fromIdea", ["name": $0]) }) }
        let name = typed("name")
        let slug = name.isEmpty ? "" : NewProjectPage.slugify(name)
        let sig = [folderMode, pick ?? "", slug, "\(finder.count)", "\(showAll)", parent?.folder ?? "", kind ?? "", assistant, error ?? "", "\(starting)",
                   "\(known != nil)", "\(meta != nil)", "\((known?["folders"] as? [Any])?.count ?? 0)", from?.folder ?? "", briefFor?.id ?? "", ideaId ?? ""].joined(separator: "|")
        draw(sig) { rows(name: name, slug: slug) }
    }

    private func titled(_ title: String, _ views: [NSView?]) -> NSView {
        vstack([label(title, Fonts.pt(12.5, Fonts.w650), "tx2")] + views, spacing: 6)
    }

    private func seg(_ labels: [String], _ on: Int, _ run: @escaping (Int) -> Void) -> NSSegmentedControl {
        let s = NSSegmentedControl(labels: labels, trackingMode: .selectOne, target: PopTarget.shared, action: #selector(PopTarget.segmented(_:)))
        s.selectedSegment = on
        s.font = Fonts.pt(12.5)
        PopTarget.shared.run[ObjectIdentifier(s)] = { [weak s] in if let s { run(s.selectedSegment) } }
        return s
    }

    private func rows(name: String, slug: String) -> [NSView] {
        if briefFor != nil { return briefRows() }
        let nameF = field("name", t("np.namePh"))
        nameF.onChange = { [weak self] in self?.redraw() }
        var out: [NSView] = [titled(t("np.name"), [nameF])]

        // Folder: New folder | Existing.
        let sf = seg([t("np.newFolder"), t("np.existing")], folderMode == "new" ? 0 : 1) { [weak self] i in
            guard let self else { return }
            self.folderMode = i == 0 ? "new" : "existing"
            self.redraw()
        }
        sf.setAccessibilityLabel(t("np.folder"))
        segFolder = sf
        out.append(titled(t("np.folder"), [hstack([sf, spring()], spacing: 0)] + folderBody(slug: slug)))

        // Assistant: Claude | Codex.
        let sa = seg(["Claude", "Codex"], assistant == "codex" ? 1 : 0) { [weak self] i in
            self?.assistant = i == 1 ? "codex" : "claude"
            self?.redraw()
        }
        sa.setAccessibilityLabel(t("np.assistant"))
        segAssistant = sa
        let asHint = (from != nil && from?.assistant != nil ? t("np.asFrom") : t("np.asDefault")) + " " + t("np.asUses")
        out.append(titled(t("np.assistant"), [hstack([sa, spring()], spacing: 0), wrap(asHint, Fonts.pt(12), "tx3")]))

        out += briefFields()
        if let e = error { out.append(wrap(e, Fonts.pt(12.5), "bad")) }
        let fromHere = from != nil && folderMode == "existing"
        let goTitle = starting ? t("np.starting") : fromHere && from?.workspaceId != nil ? t("np.create") : t("np.start", ["term": boardTerm])
        let go = RButton(goTitle, .primary) { [weak self] in self?.submit() }
        go.isEnabled = !starting
        buttons["go"] = go
        let foot = wrap(footText(name: name, slug: slug), Fonts.pt(12.5), "tx2")
        let row = hstack([foot, go], spacing: 12)
        row.alignment = .centerY
        out.append(row)
        return out
    }

    /// Write the brief: the brief's fields, where it goes, and Write the brief.
    private func briefRows() -> [NSView] {
        var out = briefFields()
        if let e = error { out.append(wrap(e, Fonts.pt(12.5), "bad")) }
        let go = RButton(starting ? t("np.writing") : t("np.writeBrief"), .primary) { [weak self] in self?.submit() }
        go.isEnabled = !starting
        buttons["go"] = go
        let row = hstack([wrap(t("np.briefFoot", ["path": briefWhere]), Fonts.pt(12.5), "tx2"), go], spacing: 12)
        row.alignment = .centerY
        out.append(row)
        return out
    }

    /// Where Write the brief puts it, as the board says it (briefExpected, else the folder's BRIEF.md or its own in a shared folder).
    private var briefWhere: String {
        guard let p = briefFor else { return "BRIEF.md" }
        if let w = p.s("briefExpected") { return w }
        let shared = !(p.raw["shared"] as? [Any] ?? []).isEmpty
        return "\(p.folderShort ?? p.folder ?? "")/\(shared ? "BRIEF-\(p.id).md" : "BRIEF.md")"
    }

    /// Kind, Goal, Done means, First milestones and Rules: a new project's brief, and a brief written later.
    private func briefFields() -> [NSView] {
        var out: [NSView] = []
        // Kind: one of the hub's, or in the person's own words.
        let kinds = meta?["kinds"] as? [String] ?? NewProjectPage.kinds
        let chips = kinds.map { k -> (NSView, NSSize) in
            let b = RButton(k, kind == k ? .primary : .normal, small: true) { [weak self] in
                guard let self else { return }
                self.kind = self.kind == k ? nil : k
                self.redraw()
            }
            b.setAccessibilityValue(kind == k)
            buttons["kind:\(k)"] = b
            return (b, b.intrinsicContentSize)
        }
        out.append(titled(t("np.kind"), [WrapRow(chips, gap: 6), field("kindText", t("np.kindTextPh"))]))

        out.append(titled(t("np.goal"), [field("goal", t("np.goalPh"), area: true, height: 64)]))
        out.append(titled(t("np.doneMeans"), [field("doneMeans", t("np.doneMeansPh"), area: true, height: 64)]))
        out.append(titled(t("np.milestones"), [field("milestones", t("np.milestonesPh"), area: true, height: 76)]))
        let globals = (meta?["globalRules"] as? [String] ?? []).map { r -> (NSView, NSSize) in
            let p = pill(r, nil)
            return (p, p.fittingSize)
        }
        var rulesRows: [NSView?] = []
        if !globals.isEmpty {
            let w = WrapRow(globals, gap: 5)
            w.toolTip = t("np.globalTip", ["path": meta?["globalPath"] as? String ?? "~/.claude/CLAUDE.md"])
            rulesRows.append(w)
        }
        rulesRows.append(field("rules", t("np.rulesPh"), area: true, height: 52))
        out.append(titled(t("np.rules"), rulesRows))
        return out
    }

    /// The line beside Start: what it makes and where the session opens.
    private func footText(name: String, slug: String) -> String {
        if folderMode == "new" { return t("np.footNew", ["slug": slug.isEmpty ? t("np.theFolder") : slug, "place": newPlace, "who": who]) }
        if let f = from {
            if f.workspaceId != nil { return t("np.footFrom", ["name": f.name]) }
            let shared = (state?.projects ?? []).contains { $0.folder == f.folder } || FileManager.default.fileExists(atPath: (f.folder as NSString).appendingPathComponent("BRIEF.md"))
            return t("np.footExisting", ["brief": shared ? "BRIEF-\(idFor(name.isEmpty ? "project" : name)).md" : "BRIEF.md", "name": (f.folder as NSString).lastPathComponent, "place": newPlace, "who": who])
        }
        if let p = picked() {
            let users = p["projects"] as? [String] ?? []
            let brief = !users.isEmpty || (p["hasBrief"] as? Bool ?? false) ? "BRIEF-\(idFor(name.isEmpty ? "project" : name)).md" : "BRIEF.md"
            return t("np.footExisting", ["brief": brief, "name": p["name"] as? String ?? "", "place": newPlace, "who": who])
        }
        return t("np.footPick", ["place": newPlace, "who": who])
    }

    private func pathLine(_ head: String, _ last: String, link: RButton? = nil) -> NSView {
        let a = NSMutableAttributedString(string: head, attributes: [.font: Fonts.mono(12), .foregroundColor: Design.color("tx3")])
        a.append(NSAttributedString(string: last, attributes: [.font: Fonts.mono(12), .foregroundColor: Design.color("tx")]))
        let l = label("", Fonts.mono(12), "tx", lines: 2)
        l.attributedStringValue = a
        l.lineBreakMode = .byCharWrapping
        let inner = hstack([l, spring(), link], spacing: 8)
        return boxed(inner, fill: "input", ring: "sep", radius: 7, insets: NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10))
    }

    private func folderBody(slug: String) -> [NSView] {
        if folderMode == "new" {
            let par = parent?.short ?? root
            let takenList = parent?.taken ?? (known?["taken"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }
            let taken = !slug.isEmpty && takenList.contains(slug)
            let link = RButton(parent != nil ? t("np.backDefault") : t("np.changeOne"), .link) { [weak self] in
                guard let self else { return }
                if self.parent != nil { self.parent = nil; self.redraw(); return }
                self.chooseFolder(true) { [weak self] path in
                    guard let self, let p = path else { return }
                    self.parent = (p, self.tilde(p), NewProjectPage.taken(in: p))
                    self.redraw()
                }
            }
            buttons["parent"] = link
            var out: [NSView] = [pathLine(par + "/", slug.isEmpty ? "..." : slug, link: link)]
            if taken {
                let use = RButton(t("np.pickIt"), .link) { [weak self] in self?.useTaken(slug) }
                buttons["useTaken"] = use
                out.append(hstack([wrap(t("np.taken", ["slug": slug]), Fonts.pt(12), "you"), use, spring()], spacing: 4))
            } else {
                out.append(wrap(parent != nil ? t("np.hintParent", ["root": root]) : t("np.hintNew"), Fonts.pt(12), "tx3"))
            }
            return out
        }
        if let f = from {
            // From a folder: that folder, whole, and what joining means.
            let s = f.folderShort.isEmpty ? f.folder : f.folderShort
            let cut = s.range(of: "/", options: .backwards).map { s.distance(from: s.startIndex, to: $0.upperBound) } ?? 0
            return [pathLine(String(s.prefix(cut)), String(s.dropFirst(cut))),
                    wrap(f.workspaceId != nil ? t("np.fromHint", ["name": f.name]) : t("np.fromShellHint", ["name": f.name]), Fonts.pt(12), "tx3")]
        }
        let all = folderList()
        if pick == nil, let first = all.first?["folder"] as? String { pick = first }
        let fromFinder = all.filter { $0["fromFinder"] as? Bool ?? false }
        let rest = all.filter { !($0["fromFinder"] as? Bool ?? false) }
        var shown = showAll ? rest : Array(rest.prefix(6))
        if !shown.contains(where: { $0["folder"] as? String == pick }), let hid = rest.first(where: { $0["folder"] as? String == pick }) { shown.append(hid) }
        let more = rest.count - shown.count
        folderRows = [:]
        var list: [NSView] = []
        if known == nil { list.append(wrap(t("np.loadingFolders"), Fonts.pt(12), "tx3")) }
        else if all.isEmpty { list.append(wrap((knownFailed ? t("np.foldersFailed") : t("np.noFolders")) + " " + t("np.chooseBelow"), Fonts.pt(12), "tx3")) }
        for e in fromFinder + shown { list.append(folderRow(e)) }
        if more > 0 {
            let b = RButton(more == 1 ? t("np.moreFolder") : t("np.moreFolders", ["n": "\(more)"]), .link) { [weak self] in self?.showAll = true; self?.redraw() }
            buttons["moreFolders"] = b
            list.append(hstack([b, spring()], spacing: 0))
        }
        let choose = RButton(fromFinder.isEmpty ? t("np.chooseDots") : t("np.chooseAnother"), small: true) { [weak self] in
            self?.chooseFolder(false) { [weak self] path in
                guard let self, let p = path else { return }
                let e = self.entry(p)
                self.finder = [e] + self.finder.filter { $0["folder"] as? String != p }
                self.pick = p
                self.redraw()
            }
        }
        buttons["choose"] = choose
        var out: [NSView] = [vstack(list, spacing: 4), hstack([choose, label(t("np.chooseNote"), Fonts.pt(12), "tx3"), spring()], spacing: 8)]
        if let p = picked() {
            let users = p["projects"] as? [String] ?? []
            out.append(wrap(users.isEmpty ? t("np.noneUses") : t(users.count > 1 ? "np.useToo" : "np.usesToo", ["names": NewProjectPage.joinNames(users)]), Fonts.pt(12), "tx3"))
        }
        return out
    }

    /// A folder the board knows, as a radio row: its name, where it is when picked, who uses it.
    private func folderRow(_ e: [String: Any]) -> NSView {
        let folder = e["folder"] as? String ?? ""
        let on = folder == pick
        let dot = Box(fill: on ? "work" : nil, ring: on ? nil : "tx3", radius: 6.5)
        dot.ringWidth = 1.5
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.widthAnchor.constraint(equalToConstant: 13).isActive = true
        dot.heightAnchor.constraint(equalToConstant: 13).isActive = true
        // The parent folder gives up its room first (cut in its middle), then the names of who uses it; From Finder stays whole.
        let nameL = yields(label(e["name"] as? String ?? folder, Fonts.pt(13, on ? Fonts.w650 : .regular)), fill: false)
        nameL.setContentCompressionResistancePriority(.init(230), for: .horizontal)
        let parentL = on ? yields(label(t("np.inParent", ["parent": e["parent"] as? String ?? ""]), Fonts.pt(11.5), "tx3"), fill: false) : nil
        parentL?.lineBreakMode = .byTruncatingMiddle
        let col = vstack([nameL, parentL], spacing: 1)
        col.setContentCompressionResistancePriority(.init(200), for: .horizontal)
        let finderRow = e["fromFinder"] as? Bool ?? false
        let users = finderRow ? t("np.fromFinder") : NewProjectPage.joinNames(e["projects"] as? [String] ?? [])
        let whoL = finderRow ? fixedLabel(users, Fonts.pt(12), "tx3") : label(users, Fonts.pt(12), "tx3")
        whoL.lineBreakMode = .byTruncatingTail
        if !finderRow { whoL.setContentCompressionResistancePriority(.init(240), for: .horizontal) }
        let row = hstack([dot, col, spring(), whoL], spacing: 9, insets: NSEdgeInsets(top: 7, left: 10, bottom: 7, right: 10))
        let b = PressBox(fill: on ? "sel" : "input", ring: on ? "selring" : "sep", radius: 7)
        b.addSubview(row)
        row.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([row.leadingAnchor.constraint(equalTo: b.leadingAnchor), row.trailingAnchor.constraint(equalTo: b.trailingAnchor),
                                     row.topAnchor.constraint(equalTo: b.topAnchor), row.bottomAnchor.constraint(equalTo: b.bottomAnchor)])
        b.onPress = { [weak self] in self?.pick = folder; self?.redraw() }
        b.setAccessibilityRole(.radioButton)
        b.setAccessibilityLabel(e["name"] as? String ?? folder)
        b.setAccessibilityValue(on)
        folderRows[folder] = b
        return b
    }

    /// "Pick it under Existing": the folder the name makes, which already has files.
    private func useTaken(_ slug: String) {
        let par = parent?.folder ?? root.replacingOccurrences(of: "^~", with: NSHomeDirectory(), options: .regularExpression)
        let full = (par as NSString).appendingPathComponent(slug)
        if let k = folderList().first(where: { ($0["folder"] as? String) == full || ($0["short"] as? String) == tilde(full) }) { pick = k["folder"] as? String }
        else {
            var e = entry(full)
            e["fromFinder"] = false
            var k = known ?? [:]
            k["folders"] = [e] + (k["folders"] as? [[String: Any]] ?? [])
            known = k
            pick = full
        }
        folderMode = "existing"
        redraw()
    }

    /// Selects a folder row (the self-test).
    func choose(folder: String) { pick = folder; folderMode = "existing"; redraw() }

    // MARK: Start

    func submit() {
        guard !starting, let hub else { return }
        if let b = briefFor { writeBrief(b, hub); return }
        let name = typed("name")
        func say(_ e: String, _ k: String?) {
            error = e
            redraw()
            if let k, let f = fields[k] { window?.makeFirstResponder(f.field) }
        }
        if name.isEmpty { say(t("np.needName"), "name"); return }
        if typed("goal").isEmpty { say(t("np.needGoal"), "goal"); return }
        let fromHere = from != nil && folderMode == "existing"
        let existing: String? = fromHere ? from?.folder : folderMode == "existing" ? picked()?["folder"] as? String : nil
        if folderMode == "existing" && existing == nil { say(t("np.needFolder"), nil); return }
        var body: [String: Any] = [:]
        for k in ["name", "kindText", "goal", "doneMeans", "milestones", "rules"] { body[k] = fields[k]?.text ?? "" }
        if let k = kind { body["kind"] = k }
        if let e = existing { body["existingFolder"] = e } else if let p = parent { body["parentFolder"] = p.folder }
        if fromHere, let w = from?.workspaceId { body["workspaceId"] = w }
        if let i = ideaId { body["ideaId"] = i }
        if let st = stage { body["stage"] = st }
        // From a folder the session's assistant is always sent; otherwise only when changed for this project.
        if from != nil || assistant != asDefault { body["assistant"] = assistant }
        error = nil
        starting = true
        redraw()
        hub.post("/api/project/new", body) { [weak self] code, j in
            guard let self else { return }
            self.starting = false
            guard code == 200, let id = j["id"] as? String else {
                self.error = j["error"] as? String ?? t("np.failed", ["code": "\(code)"])
                self.redraw()
                return
            }
            self.made = j
            let w = (j["assistant"] as? String) == "codex" ? "Codex" : "Claude"
            let said = (j["partial"] as? Bool ?? false) ? j["error"] as? String : j["message"] as? String
            self.toast?(said ?? t("np.made", ["name": name, "folder": j["folder"] as? String ?? "", "who": w, "where": j["workspaceRef"] as? String ?? self.boardTerm]))
            self.redraw()
            self.onMade?(id, j)
        }
    }
}

extension NewProjectPage {
    /// Write the brief: POST /api/project/brief with the brief's fields; its brief opens once written.
    private func writeBrief(_ p: HubProject, _ hub: HubClient) {
        if typed("goal").isEmpty {
            error = t("np.needGoal"); redraw()
            if let f = fields["goal"] { window?.makeFirstResponder(f.field) }
            return
        }
        var body: [String: Any] = ["projectId": p.id]
        for k in ["kindText", "goal", "doneMeans", "milestones", "rules"] { body[k] = fields[k]?.text ?? "" }
        if let k = kind { body["kind"] = k }
        error = nil
        starting = true
        redraw()
        hub.post("/api/project/brief", body) { [weak self] code, j in
            guard let self else { return }
            self.starting = false
            guard code == 200 else {
                self.error = j["error"] as? String ?? t("np.briefFailed", ["code": "\(code)"])
                self.redraw()
                return
            }
            self.made = j
            self.toast?(t("np.briefWritten", ["path": j["brief"] as? String ?? self.briefWhere]))
            self.redraw()
            self.onBrief?(p.id)
        }
    }
}

extension Board {
    /// The panel's checkpoints from this window's daemons (the board down
    /// from the start: no state to bring them), and New project's ways in.
    func wirePanel() {
        hub.onLocal = { [weak self] ids in
            guard let self else { return }
            for id in ids { if let cp = self.hub.checkpoint(id: id) { self.cpArrived(cp) } }
            self.render(force: true)
        }
        panel.host?.newProject = { [weak self] f in self?.openNewProject(f) }
        sidebar.onNewProject = { [weak self] in self?.topLevel { $0.openNewProject(nil) } }
        newProject.onMade = { [weak self] id, _ in self?.showMade(id, until: Date().addingTimeInterval(15)) }
    }

    /// The project just made, once the board lists it: its session (the first, starting), else its page.
    private func showMade(_ id: String, until: Date) {
        guard case .page(let k, _) = front, k == "newproject" || k.hasPrefix("promote:") else { return }
        if hub.state?.project(id) != nil { pickProject(id); return }
        guard Date() < until else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.showMade(id, until: until) }
    }
}
