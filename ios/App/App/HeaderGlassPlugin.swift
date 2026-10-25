import Foundation
import Capacitor
import UIKit

// Real native Apple Liquid Glass (UIGlassEffect, iOS 26+) for the top
// header's 3 button groups (menu, chart/order-book toggle capsule,
// notifications bell) — same technique as LiquidGlassNavPlugin's bottom
// nav bar (a UIVisualEffectView per element, positioned above the
// WKWebView with native buttons inside, taps forwarded back to JS). Unlike
// the bottom nav this doesn't need a UITabBarController: .main-coin-header
// sits as a sibling ABOVE .main-content (the actual overflow-y:auto
// scrolling pane, see App.css), not inside it, so its on-screen position
// is already stable without needing any sticky/fixed CSS change — a plain
// fixed-position overlay is enough, exactly like the very first (pre-
// UITabBarController) attempt at the bottom bar.
//
// Falls back to the CSS backdrop-filter buttons entirely on iOS <26 or
// non-iOS (App.tsx calls isAvailable() first and never calls show() if
// this returns false).
@objc(HeaderGlassPlugin)
public class HeaderGlassPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HeaderGlassPlugin"
    public let jsName = "HeaderGlass"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise)
    ]

    private var bar: HeaderGlassBar?

    @objc func isAvailable(_ call: CAPPluginCall) {
        if #available(iOS 26.0, *) {
            call.resolve(["available": true])
        } else {
            call.resolve(["available": false])
        }
    }

    @objc func show(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else { call.resolve(); return }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let vc = self.bridge?.viewController else { call.resolve(); return }
            if self.bar == nil {
                let bar = HeaderGlassBar()
                bar.onTap = { [weak self] label in
                    self?.notifyListeners("tap", data: ["label": label])
                }
                vc.view.addSubview(bar.menu)
                vc.view.addSubview(bar.capsule)
                vc.view.addSubview(bar.bell)
                [bar.menu, bar.capsule, bar.bell].forEach { $0.translatesAutoresizingMaskIntoConstraints = false }
                NSLayoutConstraint.activate([
                    bar.menu.leadingAnchor.constraint(equalTo: vc.view.leadingAnchor, constant: 20),
                    bar.menu.centerYAnchor.constraint(equalTo: vc.view.safeAreaLayoutGuide.topAnchor, constant: 40),
                    bar.menu.widthAnchor.constraint(equalToConstant: 36),
                    bar.menu.heightAnchor.constraint(equalToConstant: 36),

                    bar.bell.trailingAnchor.constraint(equalTo: vc.view.trailingAnchor, constant: -20),
                    bar.bell.centerYAnchor.constraint(equalTo: vc.view.safeAreaLayoutGuide.topAnchor, constant: 40),
                    bar.bell.widthAnchor.constraint(equalToConstant: 40),
                    bar.bell.heightAnchor.constraint(equalToConstant: 40),

                    bar.capsule.trailingAnchor.constraint(equalTo: bar.bell.leadingAnchor, constant: -10),
                    bar.capsule.centerYAnchor.constraint(equalTo: vc.view.safeAreaLayoutGuide.topAnchor, constant: 40),
                    bar.capsule.widthAnchor.constraint(equalToConstant: 88),
                    bar.capsule.heightAnchor.constraint(equalToConstant: 40)
                ])
                self.bar = bar
            }
            self.bar?.setHidden(false)
            call.resolve()
        }
    }

    @objc func hide(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.bar?.setHidden(true)
            call.resolve()
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.bar?.apply(
                chartActive: call.getString("mode") != "orderbook",
                unreadCount: call.getInt("unreadCount") ?? 0
            )
            call.resolve()
        }
    }
}

// MARK: - Native header glass bar

private final class HeaderGlassBar {
    var onTap: ((String) -> Void)?

    let menu = GlassPillView(cornerRadius: 18)
    let capsule = GlassPillView(cornerRadius: 20)
    let bell = GlassPillView(cornerRadius: 20)

    private let chartButton = UIButton(type: .system)
    private let orderBookButton = UIButton(type: .system)
    private let bellButton = UIButton(type: .system)
    private let badge = UIView()

