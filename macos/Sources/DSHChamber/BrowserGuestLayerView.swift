//
//  BrowserGuestLayerView.swift — 右栏浏览器 v3 原生 guest 宿主层（design 28 v3 §4.1）
//
//  宿主层级（已勘察 ShellWindowMaterial.swift:35-49）：contentView 是容器，壳 webView 是
//  其中一个子视图 ⇒ 本层作为同级子视图挂在 webView 之上，不重排 contentView。
//  - isFlipped：与 CSS 同 y 向下；rect 直接是 webView 坐标（points，已按 pageZoom 归一）；
//  - hitTest：只有「活动 guest + 可见 + 点在 guest rect 内」才命中，其余穿透给壳页面
//    （否则空 overlay 会吃掉壳文档的滚动/拖拽/菜单事件）；
//  - per-guest 可见性（visible/occluded 轴）只影响该 lease；全局遮挡协议已退役
//    （renderer 不再推窗口级 occluded，活动态由 registry 的 setActive 维护）；
//  - 焦点门只认**活动且可见**的 guest（M-A）：活动 guest 被切走/隐藏/卸载时把
//    firstResponder 交回壳 webView（controller 注入 returnFocusToShell）。
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
    /// per-guest 可见性（V3-C F-06/F-07）：非活动 tab 报 visible=false **不得**隐藏活动 guest。
    private var guestVisible: [String: Bool] = [:]
    /// 活动 guest 被切换/隐藏/卸载时把 firstResponder 交回壳 webView（controller 注入）：
    /// 否则活动 guest 隐藏后键盘仍可能派发进隐藏 guest（M-A 焦点门）。
    var returnFocusToShell: (() -> Void)?

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }

    override init(frame: CGRect = .zero) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        autoresizingMask = [.width, .height]
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    /// 命中面：活动 guest 且可见且点在 rect 内 → 返回 guest；否则 nil（穿透给壳页面）。
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let lease = activeLease, let guest = guests[lease],
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

    /// 卸载一个 guest（release/崩溃销毁）。活动 guest 被卸载时焦点交回壳。
    func detach(lease: String) {
        guard let guest = guests.removeValue(forKey: lease) else { return }
        guestVisible.removeValue(forKey: lease)
        guest.removeFromSuperview()
        if activeLease == lease {
            activeLease = nil
            handBackFocusIfGuestHoldsIt()
        }
    }

    /// 更新几何（points 已换算并裁剪；0 面积 = 隐藏）。
    func setFrame(_ points: CGRect, for lease: String) {
        guard let guest = guests[lease] else { return }
        guest.frame = points
        guest.isHidden = points.isEmpty || shouldHide(lease)
    }

    /// tab 切换/清空活动 guest：只切可见性，不销毁（keepMounted）。
    /// 旧活动 guest 被切走或清空时，若 firstResponder 还在某个 guest 上，交回壳 webView
    /// （M-A：隐藏后的 guest 不得继续持有键盘）。
    func setActive(lease: String?) {
        let previous = activeLease
        activeLease = lease
        for (key, guest) in guests {
            guest.isHidden = (key != lease) || !(guestVisible[key] ?? true)
        }
        if let previous, previous != lease { handBackFocusIfGuestHoldsIt() }
    }

    /// per-guest 可见性（browser-frame/acquire 的顶层 visible/occluded）。
    /// 只影响该 lease；活动态仍是全局态（非活动 guest 恒隐藏）。
    /// M-A：把**活动** guest 置为不可见时同时清活动态并把焦点交回壳。
    func setGuestVisible(_ visible: Bool, for lease: String) {
        guestVisible[lease] = visible
        if !visible, lease == activeLease {
            activeLease = nil
            handBackFocusIfGuestHoldsIt()
        }
        guard let guest = guests[lease] else { return }
        guest.isHidden = !visible || lease != activeLease
    }

    /// 当前活动且可见 guest 的 WKWebView（焦点门通过后的 zoom 路由用）。
    func activeGuestWebView() -> WKWebView? {
        guard let lease = activeLease, let guest = guests[lease],
              !guest.isHidden, guestVisible[lease] ?? true else { return nil }
        return guest
    }

    /// 窗口 resize / 全屏 / 缩放变化：把现有 rect 重新裁剪（native 兜底，不依赖 renderer 再推）。
    func refreshClip(containerSize: CGSize) {
        for (_, guest) in guests {
            let clipped = guest.frame.intersection(CGRect(origin: .zero, size: containerSize))
            guest.frame = (clipped.isNull || clipped.isEmpty) ? .zero : clipped
        }
    }

    /// 焦点门（M-A）：responder 是否属于**活动且可见**的 guest（WKWebView 自身或其子视图——
    /// WebKit 常把内部 content view 设为 firstResponder，故用 isDescendant(of:) 兼容）。
    /// 活动 guest 隐藏/切走后键盘不得继续派发给它。
    func isActiveGuestResponder(_ responder: NSResponder?) -> Bool {
        guard let view = responder as? NSView,
              let lease = activeLease, let guest = guests[lease],
              !guest.isHidden, guestVisible[lease] ?? true else { return false }
        return view === guest || view.isDescendant(of: guest)
    }

    /// responder 是否属于任一 guest（卸载/清层前判断是否需要把焦点交回壳）。
    private func isAnyGuestResponder(_ responder: NSResponder?) -> Bool {
        guard let view = responder as? NSView else { return false }
        return guests.values.contains { view === $0 || view.isDescendant(of: $0) }
    }

    /// 当前 firstResponder 若还在某个 guest 上，交回壳 webView（调用方注入出口）。
    private func handBackFocusIfGuestHoldsIt() {
        guard isAnyGuestResponder(window?.firstResponder) else { return }
        returnFocusToShell?()
    }

    /// 全清（壳文档 reload/crash/退出）。先交回焦点再拆视图（拆完就判断不出 responder）。
    func removeAll() {
        if activeLease != nil { handBackFocusIfGuestHoldsIt() }
        for guest in guests.values { guest.removeFromSuperview() }
        guests.removeAll()
        guestVisible.removeAll()
        activeLease = nil
    }

    private func shouldHide(_ lease: String) -> Bool {
        lease != activeLease
    }
}
