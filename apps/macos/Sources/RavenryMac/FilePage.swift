// The sidebar's pages from page files (PAGE-001 to PAGE-010, IDEA-001,
// IDEA-002, IDEA-007), as the Electron app draws them (apps/desktop/src/
// renderer/pages.ts): Objectives, Plans, Ideas, Rules, Ship, and any page a
// person or a project added.
//
// What is drawn is the hub's answer to GET /api/pages/page?key=&tab= (its
// typed model, its last good version under a mistake, and `drawn`: each
// section's rows already filtered, sorted, limited and grouped, the tabs'
// counts and the stats, hub/server/pagedraw.mjs). The window runs nothing
// of the page format: a tab picked is sent (?tab=) and drawn when the hub
// answers, and every button posts the route the Electron app posts
// (item/set, archive with Undo, item/create from the form, item/toggle,
// ask with its approval, run, customize, trust, dismiss, the rules' and
// the repeats' routes, ideas add and brainstorm, sessions/close). The page
// is read again when its sidebar row's rev moves and after each write.

import AppKit
import CryptoKit

final class FilePage: FormPage {
    struct Host {
        var rows: () -> [NavPage]
        var pickSession: (String) -> Void
        /// A project by its id or its name: its session, else its page; false when there is none.
        var pickProject: (String) -> Bool
        var openPage: (String) -> Void
        var openPlan: (String, String?) -> Void
        var openIdea: (String) -> Void
        /// A project's brief, at an objective's heading when one is given.
        var openBrief: ((String, String?) -> Void)? = nil
        /// A checkpoint's approval card, by its id (a page's run button).
        var showCheckpoint: ((String) -> Void)? = nil
        /// The project of the session the person last had open (Ask Claude to fix).
        var lastProject: () -> String?
        var toast: (String, (String, () -> Void)?) -> Void
    }
    var host: Host?
    private(set) var key = ""
    private var cache: [String: (rev: String, view: [String: Any], sig: Int)] = [:]
    private var tabOf: [String: Int] = [:]
    private var loading = Set<String>()
    /// Lanes of a narrow board a person folded or unfolded, lanes showing all their notes.
    private var folded: [String: Bool] = [:]
    private var shown = Set<String>()
    private var dismissed = Set<String>()
    private var memory: (at: Date, rules: [[String: Any]])?
    /// The rules from project memory shown (Show), else folded behind their count.
    private(set) var memoryShown = false
    /// GET /api/ideas's brainstorm and brainstormError, for the brainstorm view's line (IDEA-009).
    private(set) var brainstormState: (at: Date, running: [String: Any]?, error: String?)?
    private var images: [String: NSImage] = [:]
    private var asked = Set<String>()
    /// Posts on their way; the self-test waits for none.
    private(set) var pending = 0
    /// What the self-test presses and reads: the page's buttons by name, rows by item, lanes by value.
    private(set) var pb: [String: NSView] = [:]
    private(set) var lanes: [(value: String?, view: Box)] = []
    private(set) var sheetView: NSView?
    private(set) var sheetKind = ""
    private var layoutSig = ""
    /// A view the self-test gave (apply): kept until another page is shown.
    private var held = false
    private var headSig = ""
    /// The board's note being dragged: its picture follows the pointer.
    private var ghost: NSImageView?

    var view: [String: Any]? { cache[key]?.view }
    var drawnTab: Int { (view?["drawn"] as? [String: Any])?["tab"] as? Int ?? 0 }

    // MARK: loading

    func show(_ k: String) {
        held = false
        if k != key { closeSheet(); dirty(); headSig = ""; scroll.contentView.scroll(to: .zero) }
        key = k
        redraw()
        let row = host?.rows().first { $0.key == k }
        if let c = cache[k] { if (row != nil && c.rev != row!.rev) || otherTab(k) { load(k) } } else { load(k) }
    }

    /// The hub's state came: the page is read again when its row's rev moved.
    func refresh() {
        guard !key.isEmpty, !held, let c = cache[key] else { return }
        if let r = host?.rows().first(where: { $0.key == key }), r.rev != c.rev || otherTab(key) { load(key) }
    }

    override func load() { if !key.isEmpty { load(key) } }

    func load(_ k: String) {
        guard let hub, !held else { return }
        let tab = tabOf[k] ?? 0
        let lk = "\(k)#\(tab)"
        if loading.contains(lk) { return }
        loading.insert(lk)
        hub.get("/api/pages/page?key=\(enc(k))&tab=\(tab)") { [weak self] code, j in
            guard let self else { return }
            self.loading.remove(lk)
            // An answer for a tab the person has since left is not drawn over the one they are on.
            if code == 200, let v = j["page"] as? [String: Any], (self.tabOf[k] ?? 0) == tab || self.cache[k] == nil {
                let rev = self.host?.rows().first { $0.key == k }?.rev ?? ""
                let sig = FilePage.signature(v)
                self.cache[k] = (rev, v, sig)
                if let d = v["drawn"] as? [String: Any], let dt = d["tab"] as? Int, dt != tab { self.tabOf[k] = dt }
            }
            if self.key == k { self.freshSheet(); self.redraw() }
        }
    }

    /// The item open in a sheet, by its section and file, with the hash it was drawn from.
    private var openedItem: (sec: [Int], file: String, hash: String)?

    /// The page was read again: an open item whose file changed (its own
    /// Fixed, an agent's edit) is drawn again from the new copy, so its
    /// fields say what the file says and its next button sends the new hash.
    private func freshSheet() {
        guard sheetKind == "item", let o = openedItem, let v = cache[key]?.view,
              let d = v["drawn"] as? [String: Any], (d["tab"] as? Int ?? 0) == o.sec[0],
              let ds = d["sections"] as? [[String: Any]], o.sec[1] < ds.count,
              let it = rowsOf(ds[o.sec[1]]).first(where: { PageFmt.text($0["file"]) == o.file }),
              PageFmt.text(it["$hash"]) != o.hash else { return }
        openSheet("item", itemSheet(v, it, o.sec))
        openedItem = (o.sec, o.file, PageFmt.text(it["$hash"]))
    }

    /// What a view says, as a number that changes with any of it: its JSON's
    /// SHA-256 (Data's own hash reads only its first 80 bytes, so a box
    /// ticked, todo to done, never drew).
    static func signature(_ v: [String: Any]) -> Int {
        let d = (try? JSONSerialization.data(withJSONObject: v, options: [.sortedKeys])) ?? Data()
        return SHA256.hash(data: d).prefix(8).reduce(0) { $0 << 8 | Int($1) }
    }

    /// The self-test's: a page view as the hub sends it, drawn as it is (never read again).
    func apply(_ k: String, _ v: [String: Any]) {
        held = true
        key = k
        cache[k] = ("held", v, FilePage.signature(v))
        headSig = ""
        redraw()
    }

    /// The self-test's: rules from project memory as GET /api/rules sends them, kept a minute.
    func holdMemory(_ rules: [[String: Any]]) { memory = (Date(), rules); dirty(); redraw() }

    private func otherTab(_ k: String) -> Bool {
        guard let d = cache[k]?.view["drawn"] as? [String: Any], let dt = d["tab"] as? Int else { return false }
        return dt != (tabOf[k] ?? 0)
    }

    /// The person picked tab `i`: the hub draws it; the tab on screen stays until it answers.
    func pickTab(_ i: Int) {
        if (tabOf[key] ?? 0) == i && !otherTab(key) && !held { return }
        held = false
        tabOf[key] = i
        load(key)
    }

