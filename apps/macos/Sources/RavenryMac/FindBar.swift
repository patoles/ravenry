// The find bar (Cmd+F), as the Electron app's .findbar: a small card at
// the top right of the terminal in the app's own colours (light or dark),
// with the search icon, the text to find (a one-line selection fills it,
// TerminalView.showFindBar), the count ("3 of 11"), previous and next with
// their keys in their tips, Match case (Aa) and Regular expression (.*),
// and close. It only takes what the person types; the search is the
// daemon's (render.find) and the matches come in the frames. A line under
// the bar says what is wrong when something is: a pattern that does not
// parse, or a toggle a tab's older daemon does not have.

import AppKit

/// The find field's editor: Enter is the next match, Shift+Enter the
/// previous one, Esc closes, from the key event itself.
final class FindFieldEditor: NSTextView {
    var onReturn: ((_ shift: Bool) -> Void)?
    var onEscape: (() -> Void)?
    /// It took the keyboard, or gave it up.
    var onFocus: ((Bool) -> Void)?

    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { onFocus?(true) }
        return ok
    }
    override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        if ok { onFocus?(false) }
        return ok
    }

    override func keyDown(with e: NSEvent) {
        switch e.keyCode {
        case 0x24, 0x4C: onReturn?(e.modifierFlags.contains(.shift))
        case 0x35: onEscape?()
        default: super.keyDown(with: e)
        }
    }
}

private final class FindFieldCell: NSTextFieldCell {
    let editor: FindFieldEditor = {
        let e = FindFieldEditor()
        e.isFieldEditor = true
        return e
    }()

    override func fieldEditor(for controlView: NSView) -> NSTextView? { editor }
}

final class FindBar: NSView, NSTextFieldDelegate {
    let field = NSTextField()
    let count = NSTextField(labelWithString: "")
    private(set) var previous: NSButton!
    private(set) var next: NSButton!
    private(set) var close: NSButton!
    /// Match case (Aa) and Regular expression (.*), as .fb-t.
    private(set) var matchCase: FindToggle!
    private(set) var regex: FindToggle!
    /// The line under the bar: a pattern that does not parse, or a toggle
    /// this tab's daemon does not have. Empty: no line.
    let problem = NSTextField(labelWithString: "")
    /// The field's well (.findbar input): the input colour, ringed, the accent while typing.
    private let well = NSView()
    private let icon = NSImageView()
    private let rule = NSView()
    private let rule2 = NSView()

