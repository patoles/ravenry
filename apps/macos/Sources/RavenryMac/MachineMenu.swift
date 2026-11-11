// Two things the app does to this Mac outside its own folders, each from the
// Ravenry menu and each asked first, done by install/setup.ts on the app's
// Node (`command`, `uninstall`):
//
// - The ravenry command. Agents in a pane type `ravenry pick`, `ravenry ask`...
//   On a Mac that had the npm board (ravenry-app), `ravenry` in a terminal is
//   its launcher, which knows none of them ("Unknown command pick"). Install
//   the ravenry Command... links ~/.local/bin/ravenry to the app's stable
//   <data>/bin/ravenry (an update needs no rewrite), and only when that folder
//   does not come first on the login shell's PATH, adds two marked lines at
//   the end of its startup file (backed up first). The npm board's own
//   commands (setup, doctor, uninstall...) still reach it (ravenryd
//   boardwords.go). At launch, when a terminal's ravenry is another program,
//   a toast offers it once (Not now is kept in <data>/command-choice.json,
//   until that other program changes). Remove the ravenry Command... takes
//   out exactly what Install made.
// - Uninstall Ravenry... (HUB-016): the hooks out of Claude Code's and
//   Codex's files and the skill out of their folders (each put back as it
//   was, else only Ravenry's entries out, backed up), the hub service, the
//   ravenry command, the program's folders; with the box ticked, the data
//   too. Then it says what it did and quits; the person moves the app to
//   the Trash (shown in Finder).
//
// A development build (no setup.mjs) shows neither. Off every screen the
// dialogs are sheets on the window, which a check presses (ReportDriver.swift).

import AppKit

final class MachineMenu: NSObject, NSMenuItemValidation {
    static let shared = MachineMenu()
    private weak var commandItem: NSMenuItem?
    /// `setup.mjs command --state`'s last answer.
    private(set) var command: [String: Any]?
    /// What the last uninstall answered, for a check.
    private(set) var uninstalled: [String: Any]?
    private var busy = false

    private var inst: AppInstall { AppInstall.shared }
    private var available: Bool { inst.packaged }
    /// A path as people read it: ~ for the home folder (HOME's, as the setup's sayPath).
    private var tilde: (String) -> String { let h = AppInstall.shared.home; return { $0.hasPrefix(h + "/") ? "~" + $0.dropFirst(h.count) : $0 } }

