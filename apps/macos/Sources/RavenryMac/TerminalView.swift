// The terminal view: draws a pane's render stream with Metal and sends
// the person's keys, mouse and pastes to the daemon, which encodes them
// for the program (docs/RENDERING.md). It keeps no terminal state of its
// own beyond the rows it was sent.

import AppKit
import Metal
import QuartzCore

final class TerminalView: NSView, NSTextInputClient {
    let screen = Screen()
    let renderer: Renderer
    private let metalLayer = CAMetalLayer()
    private(set) var conn: Connection?
    private(set) var pane = ""
    private(set) var fps = 60
    /// The render stream's channel while the view is live, else 0. Set
    /// on the reader thread when pane.render answers, before the
    /// stream's first frame.
    var channel: UInt32 {
        chLock.lock()
        defer { chLock.unlock() }
        return liveChannel
    }
    private let chLock = NSLock()
    private var liveChannel: UInt32 = 0
    private var wantsStream = false
    /// On screen: the pane's render stream is open and the view draws.
    /// Off screen (a tab not in front), no stream and no draws: the rows
    /// it had stay, and are drawn at once when it shows again, the
    /// pane's own following from a new stream.
    private(set) var live = false
    /// Where the view was scrolled when it went behind (rows up from the
    /// bottom, and the history then): a tab switch keeps each pane's
    /// place (TERM-007). The new stream starts at the live screen, so its
    /// first frame asks render.scroll for the same rows, counting the
    /// rows printed meanwhile, and live frames are acked but not drawn
    /// until the scrolled one comes (at most half a second).
    private var keptView: (offset: Int, history: Int)?
    /// What an agent or the hub typed, marked in the right gutter (TERM-044, InputMarks.swift).
    let marks = InputMarks()
    /// The next frame with the cursor on screen is the stream's snapshot for the marks.
    private var marksDue = false
    /// The marks the last draw drew: the row on screen, who, when (the label on hover).
    private(set) var drawnMarks: [(row: Int, rec: [String: Any], who: String, cls: String)] = []
    private var restoreAsk: (offset: Int, history: Int)?
    private var restoring: (target: Int, until: CFTimeInterval)?
    /// A split's divider is being dragged: draw in the window's
    /// transaction, as during a live resize.
    var splitDragging = false {
        didSet { if !splitDragging && oldValue { metalLayer.presentsWithTransaction = false; requestDraw() } }
    }
    private var resizing: Bool { (((window as? TerminalWindow)?.liveResizing ?? inLiveResize) || splitDragging) && !offscreen }
    /// The view took the keyboard (a click, or the window's focus).
    var onFocus: (() -> Void)?

    private var grid = (cols: 0, rows: 0)
    /// The size the daemon's frames last said (reader thread), and the one
    /// this view last asked back (main thread): see reclaimSize.
    private var frameSize = (cols: 0, rows: 0)
    private var reclaimed: (cols: Int, rows: Int)?
    /// When this view last asked for a size of its own: the daemon may draw
    /// at the old size a moment longer (a program's redraw), not a size to take back.
    private var askedAt: CFTimeInterval = 0
    private var drawPending = false
    private let drawLock = NSLock()
    private var ackedSeq: UInt32 = 0
    private var lastBell: UInt32?
    /// When the bell last rang: the view flashes for 150 ms.
    private var bellAt: CFTimeInterval = -10
    static let bellFlash: CFTimeInterval = 0.15
    private var lastTitle = ""
    private(set) var cursorOn = true
    private var blinkTimer: Timer?
    private(set) var focused = false
    /// The cursor blinks offscreen too (the self-test; never the bench).
    var blinkOffscreen = false
    var cursorBlinking: Bool { blinkTimer != nil }

    /// A selection gesture is under way (the button went down with no
    /// mouse reporting, or with Shift).
    private var selecting = false
    private var autoscroll: Timer?
    private var lastDrag: NSEvent?

    /// The link under the pointer while Cmd is held: its URI and its
    /// cells in screen coordinates (render.link), underlined.
    private(set) var link: (uri: String, range: CellRange)?
    private var linkAsked: (x: Int, y: Int)?
    private var commandDown = false
    private var pointer: NSPoint?
    /// The pointing hand shows over the link.
    private(set) var linkCursor = false
    /// The pointer is over a session link (SessionLinks.swift): the pointing hand too.
    private(set) var nameHover = false

