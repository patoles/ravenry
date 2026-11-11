// The filmstrip, as the Electron app's (apps/desktop/src/renderer/
// filmstrip.ts, its sheet .fsheet): the pane's last 20 seconds (the daemon
// keeps about 20 s of screens for every pane, PROTOCOL.md section 3,
// `pane.frames`, drawn by the daemon as PNGs in the terminal's own colours
// and size), in a sheet under the pane. The frames lie along a track from
// "20 s ago" to "now", the ones that look wrong marked (a blank screen; a
// frame replaced within 130 ms of being drawn, so it was seen half drawn; a
// stretch of 2 s or more the screen did not change), six of them as
// thumbnails cropped to where they changed. Step and play; a frame clicked
// (a thumbnail, or a press or a drag on the track: the frame closest to
// that moment) fills the pane, all of it, with "Showing hh:mm:ss" over it
// and Back to live (the pane runs on underneath); Send to the agent of the pane's session (the
// hub's POST /api/sessions/:id/filmstrip); Save as GIF. Opened from the
// strip's film button (or Learn's card), it belongs to the pane it was
// opened on and closes when another one comes to the front.
//
// A big busy pane's frames are hundreds of KB each as PNGs: the daemon
// lists every frame with its time and pictures as many as fit in its
// answer's 12 MiB (unpictured, the rest). The marks are read from every
// frame's time; the frames with a picture are the ones to step through.
// Each picture is kept as its PNG and drawn from it when shown (a 2464 x
// 1876 frame is 18 MB drawn), its thumbnail drawn once, small.

import AppKit
import UniformTypeIdentifiers

/// One frame: when, its picture, and what the look of it says.
struct FilmFrame {
    var at: Date
    /// Drawn from its PNG each time, never kept drawn.
    var image: CGImage
    /// Its thumbnail, drawn once (FilmThumb's size at the screen's scale).
    var thumb: CGImage?
    var mark: Int
    /// "blank", "half" or nil.
    var tag: String?
    /// How long the screen stayed the same after it (s), when 2 s or more.
    var still: Double
    /// Where anything is drawn, and where it differs from the frame before (fractions of the picture).
    var box: CGRect?
    var change: CGRect?
    var bg: NSColor
}

enum Film {
    static let lastMs = 20000
    static let halfMs = 130.0
    static let stallMs = 2000.0

    /// Marks the frames that look wrong (filmstrip.ts analyse). Half drawn:
    /// rows missing that the screens around it have drawn (the daemon's
    /// missing_rows), so a spinner redrawn ten times a second is not; from
    /// an older daemon, which does not count them, replaced within 130 ms.
    static func analyse(_ frames: [(at: Double, blank: Bool, missing: Int?)], end: Double) -> [(tag: String?, still: Double)] {
        frames.enumerated().map { i, f in
            let next = i + 1 < frames.count ? frames[i + 1].at : nil
            let lasted = (next ?? end) - f.at
            let half = f.missing.map { $0 > 0 } ?? (next != nil && lasted < halfMs)
            let tag: String? = f.blank && i > 0 ? "blank" : half ? "half" : nil
            return (tag, next != nil && lasted >= stallMs ? lasted : 0)
        }
    }

    /// "2 frames half drawn, 1 stall of 3 s", or "Nothing looks wrong".
    static func summary(_ fs: [(tag: String?, still: Double)]) -> String {
        let half = fs.filter { $0.tag != nil }.count
        let stalls = fs.filter { $0.still > 0 }
        var parts: [String] = []
        if half > 0 { parts.append(t(half == 1 ? "film.half1" : "film.halfN", ["n": "\(half)"])) }
        if stalls.count == 1 { parts.append(t("film.stall1", ["s": "\(Int((stalls[0].still / 1000).rounded()))"])) }
        if stalls.count > 1 { parts.append(t("film.stallN", ["n": "\(stalls.count)", "s": "\(Int(((stalls.map(\.still).max() ?? 0) / 1000).rounded()))"])) }
        return parts.isEmpty ? t("film.fine") : parts.joined(separator: ", ")
    }

    /// Up to n frames as thumbnails: the marked ones and the selected one first, then evenly between (pickThumbs).
    static func pick(_ fs: [(tag: String?, still: Double)], n: Int, sel: Int) -> [Int] {
        if fs.count <= n { return Array(fs.indices) }
        var want: [Int] = [sel]
        func add(_ i: Int) { if !want.contains(i) { want.append(i) } }
        for (i, f) in fs.enumerated() where f.tag == "half" && want.count < n - 2 { add(i) }
        for (i, f) in fs.enumerated() where f.still > 0 && want.count < n - 1 { add(i) }
        if let b = fs.firstIndex(where: { $0.tag == "blank" }), want.count < n { add(b) }
        var k = 0
        while want.count < n && k < n * 4 { add(Int((Double(k * (fs.count - 1)) / Double(n * 4 - 1)).rounded())); k += 1 }
        return Array(want.sorted().prefix(n))
    }