    func addMenuItems(to menu: NSMenu) {
        guard available else { return }
        let at = (menu.items.firstIndex { $0.action == #selector(AppDelegate.menuSettings(_:)) } ?? (menu.items.count - 1)) + 1
        let c = NSMenuItem(title: t("command.menuInstall"), action: #selector(menuCommand(_:)), keyEquivalent: "")
        c.target = self
        menu.insertItem(c, at: at)
        commandItem = c
        let u = NSMenuItem(title: t("uninstall.menu"), action: #selector(menuUninstall(_:)), keyEquivalent: "")
        u.target = self
        menu.insertItem(u, at: at + 1)
    }

    private var installed: Bool { command?["firstOurs"] as? Bool == true && command?["linkOurs"] as? Bool == true }

    func validateMenuItem(_ m: NSMenuItem) -> Bool {
        if m.action == #selector(menuCommand(_:)) { m.title = installed ? t("command.menuRemove") : t("command.menuInstall") }
        return !busy
    }

    /// The command's state, read in the background.
    func refresh(_ then: (() -> Void)? = nil) {
        guard available else { return }
        DispatchQueue.global(qos: .utility).async { [self] in
            let r = inst.runSetup(["command", "--state"])
            DispatchQueue.main.async {
                if r["ok"] as? Bool == true { self.command = r }
                self.commandItem?.title = self.installed ? t("command.menuRemove") : t("command.menuInstall")
                then?()
            }
        }
    }

    // MARK: the launch's offer

    private var choiceFile: URL { URL(fileURLWithPath: SingleInstance.dataFolder).appendingPathComponent("command-choice.json") }

    /// After the hub's setup at launch: another program answers ravenry in a terminal, so the toast offers it.
    func atLaunch() {
        refresh { [self] in
            guard let c = command, c["firstOurs"] as? Bool != true, let other = c["other"] as? String,
                  c["first"] as? String == other, c["installed"] as? Bool == true, c["blocked"] as? Bool != true else { return }
            if let d = try? Data(contentsOf: choiceFile), let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
               j["choice"] as? String == "not-now", j["other"] as? String == other { return }
            let what = c["otherWhat"] as? String ?? tilde(other)
            inst.log("command: a terminal's ravenry is \(what) (\(other)): offered")
            Board.lastFront?.toast(t("command.offer", ["what": what]), actions: [
                (t("command.offerYes"), { [weak self] in self?.menuCommand(nil) }),
                (t("command.offerNo"), { [weak self] in self?.notNow(other) }),
            ], key: "ravenry-command", seconds: .infinity)
        }
    }

    private func notNow(_ other: String) {
        let j: [String: Any] = ["choice": "not-now", "other": other, "at": ISO8601DateFormatter().string(from: Date())]
        try? JSONSerialization.data(withJSONObject: j).write(to: choiceFile)
        inst.log("command: Not now (kept until a terminal's ravenry is another program than \(other))")
    }

    // MARK: Install or Remove the ravenry Command...

    @objc func menuCommand(_ sender: Any?) {
        guard !busy else { return }
        refresh { [self] in
            guard let c = command else { return }
            let up = Updater.shared
            let link = tilde(c["link"] as? String ?? "~/.local/bin/ravenry")
            let rc = tilde(c["rc"] as? String ?? "~/.zshrc")
            if installed {
                let detail = t(c["lineOurs"] as? Bool == true ? "command.removeWithLine" : "command.removeDetail", ["link": link, "rc": rc])
                up.show(up.alert(t("command.removeTitle"), detail, buttons: [t("command.remove"), t("command.cancel")])) { [weak self] r in
                    if r == .alertFirstButtonReturn { self?.run(["command", "--off"], done: t("command.removed")) }
                }
                return
            }
            if c["blocked"] as? Bool == true {
                up.show(up.alert(t("command.title"), t("command.blocked", ["link": link]), buttons: [t("update.ok")]))
                return
            }
            let now = (c["other"] as? String).map { t("command.nowOther", ["what": c["otherWhat"] as? String ?? tilde($0)]) } ?? t("command.nowNone")
            let what = t(c["needsLine"] as? Bool == true ? "command.addsWithLine" : "command.adds", ["link": link, "rc": rc])
            up.show(up.alert(t("command.title"), "\(now) \(what) \(t("command.after"))", buttons: [t("command.install"), t("command.cancel")])) { [weak self] r in
                if r == .alertFirstButtonReturn { self?.run(["command", "--on"], done: t("command.done")) }
            }
        }
    }

    private func run(_ args: [String], done: String) {
        busy = true
        inst.runSetupLive(args, onLine: { _ in }) { [weak self] j in
            guard let self else { return }
            self.busy = false
            self.command = j
            self.commandItem?.title = self.installed ? t("command.menuRemove") : t("command.menuInstall")
            let ok = j["ok"] as? Bool == true
            Board.lastFront?.toast(ok ? done : t("command.failed", ["why": j["error"] as? String ?? "no answer"]))
        }
    }

    // MARK: Uninstall Ravenry...

    /// The box under the question (the data too); kept for a check.
    private(set) var purgeBox: NSButton?

    @objc func menuUninstall(_ sender: Any?) {
        guard !busy else { return }
        let up = Updater.shared
        let a = up.alert(t("uninstall.title"), t("uninstall.detail"), buttons: [t("uninstall.yes"), t("command.cancel")], warning: true)
        let box = NSButton(checkboxWithTitle: t("uninstall.purge"), target: nil, action: nil)
        box.setAccessibilityIdentifier("uninstall.purge")
        box.state = .off
        box.sizeToFit()
        a.accessoryView = box
        purgeBox = box
        up.show(a) { [weak self] r in
            guard r == .alertFirstButtonReturn else { return }
            self?.uninstall(purge: box.state == .on)
        }
    }

    private func uninstall(purge: Bool) {
        busy = true
        inst.log("uninstall: asked from the Ravenry menu\(purge ? ", the data too" : "")")
        inst.runSetupLive(["uninstall"] + (purge ? ["--purge"] : []), onLine: { _ in }) { [weak self] j in
            guard let self else { return }
            self.busy = false
            self.uninstalled = j
            let did = (j["did"] as? [String] ?? []).map { "- \($0)" }
            let left = (j["left"] as? [String] ?? []).map { "- \($0)" }
            let kept = j["kept"] as? [String] ?? []
            var text = did.isEmpty ? t("uninstall.nothing") : did.joined(separator: "\n")
            if !left.isEmpty { text += "\n\n" + t("uninstall.left") + "\n" + left.joined(separator: "\n") }
            if !kept.isEmpty { text += "\n\n" + t("uninstall.kept", ["folders": kept.joined(separator: " and ")]) }
            text += "\n\n" + t("uninstall.finish")
            let up = Updater.shared
            up.show(up.alert(t(left.isEmpty ? "uninstall.doneTitle" : "uninstall.partTitle"), text, buttons: [t("uninstall.quit")])) { _ in
                Outside.reveal(Bundle.main.bundlePath)
                (NSApp.delegate as? AppDelegate)?.quitWhy = "Ravenry was uninstalled"
                NSApp.terminate(nil)
            }
        }
    }
}
