// A pick's videos (the pickvideo round, 2026-11-16): a variant that is a
// video, or a page that holds one, plays where its picture would show. The
// hub names the video each plays (`variants[n].video`: a video's own file, a
// page's video, server/picks.mjs); this app reads it once into a file of its
// own and plays it with AVFoundation.
//
// A video AVFoundation cannot open (the webm round, 2026-11-17: WebM VP8
// and VP9, as Playwright's recordings and ffmpeg's and browsers' exports
// are; VP9 in an MP4) plays in a web view that holds only its <video>, as
// WebKit plays it, with the same behaviour: first frame, muted loop,
// controls, pause, a ring on the paused frame with its second. A codec this
// Mac cannot decode at all (AV1 on an M1 or M2: the hub's `videoType` that
// WebKit says it cannot play, an error, or no frame in 8 s) shows a still
// that says "This video can't play here", never a blank or a spinner.
//
// The webm round's second part (2026-11-17, a VP9, a VP8 and an AV1 .webm
// on an M1 Max): the card reaches the window first as a daemon's own copy,
// with no `videoType`, so the AV1 was loaded instead of refused; its page,
// in a window off every screen, stalled (WebKit holds a hidden page's
// timers) until the 15 s give-up, and its late "cant" was taken as the next
// video's answer (the VP8's): B and C blank for 15 s, then both stills. Now
// each video's type is read from its own headers when the copy has none
// (VideoHeaders, as the hub reads it), each first-frame page answers with
// its own number and a late answer is dropped, and a page that stalls is
// given up after 8 s by the app itself. Each one said cannot play is
// written to app.log with why.
//
//   - small (the panel's card, side by side, the viewer's strip): its first
//     frame, with a play mark (`frame`);
//   - up close (the picker's viewer): it plays at once, muted and looping,
//     with its controls (play, pause, the scrub bar) at its fit
//     (`PickPlayer`). Circle a part stops it on the frame shown: the ring is
//     dragged on that frame, in fractions of it, and the answer's region
//     says its second (t).

import AppKit
import AVFoundation
import AVKit
import CryptoKit
import WebKit

/// The hub's URL of the video variant n of a pick plays, else nil: the hub's
/// `video` (a video's own file, a page's video), else, for a copy that has
/// none (a daemon's own, which reaches the window before the hub's), a
/// video's own URL from its type. Never the agent's path: the hub's kept
/// copy is the only source once the card is made.
func pickVideoPath(_ cp: [String: Any], _ n: Int) -> String? {
    let vs = cp["variants"] as? [[String: Any]] ?? []
    guard n >= 0, n < vs.count, let id = cp["id"] as? String else { return nil }
    let path: String? = (vs[n]["video"] as? String).flatMap { $0.hasPrefix("/api/") ? $0 : nil }
        ?? (vs[n]["type"] as? String == "video" ? "/api/checkpoints/\(id)/variants/\(n)" : nil)
    // Its type (the hub's, from the video's headers): a codec WebKit says it cannot play shows the still at once.
    if let path, let ty = vs[n]["videoType"] as? String { PickVideos.shared.types[path] = ty }
    return path
}

/// The still a video that cannot play here shows in its frame's place: the words on the dark ground,
/// big enough to read on a card's tile, at the video's shape when known.
func cantPlayStill(_ size: CGSize = .zero) -> NSImage {
    let h: CGFloat = 360
    let w = size.width > 0 && size.height > 0 ? max(h * 0.75, min(h * 2.4, h * size.width / size.height)) : h * 1.6
    return NSImage(size: NSSize(width: w, height: h), flipped: true) { r in
        NSColor(srgbRed: 0x1C / 255, green: 0x1C / 255, blue: 0x1E / 255, alpha: 1).setFill()
        r.fill()
        let para = NSMutableParagraphStyle()
        para.alignment = .center
        para.lineBreakMode = .byWordWrapping
        let a: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: h / 7.2, weight: .semibold), .foregroundColor: NSColor(white: 0.86, alpha: 1), .paragraphStyle: para]
        let words = t("pick.cantPlay") as NSString
        let box = NSRect(x: w * 0.1, y: 0, width: w * 0.8, height: h)
        let need = words.boundingRect(with: box.size, options: [.usesLineFragmentOrigin], attributes: a)
        words.draw(with: NSRect(x: box.minX, y: (h - need.height) / 2, width: box.width, height: need.height), options: [.usesLineFragmentOrigin], attributes: a)
        return true
    }
}

