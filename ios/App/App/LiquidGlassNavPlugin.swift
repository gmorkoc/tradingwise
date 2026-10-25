import Foundation
import Capacitor
import UIKit

// Real native Apple "Liquid Glass" floating nav — a genuine UITabBarController
// hosted as the app's actual root view controller (see AppDelegate.swift),
// not a hand-built UIVisualEffectView overlay. iOS 26 gives UITabBarController
// its floating glass pill shape and native selection morph animation
// automatically and for free ONLY when it's genuinely the root of the view
// controller hierarchy — an earlier attempt added it as a bare child
// controller glued onto unrelated content and it fell back to the classic
// flat/blue tab bar, confirming the floating treatment needs the real thing.
//
// This app's actual navigation is and remains entirely React's — there's
// one WKWebView, one real "tab" (Home, index 0) wrapping it, and four
// decorative placeholder tabs for Signals/Agent/Search/News that never
// really show their own content. tabBarController(_:shouldSelect:) vetoes
// every content switch unconditionally and instead forwards the tap to JS
// and sets tabBar.selectedItem directly — a real, independent native
// property change the system's own glass morph animation reacts to, fully
// decoupled from which view controller is actually "selected".
@objc(LiquidGlassNavPlugin)
public class LiquidGlassNavPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LiquidGlassNavPlugin"
    public let jsName = "LiquidGlassNav"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise)
    ]

    private weak var shell: NativeTabBarShell?

    @objc func isAvailable(_ call: CAPPluginCall) {
        if #available(iOS 26.0, *) {
            call.resolve(["available": true])
        } else {
            call.resolve(["available": false])
        }
    }

    // The shell already exists by now — AppDelegate builds it at launch,
    // wrapping the real CAPBridgeViewController as its content tab. This
    // just locates it and wires up the tap callback; there's no view to
    // create here. Located via NativeTabBarShell.current (a static ref set
    // in its own init), NOT mainVC.tabBarController — that property walks
    // real UIViewController containment (.parent), and mainVC is
    // deliberately never added as an actual child of the shell (only its
    // .view gets reparented between tabs), so .tabBarController always
    // returned nil and this lookup silently failed every time, meaning
    // onTap was never wired and every tap did nothing.
    @objc func show(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else { call.resolve(); return }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let shell = NativeTabBarShell.current else {
                call.resolve(); return
            }
            shell.onTap = { [weak self] label in
                self?.notifyListeners("tap", data: ["label": label])
            }
            self.shell = shell
            call.resolve()
        }
    }

    // No-op: the tab bar is the app's actual window chrome now, not a
    // decorative overlay this plugin owns the lifecycle of — there's
    // nothing to hide it FROM. Kept as a method so FloatingNavBar.tsx's
    // existing unmount-cleanup call doesn't need special-casing.
    @objc func hide(_ call: CAPPluginCall) {
        call.resolve()
    }

    @objc func update(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.shell?.apply(
                active: call.getString("active"),
                theme: call.getString("theme") ?? "dark",
                agentUnread: call.getBool("agentUnread") ?? false,
                agentLocked: call.getBool("agentLocked") ?? false
            )
            call.resolve()
        }
    }
}

// MARK: - Native tab bar shell

let nativeTabItems: [(label: String, symbol: String, selectedSymbol: String)] = [
    ("Home", "house", "house.fill"),
    ("Signals", "chart.line.uptrend.xyaxis", "chart.line.uptrend.xyaxis"),
    ("Agent", "sparkles", "sparkles"),
    ("Search", "magnifyingglass", "magnifyingglass"),
    ("News", "newspaper", "newspaper.fill")
]