    private var marked = NSMutableAttributedString()
    private var keyTexts: [String]?
    /// Where Copy writes and Paste reads: the general pasteboard, or the
    /// self-test's own.
    var pasteboard = NSPasteboard.general
    /// Opens a link the person Cmd-clicked (the self-test records it).
    var openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }
    /// "left", "right", "both": Option acts as Alt. Empty: it types
    /// characters, as on a Mac.
    var optionAsAlt = ""

    /// The bench draws into its own texture (a window off every screen
    /// may get no drawables), and hears about each draw.
    var offscreen = false
    private var offscreenTexture: MTLTexture?
    var onDraw: ((_ seq: UInt32, _ cpuMs: Double) -> Void)?
    /// How many times it drew (the install check's report).
    private(set) var drawCount = 0
    /// The pixel size of the last draw, and how long it waited for its
    /// drawable (the bench reads them).
    private(set) var drawnPixels = CGSize.zero
    private(set) var lastWaitMs = 0.0
    /// The bench's record of each drawable's presented handler: ms from
    /// its present to the handler, and whether it was shown (a time) or
    /// dropped (none).
    var presents: [(ms: Double, shown: Bool)]?
    /// Drawables taken and not shown yet (the stall log and the bench).
    var outstanding: Int { unshown }
    var onTitle: ((String) -> Void)?
    var onFrame: (() -> Void)?

    /// What the settings make of the terminal (TermLook.swift).
    private(set) var look = TermLook()
    /// The bells that rang a sound or bounced the Dock (offscreen: only
    /// recorded, the self-test reads them).
    private(set) var bellsHeard: [String] = []

    init?(frame: NSRect, scale: CGFloat, fontName: String = "Menlo", fontSize: CGFloat = 12) {
        guard let r = Renderer(scale: scale, fontName: fontName, fontSize: fontSize) else { return nil }
        renderer = r
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .never
        metalLayer.device = r.device
        metalLayer.pixelFormat = .bgra8Unorm
        metalLayer.framebufferOnly = false
        metalLayer.isOpaque = true
        metalLayer.displaySyncEnabled = true
        metalLayer.maximumDrawableCount = 3
        metalLayer.contentsScale = scale
        metalLayer.allowsNextDrawableTimeout = true
        let bg = r.theme.background
        metalLayer.backgroundColor = CGColor(red: CGFloat(bg.x), green: CGFloat(bg.y), blue: CGFloat(bg.z), alpha: 1)
        // Never stretch the last frame to a new size: it is drawn again,
        // at the new size, in the same transaction.
        metalLayer.contentsGravity = .topLeft
        metalLayer.needsDisplayOnBoundsChange = false
        registerForDraggedTypes([.fileURL, .string])
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self, userInfo: nil))
        // The words that are session links changed: drawn again.
        NotificationCenter.default.addObserver(self, selector: #selector(sessionLinksChanged), name: SessionLinks.changed, object: nil)
    }

    @objc private func sessionLinksChanged() { requestDraw() }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func makeBackingLayer() -> CALayer { metalLayer }

    override var acceptsFirstResponder: Bool { true }
    override var isOpaque: Bool { true }
    override var isFlipped: Bool { true }

    // MARK: the stream

    /// The pane this view draws; resume() opens its stream.
    func attach(_ c: Connection, pane id: String, fps: Int) {
        conn = c
        pane = id
        self.fps = fps
    }

    /// Shows the pane: the rows it had are drawn at once, at this size,
    /// and its render stream opens at this view's grid (pane.render
    /// resizes the pane first), its frames following. wait: until the
    /// daemon answered.
    func resume(wait: Bool = false) {
        guard let c = conn, !live else { return }
        live = true
        grid = renderer.grid(for: bounds.size)
        askedAt = CACurrentMediaTime()
        reclaimed = nil
        appliedSize = bounds.size
        if metalLayer.drawableSize != pixelSize { metalLayer.drawableSize = pixelSize }
        screen.lock()
        // The new stream's frames count from 1: no ack of the old one's.
        screen.seq = 0
        screen.unlock()
        ackedSeq = 0
        if bounds.width > 0 && bounds.height > 0 { draw(sync: !offscreen && window != nil) }
        let sent = grid
        chLock.lock()
        wantsStream = true
        restoreAsk = keptView
        restoring = nil
        chLock.unlock()
        keptView = nil
        marks.reset()
        marksDue = true
        c.request("pane.inputs", ["pane": pane, "limit": 50]) { [weak self] r in
            guard case .success(let j) = r, let recs = j["inputs"] as? [[String: Any]] else { return }
            DispatchQueue.main.async { self?.marks.show(recs); self?.requestDraw() }
        }
        let sem = wait ? DispatchSemaphore(value: 0) : nil
        var params: [String: Any] = ["pane": pane, "cols": sent.cols, "rows": sent.rows, "fps": fps, "window": 2]
        // Cmd+Left to the line's start and the rest of a Mac's keys
        // (docs/RENDERING.md, Key bindings): the daemon's table, when the
        // daemon has them (an older one refuses the field).
        if TerminalView.keybinds { params["keybinds"] = "macos" }
        func open(_ params: [String: Any]) {
            c.request("pane.render", params) { [weak self, weak c] r in
                if case .failure(.daemon(_, let msg)) = r, msg.contains("keybinds"), params["keybinds"] != nil {
                    TerminalView.keybinds = false
                    var p = params
                    p.removeValue(forKey: "keybinds")
                    open(p)
                    return
                }
                self?.opened(r, c, sent)
                sem?.signal()
            }
        }
        open(params)
        if let sem { _ = sem.wait(timeout: .now() + 10) }
    }

    /// Whether the daemon takes pane.render's keybinds.
    static var keybinds = true

    /// pane.render answered (reader thread).
    private func opened(_ r: Result<[String: Any], ConnectionError>, _ c: Connection?, _ sent: (cols: Int, rows: Int)) {
        do {
            if case .failure(let e) = r {
                chLock.lock()
                let wanted = wantsStream && liveChannel == 0
                chLock.unlock()
                if wanted { DispatchQueue.main.async { [weak self] in self?.onRenderFailed?(e) } }
                return
            }
            guard let c, case .success(let res) = r, let ch = (res["channel"] as? NSNumber)?.uint32Value else { return }
            self.chLock.lock()
            if self.wantsStream && self.liveChannel == 0 {
                self.liveChannel = ch
                c.route(ch) { [weak self] p in self?.binary(p) }
                self.chLock.unlock()
                // A size that changed while the daemon answered.
                DispatchQueue.main.async {
                    if self.live && self.grid != sent { c.request("pane.resize", ["pane": self.pane, "cols": self.grid.cols, "rows": self.grid.rows]) }
                }
            } else {
                // Hidden again before the answer.
                self.chLock.unlock()
                c.request("pane.unsubscribe", ["channel": ch])
            }
        }
    }

    /// Hides the pane: its stream ends and the view stops drawing; the
    /// rows stay for the next resume.
    func pause() {
        guard live else { return }
        live = false
        screen.lock()
        keptView = screen.offset > 0 ? (screen.offset, screen.history) : nil
        screen.unlock()
        chLock.lock()
        wantsStream = false
        restoreAsk = nil
        restoring = nil
        let ch = liveChannel
        liveChannel = 0
        chLock.unlock()
        if ch != 0, let c = conn {
            c.route(ch, nil)
            c.request("pane.unsubscribe", ["channel": ch])
        }
        stopAutoscroll()
        blinkTimer?.invalidate()
        blinkTimer = nil
        cursorOn = true
        // A tab not in front keeps no drawables: the layer's are let go
        // (a smallest size), and made again at its size when it shows.
        owed = false
        step = nil
        if !offscreen { metalLayer.drawableSize = CGSize(width: 1, height: 1) }
    }

    private func binary(_ p: UnsafeRawBufferPointer) {
        // The frame header (PROTOCOL.md section 5): version, kind,
        // channel, mark; then the render frame.
        guard p.count >= 14, p[1] == 4 else { return }
        let ch = UInt32(p[2]) << 24 | UInt32(p[3]) << 16 | UInt32(p[4]) << 8 | UInt32(p[5])
        guard ch != 0, ch == channel else { return }
        // The output position the frame shows (0 from a daemon before 0.1.36).
        let frameMark = (6..<14).reduce(UInt64(0)) { $0 << 8 | UInt64(p[$1]) }
        screen.lock()
        do {
            try screen.apply(UnsafeRawBufferPointer(rebasing: p[14...]))
        } catch {
            NSLog("RavenryMac: bad frame: \(error)")
        }
        let view = (screen.offset, screen.history)
        let seq = screen.seq
        let cur = screen.cursor
        let fs = (cols: screen.cols, rows: screen.rows)
        let point: InputMarks.Point? = cur.inView ? InputMarks.Point(mark: frameMark, row: screen.history - screen.offset + cur.y, x: cur.x) : nil
        screen.unlock()
        if fs != frameSize {
            frameSize = fs
            DispatchQueue.main.async { [weak self] in self?.reclaimSize(fs) }
        }
        if let point {
            DispatchQueue.main.async { [weak self] in
                guard let self, self.live else { return }
                self.marks.written(point, snapshot: self.marksDue)
                self.marksDue = false
            }
        }
        if EventLog.shared.enabled && CACurrentMediaTime() - lastWheelAt < 2 && view != loggedView {
            loggedView = view
            EventLog.shared.write("frame offset \(view.0) history \(view.1)")
        }
        if restoreFrame(offset: view.0, history: view.1, channel: ch) {
            // A live frame before the scrolled one: acked, not drawn, so
            // the tab shows its kept rows until its place comes back.
            DispatchQueue.main.async { [weak self] in
                guard let self, self.live, seq != self.ackedSeq, self.channel == ch else { return }
                self.ackedSeq = seq
                self.conn?.sendJSON(["v": 1, "type": "ack", "channel": ch, "frame": seq])
            }
            return
        }
        onFrame?()
        scheduleDraw()
    }

    /// Asked for the kept place and its frame not come yet (at most half a
    /// second): nothing is drawn, whatever asks (an answer, the cursor's
    /// blink), so the live rows the stream sent first never show.
    private var holdingForPlace: Bool {
        chLock.lock()
        defer { chLock.unlock() }
        return restoring.map { CACurrentMediaTime() <= $0.until } ?? false
    }

    /// The first frame of a stream asks for the place the view was kept
    /// at (reader thread); true while a frame is not the one asked for.
    private func restoreFrame(offset: Int, history: Int, channel ch: UInt32) -> Bool {
        chLock.lock()
        defer { chLock.unlock() }
        let now = CACurrentMediaTime()
        if let k = restoreAsk {
            restoreAsk = nil
            let target = min(history, k.offset + max(0, history - k.history))
            if target > 0 && offset != target {
                restoring = (target, now + 0.5)
                conn?.request("render.scroll", ["channel": ch, "offset": target])
            }
        }
        guard let r = restoring else { return false }
        // Rows printed since keep the view where it is (offset grows).
        if offset >= r.target || now > r.until {
            restoring = nil
            return false
        }
        return true
    }

    /// A frame came (reader thread): draw it on the main thread.
    private func scheduleDraw() {
        drawLock.lock()
        let already = drawPending
        drawPending = true
        drawLock.unlock()
        if already { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.drawLock.lock()
            self.drawPending = false
            self.drawLock.unlock()
            self.requestDraw()
        }
    }

    /// The display's refresh interval: at most one draw in each.
    var refreshInterval: CFTimeInterval = 1.0 / 120
    private var lastDraw: CFTimeInterval = 0
    private var drawScheduled = false

    /// Draws now when no draw happened in this refresh interval, so a
    /// keystroke's echo goes out at once; otherwise at the next one, so
    /// draws never outrun the display (and never wait on a drawable).
    ///
    /// During a live resize a frame draws as soon as it comes, as in 0.1.28.
    /// 0.1.29 made frames wait for the next step (2cbd07b): resizebench got
    /// faster offscreen, but on a real screen every resize blanked the
    /// terminal (the maintainer, 2026-11-11 12:03), so that was taken out.
    func requestDraw() {
        if drawScheduled || !live { return }
        let now = CACurrentMediaTime()
        let due = lastDraw + refreshInterval * 0.9
        if now >= due {
            draw(sync: resizing)
            return
        }
        drawScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + (due - now)) { [weak self] in
            guard let self else { return }
            self.drawScheduled = false
            self.draw(sync: self.resizing)
        }
    }

    // MARK: drawing

    private var pixelSize: CGSize {
        let s = renderer.fonts.scale
        return CGSize(width: max(1, round(bounds.width * s)), height: max(1, round(bounds.height * s)))
    }

    /// Draws the screen now. sync: present in the window's own
    /// transaction (a live resize), so the content never lags its frame.
    func draw(sync: Bool) {
        guard live, bounds.width > 0, bounds.height > 0, !holdingForPlace, let cb = renderer.queue.makeCommandBuffer() else { return }
        var overlay = Overlay(focused: focused, cursorOn: cursorOn, marked: marked.string, scrollbar: scrollbarAlpha, link: link?.range,
                              flash: bellFlashing)
        if findBarVisible && !findNeedle.isEmpty && !findMarks.rows.isEmpty {
            overlay.findMarks = findMarks.rows
        }
        drawnMarks = placeMarks()
        overlay.marks = drawnMarks.map { ($0.row, InputMarks.color($0.cls)) }
        let t0 = CACurrentMediaTime()
        var seq: UInt32 = 0
        if offscreen {
            let size = pixelSize
            if offscreenTexture == nil || offscreenTexture!.width != Int(size.width) || offscreenTexture!.height != Int(size.height) {
                let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: Int(size.width), height: Int(size.height), mipmapped: false)
                d.usage = [.renderTarget, .shaderRead]
                d.storageMode = .shared
                offscreenTexture = renderer.device.makeTexture(descriptor: d)
            }
            seq = renderer.encode(screen: screen, overlay: overlay, into: offscreenTexture!, commandBuffer: cb)
            cb.commit()
        } else {
            // The layer has three drawables: one on screen and two that
            // may wait in the window's uncommitted transaction (a live
            // resize's draws are shown when it commits, at the end of this
            // turn of the run loop). A third draw in the same transaction
            // would wait in nextDrawable for one only the commit frees (its
            // 1 s timeout, the window frozen): it is put off and done right
            // after the commit. Never held back by the drawables' presented
            // handlers: on a screen they come 4 to 30 ms after the present
            // and now and then never, which held a live resize's draws off
            // for up to a second (0.1.24); the prototype took a drawable at
            // every step, and so does this.
            if inTransaction >= metalLayer.maximumDrawableCount - 1 {
                owed = true
                DrawWatch.shared.skipped(self)
                return
            }
            metalLayer.presentsWithTransaction = sync
            let next = metalLayer.nextDrawable()
            lastWaitMs = (CACurrentMediaTime() - t0) * 1000
            if lastWaitMs > DrawWatch.waitLimitMs { DrawWatch.shared.waited(self, ms: lastWaitMs, got: next != nil) }
            guard let drawable = next else { return }
            unshown += 1
            let presentAt = CACurrentMediaTime()
            drawable.addPresentedHandler { [weak self] d in
                let at = CACurrentMediaTime(), shownAt = d.presentedTime
                DispatchQueue.main.async {
                    self?.presents?.append(((at - presentAt) * 1000, shownAt > 0))
                    self?.shown()
                }
            }
            seq = renderer.encode(screen: screen, overlay: overlay, into: drawable.texture, commandBuffer: cb)
            if sync {
                // Apple's order for presentsWithTransaction: commit, wait
                // until scheduled, then present on the main thread.
                cb.commit()
                cb.waitUntilScheduled()
                drawable.present()
                inTransaction += 1
                if inTransaction == 1 { afterCommit() }
            } else {
                cb.present(drawable)
                cb.commit()
            }
        }
        lastDraw = CACurrentMediaTime()
        drawnPixels = offscreen ? pixelSize : metalLayer.drawableSize
        owed = false
        if let st = step, drawnPixels == st.px {
            step = nil
            let ms = (lastDraw - st.at) * 1000
            if ms > refreshInterval * 1000 * 1.5 { DrawWatch.shared.late(self, ms: ms) }
        }
        let cpu = (lastDraw - t0) * 1000
        afterDraw(seq)
        drawCount += 1
        onDraw?(seq, cpu)
    }

    /// Drawables taken and not shown yet (their presented handlers have
    /// not run; only said in the stall log), those presented in the
    /// window's transaction not committed yet, and a draw put off until it is.
    private var unshown = 0
    private(set) var inTransaction = 0
    private var owed = false
    /// The live resize's step not drawn yet: its pixel size, and when.
    private var step: (px: CGSize, at: CFTimeInterval)?

    /// A drawable was shown.
    private func shown() { unshown = max(0, unshown - 1) }

    /// Once the transaction the draws were presented in is committed, its
    /// drawables go to the screen and an owed draw is done.
    private func afterCommit() {
        CommitWatch.shared.after { [weak self] in
            guard let self else { return }
            self.inTransaction = 0
            // In a turn of its own, so the draw has a transaction of its own.
            if self.owed { DispatchQueue.main.async { [weak self] in guard let self, self.owed else { return }; self.owed = false; self.requestDraw() } }
        }
    }

    private func afterDraw(_ seq: UInt32) {
        let ch = channel
        if seq != ackedSeq, seq != 0, ch != 0, let c = conn {
            ackedSeq = seq
            c.sendJSON(["v": 1, "type": "ack", "channel": ch, "frame": seq])
        }
        screen.lock()
        let title = screen.title, bell = screen.bell, blink = screen.cursor.blink, blockCursor = screen.cursor.style == 0
        let offset = screen.offset, history = screen.history, find = screen.find, rowsVersion = screen.rowsVersion
        screen.unlock()
        if find != lastFind {
            lastFind = find
            findFromFrames(find)
        }
        if offset != lastOffset {
            // The view scrolled (the wheel, a find, typing brought it back).
            lastOffset = offset
            if history > 0 { showScrollbar() }
        }
        if title != lastTitle {
            lastTitle = title
            onTitle?(title)
        }
        // The bell: a flash over the view (the count the first frame
        // brings is the pane's past, not a ring).
        if let last = lastBell, bell > last { rang() }
        lastBell = bell
        if rowsVersion != a11yVersion {
            a11yVersion = rowsVersion
            announceValue()
        }
        // The settings' blink while the program leaves the cursor a block.
        updateBlink(blink || (blockCursor && look.blink))
    }

    /// The settings, now and on each change: the font and its size (the
    /// grid follows), the theme, the cursor, Option, copy on select, links,
    /// the bell.
    func apply(_ l: TermLook) {
        let was = look
        look = l
        optionAsAlt = l.optionAsAlt
        renderer.defaultCursor = l.cursor
        renderer.effect = l.effect
        if l.theme != was.theme || renderer.theme != l.theme {
            renderer.theme = l.theme
            let bg = l.theme.background
            metalLayer.backgroundColor = CGColor(red: CGFloat(bg.x), green: CGFloat(bg.y), blue: CGFloat(bg.z), alpha: 1)
        }
        if l.oneClickLinks != was.oneClickLinks && !linkLive { clearLink() }
        if l.font != renderer.askedFont || l.size != renderer.fontSize {
            renderer.setFont(name: l.font, size: l.size)
            updateMinSize()
            sizeChanged()
        }
        screen.lock()
        let blink = screen.cursor.blink, block = screen.cursor.style == 0
        screen.unlock()
        updateBlink(blink || (block && l.blink))
        requestDraw()
    }

    /// A bell in this pane: the flash, the sound and the Dock as the
    /// settings say (the Electron app's).
    private func rang() {
        if look.bell == "off" { return }
        if look.bell == "visual" {
            bellAt = CACurrentMediaTime()
            requestDraw()
            DispatchQueue.main.asyncAfter(deadline: .now() + TerminalView.bellFlash + 0.01) { [weak self] in self?.requestDraw() }
        }
        TerminalView.ring(look, offscreen: offscreen) { self.bellsHeard.append($0) }
    }

    /// The sound and the Dock's bounce of a bell (a pane on screen or
    /// not); off every screen they are only recorded.
    static func ring(_ l: TermLook, offscreen: Bool, record: (String) -> Void) {
        guard l.bell != "off" else { return }
        let bounce = l.bounce && !NSApp.isActive
        if offscreen {
            if l.bell == "sound" { record("sound") }
            if l.bounce { record("bounce") }
            return
        }
        if l.bell == "sound" { NSSound.beep() }
        if bounce { NSApp.requestUserAttention(.informationalRequest) }
    }

    /// What the last offscreen draw made (the bench's pictures).
    func snapshotImage() -> CGImage? {
        guard let t = offscreenTexture else { return nil }
        renderer.queue.makeCommandBuffer().map { $0.commit(); $0.waitUntilCompleted() }
        let w = t.width, h = t.height
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        t.getBytes(&bytes, bytesPerRow: w * 4, from: MTLRegionMake2D(0, 0, w, h), mipmapLevel: 0)
        let cs = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(data: &bytes, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return nil }
        return ctx.makeImage()
    }

    private func updateBlink(_ blink: Bool) {
        if blink && focused && (!offscreen || blinkOffscreen) {
            if blinkTimer == nil {
                blinkTimer = Timer.scheduledTimer(withTimeInterval: 0.6, repeats: true) { [weak self] _ in
                    guard let self else { return }
                    self.cursorOn.toggle()
                    self.requestDraw()
                }
            }
        } else if let t = blinkTimer {
            t.invalidate()
            blinkTimer = nil
            cursorOn = true
        }
    }

    /// The cursor shows at once after a key.
    private func wakeCursor() {
        cursorOn = true
        blinkTimer?.fireDate = Date().addingTimeInterval(0.6)
    }

    // MARK: size

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        let s = window?.backingScaleFactor ?? 2
        metalLayer.contentsScale = s
        renderer.setScale(s)
        sizeChanged()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        // AppKit sets the frame again at the same size (its layout pass
        // after the one that sized the view, in the same step of a live
        // resize): nothing changed, nothing is drawn again. A second draw
        // would take a second drawable in the same transaction.
        if newSize == appliedSize && (!live || metalLayer.drawableSize == pixelSize) { return }
        sizeChanged()
    }

    /// The size the view last laid itself out at.
    private var appliedSize = NSSize.zero

    private func sizeChanged() {
        appliedSize = bounds.size
        // A tab not in front gets its drawables when it shows (resume).
        if live && metalLayer.drawableSize != pixelSize { metalLayer.drawableSize = pixelSize }
        placeFindBar()
        let g = renderer.grid(for: bounds.size)
        if g != grid {
            grid = g
            askedAt = CACurrentMediaTime()
            // A hidden pane is resized when it shows (resume).
            if let c = conn, !pane.isEmpty, live, channel != 0 {
                c.request("pane.resize", ["pane": pane, "cols": g.cols, "rows": g.rows])
            }
        }
        // Draw what we have at the new size now, in the window's
        // transaction during a live resize; the reflowed rows follow.
        guard conn != nil, live else { return }
        if resizing {
            let at = CACurrentMediaTime()
            if let st = step, at - st.at > refreshInterval * 1.5 { DrawWatch.shared.missed(self, ms: (at - st.at) * 1000) }
            step = (pixelSize, at)
            draw(sync: true)
        } else { requestDraw() }
    }

    override func viewDidEndLiveResize() {
        super.viewDidEndLiveResize()
        metalLayer.presentsWithTransaction = false
        if let st = step, CACurrentMediaTime() - st.at > refreshInterval * 1.5 { DrawWatch.shared.missed(self, ms: (CACurrentMediaTime() - st.at) * 1000) }
        step = nil
        requestDraw()
    }

    var gridSize: (cols: Int, rows: Int) { grid }

    /// The pane is drawn at a size this view did not ask for (another
    /// window resized it, or a phone app before 0.1.42 did, which left the
    /// Mac's session at a phone's size: the maintainer's playtest, 2026-11-12): the
    /// view asks for its own size back, once for each size it sees. A size
    /// the pane keeps for a test (pane.override) stays, as the daemon keeps
    /// it; the view does not ask again for the same size.
    private func reclaimSize(_ fs: (cols: Int, rows: Int)) {
        guard live, channel != 0, !resizing, let c = conn, !pane.isEmpty, grid.cols > 0, grid.rows > 0, fs.cols > 0 else { return }
        if fs == grid { reclaimed = nil; return }
        if let r = reclaimed, r == fs { return }
        let wait = 1.0 - (CACurrentMediaTime() - askedAt)
        if wait > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
                guard let self else { return }
                self.screen.lock()
                let now = (cols: self.screen.cols, rows: self.screen.rows)
                self.screen.unlock()
                self.reclaimSize(now)
            }
            return
        }
        reclaimed = fs
        c.request("pane.resize", ["pane": pane, "cols": grid.cols, "rows": grid.rows])
    }

    // MARK: font size

    @objc func increaseFontSize(_ sender: Any?) { setFontSize(renderer.fontSize + 1) }
    @objc func decreaseFontSize(_ sender: Any?) { setFontSize(renderer.fontSize - 1) }
    @objc func resetFontSize(_ sender: Any?) { setFontSize(TerminalView.baseFontSize) }

    /// The settings' default size and range (shared/settings/settings.json fontSize).
    static var baseFontSize: CGFloat { CGFloat(SettingsStore.keys["fontSize"]?["default"] as? Int ?? 13) }
    static var fontSizeRange: ClosedRange<CGFloat> {
        let r = SettingsStore.range("fontSize")
        return r.max > r.min ? CGFloat(r.min)...CGFloat(r.max) : 8...32
    }

    /// A new size in the settings' range: written to the settings file
    /// (onFontSize), which every pane follows, as the Electron app's
    /// Cmd+= and Cmd+-.
    func setFontSize(_ size: CGFloat) {
        let r = TerminalView.fontSizeRange
        let s = min(r.upperBound, max(r.lowerBound, size.rounded()))
        guard s != renderer.fontSize else { return }
        if let f = onFontSize { f(s) } else { var l = look; l.size = s; apply(l) }
    }

    /// Writes a new text size to the settings.
    var onFontSize: ((CGFloat) -> Void)?

    /// The window's smallest content size when the window lays out more
    /// than this view (tabs, splits).
    var windowMinSize: (() -> NSSize)?

    /// The smallest grid the window may be dragged to, as Rex has one.
    static let minGrid = (cols: 40, rows: 10)

    /// The window's smallest content size: minGrid at the current font.
    var minContentSize: NSSize {
        let s = renderer.fonts.scale
        return NSSize(width: ceil(CGFloat(TerminalView.minGrid.cols) * renderer.fonts.cellWidth / s + 2 * renderer.padding + Renderer.gutter),
                      height: ceil(CGFloat(TerminalView.minGrid.rows) * renderer.fonts.cellHeight / s + 2 * renderer.padding))
    }

    /// Sets the window's smallest content size for the font, and grows a
    /// window that is now smaller than that.
    func updateMinSize() {
        guard let w = window else { return }
        let m = windowMinSize?() ?? minContentSize
        w.contentMinSize = m
        let c = w.contentRect(forFrameRect: w.frame).size
        if c.width < m.width || c.height < m.height {
            var f = w.frame
            let dw = max(0, m.width - c.width), dh = max(0, m.height - c.height)
            f.size.width += dw
            f.size.height += dh
            f.origin.y -= dh
            w.setFrame(f, display: true)
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        updateMinSize()
    }

    // MARK: focus

    override func becomeFirstResponder() -> Bool {
        setFocus(true)
        onFocus?()
        return true
    }

    override func resignFirstResponder() -> Bool {
        setFocus(false)
        return true
    }

    func setFocus(_ f: Bool) {
        guard f != focused else { return }
        focused = f
        cursorOn = true
        sendEvents([["focus": f]])
        requestDraw()
    }

    // MARK: input

    func sendEvents(_ events: [[String: Any]]) {
        guard let c = conn, channel != 0 else { return }
        c.request("render.input", ["channel": channel, "events": events])
    }

    private func mods(_ f: NSEvent.ModifierFlags) -> Int {
        var m = 0
        if f.contains(.shift) { m |= 1 }
        if f.contains(.control) { m |= 2 }
        if f.contains(.option) { m |= 4 }
        if f.contains(.command) { m |= 8 }
        if f.contains(.capsLock) { m |= 16 }
        return m
    }

    /// A key event for render.input.
    func keyEvent(_ e: NSEvent, action: String, text: String) -> [String: Any] {
        let flags = e.modifierFlags
        var ev: [String: Any] = ["code": KeyCodes.code(e.keyCode), "action": action, "mods": mods(flags)]
        var consumed = 0
        if !text.isEmpty {
            ev["text"] = text
            if flags.contains(.shift) { consumed |= 1 }
            if flags.contains(.option) && !optionIsAlt(flags) { consumed |= 4 }
        }
        if consumed != 0 { ev["consumed"] = consumed }
        // A modifier key's flagsChanged event has no characters (AppKit
        // throws when asked).
        if e.type == .keyDown || e.type == .keyUp,
           let u = e.characters(byApplyingModifiers: [])?.unicodeScalars.first, KeyCodes.printable(u) {
            ev["unshifted"] = Int(u.value)
        }
        // The side decided here (the daemon is not told which Option is held): Alt is "both" for this key, else none.
        if flags.contains(.option) { if optionIsAlt(flags) { ev["option_as_alt"] = "both" } } else if !optionAsAlt.isEmpty { ev["option_as_alt"] = optionAsAlt }
        return ["key": ev]
    }

    /// Whether Option in these flags is Alt, as Option as Meta says for the
    /// key held: left, right (the flags' device bits NX_DEVICELALTKEYMASK
    /// 0x20 and NX_DEVICERALTKEYMASK 0x40) or both. With no side in the
    /// flags, either is.
    func optionIsAlt(_ f: NSEvent.ModifierFlags) -> Bool {
        guard f.contains(.option), !optionAsAlt.isEmpty else { return false }
        if optionAsAlt == "both" { return true }
        let left = f.rawValue & 0x20 != 0, right = f.rawValue & 0x40 != 0
        if !left && !right { return true }
        return optionAsAlt == "left" ? left : right
    }

    /// The app's shortcuts with Command. They are also in the menus; the
    /// view takes them itself so they work the same from the menu, from
    /// performKeyEquivalent and from keyDown.
    func shortcut(_ e: NSEvent) -> Bool {
        let f = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard f.contains(.command), !f.contains(.control) else { return false }
        let key = e.charactersIgnoringModifiers?.lowercased() ?? ""
        if let found = findShortcut(e) { return found }
        if e.keyCode == 0x73 { scrollToTop(nil); return true }    // Cmd+Home
        if e.keyCode == 0x77 { scrollToBottom(nil); return true } // Cmd+End
        switch key {
        case "k": clearScreen(nil)
        case "c": copy(nil)
        case "v": paste(nil)
        case "a": selectAll(nil)
        case "=", "+": increaseFontSize(nil)
        case "-": decreaseFontSize(nil)
        case "0": resetFontSize(nil)
        default: return false
        }
        return true
    }

    /// Cmd+F, Cmd+G and Cmd+Shift+G, which work from the find bar too.
    private func findShortcut(_ e: NSEvent) -> Bool? {
        let f = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard f.contains(.command), !f.contains(.control), !f.contains(.option) else { return nil }
        switch e.charactersIgnoringModifiers?.lowercased() ?? "" {
        case "f": showFindBar(nil)
        case "g": f.contains(.shift) ? findPrevious(nil) : findNext(nil)
        default: return nil
        }
        return true
    }

    override func keyDown(with e: NSEvent) {
        if e.modifierFlags.contains(.command) && shortcut(e) { return }
        hideTip()
        wakeCursor()
        let hadMarked = hasMarkedText()
        if optionIsAlt(e.modifierFlags) && !hadMarked {
            // Option is Alt: the key's own text, without Option's.
            let text = e.characters(byApplyingModifiers: e.modifierFlags.intersection(.shift)) ?? ""
            sendEvents([keyEvent(e, action: e.isARepeat ? "repeat" : "press", text: text.unicodeScalars.allSatisfy(KeyCodes.printable) ? text : "")])
            return
        }
        keyTexts = []
        interpretKeyEvents([e])
        let texts = keyTexts ?? []
        keyTexts = nil
        if hasMarkedText() {
            requestDraw()
            return // composing: nothing goes to the program yet
        }
        if hadMarked {
            // The input method committed (or cancelled) its text.
            if !texts.isEmpty { sendEvents([["text": texts.joined()]]) }
            requestDraw()
            return
        }
        var text = texts.joined()
        if !text.unicodeScalars.allSatisfy(KeyCodes.printable) { text = "" }
        if e.modifierFlags.contains(.control) || e.modifierFlags.contains(.command) { text = "" }
        sendEvents([keyEvent(e, action: e.isARepeat ? "repeat" : "press", text: text)])
    }

    override func keyUp(with e: NSEvent) {
        sendEvents([keyEvent(e, action: "release", text: "")])
    }

    override func flagsChanged(with e: NSEvent) {
        let cmd = e.modifierFlags.contains(.command)
        if cmd != commandDown {
            commandDown = cmd
            if linkLive, let p = pointer ?? window?.mouseLocationOutsideOfEventStream {
                hoverLink(cell(at: p))
                linkTip?.isHidden = true
            } else {
                clearLink()
                // Cmd let go on a link: its tip again.
                if let p = pointer { hoverTip(cell(at: p), at: convert(p, from: nil)) }
            }
        }
        let flag: NSEvent.ModifierFlags
        switch KeyCodes.code(e.keyCode) {
        case "ShiftLeft", "ShiftRight": flag = .shift
        case "ControlLeft", "ControlRight": flag = .control
        case "AltLeft", "AltRight": flag = .option
        case "MetaLeft", "MetaRight": flag = .command
        case "CapsLock": flag = .capsLock
        default: return
        }
        sendEvents([keyEvent(e, action: e.modifierFlags.contains(flag) ? "press" : "release", text: "")])
    }

    override func performKeyEquivalent(with e: NSEvent) -> Bool {
        // Control combinations AppKit would take as shortcuts go to the
        // program; Command ones go to the menu.
        // Ctrl+Tab and Ctrl+Shift+Tab are the window's (the next and the
        // previous tab), as in the Electron app.
        if e.keyCode == 0x30 && e.modifierFlags.contains(.control) && !e.modifierFlags.contains(.command) {
            return super.performKeyEquivalent(with: e)
        }
        if e.modifierFlags.contains(.control) && !e.modifierFlags.contains(.command) && window?.firstResponder === self {
            keyDown(with: e)
            return true
        }
        if window?.firstResponder === self && shortcut(e) { return true }
        // Cmd+Z, Cmd+Shift+Z and Cmd+X are the program's keys here, not the
        // Edit menu's Undo, Redo and Cut (A11Y-011).
        if window?.firstResponder === self, programsEditKey(e) {
            sendEvents([keyEvent(e, action: "press", text: "")])
            return true
        }
        // The find keys also work while the find bar has the keyboard.
        if findBarVisible, findShortcut(e) == true { return true }
        return super.performKeyEquivalent(with: e)
    }

    /// Cmd+Z, Cmd+Shift+Z or Cmd+X, with no other modifier.
    private func programsEditKey(_ e: NSEvent) -> Bool {
        let f = e.modifierFlags.intersection([.command, .control, .option])
        return e.type == .keyDown && f == .command && ["z", "x"].contains(e.charactersIgnoringModifiers?.lowercased() ?? "")
    }

    /// The Edit menu's Undo and Redo, chosen with the mouse while a
    /// terminal has the keyboard: the program gets Cmd+Z (Cmd+Shift+Z),
    /// as from the keyboard.
    @objc func undo(_ sender: Any?) { sendEditKey(shift: false) }
    @objc func redo(_ sender: Any?) { sendEditKey(shift: true) }
    private func sendEditKey(shift: Bool) {
        let mods = 8 | (shift ? 1 : 0)
        sendEvents([["key": ["code": "KeyZ", "action": "press", "mods": mods, "unshifted": 122] as [String: Any]],
                    ["key": ["code": "KeyZ", "action": "release", "mods": mods, "unshifted": 122] as [String: Any]]])
    }

    /// Cut is off in a terminal (the program's screen is not text to cut).
    @objc func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(NSText.cut(_:)) { return false }
        return true
    }

    override func doCommand(by selector: Selector) {
        // Keys are encoded by the daemon from the key event itself.
    }

    // NSTextInputClient

    func insertText(_ string: Any, replacementRange: NSRange) {
        let s = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        marked = NSMutableAttributedString()
        if keyTexts != nil {
            keyTexts!.append(s)
        } else if !s.isEmpty {
            // From outside a key press (the emoji picker, dictation).
            sendEvents([["text": s]])
        }
    }

    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        if let a = string as? NSAttributedString {
            marked = NSMutableAttributedString(attributedString: a)
        } else {
            marked = NSMutableAttributedString(string: string as? String ?? "")
        }
        if keyTexts == nil { requestDraw() }
    }

    func unmarkText() {
        marked = NSMutableAttributedString()
        requestDraw()
    }

    func selectedRange() -> NSRange { NSRange(location: NSNotFound, length: 0) }
    func markedRange() -> NSRange { marked.length > 0 ? NSRange(location: 0, length: marked.length) : NSRange(location: NSNotFound, length: 0) }
    func hasMarkedText() -> Bool { marked.length > 0 }
    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? { nil }
    func validAttributesForMarkedText() -> [NSAttributedString.Key] { [] }
    func characterIndex(for point: NSPoint) -> Int { NSNotFound }

    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        // The cursor's cell, for the input method's candidate window.
        screen.lock()
        let c = screen.cursor
        screen.unlock()
        let s = renderer.fonts.scale
        let r = NSRect(x: renderer.padding + CGFloat(c.x) * renderer.fonts.cellWidth / s,
                       y: renderer.padding + CGFloat(c.y) * renderer.fonts.cellHeight / s,
                       width: renderer.fonts.cellWidth / s, height: renderer.fonts.cellHeight / s)
        guard let w = window else { return r }
        return w.convertToScreen(convert(r, to: nil))
    }

    // MARK: clipboard

    /// Copies the pane's selection, which the daemon reads (render.copy),
    /// so it reaches beyond the rows on screen.
    @objc func copy(_ sender: Any?) {
        guard let c = conn else { return }
        c.request("render.copy", ["channel": channel]) { [weak self] r in
            guard case .success(let v) = r, let t = v["text"] as? String, !t.isEmpty else { return }
            DispatchQueue.main.async {
                guard let self else { return }
                self.pasteboard.clearContents()
                self.pasteboard.setString(t, forType: .string)
            }
        }
    }

    @objc func paste(_ sender: Any?) {
        _ = paste(from: pasteboard)
    }

    func pasteText(_ s: String) {
        sendEvents([["paste": s]])
    }

    /// Files (their paths, which the daemon quotes) or text from a
    /// pasteboard: a paste, or a drop.
    func paste(from pb: NSPasteboard) -> Bool {
        let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        if !urls.isEmpty {
            sendEvents([["paths": urls.map { $0.path }]])
            return true
        }
        guard let s = pb.string(forType: .string), !s.isEmpty else { return false }
        pasteText(s)
        return true
    }

    @objc override func selectAll(_ sender: Any?) {
        sendEvents([["select": ["action": "all"]]])
    }

    // MARK: dropping files and text

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        let pb = sender.draggingPasteboard
        let ok = pb.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) || pb.string(forType: .string) != nil
        return ok ? .copy : []
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        paste(from: sender.draggingPasteboard)
    }

    // MARK: mouse

    /// The pointer from the grid's top left corner, in points.
    func gridPoint(_ e: NSEvent) -> CGPoint {
        let p = convert(e.locationInWindow, from: nil)
        return CGPoint(x: p.x - renderer.padding, y: p.y - renderer.padding)
    }

    var cellSize: CGSize {
        let s = renderer.fonts.scale
        return CGSize(width: renderer.fonts.cellWidth / s, height: renderer.fonts.cellHeight / s)
    }

    typealias CellHit = (x: Int, row: Int, y: Int, px: CGPoint)

    /// The cell under a point: its column, its row on the view and in
    /// screen coordinates, and the point from the grid's corner, kept on
    /// the grid.
    func cell(_ e: NSEvent) -> CellHit { cell(at: e.locationInWindow) }

    func cell(at windowPoint: NSPoint) -> CellHit {
        let v = convert(windowPoint, from: nil)
        let p = CGPoint(x: v.x - renderer.padding, y: v.y - renderer.padding)
        let c = cellSize
        screen.lock()
        let cols = max(1, screen.cols), rows = max(1, screen.rows), top = screen.history - screen.offset
        screen.unlock()
        let x = max(0, min(cols - 1, Int(floor(p.x / c.width))))
        let row = max(0, min(rows - 1, Int(floor(p.y / c.height))))
        let px = CGPoint(x: max(0, min(p.x, CGFloat(cols) * c.width - 0.01)), y: max(0, min(p.y, CGFloat(rows) * c.height - 0.01)))
        return (x, row, top + row, px)
    }

    private var mouseReporting: Bool {
        screen.lock()
        defer { screen.unlock() }
        return screen.modes & Screen.modeMouse != 0
    }

    private func mouseEvent(_ e: NSEvent, action: String, button: String, held: Bool = false) -> [String: Any] {
        let c = cell(e)
        let sz = cellSize
        var m: [String: Any] = ["action": action, "x": Double(c.px.x), "y": Double(c.px.y),
                                "cell_width": Double(sz.width), "cell_height": Double(sz.height)]
        if !button.isEmpty { m["button"] = button }
        let md = mods(e.modifierFlags) & 15
        if md != 0 { m["mods"] = md }
        if held { m["held"] = true }
        return ["mouse": m]
    }

    /// A step of a selection gesture: the daemon (libghostty-vt's
    /// gesture) counts the clicks by time and place and decides what is
    /// selected; the frames say what it is.
    private func selectEvent(_ e: NSEvent, action: String, at hit: CellHit? = nil) -> [String: Any] {
        let c = hit ?? cell(e)
        let sz = cellSize
        var sel: [String: Any] = ["action": action, "col": c.x, "row": c.y, "x": Double(c.px.x), "y": Double(c.px.y),
                                  "cell_width": Double(sz.width), "cell_height": Double(sz.height)]
        if e.modifierFlags.contains(.shift) { sel["extend"] = true }
        if e.modifierFlags.contains(.option) { sel["rect"] = true }
        return ["select": sel]
    }

    override func mouseDown(with e: NSEvent) {
        window?.makeFirstResponder(self)
        hideTip()
        if e.modifierFlags.contains(.command) {
            // Cmd+click opens the link there; it never selects.
            let c = cell(e)
            if let w = nameWord(at: c) { SessionLinks.shared.open(w, from: self) } else { openLink(at: c) }
            return
        }
        pressedAt = cell(e)
        pressMoved = false
        if mouseReporting && !e.modifierFlags.contains(.shift) {
            sendEvents([mouseEvent(e, action: "press", button: "left")])
            return
        }
        selecting = true
        sendEvents([selectEvent(e, action: "press")])
    }

    /// Where a selection gesture started: a click that did not move opens
    /// the link there when a click opens links, and a session link always.
    private var pressedAt: CellHit?
    /// The button went to another cell since it went down: a drag, never a click.
    private var pressMoved = false

    /// A press and release on one cell, as one click, with no drag off it.
    private func stillClick(_ e: NSEvent, _ up: CellHit) -> Bool {
        guard !pressMoved, e.clickCount == 1, let p = pressedAt else { return false }
        return p.x == up.x && p.y == up.y
    }

    /// Links look like links and a click opens them: with Cmd held, or
    /// always when the settings say so (openLinksSingleClick).
    private var linkLive: Bool { commandDown || look.oneClickLinks }

    override func mouseDragged(with e: NSEvent) {
        if let p = pressedAt, !pressMoved { let c = cell(e); if c.x != p.x || c.y != p.y { pressMoved = true } }
        if !selecting {
            screen.lock()
            let drag = screen.modes & (Screen.modeMouseDrag | Screen.modeMouseMotion) != 0
            screen.unlock()
            if drag && mouseReporting { sendEvents([mouseEvent(e, action: "motion", button: "left", held: true)]) }
            return
        }
        lastDrag = e
        sendEvents([selectEvent(e, action: "drag")])
        // Past the top or the bottom of the grid: scroll while the button
        // is held there.
        let p = gridPoint(e)
        screen.lock()
        let rows = screen.rows
        screen.unlock()
        let outside = p.y < 0 || p.y >= CGFloat(rows) * cellSize.height
        if outside && autoscroll == nil {
            let t = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in self?.autoscrollStep() }
            RunLoop.main.add(t, forMode: .common)
            autoscroll = t
        } else if !outside {
            stopAutoscroll()
        }
    }

    /// Whether a drag past the grid's edge is scrolling the view.
    var autoscrolling: Bool { autoscroll != nil }

    /// One step of the drag's scrolling: a row up or down, and the
    /// selection on to the row that comes into view at the edge.
    private func autoscrollStep() {
        guard selecting, let e = lastDrag else { return stopAutoscroll() }
        let p = gridPoint(e)
        screen.lock()
        let rows = screen.rows, history = screen.history, offset = screen.offset
        screen.unlock()
        let up = p.y < 0
        let newOffset = max(0, min(history, offset + (up ? 1 : -1)))
        var c = cell(e)
        c.row = up ? 0 : rows - 1
        c.y = history - newOffset + c.row
        let sz = cellSize
        let w: [String: Any] = ["rows": up ? 1.0 : -1.0, "x": Double(c.px.x), "y": Double(c.px.y),
                                "cell_width": Double(sz.width), "cell_height": Double(sz.height)]
        sendEvents([["wheel": w], selectEvent(e, action: "drag", at: c)])
        showScrollbar()
    }

    private func stopAutoscroll() {
        autoscroll?.invalidate()
        autoscroll = nil
    }

    override func mouseUp(with e: NSEvent) {
        if !selecting {
            if mouseReporting { sendEvents([mouseEvent(e, action: "release", button: "left")]) }
            // A session link opens on a plain click, the program's mouse on or not.
            let up = cell(e)
            if stillClick(e, up), !e.modifierFlags.contains(.shift), let w = nameWord(at: up) { SessionLinks.shared.open(w, from: self) }
            pressedAt = nil
            return
        }
        selecting = false
        stopAutoscroll()
        let dragged = lastDrag != nil
        lastDrag = nil
        sendEvents([selectEvent(e, action: "release")])
        let up = cell(e)
        if stillClick(e, up), !e.modifierFlags.contains(.shift), let w = nameWord(at: up) {
            // A session link: its tab, at once (a drag selects as ever).
            SessionLinks.shared.open(w, from: self)
        } else if look.oneClickLinks, !dragged, e.clickCount == 1, let p = pressedAt, p.x == up.x, p.y == up.y {
            openLink(at: up)
        } else if look.copyOnSelect {
            // What the gesture selected goes to the clipboard (render.copy
            // answers nothing when it selected nothing).
            copy(nil)
        }
        pressedAt = nil
    }

    override func rightMouseDown(with e: NSEvent) {
        if mouseReporting { sendEvents([mouseEvent(e, action: "press", button: "right")]) } else { super.rightMouseDown(with: e) }
    }

    override func rightMouseUp(with e: NSEvent) {
        if mouseReporting { sendEvents([mouseEvent(e, action: "release", button: "right")]) }
    }

    override func otherMouseDown(with e: NSEvent) {
        if mouseReporting { sendEvents([mouseEvent(e, action: "press", button: "middle")]) }
    }

    override func otherMouseUp(with e: NSEvent) {
        if mouseReporting { sendEvents([mouseEvent(e, action: "release", button: "middle")]) }
    }

    override func mouseMoved(with e: NSEvent) {
        // Under a view laid over the terminal (a page, the filmstrip's
        // frame): no link, no name, no motion for the program, and the
        // pointer is that view's.
        if covered(convert(e.locationInWindow, from: nil)) {
            pointerCovered = true
            clearLink()
            hideTip()
            setNameHover(false)
            pointerCovered = false
            return
        }
        pointer = e.locationInWindow
        commandDown = e.modifierFlags.contains(.command)
        hoverMark(at: convert(e.locationInWindow, from: nil))
        let c = cell(e)
        if linkLive {
            hoverLink(c)
            hideTip()
        } else {
            clearLink()
            hoverTip(c, at: convert(e.locationInWindow, from: nil))
        }
        setNameHover(nameWord(at: c) != nil)
        screen.lock()
        let motion = screen.modes & Screen.modeMouseMotion != 0
        screen.unlock()
        if motion { sendEvents([mouseEvent(e, action: "motion", button: "")]) }
    }

    override func mouseExited(with e: NSEvent) {
        hideTip()
        markLabel?.isHidden = true
    }

    // MARK: what an agent typed (TERM-044)

    /// Places the marks on the rows on screen; the ones to draw.
    private func placeMarks() -> [(row: Int, rec: [String: Any], who: String, cls: String)] {
        screen.lock()
        defer { screen.unlock() }
        let top = screen.history - screen.offset, rows = screen.rows
        let sc = screen
        let v = InputMarks.View(top: top, count: rows, row: { sc.rowText($0) },
                                cursorRow: top + (screen.cursor.inView ? screen.cursor.y : rows - 1), cursorX: screen.cursor.x,
                                alt: screen.modes & Screen.modeAltScreen != 0)
        marks.place(v)
        return v.alt ? [] : marks.visible(top: top, rows: rows)
    }

    /// A record from the daemon's pane.input event (Workspace).
    func inputLogged(_ r: [String: Any]) {
        marks.add(r)
        requestDraw()
    }

    /// The label of a mark: who and when, left of its bar while the pointer is on it.
    private(set) var markLabel: Box?

    /// The words of the label while it shows, else nil.
    var markLabelText: String? {
        guard let b = markLabel, !b.isHidden else { return nil }
        return (b.subviews.first as? NSTextField)?.stringValue
    }

    /// The bar's rect in the view, for a row on screen.
    func markBar(row: Int) -> NSRect {
        let s = renderer.fonts.scale
        screen.lock()
        let cols = screen.cols
        screen.unlock()
        let x = renderer.padding + CGFloat(cols) * renderer.fonts.cellWidth / s + 3
        return NSRect(x: x, y: renderer.padding + CGFloat(row) * renderer.fonts.cellHeight / s + 2, width: 3, height: renderer.fonts.cellHeight / s - 4)
    }

    private func hoverMark(at p: NSPoint) {
        let hit = drawnMarks.first { markBar(row: $0.row).insetBy(dx: -4, dy: -2).contains(p) }
        guard let m = hit else { markLabel?.isHidden = true; return }
        let b = markLabel ?? {
            let b = Box(radius: 5)
            b.addSubview(NSTextField(labelWithString: ""))
            b.layer?.shadowColor = NSColor.black.cgColor
            b.layer?.shadowOpacity = 0.35
            b.layer?.shadowRadius = 6
            b.layer?.shadowOffset = CGSize(width: 0, height: -4)
            addSubview(b)
            markLabel = b
            return b
        }()
        let th = renderer.theme
        let fg = NSColor(srgbRed: CGFloat(th.foreground.x), green: CGFloat(th.foreground.y), blue: CGFloat(th.foreground.z), alpha: 1)
        b.rawFill = NSColor(srgbRed: CGFloat(th.background.x), green: CGFloat(th.background.y), blue: CGFloat(th.background.z), alpha: 1)
        b.layer?.borderColor = fg.withAlphaComponent(0.16).cgColor
        b.layer?.borderWidth = 1
        let a = NSMutableAttributedString(string: m.who, attributes: [.font: NSFont.systemFont(ofSize: 11, weight: .semibold), .foregroundColor: InputMarks.nameColor(m.cls)])
        a.append(NSAttributedString(string: " " + When.clock(m.rec["at"] as? String), attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: fg.withAlphaComponent(0.7)]))
        guard let l = b.subviews.first as? NSTextField else { return }
        l.attributedStringValue = a
        let ls = l.fittingSize
        l.frame = NSRect(x: 7, y: 3, width: ceil(ls.width), height: ceil(ls.height))
        let bar = markBar(row: m.row)
        let size = NSSize(width: ceil(ls.width) + 14, height: ceil(ls.height) + 6)
        b.frame = NSRect(x: max(0, bar.maxX - 8 - size.width), y: bar.midY - size.height / 2, width: size.width, height: size.height)
        b.isHidden = false
    }

    // MARK: the link tip (TERM-022)

    /// "Cmd+click to open" beside the pointer while it rests on a link a
    /// plain click does not open (Cmd not held, "Open links with one
    /// click" off), as the Electron app's .link-tip (terminal.ts showTip):
    /// the daemon's render.link says where a link is, asked once per cell.
    private(set) var linkTip: Box?
    private var tipAsked: (x: Int, y: Int)?
    private var tipRange: CellRange?

    /// The tip's words while it shows, else nil.
    var linkTipText: String? {
        guard let b = linkTip, !b.isHidden else { return nil }
        return (b.subviews.first as? NSTextField)?.stringValue
    }

    private func hoverTip(_ c: CellHit, at p: NSPoint) {
        if linkLive { return hideTip() }
        if let r = tipRange, r.contains(x: c.x, y: c.y) { return showTip(at: p) }
        if let a = tipAsked, a.x == c.x, a.y == c.y { return }
        hideTip()
        tipAsked = (c.x, c.y)
        askLink(c) { [weak self] found in
            guard let self, !self.linkLive, let a = self.tipAsked, a.x == c.x, a.y == c.y, let found, TerminalView.openable(found.uri) else { return }
            self.tipRange = found.range
            self.showTip(at: self.pointer.map { self.convert($0, from: nil) } ?? p)
        }
    }

    private func showTip(at p: NSPoint) {
        let tip = linkTip ?? {
            let b = Box(fill: "card2", ring: "sep", radius: 5)
            let l = label(t("term.linkTip"), NSFont.systemFont(ofSize: 11.5), "tx")
            b.addSubview(l)
            b.layer?.shadowColor = NSColor.black.cgColor
            b.layer?.shadowOpacity = 0.25
            b.layer?.shadowRadius = 4
            b.layer?.shadowOffset = CGSize(width: 0, height: -2)
            addSubview(b)
            linkTip = b
            return b
        }()
        guard let l = tip.subviews.first as? NSTextField else { return }
        let ls = l.fittingSize
        let size = NSSize(width: ceil(ls.width) + 14, height: ceil(ls.height) + 6)
        l.frame = NSRect(x: 7, y: 3, width: ceil(ls.width), height: ceil(ls.height))
        // Right of the pointer and under it, inside the view (app.css .link-tip).
        let x = max(0, min(p.x + 10, bounds.width - size.width - 4))
        var y = p.y + 18
        if y + size.height > bounds.height { y = max(0, p.y - size.height - 6) }
        tip.frame = NSRect(origin: NSPoint(x: x, y: y), size: size)
        tip.isHidden = false
    }

    /// The tip goes (the pointer left the link or the view, a press, a key, the wheel).
    private func hideTip() {
        tipAsked = nil
        tipRange = nil
        linkTip?.isHidden = true
    }

    // MARK: find

    /// The find bar, made on the first Cmd+F.
    private(set) var findBar: FindBar?
    private(set) var findNeedle = ""
    /// The count and selected match from the last render.find, or the
    /// frames' find section since.
    private(set) var findCount = 0, findSelected = -1
    /// The rows the matches start on (from the top of the scrollback) and
    /// the rows in all, from the last render.find: the scrollbar's marks
    /// (TERM-030). findMarksCount: the count they are of.
    private(set) var findMarks: (rows: [Int], lines: Int) = ([], 0)
    private var findMarksCount = -1
    /// Match case and Regular expression (the bar's Aa and .*).
    private(set) var findCase = false, findRegex = false
    /// What a press on a toggle this tab's daemon lacks said, until the
    /// text changes (the line under the bar).
    private var findNotice: String?

    var findBarVisible: Bool { findBar.map { !$0.isHidden } ?? false }

    /// Cmd+F: the bar, with the keyboard; a selection on one line is what
    /// it looks for (as the Electron app's openFind), else the last words.
    @objc func showFindBar(_ sender: Any?) {
        let bar = findBar ?? makeFindBar()
        bar.isHidden = false
        placeFindBar()
        window?.invalidateCursorRects(for: self)
        window?.makeFirstResponder(bar.field)
        if let s = selectedLine(), s != findNeedle {
            bar.field.stringValue = s
            findNeedle = s
            bar.field.currentEditor()?.selectAll(nil)
            find(step: 1)
            return
        }
        bar.field.currentEditor()?.selectAll(nil)
        if !findNeedle.isEmpty { find(step: 0) }
    }

    /// The selection's text when it lies on one row (at most 200
    /// characters), asked of the daemon at once (render.copy, 300 ms at most).
    private func selectedLine() -> String? {
        screen.lock()
        let sel = screen.selection
        screen.unlock()
        guard let r = sel, r.y0 == r.y1, let conn, channel != 0,
              let v = try? conn.call("render.copy", ["channel": channel], timeout: 0.3), let s = v["text"] as? String else { return nil }
        let line = s.trimmingCharacters(in: .newlines)
        return line.isEmpty || line.count > 200 || line.contains("\n") ? nil : line
    }

    private func makeFindBar() -> FindBar {
        let bar = FindBar()
        bar.autoresizingMask = [.minXMargin, .maxYMargin]
        bar.onChange = { [weak self] s in self?.findChanged(s) }
        bar.onNext = { [weak self] in self?.findNext(nil) }
        bar.onPrevious = { [weak self] in self?.findPrevious(nil) }
        bar.onClose = { [weak self] in self?.closeFindBar() }
        bar.onToggle = { [weak self] b in self?.findToggled(b) }
        addSubview(bar)
        findBar = bar
        askFindOptions()
        return bar
    }

    private func placeFindBar() {
        guard let bar = findBar else { return }
        let sz = FindBar.size
        bar.frame = NSRect(x: max(0, bounds.width - sz.width - 12), y: 8, width: sz.width, height: bar.frame.height)
    }

    /// Whether this tab's daemon has match case and regular expressions:
    /// an older one refuses the options (bad_request), so they are asked
    /// with an empty needle, which only ends a search not started yet
    /// (PROTOCOL.md, render.find). Once per daemon.
    private func askFindOptions() {
        guard let c = conn else { return }
        if let has = c.findOptions { return findOptionsKnown(has) }
        guard channel != 0 else { return }
        c.request("render.find", ["channel": channel, "needle": "", "case_sensitive": false]) { [weak self] r in
            var has: Bool?
            switch r {
            case .success: has = true
            case .failure(.daemon(let code, let message)) where TerminalView.unknownField(code, message): has = false
            default: break
            }
            DispatchQueue.main.async {
                guard let has else { return }
                c.findOptions = has
                self?.findOptionsKnown(has)
            }
        }
    }

    /// The daemon refused a field it does not know (an older daemon).
    static func unknownField(_ code: String, _ message: String) -> Bool {
        code == "bad_request" && message.contains("unknown field")
    }

    /// An older daemon: the toggles dimmed, their tips saying why.
    func findOptionsKnown(_ has: Bool) {
        guard let bar = findBar else { return }
        bar.matchCase.unavailableTip = t("find.caseOld")
        bar.regex.unavailableTip = t("find.regexOld")
        bar.matchCase.unavailable = !has
        bar.regex.unavailable = !has
        if !has, findCase || findRegex {
            findCase = false
            findRegex = false
            bar.matchCase.on = false
            bar.regex.on = false
            if !findNeedle.isEmpty { find(step: 0) }
        }
    }

    /// Aa or .* pressed: the matches counted again from scratch, the
    /// newest selected (as the Electron app's toggles). On an older
    /// daemon it stays off and the line under the bar says why.
    private func findToggled(_ b: FindToggle) {
        guard let bar = findBar else { return }
        if b.unavailable {
            findNotice = b === bar.matchCase ? t("find.caseOld") : t("find.regexOld")
            bar.show(problem: findNotice)
            return
        }
        if b === bar.matchCase { findCase.toggle() } else { findRegex.toggle() }
        bar.matchCase.on = findCase
        bar.regex.on = findRegex
        window?.makeFirstResponder(bar.field)
        bar.field.currentEditor()?.moveToEndOfDocument(nil)
        if !findNeedle.isEmpty { find(step: 1) } else { bar.show(problem: nil) }
    }

    /// What to find changed: the first character selects the newest
    /// match (step 1), and the search keeps it after.
    func findChanged(_ s: String) {
        let first = findNeedle.isEmpty
        findNeedle = s
        findNotice = nil
        find(step: first && !s.isEmpty ? 1 : 0)
    }

    /// Next is older output (step 1), previous newer (step -1).
    @objc func findNext(_ sender: Any?) {
        if findNeedle.isEmpty { return showFindBar(nil) }
        find(step: 1)
    }

    @objc func findPrevious(_ sender: Any?) {
        if findNeedle.isEmpty { return showFindBar(nil) }
        find(step: -1)
    }

    private func find(step: Int) {
        guard let c = conn else { return }
        let needle = findNeedle, matchCase = findCase, regex = findRegex
        // The options go only when on, so an older daemon still finds.
        var req: [String: Any] = ["channel": channel, "needle": needle, "step": step]
        if matchCase && !needle.isEmpty { req["case_sensitive"] = true }
        if regex && !needle.isEmpty { req["regex"] = true }
        c.request("render.find", req) { [weak self] r in
            switch r {
            case .success(let v):
                let n = (v["count"] as? NSNumber)?.intValue ?? 0, sel = (v["selected"] as? NSNumber)?.intValue ?? -1
                let bad = v["pattern_error"] as? String
                DispatchQueue.main.async {
                    guard let self, needle == self.findNeedle, matchCase == self.findCase, regex == self.findRegex else { return }
                    self.findCount = n
                    self.findSelected = sel
                    self.findMarks = bad == nil ? ((v["rows"] as? [NSNumber] ?? []).map(\.intValue), (v["lines"] as? NSNumber)?.intValue ?? 0) : ([], 0)
                    self.findMarksCount = bad == nil ? n : -1
                    self.requestDraw()
                    self.findBar?.show(count: bad == nil ? n : 0, selected: sel, needle: bad == nil ? needle : "")
                    self.findBar?.show(problem: bad.map { t("find.badPattern", ["why": $0]) } ?? self.findNotice, bad: bad != nil)
                }
            case .failure(.daemon(let code, let message)) where (matchCase || regex) && TerminalView.unknownField(code, message):
                // A daemon older than the options: without them, and the toggles say why.
                DispatchQueue.main.async {
                    c.findOptions = false
                    self?.findOptionsKnown(false)
                }
            default: break
            }
        }
    }

    /// Esc or the close button: the search ends and the keyboard is the
    /// terminal's again.
    func closeFindBar() {
        guard let bar = findBar, !bar.isHidden else { return }
        bar.isHidden = true
        window?.invalidateCursorRects(for: self)
        if !findNeedle.isEmpty {
            findNeedle = ""
            find(step: 0)
        }
        bar.field.stringValue = ""
        bar.show(count: 0, selected: -1, needle: "")
        bar.show(problem: nil)
        findNotice = nil
        findCount = 0
        findSelected = -1
        findMarks = ([], 0)
        findMarksCount = -1
        window?.makeFirstResponder(self)
    }

    /// The frames' find section changed (new output, a scroll): the count.
    private func findFromFrames(_ f: FindState) {
        guard findBarVisible, !findNeedle.isEmpty, f.active else { return }
        if f.count != findCount || f.selected != findSelected {
            findCount = f.count
            findSelected = f.selected
            findBar?.show(count: f.count, selected: f.selected, needle: findNeedle)
        }
        // New matches came (or went): the scrollbar's marks are asked again.
        if f.count != findMarksCount && findMarksCount >= 0 {
            findMarksCount = f.count
            find(step: 0)
        }
    }

    // MARK: the bell

    var bellFlashing: Bool { CACurrentMediaTime() - bellAt < TerminalView.bellFlash }

    // MARK: the context menu and Clear

    /// The window's commands the menu offers (Workspace.box sets them): a
    /// split beside this pane, whether its tab can split (one split per
    /// tab), and the pane's folder (Copy Path).
    var onSplit: ((String) -> Void)?
    var canSplit: () -> Bool = { false }
    var folderPath: () -> String? = { nil }
    /// pane.render failed (the pane is gone, the daemon did not answer): the workspace says so (TERM-070).
    var onRenderFailed: ((ConnectionError) -> Void)?
    /// The last menu made (the self-test reads its items).
    private(set) var lastMenu: NSMenu?

    /// Right click, when the program does not take the mouse (the Electron
    /// app's term:menu): Open Link and Copy Link over a link, Copy (only
    /// with a selection), Paste, Select All, Copy Path (the pane's folder),
    /// Find, Clear, Split Right and Split Down (not in a split tab).
    override func menu(for event: NSEvent) -> NSMenu? {
        if mouseReporting { return nil }
        return contextMenu(at: event.locationInWindow)
    }

    func contextMenu(at windowPoint: NSPoint) -> NSMenu {
        let m = NSMenu(title: "Terminal")
        m.autoenablesItems = false
        func add(_ title: String, _ on: Bool = true, _ run: @escaping () -> Void) {
            let i = TermMenuItem.item(title, run)
            i.isEnabled = on
            m.addItem(i)
        }
        if let uri = linkAt(cell(at: windowPoint)) {
            add(t("term.openLink")) { [weak self] in self?.open(uri) }
            add(t("term.copyLink")) { [weak self] in self?.pasteboard.clearContents(); self?.pasteboard.setString(uri, forType: .string) }
            m.addItem(.separator())
        }
        screen.lock()
        let selected = screen.selection != nil
        screen.unlock()
        add(t("term.copy"), selected) { [weak self] in self?.copy(nil) }
        add(t("term.paste")) { [weak self] in self?.paste(nil) }
        add(t("term.selectAll")) { [weak self] in self?.selectAll(nil) }
        m.addItem(.separator())
        let folder = folderPath()
        add(t("term.copyPath"), folder != nil) { [weak self] in
            guard let self, let f = folder else { return }
            self.pasteboard.clearContents()
            self.pasteboard.setString(f, forType: .string)
        }
        add(t("term.find")) { [weak self] in self?.showFindBar(nil) }
        add(t("term.clear")) { [weak self] in self?.clearScreen(nil) }
        m.addItem(.separator())
        let split = canSplit() && onSplit != nil
        add(t("term.splitRight"), split) { [weak self] in self?.onSplit?("right") }
        add(t("term.splitDown"), split) { [weak self] in self?.onSplit?("down") }
        lastMenu = m
        return m
    }

    /// The link on a cell, asked of the daemon at once (a right click's menu
    /// waits for it, at most 300 ms): the one underlined, else render.link's.
    private func linkAt(_ c: CellHit) -> String? {
        if let l = link, l.range.contains(x: c.x, y: c.y) { return l.uri }
        guard let conn, channel != 0,
              let v = try? conn.call("render.link", ["channel": channel, "at": ["x": c.x, "y": c.y]], timeout: 0.3),
              let uri = v["uri"] as? String, !uri.isEmpty,
              let u = URL(string: uri), let scheme = u.scheme?.lowercased(), ["http", "https", "file"].contains(scheme) else { return nil }
        return uri
    }

    /// Clears the screen and the scrollback, the prompt kept at the top
    /// (pane.clear, as Cmd+K in Terminal.app).
    @objc func clearScreen(_ sender: Any?) {
        guard let c = conn, !pane.isEmpty else { return }
        c.request("pane.clear", ["pane": pane])
    }

    // MARK: accessibility

    /// The visible rows' text, as VoiceOver reads it.
    private var a11yText: String { screen.text() }
    private var a11yVersion = 0
    private var a11yPending = false
    private var a11yPosted: CFTimeInterval = 0
    private(set) var a11yPosts = 0

    /// Says the value changed, at most four times a second.
    private func announceValue() {
        if a11yPending { return }
        a11yPending = true
        let wait = max(0, a11yPosted + 0.25 - CACurrentMediaTime())
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
            guard let self else { return }
            self.a11yPending = false
            self.a11yPosted = CACurrentMediaTime()
            self.a11yPosts += 1
            NSAccessibility.post(element: self, notification: .valueChanged)
        }
    }

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .textArea }
    override func accessibilityLabel() -> String? { "Terminal" }
    override func accessibilityValue() -> Any? { a11yText }
    override func accessibilityNumberOfCharacters() -> Int { (a11yText as NSString).length }
    override func accessibilityVisibleCharacterRange() -> NSRange { NSRange(location: 0, length: accessibilityNumberOfCharacters()) }
    override func accessibilitySelectedText() -> String? { "" }

    override func accessibilityString(for range: NSRange) -> String? {
        let t = a11yText as NSString
        guard range.location >= 0, NSMaxRange(range) <= t.length else { return nil }
        return t.substring(with: range)
    }

    override func accessibilityLine(for index: Int) -> Int {
        let t = a11yText as NSString
        let end = max(0, min(index, t.length))
        var line = 0
        for i in 0..<end where t.character(at: i) == 10 { line += 1 }
        return line
    }

    override func accessibilityRange(forLine line: Int) -> NSRange {
        let t = a11yText as NSString
        var start = 0, n = 0
        while n < line {
            let r = t.range(of: "\n", range: NSRange(location: start, length: t.length - start))
            if r.location == NSNotFound { return NSRange(location: NSNotFound, length: 0) }
            start = r.location + 1
            n += 1
        }
        let r = t.range(of: "\n", range: NSRange(location: start, length: t.length - start))
        return NSRange(location: start, length: (r.location == NSNotFound ? t.length : r.location) - start)
    }

    override func accessibilityInsertionPointLineNumber() -> Int {
        screen.lock()
        defer { screen.unlock() }
        return screen.cursor.y
    }

    /// The cursor, as the text's selection.
    override func accessibilitySelectedTextRange() -> NSRange {
        screen.lock()
        let c = screen.cursor
        screen.unlock()
        let line = accessibilityRange(forLine: c.y)
        guard line.location != NSNotFound else { return NSRange(location: 0, length: 0) }
        return NSRange(location: line.location + min(c.x, line.length), length: 0)
    }

    // MARK: links

    /// A move under a view laid over the terminal: the hover is let go of without setting the pointer.
    private var pointerCovered = false

    /// Its regions where nothing lies over it: a page over the stage, the
    /// filmstrip's frame, the panel over the window keep their own pointer.
    override func resetCursorRects() {
        for (r, c) in cursorRegions() { for u in uncovered(r) { addCursorRect(u, cursor: c) } }
    }

    /// The scrollbar's strip at the right edge, while it shows.
    var scrollbarStrip: NSRect? {
        scrollbarAlpha > 0 ? NSRect(x: bounds.maxX - 12, y: 0, width: 12, height: bounds.height) : nil
    }

    /// The pointer over the view: the I-beam over the text (the pointing
    /// hand over a link with Cmd), the arrow over the overlays (the find
    /// bar, whose text field sets its own I-beam, and the scrollbar).
    func cursorRegions() -> [(NSRect, NSCursor)] {
        var overlays: [NSRect] = []
        if let bar = findBar, !bar.isHidden { overlays.append(bar.frame) }
        if let s = scrollbarStrip { overlays.append(s) }
        var text = [bounds]
        for o in overlays {
            text = text.flatMap { r -> [NSRect] in
                let i = r.intersection(o)
                if i.isEmpty { return [r] }
                // What is left of r around i: above, below, left, right.
                return [NSRect(x: r.minX, y: r.minY, width: r.width, height: i.minY - r.minY),
                        NSRect(x: r.minX, y: i.maxY, width: r.width, height: r.maxY - i.maxY),
                        NSRect(x: r.minX, y: i.minY, width: i.minX - r.minX, height: i.height),
                        NSRect(x: i.maxX, y: i.minY, width: r.maxX - i.maxX, height: i.height)]
                    .filter { $0.width > 0 && $0.height > 0 }
            }
        }
        let c: NSCursor = linkCursor || nameHover ? .pointingHand : .iBeam
        return text.map { ($0, c) } + overlays.map { ($0, NSCursor.arrow) }
    }

    /// The cursor for a point of the view, as the regions say.
    func cursorAt(_ p: NSPoint) -> NSCursor? {
        cursorRegions().last { $0.0.contains(p) }?.1
    }

    /// Asks the daemon for the link on a cell (a hyperlink, or a URL in
    /// the text), once per cell the pointer comes to while Cmd is held.
    private func hoverLink(_ c: CellHit) {
        if let l = link, l.range.contains(x: c.x, y: c.y) { return }
        if let a = linkAsked, a.x == c.x, a.y == c.y { return }
        linkAsked = (c.x, c.y)
        askLink(c) { [weak self] found in
            guard let self, self.linkLive, let a = self.linkAsked, a.x == c.x, a.y == c.y else { return }
            if let found { self.setLink(found) } else { self.clearLink(keepAsked: true) }
        }
    }

    private func askLink(_ c: CellHit, done: @escaping ((uri: String, range: CellRange)?) -> Void) {
        guard let conn else { return }
        conn.request("render.link", ["channel": channel, "at": ["x": c.x, "y": c.y]]) { r in
            var found: (uri: String, range: CellRange)?
            if case .success(let v) = r, let uri = v["uri"] as? String, !uri.isEmpty,
               let f = v["from"] as? [String: Any], let t = v["to"] as? [String: Any] {
                func n(_ d: [String: Any], _ k: String) -> Int { (d[k] as? NSNumber)?.intValue ?? 0 }
                found = (uri, CellRange(x0: n(f, "x"), y0: n(f, "y"), x1: n(t, "x"), y1: n(t, "y")))
            }
            DispatchQueue.main.async { done(found) }
        }
    }

    private func setLink(_ l: (uri: String, range: CellRange)) {
        link = l
        setLinkCursor(true)
        requestDraw()
    }

    private func clearLink(keepAsked: Bool = false) {
        if !keepAsked { linkAsked = nil }
        guard link != nil || linkCursor else { return }
        link = nil
        setLinkCursor(false)
        requestDraw()
    }

    private func setLinkCursor(_ on: Bool) {
        guard on != linkCursor else { return }
        linkCursor = on
        window?.invalidateCursorRects(for: self)
        // A window off every screen (the self-test) never sets the
        // pointer, which is the person's.
        if !offscreen && !pointerCovered { (on ? NSCursor.pointingHand : NSCursor.iBeam).set() }
    }

    /// Cmd+click: opens the link on the cell, the one underlined or the
    /// one the daemon finds there.
    private func openLink(at c: CellHit) {
        if let l = link, l.range.contains(x: c.x, y: c.y) {
            open(l.uri)
            return
        }
        askLink(c) { [weak self] found in
            if let found { self?.open(found.uri) }
        }
    }

    /// The session link on a cell (SessionLinks.swift): its word, or nil.
    func nameWord(at c: CellHit) -> String? {
        screen.lock()
        defer { screen.unlock() }
        guard !screen.nameSpans.isEmpty else { return nil }
        for sp in screen.nameSpans where sp.y == c.row && c.x >= sp.x0 && c.x <= sp.x1 {
            return sp.word < screen.nameWords.count ? screen.nameWords[sp.word] : nil
        }
        return nil
    }

    private func setNameHover(_ on: Bool) {
        guard on != nameHover else { return }
        nameHover = on
        window?.invalidateCursorRects(for: self)
        if !offscreen && !linkCursor && !pointerCovered { (on ? NSCursor.pointingHand : NSCursor.iBeam).set() }
    }

    /// Opens a link's URI: only the web and files.
    private func open(_ uri: String) {
        guard TerminalView.openable(uri), let u = URL(string: uri) else { return }
        openURL(u)
    }

    /// A link the app opens: the web and files only.
    static func openable(_ uri: String) -> Bool {
        guard let u = URL(string: uri), let scheme = u.scheme?.lowercased() else { return false }
        return ["http", "https", "file"].contains(scheme)
    }

    // MARK: scrolling

    /// Every wheel and trackpad movement, momentum included, goes to the
    /// daemon in rows (positive: up, toward older output); the daemon
    /// decides, as Ghostty does, whether the program gets it, it becomes
    /// arrow keys on the alternate screen, or the view scrolls.
    override func scrollWheel(with e: NSEvent) {
        hideTip()
        let s = renderer.fonts.scale
        let ch = renderer.fonts.cellHeight / s
        // A trackpad or Magic Mouse gives points; a wheel's notch is three
        // rows (Ghostty's discrete multiplier).
        let rows = e.hasPreciseScrollingDeltas ? e.scrollingDeltaY / ch : e.scrollingDeltaY * 3
        let log = EventLog.shared
        if log.enabled {
            screen.lock()
            let st = "history \(screen.history) rows \(screen.rows) offset \(screen.offset) modes \(screen.modes)"
            screen.unlock()
            log.write("view scrollWheel phase \(e.phase.name) momentum \(e.momentumPhase.name) precise \(e.hasPreciseScrollingDeltas) deltaY \(e.deltaY) scrollingDeltaY \(e.scrollingDeltaY) rows \(rows) sent \(rows != 0 && conn != nil && channel != 0) firstResponder \(window?.firstResponder === self) \(st)")
            lastWheelAt = CACurrentMediaTime()
        }
        if rows == 0 { return }
        let p = gridPoint(e)
        var w: [String: Any] = ["rows": Double(rows), "x": Double(max(0, p.x)), "y": Double(max(0, p.y)),
                                "cell_width": Double(renderer.fonts.cellWidth / s), "cell_height": Double(ch)]
        let md = mods(e.modifierFlags) & 15
        if md != 0 { w["mods"] = md }
        if log.enabled, let c = conn, channel != 0 {
            c.request("render.input", ["channel": channel, "events": [["wheel": w]]]) { r in
                switch r {
                case .success: log.write("daemon wheel ok")
                case .failure(let err): log.write("daemon wheel error \(err)")
                }
            }
        } else {
            sendEvents([["wheel": w]])
        }
        showScrollbar()
    }

    /// When the last wheel event came: the frames' offset is logged for
    /// two seconds after.
    private var lastWheelAt: CFTimeInterval = -10
    private var loggedView = (offset: -1, history: -1)

    /// Shows the view `offset` rows up into the scrollback (0: live).
    func scrollTo(_ offset: Int) {
        conn?.request("render.scroll", ["channel": channel, "offset": max(0, offset)])
        showScrollbar()
    }

    @objc func scrollToTop(_ sender: Any?) {
        screen.lock()
        let h = screen.history
        screen.unlock()
        scrollTo(h)
    }

    @objc func scrollToBottom(_ sender: Any?) { scrollTo(0) }

    // MARK: the scrollbar

    /// When the view last scrolled; the scrollbar shows for 0.8 s after,
    /// then fades out in 0.3 s.
    private var scrolledAt: CFTimeInterval = -10
    private var scrollbarTimer: Timer?
    private var lastOffset = 0
    private var lastFind = FindState()
    static let scrollbarHold: CFTimeInterval = 0.8, scrollbarFade: CFTimeInterval = 0.3

    /// The scrollbar's opacity now, 0 when hidden.
    var scrollbarAlpha: Float {
        screen.lock()
        let history = screen.history
        screen.unlock()
        if history == 0 { return 0 }
        let t = CACurrentMediaTime() - scrolledAt
        if t < TerminalView.scrollbarHold { return 1 }
        return Float(max(0, 1 - (t - TerminalView.scrollbarHold) / TerminalView.scrollbarFade))
    }

    func showScrollbar() {
        scrolledAt = CACurrentMediaTime()
        requestDraw()
        guard scrollbarTimer == nil else { return }
        window?.invalidateCursorRects(for: self)
        let t = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] timer in
            guard let self else { return timer.invalidate() }
            let age = CACurrentMediaTime() - self.scrolledAt
            if age >= TerminalView.scrollbarHold { self.requestDraw() }
            if age > TerminalView.scrollbarHold + TerminalView.scrollbarFade {
                timer.invalidate()
                self.scrollbarTimer = nil
                self.window?.invalidateCursorRects(for: self)
            }
        }
        RunLoop.main.add(t, forMode: .common)
        scrollbarTimer = t
    }
}

