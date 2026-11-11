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
//    daemon's screen, and the pane's whole text (scrollback and screen)
//    the prompt and the command line once each, nothing else;
// 2b. the fast drag: a size every 2 ms (500 a second), jumps of up to
//    400 pt in width and 150 pt in height, as narrow as 160 pt and as
//    short as 180 pt (the command line far taller than the window), then
//    wide and taller; checked the same way;
// 3. `seq 1 2000000`: from Enter to the last number and the prompt drawn;
// 4. every draw's CPU time (building and encoding) and GPU time.
//
// scripts/bench.sh runs it on a throwaway daemon.

import AppKit

/// A pane the drags check: its command line (prompt and paste) and the
/// ink it had before.
private struct Watched {
    let v: TerminalView
    let whole: String
    let fp: String
    var ink: Int
    var all: [String]
}

final class Bench {
    var view: TerminalView
    let window: NSWindow
    let out: String
    let dragMin: CGFloat
    private var result: [String: Any] = [:]
    private let lock = NSLock()
    private var draws: [(t: Double, seq: UInt32, cpu: Double)] = []
    private var gpu: [(cpu: Double, gpu: Double)] = []

    let workspace: Workspace
    /// The sidebar and the panel (the workspace drag reads the hub's rows).
    var board: Board?
    /// --bench-resize: only the drag of the whole window (runResize).
    var resizeOnly = false
    /// The drag's window on the screen (--bench-onscreen), for the drawables as there.
    var onscreen = false

