//
//  BrowserGuestLayerView.swift — 右栏浏览器 v3 原生 guest 宿主层（design 28 v3 §4.1）
//
//  宿主层级（已勘察 ShellWindowMaterial.swift:35-49）：contentView 是容器，壳 webView 是
//  其中一个子视图 ⇒ 本层作为同级子视图挂在 webView 之上，不重排 contentView。
//  - isFlipped：与 CSS 同 y 向下；rect 直接是 webView 坐标（points，已按 pageZoom 归一）；
//  - hitTest：只有「活动 guest + 可见 + 点在 guest rect 内」才命中，其余穿透给壳页面
//    （否则空 overlay 会吃掉壳文档的滚动/拖拽/菜单事件）；
//  - visible=false 或 occluded=true（遮挡协议）→ 整层不参与命中。
//

import AppKit
import WebKit

/// 原生 guest 宿主层。
@MainActor
final class BrowserGuestLayerView: NSView {
    /// lease → guest 视图（keepMounted：非活动 guest 保留但 isHidden）。
    private(set) var guests: [String: WKWebView] = [:]
    /// 活动 guest 的 lease（tab 切换由 registry 通过 setActive 更新）。
    private(set) var activeLease: String?
    /// 遮挡协议（design 28:102）：renderer 的 overlayDepth > 0 时整层隐藏。
    private(set) var isOccluded = false
    private(set) var isLayerVisible = true
    /// per-guest 可见性（V3-C F-06/F-07）：非活动 tab 报 visible=false **不得**隐藏活动 guest。
    private var guestVisible: [String: Bool] = [:]

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }

    init(frame: CGRect = .zero) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        autoresizingMask = [.width, .height]
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    /// 命中面：活动 guest 且可见且点在 rect 内 → 返回 guest；否则 nil（穿透给壳页面）。
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard isLayerVisible, !isOccluded, let lease = activeLease, let guest = guests[lease],
              guest.isHidden == false, guestVisible[lease] ?? true else { return nil }
        let local = superview.map { convert(point, from: $0) } ?? point
        guard guest.frame.contains(local) else { return nil }
        return guest
    }

    /// 挂入一个 guest（同 lease 幂等：替换旧视图）。
    func attach(lease: String, guest: WKWebView, points: CGRect) {
        if let existing = guests[lease], existing !== guest { existing.removeFromSuperview() }
        guests[lease] = guest
        guest.frame = points
        if guest.superview !== self { addSubview(guest) }
        guest.isHidden = shouldHide(lease)
    }

    /// 卸载一个 guest（release/崩溃销毁）。
    func detach(lease: String) {
        guard let guest = guests.removeValue(forKey: lease) else { return }
        guestVisible.removeValue(forKey: lease)
        guest.removeFromSuperview()
        if activeLease == lease { activeLease = nil }
    }

    /// 更新几何（points 已换算并裁剪；0 面积 = 隐藏）。
    func setFrame(_ points: CGRect, for lease: String) {
        guard let guest = guests[lease] else { return }
        guest.frame = points
        guest.isHidden = points.isEmpty || shouldHide(lease)
    }

    /// tab 切换：只切可见性，不销毁（keepMounted）。
    func setActive(lease: String?) {
        activeLease = lease
        for (key, guest) in guests {
            guest.isHidden = (key != lease) || !isLayerVisible || isOccluded || !(guestVisible[key] ?? true)
        }
    }

    /// per-guest 可见性（browser-frame 的顶层 visible/occluded）。
    /// 只影响该 lease；层可见性与遮挡仍是全局态（窗口隐藏时整层不命中）。
    func setGuestVisible(_ visible: Bool, for lease: String) {
        guestVisible[lease] = visible
        guard let guest = guests[lease] else { return }
        guest.isHidden = !visible || isOccluded || !isLayerVisible || lease != activeLease
    }

    /// 全局遮挡/层可见性（窗口隐藏、occ 协议的自有全局面）。
    func setVisible(_ visible: Bool, occluded: Bool) {
        isLayerVisible = visible
        isOccluded = occluded
        isHidden = !visible || occluded
        for (key, guest) in guests {
            guest.isHidden = isHidden || (key != activeLease) || !(guestVisible[key] ?? true)
        }
    }

    /// 当前活动 guest 的 WKWebView（键盘/zoom 路由用）。
    func activeGuestWebView() -> WKWebView? {
        guard let lease = activeLease, guestVisible[lease] ?? true else { return nil }
        return guests[lease]
    }

    /// 窗口 resize / 全屏 / 缩放变化：把现有 rect 重新裁剪（native 兜底，不依赖 renderer 再推）。
    func refreshClip(containerSize: CGSize) {
        for (_, guest) in guests {
            let clipped = guest.frame.intersection(CGRect(origin: .zero, size: containerSize))
            guest.frame = (clipped.isNull || clipped.isEmpty) ? .zero : clipped
        }
    }

    /// 焦点门：responder 是否属于某个 guest（WKWebView 自身或其子视图——WebKit 常把
    /// 内部 content view 设为 firstResponder，故用 isDescendant(of:) 兼容）。
    func isGuestResponder(_ responder: NSResponder?) -> Bool {
        guard let view = responder as? NSView else { return false }
        return guests.values.contains { view === $0 || view.isDescendant(of: $0) }
    }

    /// 全清（壳文档 reload/退出）。
    func removeAll() {
        for guest in guests.values { guest.removeFromSuperview() }
        guests.removeAll()
        guestVisible.removeAll()
        activeLease = nil
    }

    private func shouldHide(_ lease: String) -> Bool {
        isHidden || isOccluded || lease != activeLease
    }
}
