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
    /// A split's divider is being dragged: draw in the window's
    /// transaction, as during a live resize.
    var splitDragging = false {
        didSet { if !splitDragging && oldValue { metalLayer.presentsWithTransaction = false; requestDraw() } }
    }
    private var resizing: Bool { (inLiveResize || splitDragging) && !offscreen }
    /// The view took the keyboard (a click, or the window's focus).
    var onFocus: (() -> Void)?

    private var grid = (cols: 0, rows: 0)
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
    var onTitle: ((String) -> Void)?
    var onFrame: (() -> Void)?

    /// The font size Cmd+0 goes back to, and whether a size the person
    /// picks is kept for the next launch (never for the bench and the
    /// self-test).
    var defaultFontSize: CGFloat = 12
    var keepsFontSize = false
    static let fontSizeKey = "fontSize"

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
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self, userInfo: nil))
    }

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
        screen.lock()
        // The new stream's frames count from 1: no ack of the old one's.
        screen.seq = 0
        screen.unlock()
        ackedSeq = 0
        if bounds.width > 0 && bounds.height > 0 { draw(sync: !offscreen && window != nil) }
        let sent = grid
        chLock.lock()
        wantsStream = true
        chLock.unlock()
        let sem = wait ? DispatchSemaphore(value: 0) : nil
        c.request("pane.render", ["pane": pane, "cols": sent.cols, "rows": sent.rows, "fps": fps, "window": 2,
                                  // Cmd+Left to the line's start and the rest of a Mac's keys
                                  // (docs/RENDERING.md, Key bindings): the daemon's table.
                                  "keybinds": "macos"]) { [weak self, weak c] r in
            defer { sem?.signal() }
            guard let self, let c, case .success(let res) = r, let ch = (res["channel"] as? NSNumber)?.uint32Value else { return }
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
        if let sem { _ = sem.wait(timeout: .now() + 10) }
    }

    /// Hides the pane: its stream ends and the view stops drawing; the
    /// rows stay for the next resume.
    func pause() {
        guard live else { return }
        live = false
        chLock.lock()
        wantsStream = false
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
    }

    private func binary(_ p: UnsafeRawBufferPointer) {
        // The frame header (PROTOCOL.md section 5): version, kind,
        // channel, mark; then the render frame.
        guard p.count >= 14, p[1] == 4 else { return }
        let ch = UInt32(p[2]) << 24 | UInt32(p[3]) << 16 | UInt32(p[4]) << 8 | UInt32(p[5])
        guard ch != 0, ch == channel else { return }
        screen.lock()
        do {
            try screen.apply(UnsafeRawBufferPointer(rebasing: p[14...]))
        } catch {
            NSLog("RavenryMac: bad frame: \(error)")
        }
        let view = (screen.offset, screen.history)
        screen.unlock()
        if EventLog.shared.enabled && CACurrentMediaTime() - lastWheelAt < 2 && view != loggedView {
            loggedView = view
            EventLog.shared.write("frame offset \(view.0) history \(view.1)")
        }
        onFrame?()
        scheduleDraw()
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
        guard live, bounds.width > 0, bounds.height > 0, let cb = renderer.queue.makeCommandBuffer() else { return }
        let overlay = Overlay(focused: focused, cursorOn: cursorOn, marked: marked.string, scrollbar: scrollbarAlpha, link: link?.range,
                              flash: bellFlashing)
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
            metalLayer.presentsWithTransaction = sync
            guard let drawable = metalLayer.nextDrawable() else { return }
            seq = renderer.encode(screen: screen, overlay: overlay, into: drawable.texture, commandBuffer: cb)
            if sync {
                cb.commit()
                cb.waitUntilScheduled()
                drawable.present()
            } else {
                cb.present(drawable)
                cb.commit()
            }
        }
        lastDraw = CACurrentMediaTime()
        let cpu = (lastDraw - t0) * 1000
        afterDraw(seq)
        onDraw?(seq, cpu)
    }

    private func afterDraw(_ seq: UInt32) {
        let ch = channel
        if seq != ackedSeq, seq != 0, ch != 0, let c = conn {
            ackedSeq = seq
            c.sendJSON(["v": 1, "type": "ack", "channel": ch, "frame": seq])
        }
        screen.lock()
        let title = screen.title, bell = screen.bell, blink = screen.cursor.blink
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
        if let last = lastBell, bell > last {
            bellAt = CACurrentMediaTime()
            requestDraw()
            DispatchQueue.main.asyncAfter(deadline: .now() + TerminalView.bellFlash + 0.01) { [weak self] in self?.requestDraw() }
        }
        lastBell = bell
        if rowsVersion != a11yVersion {
            a11yVersion = rowsVersion
            announceValue()
        }
        updateBlink(blink)
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
        sizeChanged()
    }

    private func sizeChanged() {
        metalLayer.drawableSize = pixelSize
        placeFindBar()
        let g = renderer.grid(for: bounds.size)
        if g != grid {
            grid = g
            // A hidden pane is resized when it shows (resume).
            if let c = conn, !pane.isEmpty, live, channel != 0 {
                c.request("pane.resize", ["pane": pane, "cols": g.cols, "rows": g.rows])
            }
        }
        // Draw what we have at the new size now, in the window's
        // transaction during a live resize; the reflowed rows follow.
        guard conn != nil, live else { return }
        if resizing { draw(sync: true) } else { requestDraw() }
    }

    override func viewDidEndLiveResize() {
        super.viewDidEndLiveResize()
        metalLayer.presentsWithTransaction = false
        requestDraw()
    }

    var gridSize: (cols: Int, rows: Int) { grid }

    // MARK: font size

    @objc func increaseFontSize(_ sender: Any?) { setFontSize(renderer.fontSize + 1) }
    @objc func decreaseFontSize(_ sender: Any?) { setFontSize(renderer.fontSize - 1) }
    @objc func resetFontSize(_ sender: Any?) { setFontSize(defaultFontSize) }

    /// A new size, 6 to 72 points: the cell, the grid and the pane's size
    /// follow.
    func setFontSize(_ size: CGFloat) {
        let s = min(72, max(6, size.rounded()))
        guard s != renderer.fontSize else { return }
        if keepsFontSize {
            UserDefaults.standard.set(Double(s), forKey: TerminalView.fontSizeKey)
        }
        // Every pane of the window takes it (onFontSize), as the Electron
        // app's text size is the terminals'.
        if let f = onFontSize { f(s) } else { applyFontSize(s) }
    }

    /// The window's panes all follow a new text size.
    var onFontSize: ((CGFloat) -> Void)?

    func applyFontSize(_ s: CGFloat) {
        guard s != renderer.fontSize else { return }
        renderer.setFontSize(s)
        updateMinSize()
        sizeChanged()
    }

    /// The window's smallest content size when the window lays out more
    /// than this view (tabs, splits).
    var windowMinSize: (() -> NSSize)?

    /// The smallest grid the window may be dragged to, as Rex has one.
    static let minGrid = (cols: 40, rows: 10)

    /// The window's smallest content size: minGrid at the current font.
    var minContentSize: NSSize {
        let s = renderer.fonts.scale
        return NSSize(width: ceil(CGFloat(TerminalView.minGrid.cols) * renderer.fonts.cellWidth / s + 2 * renderer.padding),
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
            if flags.contains(.option) && optionAsAlt.isEmpty { consumed |= 4 }
        }
        if consumed != 0 { ev["consumed"] = consumed }
        // A modifier key's flagsChanged event has no characters (AppKit
        // throws when asked).
        if e.type == .keyDown || e.type == .keyUp,
           let u = e.characters(byApplyingModifiers: [])?.unicodeScalars.first, KeyCodes.printable(u) {
            ev["unshifted"] = Int(u.value)
        }
        if !optionAsAlt.isEmpty { ev["option_as_alt"] = optionAsAlt }
        return ["key": ev]
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
        wakeCursor()
        let hadMarked = hasMarkedText()
        if !optionAsAlt.isEmpty && e.modifierFlags.contains(.option) && !hadMarked {
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
            if cmd, let p = pointer ?? window?.mouseLocationOutsideOfEventStream {
                hoverLink(cell(at: p))
            } else {
                clearLink()
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
        // The find keys also work while the find bar has the keyboard.
        if findBarVisible, findShortcut(e) == true { return true }
        return super.performKeyEquivalent(with: e)
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
        if e.modifierFlags.contains(.command) {
            // Cmd+click opens the link there; it never selects.
            openLink(at: cell(e))
            return
        }
        if mouseReporting && !e.modifierFlags.contains(.shift) {
            sendEvents([mouseEvent(e, action: "press", button: "left")])
            return
        }
        selecting = true
        sendEvents([selectEvent(e, action: "press")])
    }

    override func mouseDragged(with e: NSEvent) {
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
            return
        }
        selecting = false
        stopAutoscroll()
        lastDrag = nil
        sendEvents([selectEvent(e, action: "release")])
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
        pointer = e.locationInWindow
        commandDown = e.modifierFlags.contains(.command)
        if commandDown { hoverLink(cell(e)) } else { clearLink() }
        screen.lock()
        let motion = screen.modes & Screen.modeMouseMotion != 0
        screen.unlock()
        if motion { sendEvents([mouseEvent(e, action: "motion", button: "")]) }
    }

    // MARK: find

    /// The find bar, made on the first Cmd+F.
    private(set) var findBar: FindBar?
    private(set) var findNeedle = ""
    /// The count and selected match from the last render.find, or the
    /// frames' find section since.
    private(set) var findCount = 0, findSelected = -1

    var findBarVisible: Bool { findBar.map { !$0.isHidden } ?? false }

    @objc func showFindBar(_ sender: Any?) {
        let bar = findBar ?? makeFindBar()
        bar.isHidden = false
        placeFindBar()
        window?.invalidateCursorRects(for: self)
        window?.makeFirstResponder(bar.field)
        bar.field.currentEditor()?.selectAll(nil)
        if !findNeedle.isEmpty { find(step: 0) }
    }

    private func makeFindBar() -> FindBar {
        let bar = FindBar()
        bar.autoresizingMask = [.minXMargin, .maxYMargin]
        bar.onChange = { [weak self] s in self?.findChanged(s) }
        bar.onNext = { [weak self] in self?.findNext(nil) }
        bar.onPrevious = { [weak self] in self?.findPrevious(nil) }
        bar.onClose = { [weak self] in self?.closeFindBar() }
        addSubview(bar)
        findBar = bar
        return bar
    }

    private func placeFindBar() {
        guard let bar = findBar else { return }
        let sz = FindBar.size
        bar.frame = NSRect(x: max(0, bounds.width - sz.width - 12), y: 8, width: sz.width, height: sz.height)
    }

    /// What to find changed: the first character selects the newest
    /// match (step 1), and the search keeps it after.
    func findChanged(_ s: String) {
        let first = findNeedle.isEmpty
        findNeedle = s
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
        let needle = findNeedle
        c.request("render.find", ["channel": channel, "needle": needle, "step": step]) { [weak self] r in
            guard case .success(let v) = r else { return }
            let n = (v["count"] as? NSNumber)?.intValue ?? 0, sel = (v["selected"] as? NSNumber)?.intValue ?? -1
            DispatchQueue.main.async {
                guard let self, needle == self.findNeedle else { return }
                self.findCount = n
                self.findSelected = sel
                self.findBar?.show(count: n, selected: sel, needle: needle)
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
        findCount = 0
        findSelected = -1
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
    }

    // MARK: the bell

    var bellFlashing: Bool { CACurrentMediaTime() - bellAt < TerminalView.bellFlash }

    // MARK: the context menu and Clear

    /// Right click, when the program does not take the mouse.
    override func menu(for event: NSEvent) -> NSMenu? {
        if mouseReporting { return nil }
        let m = NSMenu(title: "Terminal")
        for (title, action) in [("Copy", #selector(copy(_:))), ("Paste", #selector(paste(_:))),
                                ("Select All", #selector(selectAll(_:))), ("", nil), ("Clear", #selector(clearScreen(_:))),
                                ("Find…", #selector(showFindBar(_:)))] as [(String, Selector?)] {
            if action == nil {
                m.addItem(.separator())
                continue
            }
            m.addItem(withTitle: title, action: action, keyEquivalent: "").target = self
        }
        return m
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

    override func resetCursorRects() {
        for (r, c) in cursorRegions() { addCursorRect(r, cursor: c) }
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
        let c: NSCursor = linkCursor ? .pointingHand : .iBeam
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
            guard let self, self.commandDown, let a = self.linkAsked, a.x == c.x, a.y == c.y else { return }
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
        if !offscreen { (on ? NSCursor.pointingHand : NSCursor.iBeam).set() }
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

    /// Opens a link's URI: only the web and files.
    private func open(_ uri: String) {
        guard let u = URL(string: uri), let scheme = u.scheme?.lowercased(), ["http", "https", "file"].contains(scheme) else { return }
        openURL(u)
    }

    // MARK: scrolling

    /// Every wheel and trackpad movement, momentum included, goes to the
    /// daemon in rows (positive: up, toward older output); the daemon
    /// decides, as Ghostty does, whether the program gets it, it becomes
    /// arrow keys on the alternate screen, or the view scrolls.
    override func scrollWheel(with e: NSEvent) {
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
