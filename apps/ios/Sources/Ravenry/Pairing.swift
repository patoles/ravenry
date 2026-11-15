// Pairing with the computer (docs/PHONE.md section 3; the Android app's
// PairActivity, as round 1 drew it for the iPhone): the QR code through the
// camera, the code typed with its check number, the `ravenry://pair` link
// (asked first), then, on the next screen with "Connected to <Mac>" on
// top, Which iPhone is this (when iPhones get alerts through ntfy) and the
// alerts' one ask. Native, since there is no board to show yet.

import SwiftUI
import AVFoundation
import UserNotifications
import CoreImage

@MainActor
final class PairModel: ObservableObject {
    enum Step: Equatable {
        case scan
        case typing(address: String, code: String)
        case check(PairLink, pin: String)
        case confirm(PairLink)
        case busy
        case which([Iphone])
        case alerts
    }
    struct Iphone: Equatable, Identifiable { let id: String; let name: String }

    /// A screen without fields lets go of the keyboard: a field of the typed code left
    /// focused under the next screens began a text session again each time the app came
    /// back to the front (iOS's alerts ask), which stalled the app on an iPad under XCUITest.
    @Published var step: Step = .scan {
        didSet {
            if case .typing = step { return }
            let off = { _ = UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
            if Thread.isMainThread { off() } else { DispatchQueue.main.async(execute: off) }
        }
    }
    @Published var error: String?
    /// Why the computer did not answer, when there is something to open for it (Tailscale, Settings).
    @Published var reach: Reach.Why?
    /// "Connected to <Mac>": a line on top of the screen right after pairing.
    @Published var connected: String?
    @Published var choice: String?
    var onDone: () -> Void = {}
    private var scanned = false

    init(signedOut: Bool = false) {
        if signedOut { error = "This \(Device.word) was signed out. Scan the code on the Mac again." }
    }

    static var appVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }

    /// A `ravenry://pair` link, tapped or pasted: the person confirms which computer first.
    func open(link: String) {
        switch PairLink.parse(link) {
        case .success(let l): error = nil; reach = nil; step = .confirm(l)
        case .failure(let e): error = e.message
        }
    }

    /// The camera read a code (AVFoundation's QR reader).
    func scanned(_ text: String) {
        guard !scanned, step == .scan else { return }
        switch PairLink.parse(text) {
        case .success(let l): scanned = true; pair(l, pin: l.pin!)
        case .failure(let e): error = e.message
        }
    }

    func typedNext(address: String, code: String) {
        switch PairLink.typed(address: address, code: code) {
        case .success(let l): fetchKey(l)
        case .failure(let e): error = e.message
        }
    }

    private func client(_ link: PairLink, pin: String?) -> HubClient {
        let c = HubClient(hosts: link.hosts, port: link.port, pin: pin, token: nil, skip: Net.skip)
        // The first request to the Mac's Wi-Fi address may bring up iOS's
        // Local Network ask: it waits for the answer.
        c.localNetworkPatience = 60
        return c
    }

    private func words(_ e: Error, _ hosts: [String]) -> String {
        let f = e as? HubFailure
        if f?.pinRefused == true { return "The Mac answered with another key. Not paired." }
        let w = Net.why(f, hosts: hosts)
        reach = w.reason == "unreachable" ? nil : w
        return w.words
    }

    /// A typed code has no pin: take the computer's key, then show its check number.
    private func fetchKey(_ link: PairLink) {
        step = .busy; error = nil; reach = nil
        Task {
            let c = client(link, pin: nil)
            do {
                let r = try await c.call("GET", "/api/phone/hello")
                guard let pin = c.trust.seen else { throw HubFailure(hosts: link.hosts) }
                var l = link
                if let n = r.json?["name"] as? String { l.name = n }
                Log.say("pairing: the typed address answered; check number shown")
                step = .check(l, pin: pin)
            } catch {
                self.error = words(error, link.hosts)
                step = .typing(address: link.hosts[0], code: link.code)
            }
        }
    }

