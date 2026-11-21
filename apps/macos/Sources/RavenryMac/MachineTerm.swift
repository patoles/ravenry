// A session on another machine, live (MACH-006): its pane drawn by this
// app's own renderer and typed into as a pane of this Mac is, through the
// hub's terminal stream (GET /api/term?pane=, hub/server/termproxy.mjs),
// which joins the connection to the machine's ravenryd over ssh. The hub
// judges the app the person before the stream opens and gives the machine
// its answer key, so what the person types there is theirs, not a drive
// question. The phone's terminal reaches a machine the same way.
//
// A connection that drops (this Mac slept, the network changed, the hub
// lost the machine; MACH-011) is not the end: the pane is still running
// there. The view keeps its last screen and says it lost the connection
// ("reconnecting"), and connects again by itself, every second at first,
// then every 3 seconds, for as long as it is shown; the hub answers 503
// while it does not reach the machine. The new stream draws the pane again,
// history included. Only the pane closing (pane.exited, or the hub's 404),
// or the hub refusing this window (403), ends it.

import AppKit

final class MachineTerm {
    let pane: String
    let machine: String
    /// connecting, live, reconnecting, failed, ended.
    private(set) var state = "connecting"
    /// Why it failed, ended or is reconnecting, in the hub's or the connection's words.
    private(set) var why = ""
    private(set) var conn: Connection?
    private(set) var view: TerminalView?
    /// Something it shows changed (main thread).
    var onChange: (() -> Void)?
    private var closed = false
    private var hub: URL?
    private var make: (() -> TerminalView?)?
    /// Tries since the connection was lost, for the wait before the next.
    private var tries = 0
    private var retry: DispatchWorkItem?

    init(pane: String, machine: String) {
        self.pane = pane
        self.machine = machine
    }

    /// Connects (off the main thread), then makes its view with `make` and opens the pane's render stream.
    func open(hub: URL, make: @escaping () -> TerminalView?) {
        self.hub = hub
        self.make = make
        state = "connecting"
        why = ""
        connect()
    }

    private func connect() {
        guard let hub, !closed else { return }
        let pane = self.pane
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                let c = try Connection(hub: hub, pane: pane)
                c.start()
                try c.hello(client: "ravenry-desktop", timeout: 20)
                DispatchQueue.main.async {
                    guard let self, !self.closed else { c.close(); return }
                    self.attach(c)
                }
            } catch {
                DispatchQueue.main.async {
                    guard let self, !self.closed else { return }
                    if MachineTerm.passing(error) { self.lost() } else {
                        self.state = "failed"
                        self.why = MachineTerm.words(error, machine: self.machine)
                        self.onChange?()
                    }
                }
            }
        }
    }

    private func attach(_ c: Connection) {
        conn = c
        c.onClose = { [weak self, weak c] in DispatchQueue.main.async { if let self, self.conn === c { self.lost() } } }
        c.onEvent = { [weak self] ev in
            guard ev["event"] as? String == "stream.end" || ((ev["event"] as? String == "pane.exited" || ev["event"] as? String == "pane.closed")
                    && (ev["pane"] as? [String: Any])?["id"] as? String == self?.pane) else { return }
            DispatchQueue.main.async { self?.ended(t("mach.liveEnded")) }
        }
        tries = 0
        // Connected again: the same view, its rows kept, on the new stream
        // (onChange resumes it: pane.render draws the pane again).
        if let v = view {
            v.pause()
            v.attach(c, pane: pane, fps: NSScreen.main?.maximumFramesPerSecond ?? 60)
            state = "live"
            why = ""
            onChange?()
            return
        }
        guard let v = make?() else { state = "failed"; why = t("mach.liveNoView"); onChange?(); return }
        let fps = NSScreen.main?.maximumFramesPerSecond ?? 60
        v.attach(c, pane: pane, fps: fps)
        view = v
        state = "live"
        onChange?()
    }

    /// The connection dropped, or could not be made for now: the last
    /// screen stays and it connects again by itself.
    private func lost() {
        guard !closed, state != "ended", state != "failed" else { return }
        let was = conn
        conn = nil
        was?.onClose = nil
        was?.close()
        // The view is not paused: it keeps drawing the screen it had (a
        // pause would let its drawables go) until the new stream replaces it.
        state = "reconnecting"
        why = t("mach.liveAway", ["machine": machine])
        onChange?()
        retry?.cancel()
        let wait = tries < 5 ? 1.0 : 3.0
        tries += 1
        let w = DispatchWorkItem { [weak self] in self?.connect() }
        retry = w
        DispatchQueue.main.asyncAfter(deadline: .now() + wait, execute: w)
    }

    private func ended(_ text: String) {
        guard !closed, state == "live" || state == "connecting" || state == "reconnecting" else { return }
        retry?.cancel()
        state = "ended"
        why = text
        view?.pause()
        onChange?()
    }

    /// The view on screen at its size: its stream opens (pane.render sizes the pane to it).
    func resume() { if state == "live", let v = view, v.bounds.width > 0 { v.resume() } }

    func close() {
        closed = true
        retry?.cancel()
        view?.pause()
        view?.removeFromSuperview()
        conn?.close()
    }

    /// A connection's failure as a person reads it: the hub's refusal ("HTTP/1.1 404 Not Found") or the socket's.
    static func words(_ e: Error, machine: String = "") -> String {
        guard let c = e as? ConnectionError else { return "\(e)" }
        switch c {
        case .handshake(let s) where s.contains(" 404"): return t("mach.liveGone")
        case .handshake(let s) where s.contains(" 403"): return t("mach.liveRefused")
        case .handshake(let s) where s.contains(" 503"): return t("mach.liveAway", ["machine": machine])
        case .connect: return t("mach.liveNoBoard")
        case .timeout: return t("mach.liveSlow")
        default: return "\(c)"
        }
    }

    /// Whether a failure to connect passes by itself (try again): the hub
    /// does not reach the machine now (503), the board does not answer
    /// yet, no answer in time, the connection closed on the way. Not: the
    /// pane is gone (404), this window is refused (403).
    static func passing(_ e: Error) -> Bool {
        guard let c = e as? ConnectionError else { return false }
        switch c {
        case .handshake(let s): return !s.contains(" 404") && !s.contains(" 403")
        case .connect, .timeout, .closed: return true
        case .daemon: return false
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