    /// Where a frame has something drawn, its background, and where it changed from the one before (lookAll).
    /// drawn: the picture as drawn here, so its thumbnail needs no second reading of its PNG.
    static func look(_ img: CGImage, prev: (data: [UInt8], w: Int, h: Int)?) -> (box: CGRect?, change: CGRect?, bg: NSColor, data: [UInt8], drawn: CGImage?) {
        let w = img.width, h = img.height
        var d = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = CGContext(data: &d, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        ctx?.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        let drawn = ctx?.makeImage()
        // Row 0 of the buffer is the picture's top.
        let r = Int(d[0]), g = Int(d[1]), b = Int(d[2])
        var x0 = w, y0 = h, x1 = -1, y1 = -1, lit = 0
        var cx0 = w, cy0 = h, cx1 = -1, cy1 = -1
        let same = prev.map { $0.w == w && $0.h == h } ?? false
        var y = 0
        while y < h {
            var x = 0
            while x < w {
                let i = (y * w + x) * 4
                if abs(Int(d[i]) - r) + abs(Int(d[i + 1]) - g) + abs(Int(d[i + 2]) - b) > 40 {
                    lit += 1; x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y)
                }
                if same, let p = prev?.data, abs(Int(d[i]) - Int(p[i])) + abs(Int(d[i + 1]) - Int(p[i + 1])) + abs(Int(d[i + 2]) - Int(p[i + 2])) > 40 {
                    cx0 = min(cx0, x); cx1 = max(cx1, x); cy0 = min(cy0, y); cy1 = max(cy1, y)
                }
                x += 2
            }
            y += 2
        }
        let fw = CGFloat(w), fh = CGFloat(h)
        // A lone cursor is not a drawing.
        let box = lit > 6 ? CGRect(x: CGFloat(x0) / fw, y: CGFloat(y0) / fh, width: CGFloat(x1 - x0 + 2) / fw, height: CGFloat(y1 - y0 + 2) / fh) : nil
        let change = cx1 >= 0 ? CGRect(x: CGFloat(cx0) / fw, y: CGFloat(cy0) / fh, width: CGFloat(cx1 - cx0 + 2) / fw, height: CGFloat(cy1 - cy0 + 2) / fh) : nil
        return (box, change, NSColor(srgbRed: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1), d, drawn)
    }

    /// A PNG as an image drawn from its data each time it is drawn, so a
    /// strip of big frames holds their PNGs, not their pixels.
    static func image(_ data: Data) -> CGImage? {
        let no = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let src = CGImageSourceCreateWithData(data as CFData, no) else { return nil }
        return CGImageSourceCreateImageAtIndex(src, 0, no)
    }

    /// A frame's thumbnail: at 0.8 of its size, around where it changed
    /// (else where anything is drawn), on its background, FilmThumb's size
    /// at the screen's scale.
    static func thumb(_ img: CGImage, around at: CGRect?, bg: NSColor, scale: CGFloat) -> CGImage? {
        let size = FilmThumb.size, k: CGFloat = 0.8
        guard let ctx = CGContext(data: nil, width: Int(size.width * scale), height: Int(size.height * scale), bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return nil }
        ctx.scaleBy(x: scale, y: scale)
        ctx.setFillColor(bg.cgColor)
        ctx.fill(CGRect(origin: .zero, size: size))
        let W = CGFloat(img.width) / scale, H = CGFloat(img.height) / scale
        let cw = size.width / k, ch = size.height / k
        var left: CGFloat = 0, top: CGFloat = 0
        if let at {
            let cx = at.midX * W, cy = at.midY * H
            left = max(0, min(W - cw, min(at.minX * W - 8, cx - cw / 2)))
            top = max(0, min(H - ch, cy - ch / 2))
        }
        // The picture's point (left, top) at the thumbnail's top left (this context's y goes up).
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(x: -left * k, y: size.height + top * k - H * k, width: W * k, height: H * k))
        return ctx.makeImage()
    }

    /// What went wrong, in words a person reads after "Could not ...: ".
    static func why(_ e: ConnectionError) -> String {
        switch e {
        case .connect, .handshake, .closed: return t("film.whyLost")
        case .timeout: return t("film.whySlow")
        case .daemon(let code, let message):
            if code == "not_found" || code == "pane_closed" { return t("film.whyClosed") }
            if message.contains("MiB") { return t("film.whyBig") }
            return t("film.whyDaemon")
        }
    }

    /// An older daemon fails a strip over 12 MiB instead of leaving
    /// pictures out (unpictured is newer).
    static func tooBig(_ e: ConnectionError) -> Bool {
        if case .daemon(let code, let message) = e, code == "failed", message.contains("MiB") { return true }
        return false
    }

    /// The daemon's RFC 3339 times, with milliseconds.
    static func date(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    static func hms(_ d: Date) -> String { let f = DateFormatter(); f.dateFormat = "HH:mm:ss"; return f.string(from: d) }
    static func ms(_ d: Date) -> String { let f = DateFormatter(); f.dateFormat = "mm:ss"; return f.string(from: d) }

    /// The theme as pane.shot takes it: the terminal's colours, as #RRGGBB.
    static func theme(_ th: Theme) -> [String: Any] {
        func hex(_ c: SIMD4<Float>) -> String { String(format: "#%02X%02X%02X", Int((c.x * 255).rounded()), Int((c.y * 255).rounded()), Int((c.z * 255).rounded())) }
        return ["foreground": hex(th.foreground), "background": hex(th.background), "cursor": hex(th.cursor), "palette": th.ansi.map(hex)]
    }
}