    func pair(_ link: PairLink, pin: String) {
        step = .busy; error = nil; reach = nil
        Task {
            let c = client(link, pin: pin)
            let body: [String: Any] = ["code": link.code, "name": UIDevice.current.name, "platform": "ios", "app": Self.appVersion]
            var o: [String: Any]?
            do {
                let r = try await c.call("POST", "/api/phone/pair", json: body)
                o = r.json
                if r.status != 200 || o == nil { throw PairError(message: (o?["error"] as? String) ?? "The Mac did not pair (\(r.status)).") }
                if let hp = (o?["hub"] as? [String: Any])?["pin"] as? String, hp != pin { throw PairError(message: "The Mac answered with another key. Not paired.") }
            } catch let e as PairError {
                Log.say("pairing: refused (\(e.message))")
                error = e.message; scanned = false; step = .scan; return
            } catch {
                Log.say("pairing: no answer")
                self.error = words(error, link.hosts); scanned = false
                step = (error as? HubFailure)?.pinRefused == true ? .scan : .confirm(link)
                return
            }
            let hub = o?["hub"] as? [String: Any] ?? [:]
            let dev = o?["device"] as? [String: Any] ?? [:]
            var hosts = [c.host]
            for h in link.hosts where !hosts.contains(h) { hosts.append(h) }
            let p = Paired(hubName: hub["name"] as? String ?? link.name, hosts: hosts, port: hub["port"] as? Int ?? link.port, pin: pin,
                           token: o?["token"] as? String ?? "", deviceId: dev["id"] as? String ?? "", deviceName: dev["name"] as? String ?? UIDevice.current.name, lastHost: c.host)
            Store.shared.save(p)
            Log.say("pairing: paired with \(MacName.say(p.hubName)) as \(p.deviceId); the token is in the Keychain")
            connected = "Connected to \(MacName.say(p.hubName))"
            let list = (o?["iphones"] as? [[String: Any]] ?? []).compactMap { x -> Iphone? in
                guard let id = x["id"] as? String else { return nil }
                return Iphone(id: id, name: x["name"] as? String ?? "iPhone")
            }
            if !list.isEmpty { choice = list[0].id; step = .which(list) } else { await afterWhich() }
        }
    }

    /// "Which iPhone is this?": the answer goes to the Mac as this device (docs/PHONE.md section 4).
    func whichContinue() {
        guard case .which = step else { return }
        let id = choice
        Task {
            if let id, let p = Store.shared.paired() {
                let c = HubClient.of(p)
                do {
                    let r = try await c.call("POST", "/api/phone/takeover", json: ["id": id])
                    guard r.status == 200, let d = r.json?["device"] as? [String: Any] else { throw PairError(message: (r.json?["error"] as? String) ?? "The Mac did not take it (\(r.status)).") }
                    var q = p
                    q.deviceId = d["id"] as? String ?? q.deviceId
                    q.deviceName = d["name"] as? String ?? q.deviceName
                    Store.shared.save(q)
                    Log.say("pairing: this iPhone is \(q.deviceName) (\(q.deviceId)), through ntfy until now")
                } catch {
                    self.error = (error as? PairError)?.message ?? words(error, p.hosts)
                    return
                }
            }
            connected = nil
            await afterWhich()
        }
    }

    /// The alerts' ask, once ever on this phone and only while iOS has not been asked.
    private func afterWhich() async {
        let s = await UNUserNotificationCenter.current().notificationSettings()
        if s.authorizationStatus == .notDetermined && !Store.shared.alertsAsked {
            Store.shared.alertsAsked = true
            step = .alerts
        } else { onDone() }
    }

    func alertsOn() {
        Task {
            let ok = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            Log.say("alerts: iOS's answer \(ok ? "allowed" : "not allowed")")
            onDone()
        }
    }

    func back() {
        error = nil; reach = nil
        switch step {
        case .check(let l, _): step = .typing(address: l.hosts[0], code: l.code)
        case .typing, .confirm: step = .scan
        default: break
        }
    }
}

// ------------------------------------------------------------ the screens

struct PairRoot: View {
    @ObservedObject var m: PairModel
    @Environment(\.colorScheme) var scheme
    var body: some View {
        let t = T(dark: scheme == .dark)
        Group {
            switch m.step {
            case .scan, .busy: PairScan(m: m, t: t, busy: m.step == .busy)
            case .typing(let a, let c): PairTyped(m: m, t: t, address: a, code: c)
            case .check(let l, let pin): PairCheck(m: m, t: t, link: l, pin: pin)
            case .confirm(let l): PairConfirm(m: m, t: t, link: l)
            case .which(let list): WhichIPhone(m: m, t: t, list: list)
            case .alerts: AlertsAsk(m: m, t: t)
            }
        }
        .animation(nil, value: m.step)
    }
}