/// The round play mark in the middle of a video's first frame.
func drawPlayMark(in r: NSRect, size: CGFloat = 34) {
    let c = NSRect(x: r.midX - size / 2, y: r.midY - size / 2, width: size, height: size)
    NSColor(srgbRed: 20 / 255, green: 20 / 255, blue: 22 / 255, alpha: 0.72).setFill()
    NSBezierPath(ovalIn: c).fill()
    NSColor(white: 1, alpha: 0.2).setStroke()
    let edge = NSBezierPath(ovalIn: c.insetBy(dx: 0.5, dy: 0.5))
    edge.lineWidth = 1
    edge.stroke()
    let k = size / 34
    let tri = NSBezierPath()
    tri.move(to: NSPoint(x: c.midX - 5 * k, y: c.midY - 7.5 * k))
    tri.line(to: NSPoint(x: c.midX + 8 * k, y: c.midY))
    tri.line(to: NSPoint(x: c.midX - 5 * k, y: c.midY + 7.5 * k))
    tri.close()
    NSColor.white.setFill()
    tri.fill()
}

/// The pick's videos as files of this app's and their first frames, read once by their URL.
final class PickVideos {
    static let shared = PickVideos()
    private var files: [String: URL] = [:]
    private var fileWaits: [String: [(URL?) -> Void]] = [:]
    private var frames: [String: NSImage] = [:]
    private var frameWaits: [String: [(NSImage?) -> Void]] = [:]
    /// Every video URL read from the hub, in order (the self-test counts them).
    private(set) var reads: [String] = []
    /// How each video plays: AVFoundation when it opens it, else a web view.
    enum Engine { case av, web }
    private var engines: [String: Engine] = [:]
    /// The hub's type of each video (`variants[n].videoType`), by its URL.
    var types: [String: String] = [:]
    /// The videos this Mac cannot decode at all: they show the still that says so.
    private(set) var cantPlay: Set<String> = []
    func cant(_ path: String) -> Bool { cantPlay.contains(path) }
    func markCant(_ path: String) { cantPlay.insert(path) }
    func engineNow(_ path: String) -> Engine? { engines[path] }
    /// The type a player is asked about for the video at `path` (read into `file`): the hub's, else its headers'.
    func type(_ path: String, _ file: URL) -> String? {
        if let t = types[path] { return t }
        let t = VideoHeaders.type(file)
        if let t { types[path] = t }
        return t
    }
    /// A video said here to be one this Mac cannot play, in app.log once with why.
    func said(_ path: String, _ why: String) {
        guard !logged.contains(path) else { return }
        logged.insert(path)
        AppLog.write("pick video: \(path) (\(types[path] ?? "type unknown")) can't play here: \(why)")
    }
    private var logged: Set<String> = []
    /// How the video at `path` (read into `file`) plays, worked out once: AVFoundation when it can play it.
    func engine(_ path: String, _ file: URL, _ done: @escaping (Engine) -> Void) {
        if let e = engines[path] { done(e); return }
        Task {
            let ok = (try? await AVURLAsset(url: file).load(.isPlayable)) ?? false
            await MainActor.run { let e = self.engines[path] ?? (ok ? .av : .web); self.engines[path] = e; done(e) }
        }
    }
    private lazy var dir: URL = {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("ravenry-pick-videos", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        // A day's videos at most: older ones go (a pick's videos never change, so a new pick's are new files).
        let old = Date().addingTimeInterval(-86400)
        for f in (try? FileManager.default.contentsOfDirectory(at: d, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
            if let m = try? f.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate, m < old { try? FileManager.default.removeItem(at: f) }
        }
        return d
    }()

    static func ext(_ type: String?) -> String {
        switch (type ?? "").split(separator: ";").first.map({ $0.trimmingCharacters(in: .whitespaces).lowercased() }) ?? "" {
        case "video/webm": return "webm"
        case "video/quicktime": return "mov"
        case "video/x-m4v": return "m4v"
        default: return "mp4"
        }
    }

    /// The video at the hub's `path` as a file: at once when read before, else nil and `done` on the main thread.
    @discardableResult func file(_ hub: HubClient?, _ path: String, _ done: @escaping (URL?) -> Void) -> URL? {
        if let f = files[path], FileManager.default.fileExists(atPath: f.path) { return f }
        if fileWaits[path] != nil { fileWaits[path]?.append(done); return nil }
        guard let hub else { done(nil); return nil }
        fileWaits[path] = [done]
        reads.append(path)
        hub.file(path) { [weak self] d, type in
            guard let self else { return }
            var url: URL?
            if let d, !d.isEmpty {
                let name = SHA256.hash(data: Data((hub.base?.absoluteString ?? "") .utf8) + Data(path.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
                let f = self.dir.appendingPathComponent("\(name).\(Self.ext(type))")
                if (try? d.write(to: f, options: .atomic)) != nil { url = f; self.files[path] = f }
            }
            for w in self.fileWaits.removeValue(forKey: path) ?? [] { w(url) }
        }
        return nil
    }

    /// The video's first frame: at once when made before, else nil and `done` on the main thread.
    @discardableResult func frame(_ hub: HubClient?, _ path: String, _ done: @escaping (NSImage?) -> Void) -> NSImage? {
        if let i = frames[path] { return i }
        if frameWaits[path] != nil { frameWaits[path]?.append(done); return nil }
        frameWaits[path] = [done]
        let finish = { [weak self] (img: NSImage?) in
            guard let self else { return }
            if let img { self.frames[path] = img }
            for w in self.frameWaits.removeValue(forKey: path) ?? [] { w(img) }
        }
        let web = { (f: URL) in
            WebFrames.shared.grab(f, type: self.type(path, f)) { img, size, why in
                if let why { self.cantPlay.insert(path); self.said(path, why); finish(cantPlayStill(size)) } else { finish(img) }
            }
        }
        let make = { (f: URL?) in
            guard let f else { finish(nil); return }
            self.engine(path, f) { e in
                guard e == .av else { web(f); return }
                let g = AVAssetImageGenerator(asset: AVURLAsset(url: f))
                g.appliesPreferredTrackTransform = true
                g.requestedTimeToleranceBefore = .zero
                g.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 10)
                g.generateCGImageAsynchronously(for: .zero) { cg, _, _ in
                    let img = cg.map { NSImage(cgImage: $0, size: NSSize(width: $0.width, height: $0.height)) }
                    DispatchQueue.main.async { if let img { finish(img) } else { self.cantPlay.insert(path); self.said(path, "AVFoundation drew no first frame"); finish(cantPlayStill()) } }
                }
            }
        }
        if let f = file(hub, path, make) { make(f) }
        return nil
    }
}

/// The page a web view plays a video in: its <video> only, filling the
/// view at its fit, muted and looping, its controls; it tells the app its
/// time, whether it plays and its size (`rv` messages), and says when this
/// engine cannot play it (`cant`: the hub's type it cannot play, an error,
/// or no frame in 8 s).
private func playerPage(_ name: String, type: String?, frame: Bool, gen: Int) -> String {
    let js = { (s: String?) -> String in
        guard let s, let d = try? JSONSerialization.data(withJSONObject: [s]), let a = String(data: d, encoding: .utf8) else { return "null" }
        return String(a.dropFirst().dropLast())
    }
    return """
    <!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#0B0B0C;overflow:hidden}video{width:100%;height:100%;object-fit:contain;display:block}</style></head>
    <body><video id="v" muted playsinline preload="auto" \(frame ? "" : "loop autoplay controls")></video><script>
    const v = document.getElementById('v'), T = \(js(type)), FRAME = \(frame ? "true" : "false"), G = \(gen);
    const say = (o) => window.webkit.messageHandlers.rv.postMessage({ ...o, g: G });
    let over = false;
    const cant = (r) => { if (over) return; over = true; const w = v.videoWidth, h = v.videoHeight; v.removeAttribute('src'); v.load(); say({ k: 'cant', r, w, h }); };
    const post = (k) => { if (!over) say({ k, t: v.currentTime, paused: v.paused, w: v.videoWidth, h: v.videoHeight, rs: v.readyState }); };
    if (T && v.canPlayType(T) === '') cant('WebKit cannot play ' + T);
    else {
      v.addEventListener('error', () => cant('the video said error ' + (v.error ? v.error.code : '?')));
      setTimeout(() => { if (v.readyState < 2) cant('no frame in 8 s'); }, 8000);
      if (FRAME) {
        // The first frame, drawn once at the video's size.
        v.addEventListener('loadeddata', () => { v.currentTime = 0.001; }, { once: true });
        v.addEventListener('seeked', () => { if (over) return; over = true; const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0); say({ k: 'frame', png: c.toDataURL('image/png'), w: v.videoWidth, h: v.videoHeight }); }, { once: true });
      } else {
        for (const e of ['loadedmetadata', 'loadeddata', 'play', 'playing', 'pause', 'seeking', 'seeked', 'waiting', 'timeupdate']) v.addEventListener(e, () => post(e));
        (function tick() { if (!v.paused) post('tick'); setTimeout(tick, 50); })();
      }
      v.src = \(js(name));
    }
    window.rv = { play() { v.play().catch(() => {}); post('play'); }, pause() { v.pause(); post('pause'); }, seek(t) { v.currentTime = t; }, controls(on) { v.controls = on; } };
    </script></body></html>
    """
}

/// Writes a video's page beside its file and loads it, the folder readable (its video only).
private func loadPlayerPage(_ w: WKWebView, _ file: URL, type: String?, frame: Bool, gen: Int = 0) {
    let page = file.deletingPathExtension().appendingPathExtension(frame ? "frame.html" : "html")
    try? playerPage(file.lastPathComponent, type: type, frame: frame, gen: gen).write(to: page, atomically: true, encoding: .utf8)
    w.loadFileURL(page, allowingReadAccessTo: file.deletingLastPathComponent())
}

private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var to: AnyObject?
    let on: ([String: Any]) -> Void
    init(_ on: @escaping ([String: Any]) -> Void) { self.on = on }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { if let b = m.body as? [String: Any] { on(b) } }
}

private func videoWebView(_ on: @escaping ([String: Any]) -> Void) -> WKWebView {
    let cfg = WKWebViewConfiguration()
    cfg.mediaTypesRequiringUserActionForPlayback = []
    cfg.websiteDataStore = .nonPersistent()
    cfg.userContentController.add(WeakHandler(on), name: "rv")
    let w = WKWebView(frame: .zero, configuration: cfg)
    w.setValue(false, forKey: "drawsBackground")
    return w
}

/// The first frames of the videos AVFoundation cannot open, drawn one after
/// another by a web view in a window off every screen (WebKit loads a
/// video only in a view in a window).
final class WebFrames {
    static let shared = WebFrames()
    private var queue: [(URL, String?, (NSImage?, CGSize, String?) -> Void)] = []
    private var busy = false
    private var web: WKWebView?
    private var host: NSWindow?
    private var done: ((NSImage?, CGSize, String?) -> Void)?
    /// The number of the page asked now: its answers say it, and a late answer of a page given up is dropped.
    private var gen = 0
    /// How long a page is given before the app gives it up itself (a hidden page's own timers may not run).
    static var giveUp: TimeInterval = 8

    /// The first frame of the video in `file` (nil, its size and why: this Mac cannot play it), on the main thread.
    func grab(_ file: URL, type: String?, _ out: @escaping (NSImage?, CGSize, String?) -> Void) {
        queue.append((file, type, out))
        next()
    }

    private func next() {
        guard !busy, !queue.isEmpty else { return }
        busy = true
        let (file, type, out) = queue.removeFirst()
        if web == nil {
            let w = videoWebView { [weak self] m in self?.got(m) }
            w.frame = NSRect(x: 0, y: 0, width: 320, height: 200)
            let win = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 320, height: 200), styleMask: [.borderless], backing: .buffered, defer: false)
            win.isReleasedWhenClosed = false
            win.isExcludedFromWindowsMenu = true
            win.ignoresMouseEvents = true
            win.collectionBehavior = [.transient, .ignoresCycle, .stationary]
            win.contentView = w
            web = w
            host = win
        }
        host?.orderFrontRegardless()
        var settled = false
        done = { [weak self] img, size, why in
            guard let self, !settled else { return }
            settled = true
            self.done = nil
            self.gen += 1
            out(img, size, why)
            self.web?.loadHTMLString("", baseURL: nil)
            self.busy = false
            if self.queue.isEmpty { self.host?.orderOut(nil) }
            self.next()
        }
        // A page that never answers (no web content process, its timers held while hidden): given up by the app.
        gen += 1
        let mine = gen
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.giveUp) { [weak self] in if let self, self.gen == mine { self.done?(nil, .zero, "no first frame in \(Int(Self.giveUp)) s") } }
        loadPlayerPage(web!, file, type: type, frame: true, gen: mine)
    }

    private func got(_ m: [String: Any]) {
        // Only the page asked now: one given up may still answer as it goes (that answer is not the next video's).
        guard (m["g"] as? NSNumber)?.intValue == gen else { return }
        let size = CGSize(width: (m["w"] as? NSNumber)?.doubleValue ?? 0, height: (m["h"] as? NSNumber)?.doubleValue ?? 0)
        switch m["k"] as? String {
        case "frame":
            let img = (m["png"] as? String).flatMap { $0.split(separator: ",", maxSplits: 1).last }.flatMap { Data(base64Encoded: String($0)) }.flatMap { NSImage(data: $0) }
            img?.size = size
            done?(img, size, img == nil ? "its first frame could not be read" : nil)
        case "cant": done?(nil, size, m["r"] as? String ?? "the page said so")
        default: break
        }
    }
}

