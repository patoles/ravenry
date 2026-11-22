// The app's one list of actions (NAV-011, SET-018): each action's id,
// title, menu, default key, how it runs and when it can. Everything that
// shows an action reads it from here:
//
// - the menu bar (AppDelegate.buildMenu): every item, its title and its
//   key, and a key the person changed shows there and works;
// - the command palette (Palette.swift): the actions that can run now,
//   with the board's own beside them;
// - Settings, Keys (SettingsKeys.swift): the actions a person can give a
//   key, grouped by menu;
// - right-click menus (Actions.contextItem): an item with the action's
//   title and its key as the menu bar has it, running what the caller says
//   (the pane right-clicked, the tab under the pointer).
//
// A key is kept as text, "ctrl+opt+shift+cmd+d" (KeyStroke); the person's
// changes are the setting `keys` in settings.json (shared/settings/
// settings.json, kind keymap): an action's id and its key, "" for none.
// KeyMap reads them from every settings store and puts them on the menu.

import AppKit

/// A key with its modifiers, as the person presses it.
struct KeyStroke: Hashable {
    var ctrl = false, opt = false, shift = false, cmd = false
    /// A letter, a digit or a sign as the key has it without Shift ("d", "=", "]"),
    /// or a key's name: left, right, up, down, return, tab, space, delete,
    /// forwarddelete, escape, home, end, pageup, pagedown, f1 to f12.
    var key: String

    init(key: String, ctrl: Bool = false, opt: Bool = false, shift: Bool = false, cmd: Bool = false) {
        self.key = key; self.ctrl = ctrl; self.opt = opt; self.shift = shift; self.cmd = cmd
    }

    /// "shift+cmd+d" read back; nil when it is not a key.
    init?(_ text: String) {
        var parts = text.lowercased().split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        guard let k = parts.popLast(), !k.isEmpty, KeyStroke.known(k) else { return nil }
        key = k
        for p in parts {
            switch p {
            case "ctrl": ctrl = true
            case "opt", "alt": opt = true
            case "shift": shift = true
            case "cmd": cmd = true
            default: return nil
            }
        }
    }

    static let names: Set<String> = ["left", "right", "up", "down", "return", "tab", "space", "delete", "forwarddelete", "escape", "home", "end", "pageup", "pagedown"]
    static func known(_ k: String) -> Bool {
        if names.contains(k) { return true }
        if k.hasPrefix("f"), let n = Int(k.dropFirst()), (1...12).contains(n) { return true }
        return k.count == 1 && k.unicodeScalars.allSatisfy { $0.value > 0x20 && $0.value < 0x7F && !CharacterSet.uppercaseLetters.contains($0) }
    }

    var text: String { (ctrl ? "ctrl+" : "") + (opt ? "opt+" : "") + (shift ? "shift+" : "") + (cmd ? "cmd+" : "") + key }

    /// As a Mac menu writes it: ⌃⌥⇧⌘ then the key ("⇧⌘D", "⌥⌘←").
    var symbols: String { (ctrl ? "\u{2303}" : "") + (opt ? "\u{2325}" : "") + (shift ? "\u{21E7}" : "") + (cmd ? "\u{2318}" : "") + keySymbol }

    var keySymbol: String {
        switch key {
        case "left": return "\u{2190}"
        case "right": return "\u{2192}"
        case "up": return "\u{2191}"
        case "down": return "\u{2193}"
        case "return": return "\u{21A9}"
        case "tab": return "\u{21E5}"
        case "space": return "Space"
        case "delete": return "\u{232B}"
        case "forwarddelete": return "\u{2326}"
        case "escape": return "\u{238B}"
        case "home": return "\u{2196}"
        case "end": return "\u{2198}"
        case "pageup": return "\u{21DE}"
        case "pagedown": return "\u{21DF}"
        default: return key.uppercased()
        }
    }

