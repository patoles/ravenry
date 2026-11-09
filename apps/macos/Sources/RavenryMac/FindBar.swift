// The find bar (Cmd+F): a small panel at the top right of the terminal,
// with the text to find, the count ("3 of 11"), previous and next, and
// close. It only takes what the person types; the search is the daemon's
// (render.find) and the matches come in the frames.

import AppKit

/// The find field's editor: Enter is the next match, Shift+Enter the
/// previous one, Esc closes, from the key event itself.
final class FindFieldEditor: NSTextView {
    var onReturn: ((_ shift: Bool) -> Void)?
    var onEscape: (() -> Void)?

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

    /// The arrow over the bar and its buttons; the text field sets its
    /// own I-beam.
    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .arrow)
    }

    var onChange: ((String) -> Void)?
    var onNext: (() -> Void)?
    var onPrevious: (() -> Void)?
    var onClose: (() -> Void)?

    static let size = NSSize(width: 330, height: 32)

    var editor: FindFieldEditor { (field.cell as! FindFieldCell).editor }

    init() {
        super.init(frame: NSRect(origin: .zero, size: FindBar.size))
        appearance = NSAppearance(named: .darkAqua)
        wantsLayer = true
        layer?.backgroundColor = NSColor(white: 0.16, alpha: 0.97).cgColor
        layer?.cornerRadius = 7
        layer?.borderWidth = 1
        layer?.borderColor = NSColor(white: 1, alpha: 0.12).cgColor

        let cell = FindFieldCell(textCell: "")
        cell.isEditable = true
        cell.isScrollable = true
        cell.usesSingleLineMode = true
        cell.isBezeled = true
        cell.bezelStyle = .roundedBezel
        cell.placeholderString = "Find"
        field.cell = cell
        field.font = NSFont.systemFont(ofSize: 12)
        field.focusRingType = .none
        field.delegate = self
        field.frame = NSRect(x: 6, y: 5, width: 168, height: 22)
        addSubview(field)
        editor.onReturn = { [weak self] shift in shift ? self?.onPrevious?() : self?.onNext?() }
        editor.onEscape = { [weak self] in self?.onClose?() }

        count.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        count.textColor = .secondaryLabelColor
        count.alignment = .right
        count.frame = NSRect(x: 176, y: 8, width: 72, height: 16)
        addSubview(count)

        func button(_ symbol: String, _ label: String, _ x: CGFloat, _ action: Selector) -> NSButton {
            let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label) ?? NSImage()
            let b = NSButton(image: image, target: self, action: action)
            b.isBordered = false
            b.bezelStyle = .regularSquare
            b.contentTintColor = .labelColor
            b.toolTip = label
            b.frame = NSRect(x: x, y: 5, width: 24, height: 22)
            addSubview(b)
            return b
        }
        previous = button("chevron.up", "Previous match", 252, #selector(previousClicked))
        next = button("chevron.down", "Next match", 276, #selector(nextClicked))
        close = button("xmark", "Close", 302, #selector(closeClicked))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var isFlipped: Bool { true }

    @objc private func previousClicked() { onPrevious?() }
    @objc private func nextClicked() { onNext?() }
    @objc private func closeClicked() { onClose?() }

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
