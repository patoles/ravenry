// A pick's videos (the pickvideo round, 2026-11-16): a variant that is a
// video, or a page that holds one, plays where its picture would show. The
// hub names the video each plays (`variants[n].video`: a video's own file, a
// page's video, server/picks.mjs); this app reads it once into a file of its
// own and plays it with AVFoundation, never a web view.
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
        let make = { (f: URL?) in
            guard let f else { finish(nil); return }
            let g = AVAssetImageGenerator(asset: AVURLAsset(url: f))
            g.appliesPreferredTrackTransform = true
            g.requestedTimeToleranceBefore = .zero
            g.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 10)
            g.generateCGImageAsynchronously(for: .zero) { cg, _, _ in
                let img = cg.map { NSImage(cgImage: $0, size: NSSize(width: $0.width, height: $0.height)) }
                DispatchQueue.main.async { finish(img) }
            }
        }
        if let f = file(hub, path, make) { make(f) }
        return nil
    }
}

/// A video up close: AVKit's player with its inline controls, the video at
/// its fit, and the ring over the video's own rect (in fractions of its
/// frame). `still`: stopped on a frame with no controls (circling, or a ring
/// drawn on that frame).
final class PickPlayer: NSView {
    let playerView = AVPlayerView()
    let ring = PickRing()
    private(set) var player: AVPlayer?
    /// The hub's URL of the video shown.
    private(set) var url = ""
    /// The video's own size (its first track's, turned as it plays), once known.
    private(set) var natural: CGSize = .zero
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
        addSubview(playerView)
        addSubview(ring)
        setAccessibilityElement(false)
    }
    required init?(coder: NSCoder) { fatalError() }

    /// Shows the video at `path` from its file (nil: not read yet); the same one goes on as it is.
    func show(_ path: String, file: URL?) {
        if path == url, player != nil { return }
        stop()
        url = path
        natural = .zero
        guard let file else { needsLayout = true; return }
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
            await MainActor.run { guard let self, self.url == path else { return }; self.natural = CGSize(width: abs(r.width), height: abs(r.height)); self.needsLayout = true; self.layoutSubtreeIfNeeded(); self.onLayout?() }
        }
        apply()
        needsLayout = true
    }

    /// Stops and lets the video go (another variant, the viewer closed).
    func stop() {
        player?.pause()
        if let l = looping { NotificationCenter.default.removeObserver(l) }
        looping = nil
        playerView.player = nil
        player = nil
        url = ""
    }

    func pause() { player?.pause() }
    /// The second shown now.
    var time: Double { let t = player?.currentTime().seconds ?? 0; return t.isFinite ? max(0, t) : 0 }
    var playing: Bool { (player?.rate ?? 0) != 0 }
    func seek(_ t: Double) { player?.seek(to: CMTime(seconds: t, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) }
    func togglePlay() { guard let p = player, !still else { return }; if p.rate != 0 { p.pause() } else { p.play() } }

    private func apply() {
        playerView.controlsStyle = still ? .none : .inline
        if still { player?.pause() } else { player?.play() }
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
        ring.frame = videoRect
    }
}