    /// The menu item's key equivalent and its modifiers.
    var menuKey: (String, NSEvent.ModifierFlags) {
        var m: NSEvent.ModifierFlags = []
        if ctrl { m.insert(.control) }
        if opt { m.insert(.option) }
        if shift { m.insert(.shift) }
        if cmd { m.insert(.command) }
        let f = { (c: Int) in String(UnicodeScalar(UInt32(c))!) }
        let k: String
        switch key {
        case "left": k = f(NSLeftArrowFunctionKey)
        case "right": k = f(NSRightArrowFunctionKey)
        case "up": k = f(NSUpArrowFunctionKey)
        case "down": k = f(NSDownArrowFunctionKey)
        case "return": k = "\r"
        case "tab": k = "\t"
        case "space": k = " "
        case "delete": k = "\u{8}"
        case "forwarddelete": k = f(NSDeleteFunctionKey)
        case "escape": k = "\u{1b}"
        case "home": k = f(NSHomeFunctionKey)
        case "end": k = f(NSEndFunctionKey)
        case "pageup": k = f(NSPageUpFunctionKey)
        case "pagedown": k = f(NSPageDownFunctionKey)
        default:
            if key.hasPrefix("f"), key.count > 1, let n = Int(key.dropFirst()) { k = f(NSF1FunctionKey + n - 1) }
            else { k = shift && key.count == 1 && key.first!.isLetter ? key.uppercased() : key }
        }
        return (k, m)
    }

    /// The signs Shift makes of a key on a US keyboard, back to the key ("+" is Shift and "=").
    private static let unshift: [Character: Character] = ["+": "=", "_": "-", "}": "]", "{": "[", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
                                                         "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0"]

    /// The key a key-down event is: nil for a modifier alone or a key with no name here.
    static func from(_ e: NSEvent) -> KeyStroke? {
        guard e.type == .keyDown else { return nil }
        let f = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
        var s = KeyStroke(key: "", ctrl: f.contains(.control), opt: f.contains(.option), shift: f.contains(.shift), cmd: f.contains(.command))
        let raw = e.charactersIgnoringModifiers ?? ""
        guard let sc = raw.unicodeScalars.first else {
            if e.keyCode == 0x73 { s.key = "home"; return s }
            if e.keyCode == 0x77 { s.key = "end"; return s }
            return nil
        }
        switch Int(sc.value) {
        case NSUpArrowFunctionKey: s.key = "up"
        case NSDownArrowFunctionKey: s.key = "down"
        case NSLeftArrowFunctionKey: s.key = "left"
        case NSRightArrowFunctionKey: s.key = "right"
        case NSF1FunctionKey...NSF12FunctionKey: s.key = "f\(Int(sc.value) - NSF1FunctionKey + 1)"
        case NSHomeFunctionKey: s.key = "home"
        case NSEndFunctionKey: s.key = "end"
        case NSPageUpFunctionKey: s.key = "pageup"
        case NSPageDownFunctionKey: s.key = "pagedown"
        case NSDeleteFunctionKey: s.key = "forwarddelete"
        case 0x0D, 0x03: s.key = "return"
        case 0x09: s.key = "tab"
        case 0x19: s.key = "tab"; s.shift = true
        case 0x20: s.key = "space"
        case 0x7F, 0x08: s.key = "delete"
        case 0x1B: s.key = "escape"
        default:
            guard var c = raw.first else { return nil }
            if c.isUppercase { c = Character(c.lowercased()); s.shift = true }
            if let b = unshift[c] { c = b; s.shift = true }
            s.key = String(c)
            guard known(s.key) else { return nil }
        }
        return s
    }
}

/// One action: what the menu bar, the palette, the Keys page and right-click menus show of it.
struct AppAction {
    /// Who answers a menu action: the app's delegate, NSApp, the key window's
    /// first responder (Copy, Paste: the view with the keyboard), the updater or
    /// the ravenry command's menu.
    enum Target { case app, nsapp, chain, updater, machine }

