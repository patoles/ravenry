// The headless bench (--offscreen --bench OUT.json): the window off every
// screen, drawn into an offscreen texture by the same renderer. It
// measures, through the app's own key, paste and resize paths:
//
// 1. typing: a key press to the drawn frame that shows its echo;
// 2. the drag: a long multi-line command line pasted at the shell's
//    prompt, the window's width dragged from 1200 pt to --drag-min and
//    back at 120 steps a second; at each step the screen the window
//    would show is checked for a blank (the command line gone) and for
//    debris (a piece of an old prompt), and at the end it must be the
//    daemon's screen;
// 3. `seq 1 2000000`: from Enter to the last number and the prompt drawn;
// 4. every draw's CPU time (building and encoding) and GPU time.
//
// scripts/bench.sh runs it on a throwaway daemon.

import AppKit

final class Bench {
    let view: TerminalView
    let window: NSWindow
    let out: String
    let dragMin: CGFloat
    private var result: [String: Any] = [:]
    private let lock = NSLock()
    private var draws: [(t: Double, seq: UInt32, cpu: Double)] = []
    private var gpu: [(cpu: Double, gpu: Double)] = []

    init(view: TerminalView, window: NSWindow, out: String, dragMin: CGFloat) {
        self.view = view
        self.window = window
        self.out = out
        self.dragMin = dragMin
    }

    func start() {
        view.onDraw = { [weak self] seq, cpu in
            guard let self else { return }
            self.lock.lock()
            self.draws.append((CACurrentMediaTime(), seq, cpu))
            self.lock.unlock()
        }
        view.renderer.onTiming = { [weak self] cpu, gpu in
            guard let self else { return }
            self.lock.lock()
            self.gpu.append((cpu, gpu))
            self.lock.unlock()
        }
        Thread { self.run() }.start()
    }

    private func main<T>(_ f: () -> T) -> T { DispatchQueue.main.sync(execute: f) }
    private func sleep(_ s: Double) { Thread.sleep(forTimeInterval: s) }
    private func text() -> String { view.screen.text() }

    private func waitFor(_ timeout: Double, _ cond: () -> Bool) -> Bool {
        let end = CACurrentMediaTime() + timeout
        while CACurrentMediaTime() < end {
            if cond() { return true }
            sleep(0.0005)
        }
        return cond()
    }