/// The sheet under the pane: the head (what it found, step, play, send,
/// save, close), the track, and the thumbnails.
final class FilmSheet: NSView {
    static let height: CGFloat = 236
    /// The pane it was opened on.
    private(set) var pane: String?
    /// The frames with a picture: the ones to step through and show.
    private(set) var frames: [FilmFrame] = []
    /// Every frame's time and marks, pictured or not: the track and the summary.
    private(set) var allMarks: [(at: Date, tag: String?, still: Double)] = []
    /// How many frames the daemon listed (frames.count of them pictured).
    private(set) var total = 0
    /// The frame shown over the pane, nil for live.
    private(set) var shown: Int?
    /// The moment picked on the track when the daemon kept no picture of it:
    /// the closest pictured frame is shown, and its line says so.
    private(set) var wanted: Date?
    private(set) var sel = 0
    private(set) var loading = false
    private(set) var error: String?
    private(set) var playing = false
    private var playTimer: Timer?
    private var from = Date(), to = Date()
    /// The size the frames were drawn at, in their pixels, and the screen's scale.
    private(set) var drawnAt: CGFloat = 26
    private(set) var scale: CGFloat = 2

    /// What the sheet needs of the window (Workspace sets them).
    var conn: (String) -> Connection? = { _ in nil }
    var look: () -> (theme: Theme, size: CGFloat, scale: CGFloat) = { (Theme.ravenry, 13, 2) }
    /// The agent to send it to ("Claude"), and how; nil when the pane runs no session.
    var sendTo: (String) -> (who: String, send: (@escaping (String?) -> Void) -> Void)? = { _ in nil }
    var paneName: (String) -> String = { $0 }
    /// What it has to say (sent, saved, a failure): in its head for a few seconds.
    private(set) var note: String?
    private var noteTimer: Timer?
    func say(_ s: String) {
        note = s
        paint()
        noteTimer?.invalidate()
        noteTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in self?.note = nil; self?.paint() }
    }
    /// Opened, closed, or a frame shown or not: the window lays out again.
    var changed: (() -> Void)?
    /// Where Save as GIF writes without asking (the self-test).
    var testSaveDir: URL?
    private(set) var lastSaved: URL?
    private(set) var lastSent: String?

    /// The controls by name, for the self-test.
    private(set) var controls: [String: NSView] = [:]
    private let summaryLabel = NSTextField(labelWithString: "")
    private let track = FilmTrack()
    private let thumbs = NSStackView()
    private let topLine = NSView()

    var isOpen: Bool { pane != nil }
    private var paintedWidth: CGFloat = 0

    /// Wider or narrower by a thumbnail: drawn again with as many as fit.
    override func setFrameSize(_ s: NSSize) {
        super.setFrameSize(s)
        if isOpen, abs(s.width - paintedWidth) >= 40 { paint() }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(t("film.title"))
        isHidden = true
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    override func draw(_ dirty: NSRect) {
        Design.sheet.setFill()
        bounds.fill()
        Design.sep.setFill()
        NSRect(x: 0, y: 0, width: bounds.width, height: 1).fill()
    }

    // MARK: opening

    func toggle(_ p: String) { if pane == p { close() } else { load(p) } }

    func close() {
        stop()
        pane = nil
        frames = []
        allMarks = []
        total = 0
        shown = nil
        isHidden = true
        changed?()
    }

    /// The pane on screen changed: the sheet belongs to the one it was opened on.
    func follow(_ p: String?) { if let q = pane, p != q { close() } }

    func load(_ p: String) {
        stop()
        pane = p
        loading = true
        error = nil
        shown = nil
        frames = []
        allMarks = []
        total = 0
        isHidden = false
        paint()
        changed?()
        guard let c = conn(p) else { loading = false; error = t("film.noDaemon"); paint(); return }
        let l = look()
        scale = max(1, min(3, l.scale))
        drawnAt = min(48, l.size * scale)
        // Every frame the daemon holds (about 200 in 20 s): their times are
        // all read; it pictures as many as fit its answer.
        let params: [String: Any] = ["pane": p, "last_ms": Film.lastMs, "format": "png", "max_frames": 600, "font_size": Double(drawnAt), "theme": Film.theme(l.theme)]
        fetch(c, p, params, sized: false)
    }

    /// Asks for the frames; an older daemon that fails a big strip is asked
    /// again for as many as one picture of the screen now says fit.
    private func fetch(_ c: Connection, _ p: String, _ params: [String: Any], sized: Bool) {
        let scale = self.scale
        c.request("pane.frames", params) { [weak self] r in
            if case .failure(let e) = r, Film.tooBig(e), !sized {
                var shot = params
                shot.removeValue(forKey: "last_ms"); shot.removeValue(forKey: "format"); shot.removeValue(forKey: "max_frames")
                c.request("pane.shot", shot) { [weak self] s in
                    let bytes = (try? s.get()["png"] as? String)?.count ?? 0
                    var again = params
                    // Its 12 MiB, with room for frames busier than the screen now.
                    again["max_frames"] = max(1, min(600, bytes > 0 ? Int(Double(9 << 20) / Double(bytes)) : 4))
                    DispatchQueue.main.async { guard let self, self.pane == p else { return }; self.fetch(c, p, again, sized: true) }
                }
                return
            }
            // The pictures are read off the main thread, then shown.
            var got: [FilmFrame] = []
            var all: [(at: Date, tag: String?, still: Double)] = []
            var why: String?
            switch r {
            case .failure(let e):
                why = Film.why(e)
                EventLog.shared.write("film pane.frames \(p) failed: \(e)")
            case .success(let v):
                let end = Date()
                var prev: (data: [UInt8], w: Int, h: Int)?
                var raw: [(at: Date, mark: Int, missing: Int?, img: CGImage?, box: CGRect?, change: CGRect?, bg: NSColor, thumb: CGImage?)] = []
                for f in v["frames"] as? [[String: Any]] ?? [] {
                    let at = Film.date(f["at"] as? String) ?? end
                    let mark = (f["mark"] as? NSNumber)?.intValue ?? 0
                    let missing = (f["missing_rows"] as? NSNumber)?.intValue
                    guard let b = f["png"] as? String, let data = Data(base64Encoded: b), let img = Film.image(data) else {
                        raw.append((at, mark, missing, nil, nil, nil, .black, nil))
                        continue
                    }
                    let lk = Film.look(img, prev: prev)
                    prev = (lk.data, img.width, img.height)
                    raw.append((at, mark, missing, img, lk.box, lk.change, lk.bg, Film.thumb(lk.drawn ?? img, around: lk.change ?? lk.box, bg: lk.bg, scale: scale)))
                }
                // A frame with no picture is not known to be blank.
                let marks = Film.analyse(raw.map { ($0.at.timeIntervalSince1970 * 1000, $0.img != nil && $0.box == nil, $0.missing) }, end: end.timeIntervalSince1970 * 1000)
                all = raw.enumerated().map { i, x in (x.at, marks[i].tag, marks[i].still / 1000) }
                for (i, x) in raw.enumerated() {
                    guard let img = x.img else { continue }
                    got.append(FilmFrame(at: x.at, image: img, thumb: x.thumb, mark: x.mark,
                                         tag: marks[i].tag, still: marks[i].still / 1000, box: x.box, change: x.change, bg: x.bg))
                }
                if got.isEmpty && !raw.isEmpty { why = t("film.whyBig") }
                DispatchQueue.main.async { [weak self] in self?.from = end.addingTimeInterval(-Double(Film.lastMs) / 1000); self?.to = end }
            }
            DispatchQueue.main.async {
                guard let self, self.pane == p else { return }
                self.loading = false
                self.error = why.map { t("film.failed", ["why": $0]) }
                self.frames = got
                self.allMarks = all
                self.total = all.count
                self.sel = max(0, got.firstIndex { $0.tag != nil } ?? got.count - 1)
                self.paint()
            }
        }
    }

    // MARK: stepping

    func showFrame(_ i: Int, wanted w: Date? = nil) {
        guard frames.indices.contains(i) else { return }
        sel = i
        shown = i
        wanted = w
        paint()
        changed?()
    }

    func live() { stop(); shown = nil; wanted = nil; paint(); changed?() }

    /// A press on the track at x (0 the left end, 20 s ago; 1 now): the
    /// frame closest to that moment, pictured or not; one without a
    /// picture shows the closest pictured frame instead.
    func pick(at x: CGFloat) {
        stop()
        guard !frames.isEmpty else { return }
        let t = trackTime(x)
        func gap(_ d: Date) -> Double { abs(d.timeIntervalSince(t)) }
        let at = allMarks.map(\.at).min { gap($0) < gap($1) } ?? t
        let near = frames.indices.min { abs(frames[$0].at.timeIntervalSince(at)) < abs(frames[$1].at.timeIntervalSince(at)) } ?? 0
        showFrame(near, wanted: abs(frames[near].at.timeIntervalSince(at)) < 0.0005 ? nil : at)
    }

    /// The moment at x on the track, and where a moment lies on it (0 to 1), for the self-test.
    func trackTime(_ x: CGFloat) -> Date { from.addingTimeInterval(Double(min(1, max(0, x))) * to.timeIntervalSince(from)) }
    func trackX(_ d: Date) -> CGFloat { CGFloat(min(1, max(0, d.timeIntervalSince(from) / max(0.001, to.timeIntervalSince(from))))) }

    /// The line under "Showing" when the frame picked had no picture: how far the one shown is from it.
    var nearestLine: String? {
        guard let w = wanted, let i = shown, frames.indices.contains(i) else { return nil }
        let d = frames[i].at.timeIntervalSince(w)
        let s = String(format: "%.1f", max(0.1, abs(d)))
        return t(d < 0 ? "film.nearestBefore" : "film.nearestAfter", ["s": s])
    }

    func step(_ d: Int) {
        stop()
        guard !frames.isEmpty else { return }
        showFrame(min(frames.count - 1, max(0, (shown ?? sel) + d)))
    }

    func play() {
        if playing { stop(); paint(); return }
        guard !frames.isEmpty else { return }
        var i = shown.map { $0 < frames.count - 1 ? $0 : 0 } ?? 0
        playing = true
        func next() {
            guard playing else { return }
            showFrame(i)
            guard i + 1 < frames.count else { playing = false; paint(); return }
            let gap = min(1.5, max(0.06, frames[i + 1].at.timeIntervalSince(frames[i].at)))
            i += 1
            playTimer = Timer.scheduledTimer(withTimeInterval: gap, repeats: false) { _ in next() }
        }
        next()
    }

    private func stop() {
        playTimer?.invalidate()
        playTimer = nil
        playing = false
    }

    // MARK: send and save

    func send() {
        guard let p = pane, let s = sendTo(p), !frames.isEmpty else { return }
        s.send { [weak self] err in
            DispatchQueue.main.async {
                if let e = err { self?.say(t("film.sendFailed", ["why": e])) } else { self?.lastSent = s.who; self?.say(t("film.sent", ["who": s.who])) }
            }
        }
    }

    func saveGif() {
        guard let p = pane, let c = conn(p) else { return }
        let stamp = Film.hms(to).replacingOccurrences(of: ":", with: "")
        let name = "\(paneName(p).replacingOccurrences(of: #"[^\w.-]+"#, with: "-", options: .regularExpression))-\(stamp).gif"
        c.request("pane.frames", ["pane": p, "last_ms": Film.lastMs, "format": "gif", "max_frames": 200]) { [weak self] r in
            DispatchQueue.main.async {
                guard let self else { return }
                guard case .success(let v) = r, let b = v["data"] as? String, let data = Data(base64Encoded: b) else {
                    if case .failure(let e) = r {
                        EventLog.shared.write("film gif \(p) failed: \(e)")
                        self.say(t("film.gifFailed", ["why": Film.why(e)]))
                    } else { self.say(t("film.gifFailed", ["why": t("film.noGif")])) }
                    return
                }
                if let dir = self.testSaveDir {
                    let u = dir.appendingPathComponent(name)
                    try? data.write(to: u)
                    self.lastSaved = u
                    self.say(t("film.saved", ["name": name]))
                    return
                }
                let panel = NSSavePanel()
                panel.nameFieldStringValue = name
                panel.allowedContentTypes = [.gif]
                panel.canCreateDirectories = true
                panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
                let done: (NSApplication.ModalResponse) -> Void = { res in
                    guard res == .OK, let u = panel.url else { return }
                    do { try data.write(to: u); self.lastSaved = u; self.say(t("film.saved", ["name": u.lastPathComponent])) } catch { self.say(t("film.gifFailed", ["why": error.localizedDescription])) }
                }
                if let w = self.window { panel.beginSheetModal(for: w, completionHandler: done) } else if !options.offscreen { done(panel.runModal()) }
            }
        }
    }

    // MARK: drawing

    private func button(_ key: String, _ title: String?, icon: String?, tip: String?, kind: RButton.Kind = .icon, _ run: @escaping () -> Void) -> RButton {
        let b = RButton(title ?? "", kind, small: true, icon: icon, run: run)
        b.toolTip = tip
        if let tip { b.setAccessibilityLabel(tip) }
        controls[key] = b
        return b
    }

    /// Draws the sheet again from what it holds.
    func paint() {
        controls = [:]
        subviews.forEach { $0.removeFromSuperview() }
        guard let p = pane else { return }
        let title = label(t("film.title"), Fonts.pt(13, Fonts.w650))
        let icon = Icon("film", "tx2", size: 14)
        let found = frames.isEmpty ? t("film.nothing") : Film.summary(allMarks.map { ($0.tag, $0.still * 1000) })
        summaryLabel.stringValue = note ?? (loading ? t("film.reading") : error ?? found)
        summaryLabel.font = Fonts.pt(12)
        summaryLabel.textColor = Design.color(error == nil && allMarks.contains { $0.tag != nil || $0.still > 0 } ? "you" : "tx3")
        summaryLabel.lineBreakMode = .byTruncatingTail
        summaryLabel.setContentCompressionResistancePriority(.init(100), for: .horizontal)
        let none = frames.isEmpty
        let retry = error != nil && !loading && note == nil
            ? button("retry", t("film.retry"), icon: nil, tip: nil, kind: .normal) { [weak self] in if let p = self?.pane { self?.load(p) } } : nil
        var row: [NSView?] = [icon, title, summaryLabel, retry, spring(),
                              button("prev", nil, icon: "left", tip: t("film.prev")) { [weak self] in self?.step(-1) },
                              button("play", nil, icon: playing ? "pause" : "play", tip: playing ? t("film.pause") : t("film.play")) { [weak self] in self?.play() },
                              button("next", nil, icon: "chevron", tip: t("film.next")) { [weak self] in self?.step(1) }]
        if let s = sendTo(p) {
            let b = button("send", t("film.send", ["who": s.who]), icon: nil, tip: nil, kind: .primary) { [weak self] in self?.send() }
            b.isEnabled = !none
            row.append(b)
        }
        let gif = button("gif", t("film.gif"), icon: nil, tip: nil, kind: .normal) { [weak self] in self?.saveGif() }
        gif.lead = "download"
        gif.isEnabled = !none
        row.append(gif)
        row.append(button("close", nil, icon: "close", tip: t("film.close")) { [weak self] in self?.close() })
        for v in row.compactMap({ $0 }) where v is RButton { v.setContentCompressionResistancePriority(.init(760), for: .horizontal); v.setContentHuggingPriority(.init(760), for: .horizontal) }
        let head = hstack(row, spacing: 8)
        // The track: the rail, the stalls, the marks, the knob; "20 s ago" and "now" under it.
        let span = max(0.001, to.timeIntervalSince(from))
        let pos = { (d: Date) -> CGFloat in CGFloat(min(1, max(0, d.timeIntervalSince(self.from) / span))) }
        track.stalls = allMarks.filter { $0.still > 0 }.map { (pos($0.at), CGFloat($0.still / span)) }
        track.bad = allMarks.filter { $0.tag != nil }.map { pos($0.at) }
        track.knob = frames.indices.contains(shown ?? sel) ? pos(frames[shown ?? sel].at) : nil
        track.needsDisplay = true
        track.onPick = { [weak self] x in self?.pick(at: x) }
        track.translatesAutoresizingMaskIntoConstraints = false
        if track.constraints.isEmpty { track.heightAnchor.constraint(equalToConstant: 12).isActive = true }
        controls["track"] = track
        // Under the track's middle: how many of the frames have a picture, when not all.
        let some: NSView? = !frames.isEmpty && frames.count < total ? label(t("film.some", ["n": "\(frames.count)", "all": "\(total)"]), Fonts.pt(11), "tx3") : nil
        some.map { controls["some"] = $0 }
        let gapL = spring(), gapR = spring()
        let ends = hstack([label(t("film.ago"), Fonts.pt(11), "tx3"), gapL, some, some == nil ? nil : gapR, label(t("film.now"), Fonts.pt(11), "tx3")], spacing: 0)
        if some != nil { gapL.widthAnchor.constraint(equalTo: gapR.widthAnchor).isActive = true }
        // The thumbnails.
        thumbs.arrangedSubviews.forEach { $0.removeFromSuperview() }
        thumbs.orientation = .horizontal
        thumbs.spacing = 8
        thumbs.alignment = .top
        let cur = shown ?? sel
        // As many as the width holds, at most six.
        let fit = max(1, min(6, Int((bounds.width - 24 + 8) / (FilmThumb.size.width + 8))))
        paintedWidth = bounds.width
        for i in Film.pick(frames.map { ($0.tag, $0.still * 1000) }, n: fit, sel: cur) {
            let f = frames[i]
            let th = FilmThumb(frame: f, scale: scale, on: shown == i)
            th.toolTip = t("film.showAt", ["time": Film.hms(f.at)])
            th.onPress = { [weak self] in self?.stop(); self?.showFrame(i) }
            controls["thumb:\(i)"] = th
            thumbs.addArrangedSubview(th)
        }
        let col = vstack([head, track, ends, thumbs], spacing: 6, insets: NSEdgeInsets(top: 10, left: 14, bottom: 10, right: 10))
        col.translatesAutoresizingMaskIntoConstraints = false
        addSubview(col)
        NSLayoutConstraint.activate([col.leadingAnchor.constraint(equalTo: leadingAnchor), col.trailingAnchor.constraint(equalTo: trailingAnchor), col.topAnchor.constraint(equalTo: topAnchor)])
        needsDisplay = true
    }

    /// The frame shown over the pane, at the live text's size (each of the
    /// frame's cells, Go Mono's 0.6 em at the size it was drawn, as wide as
    /// the terminal's), its 8 px margin taken off.
    func overlayImage(cellWidth live: CGFloat) -> (image: CGImage, size: NSSize, offset: CGFloat, bg: NSColor, at: Date, note: String?)? {
        guard let i = shown, frames.indices.contains(i) else { return nil }
        let f = frames[i]
        let cellPx = (0.6 * drawnAt).rounded()
        let k = live > 0 && cellPx > 0 ? live / (cellPx / scale) : 1
        return (f.image, NSSize(width: CGFloat(f.image.width) / scale * k, height: CGFloat(f.image.height) / scale * k), 8 / scale * k, f.bg, f.at, nearestLine)
    }
}