    init(view: TerminalView, window: NSWindow, out: String, dragMin: CGFloat, workspace: Workspace) {
        self.workspace = workspace
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
        Thread { self.resizeOnly ? self.runResize() : self.run() }.start()
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

    private func savePNG(_ name: String, window whole: Bool = false) {
        let img: CGImage? = main { whole ? windowImage() : view.snapshotImage() }
        guard let img else { return }
        let url = URL(fileURLWithPath: out).deletingLastPathComponent().appendingPathComponent(name)
        let rep = NSBitmapImageRep(cgImage: img)
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
    }

    /// The window as it would show: its views (the strip, the headers)
    /// and each pane's last drawing at its place.
    private func windowImage() -> CGImage? {
        guard let root = window.contentView, let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { return nil }
        root.cacheDisplay(in: root.bounds, to: rep)
        let s: CGFloat = 2
        let w = Int(root.bounds.width * s), h = Int(root.bounds.height * s)
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
              let base = rep.cgImage else { return nil }
        ctx.draw(base, in: CGRect(x: 0, y: 0, width: w, height: h))
        for (_, b) in workspace.boxes where b.term.window != nil && b.term.live {
            guard let img = b.term.snapshotImage() else { continue }
            let r = b.term.convert(b.term.bounds, to: root)
            // root is flipped: y from the top.
            ctx.setAlpha(b.term.alphaValue)
            ctx.draw(img, in: CGRect(x: r.minX * s, y: CGFloat(h) - r.maxY * s, width: r.width * s, height: r.height * s))
        }
        return ctx.makeImage()
    }

    /// The front tab's panes the drag checks.
    private var panesInFront: [TerminalView] {
        main { workspace.active.map { t in workspace.panes(of: t, visibleOnly: true).compactMap { workspace.boxes[$0]?.term } } ?? [view] }
    }

    /// 4 tabs, 2 split: the first split right (in front, the keyboard on
    /// its left pane), the third split down.
    private func setUpTabs() {
        func ready() { _ = waitFor(5) { self.main { self.workspace.focusedView?.screen.text().contains("~ >") ?? false } } }
        main { workspace.split("right") }; ready()
        main { workspace.newTab(nil) }; ready()
        main { workspace.newTab(nil) }; ready()
        main { workspace.split("down") }; ready()
        main { workspace.newTab(nil) }; ready()
        main {
            workspace.select(index: 0)
            workspace.focusToward("left")
        }
        sleep(0.3)
        view = main { workspace.focusedView! }
        let first = view
        for v in panesInFront where v !== first {
            let old = v.renderer.onTiming
            v.renderer.onTiming = { [weak self] cpu, gpu in
                old?(cpu, gpu)
                guard let self else { return }
                self.lock.lock(); self.gpu.append((cpu, gpu)); self.lock.unlock()
            }
        }
        view.onDraw = { [weak self] seq, cpu in
            guard let self else { return }
            self.lock.lock(); self.draws.append((CACurrentMediaTime(), seq, cpu)); self.lock.unlock()
        }
        result["tabs"] = main { "\(workspace.tabs.count) tabs, \(workspace.tabs.filter { $0.guest != nil }.count) split" }
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

    private func setSize(_ w: CGFloat, _ h: CGFloat) {
        main {
            var f = window.frame
            f.size = NSSize(width: w, height: h)
            window.setFrame(f, display: false)
        }
    }

    /// The daemon's screen, and its whole text: scrollback rows first.
    private func daemonText(_ v: TerminalView? = nil) -> (screen: String, all: [String], history: Int) {
        let v = v ?? view
        guard let c = v.conn, let r = try? c.call("pane.capture", ["pane": v.pane, "history": 100000]) else { return ("", [], 0) }
        let lines = (r["lines"] as? [[String: Any]] ?? []).map { ($0["text"] as? String ?? "").replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression) }
        let history = r["history"] as? Int ?? 0
        return (lines.dropFirst(history).joined(separator: "\n"), lines, history)
    }

    /// The pane's whole text read row by row against its text before the
    /// drag (the prompt and the command line) in order: a row that is not
    /// its next piece is debris; a blank row above the last row of text is
    /// a cleared prompt row left behind; the first row of text must be
    /// the same as before (at the same width).
    private func checkWhole(_ all: [String], history: Int, before: [String]) -> [String: Any] {
        let flat = { (s: String) in s.filter { !$0.isWhitespace } }
        let whole = before.map(flat).joined()
        let first = before.map(flat).first { !$0.isEmpty } ?? ""
        var pos = whole.startIndex, seen = false, top = false, debris = 0, blank = 0, run = 0
        var examples: [String] = []
        for (i, row) in all.enumerated() {
            let f = flat(row)
            if f.isEmpty { run += 1; continue }
            if !seen { top = f == first }
            seen = true
            blank += run
            run = 0
            if whole[pos...].hasPrefix(f) {
                pos = whole.index(pos, offsetBy: f.count)
            } else {
                debris += 1
                if examples.count < 3 { examples.append("row \(i) (history \(history)): " + row) }
            }
        }
        return ["debris": debris, "blank_rows": blank, "top_is_prompt": top, "whole": pos == whole.endIndex,
                "history": history, "debris_examples": examples]
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
        setUpTabs()

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

        // 2. The drag, over both panes of the split in front: each has the
        // pasted command line and is checked on its own.
        sleep(0.3)
        let words = "the quick brown fox jumps over the lazy dog and keeps running past the river while the wind blows"
        let pasted = (0..<10).map { "line \($0): " + String(repeating: words + " ", count: $0 % 3 + 1) }.joined(separator: "\n")
        let flat = { (s: String) in s.filter { !$0.isWhitespace } }
        var watched: [Watched] = []
        for v in panesInFront {
            // A clean start: no scrollback (the split made the left pane
            // narrower, and its rows of the styles above went up into it).
            main { v.clearScreen(nil) }
            _ = waitFor(3) { self.daemonText(v).history == 0 }
            sleep(0.3)
            let promptScreen = v.screen.text()
            main { v.pasteText(pasted) }
            _ = waitFor(5) { v.screen.text().contains("line 9") }
            watched.append(Watched(v: v, whole: flat(promptScreen + pasted), fp: flat(promptScreen), ink: 0, all: []))
        }
        sleep(0.8)
        for i in watched.indices {
            watched[i].ink = flat(watched[i].v.screen.text()).count
            watched[i].all = daemonText(watched[i].v).all
        }
        savePNG("bench-pasted.png")
        savePNG("bench-window.png", window: true)
        func debris(_ w: Watched, _ t: String) -> Bool {
            var f = flat(t)
            if f.hasPrefix(w.fp + ">....") { f = String(f.dropFirst(w.fp.count + 5)) } else if f.hasPrefix(">....") { f = String(f.dropFirst(5)) }
            return !w.whole.contains(f)
        }
        /// Each pane's screen now: blank (its command line gone), debris.
        func sample(_ label: String, _ blank: inout Int, _ bad: inout Int, _ shots: inout [String], fast: Bool = false) {
            for w in watched {
                let t = w.v.screen.text()
                // At most what the grid holds: a narrow pane at a larger
                // font shows less of the command line without losing it.
                _ = fast
                w.v.screen.lock()
                let g = (cols: w.v.screen.cols, rows: w.v.screen.rows)
                w.v.screen.unlock()
                let limit = min(w.ink, g.cols * max(1, g.rows - 1))
                if flat(t).count < limit * 3 / 10 {
                    blank += 1
                    if shots.count < 3 { shots.append("blank \(label) pane \(w.v.pane): " + t.split(separator: "\n").prefix(3).joined(separator: " | ")) }
                }
                if debris(w, t) {
                    bad += 1
                    if shots.count < 3 { shots.append("debris \(label) pane \(w.v.pane): " + t.split(separator: "\n").prefix(4).joined(separator: " | ")) }
                }
            }
        }
        /// Each pane's last screen against the daemon's, and its whole text.
        func ends() -> (Bool, [[String: Any]], [String: String]) {
            var same = true
            var after: [[String: Any]] = []
            var diff: [String: String] = [:]
            for w in watched {
                let (d, all, h) = daemonText(w.v)
                let c = w.v.screen.text()
                if c != d { same = false; diff[w.v.pane] = "client:\n" + c + "\ndaemon:\n" + d }
                after.append(checkWhole(all, history: h, before: w.all))
            }
            return (same, after, diff)
        }
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
            sample("width \(Int(width))", &blank, &bad, &badShots)
            if !narrowShot && i + 1 < widths.count && widths[i + 1] > width {
                narrowShot = true
                let p0 = CACurrentMediaTime()
                sleep(0.1)
                savePNG("bench-narrow.png", window: true)
                next = CACurrentMediaTime()
                pause = (p0, next)
            }
        }
        let dragSecs = CACurrentMediaTime() - tStart
        sleep(1.0)
        savePNG("bench-after-drag.png", window: true)
        lock.lock()
        let dragDraws = Array(draws[d0...])
        let dragGPU = gpu
        lock.unlock()
        var gaps: [Double] = []
        // The gaps between draws, but the pause for the narrow picture.
        for i in 1..<max(1, dragDraws.count) where !(dragDraws[i].t > pause.0 && dragDraws[i - 1].t < pause.1) {
            gaps.append((dragDraws[i].t - dragDraws[i - 1].t) * 1000)
        }
        let (same, after, diff) = ends()
        result["drag"] = [
            "panes": watched.count, "steps": widths.count, "seconds": dragSecs - (pause.1 - pause.0), "min_width": Double(dragMin),
            "blank": blank, "debris": bad, "debris_examples": badShots,
            "ends_on_daemon_screen": same,
            "draws": dragDraws.count, "fps": Double(dragDraws.count) / dragSecs,
            "draw_gap_ms": Bench.stats(gaps),
            "cpu_ms": Bench.stats(dragGPU.map { $0.cpu }), "gpu_ms": Bench.stats(dragGPU.map { $0.gpu }),
            "frame_ms": Bench.stats(dragGPU.map { $0.cpu + $0.gpu }),
            "after": after,
        ]
        if !diff.isEmpty { result["drag_screens"] = diff }

        // 2b. The fast drag.
        let h0 = main { window.frame.height }
        var sizes: [CGSize] = []
        var rng: UInt64 = 7
        func rand(_ n: Int) -> CGFloat {
            rng = rng &* 6364136223846793005 &+ 1442695040888963407
            return CGFloat(Int((rng >> 33) % UInt64(n)))
        }
        // Each pane as narrow as the one pane of a window was (160 pt):
        // the window wider by the panes side by side.
        let across = CGFloat(main { workspace.active.map { $0.guest != nil && ($0.side == "right" || $0.side == "left") ? 2 : 1 } ?? 1 })
        let floor = 160 * across + (across - 1) * Design.gutter
        result["fast_drag_min_width"] = Double(floor)
        var fw: CGFloat = 1200, fh = h0
        for i in 0..<400 {
            fw += (i / 40 % 2 == 0 ? -1 : 1) * (rand(400) + 8)
            fh += rand(300) - 150
            fw = min(max(fw, floor), 1300)
            fh = min(max(fh, 180), h0 + 300)
            sizes.append(CGSize(width: fw, height: fh))
        }
        var sw: CGFloat = floor
        while sw <= 1200 { sizes.append(CGSize(width: sw, height: 180)); sw += 16 }
        sizes.append(CGSize(width: 1200, height: h0))
        sizes.append(CGSize(width: 1200, height: h0 + 300))
        lock.lock(); let f0d = draws.count; gpu.removeAll(); lock.unlock()
        var fblank = 0, fbad = 0, fticks = 0
        var fshots: [String] = []
        let fStart = CACurrentMediaTime()
        var fnext = fStart, ftick = fStart + 1.0 / 120
        for sz in sizes {
            setSize(sz.width, sz.height)
            fnext += 0.002
            while CACurrentMediaTime() < fnext {
                if CACurrentMediaTime() >= ftick { fticks += 1; sample("fast", &fblank, &fbad, &fshots, fast: true); ftick += 1.0 / 120 }
                sleep(0.0002)
            }
        }
        let fSecs = CACurrentMediaTime() - fStart
        let settle = CACurrentMediaTime() + 1.0
        while CACurrentMediaTime() < settle { fticks += 1; sample("fast", &fblank, &fbad, &fshots, fast: true); sleep(1.0 / 120) }
        savePNG("bench-after-fast-drag.png", window: true)
        lock.lock()
        let fDraws = Array(draws[f0d...])
        let fGPU = gpu
        lock.unlock()
        let (fsame, fafter, fdiff) = ends()
        result["fast_drag"] = [
            "steps": sizes.count, "seconds": fSecs, "steps_per_s": Double(sizes.count) / fSecs,
            "ticks": fticks, "blank": fblank, "debris": fbad, "examples": fshots,
            "ends_on_daemon_screen": fsame, "draws": fDraws.count,
            "frame_ms": Bench.stats(fGPU.map { $0.cpu + $0.gpu }),
            "after": fafter,
        ]
        if !fdiff.isEmpty { result["fast_drag_screens"] = fdiff }
        setSize(1200, h0)
        sleep(0.5)

        // 2c. The divider: from the middle to 20 %, to 80 % and back, a
        // step of 0.5 % at 120 a second, as AppKit's tracking moves it.
        if let sv = main({ workspace.focusedView?.superview?.superview as? PaneSplitView }) {
            var fr: [CGFloat] = []
            var x: CGFloat = 0.5
            while x > 0.2 { fr.append(x); x -= 0.005 }
            while x < 0.8 { fr.append(x); x += 0.005 }
            while x > 0.5 { fr.append(x); x -= 0.005 }
            fr.append(0.5)
            lock.lock(); let dd0 = draws.count; gpu.removeAll(); lock.unlock()
            var dblank = 0, dbad = 0
            var dshots: [String] = []
            main { sv.beginDrag() }
            let dStart = CACurrentMediaTime()
            var dnext = dStart
            for f in fr {
                main { sv.setFraction(f) }
                dnext += 1.0 / 120
                while CACurrentMediaTime() < dnext { sleep(0.0003) }
                sample(String(format: "divider %.3f", f), &dblank, &dbad, &dshots)
            }
            main { sv.endDrag() }
            let dSecs = CACurrentMediaTime() - dStart
            sleep(1.0)
            lock.lock()
            let dDraws = Array(draws[dd0...])
            let dGPU = gpu
            lock.unlock()
            let (dsame, dafter, ddiff) = ends()
            result["divider_drag"] = [
                "steps": fr.count, "seconds": dSecs, "blank": dblank, "debris": dbad, "examples": dshots,
                "ends_on_daemon_screen": dsame, "draws": dDraws.count,
                "frame_ms": Bench.stats(dGPU.map { $0.cpu + $0.gpu }), "after": dafter,
            ]
            if !ddiff.isEmpty { result["divider_screens"] = ddiff }
            savePNG("bench-after-divider.png", window: true)
        }

        // 2d. Switching tabs: each switch's first draw (the rows the
        // panes had) and the first frame of their new streams; a pane
        // whose first draw is blank counts.
        var drawnMs: [Double] = [], frameMs: [Double] = []
        let swLock = NSLock()
        main {
            workspace.onSwitch = { _, d, f, _ in
                swLock.lock(); drawnMs.append(d); frameMs.append(f); swLock.unlock()
            }
        }
        var swBlank = 0, switches = 0
        var swShots: [String] = []
        for round in 0..<6 {
            for idx in [1, 2, 3, 0] {
                let blankPanes: [String] = main {
                    workspace.select(index: idx)
                    // What the panes drew at the switch, before any frame.
                    return workspace.panes(of: workspace.active!, visibleOnly: true).compactMap { id in
                        guard let v = workspace.boxes[id]?.term else { return id }
                        return v.screen.text().filter { !$0.isWhitespace }.isEmpty ? id : nil
                    }
                }
                switches += 1
                swBlank += blankPanes.count
                if !blankPanes.isEmpty && swShots.count < 3 { swShots.append("round \(round) tab \(idx): \(blankPanes)") }
                sleep(0.15)
            }
        }
        main { workspace.onSwitch = nil }
        swLock.lock()
        result["tab_switch"] = [
            "switches": switches, "blank_panes": swBlank, "examples": swShots,
            "first_draw_ms": Bench.stats(drawnMs), "first_frame_ms": Bench.stats(frameMs),
        ]
        swLock.unlock()
        main { workspace.select(index: 0) }
        sleep(0.3)
        savePNG("bench-tabs.png", window: true)

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
        // The grid of the app's first window (900 x 560 pt of terminal at
        // scale 2, the same padding), with this cell and with Rex's, 14 x 28
        // px at 2x as measured on a screenshot.
        let r = view.renderer
        let s = r.fonts.scale
        let g = r.grid(for: CGSize(width: 900, height: 560))
        let rex = (Int((900 - 2 * r.padding) * s / 14), Int((560 - 2 * r.padding) * s / 28))
        result["window_900x560"] = [
            "font": "\(r.fontName) \(Int(r.fontSize))", "scale": Double(s), "grid": "\(g.cols)x\(g.rows)",
            "cell_px": "\(Int(r.fonts.cellWidth))x\(Int(r.fonts.cellHeight))",
            "cell_pt": "\(Double(r.fonts.cellWidth / s))x\(Double(r.fonts.cellHeight / s))",
            "rex_grid": "\(rex.0)x\(rex.1)",
        ]
    }

