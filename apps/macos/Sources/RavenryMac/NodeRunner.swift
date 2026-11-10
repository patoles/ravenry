// This executable run as Node, as the Electron app's executable ran with
// ELECTRON_RUN_AS_NODE=1: the hub service (its launchd job names
// Contents/MacOS/Ravenry, install.ts plistText) and the assistants' hooks
// written by the Electron app (`ELECTRON_RUN_AS_NODE=1
// /Applications/Ravenry.app/Contents/MacOS/Ravenry <data>/current/hub/hooks/
// events.mjs`, read once by each session when it starts) keep working once
// this app has replaced it.
//
// It starts the Node the app carries (Contents/MacOS/node) with the same
// arguments, stays its parent, passes the signals on, and exits as it
// exits. Staying the parent is what keeps macOS's privacy answers: the
// hub's reads of ~/Documents are asked for the process responsible for
// it, which is this one, the app's own executable (bundle id
// dev.ravenry.app, signed by the same team), as the Electron hub was, so a
// grant the person gave Ravenry still holds and a new prompt names
// Ravenry. Node started on its own would be a new program to macOS.

import Foundation

enum NodeRunner {
    /// The child, for the signal handlers (they capture nothing).
    static var child: pid_t = 0

    static func run() -> Never {
        let exe = Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])
        let node = exe.deletingLastPathComponent().appendingPathComponent("node").path
        guard FileManager.default.isExecutableFile(atPath: node) else {
            FileHandle.standardError.write("Ravenry: no Node in this copy of the app (\(node))\n".data(using: .utf8)!)
            exit(127)
        }
        // Its environment without ELECTRON_RUN_AS_NODE, so nothing the hub
        // starts (a daemon, a pane's program) inherits it.
        var env: [String] = []
        for (k, v) in ProcessInfo.processInfo.environment where k != "ELECTRON_RUN_AS_NODE" { env.append("\(k)=\(v)") }
        let args = [node] + CommandLine.arguments.dropFirst()
        var cargs: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) } + [nil]
        var cenv: [UnsafeMutablePointer<CChar>?] = env.map { strdup($0) } + [nil]
        // Signals are passed on, set before the spawn so none is lost.
        // SIGUSR1 is not: it would open Node's inspector in the hub.
        for s in [SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR2, SIGWINCH] {
            signal(s) { sig in if NodeRunner.child > 0 { kill(NodeRunner.child, sig) } }
        }
        var pid: pid_t = 0
        let rc = posix_spawn(&pid, node, nil, nil, &cargs, &cenv)
        if rc != 0 {
            FileHandle.standardError.write("Ravenry: could not start \(node): \(String(cString: strerror(rc)))\n".data(using: .utf8)!)
            exit(127)
        }
        child = pid
        var status: Int32 = 0
        while waitpid(pid, &status, 0) < 0 {
            if errno != EINTR { exit(1) }
        }
        // Exited: its code. Ended by a signal: the same signal, so whoever
        // waits on this process sees what Node saw.
        let low = status & 0x7f
        if low == 0 { exit((status >> 8) & 0xff) }
        signal(low, SIG_DFL)
        kill(getpid(), low)
        exit(128 + low)
    }
}