struct Brand: View { let t: T
    var body: some View { HStack(spacing: 8) { Mark(ink: t.tx, size: 26); Text("Ravenry").font(.system(size: 18, weight: .semibold)).foregroundStyle(t.tx) } }
}

struct Primary: View { let t: T; let title: String; var enabled = true; let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 17, weight: .semibold)).foregroundStyle(.white).frame(maxWidth: .infinity).frame(height: 50).background(Capsule().fill(t.work.opacity(enabled ? 1 : 0.5)))
        }.buttonStyle(.plain).disabled(!enabled)
    }
}
struct Secondary: View { let t: T; let title: String; let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 17, weight: .semibold)).foregroundStyle(t.tx).frame(maxWidth: .infinity).frame(height: 46)
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(t.line, lineWidth: 1.5)).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
}

/// The error and, when there is something to open for it, its button (Tailscale, Settings).
struct Trouble: View { @ObservedObject var m: PairModel; let t: T
    var body: some View {
        if let e = m.error { Text(e).font(.system(size: 15)).foregroundStyle(t.bad).padding(.top, 14).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("pair-error") }
        if let w = m.reach {
            let label = w.reason == "local-network-off" ? "Open Settings" : w.reason == "tailscale-off" ? "Open Tailscale" : "Get Tailscale"
            Secondary(t: t, title: label) { if w.reason == "local-network-off" { Net.openSettings() } else { Net.openTailscale() } }.padding(.top, 12)
        }
    }
}

/// A pairing screen: the phone's, and on an iPad's width a centred column of 640 pt (C, picked 2026-11-15).
struct Page<C: View>: View { let t: T; var scroll = true; @ViewBuilder var content: C
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Brand(t: t).padding(.top, 14).padding(.bottom, 26)
            content
        }.padding(.horizontal, 20).frame(maxWidth: 640, maxHeight: .infinity, alignment: .topLeading).frame(maxWidth: .infinity).background(t.win.ignoresSafeArea())
    }
}

struct Foot: View { let t: T
    var body: some View { Text("No account. Your sessions stay on your machines.").font(.system(size: 13)).foregroundStyle(t.tx2).frame(maxWidth: .infinity).padding(.bottom, 8) }
}

struct Title: View { let t: T; let title: String; let sub: String
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).font(.system(size: 28, weight: .bold)).foregroundStyle(t.tx).fixedSize(horizontal: false, vertical: true)
            Text(sub).font(.system(size: 16)).foregroundStyle(t.tx2).padding(.top, 8).fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct PairScan: View { @ObservedObject var m: PairModel; let t: T; let busy: Bool
    @State private var camera: AVAuthorizationStatus = AVCaptureDevice.authorizationStatus(for: .video)
    private var hasCamera: Bool { AVCaptureDevice.default(for: .video) != nil }
    var body: some View {
        Page(t: t) {
            Title(t: t, title: "Pair with your Mac", sub: "On the Mac, click the phone button in Ravenry and point the camera at the code it shows.")
            ZStack {
                Color(red: 0.118, green: 0.118, blue: 0.129)
                if busy {
                    VStack(spacing: 12) { ProgressView().tint(.white); Text("Pairing…").foregroundStyle(.white) }
                } else if camera == .authorized && hasCamera {
                    QRCamera { m.scanned($0) }
                } else if camera != .notDetermined || !hasCamera {
                    Text("The camera is off. Allow it, or type the code instead.").font(.system(size: 14)).foregroundStyle(Color(white: 0.63)).multilineTextAlignment(.center).padding(32)
                }
                Corners().stroke(.white, style: StrokeStyle(lineWidth: 3, lineCap: .round)).frame(width: 200, height: 200)
                VStack { Spacer(); HStack(spacing: 6) { Image(systemName: "qrcode").font(.system(size: 14, weight: .semibold)); Text("Hold it inside the corners").font(.system(size: 14, weight: .semibold)) }
                    .foregroundStyle(.white).padding(.horizontal, 14).padding(.vertical, 8).background(Capsule().fill(.black.opacity(0.75))).padding(.bottom, 14) }
            // At most 400 pt square (a phone's whole width), so the screen fits an iPad sideways.
            }.frame(maxWidth: 400).aspectRatio(1, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 20)).frame(maxWidth: .infinity).padding(.top, 20)
            Trouble(m: m, t: t)
            Button { UIApplication.shared.open(URL(string: "https://tailscale.com/download")!) } label: {
                (Text("Not on your Mac's Wi-Fi? The \(Device.word) reaches it through Tailscale. ").foregroundStyle(t.tx2) + Text("Set up Tailscale").foregroundStyle(t.work).bold()).font(.system(size: 15)).multilineTextAlignment(.leading)
            }.buttonStyle(.plain).padding(.top, 18)
            Button { m.error = nil; m.reach = nil; m.step = .typing(address: "", code: "") } label: {
                (Text("Camera not working? ").foregroundStyle(t.tx2) + Text("Type the code instead").foregroundStyle(t.work).bold()).font(.system(size: 15))
            }.buttonStyle(.plain).padding(.top, 14).disabled(busy).accessibilityIdentifier("type-instead")
            Spacer()
            Foot(t: t)
        }
        .onAppear {
            // Asked when the camera's screen shows, not before: a pairing link opens on "Pair with ...?" and needs no camera.
            if camera == .notDetermined && hasCamera { AVCaptureDevice.requestAccess(for: .video) { ok in DispatchQueue.main.async { camera = ok ? .authorized : .denied } } }
        }
    }
}