    // MARK: the whole window's drag (--bench-resize)

    /// The window as the person has it: the hub's sidebar, the panel
    /// docked, four tabs, the one in front busy (a loop printing about 30
    /// lines a second), drawn through the window's Metal layer. Its width
    /// is dragged from 1440 pt to 700 and back at 120 steps a second, the
    /// window in a live resize, as when the person drags its edge; each
    /// step is a setFrame with display, as AppKit's own. For each step:
    /// its main-thread time, whether the pane in front drew at the step's
    /// size within it and how many times; the draws a second, the longest
    /// gap between draws, the waits for a drawable, the draws of the panes
    /// not in front (none expected) and the lines the stall log wrote.
    private func runResize() {
        defer { finish() }
        guard waitFor(20, { self.text().contains("~ >") }) else {
            result["error"] = "no prompt: " + text()
            return
        }
        // The hub's rows in the sidebar.
        let rows = waitFor(15) { self.main { self.board?.hub.state != nil } }
        sleep(0.5)
        setSize(1440, 800)
        sleep(0.5)
        func ready() { _ = waitFor(5) { self.main { self.workspace.focusedView?.screen.text().contains("~ >") ?? false } } }
        for _ in 0..<3 { main { workspace.newTab(nil) }; ready() }
        main { workspace.select(index: 0) }
        sleep(0.3)
        view = main { workspace.focusedView! }
        // What the pane in front shows (RAVENRY_BENCH_CONTENT, resizebench
        // --content): "busy" (the default, the loop), "idle" (the shell at
        // its prompt), or a command typed in it (a replayed Claude tab and
        // its spinner), given 3 s to draw its screen.
        let content = ProcessInfo.processInfo.environment["RAVENRY_BENCH_CONTENT"].flatMap { $0.isEmpty ? nil : $0 } ?? "busy"
        if content == "busy" {
            // A line about 30 times a second, of 3 to 19 words, and the
            // screen drawn again as Claude Code draws it, once for every
            // size it is told, in order, 150 ms after it: a synchronized
            // update (mode 2026), every row erased from the top, the last
            // lines word-wrapped at that size's width with each word
            // placed at its column (ESC[<col>G), the rows one under the
            // other from the top (CR LF, autowrap on), in four writes 5 ms
            // apart, the update ended. A frame of the drag that shows that
            // redraw half done has rows missing, and one laid out for a
            // wider width than the screen has bars, a lone letter down the
            // last column (the content check below). Given until the
            // screen is full.
            let busy = #"""
            # The redraw's writes go through /usr/bin/printf: zsh's own
            # printf loses a write a SIGWINCH interrupts.
            zmodload zsh/datetime
            P=/usr/bin/printf; Q=(); TRAPWINCH() { Q+=("$EPOCHREALTIME $(stty size)") }
            W=(the quick brown fox jumps over the lazy dog and keeps running past the river while the wind blows)
            L=(); i=0
            while :; do
              while (( $#Q )) && (( EPOCHREALTIME - ${Q[1]%% *} >= 0.15 )); do
                sz=${Q[1]#* }; shift Q; r=${sz% *}; c=${sz#* }; n=$((r - 1)); k=$(( (n + 3) / 4 ))
                R=()
                for l in "${(@)L[-n,-1]}"; do
                  row=''; x=0
                  for w in ${=l}; do
                    if (( x > 0 && x + 1 + $#w > c )); then R+=("$row"); row=''; x=0; fi
                    if (( x > 0 )); then x=$((x + 1)); row+=$'\e['$((x + 1))'G'; fi
                    row+=$w; x=$((x + $#w))
                  done
                  R+=("$row")
                done
                R=("${(@)R[-n,-1]}")
                e=''; repeat $r e+=$'\e[2K\e[1B'
                $P '\033[?2026h\033[H%s\033[H' "$e"
                for p in 0 1 2 3; do
                  sleep 0.005; s=''
                  for (( y = p * k + 1; y <= p * k + k && y <= $#R; y++ )); do
                    (( y > 1 )) && s+=$'\r\n'; s+=$R[y]
                  done
                  $P '%s' "$s"
                done
                $P '\r\n\033[?2026l'
              done
              i=$((i + 1)); l="busy $i $W[1,$(( 1 + i % 17 ))]"
              L+=("$l"); (( $#L > 300 )) && shift L
              print -r -- "$l"; sleep 0.033
            done
            """#
            let script = (ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()) + "/bench-busy.zsh"
            try? busy.write(toFile: script, atomically: true, encoding: .utf8)
            main { view.sendEvents([["text": "zsh \(script)"]]) }
            key("\r", code: 0x24)
            _ = waitFor(3) { self.text().contains("busy 20") }
            let full = main { view.screen.rows }
            _ = waitFor(8) { self.text().contains("busy \(full + 20)") }
        } else if content != "idle" {
            main { view.sendEvents([["text": content]]) }
            key("\r", code: 0x24)
            sleep(3)
        }
        sleep(0.5)
        let front = view
        let others: [TerminalView] = main { workspace.boxes.values.map(\.term).filter { $0 !== front } }
        let othersBefore = main { others.map(\.drawCount).reduce(0, +) }
        let logFile = (ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()) + "/Library/Logs/Ravenry/app.log"
        let logBefore = (try? String(contentsOfFile: logFile, encoding: .utf8))?.components(separatedBy: "\n").filter { $0.contains("draw:") }.count ?? 0
        var drawsAt: [(t: Double, px: CGSize, wait: Double)] = []
        // When each of the pane's frames came (the reader thread), for the
        // time from a frame to the draw that showed it.
        var framesAt: [Double] = []
        // The content check: the rows with text on them of each frame
        // (the screen once it is applied), against the full screen's
        // before the drag. A frame with fewer shows a program's redraw
        // half done (rows erased and not drawn again yet).
        // And its bars: rows ending in a lone character, a redraw laid out
        // for a wider width on a narrower screen (Screen.barRows).
        var filledAt: [(t: Double, n: Int, rows: Int, held: Bool, bars: Int)] = []
        front.screen.lock()
        let fullRows = front.screen.filledRows()
        front.screen.unlock()
        let dl = NSLock()
        main {
            front.onDraw = { _, _ in
                dl.lock(); drawsAt.append((CACurrentMediaTime(), front.drawnPixels, front.lastWaitMs)); dl.unlock()
            }
            let before = front.onFrame
            front.onFrame = {
                before?()
                front.screen.lock()
                let n = front.screen.filledRows(), rows = front.screen.rows, held = front.screen.held, bars = front.screen.barRows()
                front.screen.unlock()
                dl.lock(); framesAt.append(CACurrentMediaTime()); filledAt.append((CACurrentMediaTime(), n, rows, held, bars)); dl.unlock()
            }
            board?.resizeMs.removeAll()
        }
        var widths: [CGFloat] = []
        var w: CGFloat = 1433
        while w > 700 { widths.append(w); w -= 7 }
        while w <= 1440 { widths.append(w); w += 7 }
        var inTransactionAtStep = 0
        // One drag of the edge: per step its main-thread time, the draws in
        // it, the drawables out when it began, and when it was drawn at its size.
        func drag() -> (stepMs: [Double], perStep: [Double], notDrawn: Int, multi: Int, late: Int, examples: [String],
                        outAtStep: [Double], toDrawn: [Double], tStart: Double, secs: Double) {
            var stepMs: [Double] = [], perStep: [Double] = [], outAtStep: [Double] = [], toDrawn: [Double] = []
            var notDrawn = 0, multi = 0, late = 0
            var examples: [String] = []
            inTransactionAtStep = 0
            main { (window as? TerminalWindow)?.simulatedLiveResize = true }
            let tStart = CACurrentMediaTime()
            var next = tStart
            var pending: [(want: CGSize, at: Double, n: Int)] = []
            for width in widths {
                dl.lock(); let n0 = drawsAt.count; dl.unlock()
                let t0 = CACurrentMediaTime()
                let (want, out): (CGSize, Int) = main {
                    let out = front.outstanding
                    if front.inTransaction > 0 { inTransactionAtStep += 1 }
                    var f = window.frame
                    f.size.width = width
                    window.setFrame(f, display: true)
                    let s = front.renderer.fonts.scale
                    return (CGSize(width: max(1, round(front.bounds.width * s)), height: max(1, round(front.bounds.height * s))), out)
                }
                let t1 = CACurrentMediaTime()
                stepMs.append((t1 - t0) * 1000)
                outAtStep.append(Double(out))
                dl.lock(); let mine = drawsAt[n0...].filter { $0.t <= t1 }; dl.unlock()
                perStep.append(Double(mine.count))
                if mine.count > 1 { multi += 1 }
                if !mine.contains(where: { $0.px == want }) {
                    notDrawn += 1
                    pending.append((want, t0, n0))
                    if examples.count < 3 { examples.append("width \(Int(width)): drew \(mine.map { "\(Int($0.px.width))x\(Int($0.px.height))" }) for \(Int(want.width))x\(Int(want.height))") }
                } else { toDrawn.append((t1 - t0) * 1000) }
                if (t1 - t0) > 1.0 / 60 { late += 1 }
                next += 1.0 / 120
                while CACurrentMediaTime() < next { sleep(0.0003) }
                if CACurrentMediaTime() > next + 0.05 { next = CACurrentMediaTime() }
            }
            let secs = CACurrentMediaTime() - tStart
            sleep(0.1)
            // A step not drawn in it: when (if ever) it was drawn at its size after.
            dl.lock(); let all = drawsAt; dl.unlock()
            for p in pending {
                if let d = all[p.n...].first(where: { $0.px == p.want }) { toDrawn.append((d.t - p.at) * 1000) } else { toDrawn.append(1000) }
            }
            return (stepMs, perStep, notDrawn, multi, late, examples, outAtStep, toDrawn, tStart, secs)
        }
        let skips0 = main { front.presents = []; return DrawWatch.shared.skipsTotal }
        let r = drag()
        let stepMs = r.stepMs, perStep = r.perStep, notDrawn = r.notDrawn, multi = r.multi, late = r.late, examples = r.examples
        let tStart = r.tStart
        let pr0 = main { front.presents ?? [] }
        let secs = r.secs
        let skipsInDrag = main { DrawWatch.shared.skipsTotal } - skips0
        // Four draws in one turn of the run loop, as a step's and the
        // stream's can come together: none may wait on the main thread for
        // a drawable, and a draw put off is done once one is shown.
        sleep(0.2)
        dl.lock(); let b0 = drawsAt.count; dl.unlock()
        let burst: (ms: Double, skipped: Int) = main {
            let k0 = DrawWatch.shared.skipsTotal
            let t = CACurrentMediaTime()
            for _ in 0..<4 { front.draw(sync: true) }
            return ((CACurrentMediaTime() - t) * 1000, DrawWatch.shared.skipsTotal - k0)
        }
        let owedDone = waitFor(0.2) { dl.lock(); defer { dl.unlock() }; return drawsAt.count >= b0 + 4 - burst.skipped + (burst.skipped > 0 ? 1 : 0) }
        main { (window as? TerminalWindow)?.endSimulatedLiveResize() }
        sleep(1.0)
        dl.lock(); let all = drawsAt; dl.unlock()
        let during = all.filter { $0.t >= tStart && $0.t <= tStart + secs }
        var gaps: [Double] = []
        for i in 1..<max(1, during.count) { gaps.append((during[i].t - during[i - 1].t) * 1000) }
        // A frame that came in the drag: the time until the next draw (the one that showed it).
        dl.lock(); let frames = framesAt.filter { $0 >= tStart && $0 <= tStart + secs }; dl.unlock()
        var frameToDraw: [Double] = []
        var di = 0
        for f in frames {
            while di < all.count && all[di].t < f { di += 1 }
            if di < all.count { frameToDraw.append((all[di].t - f) * 1000) }
        }
        // The content check, over the frames of the drag and of the 100 ms
        // after it: a frame short of a tenth or more of the full screen's
        // rows. Content with blank lines (a Claude transcript) has a row
        // or two more or fewer of them in view once reflowed; a redraw
        // shown half done has most rows missing.
        dl.lock(); let filled = filledAt.filter { $0.t >= tStart && $0.t <= tStart + secs + 0.1 }; dl.unlock()
        let short = filled.filter { $0.n * 10 < min(fullRows, $0.rows) * 9 }
        let shortExamples = short.prefix(3).map { "\(String(format: "%.0f", ($0.t - tStart) * 1000)) ms: \($0.n) of \($0.rows) rows\($0.held ? " (held)" : "")" }
        // A frame with bars on four rows or more, in the drag and the
        // 600 ms after it (a program redraws for each size it was told,
        // 100 to 250 ms behind).
        dl.lock(); let barWindow = filledAt.filter { $0.t >= tStart && $0.t <= tStart + secs + 0.6 }; dl.unlock()
        let barred = barWindow.filter { $0.bars >= 4 }
        let barExamples = barred.prefix(3).map { "\(String(format: "%.0f", ($0.t - tStart) * 1000)) ms: \($0.bars) of \($0.rows) rows end in a lone character" }
        // The last lines the pane in front shows: its content was what was asked.
        let lines: [String] = text().components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        let tail: [String] = Array(lines.suffix(4))
        let othersAfter = main { others.map(\.drawCount).reduce(0, +) }
        let logAfter = (try? String(contentsOfFile: logFile, encoding: .utf8))?.components(separatedBy: "\n").filter { $0.contains("draw:") } ?? []
        let resize = main { board?.resizeMs ?? [] }
        let sideRows = main { board.map { !$0.sideHidden && $0.root.sideWidth > 0 } ?? false }
        let panel = main { "\(board?.root.panelMode ?? .hidden)" }
        result["resize"] = [
            "onscreen": onscreen, "hub_rows": rows, "sidebar_shown": sideRows, "panel_at_end": panel,
            "tabs": main { workspace.tabs.count }, "steps": widths.count, "seconds": secs,
            "step_ms": Bench.stats(stepMs), "steps_over_16ms": late,
            "draws_per_step": Bench.stats(perStep), "steps_not_drawn_at_their_size": notDrawn, "steps_drawn_more_than_once": multi,
            "examples": examples,
            "draws": during.count, "fps": Double(during.count) / secs, "draw_gap_ms": Bench.stats(gaps),
            "content": content, "frames_in_drag": frames.count, "frame_to_draw_ms": Bench.stats(frameToDraw),
            "front_text_tail": tail,
            "drawable_wait_ms": Bench.stats(during.map(\.wait)),
            "board_resize_ms": Bench.stats(resize),
            "hidden_tab_draws": othersAfter - othersBefore,
            "draws_put_off_in_drag": skipsInDrag,
            "outstanding_at_step": Bench.stats(r.outAtStep), "steps_begun_with_a_draw_uncommitted": inTransactionAtStep, "step_to_drawn_ms": Bench.stats(r.toDrawn),
            "present_to_handler_ms": Bench.stats(pr0.map(\.ms)), "presents_dropped": pr0.filter { !$0.shown }.count,
            "burst_4_draws_ms": burst.ms, "burst_put_off": burst.skipped, "burst_owed_draw_done": owedDone,
            "stall_log_lines": logAfter.count - logBefore, "stall_log_examples": Array(logAfter.suffix(3)),
            "after_end_drawn_at_size": main { front.drawnPixels == CGSize(width: max(1, round(front.bounds.width * front.renderer.fonts.scale)), height: max(1, round(front.bounds.height * front.renderer.fonts.scale))) },
        ]
        let check: [String: Any] = [
            "content_full_rows": fullRows, "content_frames_checked": filled.count, "content_frames_short": short.count,
            "content_frames_held": filled.filter(\.held).count, "content_short_examples": shortExamples,
            "content_frames_bars": barred.count, "content_bars_examples": barExamples,
        ]
        if var res = result["resize"] as? [String: Any] {
            res.merge(check) { $1 }
            result["resize"] = res
        }
        // The stall log writes its line (a made-up stall, after the counts above).
        main { DrawWatch.shared.missed(front, ms: 99) }
        result["stall_log_written"] = waitFor(2) {
            ((try? String(contentsOfFile: logFile, encoding: .utf8)) ?? "").contains("a resize step not drawn at its size (99 ms after it)")
        }
        savePNG("bench-resize-window.png", window: true)
        key("\u{3}", code: 0x08, flags: .control)
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
