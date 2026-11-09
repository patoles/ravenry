// A board older than the sidebar's (a hub from before 2026-11-09, such as
// one still running from an earlier install): its state has no `sidebar`,
// its checkpoints no `words`, its briefs no `nextParts`. The window then
// runs the hub's own code for them, the same files the hub runs
// (hub/server/sidebar.mjs, cpwords.mjs, briefnext.mjs, bundled with the
// app), in JavaScriptCore (no web view): withGroups, marksOf and build for
// the sidebar, wordsOf for each checkpoint, nextParts for each brief. So
// the window still decides nothing of its own; with a current hub this
// file does nothing.

import Foundation
import JavaScriptCore

final class OlderHub {
    private let ctx: JSContext?

    init() {
        let names = ["cpwords", "sidebar", "briefnext"]
        var src = "var process = { platform: 'darwin', env: {} };\n"
        // shared/strings/en.json, for sidebar.mjs's section titles (hub/server/strings.mjs t()).
        let en = Bundle.main.url(forResource: "en", withExtension: "json").flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? "{}"
        src += "var EN = \(en);\nfunction t(key, vars) { var s = EN[key]; if (typeof s !== 'string') return key; for (var k in (vars || {})) s = s.split('{' + k + '}').join(String(vars[k])); return s; }\n"
        for n in names {
            guard let u = Bundle.main.url(forResource: n, withExtension: "mjs"), let s = try? String(contentsOf: u, encoding: .utf8) else { ctx = nil; return }
            // As a plain script: no imports (all three are here), no exports.
            let body = s.split(separator: "\n", omittingEmptySubsequences: false)
                .filter { !$0.hasPrefix("import ") }
                .map { $0.hasPrefix("export ") ? String($0.dropFirst(7)) : String($0) }
                .joined(separator: "\n")
            src += "(function(){\n\(body)\n" + OlderHub.exports(of: body) + "\n})();\n"
        }
        let c = JSContext()
        c?.exceptionHandler = { _, e in NSLog("RavenryMac: older hub: \(e?.toString() ?? "")") }
        c?.evaluateScript(src)
        c?.evaluateScript("""
        function ravenryFill(state) {
          var projects = state.projects || [];
          withGroups(projects);
          var cps = state.checkpoints || [];
          for (var i = 0; i < cps.length; i++) if (!cps[i].words) cps[i].words = wordsOf(cps[i], { platform: 'darwin' });
          for (var j = 0; j < projects.length; j++) { var b = projects[j].brief; if (b && !b.nextParts) b.nextParts = nextParts(b.next || ''); }
          var th = (state.settings && state.settings.handoffThreshold) || 50;
          if (!state.sidebar) state.sidebar = build(projects, { threshold: th, marks: marksOf(projects, cps) });
          return JSON.stringify(state);
        }
        """)
        ctx = c
    }

    /// Each file's top-level names, made global for the next file.
    private static func exports(of body: String) -> String {
        var out = ""
        for l in body.split(separator: "\n") {
            for kw in ["function ", "const ", "let "] where l.hasPrefix(kw) {
                let rest = l.dropFirst(kw.count)
                let name = rest.prefix { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "$" }
                if !name.isEmpty { out += "globalThis.\(name) = \(name);\n" }
            }
        }
        return out
    }

    /// The state with what an older hub did not send filled by the hub's own code.
    func fill(_ state: [String: Any]) -> [String: Any] {
        let cps = state["checkpoints"] as? [[String: Any]] ?? []
        let briefs = (state["projects"] as? [[String: Any]] ?? []).compactMap { $0["brief"] as? [String: Any] }
        let needs = state["sidebar"] == nil || cps.contains { $0["words"] == nil } || briefs.contains { $0["nextParts"] == nil }
        guard needs, let c = ctx, let f = c.objectForKeyedSubscript("ravenryFill"),
              let d = try? JSONSerialization.data(withJSONObject: state), let js = String(data: d, encoding: .utf8),
              let arg = c.evaluateScript("(\(js))"),
              let out = f.call(withArguments: [arg])?.toString(),
              let j = (try? JSONSerialization.jsonObject(with: Data(out.utf8))) as? [String: Any] else { return state }
        return j
    }
}
