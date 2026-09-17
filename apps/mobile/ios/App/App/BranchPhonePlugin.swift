import Capacitor
import LocalAuthentication
import UserNotifications
import WebKit

/// The phone app's page talks to the phone through this plugin only (see apps/mobile/web/vault.js).
/// The key a Branch hands over stays here and in the Keychain; this page never receives it. (Opening
/// the owner's Branch writes the key and this phone's secret into that address's own session storage,
/// as public/pair.js does, because the window sends them itself.)
@objc(BranchPhonePlugin)
public class BranchPhonePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BranchPhonePlugin"
    public let jsName = "BranchPhone"
    public let pluginMethods: [CAPPluginMethod] = [
        "pair", "session", "forget", "request", "getSwitches", "setSwitches", "switchesChanged", "unlock",
        "openBranch", "look", "notify", "lastSeen", "takeShared", "clearShared",
    ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

    /// Capacitor on iOS answers its bridge from whatever page the window shows, and the window also
    /// shows the owner's Branch. Every method here is for the phone app's own page only, so a call
    /// made while another page is showing is refused.
    private func fromAppPage(_ call: CAPPluginCall) -> Bool {
        var allowed = false
        let check = {
            guard let shown = self.bridge?.webView?.url, let local = self.bridge?.config.localURL else { return }
            allowed = shown.scheme == local.scheme && shown.host == local.host && shown.port == local.port
        }
        if Thread.isMainThread { check() } else { DispatchQueue.main.sync(execute: check) }
        if !allowed { call.reject("Only the phone app's own page may ask this.") }
        return allowed
    }

    @objc func pair(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        guard let origin = BranchRules.checkOrigin(call.getString("origin") ?? ""), let id = call.getString("id"),
              let code = call.getString("code") else {
            call.resolve(["paired": false, "error": BranchNative.word("phone.error.plainHttp", "That address is refused.")])
            return
        }
        Task {
            do {
                let session = try await BranchClient.pair(origin: origin, id: id, code: code, name: call.getString("name") ?? "iPhone")
                try BranchKeychain.save(session)
                call.resolve(["paired": true])
            } catch {
                call.resolve(["paired": false, "error": error.localizedDescription])
            }
        }
    }

    @objc func session(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        guard let session = BranchKeychain.load() else { call.resolve(["paired": false]); return }
        call.resolve(["paired": true, "origin": session.origin, "pairedAt": session.pairedAt, "deviceId": session.deviceId ?? ""])
    }

    @objc func forget(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        BranchKeychain.forget()
        call.resolve()
    }

    @objc func request(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        guard let session = BranchKeychain.load() else { call.reject("Not paired"); return }
        let method = call.getString("method") ?? "GET", path = call.getString("path") ?? ""
        let raw = call.getString("base64").flatMap { Data(base64Encoded: $0) }
        let body = call.getObject("body")
        Task {
            do {
                let answer = try await BranchClient.send(session, method: method, path: path, json: body, raw: raw,
                                                         contentType: call.getString("contentType"), query: call.getString("query"))
                call.resolve(["status": answer.status, "data": answer.json ?? NSNull()])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func getSwitches(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        call.resolve(["switches": BranchSwitches.all()])
    }

    @objc func setSwitches(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        BranchSwitches.save(call.getObject("switches") as? [String: String] ?? [:])
        call.resolve()
    }

    /// Asks for what a switch now needs: permission to notify, the background check, push.
    @objc func switchesChanged(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        let switches = BranchSwitches.all()
        if switches["notifications"] != "off" || switches["push"] != "off" {
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        }
        BranchBackground.schedule()
        DispatchQueue.main.async { BranchBackground.updatePush() }
        call.resolve()
    }

    @objc func unlock(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        let context = LAContext()
        var problem: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &problem) else {
            call.resolve(["unlocked": false, "reason": "unavailable"])
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: call.getString("reason") ?? "Branch") { unlocked, _ in
            call.resolve(["unlocked": unlocked])
        }
    }

    @objc func openBranch(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        guard let session = BranchKeychain.load() else { call.reject("Not paired"); return }
        DispatchQueue.main.async {
            (self.bridge?.viewController as? BranchViewController)?.openBranch(session, at: call.getString("at") ?? "")
            call.resolve()
        }
    }

    @objc func look(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        let saved = UserDefaults.standard.dictionary(forKey: "branch-look") ?? [:]
        call.resolve(["theme": saved["theme"] as? String ?? "forest", "mode": saved["mode"] as? String ?? "dark"])
    }

    @objc func notify(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        BranchBackground.show(id: call.getString("id") ?? UUID().uuidString, title: call.getString("title") ?? "Branch",
                              body: call.getString("body") ?? "")
        call.resolve()
    }

    @objc func lastSeen(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        call.resolve(["at": UserDefaults.standard.double(forKey: "branch-last-seen")])
    }

    /// iOS shares straight from the extension, so nothing waits here.
    @objc func takeShared(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        call.resolve(["items": []])
    }
    @objc func clearShared(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        call.resolve()
    }

    /// Only the paired Branch opens inside the app; every other address goes to Safari as before.
    override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let paired = BranchKeychain.load()?.origin, BranchRules.origin(of: navigationAction.request.url) == paired else { return nil }
        return false
    }
}