struct Corners: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path(); let l: CGFloat = 26
        for (c, dx, dy) in [(CGPoint(x: r.minX, y: r.minY), 1.0, 1.0), (CGPoint(x: r.maxX, y: r.minY), -1.0, 1.0), (CGPoint(x: r.minX, y: r.maxY), 1.0, -1.0), (CGPoint(x: r.maxX, y: r.maxY), -1.0, -1.0)] {
            p.move(to: CGPoint(x: c.x + l * dx, y: c.y)); p.addLine(to: c); p.addLine(to: CGPoint(x: c.x, y: c.y + l * dy))
        }
        return p
    }
}

struct Field: View { let t: T; let label: String; @Binding var value: String; var mono = false; var id: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.system(size: 13, weight: .semibold)).foregroundStyle(t.tx2)
            TextField("", text: $value)
                .font(mono ? .system(size: 18, design: .monospaced) : .system(size: 17)).foregroundStyle(t.tx)
                .textInputAutocapitalization(mono ? .characters : .never).autocorrectionDisabled(true)
                .keyboardType(mono ? .asciiCapable : .URL)
                .padding(.horizontal, 14).frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 12).fill(t.card)).overlay(RoundedRectangle(cornerRadius: 12).stroke(t.line))
                .accessibilityIdentifier(id)
        }
    }
}

struct PairTyped: View { @ObservedObject var m: PairModel; let t: T
    @State var address: String
    @State var code: String
    init(m: PairModel, t: T, address: String, code: String) { self.m = m; self.t = t; _address = State(initialValue: address); _code = State(initialValue: code) }
    var body: some View {
        Page(t: t) {
            Title(t: t, title: "Type the code instead", sub: "Type the address and the code the Mac shows under its QR code.").padding(.bottom, 22)
            Field(t: t, label: "The Mac's address", value: $address, id: "pair-address").padding(.bottom, 16)
            Field(t: t, label: "The code", value: $code, mono: true, id: "pair-code").padding(.bottom, 8)
            Trouble(m: m, t: t)
            Primary(t: t, title: "Next") { m.typedNext(address: address, code: code) }.padding(.top, 16).accessibilityIdentifier("pair-next")
            Secondary(t: t, title: "Back") { m.back() }.padding(.top, 10)
            Spacer()
        }
    }
}

struct PairCheck: View { @ObservedObject var m: PairModel; let t: T; let link: PairLink; let pin: String
    var body: some View {
        Page(t: t) {
            Title(t: t, title: "Does the Mac show this number?", sub: "It is under the code on the Mac. Pair only when the two match.")
            Text(Pins.checkNumber(pin)).font(.system(size: 34, weight: .semibold, design: .monospaced)).foregroundStyle(t.tx).frame(maxWidth: .infinity).padding(.vertical, 26)
                .background(RoundedRectangle(cornerRadius: 16).fill(t.card)).padding(.vertical, 24).accessibilityIdentifier("check-number")
            Primary(t: t, title: "They match, pair") { m.pair(link, pin: pin) }.accessibilityIdentifier("pair-match")
            Secondary(t: t, title: "Back") { m.back() }.padding(.top, 10)
            Trouble(m: m, t: t)
            Spacer()
        }
    }
}