    private func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? s }

    /// A post the person's click makes; its error said; the page read again after.
    private func send(_ path: String, _ body: [String: Any], fail: String?, reload: Bool = true, _ done: ((Int, [String: Any]) -> Void)? = nil) {
        guard let hub else { return }
        pending += 1
        let k = key
        hub.post(path, body) { [weak self] code, j in
            guard let self else { return }
            self.pending -= 1
            if code != 200, let f = fail { self.toast?(j["error"] as? String ?? f) }
            done?(code, j)
            if reload { self.load(k) }
        }
    }

    // MARK: what a page says

    private func model(_ v: [String: Any]) -> [String: Any]? { v["model"] as? [String: Any] }
    private func section(_ v: [String: Any], _ sec: [Int]?) -> [String: Any]? {
        guard let sec, let m = model(v), let tabs = m["tabs"] as? [[String: Any]], sec[0] < tabs.count,
              let ss = tabs[sec[0]]["sections"] as? [[String: Any]], sec[1] < ss.count else { return nil }
        return ss[sec[1]]
    }
    private func spec(_ s: [String: Any]) -> [String: Any] { s["item"] as? [String: Any] ?? [:] }
    private func actions(_ d: [String: Any]?) -> [[String: Any]] { d?["actions"] as? [[String: Any]] ?? [] }
    private func str(_ d: [String: Any]?, _ k: String) -> String? { d?[k] as? String }

    /// Buttons are off on a project page not trusted, or with no version that worked.
    private func off(_ v: [String: Any]) -> String? {
        if let tr = v["trust"] as? [String: Any], tr["state"] as? String != "trusted" { return t("pg.offTrust") }
        if model(v) == nil { return t("pg.offFixed") }
        return nil
    }

    private func ref(_ item: Item?) -> Any {
        guard let item else { return NSNull() }
        if item["$hash"] != nil { return ["file": item["file"] ?? NSNull()] }
        return ["id": item["id"] ?? item["path"] ?? NSNull()]
    }
    private func secJSON(_ sec: [Int]?) -> Any { sec.map { $0 as Any } ?? NSNull() }

    // MARK: what a button does

    /// Where an action sits: on the page, a section, or an item.
    struct Addr { var scope: String; var tab: Int?; var section: Int?; var index: Int
        var json: [String: Any] { var d: [String: Any] = ["scope": scope, "index": index]; if let t = tab { d["tab"] = t }; if let s = section { d["section"] = s }; return d }
    }

    func act(_ v: [String: Any], _ a: [String: Any], _ at: Addr, _ item: Item?, _ sec: [Int]?) {
        let kind = a["kind"] as? String ?? ""
        let confirm = (a["confirm"] as? [[String: Any]]).map { PageFmt.fill($0, item ?? [:]) }
        let go: () -> Void = { [weak self] in self?.run(v, a, kind, at, item, sec) }
        if let c = confirm { openSheet("confirm", confirmSheet(c, ok: a["label"] as? String ?? "", run: go)); return }
        go()
    }

    private func run(_ v: [String: Any], _ a: [String: Any], _ kind: String, _ at: Addr, _ item: Item?, _ sec: [Int]?) {
        let k = v["key"] as? String ?? key
        switch kind {
        case "set":
            guard let item else { return }
            let patch = a["set"] as? [String: Any] ?? [:]
            var fields: [String: Any] = [:]
            for f in patch.keys { fields[f] = item[f] ?? NSNull() }
            send("/api/pages/item/set", ["key": k, "at": secJSON(sec), "file": item["file"] ?? NSNull(), "hash": item["$hash"] ?? NSNull(), "fields": fields, "patch": patch], fail: t("pg.notWritten"))
        case "archive":
            guard let item else { return }
            send("/api/pages/item/archive", ["key": k, "at": secJSON(sec), "file": item["file"] ?? NSNull(), "hash": item["$hash"] ?? NSNull()], fail: t("pg.notArchived")) { [weak self] code, _ in
                guard let self, code == 200 else { return }
                self.host?.toast(t("pg.archived", ["title": PageFmt.text(item["title"])]), (t("pg.undo"), { [weak self] in
                    self?.send("/api/pages/item/restore", ["key": k, "at": self?.secJSON(sec) ?? NSNull(), "file": item["file"] ?? NSNull()], fail: nil)
                }))
            }
        case "create":
            form = FormState(at: at, action: a, sec: sec)
            for (f, spec) in formFields(v, sec) {
                let d = (a["create"] as? [String: Any])?[f] ?? spec["default"]
                let box = field("form:\(f)", "")
                box.text = d.map { PageFmt.text($0) } ?? ""
            }
            clear("form:$body")
            openSheet("form", formSheet(v))
        case "copy":
            Outside.copy(PageFmt.fill(a["copy"], item ?? [:]))
            toast?(t("pg.copied"))
        case "open": openTarget(v, a, item, sec)
        case "ask": ask(v, at, ref(item))
        case "run":
            send("/api/pages/run", ["key": k, "at": at.json, "item": ref(item)], fail: t("pg.notStarted"), reload: false) { [weak self] code, j in
                guard code == 200 else { return }
                // Its approval card in front (Electron's showCheckpoint), else said where it waits.
                if let id = (j["checkpoint"] as? [String: Any])?["id"] as? String, let show = self?.host?.showCheckpoint { show(id) }
                else { self?.toast?(t("pg.runWaits", ["title": a["label"] as? String ?? ""])) }
            }
        case "plugin": plugin(v, a, item)
        default: break
        }
    }

    private func ask(_ v: [String: Any], _ at: Addr, _ r: Any) {
        let k = v["key"] as? String ?? key
        send("/api/pages/ask", ["key": k, "at": at.json, "item": r], fail: nil, reload: false) { [weak self] code, j in
            guard let self else { return }
            if code == 409, j["needsApproval"] as? Bool == true {
                self.openSheet("approve", self.approveSheet(j["does"] as? String ?? "") { [weak self] in
                    self?.send("/api/pages/approve", ["key": k, "hash": j["hash"] ?? NSNull()], fail: t("pg.notAllowed"), reload: false) { code, _ in
                        if code == 200 { self?.ask(v, at, r) }
                    }
                })
                return
            }
            if code != 200 { self.toast?(j["error"] as? String ?? t("page.nothingTyped")); return }
            if let p = j["projectId"] as? String, let s = j["surfaceId"] as? String { self.host?.pickSession("\(p)/\(s)") }
            self.toast?(j["sent"] as? Bool == true ? t("pg.sent") : t("pg.typedInBox"))
        }
    }

    private func openTarget(_ v: [String: Any], _ a: [String: Any], _ item: Item?, _ sec: [Int]?) {
        let o = a["open"] as? [String: Any] ?? [:]
        switch o["kind"] as? String ?? "" {
        case "item": if let item { openItem(v, item, sec) }
        case "file": if let item, item["file"] != nil { Outside.openFile(itemPath(v, item, sec)) }
        case "folder": Outside.openFile((itemPath(v, item, sec) as NSString).deletingLastPathComponent)
        case "page":
            let p = o["page"] as? String ?? ""
            if let r = host?.rows().first(where: { $0.id == p || $0.route == p }) { host?.openPage(r.key) } else { toast?(t("pg.noPage", ["page": p])) }
        case "link":
            let url = PageFmt.text(item.flatMap { PageFmt.field($0, o["field"] as? String ?? "") })
            if url.hasPrefix("http://") || url.hasPrefix("https://") { openSheet("link", linkSheet(url)) }
        case "project", "session":
            let name = PageFmt.fill(o["text"], item ?? [:])
            if host?.pickProject(name) != true { toast?(t("pg.noProject", ["name": name])) }
        default: break
        }
    }

    private func itemPath(_ v: [String: Any], _ item: Item?, _ sec: [Int]?) -> String {
        let src = sourceOf(v, sec)
        let dir = ((v["file"] as? String ?? "") as NSString).deletingLastPathComponent
        let base = v["origin"] as? String == "default" ? ((v["dir"] as? String ?? "") as NSString).expandingTildeInPath : dir
        var folder = src?["kind"] as? String == "folder" ? src?["folder"] as? String ?? "" : ""
        while folder.hasSuffix("/") { folder.removeLast() }
        if let f = item?["file"] as? String { return "\(base)/\(folder)/\(f)" }
        return "\(base)/\(folder)"
    }

    private func plugin(_ v: [String: Any], _ a: [String: Any], _ item: Item?) {
        let id = PageFmt.text(item?["id"])
        let k = v["key"] as? String ?? key
        switch a["plugin"] as? String ?? "" {
        case "ravenry:save-rule": if let item { openSheet("rule", ruleSheet(item, a)) }
        case "ravenry:not-now":
            send("/api/repeats/\(enc(id))", ["action": "notnow"], fail: t("pg.notHidden")) { [weak self] code, _ in if code == 200 { self?.toast?(t("pg.hiddenRepeat")) } }
        case "ravenry:write-brief":
            // The brief's form, as the hub's browser board opens it (openModal, mode
            // brief): the person writes it, POST /api/project/brief (BRIEF-006).
            host?.openPage("writebrief:\(id)")
        default: toast?(t("pg.notInstalled", ["plugin": a["plugin"] as? String ?? ""]))
        }
    }

    /// An item opened: Ravenry's own page for it (a plan, an idea, a project), else its fields and text.
    func openItem(_ v: [String: Any], _ item: Item, _ sec: [Int]?) {
        let detail = section(v, sec).map { spec($0)["detail"] as? String } ?? nil
        switch detail {
        case "ravenry:plan": openPlan(item)
        case "ravenry:session-sheet":
            let id = PageFmt.text(item["id"])
            if host?.pickProject(id) != true { toast?(t("pg.noProject", ["name": id])) }
        case "ravenry:idea-thread": host?.openIdea(PageFmt.text((item["$ravenry"] as? [String: Any])?["id"] ?? item["id"]))
        default:
            if let sec {
                openSheet("item", itemSheet(v, item, sec))
                openedItem = PageFmt.text(item["file"]).isEmpty ? nil : (sec, PageFmt.text(item["file"]), PageFmt.text(item["$hash"]))
            }
        }
    }

    /// A plans item is "<project>/<title>" with both as fields; a projects item is the project.
    private func openPlan(_ it: Item) {
        let project = PageFmt.text(it["project"]).isEmpty ? String(PageFmt.text(it["id"]).split(separator: "/").first ?? "") : PageFmt.text(it["project"])
        let title = it["title"] != nil && it["project"] != nil ? PageFmt.text(it["title"]) : nil
        host?.openPlan(project, title)
    }

    /// A project's brief at an objective: Ravenry's brief page, else the project.
    private func openBrief(_ pid: String, _ objective: String?) {
        if let ob = host?.openBrief { ob(pid, objective) } else if host?.pickProject(pid) != true { toast?(t("pg.noProject", ["name": pid])) }
    }

    /// A task of a brief's objective ticked or unticked (POST /api/brief/tick); the page read again after.
    func tickTask(_ pid: String, objective: String, text: String, done: Bool) {
        send("/api/brief/tick", ["project": pid, "objective": objective, "text": text, "done": done], fail: t("pg.notTicked"))
    }

    private func sourceOf(_ v: [String: Any], _ sec: [Int]?) -> [String: Any]? {
        if let s = section(v, sec) { return s["source"] as? [String: Any] }
        return model(v)?["source"] as? [String: Any]
    }

    /// The form's fields: the title, then every field of the folder a person writes.
    func formFields(_ v: [String: Any], _ sec: [Int]?) -> [(String, [String: Any])] {
        guard let src = sourceOf(v, sec), src["kind"] as? String == "folder", let fs = src["fields"] as? [String: Any] else { return [] }
        var out: [(String, [String: Any])] = []
        if let tt = fs["title"] as? [String: Any] { out.append(("title", tt)) }
        // The file's order of fields (the hub sends them in it).
        for name in orderedKeys(fs) where name != "title" {
            guard let f = fs[name] as? [String: Any] else { continue }
            if f["builtin"] as? Bool == true || ["image", "object"].contains(f["type"] as? String ?? "") { continue }
            out.append((name, f))
        }
        return out
    }
    /// A source's field names in the order the hub wrote them (JSONSerialization loses it): by each field's own `name` order in the page's text.
    private func orderedKeys(_ fs: [String: Any]) -> [String] {
        let text = view?["text"] as? String ?? ""
        return fs.keys.sorted { a, b in
            let ia = text.range(of: "\n    \(a):")?.lowerBound ?? text.range(of: "\(a):")?.lowerBound ?? text.endIndex
            let ib = text.range(of: "\n    \(b):")?.lowerBound ?? text.range(of: "\(b):")?.lowerBound ?? text.endIndex
            return ia == ib ? a < b : ia < ib
        }
    }

    func toggle(_ v: [String: Any], _ item: Item, _ sec: [Int]?, line: Int, text: String, done: Bool) {
        send("/api/pages/item/toggle", ["key": v["key"] as? String ?? key, "at": secJSON(sec), "file": item["file"] ?? NSNull(), "line": line, "text": text, "done": done], fail: t("pg.notTicked"))
    }

    func moveTo(_ v: [String: Any], _ it: Item, _ field: String, _ value: String, _ sec: [Int]) {
        send("/api/pages/item/set", ["key": v["key"] as? String ?? key, "at": sec, "file": it["file"] ?? NSNull(), "hash": it["$hash"] ?? NSNull(),
                                      "fields": [field: it[field] ?? NSNull()], "patch": [field: value]], fail: t("page.notMoved"))
    }

    private func customize(_ v: [String: Any]) {
        let k = v["key"] as? String ?? key
        send("/api/pages/customize", ["key": k], fail: t("pg.notCustomized"), reload: false) { [weak self] code, j in
            guard let self, code == 200 else { return }
            if let f = j["file"] as? String { Outside.openFile(f) }
            self.toast?(t("pg.customized", ["path": j["path"] as? String ?? ""]))
            self.cache[k] = nil
            self.load(k)
        }
    }

    private func trust(_ v: [String: Any]) {
        let text = v["text"] as? String ?? ""
        let hash = SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
        send("/api/pages/trust", ["key": v["key"] as? String ?? key, "hash": hash], fail: t("pg.notTrusted")) { [weak self] code, _ in if code == 200 { self?.toast?(t("pg.trusted")) } }
    }

    private func askFix(_ v: [String: Any], _ err: [String: Any]) {
        let file = v["file"] as? String ?? ""
        let hint = (err["hint"] as? String).map { " " + $0 } ?? ""
        let text = t("pg.fixText", ["file": file, "line": PageFmt.text(err["line"]), "message": err["message"] as? String ?? "", "hint": hint])
        let project = (v["project"] as? [String: Any])?["id"] as? String
        guard let session = project ?? host?.lastProject() else { Outside.copy(text); toast?(t("page.noSessionToAsk")); return }
        send("/api/pages/ask", ["key": v["key"] as? String ?? key, "kind": "fix", "text": text, "session": session], fail: t("page.nothingTyped"), reload: false) { [weak self] code, j in
            guard code == 200, let p = j["projectId"] as? String, let s = j["surfaceId"] as? String else { return }
            self?.host?.pickSession("\(p)/\(s)")
            self?.toast?(t("pg.typedInBox"))
        }
    }

    // MARK: drawing

    /// The widths the drawing depends on: card and stat columns, a board narrow or not.
    private var width: CGFloat { max(200, bounds.width - 44) }
    private func cols(_ min: CGFloat) -> Int { max(1, Int((width + 12) / (min + 12))) }

    override func layoutBody() {
        super.layoutBody()
        sheetView?.frame = bounds
        let sig = "\(cols(300))|\(cols(200))|\(Int(width / 4))"
        if sig != layoutSig && !key.isEmpty {
            layoutSig = sig
            DispatchQueue.main.async { [weak self] in self?.dirty(); self?.redraw() }
        }
    }

    override func redraw() {
        guard !key.isEmpty else { return }
        let row = host?.rows().first { $0.key == key }
        guard let c = cache[key] else {
            if headSig != "reading|\(key)" { headSig = "reading|\(key)"; setHead(title: row?.label ?? t("pg.page"), src: t("pg.reading"), closable: false) }
            draw("reading|\(key)") { [] }
            return
        }
        let v = c.view
        let hs = "\(key)|\(c.sig)"
        if hs != headSig { headSig = hs; head(v) }
        let memorySig = memory.map { "\($0.rules.count)|\($0.rules.map { $0["id"] as? String ?? "" }.joined())" } ?? "-"
        let sig = "\(key)|\(c.sig)|\(layoutSig)|\(folded)|\(shown.sorted())|\(dismissed.sorted())|\(images.count)|\(memorySig)"
        draw(sig) {
            pb = pb.filter { $0.key.hasPrefix("sheet:") }
            lanes = []
            return bars(v) + page(v)
        }
    }

    private func btn(_ name: String, _ title: String, _ kind: RButton.Kind = .normal, small: Bool = true, lead: String? = nil, run: @escaping () -> Void) -> RButton {
        let b = RButton(title, kind, small: small, run: run)
        b.lead = lead
        pb[name] = b
        return b
    }

    private func head(_ v: [String: Any]) {
        let m = model(v)
        let origin = v["origin"] as? String ?? ""
        let off = self.off(v)
        let project = v["project"] as? [String: Any]
        let ch: String? = origin == "default" ? t("pg.default") : origin == "project" && project != nil ? project?["name"] as? String : (m?["from"] != nil && !(m?["from"] is NSNull)) ? t("pg.yourCopy") : nil
        var src: [(String, Bool)] = []
        let path = v["path"] as? String ?? ""
        if origin == "default" { src.append((t("pg.shipped"), false)) } else {
            if origin == "project", let tr = v["trust"] as? [String: Any], tr["state"] as? String != "trusted" { src.append((t("pg.readOnly"), false)) }
            let shown = origin == "project" && project != nil ? path.replacingOccurrences(of: (project?["folder"] as? String ?? "") + "/", with: "") : path
            src.append((shown, true))
            if let m, let ps = m["source"] as? [String: Any], ps["kind"] as? String == "folder", m["from"] == nil || m["from"] is NSNull, origin != "project" {
                let n = (v["drawn"] as? [String: Any])?["pageItems"] as? Int ?? ((v["items"] as? [String: Any])?["page"] as? [Any])?.count ?? 0
                src.append((t("pg.itemsIn", ["n": "\(n)", "noun": PageFmt.noun(m, n), "folder": ps["folder"] as? String ?? ""]), false))
            }
        }
        var right: [NSView] = []
        buttons = buttons.filter { $0.key == "close" }
        if origin == "default" { right.append(hbtn("customize", t("pg.customize"), .quiet) { [weak self] in self?.customize(v) }) }
        else if origin != "project" { right.append(hbtn("openFile", t("pg.openFile"), .quiet, small: false, lead: "doc") { Outside.openFile(v["file"] as? String ?? "") }) }
        for (i, a) in actions(m).enumerated() {
            let label = a["label"] as? String ?? ""
            if a["kind"] as? String == "off" { let b = hbtn("page:\(label)", label, small: false) {}; b.isEnabled = false; b.toolTip = a["reason"] as? String; right.append(b); continue }
            let pri = a["kind"] as? String == "create" && off == nil
            let b = hbtn("page:\(label)", label, pri ? .primary : .normal, small: off != nil, lead: off != nil ? "lock" : actionIcon(a)) { [weak self] in self?.act(v, a, Addr(scope: "page", index: i), nil, nil) }
            b.isEnabled = off == nil
            b.toolTip = off
            right.append(b)
        }
        setHead(title: m?["title"] as? String ?? v["id"] as? String ?? "", src: nil, extra: right, chip: ch.map { chip($0) }, srcView: srcLine(src), closable: false)
    }
    /// .pg-src: the line under the title, its path in mono, its parts 6 points apart, cut at the end.
    private func srcLine(_ parts: [(String, Bool)]) -> NSView {
        let a = NSMutableAttributedString()
        for (i, (s, mono)) in parts.enumerated() {
            if i > 0 { a.append(NSAttributedString(string: " ", attributes: [.font: Fonts.pt(12), .kern: 2.6])) }
            a.append(NSAttributedString(string: s, attributes: [.font: mono ? Fonts.mono(11.5) : Fonts.pt(12), .foregroundColor: Design.color("tx3")]))
        }
        let l = NSTextField(labelWithAttributedString: a)
        l.usesSingleLineMode = true
        l.cell?.wraps = false
        l.maximumNumberOfLines = 1
        l.lineBreakMode = .byTruncatingTail
        l.setContentCompressionResistancePriority(.init(400), for: .horizontal)
        return l
    }

    /// A button of the head, kept in `buttons` (the head is drawn apart from the body).
    private func hbtn(_ name: String, _ title: String, _ kind: RButton.Kind = .normal, small: Bool = true, lead: String? = nil, run: @escaping () -> Void) -> RButton {
        let b = RButton(title, kind, small: small, run: run)
        b.lead = lead
        buttons[name] = b
        return b
    }

    /// The icon of an action: its own when shared, else one by what it does.
    private func actionIcon(_ a: [String: Any]) -> String? {
        let own = ["target": "nav-objectives", "plans": "nav-plans", "idea": "nav-ideas", "rules": "nav-rules", "ship": "nav-ship", "clock": "clock", "terminal": "run"]
        if let i = a["icon"] as? String, let n = own[i] { return n }
        switch a["kind"] as? String ?? "" {
        case "ask": return "ask"
        case "run": return "run"
        case "create": return "plus"
        case "set": return "check"
        case "copy": return "doc"
        default: return nil
        }
    }

    // MARK: the bars on top

    private func bars(_ v: [String: Any]) -> [NSView] {
        var out: [NSView] = []
        let problems = v["problems"] as? [[String: Any]] ?? []
        if let err = problems.first(where: { $0["severity"] as? String == "error" }) {
            let file = (v["path"] as? String ?? "").split(separator: "/").last.map(String.init) ?? ""
            let msg = err["message"] as? String ?? ""
            let stale = v["stale"] as? Bool == true ? " " + t("pg.stale") : ""
            var col: [NSView] = [wrap(t("pg.errLine", ["file": file, "line": PageFmt.text(err["line"]), "message": msg]) + stale, Fonts.pt(12.5, .semibold))]
            let line = err["lineText"] as? String ?? ""
            if !line.isEmpty {
                let a = NSMutableAttributedString(string: PageFmt.text(err["line"]).padding(toLength: 4, withPad: " ", startingAt: 0), attributes: [.font: Fonts.mono(12), .foregroundColor: Design.color("tx3")])
                let word = msg.hasPrefix("'") ? msg.dropFirst().split(separator: "'").first.map(String.init) : nil
                let code = NSMutableAttributedString(string: line, attributes: [.font: Fonts.mono(12), .foregroundColor: Design.color("tx2")])
                if let w = word, let r = line.range(of: w) {
                    code.addAttributes([.foregroundColor: Design.color("tx"), .underlineStyle: NSUnderlineStyle.single.rawValue | NSUnderlineStyle.patternDot.rawValue, .underlineColor: Design.color("bad")], range: NSRange(r, in: line))
                }
                a.append(code)
                if let h = err["hint"] as? String { a.append(NSAttributedString(string: "      " + h, attributes: [.font: Fonts.pt(12), .foregroundColor: Design.color("tx2")])) }
                let l = NSTextField(labelWithAttributedString: a)
                l.usesSingleLineMode = true
                l.cell?.wraps = false
                l.maximumNumberOfLines = 1
                l.lineBreakMode = .byTruncatingTail
                col.append(soft(l))
            } else if let h = err["hint"] as? String { col.append(wrap(h, Fonts.pt(12.5), "tx2")) }
            let bb = hstack([btn("bar:openFile", t("pg.openFile"), lead: "doc") { Outside.openFile(v["file"] as? String ?? "") },
                             btn("bar:askFix", t("pg.askFix"), lead: "ask") { [weak self] in self?.askFix(v, err) }], spacing: 6)
            out.append(noticeBar("bad", Icon("warn", "bad", size: 14), vstack(col, spacing: 6), bb))
        }
        if let tr = v["trust"] as? [String: Any], tr["state"] as? String != "trusted", let project = v["project"] as? [String: Any], !dismissed.contains(dismissKey(v)) {
            let changed = tr["state"] as? String == "changed"
            let folder = project["folder"] as? String ?? ""
            let rel = (v["path"] as? String ?? "").replacingOccurrences(of: folder + "/", with: "")
            var col: [NSView] = [wrap(changed ? t("pg.trustChanged") : t("pg.trustNew"), Fonts.pt(12.5, .semibold))]
            let read = btn("bar:readFile", t("pg.readTheFile"), .link) { Outside.openFile(v["file"] as? String ?? "") }
            col.append(hstack([soft(label("\(folder)/\(rel)", Fonts.mono(11.5), "tx")), label(changed ? t("pg.trustChangedBy") : t("pg.trustAddedBy"), Fonts.pt(12.5), "tx2"), read, spring()], spacing: 4))
            let acts = tr["actions"] as? [[String: Any]] ?? []
            if !acts.isEmpty {
                col.append(label(t("pg.wouldDo"), Fonts.pt(12.5), "tx2"))
                col.append(vstack(acts.map { a in
                    let does = a["does"] as? String ?? ""
                    let what: NSView
                    if let w = PageFmt.would(does) {
                        let parts = t("pg.runs", ["cmd": "\u{1}", "where": w.where]).components(separatedBy: "\u{1}")
                        what = hstack([label(parts[0], Fonts.pt(12.5), "tx2"), boxed(label(w.cmd, Fonts.mono(11.5), "tx"), fill: "card2", radius: 4, insets: NSEdgeInsets(top: 1, left: 6, bottom: 1, right: 6)), soft(label(parts.count > 1 ? parts[1] : "", Fonts.pt(12.5), "tx2")), spring()], spacing: 0)
                    } else { what = wrap(does, Fonts.pt(12.5), "tx2") }
                    return hstack([fix(label(a["label"] as? String ?? "", Fonts.pt(12.5, .semibold)), w: 150), soft(what)], spacing: 14)
                }, spacing: 5))
            }
            col.append(hstack([btn("bar:trust", t("pg.trust"), .primary) { [weak self] in self?.trust(v) },
                               btn("bar:keepReadOnly", t("pg.keepReadOnly")) { [weak self] in guard let self else { return }; self.dismissed.insert(self.dismissKey(v)); self.redraw() },
                               soft(label(t("pg.trustFine"), Fonts.pt(11.5), "tx3")), spring()], spacing: 8))
            let m = Mark(.shield, size: 15); m.tint = "you"
            out.append(noticeBar("you", m, vstack(col, spacing: 6), nil))
        }
        if v["defaultChanged"] != nil && !(v["defaultChanged"] is NSNull) {
            let m = Mark(.info, size: 14); m.tint = "tx3"
            let hide = RButton(t("pg.hideUntilNext"), .icon, small: true, icon: "close") { [weak self] in self?.send("/api/pages/dismiss", ["key": v["key"] as? String ?? ""], fail: nil) }
            pb["bar:hide"] = hide
            out.append(noticeBar("info", m, label(t("pg.defaultChanged"), Fonts.pt(12.5)),
                                 hstack([btn("bar:seeChanged", t("pg.seeChanged"), .link) { [weak self] in guard let self else { return }; self.openSheet("changed", self.changedSheet(v)) }, hide], spacing: 6)))
        }
        return out
    }
    private func dismissKey(_ v: [String: Any]) -> String { "\(v["key"] ?? "")\((v["text"] as? String ?? "").count)" }

    /// .nb: a bar over the page (bad, you, info): its glyph, its words, its buttons.
    private func noticeBar(_ tone: String, _ glyph: NSView, _ body: NSView, _ bb: NSView?) -> NSView {
        let info = tone == "info"
        soft(body)
        let row = NSStackView(views: [glyph, body] + (bb.map { [$0] } ?? []))
        row.orientation = .horizontal; row.spacing = 10
        row.alignment = info ? .centerY : .top
        let b = ToneBox(fill: info ? "card" : "\(tone)-t", radius: 9)
        b.ringTone = info ? "sep" : tone
        b.ringAlpha = info ? 1 : 0.35
        row.translatesAutoresizingMaskIntoConstraints = false
        b.addSubview(row)
        let ins = info ? NSEdgeInsets(top: 8, left: 14, bottom: 8, right: 10) : NSEdgeInsets(top: 11, left: 14, bottom: 11, right: 12)
        NSLayoutConstraint.activate([row.leadingAnchor.constraint(equalTo: b.leadingAnchor, constant: ins.left), row.trailingAnchor.constraint(equalTo: b.trailingAnchor, constant: -ins.right),
                                     row.topAnchor.constraint(equalTo: b.topAnchor, constant: ins.top), row.bottomAnchor.constraint(equalTo: b.bottomAnchor, constant: -ins.bottom)])
        return b
    }

    // MARK: the page

    private func page(_ v: [String: Any]) -> [NSView] {
        guard let m = model(v), let tabs = m["tabs"] as? [[String: Any]], !tabs.isEmpty else { return [wrap(t("pg.noGoodVersion"), Fonts.pt(13), "tx2")] }
        let d = v["drawn"] as? [String: Any]
        let ti = min(d?["tab"] as? Int ?? 0, tabs.count - 1)
        var out: [NSView] = []
        if m["tabbed"] as? Bool == true {
            let dt = d?["tabs"] as? [[String: Any]] ?? []
            let labels = tabs.enumerated().map { i, tb in ((tb["label"] as? String) ?? t("pg.tabN", ["n": "\(i + 1)"]), i < dt.count ? dt[i]["count"] as? Int : nil) }
            let tv = PageTabs(labels, on: ti) { [weak self] i in self?.pickTab(i) }
            for (i, s) in tv.segs.enumerated() { pb["tab:\(i)"] = s }
            out.append(hstack([tv, spring()], spacing: 0))
        }
        var legend = false
        let secs = tabs[ti]["sections"] as? [[String: Any]] ?? []
        let dsecs = d?["sections"] as? [[String: Any]] ?? []
        for (si, s) in secs.enumerated() {
            if !legend && s["kind"] as? String == "core" && spec(s)["place"] as? String == "ravenry:objective-rows" { out.append(objectivesLegend()); legend = true }
            let ds = si < dsecs.count ? dsecs[si] : [:]
            if let x = sectionView(v, s, ds, [ti, si]) { out.append(x) }
        }
        return out
    }

    private func rowsOf(_ d: [String: Any]) -> [Item] { d["rows"] as? [Item] ?? [] }
    private func groupsOf(_ d: [String: Any]) -> [(value: String?, items: [Item])]? {
        guard let gs = d["groups"] as? [[String: Any]] else { return nil }
        let rows = rowsOf(d)
        return gs.map { g in (g["value"] as? String, (g["rows"] as? [Int] ?? []).compactMap { $0 < rows.count ? rows[$0] : nil }) }
    }

    private func sectionView(_ v: [String: Any], _ s: [String: Any], _ d: [String: Any], _ sec: [Int]) -> NSView? {
        let kind = s["kind"] as? String ?? ""
        if kind == "placeholder" { return ocard([cardHead(s["title"] as? String ?? s["view"] as? String ?? "", nil, muted: true), orow(wrap(s["reason"] as? String ?? "", Fonts.pt(12.5), "tx2"))]) }
        if kind == "plugin" { return pluginView(v, s, rowsOf(d), sec) }
        switch s["view"] as? String ?? "list" {
        case "board": return board(v, s, d, sec)
        case "cards": return cards(v, s, rowsOf(d), sec)
        case "table": return table(v, s, rowsOf(d), sec)
        case "stats": return stats(d)
        case "document": return documentView(v, s, d, sec)
        default: return list(v, s, d, sec)
        }
    }

    private func sectionActions(_ v: [String: Any], _ s: [String: Any], _ sec: [Int]) -> NSView? {
        let acts = actions(s)
        guard !acts.isEmpty else { return nil }
        let off = self.off(v)
        return hstack(acts.enumerated().compactMap { i, a in button(v, a, Addr(scope: "section", tab: sec[0], section: sec[1], index: i), nil, sec, off, small: false) } + [spring()], spacing: 8)
    }

    /// A button of the page; nil for an item's button whose `when` does not hold for it.
    private func button(_ v: [String: Any], _ a: [String: Any], _ at: Addr, _ item: Item?, _ sec: [Int]?, _ off: String?, small: Bool = true) -> NSView? {
        if let item, at.scope == "item", let ok = item["$actions"] as? [Int], !ok.contains(at.index) { return nil }
        let lbl = a["label"] as? String ?? ""
        let name = "\(at.scope):\(item.map { PageFmt.text($0["file"] ?? $0["id"] ?? $0["path"]) } ?? "\(at.section ?? -1)"):\(lbl)"
        if a["kind"] as? String == "off" { let b = btn(name, lbl, small: small) {}; b.isEnabled = false; b.toolTip = a["reason"] as? String; return b }
        let b = btn(name, lbl, small: small, lead: off != nil ? "lock" : actionIcon(a)) { [weak self] in self?.act(v, a, at, item, sec) }
        b.isEnabled = off == nil
        b.toolTip = off
        return b
    }

    private func itemButtons(_ v: [String: Any], _ sp: [String: Any], _ item: Item, _ sec: [Int]) -> [NSView] {
        let off = self.off(v)
        return actions(sp).enumerated().compactMap { i, a in button(v, a, Addr(scope: "item", tab: sec[0], section: sec[1], index: i), item, sec, off) }
    }

    // MARK: an item's slots

    func image(_ v: [String: Any], _ item: Item, _ field: String?) -> NSImage?? {
        guard let field else { return nil }
        let val = PageFmt.text(PageFmt.field(item, field))
        guard !val.isEmpty else { return nil }
        let u: String
        if val.hasPrefix("/api/") { u = val }
        else if val.range(of: "^[a-z]+:", options: [.regularExpression, .caseInsensitive]) != nil || val.hasPrefix("/") || val.contains("..") { return nil }
        else { u = "/api/pages/img?key=\(enc(v["key"] as? String ?? ""))&path=\(enc((item["$base"] as? String ?? "") + val))" }
        if let i = images[u] { return .some(i) }
        if !asked.contains(u), let hub {
            asked.insert(u)
            hub.data(u) { [weak self] d in
                guard let self else { return }
                if let d, let i = NSImage(data: d) { self.images[u] = i; self.redraw() }
            }
        }
        return .some(nil)
    }
    /// A picture shown whole, never cropped (`contain`, on card2 where it
    /// leaves room). `cap`: as tall as the picture's own shape at its width,
    /// at most `cap` high; `aspect`: a band of that width:height (cards in a
    /// grid keep one shape); `w` and `h`: a fixed box. A picture not read yet
    /// holds a 16:10 place.
    private func picture(_ img: NSImage??, cap: CGFloat? = nil, aspect: CGFloat? = nil, w: CGFloat? = nil, h: CGFloat? = nil, radius: CGFloat = 0) -> NSView? {
        guard let img else { return nil }
        let c = CoverImage()
        c.image = img; c.radius = radius; c.fit = true; c.fillColor = Design.color("card2")
        c.translatesAutoresizingMaskIntoConstraints = false
        if let w { c.widthAnchor.constraint(equalToConstant: w).isActive = true }
        if let h { c.heightAnchor.constraint(equalToConstant: h).isActive = true }
        if let a = aspect {
            let k = c.heightAnchor.constraint(equalTo: c.widthAnchor, multiplier: 1 / a)
            if cap != nil { k.priority = .init(750) }
            k.isActive = true
        }
        if let cap, aspect != nil { c.heightAnchor.constraint(lessThanOrEqualToConstant: cap).isActive = true }
        else if let cap {
            let sz = img?.size ?? NSSize(width: 16, height: 10)
            let r = sz.width > 0 && sz.height > 0 ? sz.height / sz.width : 10 / 16
            let own = c.heightAnchor.constraint(equalTo: c.widthAnchor, multiplier: r); own.priority = .init(740); own.isActive = true
            c.heightAnchor.constraint(lessThanOrEqualToConstant: cap).isActive = true
            // Never taller than the picture is at its own size (a small one is not blown up).
            if let i = img, i.size.height > 0 { c.heightAnchor.constraint(lessThanOrEqualToConstant: max(40, i.size.height)).isActive = true }
        }
        c.setAccessibilityElement(true)
        c.setAccessibilityRole(.image)
        return c
    }
    /// A narrow board's thumbnail: the whole picture in 76 by 46.
    private func thumb(_ img: NSImage??) -> NSView? { picture(img, w: 76, h: 46, radius: 6) }

    private func isEnum(_ s: [String: Any], _ f: String) -> Bool {
        let fs = (s["source"] as? [String: Any])?["fields"] as? [String: Any]
        return ((fs?[String(f.split(separator: ".").first ?? "")] as? [String: Any])?["type"] as? String) == "enum"
    }

    private func badges(_ item: Item, _ sp: [String: Any], _ s: [String: Any]) -> [NSView] {
        var out: [NSView] = []
        for f in sp["badges"] as? [String] ?? [] {
            let val = PageFmt.field(item, f)
            if val == nil || PageFmt.text(val).isEmpty && !(val is [Any]) || (val as? [Any])?.isEmpty == true { continue }
            if f == "machine" { out.append(hstack([Icon("machine", "tx3", size: 12), label(PageFmt.text(val), Fonts.pt(11.5, .medium), "tx2")], spacing: 4)); continue }
            for x in (val as? [Any]) ?? [val!] {
                out.append(asTag(PageFmt.text(x), tone: PageFmt.fieldTone(item, f) ?? (isEnum(s, f) ? PageFmt.tone(x) : nil)))
            }
        }
        return out
    }

    private func timeEl(_ item: Item, _ sp: [String: Any]) -> NSView? {
        guard let f = sp["time"] as? String, let val = PageFmt.field(item, f), !PageFmt.text(val).isEmpty else { return nil }
        return hstack([Icon("clock", "tx3", size: 11), label(PageFmt.time(val), Fonts.pt(11.5).withTabularDigits, "tx3")], spacing: 4)
    }

    private static let taskTag: [String: (String, String)] = ["you": ("pg.tag.you", "you"), "now": ("pg.tag.now", "work"), "wait": ("pg.tag.wait", "wait")]

    /// A progress slot, always with its value in words; a list whose entries
    /// have text as the Ship card draws a brief's Ship section. `block` when it is that list.
    private func progress(_ item: Item, _ p: [String: Any]?) -> (view: NSView, block: Bool)? {
        guard let p else { return nil }
        let kind = p["kind"] as? String ?? "", style = p["style"] as? String ?? "bar"
        var done = 0.0, total = 0.0
        var states: [String]? = nil
        let num = { (k: String) -> Double in Double(PageFmt.text(PageFmt.field(item, p[k] as? String ?? ""))) ?? 0 }
        if kind == "number" { done = max(0, min(100, num("field"))); total = 100 }
        else if kind == "ratio" { done = num("done"); total = num("total") }
        else {
            let entries = PageFmt.field(item, p["list"] as? String ?? "") as? [Any] ?? []
            let st = entries.map { (($0 as? [String: Any])?["state"] as? String) ?? "todo" }
            states = st
            done = Double(st.filter { $0 == "done" }.count); total = Double(st.count)
            let texts = entries.map(PageFmt.entryText)
            if total > 0 && style == "dots" && texts.allSatisfy({ !$0.isEmpty }) {
                return (vstack(entries.indices.map { i in
                    let tg = Self.taskTag[st[i]]
                    let on = tg != nil, d = st[i] == "done"
                    return hstack([Mark.task(st[i]), soft(label(texts[i], Fonts.pt(12.5, on ? .semibold : .regular), on || d ? "tx" : "tx2", lines: 3)), tg.map { label(t($0.0), Fonts.pt(11.5, .semibold), $0.1) }, spring()].compactMap { $0 }, spacing: 8)
                }, spacing: 6), true)
            }
        }
        guard total > 0 else { return nil }
        let words = kind == "number" ? "\(Int(done))%" : "\(Int(done)) of \(Int(total))"
        let wl = label(words, Fonts.pt(12, .semibold).withTabularDigits, "tx")
        if style == "count" { return (wl, false) }
        if style == "dots" {
            let marks = states ?? (kind == "number" ? (0..<10).map { $0 < Int((done / 10).rounded()) ? "done" : "todo" } : (0..<Int(total)).map { Double($0) < done ? "done" : "todo" })
            return (hstack([hstack(marks.map { Mark.task($0) }, spacing: 4), wl], spacing: 8), false)
        }
        return (hstack([fix(Meter(done / total), w: 120, h: 5), wl], spacing: 8), false)
    }

    private func checklist(_ v: [String: Any], _ item: Item, _ sp: [String: Any], _ sec: [Int]) -> NSView? {
        guard sp["checklist"] as? String != nil, let boxes = item["$boxes"] as? [[String: Any]], !boxes.isEmpty else { return nil }
        let can = actions(sp).contains { $0["kind"] as? String == "toggle" } && off(v) == nil
        return vstack(boxes.enumerated().map { i, b in
            let done = b["done"] as? Bool ?? false
            let tb = TickBox(done, enabled: can) { [weak self] in self?.toggle(v, item, sec, line: b["line"] as? Int ?? 0, text: b["text"] as? String ?? "", done: !done) }
            pb["box:\(PageFmt.text(item["file"])):\(i)"] = tb
            return hstack([tb, soft(wrap(b["text"] as? String ?? "", Fonts.pt(13), done ? "tx2" : "tx"))], spacing: 8)
        }, spacing: 3)
    }

    private func excerpt(_ item: Item, _ f: String?) -> NSView? {
        guard let f else { return nil }
        var s = PageFmt.text(PageFmt.field(item, f))
        if s.hasPrefix("---"), let r = s.range(of: "\n---\n", range: s.index(s.startIndex, offsetBy: 3)..<s.endIndex) { s = String(s[r.upperBound...]) }
        let lines = s.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && !$0.hasPrefix("#") }.prefix(3)
        var tx = lines.joined(separator: " ")
        if tx.count > 220 { tx = String(tx.prefix(217)) + "..." }
        return tx.isEmpty ? nil : wrap(tx, Fonts.pt(12.5), "tx2")
    }

    private func subtitle(_ item: Item, _ sp: [String: Any]) -> NSView? {
        guard let f = sp["subtitle"] as? String else { return nil }
        let s = PageFmt.text(PageFmt.field(item, f))
        guard !s.isEmpty else { return nil }
        let tone = PageFmt.fieldTone(item, f)
        return wrap(s, Fonts.pt(12.5, .medium), ["ok": "ok", "you": "you", "muted": "tx2", "faint": "tx3"][tone ?? ""] ?? "tx2")
    }

    private func place(_ item: Item, _ sp: [String: Any]) -> NSView? {
        guard let p = sp["place"] as? String else { return nil }
        let r = item["$ravenry"] as? [String: Any]
        if p == "ravenry:plan-row", let row = r?["row"] as? [String: Any] { return planRow(row) }
        if p == "ravenry:mockup-rounds" {
            guard let mk = r?["mockups"] as? [String: Any] else {
                if let job = r?["job"], !(job is NSNull) { return label(t("pg.drawingRound", ["job": PageFmt.text(job)]), Fonts.pt(12), "tx3") }
                return nil
            }
            let vs = (mk["variants"] as? [[String: Any]] ?? []).map { x -> NSView in
                let u = x["img"] as? String ?? ""
                let c = picture(.some(images[u]), aspect: 1.6, radius: 4)!
                if images[u] == nil, !asked.contains(u), let hub { asked.insert(u); hub.data(u) { [weak self] d in if let d, let i = NSImage(data: d) { self?.images[u] = i; self?.redraw() } } }
                if mk["picked"] as? String == x["key"] as? String { (c as? CoverImage)?.wantsLayer = true; c.layer?.borderColor = Design.color("ok").cgColor; c.layer?.borderWidth = 1.5 }
                return c
            }
            let g = NSStackView(views: vs); g.orientation = .horizontal; g.distribution = .fillEqually; g.spacing = 4
            return g
        }
        return nil
    }

    // MARK: Objectives' pieces (the board's objRow, planRow, the legend)

    /// .prow: the steps' dots from the left, the count right-aligned in its
    /// column, the next step at the right end, so rows line up with each other.
    private func planRow(_ r: [String: Any]) -> NSView {
        let next = r["next"] as? [String: Any] ?? [:]
        let cn = label(r["count"] as? String ?? "", Fonts.pt(12, .semibold).withTabularDigits)
        cn.alignment = .right
        cn.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        return hstack([hstack((r["dots"] as? [String] ?? []).map { Mark.step($0) }, spacing: 4), spring(), fix(cn, minW: 76),
                       nextCol(wrap(md: next["text"] as? String ?? "", Fonts.pt(12), nextColor(next["cls"] as? String)), 260)], spacing: 14)
    }
    /// .nx: `w` wide, narrower (its words wrapping) before the steps or the count give way.
    private func nextCol(_ v: NSView, _ w: CGFloat) -> NSView {
        v.translatesAutoresizingMaskIntoConstraints = false
        let c = v.widthAnchor.constraint(equalToConstant: w); c.priority = .init(500); c.isActive = true
        v.widthAnchor.constraint(lessThanOrEqualToConstant: w).isActive = true
        v.widthAnchor.constraint(greaterThanOrEqualToConstant: 110).isActive = true
        v.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        return v
    }
    private func nextColor(_ cls: String?) -> String { cls == "now" ? "work" : cls == "you" ? "you" : "tx2" }

    /// An objective's row (objRow): its title, its steps or tasks, the count
    /// and what comes next. A press opens the brief at it (a plan's row, the
    /// plan); a task's dot ticks it in the brief (`tickTask`, nil when the
    /// page is off).
    private func objRow(_ r: [String: Any], key: String, open: @escaping () -> Void, tickTask: ((String, Bool) -> Void)?) -> NSView {
        let kind = r["kind"] as? String ?? "none"
        let title = r["title"] as? String ?? ""
        let plan = kind == "plan" || r["plan"] as? Bool == true
        let tl = wrap(md: title, Fonts.pt(12.5, .medium))
        let ot = fix(hstack([plan ? boxed(label(t("pg.planLabel").uppercased(), Fonts.pt(10, .bold), "tx2"), fill: "card2", radius: 5, insets: NSEdgeInsets(top: 1, left: 6, bottom: 1, right: 6)) : nil, soft(tl)], spacing: 8), w: 240)
        let cn = { (s: String) -> NSView in let l = label(s, Fonts.pt(12.5, .semibold).withTabularDigits); l.alignment = .right; l.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal); return fix(l, minW: 76) }
        // .ds: flex 1, at least 90 wide in every row, so the count and the next step line up from row to row.
        let steps = { (marks: [NSView]) -> NSView in let h = hstack(marks + [spring()], spacing: 4); h.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal); return fix(h, minW: 90) }
        var parts: [NSView] = [ot]
        switch kind {
        case "plan":
            let next = r["next"] as? [String: Any] ?? [:]
            parts += [steps((r["dots"] as? [String] ?? []).map { Mark.step($0) }), cn(r["count"] as? String ?? ""),
                      nextCol(wrap(md: next["text"] as? String ?? "", Fonts.pt(12), nextColor(next["cls"] as? String)), 220)]
        case "tasks":
            let tasks = r["tasks"] as? [[String: Any]] ?? []
            parts += [steps(tasks.enumerated().map { i, x -> NSView in
                let st = x["state"] as? String ?? "todo"
                let text = x["text"] as? String ?? ""
                guard let tick = tickTask else { let m = Mark.task(st); m.toolTip = text; return m }
                // A dot that ticks: done unticks, anything else ticks.
                let d = TaskDot(st, text: text) { tick(text, st != "done") }
                pb["task:\(key):\(title):\(i)"] = d
                return d
            }), cn(r["count"] as? String ?? ""), nextCol(wrap(md: r["next"] as? String ?? "", Fonts.pt(12), "tx2"), 220)]
        case "file":
            let tot = r["total"] as? Double ?? Double(r["total"] as? Int ?? 0), dn = r["done"] as? Double ?? Double(r["done"] as? Int ?? 0)
            let upd = (r["updated"] as? String).map { t("pg.updated", ["ago": PageFmt.ago($0)]) } ?? (r["source"] as? String ?? "")
            parts += [soft(fix(Meter(tot > 0 ? dn / tot : 0), h: 5)), cn(r["count"] as? String ?? ""), nextCol(wrap(upd, Fonts.pt(12), "tx2"), 220)]
        default:
            parts += [label(t("pg.notBroken"), Fonts.pt(12), "tx2"), spring()]
        }
        let b = card(hstack(parts, spacing: 14), fill: "card", radius: 0, insets: NSEdgeInsets(top: 9, left: 16, bottom: 9, right: 16), press: kind == "file" ? nil : open)
        b.fill = r["wash"] as? String ?? "" != "" ? "you-t" : nil
        b.toolTip = kind == "plan" ? t("pg.openPlanTip") : kind == "file" ? nil : t("pg.openInBriefTip")
        b.key = "\(key)/\(title)"
        pb["obj:\(key):\(title)"] = b
        return vstack([hline(), b])
    }

    private func objectivesLegend() -> NSView {
        let it = { (m: Mark, k: String) -> NSView in hstack([m, label(t(k), Fonts.pt(12), "tx2")], spacing: 6) }
        // .legend2: wraps onto a second line when the page is narrow.
        return flow([it(.task("done"), "pg.lg.done"), it(.task("now"), "pg.lg.now"), it(.task("you"), "pg.lg.you"), it(.task("wait"), "pg.lg.wait"), it(.task("todo"), "pg.lg.todo"),
                     it(Mark(.gateOn), "pg.lg.gate"), it(Mark(.branchLegend), "pg.lg.branch")], width: width, gap: 16)
    }

    // MARK: the cards and rows sections are made of

    /// .ocard: rows on a card.
    private func ocard(_ rows: [NSView?]) -> NSView { card(vstack(rows, spacing: 0)) }
    /// .ocard-h: a card's title (sec-t: tx2) and count.
    private func cardHead(_ title: String, _ n: Int?, muted: Bool = false, extra: [NSView] = []) -> NSView {
        let parts: [NSView?] = [label(title, Fonts.pt(13, Fonts.w650), "tx2"), n.map { label("\($0)", Fonts.pt(13, Fonts.w650).withTabularDigits, "tx3") }, spring()]
        return prow(parts + extra.map { Optional($0) }, spacing: 10, insets: NSEdgeInsets(top: 11, left: 16, bottom: 11, right: 16))
    }
    /// .orow: a row under a line.
    private func orow(_ content: NSView, press: (() -> Void)? = nil) -> NSView {
        let b = card(soft(content), fill: "card", radius: 0, insets: NSEdgeInsets(top: 9, left: 16, bottom: 9, right: 16), press: press)
        b.fill = nil
        return vstack([hline(), b])
    }
    private func ring(_ st: String) -> NSView {
        let i = Icon("ring-\(st)", ["you": "you", "work": "work", "wait": "wait"][st] ?? "tx3", size: 14)
        i.toolTip = t("group.\(st)")
        i.setAccessibilityLabel(t("group.\(st)"))
        return i
    }

    // MARK: views

    private func list(_ v: [String: Any], _ s: [String: Any], _ d: [String: Any], _ sec: [Int]) -> NSView {
        let sp = spec(s)
        let items = rowsOf(d)
        let objRows = sp["place"] as? String == "ravenry:objective-rows"
        let rowOf = { [unowned self] (it: Item) -> NSView in
            let st = (it["state"] as? String).flatMap { ["you", "work", "idle"].contains($0) && it["$hash"] == nil ? $0 : nil }
            let pg = self.progress(it, sp["progress"] as? [String: Any])
            let lt = vstack([wrap(PageFmt.text(PageFmt.field(it, sp["title"] as? String ?? "title")), Fonts.pt(13, .medium)), self.subtitle(it, sp), self.excerpt(it, sp["excerpt"] as? String),
                             pg?.block == true ? pg?.view : nil, self.checklist(v, it, sp, sec), objRows ? nil : self.place(it, sp)], spacing: 3)
            soft(lt)
            let ra = hstack(self.itemButtons(v, sp, it, sec), spacing: 6)
            var right: [NSView?] = self.badges(it, sp, s).map { Optional($0) }
            right += [pg?.block == false ? pg?.view : nil, self.timeEl(it, sp), ra]
            let b = card(self.fillRow(st.map { self.ring($0) }, lt, right.compactMap { $0 }.filter { !(($0 as? NSStackView)?.arrangedSubviews.isEmpty ?? false) }),
                         fill: "card", radius: 0, insets: NSEdgeInsets(top: 9, left: 16, bottom: 9, right: 16)) { [weak self] in self?.openItem(v, it, sec) }
            b.fill = nil
            b.key = PageFmt.text(it["file"] ?? it["id"])
            self.pb["row:\(b.key)"] = b
            return vstack([hline(), b])
        }
        let title = s["title"] as? String
        let head = title.map { cardHead($0, items.count) }
        if items.isEmpty { return vstack([ocard([head, orow(wrap(s["empty"] as? String ?? t("page.empty"), Fonts.pt(12.5), "tx2"))]), sectionActions(v, s, sec)], spacing: 12) }
        if s["groupBy"] as? String != nil, let gs = groupsOf(d) {
            return vstack([head] + gs.map { g in ocard([cardHead(g.value ?? t("pg.none"), g.items.count)] + g.items.map(rowOf)) } + [sectionActions(v, s, sec)], spacing: 12)
        }
        return vstack([ocard([head] + items.map(rowOf)), sectionActions(v, s, sec)], spacing: 12)
    }

    private func cards(_ v: [String: Any], _ s: [String: Any], _ items: [Item], _ sec: [Int]) -> NSView {
        let sp = spec(s)
        if items.isEmpty { return ocard([(s["title"] as? String).map { cardHead($0, nil) }, orow(wrap(s["empty"] as? String ?? t("page.empty"), Fonts.pt(12.5), "tx2"))]) }
        if sp["place"] as? String == "ravenry:objective-rows" {
            // Objectives' cards: one per project, its goal on the line, then its
            // objectives as rows. The name opens the project; a row the brief
            // at that objective (a plan's row, that plan); a task's dot ticks
            // it in the brief; Edit the brief opens the file.
            return vstack(items.map { it -> NSView in
                let r = (it["$ravenry"] as? [String: Any])?["rows"] as? [[String: Any]] ?? []
                let st = it["state"] as? String ?? "idle"
                let pid = PageFmt.text(it["id"])
                let name = btn("project:\(pid)", PageFmt.text(PageFmt.field(it, sp["title"] as? String ?? "name")), .link) { [weak self] in self?.openItem(v, it, sec) }
                name.titleColor = "tx"; name.titleSize = 13.5
                name.toolTip = t("pg.openProjectTip")
                let goal = PageFmt.text((sp["subtitle"] as? String).flatMap { PageFmt.field(it, $0) })
                let briefFile = PageFmt.text((it["brief"] as? [String: Any])?["path"])
                let edit: NSView? = briefFile.isEmpty || it["machine"] != nil ? nil : btn("editBrief:\(pid)", t("pg.editBrief"), .quiet, lead: "doc") { Outside.openFile(briefFile) }
                var hv: [NSView?] = [ring(["you", "work", "idle", "wait"].contains(st) ? st : "idle"), name]
                hv += badges(it, sp, s).map { Optional($0) }
                let gl = label(md: goal.isEmpty ? t("pg.noGoal") : goal, Fonts.pt(12.5), "tx2")
                gl.toolTip = goal.isEmpty ? nil : InlineMd.plain(goal)
                hv += [soft(gl), spring(), edit]
                hv += itemButtons(v, sp, it, sec).map { Optional($0) }
                let head = prow(hv, spacing: 10, insets: NSEdgeInsets(top: 11, left: 16, bottom: 11, right: 16))
                let off = self.off(v) != nil || it["machine"] != nil || briefFile.isEmpty
                let rows: [NSView] = r.isEmpty ? [orow(label(t("pg.noPlanYet"), Fonts.pt(12.5), "tx2"))] : r.map { row in
                    let title = row["title"] as? String ?? ""
                    let isPlan = row["kind"] as? String == "plan"
                    return objRow(row, key: pid, open: { [weak self] in
                        if isPlan { self?.host?.openPlan(pid, title) } else { self?.openBrief(pid, title) }
                    }, tickTask: off ? nil : { [weak self] text, done in self?.tickTask(pid, objective: title, text: text, done: done) })
                }
                return ocard([head] + rows)
            }, spacing: 14)
        }
        let n = cols(300)
        let cw = (width - CGFloat(n - 1) * 12) / CGFloat(n)
        let cardsV = items.map { it -> NSView in
            let pg = progress(it, sp["progress"] as? [String: Any])
            let mr = badges(it, sp, s)
            let body = vstack([hstack([soft(wrap(PageFmt.text(PageFmt.field(it, sp["title"] as? String ?? "title")), Fonts.pt(15, .bold))), timeEl(it, sp)].compactMap { $0 }, spacing: 8),
                               subtitle(it, sp), mr.isEmpty ? nil : flow(mr, width: cw - 28, gap: 6), pg?.view, excerpt(it, sp["excerpt"] as? String), checklist(v, it, sp, sec), place(it, sp),
                               { let b = itemButtons(v, sp, it, sec); return b.isEmpty ? nil : flow(b, width: cw - 28, gap: 6) }()], spacing: 7, insets: NSEdgeInsets(top: 12, left: 14, bottom: 14, right: 14))
            let c = card(vstack([picture(image(v, it, sp["image"] as? String), cap: 200, aspect: 1.6), body])) { [weak self] in self?.openItem(v, it, sec) }
            c.key = PageFmt.text(it["file"] ?? it["id"] ?? it["path"])
            pb["card:\(c.key)"] = c
            return c
        }
        return vstack([(s["title"] as? String).map { label($0, Fonts.pt(12.5, Fonts.w650), "tx2") }, grid(cardsV, cols: n, gap: 12), sectionActions(v, s, sec)], spacing: 10)
    }

    /// Rows of `cols` cells of one width, each row as tall as its tallest (a CSS grid).
    private func grid(_ cells: [NSView], cols: Int, gap: CGFloat) -> NSView {
        var rows: [NSView] = []
        var i = 0
        while i < cells.count {
            let part = Array(cells[i..<min(cells.count, i + cols)])
            let filler = (0..<(cols - part.count)).map { _ in NSView() }
            let r = NSStackView(views: part + filler)
            r.orientation = .horizontal; r.distribution = .fillEqually; r.alignment = .top; r.spacing = gap
            r.translatesAutoresizingMaskIntoConstraints = false
            for c in part { c.heightAnchor.constraint(equalTo: r.heightAnchor).isActive = true }
            rows.append(r)
            i += cols
        }
        return vstack(rows, spacing: gap)
    }

    /// Views left to right, onto a new line when the width is used (flex-wrap).
    private func flow(_ views: [NSView], width: CGFloat, gap: CGFloat) -> NSView {
        var lines: [[NSView]] = [[]]
        var used: CGFloat = 0
        for v in views {
            let w = v.fittingSize.width
            if !lines[lines.count - 1].isEmpty && used + gap + w > width { lines.append([]); used = 0 }
            used += (lines[lines.count - 1].isEmpty ? 0 : gap) + w
            lines[lines.count - 1].append(v)
        }
        return vstack(lines.map { hstack($0 + [spring()], spacing: gap) }, spacing: gap)
    }

    private func board(_ v: [String: Any], _ s: [String: Any], _ d: [String: Any], _ sec: [Int]) -> NSView {
        let sp = spec(s)
        let groupBy = s["groupBy"] as? String ?? ""
        let fieldOK = ((s["source"] as? [String: Any])?["kind"] as? String) != "provider" && (((s["source"] as? [String: Any])?["fields"] as? [String: Any])?[groupBy] != nil)
        let groups = groupsOf(d) ?? []
        let narrow = width / CGFloat(max(1, groups.count)) < 240
        let name = { (g: String?) in g.map { PageFmt.capitalise($0) } ?? t("pg.none") }
        let off = self.off(v)
        let meta = { [unowned self] (it: Item) -> NSView? in
            let parts = self.badges(it, sp, s) + [self.timeEl(it, sp)].compactMap { $0 }
            return parts.isEmpty ? nil : hstack(parts.count > 1 ? Array(parts.dropLast()) + [spring(), parts.last!] : parts + [spring()], spacing: 6)
        }
        let lk = { (g: String?) in "\(v["key"] ?? "")|\(sec[0]).\(sec[1])|\(g ?? "null")" }
        if narrow {
            // Below about 240 points a lane: a list grouped by lane, the last folded.
            return vstack(groups.enumerated().map { i, g -> NSView in
                let k = lk(g.value)
                let isFolded = folded[k] ?? (i == groups.count - 1 && groups.count > 1)
                let tg: NSView = isFolded ? hstack([label(t("pg.show"), Fonts.pt(12, .medium), "tx2"), Icon("chevron", "tx2", size: 12)], spacing: 4) : Icon("down", "tx2", size: 12)
                let h = card(hstack([label(name(g.value), Fonts.pt(12.5, Fonts.w650)), countPill(g.items.count), spring(), tg], spacing: 8), radius: 0, insets: NSEdgeInsets(top: 9, left: 12, bottom: 9, right: 12)) { [weak self] in
                    self?.folded[k] = !isFolded; self?.redraw()
                }
                h.fill = nil
                pb["lane:\(g.value ?? "null")"] = h
                let rows: [NSView] = isFolded ? [] : g.items.map { it in
                    let tx = vstack([wrap(PageFmt.text(PageFmt.field(it, sp["title"] as? String ?? "title")), Fonts.pt(13, .semibold)), subtitle(it, sp), meta(it)], spacing: 5)
                    let r = card(hstack([soft(tx), thumb(image(v, it, sp["image"] as? String))].compactMap { $0 }, spacing: 12), radius: 0, insets: NSEdgeInsets(top: 9, left: 12, bottom: 9, right: 12)) { [weak self] in self?.openItem(v, it, sec) }
                    r.fill = nil
                    r.key = PageFmt.text(it["file"] ?? it["id"])
                    pb["note:\(r.key)"] = r
                    return vstack([hline(), r])
                }
                let c = ocard([h] + rows)
                lanes.append((g.value, c as! Box))
                return c
            } + [sectionActions(v, s, sec)].compactMap { $0 }, spacing: 12)
        }
        let laneViews = groups.enumerated().map { gi, g -> NSView in
            let k = lk(g.value)
            let cap = shown.contains(k) ? Int.max : gi == groups.count - 1 && groups.count > 1 ? 3 : 12
            let vis = Array(g.items.prefix(cap))
            let lh = hstack([label(name(g.value), Fonts.pt(12.5, Fonts.w650)), countPill(g.items.count), spring()], spacing: 8, insets: NSEdgeInsets(top: 6, left: 4, bottom: 2, right: 4))
            lh.heightAnchor.constraint(equalToConstant: 28).isActive = true
            var col: [NSView] = [lh]
            for it in vis {
                let acts = itemButtons(v, sp, it, sec)
                let actsV = acts.isEmpty ? nil : flow(acts, width: 160, gap: 6)
                actsV?.isHidden = true
                let pg = progress(it, sp["progress"] as? [String: Any])
                let bd = vstack([wrap(PageFmt.text(PageFmt.field(it, sp["title"] as? String ?? "title")), Fonts.pt(13, .semibold)), subtitle(it, sp), excerpt(it, sp["excerpt"] as? String), pg?.view, meta(it), place(it, sp), checklist(v, it, sp, sec), actsV],
                                spacing: 8, insets: NSEdgeInsets(top: 9, left: 11, bottom: 10, right: 11))
                let nt = NoteCard(fill: "tile", radius: 8)
                nt.translatesAutoresizingMaskIntoConstraints = false
                nt.layer?.masksToBounds = true
                let inner = vstack([picture(image(v, it, sp["image"] as? String), cap: 220), bd])
                nt.addSubview(inner)
                NSLayoutConstraint.activate([inner.leadingAnchor.constraint(equalTo: nt.leadingAnchor), inner.trailingAnchor.constraint(equalTo: nt.trailingAnchor), inner.topAnchor.constraint(equalTo: nt.topAnchor), inner.bottomAnchor.constraint(equalTo: nt.bottomAnchor)])
                nt.acts = actsV
                nt.key = PageFmt.text(it["file"] ?? it["id"])
                nt.onPress = { [weak self] in self?.openItem(v, it, sec) }
                // A11Y-004: a note says what it is to VoiceOver (its words, as read).
                nt.setAccessibilityElement(true); nt.setAccessibilityRole(.button); nt.setAccessibilityLabel(axWords(bd))
                nt.draggable = off == nil && it["$hash"] != nil && fieldOK
                nt.dragMoved = { [weak self, weak nt] p in if let nt { self?.dragMove(nt, p) } }
                nt.dragEnded = { [weak self] p in self?.drop(v, it, groupBy, p, sec) }
                pb["note:\(nt.key)"] = nt
                col.append(nt)
            }
            if g.items.count > vis.count { col.append(hstack([btn("more:\(g.value ?? "null")", t("pg.more", ["n": "\(g.items.count - vis.count)"]), .ghost) { [weak self] in self?.shown.insert(k); self?.redraw() }, spring()], spacing: 0)) }
            for c in col { c.setContentHuggingPriority(.required, for: .vertical) }
            let cv = vstack(col, spacing: 8)
            cv.setHuggingPriority(.required, for: .vertical)
            let lane = card(cv, insets: NSEdgeInsets(top: 6, left: 8, bottom: 8, right: 8))
            lanes.append((g.value, lane))
            return lane
        }
        // .lanes: side by side, as wide as each other, each as tall as its notes (align-items: flex-start).
        let row = Flipped()
        row.translatesAutoresizingMaskIntoConstraints = false
        var prev: NSView? = nil
        for l in laneViews {
            row.addSubview(l)
            var cs = [l.topAnchor.constraint(equalTo: row.topAnchor), l.bottomAnchor.constraint(lessThanOrEqualTo: row.bottomAnchor),
                      l.leadingAnchor.constraint(equalTo: prev?.trailingAnchor ?? row.leadingAnchor, constant: prev == nil ? 0 : 12)]
            if let p = prev { cs.append(l.widthAnchor.constraint(equalTo: p.widthAnchor)) }
            NSLayoutConstraint.activate(cs)
            prev = l
        }
        prev?.trailingAnchor.constraint(equalTo: row.trailingAnchor).isActive = true
        let hug = row.heightAnchor.constraint(equalToConstant: 0); hug.priority = .init(50); hug.isActive = true
        return vstack([row, sectionActions(v, s, sec)], spacing: 12)
    }

    /// A note dragged: its picture follows the pointer, the lane under it lit.
    private func dragMove(_ nt: NoteCard, _ p: NSPoint) {
        if ghost == nil, let rep = nt.bitmapImageRepForCachingDisplay(in: nt.bounds) {
            nt.cacheDisplay(in: nt.bounds, to: rep)
            let img = NSImage(size: nt.bounds.size); img.addRepresentation(rep)
            let g = NSImageView(image: img)
            g.frame = NSRect(origin: .zero, size: nt.bounds.size)
            g.alphaValue = 0.85
            addSubview(g)
            ghost = g
            nt.alphaValue = 0.4
        }
        let q = convert(p, from: nil)
        ghost?.frame.origin = NSPoint(x: q.x - (ghost?.frame.width ?? 0) / 2, y: q.y - 20)
        let at = laneAt(p)
        for l in lanes { l.view.ring = l.view === at?.view && at?.value != nil ? "work" : nil; l.view.ringWidth = 1.5 }
    }

    private func laneAt(_ p: NSPoint) -> (value: String?, view: Box)? {
        lanes.first { l in l.view.bounds.contains(l.view.convert(p, from: nil)) }
    }

    private func drop(_ v: [String: Any], _ it: Item, _ field: String, _ p: NSPoint?, _ sec: [Int]) {
        ghost?.removeFromSuperview(); ghost = nil
        for l in lanes { l.view.ring = nil }
        pb.values.forEach { ($0 as? NoteCard)?.alphaValue = 1 }
        guard let p, let at = laneAt(p), let value = at.value, PageFmt.text(it[field]) != value else { return }
        moveTo(v, it, field, value, sec)
    }

    /// The self-test's drag: the note to the lane, as the pointer would take it.
    func dragForTest(_ noteKey: String, to value: String) -> Bool {
        guard let nt = pb["note:\(noteKey)"] as? NoteCard, let lane = lanes.first(where: { $0.value == value })?.view, let win = window else { return false }
        let from = nt.convert(NSPoint(x: nt.bounds.midX, y: nt.bounds.midY), to: nil)
        let to = lane.convert(NSPoint(x: lane.bounds.midX, y: 30), to: nil)
        let ev = { (type: NSEvent.EventType, p: NSPoint) in NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: win.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) }
        for i in 1...4 { if let e = ev(.leftMouseDragged, NSPoint(x: from.x + (to.x - from.x) * CGFloat(i) / 4, y: from.y + (to.y - from.y) * CGFloat(i) / 4)) { NSApp.postEvent(e, atStart: false) } }
        if let up = ev(.leftMouseUp, to) { NSApp.postEvent(up, atStart: false) }
        if let down = ev(.leftMouseDown, from) { nt.mouseDown(with: down) }
        return true
    }

    /// A table (.ptable): each column as wide as its widest value, the
    /// first (the title) taking what is left and wrapping when it is short of
    /// room; numbers to the right; a row opens its item.
    private func table(_ v: [String: Any], _ s: [String: Any], _ items: [Item], _ sec: [Int]) -> NSView {
        let sp = spec(s)
        let cols = (s["columns"] as? [[String: Any]]) ?? [["field": sp["title"] as? String ?? "title", "label": t("pg.titleCol"), "align": "start"]]
        let fields = (s["source"] as? [String: Any])?["fields"] as? [String: Any]
        let ftype = { (f: String) in ((fields?[String(f.split(separator: ".").first ?? "")] as? [String: Any])?["type"] as? String) ?? "" }
        let hasActs = !actions(sp).isEmpty
        let gap: CGFloat = 28
        let font = { (i: Int) in Fonts.pt(12.5, i == 0 ? .semibold : .regular).withTabularDigits }
        /// A cell's words (nil: an enum's tag), as they are shown.
        let words = { (it: Item, c: [String: Any]) -> (String, Bool)? in
            let f = c["field"] as? String ?? ""
            let val = PageFmt.field(it, f)
            if val == nil || PageFmt.text(val).isEmpty && !(val is NSNumber) { return ("", false) }
            if ftype(f) == "enum" { return (PageFmt.text(val), true) }
            if ftype(f) == "date" { return (PageFmt.time(val), false) }
            if let n = val as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() { let nf = NumberFormatter(); nf.numberStyle = .decimal; nf.locale = Locale(identifier: "en_US"); return (nf.string(from: n) ?? PageFmt.text(n), false) }
            return (PageFmt.text(val), false)
        }
        // Each column's natural width: its header's and its widest value's.
        var natural: [CGFloat] = cols.enumerated().map { i, c in
            let head = ((c["label"] as? String ?? "") as NSString).size(withAttributes: [.font: Fonts.pt(11.5, .semibold)]).width
            let cells = items.map { it -> CGFloat in
                guard let (w, tag) = words(it, c) else { return 0 }
                return (w as NSString).size(withAttributes: [.font: tag ? Fonts.pt(11, .semibold) : font(i)]).width + (tag ? 16 : 0)
            }
            return ceil(max(head, cells.max() ?? 0)) + 2
        }
        let actsW = hasActs ? (items.map { hstack(itemButtons(v, sp, $0, sec), spacing: 4).fittingSize.width }.max() ?? 0) + 16 : 0
        let room = width - 32 - actsW - gap * CGFloat(max(0, cols.count - 1))
        let others = natural.dropFirst().reduce(0, +)
        // The title takes what the others leave (at least 140, wrapping); the others shrink in turn only past that.
        if !natural.isEmpty { natural[0] = max(min(natural[0], 600), max(140, room - others)) }
        if natural.reduce(0, +) > room, natural.count > 1 {
            let k = max(0.3, (room - natural[0]) / max(1, others))
            for i in 1..<natural.count { natural[i] = floor(natural[i] * min(1, k)) }
        }
        let cell = { (it: Item, c: [String: Any], i: Int) -> NSView in
            let f = c["field"] as? String ?? ""
            let end = c["align"] as? String == "end" || (PageFmt.field(it, f) is NSNumber && ftype(f) != "enum")
            var view: NSView
            let (w, tag) = words(it, c) ?? ("", false)
            if w.isEmpty { view = NSView() }
            else if tag { view = hstack([asTag(w, tone: PageFmt.tone(PageFmt.field(it, f)))], spacing: 0) }
            else {
                // The title wraps when its column is short of room; a value keeps one line, cut at its end.
                if i == 0 { let l = wrap(w, font(i), "tx"); view = l }
                else { let l = label(w, font(i), ftype(f) == "date" ? "tx2" : "tx"); l.alignment = end ? .right : .left; l.toolTip = w; view = l }
            }
            return fix(hstack(end ? [spring(), view] : [view, spring()], spacing: 0), w: natural[i])
        }
        let rowView = { (cells: [NSView], acts: NSView?, press: (() -> Void)?, ins: NSEdgeInsets) -> NSView in
            let r = hstack(cells + [spring()], spacing: gap)
            let line = hstack([soft(r), acts].compactMap { $0 }, spacing: 16)
            let b = card(line, fill: "card", radius: 0, insets: ins, press: press); b.fill = nil
            return b
        }
        var rows: [NSView] = []
        if let tt = s["title"] as? String { rows.append(cardHead(tt, nil)) }
        rows.append(rowView(cols.enumerated().map { i, c -> NSView in
            let l = label(c["label"] as? String ?? "", Fonts.pt(11.5, .semibold), "tx3")
            let end = c["align"] as? String == "end"
            l.alignment = end ? .right : .left
            return fix(end ? hstack([spring(), l], spacing: 0) : hstack([l, spring()], spacing: 0), w: natural[i])
        }, hasActs ? fix(NSView(), w: max(1, actsW - 16)) : nil, nil, NSEdgeInsets(top: 10, left: 16, bottom: 10, right: 16)))
        if items.isEmpty { rows.append(orow(label(s["empty"] as? String ?? t("page.empty"), Fonts.pt(12.5), "tx2"))) }
        for it in items {
            let b = rowView(cols.enumerated().map { i, c in cell(it, c, i) }, hasActs ? fix(hstack(itemButtons(v, sp, it, sec) + [spring()], spacing: 4), w: max(1, actsW - 16)) : nil, { [weak self] in self?.openItem(v, it, sec) }, NSEdgeInsets(top: hasActs ? 6 : 9, left: 16, bottom: hasActs ? 6 : 9, right: 16))
            let key = PageFmt.text(it["file"] ?? it["id"])
            pb["trow:\(key)"] = b
            rows.append(hline()); rows.append(b)
        }
        return vstack([ocard(rows), sectionActions(v, s, sec)], spacing: 12)
    }

    private func stats(_ d: [String: Any]) -> NSView {
        let st = d["stats"] as? [[String: Any]] ?? []
        let cells = st.map { x -> NSView in
            let val = x["value"]
            let shown = val == nil || val is NSNull ? t("pg.none") : val is String ? PageFmt.time(val) : PageFmt.text(val)
            return card(vstack([label(x["label"] as? String ?? "", Fonts.pt(12.5), "tx2"), label(shown, Fonts.pt(24, .bold).withTabularDigits), (x["note"] as? String).map { label($0, Fonts.pt(12), "tx3") }], spacing: 4), insets: NSEdgeInsets(top: 14, left: 16, bottom: 14, right: 16))
        }
        return grid(cells, cols: min(max(1, cells.count), cols(200)), gap: 12)
    }

    private func documentView(_ v: [String: Any], _ s: [String: Any], _ d: [String: Any], _ sec: [Int]) -> NSView {
        let sp = spec(s)
        let items = rowsOf(d)
        if items.isEmpty { return ocard([orow(label(s["empty"] as? String ?? t("page.empty"), Fonts.pt(12.5), "tx2"))]) }
        let doc = { [unowned self] (it: Item) -> NSView in
            let can = self.actions(sp).contains { $0["kind"] as? String == "toggle" } && self.off(v) == nil
            let boxes = it["$boxes"] as? [[String: Any]] ?? []
            let pg = self.progress(it, sp["progress"] as? [String: Any])
            let open: NSView? = it["$hash"] != nil || it["done"] != nil ? self.btn("open:\(PageFmt.text(it["file"] ?? it["path"]))", t("pg.open"), .quiet, lead: "doc") { [weak self] in guard let self else { return }; Outside.openFile(self.itemPath(v, it, sec)) } : nil
            var hv: [NSView?] = [soft(label(PageFmt.text(PageFmt.field(it, sp["title"] as? String ?? "title")), Fonts.pt(13.5, Fonts.w650)))]
            hv += self.badges(it, sp, s).map { Optional($0) }
            hv += [pg?.block == false ? pg?.view : nil, spring(), open]
            let head = self.prow(hv, spacing: 10, insets: NSEdgeInsets(top: 11, left: 20, bottom: 11, right: 16))
            let file = PageFmt.text(it["file"] ?? it["path"])
            let body = self.markdown(PageFmt.text(it["body"]), key: file, dir: (self.itemPath(v, it, sec) as NSString).deletingLastPathComponent, can: can, skipTitle: PageFmt.text(PageFmt.field(it, sp["title"] as? String ?? "title"))) { [weak self] k, done in
                guard k < boxes.count else { return }
                self?.toggle(v, it, sec, line: boxes[k]["line"] as? Int ?? 0, text: boxes[k]["text"] as? String ?? "", done: done)
            }
            let acts = self.itemButtons(v, sp, it, sec)
            return card(vstack([head, hline(), pg?.block == true ? self.pad(pg!.view, NSEdgeInsets(top: 10, left: 20, bottom: 0, right: 20)) : nil,
                                self.pad(body.text.string.isEmpty ? label(t("pg.emptyFile"), Fonts.pt(13), "tx3") : body, NSEdgeInsets(top: 16, left: 20, bottom: 20, right: 20)), acts.isEmpty ? nil : self.pad(hstack(acts + [spring()], spacing: 6), NSEdgeInsets(top: 0, left: 20, bottom: 14, right: 20))], spacing: 0))
        }
        if s["groupBy"] as? String != nil, let gs = groupsOf(d) {
            return vstack(gs.map { g in vstack([pad(label(g.value ?? t("pg.other"), Fonts.pt(12.5, Fonts.w650), "tx2"), NSEdgeInsets(top: 2, left: 2, bottom: 6, right: 2))] + g.items.map(doc), spacing: 12) }, spacing: 18)
        }
        return vstack(items.map(doc), spacing: 12)
    }

    private func pad(_ v: NSView, _ ins: NSEdgeInsets) -> NSView { boxed(v, fill: nil, radius: 0, insets: ins) }

    /// A row's views left to right with room around them (.orow's padding):
    /// the room is the box's own, so the row is always that much taller than
    /// what it holds (a stack's edge insets are not kept in its height).
    private func prow(_ views: [NSView?], spacing: CGFloat = 14, insets: NSEdgeInsets = NSEdgeInsets(top: 9, left: 16, bottom: 9, right: 16)) -> NSView {
        boxed(hstack(views, spacing: spacing), fill: nil, radius: 0, insets: insets)
    }

    /// .orow as flex: a lead (a ring), the main column taking every point the
    /// rest leaves (flex 1, so a plan's band spans it), then the right-hand
    /// views at their own widths, 14 apart, each on the row's middle; the row
    /// as tall as its tallest.
    private func fillRow(_ lead: NSView?, _ main: NSView, _ right: [NSView]) -> NSView {
        let c = Flipped()
        c.translatesAutoresizingMaskIntoConstraints = false
        let rs = hstack(right, spacing: 14)
        var cs: [NSLayoutConstraint] = []
        for v in [lead, main, right.isEmpty ? nil : rs].compactMap({ $0 }) {
            v.translatesAutoresizingMaskIntoConstraints = false
            c.addSubview(v)
            cs += [v.centerYAnchor.constraint(equalTo: c.centerYAnchor), v.topAnchor.constraint(greaterThanOrEqualTo: c.topAnchor), v.bottomAnchor.constraint(lessThanOrEqualTo: c.bottomAnchor)]
        }
        cs.append(main.leadingAnchor.constraint(equalTo: lead?.trailingAnchor ?? c.leadingAnchor, constant: lead == nil ? 0 : 14))
        if let lead { cs.append(lead.leadingAnchor.constraint(equalTo: c.leadingAnchor)) }
        if right.isEmpty { cs.append(main.trailingAnchor.constraint(equalTo: c.trailingAnchor)) }
        else { cs += [rs.leadingAnchor.constraint(equalTo: main.trailingAnchor, constant: 14), rs.trailingAnchor.constraint(equalTo: c.trailingAnchor)] }
        let hug = c.heightAnchor.constraint(equalToConstant: 0); hug.priority = .init(240); cs.append(hug)
        NSLayoutConstraint.activate(cs)
        // The right-hand views at their own width (a stack has no hugging of its own to hold it).
        if !right.isEmpty { let w = rs.widthAnchor.constraint(equalToConstant: ceil(rs.fittingSize.width)); w.priority = .init(900); w.isActive = true }
        return c
    }

    /// The sections of each document a person folded, by its file.
    private var docFolds: [String: Set<Int>] = [:]

    /// A document's Markdown (DocView); a box ticks through `onBox` (its place among the text's boxes, its new state).
    private func markdown(_ md: String, key: String, dir: String, can: Bool, skipTitle: String? = nil, onBox: @escaping (Int, Bool) -> Void) -> DocView {
        let dv = DocView(md, dir: dir, canTick: can, folded: docFolds[key] ?? [], skipTitle: skipTitle)
        dv.onBox = onBox
        dv.onFold = { [weak self] f in self?.docFolds[key] = f }
        pb["doc:\(key)"] = dv
        return dv
    }

    // MARK: Ravenry's own views

    private func pluginView(_ v: [String: Any], _ s: [String: Any], _ items: [Item], _ sec: [Int]) -> NSView {
        switch s["view"] as? String ?? "" {
        case "ravenry:brainstorm": return brainstorm(v)
        case "ravenry:memory-rules": return memoryRules(v, s)
        case "ravenry:sessions": return sessions(v, items)
        default: return ocard([cardHead(s["title"] as? String ?? s["view"] as? String ?? "", nil), orow(wrap(t("pg.notDrawnHere", ["view": s["view"] as? String ?? ""]), Fonts.pt(12.5), "tx2"))])
        }
    }

    private func brainstorm(_ v: [String: Any]) -> NSView {
        let off = self.off(v)
        let f = field("seed", t("pg.seed"))
        let empty = { [weak self] in self?.window?.makeFirstResponder(f.field); self?.toast?(t("pg.typeSeed")) }
        let add = btn("bs:add", t("pg.addIdea"), small: false) { [weak self] in
            guard let self else { return }
            let s = self.typed("seed")
            if s.isEmpty { empty(); return }
            self.send("/api/ideas/add", ["name": s, "stage": "spark"], fail: t("pg.notAdded")) { code, _ in if code == 200 { self.clear("seed") } }
        }
        let go = btn("bs:go", t("pg.directions"), .primary, small: false) { [weak self] in
            guard let self else { return }
            let s = self.typed("seed")
            if s.isEmpty { empty(); return }
            self.send("/api/ideas/brainstorm", ["seed": s], fail: t("pg.notStartedShort"), reload: false) { code, _ in if code == 200 { self.toast?(t("pg.thinking")); self.clear("seed"); self.readBrainstorm(self.key) } }
        }
        add.isEnabled = off == nil; go.isEnabled = off == nil
        // .bs-r (flex-wrap, gap 8): the field (.field, flex 1 1 320px) and the
        // buttons go on a line while their widths fit, the rest onto the next;
        // the field takes what its line leaves.
        let inner = width - 24
        var lines: [[NSView]] = [[]]
        var used: CGFloat = 0
        for (v, w) in [(f as NSView, CGFloat(320)), (add, add.fittingSize.width), (go, go.fittingSize.width)] {
            if !lines[lines.count - 1].isEmpty && used + 8 + w > inner { lines.append([]); used = 0 }
            used += (lines[lines.count - 1].isEmpty ? 0 : 8) + w
            lines[lines.count - 1].append(v)
        }
        var rows = lines.map { l in hstack(l.contains { $0 === f } ? [soft(f)] + l.dropFirst() : l + [spring()], spacing: 8) }
        // The brainstorm under way (it stops at 3 minutes), or one that came back wrong, with Clear (hub/public/app.js #i-brain).
        let k = v["key"] as? String ?? ""
        if brainstormState == nil || Date().timeIntervalSince(brainstormState!.at) > 4 { readBrainstorm(k) }
        if let r = brainstormState?.running {
            let secs = When.date(r["startedAt"] as? String).map { max(0, Int(Date().timeIntervalSince($0))) } ?? 0
            rows.append(hstack([wrap(t("pg.bsThinking", ["who": Assistants.short(r["who"] as? String), "seed": r["seed"] as? String ?? "", "secs": "\(secs)"]), Fonts.pt(12.5), "work"), spring()], spacing: 8))
        } else if let e = brainstormState?.error {
            let clear = btn("bs:clear", t("pg.bsClear")) { [weak self] in
                self?.send("/api/ideas/brainstorm/clear", [:], fail: t("page.didNotWork"), reload: false) { code, _ in
                    if code == 200 { self?.brainstormState = (Date(), nil, nil); self?.dirty(); self?.redraw() }
                }
            }
            clear.isEnabled = off == nil
            rows.append(hstack([soft(wrap(e, Fonts.pt(12.5), "bad")), clear], spacing: 8))
        }
        return card(vstack(rows, spacing: 8), insets: NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12))
    }

    /// The brainstorm's line from GET /api/ideas: read again every second while one runs, the view drawn again when it changed.
    private func readBrainstorm(_ k: String) {
        brainstormState = (Date(), brainstormState?.running, brainstormState?.error)
        hub?.get("/api/ideas") { [weak self] code, j in
            guard let self, code == 200 else { return }
            let r = j["brainstorm"] as? [String: Any], e = j["brainstormError"] as? String
            let changed = (r == nil) != (self.brainstormState?.running == nil) || e != self.brainstormState?.error || r != nil
            self.brainstormState = (Date(), r, e)
            guard self.key == k, self.window != nil else { return }
            if changed { self.dirty(); self.redraw() }
            if r != nil { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in if self?.key == k { self?.readBrainstorm(k) } } }
        }
    }

    private func memoryRules(_ v: [String: Any], _ s: [String: Any]) -> NSView {
        if memory == nil || Date().timeIntervalSince(memory!.at) > 60 {
            memory = (Date(), memory?.rules ?? [])
            hub?.get("/api/rules") { [weak self] code, j in
                guard let self else { return }
                self.memory = (Date(), j["rules"] as? [[String: Any]] ?? [])
                if self.key == (v["key"] as? String ?? "") { self.redraw() }
            }
        }
        let rules = (memory?.rules ?? []).filter { $0["pending"] as? Bool == true }
        let decide = { [weak self] (id: String, action: String) in
            self?.send("/api/rules/\(self?.enc(id) ?? id)", ["action": action], fail: t("pg.notSaved"), reload: false) { code, _ in
                if code == 200 { self?.toast?(action == "dismiss" ? t("pg.rememberedNot") : t("pg.saved")) }
                self?.memory = nil; self?.dirty(); self?.redraw()
            }
        }
        let rows: [NSView] = rules.isEmpty ? [orow(label(t("pg.nothingMemory"), Fonts.pt(12.5), "tx2"))] : rules.map { r in
            let id = r["id"] as? String ?? ""
            let lt = vstack([wrap(r["text"] as? String ?? "", Fonts.pt(13, .medium)), wrap(r["why"] as? String ?? "", Fonts.pt(12.5, .medium), "tx2")], spacing: 3)
            return orow(hstack([soft(lt), btn("mem:\(id):global", t("pg.everyProject"), .primary) { decide(id, "global") },
                                btn("mem:\(id):local", (r["localLabel"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? t("pg.thisProject")) { decide(id, "local") },
                                btn("mem:\(id):dismiss", t("pg.notARule")) { decide(id, "dismiss") }], spacing: 6))
        }
        // Behind "N more from project memory" with Show, as the browser board keeps them (PAGE-010); with none, the line that says so.
        if rules.isEmpty { return ocard([cardHead(s["title"] as? String ?? t("pg.fromMemory"), rules.count)] + rows) }
        let more = btn("mem:more", memoryShown ? t("pg.hideMemory") : t("pg.show"), .link) { [weak self] in
            guard let self else { return }
            self.memoryShown.toggle(); self.dirty(); self.redraw()
        }
        let line = hstack([label(t("pg.moreFromMemory", ["n": "\(rules.count)"]), Fonts.pt(12.5), "tx2"), more, spring()], spacing: 8)
        return memoryShown ? vstack([line, ocard([cardHead(s["title"] as? String ?? t("pg.fromMemory"), rules.count)] + rows)], spacing: 8) : line
    }

    private func sessions(_ v: [String: Any], _ items: [Item]) -> NSView {
        let idle = items.filter { $0["closable"] as? Bool == true && ["idle", "handed", "left"].contains(PageFmt.text($0["group"])) }
        let close: NSView? = idle.isEmpty ? nil : btn("sessions:closeIdle", t("pg.closeIdle", ["n": "\(idle.count)"])) { [weak self] in
            self?.send("/api/sessions/close", ["sessionIds": idle.map { $0["id"] ?? NSNull() }], fail: t("pg.notClosed")) { code, _ in if code == 200 { self?.toast?(t("pg.closed", ["n": "\(idle.count)"])) } }
        }
        return ocard([cardHead(t("pg.sessions"), items.count, extra: close.map { [$0] } ?? [])] + items.map { it in
            let lt = vstack([label(PageFmt.text(it["project_name"]), Fonts.pt(13, .medium)), wrap(PageFmt.text(it["line"]), Fonts.pt(12.5, .medium), "tx2")], spacing: 3)
            let mb = Int(((Double(PageFmt.text(it["memory_kb"])) ?? 0) / 1024).rounded())
            return orow(hstack([soft(lt), asTag(PageFmt.text(it["assistant"])), label(t("pg.mb", ["n": "\(mb)"]), Fonts.pt(12).withTabularDigits, "tx3")], spacing: 14))
        })
    }

    // MARK: sheets over the page

    final class FormState { let at: Addr; let action: [String: Any]; let sec: [Int]?; var error: String?; var busy = false
        init(at: Addr, action: [String: Any], sec: [Int]?) { self.at = at; self.action = action; self.sec = sec }
    }
    private(set) var form: FormState?
    private var popups: [String: NSPopUpButton] = [:]

    func openSheet(_ kind: String, _ content: NSView) {
        let keep = pb.filter { $0.key.hasPrefix("sheet:") }
        let f = kind == "form" ? form : nil
        closeSheet()
        pb.merge(keep) { $1 }
        form = f
        sheetKind = kind
        let layer = SheetLayer(content) { [weak self] in self?.closeSheet() }
        layer.frame = bounds
        layer.autoresizingMask = [.width, .height]
        addSubview(layer)
        sheetView = layer
        // Esc closes it wherever the keyboard was (the hidden terminal never gets it).
        window?.makeFirstResponder(layer)
    }
    func closeSheet() {
        sheetView?.removeFromSuperview(); sheetView = nil; sheetKind = ""; openedItem = nil
        pb = pb.filter { !$0.key.hasPrefix("sheet:") }
        if form != nil { form = nil }
    }
    override func cancelOperation(_ sender: Any?) { closeSheet() }

    private func sheetButtons(_ views: [NSView?]) -> NSView { hstack(views.compactMap { $0 }, spacing: 8) }
    private func h3(_ s: String) -> NSView { wrap(s, Fonts.pt(16, .bold)) }

    private func confirmSheet(_ text: String, ok: String, run: @escaping () -> Void) -> NSView {
        vstack([wrap(text, Fonts.pt(13)), sheetButtons([spring(), btn("sheet:cancel", t("pg.cancel"), small: false) { [weak self] in self?.closeSheet() },
                                                         btn("sheet:ok", ok, .primary, small: false) { [weak self] in self?.closeSheet(); run() }])], spacing: 12)
    }
    private func linkSheet(_ url: String) -> NSView {
        vstack([h3(t("pg.openAddress")), wrap(url, Fonts.mono(12)), sheetButtons([spring(), btn("sheet:cancel", t("pg.cancel"), small: false) { [weak self] in self?.closeSheet() },
                                                                                 btn("sheet:ok", t("pg.openBrowser"), .primary, small: false) { [weak self] in Outside.open(url); self?.closeSheet() }])], spacing: 12)
    }
    private func approveSheet(_ does: String, run: @escaping () -> Void) -> NSView {
        vstack([h3(t("pg.approveTitle")), wrap(does, Fonts.pt(13)), wrap(t("pg.approveNote"), Fonts.pt(12), "tx2"),
                sheetButtons([spring(), btn("sheet:cancel", t("pg.notNow"), small: false) { [weak self] in self?.closeSheet() },
                              btn("sheet:ok", t("pg.allow"), .primary, small: false) { [weak self] in self?.closeSheet(); run() }])], spacing: 12)
    }
    private func ruleSheet(_ item: Item, _ a: [String: Any]) -> NSView {
        let p = (item["$ravenry"] as? [String: Any])?["preview"] as? [String: Any] ?? [:]
        var rows: [NSView] = [h3(a["label"] as? String ?? "")]
        if let now = p["now"] as? String, !now.isEmpty {
            let old = wrap(now, Fonts.pt(13), "tx2")
            old.text.attributedStringValue = NSAttributedString(string: now, attributes: [.font: Fonts.pt(13), .foregroundColor: Design.color("tx2"), .strikethroughStyle: NSUnderlineStyle.single.rawValue])
            rows.append(vstack([label(p["nowLabel"] as? String ?? t("pg.ruleNow"), Fonts.pt(12), "tx3"), old], spacing: 4))
        }
        rows.append(vstack([label(p["nextLabel"] as? String ?? t("pg.willSay"), Fonts.pt(12), "tx3"), wrap(md: p["next"] as? String ?? PageFmt.text(item["rule"]), Fonts.pt(13))], spacing: 4))
        rows.append(wrap(t("pg.into", ["targets": PageFmt.text(item["targets"])]), Fonts.pt(12), "tx2"))
        rows.append(sheetButtons([spring(), btn("sheet:cancel", t("pg.cancel"), small: false) { [weak self] in self?.closeSheet() },
                                  btn("sheet:ok", t("pg.save"), .primary, small: false) { [weak self] in
                                      guard let self else { return }
                                      self.send("/api/repeats/\(self.enc(PageFmt.text(item["id"])))", ["action": PageFmt.text(item["kind"])], fail: t("pg.notSaved")) { code, j in
                                          if code == 200 { self.toast?(t("pg.writtenTo", ["target": (j["target"] as? [String] ?? []).joined(separator: t("pg.and"))])) }
                                          self.closeSheet()
                                      }
                                  }]))
        return vstack(rows, spacing: 12)
    }

    private func changedSheet(_ v: [String: Any]) -> NSView {
        let name = model(v)?["title"] as? String ?? v["id"] as? String ?? ""
        let dc = v["defaultChanged"] as? [String: Any] ?? [:]
        let from = PageFmt.text(dc["from"]), to = PageFmt.text(dc["to"])
        let lines = v["changed"] as? [[String: Any]] ?? []
        let code = NSMutableAttributedString()
        let ps = NSMutableParagraphStyle(); ps.minimumLineHeight = 19.4; ps.maximumLineHeight = 19.4
        for l in lines {
            let gap = l["gap"] as? Bool == true, add = l["add"] as? Bool == true
            let n = gap ? "" : PageFmt.text(l["n"])
            var at: [NSAttributedString.Key: Any] = [.font: Fonts.mono(12), .foregroundColor: Design.termFg.withAlphaComponent(gap ? 0.3 : 0.85), .paragraphStyle: ps]
            if add { at[.backgroundColor] = Design.color("ok").withAlphaComponent(0.14) }
            code.append(NSAttributedString(string: n.padding(toLength: 5, withPad: " ", startingAt: 0), attributes: at.merging([.foregroundColor: Design.termFg.withAlphaComponent(0.35)]) { $1 }))
            code.append(NSAttributedString(string: (gap ? "..." : PageFmt.text(l["text"])) + "\n", attributes: at))
        }
        let pre = NSTextField(labelWithAttributedString: code)
        pre.lineBreakMode = .byClipping
        pre.isSelectable = true
        // .code-h: the terminal's colours in both appearances.
        let hl = label(t("pg.changedHead", ["id": v["id"] as? String ?? "", "from": from, "to": to]), Fonts.mono(12))
        hl.textColor = Design.termFg
        let hi = Icon("doc", "tx3", size: 13)
        hi.image = SharedIcons.image("doc", color: "tx2", size: 13, dark: true)
        let headRow = prow([hi, hl, spring()], spacing: 8, insets: NSEdgeInsets(top: 9, left: 14, bottom: 9, right: 14))
        let codeBox = card(vstack([headRow, hline(), pad(soft(pre), NSEdgeInsets(top: 10, left: 14, bottom: 12, right: 14))]), fill: "term-bg", radius: 8)
        let ask = { [weak self] in
            guard let self else { return }
            let text = t("pg.mergeText", ["name": name, "from": from, "to": to, "file": v["file"] as? String ?? "", "path": v["defaultPath"] as? String ?? ""])
            guard let session = self.host?.lastProject() else { Outside.copy(text); self.toast?(t("page.noSessionToAsk")); return }
            self.send("/api/pages/ask", ["key": v["key"] as? String ?? "", "kind": "merge", "text": text, "session": session], fail: t("page.nothingTyped"), reload: false) { code, j in
                guard code == 200 else { return }
                self.closeSheet()
                if let p = j["projectId"] as? String, let s = j["surfaceId"] as? String { self.host?.pickSession("\(p)/\(s)") }
            }
        }
        return vstack([h3(t("pg.changedTitle", ["name": name])), wrap(t("pg.changedNote", ["from": from, "to": to]), Fonts.pt(13), "tx2"), codeBox,
                       sheetButtons([btn("sheet:openBoth", t("pg.openBoth"), .link) { Outside.openFile(v["file"] as? String ?? ""); if let d = v["defaultPath"] as? String { Outside.openFile(d) } }, spring(),
                                     btn("sheet:cancel", t("pg.notNow"), small: false) { [weak self] in self?.closeSheet() }, btn("sheet:ok", t("pg.bringIn"), .primary, small: false, run: ask)])], spacing: 12)
    }

    private func itemSheet(_ v: [String: Any], _ it: Item, _ sec: [Int]) -> NSView {
        let s = section(v, sec) ?? [:]
        let sp = s["kind"] as? String == "core" ? spec(s) : nil
        let src = s["source"] as? [String: Any]
        let fs = src?["kind"] as? String != "provider" ? (src?["fields"] as? [String: Any] ?? [:]) : [:]
        let fields = orderedKeys(fs).compactMap { fs[$0] as? [String: Any] }.filter { $0["builtin"] as? Bool != true && $0["type"] as? String != "image" }
        let title = PageFmt.text(it["title"]).isEmpty ? PageFmt.text(sp.flatMap { PageFmt.field(it, $0["title"] as? String ?? "") }) : PageFmt.text(it["title"])
        var rows: [NSView?] = [h3(title)]
        if !fields.isEmpty {
            rows.append(vstack(fields.map { f in
                let val = PageFmt.text(it[f["name"] as? String ?? ""])
                return hstack([fix(label(f["label"] as? String ?? "", Fonts.pt(12), "tx3"), w: 110), soft(wrap(val.isEmpty ? "-" : val, Fonts.pt(12.5)))], spacing: 8)
            }, spacing: 5))
        }
        if let sp { rows.append(picture(image(v, it, sp["image"] as? String), cap: 260, radius: 8)) }
        if !PageFmt.text(it["body"]).isEmpty { rows.append(markdown(PageFmt.text(it["body"]), key: "sheet:doc", dir: (itemPath(v, it, sec) as NSString).deletingLastPathComponent, can: false, skipTitle: title) { _, _ in }) }
        let open: NSView? = it["$hash"] != nil ? btn("sheet:openFile", t("pg.openFile"), .link) { [weak self] in guard let self else { return }; Outside.openFile(self.itemPath(v, it, sec)) } : nil
        var bb: [NSView?] = [open, spring()]
        bb += (sp.map { itemButtons(v, $0, it, sec) } ?? []).map { Optional($0) }
        bb.append(btn("sheet:close", t("page.close"), small: false) { [weak self] in self?.closeSheet() })
        rows.append(sheetButtons(bb))
        return vstack(rows, spacing: 12)
    }

    private func formSheet(_ v: [String: Any]) -> NSView {
        guard let fm = form else { return NSView() }
        let fs = formFields(v, fm.sec)
        var rows: [NSView?] = [h3(fm.action["label"] as? String ?? "")]
        popups = [:]
        for (k, f) in fs {
            let type = f["type"] as? String ?? "string"
            let need = f["required"] as? Bool == true || k == "title"
            let lbl = NSMutableAttributedString(string: f["label"] as? String ?? k, attributes: [.font: Fonts.pt(12), .foregroundColor: Design.color("tx2")])
            if need { lbl.append(NSAttributedString(string: t("pg.needed"), attributes: [.font: Fonts.pt(12), .foregroundColor: Design.color("tx3")])) }
            let input: NSView
            if type == "enum" || type == "bool" {
                let p = NSPopUpButton(frame: .zero, pullsDown: false)
                p.translatesAutoresizingMaskIntoConstraints = false
                let vals: [(String, String)] = type == "bool" ? [("true", t("pg.yes")), ("false", t("pg.no"))] : (f["values"] as? [String] ?? []).map { ($0, PageFmt.capitalise($0)) }
                p.addItem(withTitle: "")
                p.lastItem?.representedObject = ""
                for (val, title) in vals { p.addItem(withTitle: title); p.lastItem?.representedObject = val }
                let cur = fields["form:\(k)"]?.text ?? ""
                if let i = p.itemArray.firstIndex(where: { $0.representedObject as? String == cur }) { p.selectItem(at: i) }
                popups[k] = p
                input = p
            } else if type == "date" {
                // A day typed as YYYY-MM-DD, or picked on a calendar.
                let fb = field("form:\(k)", "YYYY-MM-DD")
                let cal = btn("sheet:cal:\(k)", t("pg.pickDay"), small: false, lead: "clock") {}
                cal.run = { [weak self, weak cal, weak fb] in
                    guard let self, let cal, let fb else { return }
                    self.pickDay(fb, from: cal)
                }
                input = hstack([fix(fb, w: 160), cal, spring()], spacing: 6)
            } else {
                let fb = field("form:\(k)", type == "list" ? t("pg.commaSep") : "")
                if type == "number" {
                    // Only a number goes in (the field keeps what parses).
                    let nf = NumberFormatter(); nf.numberStyle = .decimal; nf.usesGroupingSeparator = false; nf.locale = Locale(identifier: "en_US_POSIX")
                    fb.field.formatter = nf
                    fb.field.alignment = .right
                }
                input = type == "number" ? hstack([fix(fb, w: 140), spring()], spacing: 0) : fb
            }
            rows.append(vstack([NSTextField(labelWithAttributedString: lbl), input], spacing: 5))
        }
        rows.append(vstack([label(t("pg.text"), Fonts.pt(12), "tx2"), field("form:$body", "", area: true)], spacing: 5))
        if let e = fm.error { rows.append(wrap(e, Fonts.pt(12.5), "bad")) }
        let save = btn("sheet:ok", fm.action["label"] as? String ?? "", .primary, small: false) { [weak self] in self?.saveForm(v) }
        save.isEnabled = !fm.busy
        rows.append(sheetButtons([spring(), btn("sheet:cancel", t("pg.cancel"), small: false) { [weak self] in self?.closeSheet() }, save]))
        return vstack(rows, spacing: 12)
    }

    /// A calendar under the button: the day picked fills the field as YYYY-MM-DD.
    private func pickDay(_ fb: FieldBox, from anchor: NSView) {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd"
        let dp = NSDatePicker()
        dp.datePickerStyle = .clockAndCalendar
        dp.datePickerElements = .yearMonthDay
        dp.dateValue = f.date(from: fb.text) ?? Date()
        dp.sizeToFit()
        let vc = NSViewController()
        let host = NSView(frame: NSRect(x: 0, y: 0, width: dp.frame.width + 16, height: dp.frame.height + 16))
        dp.frame.origin = NSPoint(x: 8, y: 8)
        host.addSubview(dp)
        vc.view = host
        let pop = NSPopover()
        pop.contentViewController = vc
        pop.behavior = .transient
        dayPicker = (dp, fb, f)
        dp.target = self
        dp.action = #selector(dayPicked(_:))
        pop.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .maxY)
    }
    private var dayPicker: (NSDatePicker, FieldBox, DateFormatter)?
    @objc private func dayPicked(_ dp: NSDatePicker) {
        guard let (p, fb, f) = dayPicker, p === dp else { return }
        fb.text = f.string(from: dp.dateValue)
    }

    private func saveForm(_ v: [String: Any]) {
        guard let fm = form else { return }
        var out: [String: Any] = [:]
        for (k, f) in formFields(v, fm.sec) {
            let raw = popups[k].map { ($0.selectedItem?.representedObject as? String) ?? "" } ?? (fields["form:\(k)"]?.text ?? "")
            if popups[k] != nil { field("form:\(k)", "").text = raw }
            if raw.isEmpty { continue }
            switch f["type"] as? String ?? "" {
            case "number": out[k] = Double(raw) ?? raw
            case "bool": out[k] = raw == "true"
            case "list": out[k] = raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            default: out[k] = raw
            }
        }
        fm.busy = true; fm.error = nil
        openSheet("form", formSheet(v))
        let body: [String: Any] = ["key": v["key"] as? String ?? key, "at": secJSON(fm.sec), "action": fm.at.json, "fields": out, "body": fields["form:$body"]?.text ?? ""]
        send("/api/pages/item/create", body, fail: nil) { [weak self] code, j in
            guard let self, let f = self.form, f === fm else { return }
            f.busy = false
            if code != 200 { f.error = j["error"] as? String ?? t("pg.notMade"); self.openSheet("form", self.formSheet(v)); return }
            self.closeSheet()
        }
    }
}

