// The assistants, as the hub lists them (hub/server/assistants.mjs, the
// assistant registry): the state's `assistants.list`, in order, each with
// its name ("Claude Code"), its short word for a switch ("Claude") and its
// tag ("Claude"). The window draws this list (New session's cards, New
// project's and a project's switches, Settings, the tags and the words
// that name an assistant) and never a second one of its own. Before the
// first state, and from a hub older than the registry, Claude Code and
// Codex, as they were.

import Foundation

struct Assistant: Equatable {
    let id: String
    let name: String
    let short: String
    let chip: String
    let caps: [String: Bool]

    init(id: String, name: String, short: String, chip: String, caps: [String: Bool] = [:]) {
        self.id = id; self.name = name; self.short = short; self.chip = chip; self.caps = caps
    }

    init?(_ d: [String: Any]) {
        guard let id = (d["id"] as? String) ?? (d["kind"] as? String), !id.isEmpty else { return nil }
        let name = d["name"] as? String ?? id
        self.init(id: id, name: name, short: d["short"] as? String ?? name, chip: d["chip"] as? String ?? (d["short"] as? String ?? name),
                  caps: (d["caps"] as? [String: Any] ?? [:]).compactMapValues { $0 as? Bool })
    }
}

enum Assistants {
    /// Claude Code and Codex: what a hub older than the registry starts.
    static let builtIn = [Assistant(id: "claude", name: "Claude Code", short: "Claude", chip: "Claude"),
                          Assistant(id: "codex", name: "Codex", short: "Codex", chip: "Codex")]
    /// The hub's list, from the last state that had one (HubState.init).
    private(set) static var hubList: [Assistant] = []

    /// Every assistant the hub lists, in its order.
    static var list: [Assistant] { hubList.isEmpty ? builtIn : hubList }

    /// Takes the hub's list from a state (or GET /api/settings/assistant): `assistants.list`.
    static func take(_ state: [String: Any]) {
        guard let l = (state["assistants"] as? [String: Any])?["list"] as? [[String: Any]] else { return }
        let a = l.compactMap(Assistant.init)
        if !a.isEmpty { hubList = a }
    }

    /// The assistant of a kind, or nil when the hub lists none of that kind.
    static func of(_ kind: String?) -> Assistant? { kind.flatMap { k in list.first { $0.id == k } } }
    static func isKnown(_ kind: String?) -> Bool { of(kind) != nil }
    /// A kind the hub does not list (none, an older record) is Claude Code.
    static func kind(_ kind: String?) -> String { isKnown(kind) ? kind! : "claude" }
    private static func entry(_ kind: String?) -> Assistant { of(Assistants.kind(kind)) ?? builtIn[0] }
    /// "Claude Code", "Codex".
    static func name(_ kind: String?) -> String { entry(kind).name }
    /// "Claude", "Codex": a switch's label, and the words that name the assistant in a line.
    static func short(_ kind: String?) -> String { entry(kind).short }
    /// "Claude", "Codex": the session's tag.
    static func chip(_ kind: String?) -> String { entry(kind).chip }
    /// The word for a kind the hub may not list: its tag, else the kind with a capital, else nil.
    static func word(_ kind: String?) -> String? {
        guard let k = kind, !k.isEmpty else { return nil }
        return of(k)?.chip ?? k.prefix(1).uppercased() + k.dropFirst()
    }
    /// The assistant whose kind a longer kind starts with ("claude", "codex-..."), or nil.
    static func prefixed(_ kind: String?) -> String? {
        guard let k = kind else { return nil }
        return list.first { k.hasPrefix($0.id) }?.id
    }
    /// Can the board do this with its sessions (the registry's caps: resume, model, ...)? Claude Code and Codex can all.
    static func can(_ kind: String?, _ cap: String) -> Bool {
        guard let a = of(kind) else { return false }
        return a.caps[cap] ?? true
    }
}
