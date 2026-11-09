// The headless self-test (--offscreen --selftest OUT.json): types into the
// terminal through the same key path a person's keys take, reads what the
// surface shows, resizes the window, times a large output, saves a picture
// of what Ghostty drew, and writes the results for scripts/selftest.sh,
// which checks the daemon's side.

import AppKit
import CoreImage
import GhosttyKit
import IOSurface

final class SelfTest {
    let view: TerminalView
    let window: NSWindow
    let out: String
    var result: [String: Any] = [:]
    let started = Date()

    init(view: TerminalView, window: NSWindow, out: String) {
        self.view = view
        self.window = window
        self.out = out
    }

    func start() {
        Task { @MainActor in
            await self.run()
            self.finish()
        }
    }

    private func ms(since t: Date) -> Int { Int(Date().timeIntervalSince(t) * 1000) }

    /// Waits until the visible screen holds `text`, polling every 10 ms.
    @MainActor
    private func waitFor(_ match: (String) -> Bool, timeout: TimeInterval) async -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if match(view.screenText()) { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return false
    }

    /// Types a line through keyDown, as AppKit delivers a person's keys.
    @MainActor
    private func type(_ line: String) {
        for ch in line {
            let s = String(ch)
            let code = Self.keyCodes[ch] ?? 0
            press(s, code)
        }
        press("\r", 36)
    }

    @MainActor
    private func press(_ s: String, _ code: UInt16) {
        for kind in [NSEvent.EventType.keyDown, .keyUp] {
            guard let e = NSEvent.keyEvent(with: kind, location: .zero, modifierFlags: [],
                                           timestamp: ProcessInfo.processInfo.systemUptime,
                                           windowNumber: window.windowNumber, context: nil,
                                           characters: s, charactersIgnoringModifiers: s,
                                           isARepeat: false, keyCode: code) else { continue }
            if kind == .keyDown { view.keyDown(with: e) } else { view.keyUp(with: e) }
        }
    }

    // ANSI key codes for what the test types (no shifted characters, so the
    // keyboard layout does not matter).
    static let keyCodes: [Character: UInt16] = {
        var m: [Character: UInt16] = [" ": 49, "-": 27]
        let letters: [(Character, UInt16)] = [
            ("a", 0), ("s", 1), ("d", 2), ("f", 3), ("h", 4), ("g", 5), ("z", 6), ("x", 7), ("c", 8), ("v", 9),
            ("b", 11), ("q", 12), ("w", 13), ("e", 14), ("r", 15), ("y", 16), ("t", 17), ("o", 31), ("u", 32),
            ("i", 34), ("p", 35), ("l", 37), ("j", 38), ("k", 40), ("n", 45), ("m", 46),
            ("1", 18), ("2", 19), ("3", 20), ("4", 21), ("6", 22), ("5", 23), ("9", 25), ("7", 26), ("8", 28), ("0", 29),
        ]
        for (c, k) in letters { m[c] = k }
        return m
    }()

    @MainActor
    private func run() async {
        // 1. The pane's prompt reaches the surface.
        let prompted = await waitFor({ $0.contains("$ ") }, timeout: 15)
        result["prompt"] = prompted
        result["prompt_ms"] = ms(since: started)
        guard prompted else { return }

        // 2. Typed keys reach the pane, its answer reaches the surface.
        var t = Date()
        type("expr 50 - 8")
        result["typed_answer"] = await waitFor({ $0.split(separator: "\n").contains { $0.trimmingCharacters(in: .whitespaces) == "42" } }, timeout: 10)
        result["typed_answer_ms"] = ms(since: t)

        // 3. Resize: the window grows, Ghostty's grid follows, and (checked
        // by the script) the pane takes the same size.
        let before = view.gridSize()
        result["grid_before"] = [before.cols, before.rows]
        window.setContentSize(NSSize(width: 1200, height: 760))
        try? await Task.sleep(nanoseconds: 800_000_000)
        let after = view.gridSize()
        result["grid_after"] = [after.cols, after.rows]
        type("stty size")
        result["stty_after"] = await waitFor({ $0.contains("\(after.rows) \(after.cols)") }, timeout: 10)

        // 4. Big output: 200000 lines through the daemon into the surface.
        t = Date()
        type("seq 1 200000 && echo seq-done")
        result["seq_done"] = await waitFor({ $0.contains("\nseq-done") }, timeout: 60)
        result["seq_ms"] = ms(since: t)

        // 5. Queries: the script left `q` in the pane's folder, a program
        // that asks the terminal things and records the answers it reads.
        type("sh q")
        result["probe_done"] = await waitFor({ $0.contains("probe-done") }, timeout: 10)

        try? await Task.sleep(nanoseconds: 300_000_000)
        result["screen"] = view.screenText()
        result["picture"] = savePicture()
    }

    /// Saves the IOSurface Ghostty renders into, as a PNG beside OUT.json.
    @MainActor
    private func savePicture() -> String? {
        var layer = view.layer
        if let l = layer, l.contents == nil, let sub = l.sublayers?.first(where: { $0.contents != nil }) { layer = sub }
        guard let contents = layer?.contents else { return nil }
        let obj = contents as AnyObject
        guard CFGetTypeID(obj) == IOSurfaceGetTypeID() else { return nil }
        let surface = unsafeBitCast(obj, to: IOSurfaceRef.self)
        let image = CIImage(ioSurface: surface)
        let ctx = CIContext()
        guard let cg = ctx.createCGImage(image, from: image.extent) else { return nil }
        let rep = NSBitmapImageRep(cgImage: cg)
        guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
        let path = (out as NSString).deletingPathExtension + ".png"
        try? png.write(to: URL(fileURLWithPath: path))
        return path
    }

    private func finish() {
        result["total_ms"] = ms(since: started)
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: out))
        }
        // The way a person ends it: closing the window frees the surface,
        // which hangs up the attach command, and the app quits.
        window.close()
    }
}