/// The track under the sheet's head: the rail, a stall as a band, a bad
/// frame as a red tick, the frame on screen as a knob.
final class FilmTrack: NSView {
    var stalls: [(CGFloat, CGFloat)] = []
    var bad: [CGFloat] = []
    var knob: CGFloat?
    /// A press or a drag along it: where, 0 (20 s ago) to 1 (now).
    var onPick: ((CGFloat) -> Void)?
    override var isFlipped: Bool { true }
    private func at(_ e: NSEvent) -> CGFloat { bounds.width > 0 ? convert(e.locationInWindow, from: nil).x / bounds.width : 0 }
    override func mouseDown(with e: NSEvent) { onPick?(at(e)) }
    override func mouseDragged(with e: NSEvent) { onPick?(at(e)) }
    override func resetCursorRects() { handCursor(onPick != nil) }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func draw(_ dirty: NSRect) {
        let w = bounds.width, mid = bounds.midY
        Design.sep.setFill()
        NSBezierPath(roundedRect: NSRect(x: 0, y: mid - 1.5, width: w, height: 3), xRadius: 1.5, yRadius: 1.5).fill()
        Design.color("you").withAlphaComponent(0.45).setFill()
        for (x, len) in stalls { NSBezierPath(roundedRect: NSRect(x: x * w, y: mid - 3, width: max(3, len * w), height: 6), xRadius: 3, yRadius: 3).fill() }
        Design.color("bad").setFill()
        for x in bad { NSRect(x: x * w - 1, y: 0, width: 2, height: bounds.height).fill() }
        if let k = knob {
            Design.work.setFill()
            NSBezierPath(ovalIn: NSRect(x: k * w - 5, y: mid - 5, width: 10, height: 10)).fill()
        }
    }
}