    let id: String
    let title: String
    /// The menu bar's menu ("Ravenry", "Shell", "Edit", "View", "Window", "Help"),
    /// or "Board" for the board's actions, kept as hidden items of View.
    let menu: String
    /// A line between items where this changes, as the menus have them.
    var group = 0
    /// Edit's Find items are in its Find submenu.
    var sub: String? = nil
    /// The key Ravenry ships it with.
    var key: String? = nil
    /// Hidden keys it also takes, which the person cannot change (Cmd+} for
    /// Next Tab): the menu's own key equivalent and modifiers, and the stroke.
    var also: [(String, NSEvent.ModifierFlags, String)] = []
    var selector: Selector
    var target: Target = .app
    /// The tag the handler reads (the pane's direction, the tab's number).
    var tag = 0
    /// A key with no item a person sees (Tab 1 to 9, the board's actions).
    var hidden = false
    /// On the Keys page: a person can give it another key.
    var rebind = true
    /// In the palette.
    var palette = true
    /// The palette's words for it, when they are not the menu's (the board's: "Hand off now").
    var phrase: String? = nil
    /// A right-click menu's words for it, when they are not the menu's ("Move to Own Tab").
    var contextTitle: String? = nil
    var icon = "shell"
    /// Whether it is in the menu at all (the ravenry command's items, on a packaged app).
    var only: (() -> Bool)? = nil
    /// Its item made: the owner keeps it (its title changes with a state).
    var made: ((NSMenuItem) -> Void)? = nil

    var defaultStroke: KeyStroke? { key.flatMap(KeyStroke.init) }
}

enum Actions {
    static let menuOrder = ["Ravenry", "Shell", "Edit", "View", "Window", "Help"]
    /// The Keys page's order: the menus a person uses most first, the board's last.
    static let keysOrder = ["Shell", "Edit", "View", "Window", "Help", "Ravenry", "Board"]