/// A bar's box whose ring is its tone at a given strength (.nb.bad, .nb.you: 35%).
final class ToneBox: Box {
    var ringTone = "sep"
    var ringAlpha: CGFloat = 1
    override func updateLayer() {
        super.updateLayer()
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.borderWidth = 1
            layer?.borderColor = Design.color(ringTone).withAlphaComponent(ringAlpha).cgColor
        }
    }
}

/// A bar of a progress (.bar, .pbar): its share filled.
final class Meter: NSView {
    let frac: CGFloat
    init(_ f: Double) { frac = CGFloat(max(0, min(1, f.isFinite ? f : 0))); super.init(frame: .zero); translatesAutoresizingMaskIntoConstraints = false }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ r: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            Design.color("card2").setFill(); NSBezierPath(roundedRect: bounds, xRadius: 3, yRadius: 3).fill()
            Design.color("tx").setFill(); NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: bounds.width * frac, height: bounds.height), xRadius: 3, yRadius: 3).fill()
        }
    }
    override func viewDidChangeEffectiveAppearance() { needsDisplay = true }
}

/// .pmodal and .msheet: the page dimmed, a sheet in the middle; a press outside it closes it.
final class SheetLayer: Flipped {
    let sheet: Box
    let onClose: () -> Void
    init(_ content: NSView, onClose: @escaping () -> Void) {
        self.onClose = onClose
        sheet = Box(fill: "sheet", ring: "sheet-ring", radius: 12)
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.withAlphaComponent(0.32).cgColor
        sheet.translatesAutoresizingMaskIntoConstraints = false
        content.translatesAutoresizingMaskIntoConstraints = false
        sheet.addSubview(content)
        addSubview(sheet)
        let w = sheet.widthAnchor.constraint(equalToConstant: 520); w.priority = .init(700)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: sheet.leadingAnchor, constant: 20), content.trailingAnchor.constraint(equalTo: sheet.trailingAnchor, constant: -20),
            content.topAnchor.constraint(equalTo: sheet.topAnchor, constant: 18), content.bottomAnchor.constraint(equalTo: sheet.bottomAnchor, constant: -18),
            sheet.centerXAnchor.constraint(equalTo: centerXAnchor), sheet.centerYAnchor.constraint(equalTo: centerYAnchor),
            w, sheet.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -48),
            sheet.heightAnchor.constraint(lessThanOrEqualTo: heightAnchor, constant: -48),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    override func mouseDown(with e: NSEvent) { if !sheet.frame.contains(convert(e.locationInWindow, from: nil)) { onClose() } }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func keyDown(with e: NSEvent) { if e.keyCode == 53 { onClose() } else { super.keyDown(with: e) } }
    override func cancelOperation(_ sender: Any?) { onClose() }
}
