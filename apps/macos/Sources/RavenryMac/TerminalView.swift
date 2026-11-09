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
    private(set) var channel: UInt32 = 0
    private(set) var pane = ""

    private var grid = (cols: 0, rows: 0)
    private var drawPending = false
    private let drawLock = NSLock()
    private var ackedSeq: UInt32 = 0
    private var lastBell: UInt32 = 0
    private var lastTitle = ""
    private var cursorOn = true
    private var blinkTimer: Timer?
    private var focused = true

    var selection: Selection?
    private var selecting = false
    private var selectAnchor: (x: Int, y: Int)?
    private var selectUnit = 1

    private var marked = NSMutableAttributedString()
    private var keyTexts: [String]?
    private var scrollAccum: CGFloat = 0
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
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self, userInfo: nil))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func makeBackingLayer() -> CALayer { metalLayer }

    override var acceptsFirstResponder: Bool { true }
    override var isOpaque: Bool { true }
    override var isFlipped: Bool { true }

    // MARK: the stream

    /// Starts drawing a pane: its render stream at this view's size.
    func attach(_ c: Connection, pane id: String, fps: Int) throws {
        conn = c
        pane = id
        c.onBinary = { [weak self] p in self?.binary(p) }
        grid = renderer.grid(for: bounds.size)
        let r = try c.call("pane.render", ["pane": id, "cols": grid.cols, "rows": grid.rows, "fps": fps, "window": 2])
        channel = (r["channel"] as? NSNumber)?.uint32Value ?? 0
    }

    private func binary(_ p: UnsafeRawBufferPointer) {
        // The frame header (PROTOCOL.md section 5): version, kind,
        // channel, mark; then the render frame.
        guard p.count >= 14, p[1] == 4 else { return }
        let ch = UInt32(p[2]) << 24 | UInt32(p[3]) << 16 | UInt32(p[4]) << 8 | UInt32(p[5])
        guard ch == channel else { return }
        screen.lock()
        do {
            try screen.apply(UnsafeRawBufferPointer(rebasing: p[14...]))
        } catch {
            NSLog("RavenryMac: bad frame: \(error)")
        }
        screen.unlock()
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
        if drawScheduled { return }
        let now = CACurrentMediaTime()
        let due = lastDraw + refreshInterval * 0.9
        if now >= due {
            draw(sync: inLiveResize && !offscreen)
            return
        }
        drawScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + (due - now)) { [weak self] in
            guard let self else { return }
            self.drawScheduled = false
            self.draw(sync: self.inLiveResize && !self.offscreen)
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
        guard bounds.width > 0, bounds.height > 0, let cb = renderer.queue.makeCommandBuffer() else { return }
        let overlay = Overlay(selection: selection, focused: focused, cursorOn: cursorOn, marked: marked.string)
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
        if seq != ackedSeq, let c = conn {
            ackedSeq = seq
            c.sendJSON(["v": 1, "type": "ack", "channel": channel, "frame": seq])
        }
        screen.lock()
        let title = screen.title, bell = screen.bell, blink = screen.cursor.blink
        screen.unlock()
        if title != lastTitle {
            lastTitle = title
            onTitle?(title)
        }
        if bell != lastBell {
            if bell > lastBell && !offscreen { NSSound.beep() }
            lastBell = bell
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
        if blink && focused && !offscreen {
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
        let g = renderer.grid(for: bounds.size)
        if g != grid {
            grid = g
            if let c = conn, !pane.isEmpty {
                c.request("pane.resize", ["pane": pane, "cols": g.cols, "rows": g.rows])
            }
        }
        // Draw what we have at the new size now, in the window's
        // transaction during a live resize; the reflowed rows follow.
        guard conn != nil else { return }
        if inLiveResize && !offscreen { draw(sync: true) } else { requestDraw() }
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
        renderer.setFontSize(s)
        if keepsFontSize {
            UserDefaults.standard.set(Double(s), forKey: TerminalView.fontSizeKey)
        }
        sizeChanged()
    }

    // MARK: focus

    override func becomeFirstResponder() -> Bool {
        setFocus(true)
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
        if let u = e.characters(byApplyingModifiers: [])?.unicodeScalars.first, KeyCodes.printable(u) {
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
        switch key {
        case "=", "+": increaseFontSize(nil)
        case "-": decreaseFontSize(nil)
        case "0": resetFontSize(nil)
        default: return false
        }
        return true
    }

    override func keyDown(with e: NSEvent) {
        if e.modifierFlags.contains(.command) && shortcut(e) { return }
        wakeCursor()
        if wantOffset > 0 { scrollTo(0) }
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
        if e.modifierFlags.contains(.control) && !e.modifierFlags.contains(.command) && window?.firstResponder === self {
            keyDown(with: e)
            return true
        }
        if window?.firstResponder === self && shortcut(e) { return true }
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

    @objc func copy(_ sender: Any?) {
        guard let sel = selection, let c = conn else { return }
        let (x0, y0, x1, y1) = sel.ordered
        c.request("render.text", ["channel": channel, "from": ["x": x0, "y": y0], "to": ["x": x1, "y": y1], "rect": sel.rect]) { r in
            if case .success(let v) = r, let t = v["text"] as? String {
                DispatchQueue.main.async {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(t, forType: .string)
                }
            }
        }
    }

    @objc func paste(_ sender: Any?) {
        guard let s = NSPasteboard.general.string(forType: .string), !s.isEmpty else { return }
        pasteText(s)
    }

    func pasteText(_ s: String) {
        if wantOffset > 0 { scrollTo(0) }
        sendEvents([["paste": s]])
    }

    @objc override func selectAll(_ sender: Any?) {
        screen.lock()
        let total = screen.history + screen.rows
        let cols = screen.cols
        screen.unlock()
        selection = Selection(start: (0, 0), end: (cols - 1, total - 1))
        requestDraw()
    }

    // MARK: mouse

    /// The cell under a point: its column, its row in screen coordinates,
    /// and the point from the grid's corner.
    private func cell(_ e: NSEvent) -> (x: Int, y: Int, px: CGPoint) {
        let p = convert(e.locationInWindow, from: nil)
        let s = renderer.fonts.scale
        let cw = renderer.fonts.cellWidth / s, ch = renderer.fonts.cellHeight / s
        screen.lock()
        let cols = screen.cols, rows = screen.rows, top = screen.history - screen.offset
        screen.unlock()
        let x = max(0, min(cols - 1, Int((p.x - renderer.padding) / cw)))
        let row = max(0, min(rows - 1, Int((p.y - renderer.padding) / ch)))
        return (x, top + row, CGPoint(x: max(0, p.x - renderer.padding), y: max(0, p.y - renderer.padding)))
    }

    private var mouseReporting: Bool {
        screen.lock()
        defer { screen.unlock() }
        return screen.modes & Screen.modeMouse != 0
    }

    private func mouseEvent(_ e: NSEvent, action: String, button: String, held: Bool = false) -> [String: Any] {
        let c = cell(e)
        let s = renderer.fonts.scale
        var m: [String: Any] = ["action": action, "x": Double(c.px.x), "y": Double(c.px.y),
                                "cell_width": Double(renderer.fonts.cellWidth / s), "cell_height": Double(renderer.fonts.cellHeight / s)]
        if !button.isEmpty { m["button"] = button }
        let md = mods(e.modifierFlags) & 15
        if md != 0 { m["mods"] = md }
        if held { m["held"] = true }
        return ["mouse": m]
    }

    override func mouseDown(with e: NSEvent) {
        window?.makeFirstResponder(self)
        if mouseReporting && !e.modifierFlags.contains(.shift) {
            sendEvents([mouseEvent(e, action: "press", button: "left")])
            return
        }
        let c = cell(e)
        selectUnit = min(e.clickCount, 3)
        if e.modifierFlags.contains(.shift), let sel = selection {
            selection = Selection(start: sel.start, end: (c.x, c.y), rect: e.modifierFlags.contains(.option))
        } else if e.clickCount == 1 {
            selection = nil
        } else {
            selection = expand(c.x, c.y, unit: selectUnit)
        }
        selectAnchor = (c.x, c.y)
        selecting = true
        requestDraw()
    }

    override func mouseDragged(with e: NSEvent) {
        if !selecting {
            screen.lock()
            let drag = screen.modes & (Screen.modeMouseDrag | Screen.modeMouseMotion) != 0
            screen.unlock()
            if drag && mouseReporting { sendEvents([mouseEvent(e, action: "motion", button: "left", held: true)]) }
            return
        }
        guard let a = selectAnchor else { return }
        let c = cell(e)
        if selectUnit > 1, let s1 = expand(a.x, a.y, unit: selectUnit), let s2 = expand(c.x, c.y, unit: selectUnit) {
            let forward = c.y > a.y || (c.y == a.y && c.x >= a.x)
            selection = forward ? Selection(start: s1.start, end: s2.end) : Selection(start: s1.end, end: s2.start)
        } else {
            selection = Selection(start: a, end: (c.x, c.y), rect: e.modifierFlags.contains(.option))
        }
        requestDraw()
    }

    override func mouseUp(with e: NSEvent) {
        if !selecting {
            if mouseReporting { sendEvents([mouseEvent(e, action: "release", button: "left")]) }
            return
        }
        selecting = false
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
        screen.lock()
        let motion = screen.modes & Screen.modeMouseMotion != 0
        screen.unlock()
        if motion { sendEvents([mouseEvent(e, action: "motion", button: "")]) }
    }

    /// A word (two clicks) or a line (three) around a cell.
    private func expand(_ x: Int, _ y: Int, unit: Int) -> Selection? {
        screen.lock()
        defer { screen.unlock() }
        let row = y - (screen.history - screen.offset)
        if unit >= 3 { return Selection(start: (0, y), end: (screen.cols - 1, y)) }
        guard unit == 2, row >= 0, row < screen.lines.count else { return Selection(start: (x, y), end: (x, y)) }
        let line = screen.lines[row]
        func isWord(_ c: Cell) -> Bool {
            if c.flags & Cell.spacer != 0 { return true }
            if c.g == 0 || c.g == 32 { return false }
            if c.g < 128, let u = Unicode.Scalar(c.g) { return !" \t\"'`()[]{}<>|;,".unicodeScalars.contains(u) }
            return true
        }
        guard x < line.count, isWord(line[x]) else { return Selection(start: (x, y), end: (x, y)) }
        var a = x, b = x
        while a > 0 && isWord(line[a - 1]) { a -= 1 }
        while b + 1 < line.count && isWord(line[b + 1]) { b += 1 }
        return Selection(start: (a, y), end: (b, y))
    }

    // MARK: scrolling

    private var wantOffset = 0

    func scrollTo(_ offset: Int) {
        wantOffset = max(0, offset)
        conn?.request("render.scroll", ["channel": channel, "offset": wantOffset])
    }

    override func scrollWheel(with e: NSEvent) {
        let s = renderer.fonts.scale
        let ch = renderer.fonts.cellHeight / s
        var dy = e.scrollingDeltaY
        if !e.hasPreciseScrollingDeltas { dy *= ch }
        scrollAccum += dy
        let lines = Int(scrollAccum / ch)
        if lines == 0 { return }
        scrollAccum -= CGFloat(lines) * ch
        screen.lock()
        let modes = screen.modes, history = screen.history
        screen.unlock()
        if modes & Screen.modeMouse != 0 {
            let ev = mouseEvent(e, action: "press", button: lines > 0 ? "wheel_up" : "wheel_down")
            sendEvents([[String: Any]](repeating: ev, count: min(abs(lines), 10)))
        } else if modes & Screen.modeAltScreen != 0 {
            // A full-screen program with no mouse: the wheel is arrow keys.
            let ev: [String: Any] = ["key": ["code": lines > 0 ? "ArrowUp" : "ArrowDown"]]
            sendEvents([[String: Any]](repeating: ev, count: min(abs(lines), 10)))
        } else {
            scrollTo(max(0, min(history, wantOffset + lines)))
        }
    }
}