struct PairConfirm: View { @ObservedObject var m: PairModel; let t: T; let link: PairLink
    var body: some View {
        Page(t: t) {
            // The computer by its name only: its addresses mean nothing to a person.
            Title(t: t, title: "Pair with \(MacName.say(link.name))?", sub: "Only pair with a computer of your own: it will see your answers and can ask you for secrets.").padding(.bottom, 24)
            Primary(t: t, title: "Pair") { m.pair(link, pin: link.pin!) }.padding(.top, 24).accessibilityIdentifier("pair-confirm")
            Secondary(t: t, title: "Back") { m.back() }.padding(.top, 10)
            Trouble(m: m, t: t)
            Spacer()
            Foot(t: t)
        }
    }
}

struct ConnectedLine: View { let t: T; let text: String
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(t.ok).font(.system(size: 18))
            Text(text).font(.system(size: 15, weight: .semibold)).foregroundStyle(t.tx)
        }.padding(.horizontal, 14).padding(.vertical, 9).background(Capsule().fill(t.card)).accessibilityIdentifier("connected-line")
    }
}

// PHONE.md 4, "Which iPhone is this?": asked once at pairing when the Mac has iPhones through ntfy.
struct WhichIPhone: View { @ObservedObject var m: PairModel; let t: T; let list: [PairModel.Iphone]
    var body: some View {
        Page(t: t) {
            if let c = m.connected { ConnectedLine(t: t, text: c).padding(.bottom, 22) }
            Title(t: t, title: "Which \(Device.model) is this?", sub: "Your Mac already sends alerts to an \(Device.model) through ntfy. If it is this one, its alerts move to this app.").padding(.bottom, 22)
            VStack(spacing: 0) {
                ForEach(list) { x in
                    Row(t: t, title: x.name, sub: "Gets alerts through ntfy", on: m.choice == x.id, id: "which-\(x.id)") { m.choice = x.id }
                    Divider().overlay(t.line).padding(.leading, 52)
                }
                Row(t: t, title: "A new \(Device.model)", sub: "Keep the other one as it is", on: m.choice == nil, id: "which-new") { m.choice = nil }
            }.background(RoundedRectangle(cornerRadius: 16).fill(t.card)).padding(.top, 22)
            Trouble(m: m, t: t)
            Spacer()
            Primary(t: t, title: "Continue") { m.whichContinue() }.padding(.bottom, 8).accessibilityIdentifier("which-continue")
        }
    }
    struct Row: View { let t: T; let title: String; let sub: String; let on: Bool; let id: String; let tap: () -> Void
        var body: some View {
            Button(action: tap) {
                HStack(spacing: 14) {
                    Image(systemName: on ? "largecircle.fill.circle" : "circle").font(.system(size: 22)).foregroundStyle(on ? t.work : t.tx3)
                    VStack(alignment: .leading, spacing: 2) { Text(title).font(.system(size: 17, weight: .medium)).foregroundStyle(t.tx); Text(sub).font(.system(size: 14)).foregroundStyle(t.tx2) }
                    Spacer()
                }.padding(.horizontal, 16).padding(.vertical, 14).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityAddTraits(on ? .isSelected : []).accessibilityIdentifier(id)
        }
    }
}

// The alerts' ask (the Android app's, in its words), with the pairing's result on top (A).
struct AlertsAsk: View { @ObservedObject var m: PairModel; let t: T
    var body: some View {
        Page(t: t) {
            if let c = m.connected { ConnectedLine(t: t, text: c).padding(.bottom, 22) }
            ZStack { RoundedRectangle(cornerRadius: 16).fill(t.card); Mark(ink: t.tx, size: 48) }.frame(width: 70, height: 70).padding(.bottom, 24)
            Title(t: t, title: "Get an alert when a session needs you", sub: "A question, a command to approve or a finished task reaches this \(Device.word) at once, with buttons to answer it from the alert.")
            HStack(spacing: 12) {
                ZStack { Circle().fill(t.you); Mark(ink: .white, eye: .white, size: 22) }.frame(width: 34, height: 34)
                VStack(alignment: .leading, spacing: 2) { Text("paper-boat needs you").font(.system(size: 15, weight: .semibold)).foregroundStyle(t.tx); Text("The hull now follows the wave height.").font(.system(size: 14)).foregroundStyle(t.tx2) }
                Spacer()
            }.padding(14).background(RoundedRectangle(cornerRadius: 16).fill(t.card)).padding(.top, 22)
            Spacer()
            Primary(t: t, title: "Turn on alerts") { m.alertsOn() }.accessibilityIdentifier("alerts-on")
            Button { m.connected = nil; m.onDone() } label: { Text("Not now").font(.system(size: 17, weight: .semibold)).foregroundStyle(t.work).frame(maxWidth: .infinity).frame(height: 40) }.buttonStyle(.plain).padding(.top, 8).accessibilityIdentifier("alerts-not-now")
            Text("You can change it later in Settings.").font(.system(size: 13)).foregroundStyle(t.tx2).frame(maxWidth: .infinity).padding(.top, 10).padding(.bottom, 8)
        }
    }
}

// The mark (brand/ravenry Perch): Shaders.swift's ravenBody, the legs, the perch, the eye.
struct Mark: View {
    var ink: Color; var eye: Color = Color(Shared.color("work", dark: true)); var size: CGFloat
    var body: some View {
        Canvas { ctx, s in
            let k = s.width / 100
            var p = Path()
            let pts = CustomShader.flatten(CustomShader.ravenBody, seg: 12)
            if let f = pts.first { p.move(to: CGPoint(x: f.x * k, y: f.y * k)); for q in pts.dropFirst() { p.addLine(to: CGPoint(x: q.x * k, y: q.y * k)) }; p.closeSubpath() }
            ctx.fill(p, with: .color(ink))
            ctx.fill(Path(CGRect(x: 50 * k, y: 74 * k, width: 5 * k, height: 12 * k)), with: .color(ink))
            ctx.fill(Path(CGRect(x: 60 * k, y: 72 * k, width: 5 * k, height: 14 * k)), with: .color(ink))
            ctx.fill(Path(roundedRect: CGRect(x: 31 * k, y: 85 * k, width: 58 * k, height: 6 * k), cornerRadius: 3 * k), with: .color(ink))
            ctx.fill(Path(ellipseIn: CGRect(x: 58.5 * k, y: 25.5 * k, width: 13 * k, height: 13 * k)), with: .color(eye))
        }.frame(width: size, height: size)
    }
}

// ------------------------------------------------------------ the QR code

/// The camera with AVFoundation's QR reader: each code it reads, as text.
struct QRCamera: UIViewRepresentable {
    let onCode: (String) -> Void
    func makeUIView(context: Context) -> Preview { let v = Preview(); v.start(onCode); return v }
    func updateUIView(_ v: Preview, context: Context) {}
    static func dismantleUIView(_ v: Preview, coordinator: ()) { v.stop() }

