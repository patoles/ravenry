// What the Electron app's own pages with words and fields share (inapp.ts
// field(), act(), need(); app.css .pg-b, .sec, .field, .ia-pill, .acts):
// a body that scrolls, its rows drawn again only when what they show
// changed, fields that keep what the person typed (and the keyboard)
// through the redraws, and a click that waits on the hub: every button off
// while it runs, its error said, what the page shows read again after.

import AppKit

/// Words that wrap at the width they are given. Its natural width is the
/// words on one line, whatever width it last wrapped at: a wrapping label's
/// own intrinsic width is its preferred width, so once laid out narrow (a
/// page drawn before it had its width) nothing widened it again and it
/// kept one word a line. Its height is the words wrapped at its preferred
/// width (CappedText sets it from its own width). It gives way below its
/// natural width just before a plain label does (740).
final class WrapField: LinkField {
    convenience init(wrapping s: String) {
        self.init(frame: .zero)
        stringValue = s
        isEditable = false; isBordered = false; drawsBackground = false; isSelectable = false
        cell?.wraps = true; cell?.isScrollable = false; cell?.truncatesLastVisibleLine = false
        usesSingleLineMode = false
        maximumNumberOfLines = 0
        lineBreakMode = .byWordWrapping
        setContentCompressionResistancePriority(.init(740), for: .horizontal)
    }
    override var intrinsicContentSize: NSSize {
        guard let c = cell else { return super.intrinsicContentSize }
        let big = CGFloat.greatestFiniteMagnitude
        let one = c.cellSize(forBounds: NSRect(x: 0, y: 0, width: big, height: big))
        let w = preferredMaxLayoutWidth > 0 ? preferredMaxLayoutWidth : one.width
        let h = c.cellSize(forBounds: NSRect(x: 0, y: 0, width: w, height: big)).height
        return NSSize(width: ceil(one.width), height: ceil(h))
    }
}

/// Words on as many lines as they take, selectable (.sec p, .t2).
func wrap(_ s: String, _ font: NSFont = Fonts.pt(13), _ color: String = "tx") -> CappedText {
    let c = CappedText(s, font, color, maxW: 100000)
    c.setContentHuggingPriority(.init(1), for: .horizontal)
    c.setContentCompressionResistancePriority(.init(1), for: .horizontal)
    return c
}

/// Words on lines `k` times their size apart (a CSS line-height).
@discardableResult
func spaced(_ c: CappedText, _ k: CGFloat) -> CappedText {
    let f = c.text.font ?? Fonts.pt(13)
    let p = NSMutableParagraphStyle()
    p.minimumLineHeight = ceil(f.pointSize * k)
    p.maximumLineHeight = ceil(f.pointSize * k)
    let a = NSMutableAttributedString(attributedString: c.text.attributedStringValue)
    a.addAttribute(.paragraphStyle, value: p, range: NSRange(location: 0, length: a.length))
    // The text sits in the middle of its taller line, as a browser sets it.
    a.addAttribute(.baselineOffset, value: (ceil(f.pointSize * k) - f.ascender + f.descender) / 4, range: NSRange(location: 0, length: a.length))
    c.text.attributedStringValue = a
    return c
}

/// Words at most `maxW` wide, from the left (.ia-msg's max-width), on a
/// bubble (`fill`) as wide as the words, else as wide as the room.
final class CappedText: Flipped {
    let text: NSTextField
    private let maxW: CGFloat, inset: CGFloat
    init(_ s: String, _ font: NSFont, _ color: String, maxW: CGFloat = 720, fill: String? = nil) {
        self.maxW = maxW
        inset = fill == nil ? 0 : 12
        text = WrapField(wrapping: s)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        text.font = font; text.textColor = Design.color(color); text.isSelectable = true; text.drawsBackground = false
        let inner: NSView = fill.map { boxed(text, fill: $0, radius: 10, insets: NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)) } ?? text
        inner.translatesAutoresizingMaskIntoConstraints = false
        addSubview(inner)
        var cs = [inner.leadingAnchor.constraint(equalTo: leadingAnchor), inner.topAnchor.constraint(equalTo: topAnchor), inner.bottomAnchor.constraint(equalTo: bottomAnchor),
                  inner.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor), inner.widthAnchor.constraint(lessThanOrEqualToConstant: maxW)]
        if fill == nil { let w = inner.widthAnchor.constraint(equalTo: widthAnchor); w.priority = .init(700); cs.append(w) }
        NSLayoutConstraint.activate(cs)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func layout() {
        let w = max(40, min(maxW, bounds.width) - 2 * inset)
        if abs(text.preferredMaxLayoutWidth - w) > 0.5 { text.preferredMaxLayoutWidth = w; text.invalidateIntrinsicContentSize() }
        super.layout()
    }
}