/// A thumbnail: its frame at 0.8 of its size, cropped around where it
/// changed (the first: where anything is drawn), its time and its mark under it.
final class FilmThumb: NSView {
    static let size = NSSize(width: 196, height: 104)
    var onPress: (() -> Void)?
    private let frameData: FilmFrame
    private let scale: CGFloat
    private let on: Bool
    init(frame f: FilmFrame, scale: CGFloat, on: Bool) {
        frameData = f
        self.scale = scale
        self.on = on
        super.init(frame: NSRect(origin: .zero, size: NSSize(width: FilmThumb.size.width, height: FilmThumb.size.height + 18)))
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: FilmThumb.size.width).isActive = true
        heightAnchor.constraint(equalToConstant: FilmThumb.size.height + 18).isActive = true
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(t("film.showAt", ["time": Film.hms(f.at)]))
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func mouseDown(with e: NSEvent) { onPress?() }
    override func resetCursorRects() { handCursor(onPress != nil) }
    /// As the buttons beside it: the first press counts in a window not yet in front.
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { onPress?(); return true }

    /// The words under it: "Half drawn", "Blank", "Same 3 s", or none.
    var tagWords: String? {
        frameData.tag == "blank" ? t("film.blank") : frameData.tag == "half" ? t("film.halfTag") : frameData.still > 0 ? t("film.same", ["s": "\(Int(frameData.still.rounded()))"]) : nil
    }