/// Runs work right after the main run loop's Core Animation commit: an
/// observer of the turn's end (before the run loop waits, and when it
/// exits a mode), both where Core Animation commits, ordered after
/// Core Animation's own (2000000).
final class CommitWatch {
    static let shared = CommitWatch()
    private var waiting: [() -> Void] = []
    private var observer: CFRunLoopObserver?

    func after(_ f: @escaping () -> Void) {
        if observer == nil {
            let o = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue | CFRunLoopActivity.exit.rawValue, true, 2_000_100) { [weak self] _, _ in
                guard let self, !self.waiting.isEmpty else { return }
                let w = self.waiting
                self.waiting.removeAll()
                w.forEach { $0() }
            }
            CFRunLoopAddObserver(CFRunLoopGetMain(), o, .commonModes)
            observer = o
        }
        waiting.append(f)
    }
}

/// What a stall on the person's screen leaves in the app's log
/// (~/Library/Logs/Ravenry/app.log): a draw that waited over 50 ms for its
/// drawable, a live resize's step not drawn at its size within one
/// display refresh. At most a line every 10 seconds, with how many more
/// there were since the last one and the draws put off for want of a
/// drawable.
final class DrawWatch {
    static let shared = DrawWatch()
    static let waitLimitMs = 50.0
    private var lastAt: CFTimeInterval = -100
    private var more = 0
    private let queue = DispatchQueue(label: "ravenry.drawwatch", qos: .utility)