/// .ia-pill: a word on a tint, in its colour.
func pill(_ s: String, _ tone: String?) -> Box {
    let fg = tone ?? "tx2", bg = tone.map { "\($0)-t" } ?? "card2"
    let l = label(s, Fonts.pt(11.5, .semibold), fg)
    let b = boxed(l, fill: bg, radius: 10, insets: NSEdgeInsets(top: 2, left: 8, bottom: 2, right: 8))
    b.setContentHuggingPriority(.required, for: .horizontal)
    return b
}

/// .sec: a card with a title (12, 650, tx2) over its rows.
func secBox(_ title: String?, _ rows: [NSView?], ring: String? = nil) -> Box {
    var items: [NSView?] = []
    if let tt = title { items.append(label(tt, Fonts.pt(12, Fonts.w650), "tx2")) }
    let b = boxed(vstack(items + rows, spacing: 8), fill: "card", ring: ring, radius: 10, insets: NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14))
    return b
}

/// .acts: buttons in a row, from the left.
func acts(_ views: [NSView?]) -> NSStackView { hstack(views + [spring()], spacing: 8) }

/// .field (.ta for an area): a text field on --input with a ring, --work while it has the keyboard.
/// A form's text field with an undo of its own (A11Y-011). A form drawn
/// again as it is typed in (New project's name makes the folder's name)
/// puts its fields in new rows, which ends the field editor's editing and
/// takes the field editor's undo with it; this one stays with the field.
/// A run of typing is one step, as in any Mac text field.
final class UndoField: NSTextField {
    let history = UndoManager()
    /// What the field's value changing back does besides (the form drawn again).
    var changed: (() -> Void)?
    private var last = ""
    private var lastChange = Date.distantPast

    /// Edit > Undo and Redo while the field has the keyboard: the field
    /// editor takes neither, so the menu reaches this field before the window.
    @objc func undo(_ sender: Any?) { history.undo() }
    @objc func redo(_ sender: Any?) { history.redo() }
    @objc func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(undo(_:)) { return history.canUndo }
        if item.action == #selector(redo(_:)) { return history.canRedo }
        return true
    }

    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        // The field editor registers nothing of its own here: this field's steps are the ones.
        (currentEditor() as? NSTextView)?.allowsUndo = false
        last = stringValue
        return ok
    }
    override func textDidEndEditing(_ n: Notification) {
        (n.object as? NSTextView)?.allowsUndo = true
        super.textDidEndEditing(n)
    }
    override func textDidChange(_ n: Notification) {
        let now = stringValue, before = last
        if now != before {
            last = now
            if Date().timeIntervalSince(lastChange) > 1 || !history.canUndo { register(before) }
            lastChange = Date()
        }
        super.textDidChange(n)
    }
    private func register(_ value: String) {
        history.registerUndo(withTarget: self) { f in f.restore(value) }
    }
    /// Undo or Redo: the value back, the other one registered the other way.
    private func restore(_ value: String) {
        register(stringValue)
        stringValue = value
        if let ed = currentEditor() {
            ed.string = value
            ed.selectedRange = NSRange(location: (value as NSString).length, length: 0)
        }
        last = value
        lastChange = .distantPast
        changed?()
    }
}

