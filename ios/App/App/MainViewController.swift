import UIKit
import Capacitor

/// env(safe-area-inset-*) reports 0 to WebKit/CSS inside this app's
/// WKWebView even though UIKit's own view.safeAreaInsets is correct (e.g.
/// 59pt for the Dynamic Island) — confirmed by direct measurement. So we
/// read UIKit's authoritative safe area here and push it into the page as
/// CSS custom properties instead of relying on WebKit's own reporting.
///
/// The injection has to survive the app's real page finishing its load
/// (an early injection lands on an intermediate document and gets wiped out
/// by the subsequent navigation). Capacitor owns webView.navigationDelegate,
/// so we can't hook didFinish navigation directly — instead we KVO-observe
/// WKWebView.isLoading, which fires independent of delegate ownership.
class MainViewController: CAPBridgeViewController {
    private var isLoadingObservation: NSKeyValueObservation?

    override func viewDidLoad() {
        super.viewDidLoad()
        isLoadingObservation = webView?.observe(\.isLoading, options: [.new]) { [weak self] _, change in
            if change.newValue == false {
                DispatchQueue.main.async { self?.applySafeAreaInsets() }
            }
        }

        // UIKit's automatic contentInset adjustment fights with the manual
        // safe-area injection above — after a keyboard show/hide cycle it
        // can leave the webview's own scroll view offset stuck non-zero,
        // exposing black space above the content until the app restarts.
        webView?.scrollView.contentInsetAdjustmentBehavior = .never
        NotificationCenter.default.addObserver(
            self, selector: #selector(resetWebViewScrollOffset),
            name: UIResponder.keyboardDidHideNotification, object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func resetWebViewScrollOffset() {
        webView?.scrollView.setContentOffset(.zero, animated: false)
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        applySafeAreaInsets()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        applySafeAreaInsets()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        applySafeAreaInsets()
    }

    private func applySafeAreaInsets() {
        let insets = view.safeAreaInsets
        let js = """
        document.documentElement.style.setProperty('--native-safe-area-top', '\(insets.top)px');
        document.documentElement.style.setProperty('--native-safe-area-bottom', '\(insets.bottom)px');
        document.documentElement.style.setProperty('--native-safe-area-left', '\(insets.left)px');
        document.documentElement.style.setProperty('--native-safe-area-right', '\(insets.right)px');
        """
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }
}
