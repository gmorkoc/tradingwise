import Foundation
import Capacitor
import UIKit

// Real native Apple "Liquid Glass" (UIGlassEffect, iOS 26+) floating nav bar,
// replacing the CSS backdrop-filter approximation (FloatingNavBar.css/.tsx)
// on devices that actually support it. CSS can fake blur/translucency but
// not the real system glass material (dynamic specular highlights, true
// backdrop refraction) — this plugin renders the genuine UIKit material as
// a native view ABOVE the WKWebView, with native buttons inside it (the
// webview's own HTML can't show through a native view sitting above it, so
// the tappable content has to be native too) and forwards taps back to JS
// so the existing React handlers (onGoHome, onSearch, etc. in App.tsx) stay
// the single source of truth for what each tap actually does.
//
// Falls back to the CSS bar entirely on iOS < 26 (FloatingNavBar.tsx calls
// isAvailable() first and never calls show() if this returns false).
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

    private var barView: GlassNavBarView?

    @objc func isAvailable(_ call: CAPPluginCall) {
        if #available(iOS 26.0, *) {
            NSLog("[LiquidGlassNav] isAvailable -> true")
            call.resolve(["available": true])
        } else {
            NSLog("[LiquidGlassNav] isAvailable -> false (iOS < 26)")
            call.resolve(["available": false])
        }
    }

    @objc func show(_ call: CAPPluginCall) {
        NSLog("[LiquidGlassNav] show() called")
        guard #available(iOS 26.0, *) else { NSLog("[LiquidGlassNav] show() bailed, iOS < 26"); call.resolve(); return }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let vc = self.bridge?.viewController else { NSLog("[LiquidGlassNav] show() no viewController"); call.resolve(); return }
            NSLog("[LiquidGlassNav] show() building bar, vc.view.frame=\(vc.view.frame)")
            if self.barView == nil {
                let bar = GlassNavBarView()
                bar.onTap = { [weak self] label in
                    self?.notifyListeners("tap", data: ["label": label])
                }
                vc.view.addSubview(bar)
                bar.translatesAutoresizingMaskIntoConstraints = false
                NSLayoutConstraint.activate([
                    bar.leadingAnchor.constraint(equalTo: vc.view.leadingAnchor, constant: 16),
                    bar.trailingAnchor.constraint(equalTo: vc.view.trailingAnchor, constant: -16),
                    bar.bottomAnchor.constraint(equalTo: vc.view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
                    bar.heightAnchor.constraint(equalToConstant: 64)
                ])
                self.barView = bar
            }
            self.barView?.isHidden = false
            call.resolve()
        }
    }

    @objc func hide(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.barView?.isHidden = true
            call.resolve()
        }
    }

    // Single state-sync call instead of many setters — mirrors how
    // FloatingNavBar.tsx already derives one render from its props each
    // time, just pushed across the bridge instead of through React.
    @objc func update(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let bar = self?.barView else { NSLog("[LiquidGlassNav] update() called but barView is nil"); call.resolve(); return }
            NSLog("[LiquidGlassNav] update() applying, active=\(call.getString("active") ?? "nil") theme=\(call.getString("theme") ?? "nil")")
            bar.apply(
                active: call.getString("active"),
                theme: call.getString("theme") ?? "dark",
                raised: call.getBool("raised") ?? false,
                agentUnread: call.getBool("agentUnread") ?? false,
                agentLocked: call.getBool("agentLocked") ?? false,
                showcase: call.getBool("showcase") ?? false
            )
            call.resolve()
        }
    }
}

// MARK: - Native glass bar view

// Uniform 5 items, all the same flat icon+label treatment (matching the
// reference exactly — no raised/colored exception for Agent anymore; the
// CSS fallback bar keeps its own distinct orb branding, this native bar
// doesn't).
// Base (unselected) symbol — outline style, matching the reference's own
// outline icons. A few have a distinct filled variant swapped in only
// when active (see activeSymbols below); chart.line/sparkles/
// magnifyingglass don't have a meaningfully different filled counterpart,
// same as the reference's own Trade/Predict icons staying outline even
// when you'd expect a filled state.
private let navItems: [(label: String, symbol: String)] = [
    ("Home", "house"),
    ("Signals", "chart.line.uptrend.xyaxis"),
    ("Agent", "sparkles"),
    ("Search", "magnifyingglass"),
    ("News", "newspaper")
]
private let activeSymbols: [String: String] = [
    "Home": "house.fill",
    "News": "newspaper.fill"
]

private final class GlassNavBarView: UIView {
    var onTap: ((String) -> Void)?

