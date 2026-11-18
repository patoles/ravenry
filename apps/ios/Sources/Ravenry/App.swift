// The iPhone app (docs/PHONE.md): a thin native shell around the shared
// phone board. Paired, it opens on the board (the launch's Ink over it on a
// cold start); not paired, or signed out, on the pairing screens. A
// `ravenry://pair` link opens the pairing's "Pair with ...?" whenever it is
// tapped.

import UIKit
import SwiftUI
import UserNotifications

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ app: UIApplication, didFinishLaunchingWithOptions o: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Read here first, on the main thread: UIDevice is the main thread's, and a first read
        // from another thread (a request's reach words) can wait on the main thread while the
        // main thread waits on that same first read (the board's layout): the app stood still.
        _ = Device.pad
        #if DEBUG
        if ProcessInfo.processInfo.environment["RAVENRY_RESET"] == "1" { Store.shared.wipe(); Log.say("start: wiped for a check") }
        // The demo's check (Tests/RavenryUITests): iOS's ask for alerts at the start, as the alerts' ask after pairing would have it.
        if ProcessInfo.processInfo.environment["RAVENRY_TEST_ASK_ALERTS"] == "1" { UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in AlertCenter.shared.refresh() } }
        #endif
        Log.say("start: Ravenry \(PairModel.appVersion), \(Store.shared.paired() == nil ? "not paired" : "paired")")
        AlertCenter.shared.setUp()
        Net.watch()
        Revokes.run()
        return true
    }

    func application(_ app: UIApplication, configurationForConnecting s: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let c = UISceneConfiguration(name: "Default", sessionRole: s.role)
        c.delegateClass = SceneDelegate.self
        return c
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    static var pendingAlert: [String: Any]?
    var window: UIWindow?
    private var board: BoardController?
    private var pairing: PairModel?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let ws = scene as? UIWindowScene else { return }
        let w = UIWindow(windowScene: ws)
        w.backgroundColor = Shared.dynamic("win")
        window = w
        Hub.onSignedOut = { [weak self] in
            Log.say("the Mac signed this phone out")
            Store.shared.clear(); Hub.reset()
            self?.showPairing(signedOut: true)
        }
        if let n = options.notificationResponse, let s = n.notification.request.content.userInfo["alert"] as? String {
            Self.pendingAlert = (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any]
        }
        if let u = options.urlContexts.first?.url, u.scheme == "ravenry" { showPairing(link: u.absoluteString) }
        else if Store.shared.paired() != nil { showBoard(cold: true) }
        else { showPairing() }
        w.makeKeyAndVisible()
    }

    func scene(_ scene: UIScene, openURLContexts c: Set<UIOpenURLContext>) {
        guard let u = c.first?.url, u.scheme == "ravenry" else { return }
        showPairing(link: u.absoluteString)
    }

    // Each said in the log: a field log shows when the app was away and came back.
    func sceneDidBecomeActive(_ s: UIScene) { Log.say("app: in front"); AlertCenter.shared.refresh { self.board?.appeared() } }
    func sceneWillResignActive(_ s: UIScene) {}
    func sceneDidEnterBackground(_ s: UIScene) { Log.say("app: in the background"); board?.disappeared() }

    func showBoard(cold: Bool) {
        guard let w = window else { return }
        // Nothing of the pairing keeps the keyboard (see PairModel.step).
        w.endEditing(true)
        let b = BoardController()
        b.pending = Self.pendingAlert
        Self.pendingAlert = nil
        board = b
        pairing = nil
        AlertCenter.shared.board = b
        w.rootViewController = b
        b.loadViewIfNeeded()
        if cold {
            b.ink = InkLaunch.begin(over: b.view, dark: w.traitCollection.userInterfaceStyle == .dark)
            b.ink?.onEnd = { [weak b] in b?.ink = nil }
        }
        if UIApplication.shared.applicationState == .active { b.appeared() }
        Log.say("board: shown (\(cold ? "cold start" : "after pairing"))")
    }

    /// The demo (Board.swift): the board on sample projects, in a web view that keeps nothing; never once a Mac is paired.
    func showDemo() {
        guard let w = window, Store.shared.paired() == nil else { return }
        w.endEditing(true)
        let b = BoardController()
        b.demo = true
        board = b
        pairing = nil
        AlertCenter.shared.board = b
        w.rootViewController = b
        b.loadViewIfNeeded()
        if UIApplication.shared.applicationState == .active { b.appeared() }
        Log.say("demo: shown (no Mac, no connection)")
    }

    /// Scan the code again, from the page that says the Mac did not answer
    /// (Board.swift pair.again): the pairing screen with a Back to the board,
    /// the pairing kept until a new one is made.
    func pairAgain() {
        guard Store.shared.paired() != nil else { showPairing(); return }
        showPairing(again: true)
    }

    func showPairing(signedOut: Bool = false, link: String? = nil, again: Bool = false) {
        guard let w = window else { return }
        board?.disappeared()
        board = nil
        AlertCenter.shared.board = nil
        let m = pairing ?? PairModel(signedOut: signedOut)
        if signedOut { m.error = "This \(Device.word) was signed out. Scan the code on the Mac again."; m.step = .scan }
        m.onDone = { [weak self] in self?.showBoard(cold: false) }
        m.onDemo = { [weak self] in self?.showDemo() }
        m.onBack = again ? { [weak self] in self?.showBoard(cold: false) } : nil
        if pairing == nil {
            pairing = m
            w.rootViewController = UIHostingController(rootView: PairRoot(m: m))
        }
        if let link { m.open(link: link) }
        Log.say("pairing: shown\(link != nil ? " (a pairing link)" : signedOut ? " (signed out)" : again ? " (again, from the page that says the Mac did not answer)" : "")")
    }
}