    override func draw(_ dirty: NSRect) {
        let box = NSRect(origin: .zero, size: FilmThumb.size)
        let clip = NSBezierPath(roundedRect: box, xRadius: 6, yRadius: 6)
        NSGraphicsContext.saveGraphicsState()
        clip.addClip()
        frameData.bg.setFill()
        box.fill()
        let f = frameData
        // Drawn once when the strip was read (Film.thumb), flipped into this flipped view.
        if let th = f.thumb, let ctx = NSGraphicsContext.current?.cgContext {
            ctx.saveGState()
            ctx.translateBy(x: 0, y: box.height)
            ctx.scaleBy(x: 1, y: -1)
            ctx.draw(th, in: CGRect(origin: .zero, size: box.size))
            ctx.restoreGState()
        }
        NSGraphicsContext.restoreGraphicsState()
        let ring = NSBezierPath(roundedRect: box.insetBy(dx: on ? 1 : 0.5, dy: on ? 1 : 0.5), xRadius: 6, yRadius: 6)
        ring.lineWidth = on ? 2 : 1
        (on ? Design.work : Design.sep).setStroke()
        ring.stroke()
        let time = NSAttributedString(string: Film.ms(f.at), attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular), .foregroundColor: Design.color("tx3")])
        time.draw(at: NSPoint(x: 2, y: box.maxY + 3))
        if let w = tagWords {
            let a = NSAttributedString(string: w, attributes: [.font: NSFont.systemFont(ofSize: 11, weight: .semibold), .foregroundColor: Design.color("you")])
            a.draw(at: NSPoint(x: 2 + time.size().width + 6, y: box.maxY + 3))
        }
    }
}