    private var effectView: UIVisualEffectView?
    private var tintOverlay = UIView()
    private var indicator = UIView()
    private var buttons: [String: UIButton] = [:]
    private var buttonImageViews: [String: UIImageView] = [:]
    private var buttonLabels: [String: UILabel] = [:]
    private var agentBadge = UIView()
    private var currentActive: String?
    private var currentTheme = "dark"

    override init(frame: CGRect) {
        super.init(frame: frame)
        build()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    private func build() {
        if #available(iOS 26.0, *) {
            let effect = UIVisualEffectView(effect: UIGlassEffect())
            effect.frame = bounds
            effect.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            effect.layer.cornerRadius = 32
            effect.layer.cornerCurve = .continuous
            effect.clipsToBounds = true
            addSubview(effect)
            effectView = effect
        }
        layer.cornerRadius = 32
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.35
        layer.shadowRadius = 14
        layer.shadowOffset = CGSize(width: 0, height: 8)

        let content = effectView?.contentView ?? self

        // A plain, guaranteed-to-render tinted layer, independent of
        // whether UIGlassEffect's own tintColor property visibly takes
        // effect at runtime (uncertain — swapping effect instances with it
        // set produced no visible change in testing). Sits above the real
        // glass blur, below the buttons, so the blur/refraction is still
        // the real material; this just keeps the bar legible as its own
        // surface against a near-white page.
        tintOverlay.isUserInteractionEnabled = false
        tintOverlay.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(tintOverlay)
        NSLayoutConstraint.activate([
            tintOverlay.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            tintOverlay.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            tintOverlay.topAnchor.constraint(equalTo: content.topAnchor),
            tintOverlay.bottomAnchor.constraint(equalTo: content.bottomAnchor)
        ])

        indicator.layer.cornerRadius = 26
        indicator.isUserInteractionEnabled = false
        content.addSubview(indicator)

        let row = UIStackView()
        row.axis = .horizontal
        row.distribution = .fillEqually
        row.alignment = .fill
        row.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 6),
            row.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -6),
            row.topAnchor.constraint(equalTo: content.topAnchor, constant: 6),
            row.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -6)
        ])

        for item in navItems { row.addArrangedSubview(makeButton(item)) }
    }

    // Deployment target is iOS 13 (this whole view is only ever
    // instantiated on iOS 26, but the compiler still type-checks its body
    // against that target) — built from plain UIImageView/UILabel inside a
    // UIStackView plus addTarget(_:action:for:), not UIButton.Configuration
    // or addAction(_:for:) (iOS 15/14-only), so nothing here needs its own
    // @available guard beyond the UIGlassEffect check in build() above.
    private func makeButton(_ item: (label: String, symbol: String)) -> UIButton {
        let button = UIButton(type: .custom)
        button.accessibilityIdentifier = item.label
        button.addTarget(self, action: #selector(handleTap(_:)), for: .touchUpInside)

        let imageView = UIImageView(image: UIImage(systemName: item.symbol))
        imageView.contentMode = .scaleAspectFit
        imageView.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)
        imageView.isUserInteractionEnabled = false

        let label = UILabel()
        label.text = item.label
        label.font = .systemFont(ofSize: 9.5, weight: .semibold)
        label.textAlignment = .center
        label.isUserInteractionEnabled = false

        let stack = UIStackView(arrangedSubviews: [imageView, label])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 3
        stack.isUserInteractionEnabled = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        button.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: button.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: button.centerYAnchor),
            imageView.widthAnchor.constraint(equalToConstant: 22),
            imageView.heightAnchor.constraint(equalToConstant: 22)
        ])

        // Agent is the only item with an unread badge — a small dot
        // anchored to its icon, same idea as FloatingNavBar.css's
        // .fnb-agent-dot, just attached generically here rather than via a
        // separate bespoke button.
        if item.label == "Agent" {
            agentBadge.backgroundColor = UIColor(red: 0.98, green: 0.44, blue: 0.52, alpha: 1)
            agentBadge.layer.cornerRadius = 5
            agentBadge.isHidden = true
            agentBadge.isUserInteractionEnabled = false
            agentBadge.translatesAutoresizingMaskIntoConstraints = false
            button.addSubview(agentBadge)
            NSLayoutConstraint.activate([
                agentBadge.topAnchor.constraint(equalTo: imageView.topAnchor, constant: -4),
                agentBadge.trailingAnchor.constraint(equalTo: imageView.trailingAnchor, constant: 4),
                agentBadge.widthAnchor.constraint(equalToConstant: 10),
                agentBadge.heightAnchor.constraint(equalToConstant: 10)
            ])
        }

        buttons[item.label] = button
        buttonImageViews[item.label] = imageView
        buttonLabels[item.label] = label
        return button
    }

    @objc private func handleTap(_ sender: UIButton) {
        guard let label = sender.accessibilityIdentifier else { return }
        onTap?(label)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        positionIndicator(animated: false)
    }

    func apply(active: String?, theme: String, raised: Bool, agentUnread: Bool, agentLocked: Bool, showcase: Bool) {
        currentActive = active
        currentTheme = theme
        // `raised` doesn't hide this bar — that was carried over from the
        // CSS fallback bar, where it was needed to win a z-index fight
        // against a panel's own full-screen dimming backdrop (both live
        // in the same webview stacking context there). This native bar is
        // always rendered above the entire WKWebView regardless, so it
        // can never lose that fight in the first place; hiding it here
        // just made the bar vanish instead of staying visible like the
        // original design intended (panels are meant to float above it,
        // not replace it).

        // Much lighter than before — the earlier 0.14-0.16 alpha was added
        // while mistakenly debugging a registration bug that made the
        // whole native path a no-op, so it was never actually validated
        // against the real material. Full-strength tint washes out the
        // genuine blur/refraction that makes this read as glass at all.
        tintOverlay.backgroundColor = theme == "light"
            ? UIColor(white: 0, alpha: 0.04)
            : UIColor(white: 1, alpha: 0.05)

        let inactiveColor: UIColor = theme == "light"
            ? UIColor(red: 0.235, green: 0.235, blue: 0.263, alpha: 1)
            : UIColor(red: 0.847, green: 0.859, blue: 0.894, alpha: 1)
        let activeColor: UIColor = theme == "light"
            ? UIColor(red: 0.118, green: 0.106, blue: 0.180, alpha: 1)
            : .white
        let indicatorColor: UIColor = theme == "light"
            ? UIColor(red: 0.059, green: 0.090, blue: 0.165, alpha: 0.06)
            : UIColor(white: 1, alpha: 0.22)

        for (label, imageView) in buttonImageViews {
            let isActive = label == active
            imageView.tintColor = isActive ? activeColor : inactiveColor
            buttonLabels[label]?.textColor = isActive ? activeColor : inactiveColor
            let symbol = (isActive ? activeSymbols[label] : nil) ?? navItems.first { $0.label == label }?.symbol
            if let symbol = symbol { imageView.image = UIImage(systemName: symbol) }
        }
        buttons["Agent"]?.alpha = agentLocked ? 0.55 : 1
        agentBadge.isHidden = !agentUnread
        indicator.backgroundColor = indicatorColor
        positionIndicator(animated: true)

        // Showcase: a brief shake the first time a user sees Agent Ready,
        // same spirit as FloatingNavBar.css's .fnb-agent-item--showcase —
        // simplified to a shake rather than byte-identical keyframes.
        let agentLayer = buttons["Agent"]?.layer
        agentLayer?.removeAnimation(forKey: "showcaseShake")
        if showcase {
            let shake = CAKeyframeAnimation(keyPath: "transform.translation.y")
            shake.values = [0, -3, 0, -3, 0]
            shake.duration = 1.2
            shake.repeatCount = 2
            agentLayer?.add(shake, forKey: "showcaseShake")
        }
    }

    private func positionIndicator(animated: Bool) {
        guard let label = currentActive, let button = buttons[label] else {
            UIView.animate(withDuration: animated ? 0.2 : 0) { self.indicator.alpha = 0 }
            return
        }
        let target = button.convert(button.bounds, to: indicator.superview).insetBy(dx: -4, dy: 0)
        guard animated else {
            indicator.frame = target
            indicator.alpha = 1
            return
        }
        indicator.alpha = 1
        indicator.frame.size.height = target.height
        // Liquid "wave/splash" stretch — position and width animate on
        // separate timings (position settles fast, width lags and
        // overshoots via the spring) instead of one uniform move, so mid-
        // transition the pill's leading edge has already arrived at the
        // new item while the trailing edge is still stretching/catching
        // up, same idea as the CSS bar's own transform/width duration
        // mismatch. Two independent animation blocks on the frame's
        // origin/size fields (not one combined block) so each can run its
        // own curve without fighting the other.
        UIView.animate(withDuration: 0.22, delay: 0, options: [.curveEaseOut], animations: {
            self.indicator.frame.origin.x = target.origin.x
        })
        UIView.animate(withDuration: 0.45, delay: 0, usingSpringWithDamping: 0.55, initialSpringVelocity: 0.6, options: [], animations: {
            self.indicator.frame.size.width = target.width
        })
    }
}
