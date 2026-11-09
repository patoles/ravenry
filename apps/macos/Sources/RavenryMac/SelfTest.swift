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

    let drag: Bool

    init(view: TerminalView, window: NSWindow, out: String, drag: Bool) {
        self.drag = drag
        self.view = view
        self.window = window
        self.out = out
    }

    func start() {
        Task { @MainActor in
            if self.drag { await self.runDrag() } else { await self.run() }
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

    /// The resize drag (--drag): a long multi-line command line pasted at
    /// the shell's prompt, then the window's width dragged down and back
    /// at about 120 steps a second, as a person drags its edge. After each
    /// step it measures how much text Ghostty's last drawn frame shows, so
    /// a frame that went blank is counted.
    @MainActor
    private func runDrag() async {
        let prompted = await waitFor({ $0.contains("> ") }, timeout: 15)
        result["prompt"] = prompted
        guard prompted, let surface = view.surface else { return }
        let words = "the quick brown fox jumps over the lazy dog and keeps running past the river while the wind blows"
        var lines: [String] = []
        for i in 0..<10 {
            lines.append("line \(i): " + String(repeating: words + " ", count: i % 3 + 1))
        }
        let text = lines.joined(separator: "\n")
        text.withCString { p in ghostty_surface_text(surface, p, UInt(text.utf8.count)) }
        try? await Task.sleep(nanoseconds: 800_000_000)
        let base = inkRatio()
        result["ink_before"] = base
        var steps: [[String: Any]] = []
        var widths: [CGFloat] = []
        var w: CGFloat = 1200
        while w > 620 { widths.append(w); w -= 7 }
        while w < 1200 { widths.append(w); w += 7 }
        let t0 = Date()
        var blankShots = 0
        for w in widths {
            window.setContentSize(NSSize(width: w, height: 760))
            try? await Task.sleep(nanoseconds: 8_000_000)
            let ink = inkRatio()
            var step: [String: Any] = ["ms": ms(since: t0), "width": Int(w), "cols": view.gridSize().cols, "ink": ink]
            if ink < base * 0.3 && blankShots < 3 {
                // What the terminal holds when the frame looks blank.
                step["screen"] = view.screenText()
                step["picture"] = savePicture(suffix: "-blank\(blankShots)")
                blankShots += 1
            }
            steps.append(step)
        }
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        let after = inkRatio()
        result["ink_after"] = after
        result["steps"] = steps
        let blank = steps.filter { ($0["ink"] as? Double ?? 0) < base * 0.3 }.count
        result["blank_steps"] = blank
        result["step_count"] = steps.count
        result["screen"] = view.screenText()
        result["picture"] = savePicture()
    }

    /// The share of Ghostty's last drawn frame covered by text: pixels
    /// clearly brighter than the background, on a frame scaled down 8 times.
    @MainActor
    private func inkRatio() -> Double {
        var layer = view.layer
        if let l = layer, l.contents == nil, let sub = l.sublayers?.first(where: { $0.contents != nil }) { layer = sub }
        guard let contents = layer?.contents else { return -1 }
        let obj = contents as AnyObject
        guard CFGetTypeID(obj) == IOSurfaceGetTypeID() else { return -1 }
        let image = CIImage(ioSurface: unsafeBitCast(obj, to: IOSurfaceRef.self))
            .transformed(by: CGAffineTransform(scaleX: 0.125, y: 0.125))
        let ext = image.extent.integral
        let w = Int(ext.width), h = Int(ext.height)
        guard w > 0, h > 0 else { return -1 }
        var px = [UInt8](repeating: 0, count: w * h * 4)
        Self.ciContext.render(image, toBitmap: &px, rowBytes: w * 4, bounds: ext,
                              format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        var ink = 0
        for i in stride(from: 0, to: px.count, by: 4) where Int(px[i]) + Int(px[i + 1]) + Int(px[i + 2]) > 240 { ink += 1 }
        return Double(ink) / Double(w * h)
    }

    static let ciContext = CIContext()

    /// Saves the IOSurface Ghostty renders into, as a PNG beside OUT.json.
    @MainActor
    private func savePicture(suffix: String = "") -> String? {
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
        let path = (out as NSString).deletingPathExtension + suffix + ".png"
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
