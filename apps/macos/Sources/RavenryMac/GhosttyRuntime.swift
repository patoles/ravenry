// The Ghostty app object and the callbacks libghostty needs from its host.
// Adapted from Ghostty's own macOS app (macos/Sources/Ghostty/Ghostty.App.swift,
// MIT licence, Mitchell Hashimoto and Ghostty contributors), cut to what one
// window with one terminal needs.

import AppKit
import GhosttyKit

final class GhosttyRuntime {
    static private(set) var shared: GhosttyRuntime?

    let app: ghostty_app_t
    private let config: ghostty_config_t

    static func start(configPath: String?) -> GhosttyRuntime? {
        if shared == nil { shared = GhosttyRuntime(configPath: configPath) }
        return shared
    }

    private init?(configPath: String?) {
        guard let cfg = ghostty_config_new() else { return nil }
        // Ravenry's own settings only: never the person's Ghostty config
        // files, so a Ravenry window looks the same on every Mac.
        if let configPath { ghostty_config_load_file(cfg, configPath) }
        ghostty_config_finalize(cfg)
        let n = ghostty_config_diagnostics_count(cfg)
        for i in 0..<n {
            let d = ghostty_config_get_diagnostic(cfg, i)
            NSLog("ghostty config: %@", String(cString: d.message))
        }

        var rt = ghostty_runtime_config_s(
            userdata: nil,
            supports_selection_clipboard: false,
            wakeup_cb: { _ in DispatchQueue.main.async { GhosttyRuntime.shared?.tick() } },
            action_cb: { app, target, action in GhosttyRuntime.action(app, target: target, action: action) },
            read_clipboard_cb: { ud, loc, state, mimes, n, list in
                GhosttyRuntime.readClipboard(ud, location: loc, state: state, mimes: mimes, count: n, list: list)
            },
            confirm_read_clipboard_cb: { ud, _, state, _ in
                // No confirmation UI in the spike: deny what would need one.
                guard let view = TerminalView.from(ud), let s = view.surface else { return }
                ghostty_surface_deny_clipboard_request(s, state)
            },
            write_clipboard_cb: { _, loc, content, len, confirm in
                GhosttyRuntime.writeClipboard(location: loc, content: content, count: len, confirm: confirm)
            },
            close_surface_cb: { ud, _ in
                DispatchQueue.main.async { TerminalView.from(ud)?.window?.close() }
            }
        )
        guard let app = ghostty_app_new(&rt, cfg) else {
            ghostty_config_free(cfg)
            return nil
        }
        self.app = app
        self.config = cfg
        ghostty_app_set_focus(app, NSApp.isActive)
    }

    func tick() { ghostty_app_tick(app) }

    // MARK: actions

    private static func action(_ app: ghostty_app_t, target: ghostty_target_s, action: ghostty_action_s) -> Bool {
        var view: TerminalView?
        if target.tag == GHOSTTY_TARGET_SURFACE, let s = target.target.surface {
            view = TerminalView.from(ghostty_surface_userdata(s))
        }
        switch action.tag {
        case GHOSTTY_ACTION_SET_TITLE:
            let title = String(cString: action.action.set_title.title)
            DispatchQueue.main.async { view?.window?.title = title.isEmpty ? "Ravenry" : title }
            return true
        case GHOSTTY_ACTION_CLOSE_WINDOW:
            DispatchQueue.main.async { view?.window?.close() }
            return true
        case GHOSTTY_ACTION_QUIT:
            DispatchQueue.main.async { NSApp.terminate(nil) }
            return true
        case GHOSTTY_ACTION_MOUSE_SHAPE:
            return true
        case GHOSTTY_ACTION_CELL_SIZE:
            if let view {
                let c = action.action.cell_size
                let scale = view.window?.backingScaleFactor ?? 2
                DispatchQueue.main.async {
                    view.cellSize = CGSize(width: Double(c.width) / scale, height: Double(c.height) / scale)
                }
            }
            return true
        default:
            return false
        }
    }

    // MARK: clipboard (text only in the spike)

    private static func readClipboard(
        _ ud: UnsafeMutableRawPointer?,
        location: ghostty_clipboard_e,
        state: UnsafeMutableRawPointer?,
        mimes: UnsafePointer<UnsafePointer<CChar>>?,
        count: Int,
        list: Bool
    ) -> ghostty_clipboard_read_result_e {
        guard location == GHOSTTY_CLIPBOARD_STANDARD,
              let state, let view = TerminalView.from(ud), let surface = view.surface,
              let text = NSPasteboard.general.string(forType: .string)
        else { return GHOSTTY_CLIPBOARD_READ_UNAVAILABLE }
        let mime = strdup("text/plain")!
        let bytes = Array(text.utf8)
        let data = UnsafeMutablePointer<CChar>.allocate(capacity: max(bytes.count, 1))
        bytes.withUnsafeBufferPointer { b in
            if let base = b.baseAddress {
                data.update(from: UnsafeRawPointer(base).assumingMemoryBound(to: CChar.self), count: b.count)
            }
        }
        defer { free(mime); data.deallocate() }
        var content = ghostty_clipboard_content_s(mime: mime, data: data, len: bytes.count)
        withUnsafePointer(to: &content) { cp in
            var complete = ghostty_clipboard_complete_s(
                contents: cp, contents_len: 1, available: nil, available_len: 0,
                confirmed: false, remember: false)
            ghostty_surface_complete_clipboard_request(surface, &complete, state)
        }
        return GHOSTTY_CLIPBOARD_READ_STARTED
    }

    private static func writeClipboard(
        location: ghostty_clipboard_e,
        content: UnsafePointer<ghostty_clipboard_content_s>?,
        count: Int,
        confirm: Bool
    ) {
        guard location == GHOSTTY_CLIPBOARD_STANDARD, !confirm, let content else { return }
        for i in 0..<count {
            let c = content[i]
            guard String(cString: c.mime) == "text/plain" else { continue }
            let text = String(decoding: UnsafeRawBufferPointer(start: c.data, count: c.len), as: UTF8.self)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            return
        }
    }
}