/// A video up close: AVKit's player with its inline controls (a video
/// AVFoundation opens), else a web view that holds only its <video>; the
/// video at its fit, and the ring over the video's own rect (in fractions of
/// its frame). `still`: stopped on a frame with no controls (circling, or a
/// ring drawn on that frame). A video this Mac cannot play shows the still
/// that says so.
final class PickPlayer: NSView {
    let playerView = AVPlayerView()
    let ring = PickRing()
    private(set) var player: AVPlayer?
    /// The web view a video AVFoundation cannot open plays in (made when one first shows).
    private(set) var web: WKWebView?
    /// The still in a video's place when this Mac cannot play it: the words, at the viewer's size.
    let cantView = NSView()
    private let cantWords = NSTextField(wrappingLabelWithString: "")
    /// How the video shown plays (nil: not known yet).
    private(set) var engine: PickVideos.Engine?
    /// The hub's URL of the video shown.
    private(set) var url = ""
    /// The video's own size (its first track's, turned as it plays), once known.
    private(set) var natural: CGSize = .zero
    /// Each video shown is a new one (the self-test checks the one left goes): its number, and the ones let go.
    private(set) var shown = 0
    private(set) var letGo: [Int] = []
    /// What the web view's <video> said last: its time, whether it plays, when.
    private var webT = 0.0, webPaused = true, webReady = false, webAt = Date()
    private var pendingSeek: Double?
    /// The <video> said it plays with frames to show (playing, or a tick with enough data): its time goes on between messages.
    private var webLive = false
    private var looping: NSObjectProtocol?
    var onLayout: (() -> Void)?
    var still = false { didSet { if still != oldValue { apply() } } }
    override var isFlipped: Bool { true }

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.masksToBounds = true
        layer?.backgroundColor = NSColor(srgbRed: 0x0B / 255, green: 0x0B / 255, blue: 0x0C / 255, alpha: 1).cgColor
        playerView.controlsStyle = .inline
        playerView.showsFullScreenToggleButton = false
        playerView.showsSharingServiceButton = false
        playerView.videoGravity = .resizeAspect
        cantView.wantsLayer = true
        cantView.layer?.backgroundColor = NSColor(srgbRed: 0x1C / 255, green: 0x1C / 255, blue: 0x1E / 255, alpha: 1).cgColor
        cantWords.font = NSFont.systemFont(ofSize: 17, weight: .semibold)
        cantWords.textColor = NSColor(white: 0.86, alpha: 1)
        cantWords.alignment = .center
        cantView.addSubview(cantWords)
        cantView.isHidden = true
        addSubview(playerView)
        addSubview(cantView)
        addSubview(ring)
        setAccessibilityElement(false)
    }
    required init?(coder: NSCoder) { fatalError() }

    /// A video plays only while it is seen. The pick answered or closed, another view in the
    /// middle, the window gone: the view (or one it is in) is hidden, and the video stops and
    /// is let go, whoever hid it. Its picker shows it again when the pick comes back.
    override func viewDidHide() {
        super.viewDidHide()
        stop()
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { stop() }
    }
    private var seen: Bool { window != nil && !isHiddenOrHasHiddenAncestor }

    /// Shows the video at `path` from its file (nil: not read yet); the same one goes on as it is.
    func show(_ path: String, file: URL?) {
        if path == url, player != nil || web?.isHidden == false || !cantView.isHidden { return }
        stop()
        // Not seen (a picker drawn while hidden, a file read after it closed): none starts.
        guard seen else { return }
        url = path
        shown += 1
        natural = .zero
        guard let file else { needsLayout = true; return }
        if PickVideos.shared.cant(path) { showCant(path); return }
        if let e = PickVideos.shared.engineNow(path) { start(e, path, file); return }
        let n = shown
        PickVideos.shared.engine(path, file) { [weak self] e in
            guard let self, self.shown == n, self.url == path else { return }
            self.start(e, path, file)
        }
    }

    private func start(_ e: PickVideos.Engine, _ path: String, _ file: URL) {
        engine = e
        if e == .web { showWeb(path, file); return }
        playerView.isHidden = false
        let asset = AVURLAsset(url: file)
        let item = AVPlayerItem(asset: asset)
        let p = AVPlayer(playerItem: item)
        p.isMuted = true
        p.actionAtItemEnd = .none
        // Loops: back to its start at its end, playing on.
        looping = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak p] _ in p?.seek(to: .zero); p?.play() }
        player = p
        playerView.player = p
        Task { [weak self] in
            guard let t = try? await asset.loadTracks(withMediaType: .video).first, let s = try? await t.load(.naturalSize), let tf = try? await t.load(.preferredTransform) else { return }
            let r = CGRect(origin: .zero, size: s).applying(tf)
            await MainActor.run { guard let self, self.url == path else { return }; self.sized(CGSize(width: abs(r.width), height: abs(r.height))) }
        }
        apply()
        needsLayout = true
    }

    private func sized(_ s: CGSize) {
        guard s.width > 0, s.height > 0, s != natural else { return }
        natural = s
        needsLayout = true
        layoutSubtreeIfNeeded()
        onLayout?()
    }

    private func showWeb(_ path: String, _ file: URL) {
        playerView.isHidden = true
        if web == nil {
            let w = videoWebView { [weak self] m in self?.heard(m) }
            addSubview(w, positioned: .below, relativeTo: cantView)
            web = w
        }
        webT = 0; webPaused = still; webReady = false; webAt = Date(); pendingSeek = nil
        web?.isHidden = false
        loadPlayerPage(web!, file, type: PickVideos.shared.type(path, file), frame: false, gen: shown)
        apply()
        needsLayout = true
    }

    private func showCant(_ path: String) {
        playerView.isHidden = true
        web?.isHidden = true
        cantWords.stringValue = t("pick.cantPlay")
        cantView.setAccessibilityElement(true)
        cantView.setAccessibilityLabel(cantWords.stringValue)
        cantView.isHidden = false
        needsLayout = true
        onLayout?()
    }

    /// What the web view's <video> says.
    private func heard(_ m: [String: Any]) {
        // Only the page of the video shown now (one left may still say it stopped as it goes).
        guard engine == .web, web?.isHidden == false, (m["g"] as? NSNumber)?.intValue == shown else { return }
        let w = (m["w"] as? NSNumber)?.doubleValue ?? 0, h = (m["h"] as? NSNumber)?.doubleValue ?? 0
        if m["k"] as? String == "cant" {
            PickVideos.shared.markCant(url)
            PickVideos.shared.said(url, m["r"] as? String ?? "the page said so")
            if w > 0, h > 0 { natural = CGSize(width: w, height: h) }
            showCant(url)
            return
        }
        if let t = (m["t"] as? NSNumber)?.doubleValue, t.isFinite { webT = max(0, t); webAt = Date() }
        if let p = m["paused"] as? Bool { webPaused = p }
        let k = m["k"] as? String ?? ""
        let rs = (m["rs"] as? NSNumber)?.intValue ?? 0
        webLive = !webPaused && (k == "playing" || ((k == "tick" || k == "timeupdate") && rs >= 3))
        if let rs = (m["rs"] as? NSNumber)?.intValue, rs >= 2, !webReady {
            // Its first frame: stopped on the ring's frame when it shows one, as the person left it.
            webReady = true
            if still { webPaused = true; web?.evaluateJavaScript("rv.controls(false); rv.pause()") } else { web?.evaluateJavaScript("rv.play()") }
            if let t = pendingSeek { pendingSeek = nil; seek(t) }
        }
        if w > 0, h > 0 { sized(CGSize(width: w, height: h)) }
    }

    /// Stops and lets the video go (another variant, the viewer closed).
    func stop() {
        player?.pause()
        if let l = looping { NotificationCenter.default.removeObserver(l) }
        looping = nil
        playerView.player = nil
        player = nil
        if let w = web, !w.isHidden {
            w.evaluateJavaScript("window.rv && rv.pause()")
            w.loadHTMLString("", baseURL: nil)
            w.isHidden = true
        }
        cantView.isHidden = true
        if !url.isEmpty { letGo.append(shown) }
        engine = nil
        webPaused = true; webReady = false; webLive = false
        url = ""
    }

    func pause() {
        player?.pause()
        if engine == .web { webT = time; webPaused = true; webLive = false; web?.evaluateJavaScript("rv.pause()") }
    }
    /// The second shown now.
    var time: Double {
        // The web view's <video> says its time as it plays (every 0.05 s, less often in a window not seen) and when
        // it stops; between, while it is known to play, its time goes on with the clock.
        if engine == .web { return webLive && !webPaused ? webT + min(1.5, Date().timeIntervalSince(webAt)) : webT }
        let t = player?.currentTime().seconds ?? 0
        return t.isFinite ? max(0, t) : 0
    }
    var playing: Bool { engine == .web ? !webPaused : (player?.rate ?? 0) != 0 }
    /// Ready to play (its first frame decoded), muted, its controls showing: as the person sees it.
    var ready: Bool { engine == .web ? webReady : player?.currentItem?.status == .readyToPlay }
    var muted: Bool { engine == .web ? true : player?.isMuted == true }
    var controlsShown: Bool { engine == .web ? !still : playerView.controlsStyle == .inline }
    /// The video shown cannot play on this Mac: the still says so.
    var cantPlay: Bool { !cantView.isHidden }
    func seek(_ t: Double) {
        player?.seek(to: CMTime(seconds: t, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        if engine == .web { webT = t; webAt = Date(); webLive = false; if webReady { web?.evaluateJavaScript("rv.seek(\(t))") } else { pendingSeek = t } }
    }
    func togglePlay() {
        guard !still else { return }
        if let p = player { if p.rate != 0 { p.pause() } else { p.play() }; return }
        guard engine == .web else { return }
        if webPaused { webPaused = false; webAt = Date(); web?.evaluateJavaScript("rv.play()") } else { pause() }
    }

    private func apply() {
        playerView.controlsStyle = still ? .none : .inline
        if still { player?.pause() } else { player?.play() }
        if engine == .web {
            if still { webT = time; webPaused = true; webLive = false }
            web?.evaluateJavaScript("window.rv && (rv.controls(\(!still)), \(still ? "rv.pause()" : "rv.play()"))")
        }
    }

    /// Where the video is drawn: the whole of it, as big as fits, in the middle.
    var videoRect: NSRect {
        guard natural.width > 0, natural.height > 0, bounds.width > 0, bounds.height > 0 else { return bounds }
        let k = min(bounds.width / natural.width, bounds.height / natural.height)
        let w = natural.width * k, h = natural.height * k
        return NSRect(x: (bounds.width - w) / 2, y: (bounds.height - h) / 2, width: w, height: h)
    }

    override func layout() {
        super.layout()
        playerView.frame = bounds
        web?.frame = bounds
        cantView.frame = videoRect
        let ws = cantWords.sizeThatFits(NSSize(width: max(40, cantView.bounds.width - 40), height: .greatestFiniteMagnitude))
        cantWords.frame = NSRect(x: (cantView.bounds.width - ws.width) / 2, y: (cantView.bounds.height - ws.height) / 2, width: ws.width, height: ws.height)
        ring.frame = videoRect
    }
}

/// The type a player is asked about (`canPlayType`) for the video in a file, from its own headers, as the
/// hub's `videoType` is (hub/server/videocodec.mjs): a WebM's first video CodecID, an MP4's first video
/// sample entry. Nil when neither says (a player is then asked to play it and tells).
enum VideoHeaders {
    static func type(_ file: URL) -> String? {
        guard let h = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? h.close() }
        guard let d = try? h.read(upToCount: 4 << 20), d.count >= 8 else { return nil }
        let b = [UInt8](d)
        let (codec, container): (String, String)
        if b[0] == 0x1A, b[1] == 0x45, b[2] == 0xDF, b[3] == 0xA3 { (codec, container) = (ebml(b), "webm") }
        else if ["ftyp", "moov", "mdat", "wide", "free", "skip"].contains(String(decoding: b[4..<8], as: UTF8.self)) { (codec, container) = (iso(b), "mp4") }
        else { return nil }
        let codecs: [String: [String: String]] = [
            "webm": ["vp8": "vp8", "vp9": "vp9", "av1": "av01.0.05M.08", "h264": "avc1.42E01E", "hevc": "hvc1.1.6.L93.B0"],
            "mp4": ["h264": "avc1.42E01E", "hevc": "hvc1.1.6.L93.B0", "av1": "av01.0.05M.08", "vp9": "vp09.00.10.08", "vp8": "vp8"],
        ]
        return codecs[container]?[codec].map { "video/\(container); codecs=\"\($0)\"" }
    }

    /// The first video CodecID element (0x86) of a Matroska file.
    private static func ebml(_ b: [UInt8]) -> String {
        var i = 0
        while i + 2 < b.count {
            defer { i += 1 }
            guard b[i] == 0x86, b[i + 1] & 0x80 != 0 else { continue }
            let n = Int(b[i + 1] & 0x7F)
            guard n >= 3, i + 2 + n <= b.count, b[i + 2] == 0x56, b[i + 3] == 0x5F else { continue }
            let id = String(decoding: b[(i + 2)..<(i + 2 + n)], as: UTF8.self)
            switch id {
            case "V_VP8": return "vp8"
            case "V_VP9": return "vp9"
            case "V_AV1": return "av1"
            default:
                if id.hasPrefix("V_MPEG4/ISO/AVC") { return "h264" }
                if id.hasPrefix("V_MPEGH/ISO/HEVC") { return "hevc" }
                return String(id.dropFirst(2)).lowercased()
            }
        }
        return ""
    }

    private struct Box { let type: String; let start: Int; let end: Int }
    private static func boxes(_ b: [UInt8], _ from: Int, _ to: Int) -> [Box] {
        var out: [Box] = [], at = from
        let u32 = { (o: Int) in Int(b[o]) << 24 | Int(b[o + 1]) << 16 | Int(b[o + 2]) << 8 | Int(b[o + 3]) }
        while to - at >= 8 {
            var size = u32(at), head = 8
            let type = String(decoding: b[(at + 4)..<(at + 8)], as: UTF8.self)
            if size == 0 { size = to - at } else if size == 1 {
                guard to - at >= 16 else { break }
                size = (0..<8).reduce(0) { $0 << 8 | Int(b[at + 8 + $1]) }
                head = 16
            }
            guard size >= head, at + size <= to else { break }
            out.append(Box(type: type, start: at + head, end: at + size))
            at += size
        }
        return out
    }
    private static func child(_ b: [UInt8], _ x: Box?, _ want: String) -> Box? {
        guard let x else { return nil }
        return boxes(b, x.start, x.end).first { $0.type == want }
    }

    /// The sample entry of the first track whose handler is video.
    private static func iso(_ b: [UInt8]) -> String {
        let entry = ["avc1": "h264", "avc3": "h264", "hvc1": "hevc", "hev1": "hevc", "dvh1": "hevc", "dvhe": "hevc", "av01": "av1", "vp09": "vp9", "vp08": "vp8"]
        guard let moov = boxes(b, 0, b.count).first(where: { $0.type == "moov" }) else { return "" }
        for trak in boxes(b, moov.start, moov.end) where trak.type == "trak" {
            let mdia = child(b, trak, "mdia")
            guard let hdlr = child(b, mdia, "hdlr"), hdlr.end - hdlr.start >= 12,
                  String(decoding: b[(hdlr.start + 8)..<(hdlr.start + 12)], as: UTF8.self) == "vide" else { continue }
            guard let stsd = child(b, child(b, child(b, mdia, "minf"), "stbl"), "stsd"), stsd.end - stsd.start >= 16 else { continue }
            let e = String(decoding: b[(stsd.start + 12)..<(stsd.start + 16)], as: UTF8.self)
            return entry[e] ?? e.trimmingCharacters(in: .whitespaces)
        }
        return ""
    }
}