// UIKit forbids mutating a tab bar controller's own tab bar directly
// (tabBar.selectedItem = ... throws "Directly modifying a tab bar managed
// by a tab bar controller is not allowed" and crashes) — selectedIndex on
// the controller is the only legal way to change selection, but that
// actually swaps which child view controller's view is shown. Rather than
// fight that, each tab IS a real, legal selection, and all 5 tabs show
// identical content by reparenting the ONE real webview's view into
// whichever tab is currently visible — cheap (just moving a UIView, nothing
// reloads) and invisible to the user, who was never going to see different
// content per tab anyway since React, not UIKit, owns real navigation here.
final class NativeContentHostViewController: UIViewController {
    static var sharedContentView: UIView?

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        guard let shared = Self.sharedContentView, shared.superview !== view else { return }
        shared.removeFromSuperview()
        shared.frame = view.bounds
        shared.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(shared)
    }
}

final class NativeTabBarShell: UITabBarController, UITabBarControllerDelegate {
    // The plugin locates this instance through here, not through UIKit's
    // own VC-containment lookups (mainVC.tabBarController) — see show()'s
    // own comment for why that doesn't work in this architecture.
    static weak var current: NativeTabBarShell?

    var onTap: ((String) -> Void)?
    private var suppressDelegateCallback = false

    // Keeps the real Capacitor bridge VC alive — it's deliberately never
    // added as a child of this tab bar controller (only its .view gets
    // reparented between the 5 host tabs above), so without a strong
    // reference here it would otherwise have no owner and get deallocated.
    private let mainViewController: UIViewController

    init(contentViewController: UIViewController) {
        mainViewController = contentViewController
        super.init(nibName: nil, bundle: nil)

        NativeContentHostViewController.sharedContentView = contentViewController.view
        let symbolConfig = UIImage.SymbolConfiguration(pointSize: 16, weight: .regular)
        let hosts = nativeTabItems.map { item -> NativeContentHostViewController in
            let vc = NativeContentHostViewController()
            vc.tabBarItem = UITabBarItem(
                title: item.label,
                image: UIImage(systemName: item.symbol)?.withConfiguration(symbolConfig),
                selectedImage: UIImage(systemName: item.selectedSymbol)?.withConfiguration(symbolConfig)
            )
            return vc
        }
        viewControllers = hosts
        delegate = self
        NativeTabBarShell.current = self
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        // .fill (the default) stretches items evenly across the bar's
        // full width; .centered + explicit itemWidth/itemSpacing is what
        // actually lets the items sit closer together with real gaps
        // between them, matching the reference's tighter, deliberately-
        // spaced layout instead of auto-stretching to fill a wide pill.
        // Set here, not init — had no visible effect set before the tab
        // bar's own view was actually loaded.
        tabBar.itemPositioning = .centered
        tabBar.itemWidth = 40
        tabBar.itemSpacing = 24
    }

    func tabBarController(_ tabBarController: UITabBarController, shouldSelect viewController: UIViewController) -> Bool {
        guard !suppressDelegateCallback, let label = viewController.tabBarItem.title else { return true }
        onTap?(label)
        return true
    }

    // Mirrors JS state into the real control — the actual page switch
    // already happened in React before this call ever arrives, this just
    // keeps the native pill pointed at the right item (e.g. after the
    // Home button's own "go home" logic, not a direct tab tap). Uses the
    // legal selectedIndex setter; suppressed so that assignment doesn't
    // loop back through the delegate as if the user had tapped it again.
    func apply(active: String?, theme: String, agentUnread: Bool, agentLocked: Bool) {
        if let index = nativeTabItems.firstIndex(where: { $0.label == active }), selectedIndex != index {
            suppressDelegateCallback = true
            selectedIndex = index
            suppressDelegateCallback = false
        }
        // Matches the hand-rolled bar's own color choices (and the app's
        // general light/dark palette) instead of the system default blue.
        tabBar.tintColor = theme == "light"
            ? UIColor(red: 0.118, green: 0.106, blue: 0.180, alpha: 1)
            : .white
        tabBar.unselectedItemTintColor = theme == "light"
            ? UIColor(red: 0.235, green: 0.235, blue: 0.263, alpha: 1)
            : UIColor(red: 0.847, green: 0.859, blue: 0.894, alpha: 1)
        if let agentItem = tabBar.items?.first(where: { $0.title == "Agent" }) {
            agentItem.badgeValue = agentUnread ? "" : nil
            agentItem.isEnabled = !agentLocked
        }
    }
}