    private func key(_ chars: String, code: UInt16, flags: NSEvent.ModifierFlags = []) {
        main {
            guard let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                           windowNumber: window.windowNumber, context: nil, characters: chars,
                                           charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code) else { return }
            view.keyDown(with: e)
        }
    }

    private func savePNG(_ name: String) {
        let img: CGImage? = main { view.snapshotImage() }
        guard let img else { return }
        let url = URL(fileURLWithPath: out).deletingLastPathComponent().appendingPathComponent(name)
        let rep = NSBitmapImageRep(cgImage: img)
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
    }

    private static func stats(_ v: [Double]) -> [String: Double] {
        guard !v.isEmpty else { return [:] }
        let s = v.sorted()
        func q(_ f: Double) -> Double { s[min(s.count - 1, Int(f * Double(s.count - 1)))] }
        return ["n": Double(s.count), "median": q(0.5), "p95": q(0.95), "p99": q(0.99), "max": s.last!]
    }

    private func setWidth(_ w: CGFloat) {
        main {
            var f = window.frame
            f.size.width = w
            window.setFrame(f, display: false)
        }
    }

    private func run() {
        defer { finish() }
        guard waitFor(20, { self.text().contains("~ >") }) else {
            result["error"] = "no prompt: " + text()
            return
        }
        sleep(0.5)
        setWidth(1200)
        sleep(0.5)

        // 0. A picture of styles, colours and wide characters.
        let demo = #"printf '\e[1mbold\e[0m \e[3mitalic\e[0m \e[1;3mboth\e[0m \e[4munder\e[0m \e[4:3mcurly\e[0m \e[4:2mdouble\e[0m \e[9mstrike\e[0m \e[7minverse\e[0m \e[2mfaint\e[0m\n'; for i in 0 1 2 3 4 5 6 7; do printf '\e[4%sm  \e[0m\e[3%sm#\e[0m\e[9%sm#\e[0m ' $i $i $i; done; printf '\n\e[38;2;255;128;0mtruecolor\e[0m \e[48;5;24m 256 \e[0m 日本語 한국어 😀🎉 👩‍💻 café e\xcc\x81 → ✓ ─│┌┐\n'"#
        main { view.sendEvents([["text": demo]]) }
        key("\r", code: 0x24)
        _ = waitFor(3) { self.text().contains("truecolor") }
        sleep(0.4)
        savePNG("bench-styles.png")
        main { view.sendEvents([["text": "clear"]]) }
        key("\r", code: 0x24)
        _ = waitFor(3) { !self.text().contains("truecolor") }
        sleep(0.3)

        // 1. Typing.
        var lat: [Double] = []
        let letters = Array("abcdefghijklmnopqrstuvwxyz")
        let codes: [Character: UInt16] = ["a": 0x00, "b": 0x0B, "c": 0x08, "d": 0x02, "e": 0x0E, "f": 0x03, "g": 0x05, "h": 0x04,
                                          "i": 0x22, "j": 0x26, "k": 0x28, "l": 0x25, "m": 0x2E, "n": 0x2D, "o": 0x1F, "p": 0x23,
                                          "q": 0x0C, "r": 0x0F, "s": 0x01, "t": 0x11, "u": 0x20, "v": 0x09, "w": 0x0D, "x": 0x07,
                                          "y": 0x10, "z": 0x06]
        var typed = ""
        for i in 0..<40 {
            let ch = letters[i % 26]
            typed.append(ch)
            let want = typed
            lock.lock(); let n0 = draws.count; lock.unlock()
            let t0 = CACurrentMediaTime()
            key(String(ch), code: codes[ch]!)
            // The first draw after the key whose screen holds the echo.
            var tDraw = 0.0
            _ = waitFor(2) {
                self.lock.lock(); defer { self.lock.unlock() }
                guard self.draws.count > n0 else { return false }
                return self.lastLineHas(want) && { tDraw = self.draws.last!.t; return true }()
            }
            if tDraw > 0 { lat.append((tDraw - t0) * 1000) }
            sleep(0.03)
        }
        key("\u{15}", code: 0x20, flags: .control) // Ctrl+U: clear the line
        _ = waitFor(2) { !self.text().contains(typed) }
        result["typing_ms"] = Bench.stats(lat)

        // 2. The drag.
        sleep(0.3)
        let promptScreen = text()
        let words = "the quick brown fox jumps over the lazy dog and keeps running past the river while the wind blows"
        let pasted = (0..<10).map { "line \($0): " + String(repeating: words + " ", count: $0 % 3 + 1) }.joined(separator: "\n")
        main { view.pasteText(pasted) }
        _ = waitFor(5) { self.text().contains("line 9") }
        sleep(0.8)
        savePNG("bench-pasted.png")
        let flat = { (s: String) in s.filter { !$0.isWhitespace } }
        let whole = flat(promptScreen + pasted)
        let fp = flat(promptScreen)
        func debris(_ t: String) -> Bool {
            var f = flat(t)
            if f.hasPrefix(fp + ">....") { f = String(f.dropFirst(fp.count + 5)) } else if f.hasPrefix(">....") { f = String(f.dropFirst(5)) }
            return !whole.contains(f)
        }
        let inkBefore = flat(text()).count
        var widths: [CGFloat] = []
        var w: CGFloat = 1200
        while w > dragMin { widths.append(w); w -= 7 }
        while w <= 1200 { widths.append(w); w += 7 }
        lock.lock(); let d0 = draws.count; gpu.removeAll(); lock.unlock()
        var blank = 0, bad = 0, narrowShot = false
        var pause = (0.0, 0.0)
        var badShots: [String] = []
        let tStart = CACurrentMediaTime()
        var next = tStart
        for (i, width) in widths.enumerated() {
            setWidth(width)
            next += 1.0 / 120
            while CACurrentMediaTime() < next { sleep(0.0003) }
            let t = text()
            if flat(t).count < inkBefore * 3 / 10 { blank += 1 }
            if debris(t) {
                bad += 1
                if badShots.count < 3 { badShots.append("width \(Int(width)): " + t.split(separator: "\n").prefix(4).joined(separator: " | ")) }
            }
            if !narrowShot && i + 1 < widths.count && widths[i + 1] > width {
                narrowShot = true
                let p0 = CACurrentMediaTime()
                sleep(0.1)
                savePNG("bench-narrow.png")
                next = CACurrentMediaTime()
                pause = (p0, next)
            }
        }
        let dragSecs = CACurrentMediaTime() - tStart
        sleep(1.0)
        savePNG("bench-after-drag.png")
        lock.lock()
        let dragDraws = Array(draws[d0...])
        let dragGPU = gpu
        lock.unlock()
        var gaps: [Double] = []
        // The gaps between draws, but the pause for the narrow picture.
        for i in 1..<max(1, dragDraws.count) where !(dragDraws[i].t > pause.0 && dragDraws[i - 1].t < pause.1) {
            gaps.append((dragDraws[i].t - dragDraws[i - 1].t) * 1000)
        }
        // The window's screen against the daemon's.
        var daemonText = ""
        if let c = view.conn, let r = try? c.call("pane.capture", ["pane": view.pane]) {
            let lines = (r["lines"] as? [[String: Any]] ?? []).map { ($0["text"] as? String ?? "").replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression) }
            daemonText = lines.joined(separator: "\n")
        }
        let clientText = text()
        result["drag"] = [
            "steps": widths.count, "seconds": dragSecs - (pause.1 - pause.0), "min_width": Double(dragMin),
            "blank": blank, "debris": bad, "debris_examples": badShots,
            "ends_on_daemon_screen": clientText == daemonText,
            "draws": dragDraws.count, "fps": Double(dragDraws.count) / dragSecs,
            "draw_gap_ms": Bench.stats(gaps),
            "cpu_ms": Bench.stats(dragGPU.map { $0.cpu }), "gpu_ms": Bench.stats(dragGPU.map { $0.gpu }),
            "frame_ms": Bench.stats(dragGPU.map { $0.cpu + $0.gpu }),
        ]
        if clientText != daemonText {
            result["drag_client_screen"] = clientText
            result["drag_daemon_screen"] = daemonText
        }

        // 3. seq 1 2000000.
        key("\u{3}", code: 0x08, flags: .control) // Ctrl+C: drop the command line
        _ = waitFor(3) { !self.text().contains("line 9") }
        sleep(0.5)
        main { view.sendEvents([["text": "seq 1 2000000"]]) }
        _ = waitFor(3) { self.text().contains("seq 1 2000000") }
        sleep(0.2)
        lock.lock(); let f0 = draws.count; gpu.removeAll(); lock.unlock()
        let tSeq = CACurrentMediaTime()
        key("\r", code: 0x24)
        // Done: the command line scrolled away and the prompt is back
        // (BSD seq prints the last numbers as 2e+06).
        let done = waitFor(60) {
            let t = self.text()
            let last = t.split(separator: "\n").last.map(String.init) ?? ""
            return !t.contains("seq 1 2000000") && last == "~ >"
        }
        let seqSecs = CACurrentMediaTime() - tSeq
        savePNG("bench-seq.png")
        lock.lock()
        let seqDraws = Array(draws[f0...])
        let seqGPU = gpu
        lock.unlock()
        var sgaps: [Double] = []
        for i in 1..<max(1, seqDraws.count) { sgaps.append((seqDraws[i].t - seqDraws[i - 1].t) * 1000) }
        result["seq"] = [
            "done": done, "seconds": seqSecs, "draws": seqDraws.count, "fps": Double(seqDraws.count) / seqSecs,
            "draw_gap_ms": Bench.stats(sgaps), "cpu_ms": Bench.stats(seqGPU.map { $0.cpu }),
            "gpu_ms": Bench.stats(seqGPU.map { $0.gpu }), "frame_ms": Bench.stats(seqGPU.map { $0.cpu + $0.gpu }),
        ]
        result["grid"] = main { "\(view.gridSize.cols)x\(view.gridSize.rows)" }
        result["cell_px"] = "\(view.renderer.fonts.cellWidth)x\(view.renderer.fonts.cellHeight)"
    }

    private func lastLineHas(_ s: String) -> Bool {
        view.screen.lock()
        defer { view.screen.unlock() }
        let y = view.screen.cursor.y
        return view.screen.rowText(y).hasSuffix(s)
    }

    private func finish() {
        if let d = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
            try? d.write(to: URL(fileURLWithPath: out))
        }
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }
}