    func waited(_ v: TerminalView, ms: Double, got: Bool) {
        note(v, String(format: "waited %.0f ms for a drawable%@", ms, got ? "" : ", none came (not drawn)"))
    }
    /// A skip alone is back pressure, not a stall: counted, and said with the next line.
    func skipped(_ v: TerminalView) { skips += 1; skipsTotal += 1 }
    private(set) var skipsTotal = 0
    private var skips = 0
    func late(_ v: TerminalView, ms: Double) { note(v, String(format: "a resize step drawn %.0f ms after it", ms)) }
    func missed(_ v: TerminalView, ms: Double) { note(v, String(format: "a resize step not drawn at its size (%.0f ms after it)", ms)) }

    private func note(_ v: TerminalView, _ what: String) {
        let now = CACurrentMediaTime()
        if now - lastAt < 10 { more += 1; return }
        lastAt = now
        var since = more > 0 ? " (+\(more) since the last line)" : ""
        if skips > 0 { since += " (\(skips) draws put off for want of a free drawable)" }
        more = 0
        skips = 0
        let px = v.drawnPixels
        let line = "draw: pane \(v.pane) \(what), \(Int(v.bounds.width))x\(Int(v.bounds.height)) pt, last drawn \(Int(px.width))x\(Int(px.height)) px, \(v.outstanding) drawables out (\(v.inTransaction) in the uncommitted transaction)\(since)"
        queue.async { AppInstall.shared.log(line) }
    }
}

/// A context menu item that runs a closure (the terminal's menu).
final class TermMenuItem: NSObject {
    private let run: () -> Void
    private init(_ run: @escaping () -> Void) { self.run = run }
    @objc func fire(_ sender: Any?) { run() }
    static func item(_ title: String, _ run: @escaping () -> Void) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: #selector(fire(_:)), keyEquivalent: "")
        let a = TermMenuItem(run)
        i.target = a
        i.representedObject = a
        return i
    }
}
