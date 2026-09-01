import Foundation
import Capacitor
import UserNotifications
import UIKit

// @capacitor-firebase/messaging's requestPermissions() builds the
// UNAuthorizationOptions it asks iOS for directly from capacitor.config.ts's
// FirebaseMessaging.presentationOptions — the SAME config value also
// controls what to show for a push that arrives while the app is
// foregrounded (see the plugin's willPresent handling). Setting
// presentationOptions: [] there to suppress the foreground OS banner (so
// PushToast.tsx's in-app toast shows instead) ALSO makes requestPermissions()
// ask iOS for zero capabilities — meaning iOS never records a real
// authorization decision: checkPermissions() stays stuck reporting "prompt"
// forever, no Notifications row ever appears in iOS Settings for this app,
// and background/killed-state delivery never works since nothing was ever
// actually authorized (foreground delivery still "works" because handing a
// push to a running app's delegate doesn't require that authorization at
// all, which is why only in-app toasts were ever visible).
//
// This plugin requests full (alert + badge + sound) authorization directly,
// independent of that shared, conflated config value.
@objc(NotificationAuthPlugin)
public class NotificationAuthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NotificationAuthPlugin"
    public let jsName = "NotificationAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestFullAuthorization", returnType: CAPPluginReturnPromise)
    ]

    @objc func requestFullAuthorization(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            DispatchQueue.main.async {
                if granted {
                    UIApplication.shared.registerForRemoteNotifications()
                }
                if let error = error {
                    call.reject(error.localizedDescription)
                    return
                }
                call.resolve(["granted": granted])
            }
        }
    }
}