    /// The arrow over the bar and its buttons; the text field sets its
    /// own I-beam.
    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .arrow)
    }

    var onChange: ((String) -> Void)?
    var onNext: (() -> Void)?
    var onPrevious: (() -> Void)?
    var onClose: (() -> Void)?
    /// A toggle was pressed (it says which: matchCase or regex).
    var onToggle: ((FindToggle) -> Void)?

    /// .findbar: 10 pt radius on the card's colour, ringed and shadowed;
    /// the search icon, the field, the count, previous, next, Aa, .*, and
    /// close; 20 pt taller with the line under it.
    static let size = NSSize(width: 448, height: 34)
    static let problemHeight: CGFloat = 20

    var editor: FindFieldEditor { (field.cell as! FindFieldCell).editor }

    init() {
        super.init(frame: NSRect(origin: .zero, size: FindBar.size))
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.borderWidth = 1
        let sh = NSShadow()
        sh.shadowBlurRadius = 12
        sh.shadowOffset = NSSize(width: 0, height: -6)
        sh.shadowColor = NSColor.black.withAlphaComponent(0.3)
        shadow = sh

        icon.image = SharedIcons.image("search", color: "tx3", size: 13)
        icon.frame = NSRect(x: 10, y: 10, width: 14, height: 14)
        addSubview(icon)

        well.wantsLayer = true
        well.layer?.cornerRadius = 6
        well.frame = NSRect(x: 30, y: 5, width: 196, height: 24)
        addSubview(well)
        let cell = FindFieldCell(textCell: "")
        cell.isEditable = true
        cell.isScrollable = true
        cell.usesSingleLineMode = true
        cell.isBezeled = false
        cell.drawsBackground = false
        cell.placeholderString = t("find.placeholder")
        field.cell = cell
        field.font = NSFont.systemFont(ofSize: 12.5)
        field.focusRingType = .none
        field.delegate = self
        field.frame = NSRect(x: 38, y: 9, width: 182, height: 17)
        field.setAccessibilityLabel(t("find.fieldA"))
        addSubview(field)
        editor.onReturn = { [weak self] shift in shift ? self?.onPrevious?() : self?.onNext?() }
        editor.onEscape = { [weak self] in self?.onClose?() }
        editor.onFocus = { [weak self] on in self?.typing = on }

        count.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        count.alignment = .center
        count.frame = NSRect(x: 228, y: 9, width: 72, height: 16)
        addSubview(count)

        func button(_ symbol: String, _ tip: String, _ label: String, _ x: CGFloat, _ action: Selector) -> NSButton {
            let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label) ?? NSImage()
            let b = NSButton(image: image, target: self, action: action)
            b.isBordered = false
            b.bezelStyle = .regularSquare
            b.toolTip = tip
            b.setAccessibilityLabel(label)
            b.frame = NSRect(x: x, y: 5, width: 24, height: 24)
            addSubview(b)
            return b
        }
        previous = button("chevron.up", t("find.previousTip"), t("find.previousA"), 302, #selector(previousClicked))
        next = button("chevron.down", t("find.nextTip"), t("find.nextA"), 328, #selector(nextClicked))
        rule.wantsLayer = true
        rule.frame = NSRect(x: 355, y: 9, width: 1, height: 16)
        addSubview(rule)
        matchCase = FindToggle("Aa", tip: t("find.caseTip"))
        matchCase.frame = NSRect(x: 360, y: 5, width: 24, height: 24)
        regex = FindToggle(".*", tip: t("find.regexTip"))
        regex.frame = NSRect(x: 386, y: 5, width: 24, height: 24)
        for b in [matchCase!, regex!] {
            b.target = self
            b.action = #selector(toggleClicked(_:))
            addSubview(b)
        }
        rule2.wantsLayer = true
        rule2.frame = NSRect(x: 413, y: 9, width: 1, height: 16)
        addSubview(rule2)
        close = button("xmark", t("find.closeTip"), t("find.closeA"), 418, #selector(closeClicked))
        problem.font = NSFont.systemFont(ofSize: 11.5)
        problem.lineBreakMode = .byTruncatingTail
        problem.frame = NSRect(x: 38, y: 32, width: FindBar.size.width - 48, height: 15)
        problem.isHidden = true
        addSubview(problem)
        restyle()
    }

    /// While the field has the keyboard: its well ringed in the accent.
    private var typing = false { didSet { if typing != oldValue { restyle() } } }

    /// The colours of the app's own look (light or dark), as the panel's cards.
    func restyle() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = Design.color("card").cgColor
            layer?.borderColor = Design.sep.cgColor
            well.layer?.backgroundColor = Design.color("input").cgColor
            well.layer?.borderWidth = typing ? 1.5 : 1
            well.layer?.borderColor = (typing ? Design.work : Design.sep).cgColor
            rule.layer?.backgroundColor = Design.sep.cgColor
            rule2.layer?.backgroundColor = Design.sep.cgColor
        }
        matchCase?.restyle()
        regex?.restyle()
        field.textColor = Design.tx
        count.textColor = Design.color("tx3")
        problem.textColor = problemBad ? Design.color("bad") : Design.color("tx2")
        for b in [previous, next, close] { b?.contentTintColor = Design.tx2 }
        icon.image = SharedIcons.image("search", color: "tx3", size: 13)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        restyle()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var isFlipped: Bool { true }

    @objc private func previousClicked() { onPrevious?() }
    @objc private func nextClicked() { onNext?() }
    @objc private func closeClicked() { onClose?() }
    @objc private func toggleClicked(_ b: FindToggle) { onToggle?(b) }

    /// The line under the bar: text, or nil for none; bad: the pattern's
    /// problem, in the bad colour. The bar grows to hold it.
    private var problemBad = false
    func show(problem text: String?, bad: Bool = false) {
        problemBad = bad
        problem.stringValue = text ?? ""
        problem.isHidden = text == nil
        restyle()
        var f = frame
        let h = FindBar.size.height + (text == nil ? 0 : FindBar.problemHeight)
        if f.height != h {
            f.size.height = h
            frame = f
        }
    }

    func controlTextDidChange(_ note: Notification) {
        onChange?(field.stringValue)
    }

    /// The count: "3 of 11", "11 matches", "No matches", or nothing.
    func show(count n: Int, selected: Int, needle: String) {
        if needle.isEmpty {
            count.stringValue = ""
        } else if n == 0 {
            count.stringValue = "No matches"
        } else if selected < 0 {
            count.stringValue = n == 1 ? "1 match" : "\(n) matches"
        } else {
            count.stringValue = "\(selected + 1) of \(n)"
        }
    }
}

/// Match case (Aa) or Regular expression (.*): .fb-t, a 24 pt square with
/// its letters in the monospaced face, ringed in the accent when on. A
/// toggle the tab's daemon does not have is dimmed (unavailable) and says
/// so in its tip.
final class FindToggle: NSButton {
    var on = false { didSet { restyle() } }
    var unavailable = false { didSet { restyle() } }
    private let label: String
    private let tip: String
    var unavailableTip = ""

    init(_ label: String, tip: String) {
        self.label = label
        self.tip = tip
        super.init(frame: NSRect(x: 0, y: 0, width: 24, height: 24))
        isBordered = false
        bezelStyle = .regularSquare
        setButtonType(.momentaryChange)
        wantsLayer = true
        layer?.cornerRadius = 6
        setAccessibilityLabel(tip)
        restyle()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func restyle() {
        let color = unavailable ? Design.color("tx3").withAlphaComponent(0.5) : on ? Design.work : Design.tx2
        attributedTitle = NSAttributedString(string: label, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 11.5, weight: .semibold),
            .foregroundColor: color,
        ])
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.borderWidth = on && !unavailable ? 1.5 : 0
            layer?.borderColor = Design.work.cgColor
        }
        toolTip = unavailable ? unavailableTip : tip
        setAccessibilityValue(on ? "on" : "off")
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        restyle()
    }
}