    static let all: [AppAction] = {
        let app = #selector(AppDelegate.menuBoard(_:))
        var a: [AppAction] = [
            // The app menu: About, Check for Updates, Settings, the ravenry command, Services, Hide, Quit.
            AppAction(id: "about", title: "About Ravenry", menu: "Ravenry", selector: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), target: .nsapp, icon: "logo"),
            AppAction(id: "checkUpdates", title: t("update.check"), menu: "Ravenry", selector: #selector(Updater.menuUpdate(_:)), target: .updater, icon: "download",
                      made: { Updater.shared.adopt(check: $0) }),
            AppAction(id: "npmBack", title: t("menu.npmBack"), menu: "Ravenry", selector: #selector(Updater.menuNpmBack(_:)), target: .updater, rebind: false, icon: "npm-board",
                      made: { Updater.shared.adopt(npmBack: $0) }),
            AppAction(id: "settings", title: "Settings\u{2026}", menu: "Ravenry", group: 1, key: "cmd+,", selector: #selector(AppDelegate.menuSettings(_:)), icon: "settings"),
            AppAction(id: "installCommand", title: t("command.menuInstall"), menu: "Ravenry", group: 1, selector: #selector(MachineMenu.menuCommand(_:)), target: .machine, icon: "shell",
                      only: { MachineMenu.shared.available }, made: { MachineMenu.shared.adopt(command: $0) }),
            AppAction(id: "uninstall", title: t("uninstall.menu"), menu: "Ravenry", group: 1, selector: #selector(MachineMenu.menuUninstall(_:)), target: .machine, icon: "close",
                      only: { MachineMenu.shared.available }),
            AppAction(id: "hide", title: "Hide Ravenry", menu: "Ravenry", group: 3, key: "cmd+h", selector: #selector(NSApplication.hide(_:)), target: .nsapp, icon: "eye-off"),
            AppAction(id: "hideOthers", title: "Hide Others", menu: "Ravenry", group: 3, key: "opt+cmd+h", selector: #selector(NSApplication.hideOtherApplications(_:)), target: .nsapp, icon: "eye-off"),
            AppAction(id: "showAll", title: "Show All", menu: "Ravenry", group: 3, selector: #selector(NSApplication.unhideAllApplications(_:)), target: .nsapp, icon: "eye"),
            AppAction(id: "quit", title: "Quit Ravenry", menu: "Ravenry", group: 4, key: "cmd+q", selector: #selector(NSApplication.terminate(_:)), target: .chain, icon: "close"),

            // The Shell menu, the Electron app's (apps/desktop/src/main/main.ts).
            AppAction(id: "newShell", title: "New Shell", menu: "Shell", key: "cmd+t", selector: #selector(AppDelegate.menuNewTab(_:)), icon: "act-prompt"),
            AppAction(id: "newSession", title: "New Session\u{2026}", menu: "Shell", key: "shift+cmd+n", selector: #selector(AppDelegate.menuNewSession(_:)), icon: "plus"),
            AppAction(id: "newWindow", title: "New Window", menu: "Shell", key: "cmd+n", selector: #selector(AppDelegate.menuNewWindow(_:)), icon: "act-window"),
            AppAction(id: "splitRight", title: "Split Right", menu: "Shell", group: 1, key: "cmd+d", selector: #selector(AppDelegate.menuSplitRight(_:)), icon: "act-split"),
            AppAction(id: "splitDown", title: "Split Down", menu: "Shell", group: 1, key: "shift+cmd+d", selector: #selector(AppDelegate.menuSplitDown(_:)), icon: "act-split"),
            AppAction(id: "paneLeft", title: "Select Pane Left", menu: "Shell", group: 1, key: "opt+cmd+left", selector: #selector(AppDelegate.menuFocusPane(_:)), tag: 0, icon: "left"),
            AppAction(id: "paneRight", title: "Select Pane Right", menu: "Shell", group: 1, key: "opt+cmd+right", selector: #selector(AppDelegate.menuFocusPane(_:)), tag: 1, icon: "act-tab"),
            AppAction(id: "paneUp", title: "Select Pane Above", menu: "Shell", group: 1, key: "opt+cmd+up", selector: #selector(AppDelegate.menuFocusPane(_:)), tag: 2, icon: "up"),
            AppAction(id: "paneDown", title: "Select Pane Below", menu: "Shell", group: 1, key: "opt+cmd+down", selector: #selector(AppDelegate.menuFocusPane(_:)), tag: 3, icon: "down"),
            AppAction(id: "zoomPane", title: "Zoom Pane", menu: "Shell", group: 1, key: "shift+cmd+return", selector: #selector(AppDelegate.menuZoom(_:)), icon: "act-window"),
            AppAction(id: "ownTab", title: "Move Pane to Own Tab", menu: "Shell", group: 1, selector: #selector(AppDelegate.menuOwnTab(_:)), contextTitle: t("term.ownTab"), icon: "act-tab"),
            AppAction(id: "equalize", title: "Equalize Splits", menu: "Shell", group: 1, key: "ctrl+cmd+=", selector: #selector(AppDelegate.menuEqualize(_:)), icon: "act-split"),
            AppAction(id: "close", title: "Close", menu: "Shell", group: 2, key: "cmd+w", selector: #selector(AppDelegate.menuClose(_:)), icon: "close"),
            AppAction(id: "closeWindow", title: "Close Window", menu: "Shell", group: 2, key: "shift+cmd+w", selector: #selector(NSWindow.performClose(_:)), target: .chain, icon: "close"),

            // Edit: Undo, Redo and Cut for every text field (A11Y-011); in a terminal Cut is
            // off and Undo and Redo are the program's keys (TerminalView).
            AppAction(id: "undo", title: "Undo", menu: "Edit", key: "cmd+z", selector: Selector(("undo:")), target: .chain, icon: "undo"),
            AppAction(id: "redo", title: "Redo", menu: "Edit", key: "shift+cmd+z", selector: Selector(("redo:")), target: .chain, icon: "undo"),
            AppAction(id: "cut", title: "Cut", menu: "Edit", group: 1, key: "cmd+x", selector: #selector(NSText.cut(_:)), target: .chain, icon: "doc"),
            AppAction(id: "copy", title: "Copy", menu: "Edit", group: 1, key: "cmd+c", selector: #selector(TerminalView.copy(_:)), target: .chain, contextTitle: t("term.copy"), icon: "doc"),
            AppAction(id: "paste", title: "Paste", menu: "Edit", group: 1, key: "cmd+v", selector: #selector(TerminalView.paste(_:)), target: .chain, contextTitle: t("term.paste"), icon: "doc"),
            AppAction(id: "selectAll", title: "Select All", menu: "Edit", group: 1, key: "cmd+a", selector: #selector(NSResponder.selectAll(_:)), target: .chain, contextTitle: t("term.selectAll"), icon: "doc"),
            AppAction(id: "clear", title: "Clear", menu: "Edit", group: 1, key: "cmd+k", selector: #selector(TerminalView.clearScreen(_:)), target: .chain, contextTitle: t("term.clear"), icon: "act-prompt"),
            AppAction(id: "find", title: "Find\u{2026}", menu: "Edit", group: 2, sub: "Find", key: "cmd+f", selector: #selector(TerminalView.showFindBar(_:)), target: .chain, contextTitle: t("term.find"), icon: "search"),
            AppAction(id: "findNext", title: "Find Next", menu: "Edit", group: 2, sub: "Find", key: "cmd+g", selector: #selector(TerminalView.findNext(_:)), target: .chain, icon: "search"),
            AppAction(id: "findPrevious", title: "Find Previous", menu: "Edit", group: 2, sub: "Find", key: "shift+cmd+g", selector: #selector(TerminalView.findPrevious(_:)), target: .chain, icon: "search"),

            // View: the font, the tabs, the sidebar and the panel.
            AppAction(id: "fontBigger", title: "Increase Font Size", menu: "View", key: "cmd+=", also: [("+", .command, "shift+cmd+=")], selector: #selector(TerminalView.increaseFontSize(_:)), target: .chain, icon: "plus"),
            AppAction(id: "fontSmaller", title: "Decrease Font Size", menu: "View", key: "cmd+-", selector: #selector(TerminalView.decreaseFontSize(_:)), target: .chain, icon: "act-prompt"),
            AppAction(id: "fontReset", title: "Reset Font Size", menu: "View", key: "cmd+0", selector: #selector(TerminalView.resetFontSize(_:)), target: .chain, icon: "act-prompt"),
            // (Shift+Tab types a back tab, U+0019; Cmd+} and Cmd+Shift+] are the hidden ones.)
            AppAction(id: "nextTab", title: "Next Tab", menu: "View", group: 1, key: "ctrl+tab",
                      also: [("}", .command, "shift+cmd+]"), ("]", [.command, .shift], "shift+cmd+]")], selector: #selector(AppDelegate.menuNextTab(_:)), icon: "act-tab"),
            AppAction(id: "previousTab", title: "Previous Tab", menu: "View", group: 1, key: "ctrl+shift+tab",
                      also: [("\u{19}", [.control, .shift], "ctrl+shift+tab"), ("{", .command, "shift+cmd+["), ("[", [.command, .shift], "shift+cmd+[")], selector: #selector(AppDelegate.menuPreviousTab(_:)), icon: "act-tab"),
        ]
        for i in 0..<9 {
            a.append(AppAction(id: "tab\(i + 1)", title: "Tab \(i + 1)", menu: "View", group: 1, key: "cmd+\(i + 1)", selector: #selector(AppDelegate.menuSelectTab(_:)), tag: i,
                               hidden: true, rebind: false, palette: false, icon: "act-tab"))
        }
        a += [
            AppAction(id: "toggleSidebar", title: t("side.hide"), menu: "View", group: 2, key: "ctrl+cmd+s", selector: #selector(AppDelegate.menuToggleSidebar(_:)), icon: "panel"),
            AppAction(id: "togglePanel", title: t("panel.hideMenu"), menu: "View", group: 2, key: "opt+cmd+b", selector: #selector(AppDelegate.menuTogglePanel(_:)), icon: "panel"),

            // The Window menu, as a Mac app's (the Electron app's windowMenu role): AppKit lists the windows under it.
            AppAction(id: "minimize", title: "Minimize", menu: "Window", key: "cmd+m", selector: #selector(NSWindow.performMiniaturize(_:)), target: .chain, icon: "down"),
            AppAction(id: "zoomWindow", title: "Zoom", menu: "Window", selector: #selector(NSWindow.performZoom(_:)), target: .chain, icon: "act-window"),
            AppAction(id: "moveTabToNewWindow", title: "Move Tab to New Window", menu: "Window", group: 1, selector: #selector(AppDelegate.menuMoveTabToNewWindow(_:)), icon: "act-window"),
            AppAction(id: "mergeAllWindows", title: "Merge All Windows", menu: "Window", group: 1, selector: #selector(AppDelegate.menuMergeAllWindows(_:)), icon: "merge"),
            AppAction(id: "bringAllToFront", title: "Bring All to Front", menu: "Window", group: 2, selector: #selector(NSApplication.arrangeInFront(_:)), target: .nsapp, icon: "act-window"),

            // Help, Learn Ravenry (learn.ts), as the Electron app's Help menu; the privacy page; the licences.
            AppAction(id: "learn", title: t("learn.title"), menu: "Help", selector: #selector(AppDelegate.menuLearn(_:)), icon: "question"),
            AppAction(id: "privacy", title: t("privacy.title"), menu: "Help", selector: #selector(AppDelegate.menuPrivacy(_:)), icon: "lock"),
            AppAction(id: "licences", title: t("licences.title"), menu: "Help", selector: #selector(AppDelegate.menuLicences(_:)), icon: "doc"),

            // The board's actions (Board.boardAction): hidden items of View, so a key a person gives one works.
            AppAction(id: "palette", title: t("act.palette"), menu: "Board", key: "shift+cmd+p", selector: #selector(AppDelegate.menuPalette(_:)), hidden: true, palette: false, icon: "search"),
            AppAction(id: "answerTop", title: t("act.answerTop"), menu: "Board", selector: app, hidden: true, phrase: t("act.answerTopPhrase"), icon: "act-answer"),
            AppAction(id: "handOffNow", title: t("act.handOff"), menu: "Board", selector: app, hidden: true, phrase: t("session.handOffNow"), icon: "act-handoff"),
            AppAction(id: "newPlan", title: t("act.newPlan"), menu: "Board", selector: app, hidden: true, phrase: t("panel.newPlan"), icon: "act-plan"),
            AppAction(id: "revive", title: t("act.revive"), menu: "Board", selector: app, hidden: true, phrase: t("project.revive"), icon: "act-revive"),
            AppAction(id: "newProject", title: t("act.newProject"), menu: "Board", selector: app, hidden: true, phrase: t("side.newProjectDots"), icon: "act-folder"),
        ]
        return a
    }()

    static let byId: [String: AppAction] = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })
    static func action(_ id: String) -> AppAction? { byId[id] }

    /// Keys an action takes that no one can change, and what has them (Tab 1 to 9, the hidden tab keys,
    /// the terminal's Cmd+Home and Cmd+End).
    static let fixed: [String: String] = {
        var m: [String: String] = ["cmd+home": t("keys.scrollTop"), "cmd+end": t("keys.scrollBottom")]
        for a in all {
            if !a.rebind, let k = a.key { m[k] = a.title }
            for x in a.also where x.2 != a.key { m[x.2] = a.title }
        }
        return m
    }()

    /// Keys macOS keeps for itself: never an app's.
    static let system: Set<String> = ["cmd+tab", "shift+cmd+tab", "cmd+space", "opt+cmd+space", "ctrl+cmd+space", "opt+cmd+escape", "shift+cmd+3", "shift+cmd+4",
                                      "shift+cmd+5", "ctrl+cmd+q", "cmd+`", "shift+cmd+`", "ctrl+cmd+f"]

    // MARK: the menu bar's items

    /// Every menu item made for an action, by its id (the alternates' hidden ones not counted).
    private(set) static var items: [String: [NSMenuItem]] = [:]

    /// The item for an action in a menu, its key from KeyMap.
    static func menuItem(_ a: AppAction, delegate: AnyObject) -> NSMenuItem {
        let i = NSMenuItem(title: a.title, action: a.selector, keyEquivalent: "")
        i.tag = a.tag
        i.identifier = NSUserInterfaceItemIdentifier("action.\(a.id)")
        switch a.target {
        case .app: i.target = delegate
        case .nsapp: i.target = NSApp
        case .chain: i.target = nil
        case .updater: i.target = Updater.shared
        case .machine: i.target = MachineMenu.shared
        }
        if a.menu == "Board" { i.representedObject = a.id }
        if a.hidden { i.isHidden = true; i.allowsKeyEquivalentWhenHidden = true }
        put(KeyMap.shared.stroke(a.id), on: i)
        items[a.id, default: []].append(i)
        a.made?(i)
        return i
    }

    static func put(_ s: KeyStroke?, on i: NSMenuItem) {
        if let s { let (k, m) = s.menuKey; i.keyEquivalent = k; i.keyEquivalentModifierMask = m } else { i.keyEquivalent = ""; i.keyEquivalentModifierMask = [] }
    }

    /// The items of one menu of the menu bar, with the lines between their groups. `between` adds
    /// what is not an action (the app menu's Services) before a group.
    static func fill(_ m: NSMenu, menu: String, delegate: AnyObject, between: [Int: () -> [NSMenuItem]] = [:]) {
        var group: Int?
        var subs: [String: NSMenu] = [:]
        for a in all where a.menu == menu || (menu == "View" && a.menu == "Board") {
            if let only = a.only, !only() { continue }
            if let g = group, a.group != g, a.menu != "Board" {
                m.addItem(.separator())
                for x in (g + 1)...a.group { if let extra = between[x] { for i in extra() { m.addItem(i) }; m.addItem(.separator()) } }
            }
            if a.menu != "Board" { group = a.group }
            let item = menuItem(a, delegate: delegate)
            if let s = a.sub {
                if subs[s] == nil {
                    let holder = m.addItem(withTitle: s, action: nil, keyEquivalent: "")
                    let sm = NSMenu(title: s)
                    holder.submenu = sm
                    subs[s] = sm
                }
                subs[s]!.addItem(item)
            } else {
                m.addItem(item)
            }
            // The hidden keys it also takes: items of their own, never changed.
            for (k, mods, _) in a.also {
                let h = NSMenuItem(title: a.title, action: a.selector, keyEquivalent: k)
                h.keyEquivalentModifierMask = mods
                h.target = item.target
                h.tag = a.tag
                h.isHidden = true
                h.allowsKeyEquivalentWhenHidden = true
                m.addItem(h)
            }
        }
    }

    /// The person changed a key: every item made for an action shows its key now.
    static func applyKeys() {
        for (id, list) in items { for i in list { put(KeyMap.shared.stroke(id), on: i) } }
    }

    /// The menu bar's item of an action (the first made), for the palette.
    static func barItem(_ id: String) -> NSMenuItem? { items[id]?.first { $0.menu != nil && !isContext($0) } }
    private static func isContext(_ i: NSMenuItem) -> Bool { i.representedObject is TermMenuItem || i.representedObject is MenuAction }

    /// An action of the menu bar run as its item runs it (the palette, a right-click menu's New Shell).
    static func perform(_ id: String) {
        guard let i = barItem(id), let sel = i.action else { return }
        NSApp.sendAction(sel, to: i.target, from: i)
    }

    // MARK: right-click menus

    /// An item for a right-click menu: the action's words and its key as the menu bar shows them,
    /// running `run` (the pane right-clicked, the tab under the pointer).
    static func contextItem(_ id: String, enabled: Bool = true, _ run: @escaping () -> Void) -> NSMenuItem {
        let a = byId[id]
        let i = TermMenuItem.item(a.map { $0.contextTitle ?? $0.title } ?? id, run)
        i.isEnabled = enabled
        put(KeyMap.shared.stroke(id), on: i)
        return i
    }
}

/// The keys as the person set them: the setting `keys` (an action's id and its key, "" for
/// none) over the keys Ravenry ships. Every settings store tells it when the file changed.
final class KeyMap {
    static let shared = KeyMap()
    /// The person's changes: an action's id and its key as text, "" for none.
    private(set) var changes: [String: String] = [:]
    /// After a change: the Keys page and the menus.
    static let changed = Notification.Name("RavenryKeysChanged")

    /// The setting read (a store loaded or written): the menus follow at once.
    func take(_ v: Any?) {
        let next = (v as? [String: Any] ?? [:]).compactMapValues { $0 as? String }
        guard next != changes else { return }
        changes = next
        Actions.applyKeys()
        NotificationCenter.default.post(name: KeyMap.changed, object: nil)
    }

    /// The key an action has now (nil: none).
    func stroke(_ id: String) -> KeyStroke? {
        if let c = changes[id] { return c.isEmpty ? nil : KeyStroke(c) }
        return Actions.byId[id]?.defaultStroke
    }

    func isChanged(_ id: String) -> Bool {
        guard let c = changes[id], Actions.byId[id]?.rebind == true else { return false }
        return c != (Actions.byId[id]?.key ?? "")
    }
    var changedCount: Int { Actions.all.filter { isChanged($0.id) }.count }

    /// The action whose key this is now (its own key, not a hidden one).
    func owner(of s: KeyStroke, except: String? = nil) -> AppAction? {
        Actions.all.first { $0.id != except && $0.rebind && stroke($0.id) == s }
    }

    /// The action of these ids that a key event is, by the keys as set (the terminal's own: Clear, Copy, Find...).
    func action(for e: NSEvent, among ids: Set<String>) -> String? {
        guard let s = KeyStroke.from(e) else { return nil }
        for id in ids {
            if stroke(id) == s { return id }
            if let a = Actions.byId[id], a.also.contains(where: { KeyStroke($0.2) == s }) { return id }
        }
        return nil
    }

    enum Verdict: Equatable { case ok, same, needsCommand, system, fixed(String), taken(String) }

    /// What a key pressed on the Keys page comes to for an action.
    func judge(_ s: KeyStroke, for id: String) -> Verdict {
        if stroke(id) == s { return .same }
        if Actions.system.contains(s.text) { return .system }
        // Without Command a key is the terminal program's (Ctrl+C); the tab keys' Ctrl+Tab aside.
        if !s.cmd && !(s.ctrl && s.key == "tab") { return .needsCommand }
        if let f = Actions.fixed[s.text] { return .fixed(f) }
        if let o = owner(of: s, except: id) { return .taken(o.id) }
        return .ok
    }

    /// The setting with this action's key (nil: none); the same as shipped drops out.
    func setting(_ id: String, _ s: KeyStroke?, freeing other: String? = nil) -> [String: String] {
        var m = changes
        let put = { (id: String, s: KeyStroke?) in
            let v = s?.text ?? ""
            if v == (Actions.byId[id]?.key ?? "") { m[id] = nil } else { m[id] = v }
        }
        put(id, s)
        if let o = other { put(o, nil) }
        return m
    }

    func resetting(_ id: String) -> [String: String] { var m = changes; m[id] = nil; return m }
}