    final class Preview: UIView, AVCaptureMetadataOutputObjectsDelegate {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        private let session = AVCaptureSession()
        private var onCode: (String) -> Void = { _ in }
        func start(_ f: @escaping (String) -> Void) {
            onCode = f
            guard let dev = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: dev), session.canAddInput(input) else { return }
            session.addInput(input)
            let out = AVCaptureMetadataOutput()
            guard session.canAddOutput(out) else { return }
            session.addOutput(out)
            out.setMetadataObjectsDelegate(self, queue: .main)
            out.metadataObjectTypes = [.qr]
            (layer as! AVCaptureVideoPreviewLayer).session = session
            (layer as! AVCaptureVideoPreviewLayer).videoGravity = .resizeAspectFill
            DispatchQueue.global().async { self.session.startRunning() }
        }
        func stop() { DispatchQueue.global().async { self.session.stopRunning() } }
        func metadataOutput(_ o: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from c: AVCaptureConnection) {
            for case let q as AVMetadataMachineReadableCodeObject in objects { if let s = q.stringValue { onCode(s) } }
        }
    }
}

/// QR codes in a still picture (Core Image's reader): the unit tests read the
/// Mac's code this way, since the simulator has no camera.
enum QR {
    static func decode(_ image: CGImage) -> [String] {
        let d = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])
        return (d?.features(in: CIImage(cgImage: image)) ?? []).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
    }
}
