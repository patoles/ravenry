// What the app takes from whoever launches it (SIGN-001), as the Electron
// release's gate (apps/desktop/src/main/gate.ts). Any program of the
// person's can start the app with arguments and an environment of its
// choosing, and the app outside every pane acts as the person (the daemon
// takes it for them). So a release, the build people install, takes no
// test hook from its launch:
//
// - a test switch (--offscreen, --bench..., --selftest, --sidetest,
//   --screen, --restore-check, --older-hub-check, --socket, `-- COMMAND`)
//   or a debugging switch (--inspect..., --remote-debugging-...) makes it
//   quit before any window, daemon or hub, with a line in app.log: no
//   window opens off every screen to be driven, and none opens on the
//   screen of a harness that started a release by mistake;
// - every test variable is removed from its environment before anything
//   reads it, so neither the app nor what it starts sees it: the hub's
//   address (RAVENRY_HUB_URL), the reports and fixtures (RAVENRY_MAC_*),
//   the update feed and its test (RAVENRY_UPDATE_FEED, _TEST), the
//   relaunch test, the self-tests' stand-ins (RAVENRY_TEST_*, _NOTIFY_*,
//   _SETTINGS_*, _BENCH_*), and the programs run in place of the app's own
//   (gate.ts's CONTROL_VARS, MC_*, FAKE_*, STUB_*);
// - run as Node (ELECTRON_RUN_AS_NODE=1, NodeRunner.swift), Node's
//   inspector is refused and NODE_OPTIONS and NODE_PATH are dropped, as the
//   Electron app's fuses do; and the hub's test switches (hubTestVars) make
//   it quit before the hub starts, as a test switch does the app: the hub
//   service is the person's board, where a caller on this Mac must never
//   pass as a phone (MC_TEST_PHONE_PORT, hub/server/testphone.mjs).
//
// What only says where things are (RAVENRY_HOME, RAVENRY_DESKTOP_DATA, the
// runtime and state folders, a test's launchd label) or how the window looks
// (--attach, --font, --font-size, --option-as-alt) stays. DYLD_* is the
// hardened runtime's: dropped by macOS for a signed release, and library
// validation keeps out a library not signed by the same team.
//
// The hooks are on in a development build (scripts/build.sh: no build.json)
// and in the test twin scripts/package.mjs makes beside the release
// (build/package/release-test/Ravenry.app: the same bundle, RavenryTestHooks
// in its Info.plist, which the signature seals).

import Foundation

enum Gate {
    /// True in a development build or the test twin; false in a release.
    static let hooks: Bool = {
        let b = Bundle.main
        let packaged = FileManager.default.fileExists(atPath: (b.resourceURL ?? URL(fileURLWithPath: "/")).appendingPathComponent("build.json").path)
        if !packaged { return true }
        return (b.object(forInfoDictionaryKey: "RavenryTestHooks") as? Bool) == true
    }()

    /// The test switches (the self-tests', the bench's, the harness's).
    static let testSwitches: Set<String> = ["offscreen", "bench", "bench-layer", "bench-resize", "bench-onscreen", "drag-min", "selftest",
                                            "restore-check", "sidetest", "screen", "older-hub-check", "socket"]
    /// Debugging switches (gate.ts CONTROL_SWITCHES, and Node's inspector).
    static let debugSwitches: Set<String> = ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address", "remote-debugging-io-pipes",
                                             "inspect", "inspect-brk", "inspect-port", "inspect-wait", "inspect-brk-node", "inspect-publish-uid",
                                             "debug", "debug-brk", "debug-port", "js-flags", "renderer-cmd-prefix", "utility-cmd-prefix",
                                             "gpu-launcher", "browser-subprocess-path"]
    static let controlVars: Set<String> = AppInstall.controlVars.union(["RAVENRY_OFFSCREEN", "RAVENRY_HUB_URL", "RAVENRY_UPDATE_FEED", "RAVENRY_UPDATE_TEST", "RAVENRY_UPDATE_EVERY",
                                                                        "RAVENRY_RELAUNCH_TEST", "RAVENRY_PRUNE_AFTER"])
    static let controlPrefixes = ["MC_", "FAKE_", "STUB_", "RAVENRY_MAC_", "RAVENRY_TEST_", "RAVENRY_NOTIFY_", "RAVENRY_SETTINGS_", "RAVENRY_BENCH_"]

    /// The hub's test switches, which a release run as Node quits on. The
    /// hub refuses them itself on a person's data (hub/server/testphone.mjs).
    static let hubTestVars: Set<String> = ["MC_TEST_PHONE_PORT"]

    static func isControlVar(_ k: String) -> Bool { controlVars.contains(k) || controlPrefixes.contains { k.hasPrefix($0) } }

    /// The switches in a command line that a release quits on (names, sorted).
    /// `--name`, `--name=value` and `-name` alike; `--` followed by a command is one too.
    static func switches(_ argv: [String], node: Bool = false) -> [String] {
        var found = Set<String>()
        for (i, a) in argv.enumerated().dropFirst() {
            if a == "--" {
                if !node && i + 1 < argv.count { found.insert("-- COMMAND") }
                break
            }
            // Node reads its own options up to the script; what follows is the script's.
            if node && !a.hasPrefix("-") { break }
            guard a.hasPrefix("-") else { continue }
            let body = a.drop { $0 == "-" }
            let name = String(body.split(separator: "=", maxSplits: 1).first ?? "").lowercased()
            if debugSwitches.contains(name) || (!node && testSwitches.contains(name)) { found.insert(name) }
        }
        return found.sorted()
    }

    /// Applies the gate to this process, first thing: in a release, the test
    /// variables leave the environment and a switch ends the launch. A
    /// development build or the twin changes nothing.
    static func apply(node: Bool) {
        if hooks { return }
        let env = ProcessInfo.processInfo.environment
        // As Node (the hub service, the hooks), what it runs is its own
        // script's business (a hook reads the hub's address): only Node's options go.
        let ignored = node ? env.keys.filter { $0 == "NODE_OPTIONS" || $0 == "NODE_PATH" }.sorted() : env.keys.filter(isControlVar).sorted()
        for k in ignored { unsetenv(k) }
        if !ignored.isEmpty && !node { AppInstall.shared.log("launch: a release build ignores \(ignored.joined(separator: ", "))") }
        // As Node, a hub test switch in the environment is refused like a switch.
        let sw = switches(CommandLine.arguments, node: node).map { $0 == "-- COMMAND" ? $0 : "--\($0)" }
            + (node ? env.keys.filter(hubTestVars.contains).sorted() : [])
        if !sw.isEmpty {
            let line = "launch: a release build does not take \(sw.joined(separator: ", ")): quitting"
            FileHandle.standardError.write("Ravenry: \(line)\n".data(using: .utf8)!)
            if !node { AppInstall.shared.log(line) }
            exit(2)
        }
    }
}
