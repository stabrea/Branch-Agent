import Capacitor
import UIKit
import WebKit

/// The one window: the phone app's own page, and the owner's Branch once it is opened.
class BranchViewController: CAPBridgeViewController, WKScriptMessageHandler {
    private var priming: (session: BranchSession, at: String)?
    private var loadingWatch: NSKeyValueObservation?
    private var statusStyle: UIStatusBarStyle = .lightContent
    /// Held here: a web view keeps its UI delegate weakly.
    private var mediaGuard: BranchMediaGuard?

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(BranchPhonePlugin())
        view.backgroundColor = BranchNative.dynamic("ground")
        webView?.isOpaque = false
        webView?.backgroundColor = BranchNative.dynamic("ground")
        // mac7/phone-pairing review: the "never allow" list holds for the camera and microphone too.
        if let web = webView, let capacitor = web.uiDelegate {
            mediaGuard = BranchMediaGuard(inner: capacitor, local: bridge?.config.localURL)
            web.uiDelegate = mediaGuard
        }
        guard let controller = webView?.configuration.userContentController else { return }
        // A script with no secret in it; it acts only where the app has written its note (see inject.js).
        if let url = Bundle.main.url(forResource: "inject", withExtension: "js", subdirectory: "public"),
           let source = try? String(contentsOf: url, encoding: .utf8) {
            controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        controller.add(self, name: "branchPhone")
        loadingWatch = webView?.observe(\.isLoading, options: [.new]) { [weak self] webView, _ in
            if !webView.isLoading { self?.finishPriming(webView) }
        }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { statusStyle }

    /// Loads one harmless file from the paired Branch, writes the key into that address's own
    /// session storage (as public/pair.js does), then opens the window itself.
    func openBranch(_ session: BranchSession, at place: String) {
        guard let url = URL(string: session.origin + "/tokens.css") else { return }
        priming = (session, place)
        webView?.load(URLRequest(url: url))
    }

    private func finishPriming(_ webView: WKWebView) {
        guard let (session, place) = priming, BranchRules.origin(of: webView.url) == session.origin,
              webView.url?.path == "/tokens.css" else { return }
        priming = nil
        let note: [String: Any] = ["deviceId": session.deviceId ?? "", "deviceKey": session.deviceKey ?? "", "at": place,
                                   "home": BranchNative.word("phone.home.back", "Back to the phone app")]
        guard let noteData = try? JSONSerialization.data(withJSONObject: note),
              let noteText = String(data: noteData, encoding: .utf8) else { return }
        let script = "sessionStorage.setItem('branch-token', \(Self.literal(session.token)));"
            + "sessionStorage.setItem('branch-phone', \(Self.literal(noteText))); location.replace('/');"
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    /// A string written as a JavaScript literal (JSON's quoting), so nothing in it can end the script.
    static func literal(_ text: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [text]), let array = String(data: data, encoding: .utf8) else { return "''" }
        return String(array.dropFirst().dropLast())
    }

    /// Messages from the Branch window, accepted only from the paired address.
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        let from = "\(origin.protocol)://\(origin.host)" + (origin.port > 0 ? ":\(origin.port)" : "")
        guard let paired = BranchKeychain.load()?.origin, BranchRules.checkOrigin(from) == paired,
              let text = message.body as? String, let data = text.data(using: .utf8),
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        switch body["type"] as? String {
        case "home": goHome()
        case "look": remember(theme: body["theme"] as? String ?? "slate", mode: body["mode"] as? String ?? "dark")
        default: break
        }
    }

    private func goHome() {
        guard let local = bridge?.config.localURL else { return }
        webView?.load(URLRequest(url: local))
    }

    /// The window's theme and mode, so the phone's own page, the status bar and the share sheet match it.
    private func remember(theme: String, mode: String) {
        UserDefaults.standard.set(["theme": theme, "mode": mode], forKey: "branch-look")
        overrideUserInterfaceStyle = mode == "light" ? .light : .dark
        statusStyle = mode == "light" ? .darkContent : .lightContent
        setNeedsStatusBarAppearanceUpdate()
    }
}