    init() {
        let menuBtn = UIButton(type: .system)
        menuBtn.setImage(UIImage(systemName: "line.3.horizontal")?.withConfiguration(UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold)), for: .normal)
        menuBtn.tintColor = .label
        menuBtn.accessibilityIdentifier = "Menu"
        menuBtn.addTarget(self, action: #selector(handleTap(_:)), for: .touchUpInside)
        pin(menuBtn, in: menu.contentView)

        chartButton.setImage(UIImage(systemName: "globe")?.withConfiguration(UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold)), for: .normal)
        chartButton.accessibilityIdentifier = "Chart"
        chartButton.addTarget(self, action: #selector(handleTap(_:)), for: .touchUpInside)
        orderBookButton.setImage(UIImage(systemName: "line.3.horizontal.decrease")?.withConfiguration(UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold)), for: .normal)
        orderBookButton.accessibilityIdentifier = "OrderBook"
        orderBookButton.addTarget(self, action: #selector(handleTap(_:)), for: .touchUpInside)
        let row = UIStackView(arrangedSubviews: [chartButton, orderBookButton])
        row.axis = .horizontal
        row.distribution = .fillEqually
        row.alignment = .center
        pin(row, in: capsule.contentView)

        bellButton.setImage(UIImage(systemName: "bell")?.withConfiguration(UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)), for: .normal)
        bellButton.tintColor = .label
        bellButton.accessibilityIdentifier = "Notifications"
        bellButton.addTarget(self, action: #selector(handleTap(_:)), for: .touchUpInside)
        pin(bellButton, in: bell.contentView)

        badge.backgroundColor = UIColor(red: 0.94, green: 0.27, blue: 0.27, alpha: 1)
        badge.layer.cornerRadius = 8
        badge.isHidden = true
        badge.isUserInteractionEnabled = false
        badge.translatesAutoresizingMaskIntoConstraints = false
        bell.addSubview(badge)
        NSLayoutConstraint.activate([
            badge.topAnchor.constraint(equalTo: bell.topAnchor, constant: -4),
            badge.trailingAnchor.constraint(equalTo: bell.trailingAnchor, constant: 4),
            badge.widthAnchor.constraint(greaterThanOrEqualToConstant: 16),
            badge.heightAnchor.constraint(equalToConstant: 16)
        ])
        apply(chartActive: true, unreadCount: 0)
    }

    private func pin(_ view: UIView, in container: UIView) {
        view.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(view)
        NSLayoutConstraint.activate([
            view.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            view.centerYAnchor.constraint(equalTo: container.centerYAnchor)
        ])
    }

    @objc private func handleTap(_ sender: UIButton) {
        guard let label = sender.accessibilityIdentifier else { return }
        onTap?(label)
    }

    func setHidden(_ hidden: Bool) {
        menu.isHidden = hidden
        capsule.isHidden = hidden
        bell.isHidden = hidden
    }

    func apply(chartActive: Bool, unreadCount: Int) {
        chartButton.tintColor = chartActive ? .label : .secondaryLabel
        orderBookButton.tintColor = chartActive ? .secondaryLabel : .label
        if unreadCount > 0 {
            badge.isHidden = false
        } else {
            badge.isHidden = true
        }
    }
}

// A small reusable UIGlassEffect pill — identical material construction
// to GlassNavBarView in LiquidGlassNavPlugin.swift, just without that
// file's selection-indicator/button-row machinery, since these are 3
// independent action buttons, not a tab set.
private final class GlassPillView: UIView {
    let contentView: UIView

    init(cornerRadius: CGFloat) {
        if #available(iOS 26.0, *) {
            let effect = UIVisualEffectView(effect: UIGlassEffect())
            contentView = effect.contentView
            super.init(frame: .zero)
            effect.frame = bounds
            effect.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            effect.layer.cornerRadius = cornerRadius
            effect.layer.cornerCurve = .continuous
            effect.clipsToBounds = true
            addSubview(effect)
        } else {
            contentView = UIView()
            super.init(frame: .zero)
        }
        layer.cornerRadius = cornerRadius
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.12
        layer.shadowRadius = 6
        layer.shadowOffset = CGSize(width: 0, height: 2)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }
}