final class FieldBox: Box, NSTextFieldDelegate {
    let field: NSTextField
    let area: Bool
    var onChange: (() -> Void)?
    /// Its ring turns --work while it has the keyboard (.field:focus); off for .dsearch.
    var ringOnFocus = true
    /// `icon`: drawn before the words, in tx3 (.dsearch's search glass).
    init(_ placeholder: String, area: Bool, height: CGFloat? = nil, icon: String? = nil) {
        self.area = area
        let f = area ? UndoField(wrappingLabelWithString: "") : UndoField(string: "")
        field = f
        super.init(fill: "input", ring: "sep", radius: 7)
        translatesAutoresizingMaskIntoConstraints = false
        field.isEditable = true
        field.isSelectable = true
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = Fonts.pt(13)
        field.textColor = Design.color("tx")
        field.placeholderAttributedString = NSAttributedString(string: placeholder, attributes: [.font: Fonts.pt(13), .foregroundColor: Design.color("tx3")])
        field.setAccessibilityLabel(placeholder)
        field.delegate = self
        f.changed = { [weak self] in self?.onChange?() }
        field.translatesAutoresizingMaskIntoConstraints = false
        if area { field.cell?.wraps = true; field.cell?.isScrollable = false; field.usesSingleLineMode = false }
        else { field.cell?.wraps = false; field.cell?.isScrollable = true; field.usesSingleLineMode = true }
        addSubview(field)
        var lead: CGFloat = 10
        if let name = icon {
            let ic = Icon(name, "tx3", size: 14)
            ic.translatesAutoresizingMaskIntoConstraints = false
            addSubview(ic)
            NSLayoutConstraint.activate([ic.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10), ic.centerYAnchor.constraint(equalTo: centerYAnchor)])
            lead = 32
        }
        let h = height ?? (area ? 90 : 32)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: h),
            field.leadingAnchor.constraint(equalTo: leadingAnchor, constant: lead),
            field.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            area ? field.topAnchor.constraint(equalTo: topAnchor, constant: 8) : field.centerYAnchor.constraint(equalTo: centerYAnchor),
            area ? field.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -8) : field.heightAnchor.constraint(greaterThanOrEqualToConstant: 18),
        ])
        field.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        setContentHuggingPriority(.init(1), for: .horizontal)
    }
    required init?(coder: NSCoder) { fatalError() }
    var text: String { get { field.stringValue } set { field.stringValue = newValue } }
    func controlTextDidBeginEditing(_ n: Notification) { if ringOnFocus { ring = "work"; ringWidth = 1.5 } }
    func controlTextDidEndEditing(_ n: Notification) { ring = "sep"; ringWidth = 1 }
    func controlTextDidChange(_ n: Notification) { onChange?() }
    /// Return in an area is a new line (a textarea's); in a field, what Send does.
    var onReturn: (() -> Void)?
    func control(_ c: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) {
            if area { textView.insertNewlineIgnoringFieldEditor(nil); return true }
            onReturn?(); return onReturn != nil
        }
        return false
    }
    override func mouseDown(with e: NSEvent) { window?.makeFirstResponder(field) }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
}

/// .ia-sw: an on/off switch (role switch).
final class Switch: NSView {
    var on: Bool { didSet { needsDisplay = true; setAccessibilityValue(on) } }
    var enabled = true { didSet { needsDisplay = true } }
    var run: (() -> Void)?
    init(_ on: Bool, label: String, run: @escaping () -> Void) {
        self.on = on; self.run = run
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 34).isActive = true
        heightAnchor.constraint(equalToConstant: 20).isActive = true
        setAccessibilityElement(true)
        setAccessibilityRole(.checkBox)
        setAccessibilitySubrole(.switch)
        setAccessibilityLabel(label)
        setAccessibilityValue(on)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ r: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let track = NSBezierPath(roundedRect: bounds, xRadius: 10, yRadius: 10)
            (on ? Design.color("ok") : Design.color("card2")).withAlphaComponent(enabled ? 1 : 0.5).setFill()
            track.fill()
            if !on { Design.color("sep").setStroke(); let i = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 9.5, yRadius: 9.5); i.lineWidth = 1; i.stroke() }
            let knob = NSRect(x: on ? 16 : 2, y: 2, width: 16, height: 16)
            NSColor(srgbRed: 0xF2 / 255, green: 0xF2 / 255, blue: 0xF4 / 255, alpha: 1).setFill()
            NSBezierPath(ovalIn: knob).fill()
        }
    }
    override func mouseDown(with e: NSEvent) { if enabled { run?() } }
    override func resetCursorRects() { handCursor(enabled) }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { if enabled { run?() }; return true }
}

/// A page of words, fields and buttons over the hub's routes.
class FormPage: InAppPage {
    var hub: HubClient?
    var toast: ((String) -> Void)?
    let scroll = StackScroll(spacing: 14, insets: NSEdgeInsets(top: 0, left: 22, bottom: 20, right: 22))
    /// The fields by id: the same ones drawn again, so what is typed and the keyboard stay.
    private(set) var fields: [String: FieldBox] = [:]
    /// The click that waits on the hub, else "".
    private(set) var busy = ""
    private var drawn = ""
    private var timer: Timer?

