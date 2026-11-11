// A session on another machine, live (MACH-006): its pane drawn by this
// app's own renderer and typed into as a pane of this Mac is, through the
// hub's terminal stream (GET /api/term?pane=, hub/server/termproxy.mjs),
// which joins the connection to the machine's ravenryd over ssh. The hub
// judges the app the person before the stream opens and gives the machine
// its answer key, so what the person types there is theirs, not a drive
// question. The phone's terminal reaches a machine the same way.

import AppKit

final class MachineTerm {
    let pane: String
    let machine: String
    /// connecting, live, failed, ended.
    private(set) var state = "connecting"
    /// Why it failed or ended, in the hub's or the connection's words.
    private(set) var why = ""
    private(set) var conn: Connection?
    private(set) var view: TerminalView?
    /// Something it shows changed (main thread).
    var onChange: (() -> Void)?
    private var closed = false

    init(pane: String, machine: String) {
        self.pane = pane
        self.machine = machine
    }

    /// Connects (off the main thread), then makes its view with `make` and opens the pane's render stream.
    func open(hub: URL, make: @escaping () -> TerminalView?) {
        state = "connecting"
        why = ""
        let pane = self.pane
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                let c = try Connection(hub: hub, pane: pane)
                c.start()
                try c.hello(client: "ravenry-desktop", timeout: 20)
                DispatchQueue.main.async {
                    guard let self, !self.closed else { c.close(); return }
                    self.attach(c, make)
                }
            } catch {
                DispatchQueue.main.async {
                    guard let self, !self.closed else { return }
                    self.state = "failed"
                    self.why = MachineTerm.words(error)
                    self.onChange?()
                }
            }
        }
    }

    private func attach(_ c: Connection, _ make: () -> TerminalView?) {
        conn = c
        c.onClose = { [weak self] in DispatchQueue.main.async { self?.ended(t("mach.liveLost")) } }
        c.onEvent = { [weak self] ev in
            guard ev["event"] as? String == "stream.end" || ((ev["event"] as? String == "pane.exited" || ev["event"] as? String == "pane.closed")
                    && (ev["pane"] as? [String: Any])?["id"] as? String == self?.pane) else { return }
            DispatchQueue.main.async { self?.ended(t("mach.liveEnded")) }
        }
        guard let v = make() else { state = "failed"; why = t("mach.liveNoView"); onChange?(); return }
        let fps = NSScreen.main?.maximumFramesPerSecond ?? 60
        v.attach(c, pane: pane, fps: fps)
        view = v
        state = "live"
        onChange?()
    }

    private func ended(_ text: String) {
        guard !closed, state == "live" || state == "connecting" else { return }
        state = "ended"
        why = text
        view?.pause()
        onChange?()
    }

    /// The view on screen at its size: its stream opens (pane.render sizes the pane to it).
    func resume() { if state == "live", let v = view, v.bounds.width > 0 { v.resume() } }

    func close() {
        closed = true
        view?.pause()
        view?.removeFromSuperview()
        conn?.close()
    }

    /// A connection's failure as a person reads it: the hub's refusal ("HTTP/1.1 404 Not Found") or the socket's.
    static func words(_ e: Error) -> String {
        guard let c = e as? ConnectionError else { return "\(e)" }
        switch c {
        case .handshake(let s) where s.contains(" 404"): return t("mach.liveGone")
        case .handshake(let s) where s.contains(" 403"): return t("mach.liveRefused")
        case .connect: return t("mach.liveNoBoard")
        case .timeout: return t("mach.liveSlow")
        default: return "\(c)"
        }
    }
}

extension Board {
    /// A terminal view for a pane on a machine, as a tab's (Workspace.box): this window's look and font, drawn offscreen when the window is.
    func machineTermView() -> TerminalView? {
        guard let v = TerminalView(frame: NSRect(x: 0, y: 0, width: 600, height: 400), scale: ws.scale, fontName: ws.look.font, fontSize: ws.look.size) else { return nil }
        v.offscreen = ws.options.offscreen && !ws.options.benchLayer
        v.apply(ws.look)
        let fps = ws.options.offscreen ? 120 : (NSScreen.main?.maximumFramesPerSecond ?? 60)
        v.refreshInterval = 1.0 / Double(max(fps, 30))
        return v
    }
}