/// The frame shown in place of the pane (.frame-view) with the "Showing"
/// line over it (Back to live); the pane runs on underneath.
final class FilmFrameView: NSView {
    private var img: CGImage?
    private var drawSize = NSSize.zero
    private var offset: CGFloat = 0
    private var bg = NSColor.black
    /// Flipped: its lines laid from the top, the small one under "Showing".
    private let bar = Flipped()
    private let words = NSTextField(labelWithString: "")
    /// Under the words, when the frame picked had no picture: that this is the closest one.
    private let small = NSTextField(labelWithString: "")
    let back = RButton(t("film.back"), .normal, small: true)
    var onBack: (() -> Void)? { didSet { back.run = onBack } }
    /// The bar's height: one line, or two with the small one.
    var barHeight: CGFloat { small.stringValue.isEmpty ? 34 : 52 }
    /// The frame drawn, for the self-test.
    private(set) var image: CGImage?
    override var isFlipped: Bool { true }
    override init(frame: NSRect) {
        super.init(frame: frame)
        bar.wantsLayer = true
        addSubview(bar)
        words.font = Fonts.pt(12.5)
        words.lineBreakMode = .byTruncatingTail
        bar.addSubview(words)
        small.font = Fonts.pt(11.5)
        small.lineBreakMode = .byTruncatingTail
        bar.addSubview(small)
        bar.addSubview(back)
        autoresizingMask = [.width, .height]
    }
    required init?(coder: NSCoder) { fatalError() }
    override func hitTest(_ p: NSPoint) -> NSView? { let v = super.hitTest(p); return v === self ? self : v }

