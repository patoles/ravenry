// The filmstrip's frames picked (sidetest.mjs --screen strip, after the
// big pane): on a pane at the window's size and on a big busy one (153 x
// 60, its frames over the daemon's 12 MiB so only some are pictured),
// presses on thumbnails, on the track and on Previous each show the frame
// picked, and the picture over the pane changes with it (its pixels
// compared, under the "Showing" bar). A moment on the track the daemon
// kept no picture of shows the closest pictured frame, with a line saying
// so. The maintainer (0.1.34): "Selecting a frame in last 20 seconds doesnt change
// the preview image".

import AppKit

extension SelfTestBoard {
    /// A press and a release at a point of a view (x, y from 0 to 1 of its bounds), as the window gets them.
    func click(_ v: NSView, fx: CGFloat, fy: CGFloat = 0.5) {
        window.contentView?.layoutSubtreeIfNeeded()
        let p = v.convert(NSPoint(x: v.bounds.width * fx, y: v.bounds.height * fy), to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            if let e = NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                          windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) {
                window.sendEvent(e)
            }
        }
        settle(0.2)
    }

    /// A picture's pixels, as RGBA rows from its top.
    func pixels(_ img: CGImage) -> [UInt8] {
        let w = img.width, h = img.height
        var d = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = CGContext(data: &d, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        ctx?.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        return d
    }

    /// How many pixels differ between two pictures of the same size (every one, if the sizes differ).
    func differ(_ a: [UInt8], _ b: [UInt8]) -> Int {
        guard a.count == b.count else { return max(a.count, b.count) / 4 }
        var n = 0, i = 0
        while i < a.count {
            if abs(Int(a[i]) - Int(b[i])) + abs(Int(a[i + 1]) - Int(b[i + 1])) + abs(Int(a[i + 2]) - Int(b[i + 2])) > 24 { n += 1 }
            i += 4
        }
        return n
    }

    /// The frame over the pane as drawn, under its bar: what the person sees of the picture.
    func filmShownPixels() -> [UInt8] {
        let v = board.ws.filmView
        guard v.window != nil, let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return [] }
        v.cacheDisplay(in: v.bounds, to: rep)
        guard let img = rep.cgImage else { return [] }
        let k = CGFloat(img.height) / max(1, v.bounds.height)
        let top = Int((v.barHeight + 1) * k)
        guard let cut = img.cropping(to: CGRect(x: 0, y: top, width: img.width, height: max(1, img.height - top))) else { return [] }
        return pixels(cut)
    }

    func filmPicks() {
        let ws = board.ws
        // The ladder's Claude tab when the driver names it (SIDETEST_FILM_CONTENT), else
        // a long output that goes on scrolling, a line of words every 0.1 s, under a spinner.
        let own = ProcessInfo.processInfo.environment["RAVENRY_MAC_FILM_CONTENT"].flatMap { $0.isEmpty ? nil : $0 }
        let scroll = "i=0; tr '\\n' ' ' < /usr/share/dict/words | fold -w 150 | head -n 2000 | while IFS= read -r l; do "
            + "printf '\\r\\033[K%s\\n\\033[38;5;208m* Working (%d)\\033[0m\\r' \"$l\" $i; i=$((i+1)); sleep 0.1; done"
        let cmd = own.map { ["/bin/zsh", $0] } ?? ["/bin/sh", "-c", scroll]
        for (name, big) in [("small", false), ("big", true)] {
            guard let id = ((try? ws.conn.call("pane.new", ["cols": 80, "rows": 24, "name": "Film \(name)", "labels": [:] as [String: String], "cwd": ws.home, "command": cmd], timeout: 5))?["pane"] as? [String: Any])?["id"] as? String,
                  let tab = ws.tab(showing: id) ?? { _ = wait(5) { ws.tab(showing: id) != nil }; return ws.tab(showing: id) }() else {
                check("film_pick_\(name)_pane", false, "no pane"); continue
            }
            ws.show(tab)
            if big { _ = try? ws.conn.call("pane.override", ["pane": id, "cols": 153, "rows": 60, "no_wait": true], timeout: 5) }
            settle(6)
            ws.film.load(id)
            _ = wait(30) { !ws.film.loading }
            let f = ws.film
            board.render(force: true)
            settle(0.4)
            let px = f.frames.first.map { "\($0.image.width)x\($0.image.height)" } ?? "-"
            check("film_pick_\(name)_read", f.error == nil && f.frames.count >= 4 && (!big || f.total > f.frames.count),
                  "\(f.frames.count) of \(f.total) pictured at \(px), err \(f.error ?? "-")")
            guard f.frames.count >= 4, f.controls["track"] != nil else { continue }

            // Each press: what it showed, the frame's own pixels, and what is drawn over the pane.
            var seen: [(how: String, shown: Int, frame: [UInt8], drawn: [UInt8])] = []
            var wrongFrame: [String] = []
            func record(_ how: String, want: Int?) {
                settle(0.2)
                guard let i = f.shown, ws.filmView.superview === ws.stage else { wrongFrame.append("\(how): nothing shown"); return }
                if let w = want, w != i { wrongFrame.append("\(how): showed \(i) want \(w)") }
                if ws.filmView.image !== f.frames[i].image { wrongFrame.append("\(how): the view draws another picture than frame \(i)'s") }
                seen.append((how, i, pixels(f.frames[i].image), filmShownPixels()))
                if seen.count <= 6 { pictureOver("native-film-pick-\(name)-\(seen.count).png", [ws.filmView]) }
            }
            // The pointer: the hand over a thumbnail and the track, the arrow over the frame (not the terminal's I-beam under it).
            if name == "small" {
                f.showFrame(0)
                settle(0.3)
                checkPointer("film_thumb", f.controls.keys.sorted().first { $0.hasPrefix("thumb:") }.flatMap { f.controls[$0] }, want: "hand")
                checkPointer("film_track", f.controls["track"], want: "hand")
                checkPointer("film_frame_over_terminal", ws.filmView, at: NSPoint(x: ws.filmView.bounds.midX, y: ws.filmView.bounds.height * 0.6), want: "arrow")
                checkPointer("film_back_to_live", ws.filmView.back, want: "hand")
                ws.filmView.back.performClick(nil)
                settle(0.2)
            }
            // Three thumbnails, pressed as the person would.
            let keys = f.controls.keys.filter { $0.hasPrefix("thumb:") }.sorted { Int($0.dropFirst(6))! < Int($1.dropFirst(6))! }
            for k in [keys.first, keys.dropFirst(keys.count / 2).first, keys.last].compactMap({ $0 }) {
                guard let v = f.controls[k] else { continue }
                click(v)
                record("thumb \(k)", want: Int(k.dropFirst(6)))
            }
            // The track at three places: the frame closest to that moment.
            for x in [CGFloat(0.15), 0.5, 0.85] {
                guard let tr = f.controls["track"] else { continue }
                click(tr, fx: x)
                let t = f.trackTime(x)
                let at = f.allMarks.map(\.at).min { abs($0.timeIntervalSince(t)) < abs($1.timeIntervalSince(t)) } ?? t
                let want = f.frames.indices.min { abs(f.frames[$0].at.timeIntervalSince(at)) < abs(f.frames[$1].at.timeIntervalSince(at)) }
                record("track \(x)", want: want)
            }
            // Previous, twice.
            for n in 1...2 {
                let was = f.shown ?? 0
                if let p = f.controls["prev"] { click(p) }
                record("previous \(n)", want: max(0, was - 1))
            }
            check("film_pick_\(name)_shows_the_frame", wrongFrame.isEmpty, wrongFrame.joined(separator: "; "))
            // All of the frame shows: inside the view, under its bar (its 8 px margin may go past the edges).
            let fv = ws.filmView, pr = fv.pictureRect, m = fv.fit * 8
            check("film_pick_\(name)_whole_frame", pr.maxX - m <= fv.bounds.width + 0.5 && pr.maxY - m <= fv.bounds.height + 0.5,
                  "picture \(pr) in \(fv.bounds.size), drawn at \(String(format: "%.2f", fv.fit)) of the live size")
            // Each press that showed a frame whose picture differs from the one before shows a different picture.
            var stuck: [String] = [], changed = 0
            for (a, b) in zip(seen, seen.dropFirst()) where a.shown != b.shown {
                let framesDiffer = differ(a.frame, b.frame)
                guard framesDiffer > 0 else { continue }
                let drawnDiffer = differ(a.drawn, b.drawn)
                if drawnDiffer == 0 { stuck.append("\(a.how) -> \(b.how) (frames \(a.shown) -> \(b.shown), \(framesDiffer) px differ in the frames, none on screen)") } else { changed += 1 }
            }
            check("film_pick_\(name)_picture_changes", stuck.isEmpty && changed >= 3, "\(changed) changed; " + stuck.joined(separator: "; "))
            // A moment with no picture: the closest pictured frame, and the line saying so.
            let pictured = Set(f.frames.map(\.at))
            if let gap = f.allMarks.first(where: { !pictured.contains($0.at) }), let tr = f.controls["track"] {
                click(tr, fx: f.trackX(gap.at))
                let near = f.frames.indices.min { abs(f.frames[$0].at.timeIntervalSince(gap.at)) < abs(f.frames[$1].at.timeIntervalSince(gap.at)) }
                check("film_pick_\(name)_nearest", f.wanted != nil && f.shown == near && ws.filmView.note.hasPrefix("No picture was kept of that moment"),
                      "wanted \(f.wanted.map(Film.hms) ?? "nil") shown \(f.shown ?? -1) want \(near ?? -1) note '\(ws.filmView.note)'")
                pictureOver("native-film-pick-\(name)-nearest.png", [ws.filmView])
            } else if big {
                check("film_pick_\(name)_nearest", false, "every frame pictured (\(f.frames.count) of \(f.total))")
            }
            // A pictured moment says nothing more.
            if let tr = f.controls["track"], let last = f.frames.last {
                click(tr, fx: f.trackX(last.at))
                check("film_pick_\(name)_pictured_no_line", f.wanted == nil && ws.filmView.note.isEmpty, "note '\(ws.filmView.note)'")
            }
            ws.filmView.back.performClick(nil)
            (f.controls["close"] as? RButton)?.run?()
            ws.closePane(id)
            settle(0.3)
        }
    }
}
