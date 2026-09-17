import BackgroundTasks
import UIKit
import UserNotifications

/// Telling the owner when a task needs them. "When needed" checks only while the app is open (the
/// page does that); "on" also asks iOS for a background check now and then. Push, which reaches a
/// closed app at once, needs a paid Apple account and a push service; its path is here behind the
/// "push" switch and is documented in docs/configuration.md, "Phone apps".
enum BranchBackground {
    static let taskId = "com.keepoak.branchagent.check"

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskId, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else { task.setTaskCompleted(success: false); return }
            schedule()
            let work = Task { await check(); refresh.setTaskCompleted(success: true) }
            refresh.expirationHandler = { work.cancel() }
        }
    }

    static func schedule() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskId)
        guard BranchSwitches.position("notifications") == "on" else { return }
        let request = BGAppRefreshTaskRequest(identifier: taskId)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    /// Asks the paired Branch what is waiting, and says so once for each new question.
    static func check() async {
        guard BranchSwitches.position("notifications") != "off", let session = BranchKeychain.load(),
              let answer = try? await BranchClient.send(session, method: "GET", path: "/api/state"),
              let state = answer.json as? [String: Any], let waiting = state["attention"] as? [[String: Any]] else { return }
        var told = Set(UserDefaults.standard.stringArray(forKey: "branch-told") ?? [])
        for item in waiting {
            guard let id = item["runId"] as? String, !told.contains(id) else { continue }
            told.insert(id)
            show(id: id, title: BranchNative.word("phone.notify.title", "Branch needs you"),
                 body: String((item["question"] as? String ?? "").prefix(180)))
        }
        UserDefaults.standard.set(Array(told.suffix(200)), forKey: "branch-told")
    }

    static func show(id: String, title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = "branch-needs-you"
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    /// Push: asks iOS for a device token only while the switch is not off. The token is kept on the
    /// phone until a push service exists to hand it to; nothing is sent anywhere yet.
    static func updatePush() {
        if BranchSwitches.position("push") == "off" {
            UIApplication.shared.unregisterForRemoteNotifications()
            UserDefaults.standard.removeObject(forKey: "branch-push-token")
        } else {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    static func remember(pushToken: Data) {
        UserDefaults.standard.set(pushToken.map { String(format: "%02x", $0) }.joined(), forKey: "branch-push-token")
    }
}