    override init() {
        super.init()
        scroll.automaticallyAdjustsContentInsets = false
        body.addSubview(scroll)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layoutBody() { scroll.frame = body.bounds }

    /// A field kept by id (what was typed in it stays).
    func field(_ id: String, _ placeholder: String, area: Bool = false, height: CGFloat? = nil, icon: String? = nil) -> FieldBox {
        if let f = fields[id] { return f }
        let f = FieldBox(placeholder, area: area, height: height, icon: icon)
        fields[id] = f
        return f
    }
    func typed(_ id: String) -> String { (fields[id]?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
    func clear(_ id: String) { fields[id]?.text = "" }
    /// An empty field: it gets the keyboard and the toast says what goes in it.
    func need(_ id: String, _ text: String) -> Bool {
        if !typed(id).isEmpty { return false }
        if let f = fields[id] { window?.makeFirstResponder(f.field) }
        toast?(text)
        return true
    }

    /// The head and rows, drawn again only when `sig` changed (the scroll, the keyboard stay).
    func draw(_ sig: String, _ rows: () -> [NSView]) {
        if sig == drawn { return }
        drawn = sig
        let had = fields.first { k in (window?.firstResponder as? NSTextView)?.delegate === k.value.field }?.key
        let sel = (window?.firstResponder as? NSTextView)?.selectedRange()
        scroll.set(rows())
        if let k = had, let f = fields[k], f.window != nil {
            window?.makeFirstResponder(f.field)
            if let s = sel, let ed = f.field.currentEditor() { ed.selectedRange = NSRange(location: min(s.location, f.text.utf16.count), length: 0) }
        }
        needsLayout = true
    }
    /// Drawn again at the next draw whatever it shows.
    func dirty() { drawn = "" }

    /// What the page shows read again from the hub (each page its own), then drawn.
    func load() {}
    /// Read again every `every` seconds while the page shows, else never.
    func poll(_ every: TimeInterval?) {
        timer?.invalidate(); timer = nil
        guard let s = every else { return }
        timer = Timer.scheduledTimer(withTimeInterval: s, repeats: true) { [weak self] _ in
            guard let self, self.window != nil, !self.isHidden else { return }
            self.load()
        }
    }
    override func viewDidHide() { super.viewDidHide(); timer?.invalidate(); timer = nil }

    /// A click that waits on the hub: off while it runs, its error said, the page read again after.
    func act(_ name: String, _ path: String, _ body: [String: Any], done: (([String: Any]) -> Void)? = nil) {
        guard busy.isEmpty, let hub else { return }
        busy = name
        dirty(); redraw()
        hub.post(path, body) { [weak self] code, j in
            guard let self else { return }
            if code != 200 { self.toast?(j["error"] as? String ?? t("page.didNotWork")) } else { done?(j) }
            self.busy = ""
            self.dirty(); self.redraw()
            self.load()
        }
    }
    /// Each page draws itself again from what it has.
    func redraw() {}
}

/// Views of fixed sizes left to right, onto the next line when the width is
/// used (flex-wrap), as tall as its lines (an idea's pictures).
final class WrapRow: Flipped {
    let gap: CGFloat
    private let items: [(view: NSView, size: NSSize)]
    private var height: CGFloat = 0
    init(_ items: [(NSView, NSSize)], gap: CGFloat = 8) {
        self.items = items.map { (view: $0.0, size: $0.1) }
        self.gap = gap
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        for (v, _) in items { v.translatesAutoresizingMaskIntoConstraints = true; addSubview(v) }
        height = place(10000, apply: false)
    }
    required init?(coder: NSCoder) { fatalError() }
    /// The height for width `w`; `apply`: the views put there.
    private func place(_ w: CGFloat, apply: Bool) -> CGFloat {
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0
        for it in items {
            let s = NSSize(width: min(it.size.width, max(40, w)), height: it.size.width > w && w > 0 ? it.size.height * w / it.size.width : it.size.height)
            if x > 0 && x + s.width > w { x = 0; y += line + gap; line = 0 }
            if apply { it.view.frame = NSRect(origin: NSPoint(x: x, y: y), size: s) }
            x += s.width + gap
            line = max(line, s.height)
        }
        return items.isEmpty ? 0 : y + line
    }
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: height) }
    override func layout() {
        super.layout()
        let h = place(bounds.width, apply: true)
        if abs(h - height) > 0.5 { height = h; invalidateIntrinsicContentSize() }
    }
}