    func show(_ x: (image: CGImage, size: NSSize, offset: CGFloat, bg: NSColor, at: Date, note: String?)) {
        img = x.image; image = x.image; drawSize = x.size; offset = x.offset; bg = x.bg
        let ago = max(0, Int(Date().timeIntervalSince(x.at).rounded()))
        words.stringValue = t("film.showing", ["time": Film.hms(x.at), "s": "\(ago)"])
        small.stringValue = x.note ?? ""
        small.isHidden = x.note == nil
        needsLayout = true
        needsDisplay = true
    }
    /// What the line says, for the self-test.
    var line: String { words.stringValue }
    /// The small line under it ("" when none).
    var note: String { small.stringValue }

    override func layout() {
        super.layout()
        bar.frame = NSRect(x: 0, y: 0, width: bounds.width, height: barHeight)
        bar.layer?.backgroundColor = Design.color("card").cgColor
        let bw = back.fittingSize.width
        back.frame = NSRect(x: bounds.width - bw - 10, y: 5, width: bw, height: 24)
        words.frame = NSRect(x: 12, y: 9, width: max(0, bounds.width - bw - 34), height: 17)
        words.textColor = Design.tx
        small.frame = NSRect(x: 12, y: 29, width: max(0, bounds.width - 24), height: 16)
        small.textColor = Design.color("tx3")
    }

    /// How much smaller than the live text the frame is drawn so all of it
    /// shows under the bar: a frame drawn before the sheet took its room
    /// under the pane is taller than what is left, and its last rows (the
    /// spinner, the newest output: where frames differ) went under the sheet.
    var fit: CGFloat {
        let w = drawSize.width - 2 * offset, h = drawSize.height - 2 * offset
        guard w > 0, h > 0 else { return 1 }
        return max(0.05, min(1, bounds.width / w, (bounds.height - barHeight) / h))
    }
    /// Where the frame's picture lies in the view (its margin outside).
    var pictureRect: NSRect {
        let k = fit
        return NSRect(x: -offset * k, y: barHeight - offset * k, width: drawSize.width * k, height: drawSize.height * k)
    }

    override func draw(_ dirty: NSRect) {
        bg.setFill()
        bounds.fill()
        guard let img, let ctx = NSGraphicsContext.current?.cgContext else { return }
        let r = pictureRect
        ctx.saveGState()
        ctx.translateBy(x: r.minX, y: r.minY + r.height)
        ctx.scaleBy(x: 1, y: -1)
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(origin: .zero, size: r.size))
        ctx.restoreGState()
    }
}
