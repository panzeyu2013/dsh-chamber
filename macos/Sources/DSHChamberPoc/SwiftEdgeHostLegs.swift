//
//  SwiftEdgeHostLegs.swift
//  DSHChamberPoc
//
//  W-19/20 切片（design 25 §4.4.2/§5 E4/E5/E8/E10/E12）：sidecar 出站
//  edge（node-edges.ts 经 B 桥发出）的 Swift 宿主腿骨架。与 BridgeClient
//  v1 默认应答表（defaultEdgeResponse）的关系：宿主接线（AppDelegate/
//  MainWindowController）把本 legs 实例赋给 BridgeClient.edgeHostLegs 后，
//  默认表让位于 legs（legs 报 unimplemented/ui-unavailable 时回落默认表，
//  语义：POC 无宿主仍不挂起）。
//
//  降级语义（headless/无窗/config.canShowUI()==false → 一律诚实错误
//  "swift-edge-ui-unavailable:<method>"，绝不静默假装成功）：
//  - focusMainWindow / pickPluginSource / showMessage（异步 NSAlert 消费）/
//    showNativeNotification（UNUserNotificationCenter + click 回灌
//    __host.notifyClicked）/ openExternal / openPath / showItemInFolder /
//    setBadge（dockTile）/ setKeepAwake / setLoginItem / showError /
//    launchApp / retireNotifications。
//  GUI 分支实机验收属硬门禁（M3 集成点见各腿注释 TODO）。
//

import Foundation
import AppKit
import UserNotifications
import UniformTypeIdentifiers

/// AnyCodable 载荷提取助手（AnyCodable.jsonObject 的字典/标量投影）。
enum EdgePayload {
    /// 顶层字典投影（非 object → nil）。
    static func dictionary(_ payload: AnyCodable?) -> [String: AnyCodable]? {
        guard case .object(let entries)? = payload else { return nil }
        return entries
    }

    static func string(_ value: AnyCodable?) -> String? {
        guard case .string(let s)? = value else { return nil }
        return s
    }

    static func int(_ value: AnyCodable?) -> Int? {
        guard case .number(let n)? = value else { return nil }
        return Int(n)
    }

    static func bool(_ value: AnyCodable?) -> Bool? {
        guard case .bool(let b)? = value else { return nil }
        return b
    }
}

/// showMessage 的异步消费队列（纯逻辑，可无头单测）：宿主在 canShowUI
/// 上下文把 NSAlert 跑在主线程，完成后调用 completePendingAlert；重复
/// complete 幂等；无 pending 时 complete 是 no-op。
public final class PendingAlertQueue {
    private var pending: [Int: Int] = [:]  // token → buttonIndex
    private var nextToken = 1
    private let lock = NSLock()

    /// 登记一次期待（返回 token，供宿主回填按钮序）。
    public func expect() -> Int {
        lock.lock()
        defer { lock.unlock() }
        let token = nextToken
        nextToken += 1
        pending[token] = -1
        return token
    }

    /// 宿主完成 alert 后回填按钮序；幂等（重复调用 no-op）。
    public func complete(token: Int, buttonIndex: Int) {
        lock.lock()
        defer { lock.unlock() }
        if pending[token] != nil {
            pending[token] = buttonIndex
        }
    }

    /// 取出已完成的按钮序（未完成 → nil；已取出 → 移出）。
    public func takeResult(token: Int) -> Int? {
        lock.lock()
        defer { lock.unlock() }
        guard let value = pending[token], value >= 0 else { return nil }
        pending.removeValue(forKey: token)
        return value
    }
}

/// Swift 宿主 edge 腿（design 25 §4.4.2/§5；W-19/20）。
public final class SwiftEdgeHostLegs {
    /// UI/系统能力门（headless/测试 → false：全部 UI 腿诚实降级）。
    public struct Config {
        public var canShowUI: () -> Bool
        public init(canShowUI: @escaping () -> Bool = { false }) {
            self.canShowUI = canShowUI
        }
    }

    private let config: Config
    /// 主窗提供者（POC 接线点：MainWindowController 注册后置非 nil）。
    public var mainWindowProvider: (() -> NSWindow?)?

    /// keep-awake activity token（ProcessInfo 防休眠；nil = 未激活）。
    private var keepAwakeActivity: NSObjectProtocol?

    private func updateKeepAwake(enabled: Bool) {
        if enabled, keepAwakeActivity == nil {
            keepAwakeActivity = ProcessInfo.processInfo.beginActivity(
                options: [.idleDisplaySleepDisabled, .idleSystemSleepDisabled],
                reason: "dsh-chamber keep-awake (edge setKeepAwake)"
            )
        } else if !enabled, let token = keepAwakeActivity {
            ProcessInfo.processInfo.endActivity(token)
            keepAwakeActivity = nil
        }
    }

    deinit {
        if let token = keepAwakeActivity {
            ProcessInfo.processInfo.endActivity(token)
        }
    }

    /// showMessage 异步消费队列（M3 主窗 delegate 接线后使用）。
    public let pendingAlerts = PendingAlertQueue()

    public init(config: Config = Config()) {
        self.config = config
    }

    /// 未实现（M3 集成点留待）与 UI 不可用文案前缀（BridgeClient 回落依据）。
    public static let unimplementedPrefix = "swift-edge-unimplemented:"
    public static let uiUnavailablePrefix = "swift-edge-ui-unavailable:"

    /// 异步宿主腿入口（W-21 前置）：非 nil 时 BridgeClient 默认应答器改经
    /// 它应答（reply 可延迟调用，恰一次契约由 sendEdgeReply 守卫）；本入口
    /// 内部先走同步 respond——命中实现腿（非 unimplemented/ui-unavailable）
    /// 立即 reply；未实现/UI 不可用则回落 v1 默认表（由 BridgeClient 判定
    /// 前缀后自行处理）。AppKit 宿主接线（MainWindowController/AppDelegate）
    /// 可在子类/扩展中把通知/对话框腿接到本异步入口。
    public func respondAsync(
        method: String,
        payload: AnyCodable?,
        completion: @escaping (AnyCodable?, String?) -> Void
    ) {
        if method == "showNativeNotification" {
            scheduleNotification(payload: payload, completion: completion)
            return
        }
        let outcome = respond(method: method, payload: payload)
        completion(outcome.result, outcome.error)
    }

    /// 异步腿面（当前：showNativeNotification——canShowUI 为真时由本类真实
    /// 调度，无需宿主接线）；其余方法走同步 respond。
    public func canHandleAsync(method: String) -> Bool {
        switch method {
        case "showNativeNotification":
            return config.canShowUI()
        default:
            return false
        }
    }

    /// 真实通知调度（W-21 切片；design 25 §5 E4）：node-edges 载荷形状
    /// {notificationId: Int, spec: {title?, body?, …}}。canShowUI 为假 →
    /// ui-unavailable 诚实降级；调度失败（未授权/系统拒绝）→ loud error。
    /// click 回灌（__host.notifyClicked {notificationId}）与前台展示 delegate
    /// 属 M3 集成（需 UNUserNotificationCenterDelegate 宿主接线 + 实机门禁）。
    private func scheduleNotification(
        payload: AnyCodable?,
        completion: @escaping (AnyCodable?, String?) -> Void
    ) {
        guard config.canShowUI() else {
            completion(nil, Self.uiUnavailablePrefix + "showNativeNotification")
            return
        }
        guard let dict = EdgePayload.dictionary(payload) else {
            completion(nil, Self.unimplementedPrefix + "showNativeNotification:payload")
            return
        }
        let content = UNMutableNotificationContent()
        if let spec = EdgePayload.dictionary(dict["spec"]) {
            content.title = EdgePayload.string(spec["title"]) ?? ""
            content.body = EdgePayload.string(spec["body"]) ?? EdgePayload.string(spec["message"]) ?? ""
        }
        let request = UNNotificationRequest(
            identifier: "chamber-edge-" + String(EdgePayload.int(dict["notificationId"]) ?? -1),
            content: content,
            trigger: nil  // 立即投递（前台展示语义需 delegate，M3 集成）
        )
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                completion(nil, "swift-edge-notification-schedule-failed:\(error.localizedDescription)")
            } else {
                completion(nil, nil)
            }
        }
    }

    /// 统一分派：未知/未实现 → unimplemented；UI 腿在 canShowUI()==false →
    /// ui-unavailable；其余按腿执行。
    public func respond(method: String, payload: AnyCodable?)
        -> (result: AnyCodable?, error: String?) {
        let dict = EdgePayload.dictionary(payload)
        switch method {
        case "focusMainWindow":
            return performUI(method: method) {
                guard let window = mainWindowProvider?() else {
                    return (nil, Self.uiUnavailablePrefix + method + ":no-window")
                }
                window.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
                return (nil, nil)
            }
        case "showNativeNotification":
            // 同步路径仅覆盖 UI 不可用（真实调度走 respondAsync/canHandleAsync）；
            // 谎报 shown 绝不允许。
            guard config.canShowUI() else {
                return (nil, Self.uiUnavailablePrefix + method)
            }
            return (nil, Self.unimplementedPrefix + method + ":use-async-leg")
        case "setBadge":
            // E5 dock 角标叶：payload {count: number}；UI 上下文守卫（headless
            // 绝不触碰 NSApp 状态）。badgePlatformGate 裁决在 core（sidecar），
            // 本腿只执行 dockTile 写。
            return performUI(method: method) {
                guard mainWindowProvider?() != nil else {
                    return (nil, Self.uiUnavailablePrefix + method + ":no-window")
                }
                let count = dict.flatMap { EdgePayload.int($0["count"]) } ?? 0
                NSApp.dockTile.badgeLabel = count > 0 ? "\(count)" : nil
                return (nil, nil)
            }
        case "setKeepAwake":
            // E5 keep-awake 叶：payload {on: bool}；ProcessInfo activity 防休眠
            // （blocker id 语义注释同 electron-edges）。窗口上下文守卫防
            // headless 测试副作用（真实用途恒有主窗）。
            return performUI(method: method) {
                guard mainWindowProvider?() != nil else {
                    return (nil, Self.uiUnavailablePrefix + method + ":no-window")
                }
                let on = dict.flatMap { EdgePayload.bool($0["on"]) } ?? false
                updateKeepAwake(enabled: on)
                return (nil, nil)
            }
        case "showItemInFolder":
            // Finder 揭示叶：payload {path: string}；窗口上下文守卫。
            return performUI(method: method) {
                guard mainWindowProvider?() != nil else {
                    return (nil, Self.uiUnavailablePrefix + method + ":no-window")
                }
                guard let raw = dict.flatMap({ EdgePayload.string($0["path"]) }) else {
                    return (nil, Self.unimplementedPrefix + method + ":path-missing")
                }
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: raw)])
                return (nil, nil)
            }
        case "pickPluginSource":
            // E8/A10 一体化 picker（folder|.tgz；design 21 §10 ⑧，electron-edges
            // 语义：darwin openFile+openDirectory 一体）。模态主线程执行；
            // 无窗/headless → 诚实降级。应答形状 {status:'cancelled'} 或
            // {status:'picked', path}（node-edges pickPluginSource 折算）。
            return performUI(method: method) {
                guard mainWindowProvider?() != nil else {
                    return (nil, Self.uiUnavailablePrefix + method + ":no-window")
                }
                var pickedPath: String?
                var cancelled = false
                let run: () -> Void = {
                    let panel = NSOpenPanel()
                    panel.title = "选择 chamber 插件源"
                    panel.canChooseFiles = true
                    panel.canChooseDirectories = true
                    panel.allowsMultipleSelection = false
                    panel.allowedContentTypes = [UTType.folder, UTType(filenameExtension: "tgz") ?? UTType.data]
                    if panel.runModal() == .OK, let url = panel.urls.first {
                        pickedPath = url.path
                    } else {
                        cancelled = true
                    }
                }
                if Thread.isMainThread {
                    run()
                } else {
                    DispatchQueue.main.sync(execute: run)
                }
                if cancelled {
                    return (.object(["status": .string("cancelled")]), nil)
                }
                if let path = pickedPath {
                    return (.object(["status": .string("picked"), "path": .string(path)]), nil)
                }
                return (nil, Self.uiUnavailablePrefix + method + ":no-selection")
            }
        case "showError":
            // dialog.showErrorBox 对应腿：payload {title, detail}；主线程模态
            // alert（无窗守卫——深链消费等错误路径须有 UI 上下文才弹）。
            return performUI(method: method) {
                guard mainWindowProvider?() != nil else {
                    return (nil, Self.uiUnavailablePrefix + method + ":no-window")
                }
                let title = dict.flatMap { EdgePayload.string($0["title"]) } ?? "dsh-chamber"
                let detail = dict.flatMap { EdgePayload.string($0["detail"]) } ?? ""
                let run: () -> Void = {
                    let alert = NSAlert()
                    alert.alertStyle = .critical
                    alert.messageText = title
                    alert.informativeText = detail
                    alert.runModal()
                }
                if Thread.isMainThread {
                    run()
                } else {
                    DispatchQueue.main.sync(execute: run)
                }
                return (nil, nil)
            }
        case "launchApp":
            // E12 open-in 原生拉起腿：payload {appId, path}。v1 语义：path 指向
            // .app 时经 NSWorkspace.openApplication 拉起；否则尝试以 path 作为
            // 文件用默认应用打开；appId→应用映射（Finder/VS Code 协商）属 M3
            // 集成（open-in-apps 协商数据在 core，Swift 侧只执行叶）。
            return performUI(method: method) {
                guard mainWindowProvider?() != nil else {
                    return (nil, Self.uiUnavailablePrefix + method + ":no-window")
                }
                guard let rawPath = dict.flatMap({ EdgePayload.string($0["path"]) }),
                      !rawPath.isEmpty else {
                    return (nil, Self.unimplementedPrefix + method + ":path-missing")
                }
                let url = URL(fileURLWithPath: rawPath)
                if url.pathExtension.lowercased() == "app" {
                    // 同步 openApplication（SDK 非 throwing）；启动结果经
                    // NSWorkspace 运行会话异步上报——v1 以「已提交拉起」为成功，
                    // 应用启动失败由系统/用户可见处理。
                    NSWorkspace.shared.openApplication(
                        at: url,
                        configuration: NSWorkspace.OpenConfiguration()
                    )
                    return (.bool(true), nil)
                }
                if NSWorkspace.shared.open(url) {
                    return (.bool(true), nil)
                }
                return (nil, Self.uiUnavailablePrefix + method + ":open-failed")
            }
        case "showMessage":
            // 形状（HostMessageOptions，electron-edges/global.d.ts 为准）：
            // {type,title,message,detail,buttons[],defaultId,cancelId,noLink?}
            guard config.canShowUI() else {
                return (nil, Self.uiUnavailablePrefix + method)
            }
            // M3 集成：主线程 NSAlert + pendingAlerts.expect()/complete(token:)
            // 消费；本切片登记 pending 并立即返回取消序（无宿主接线时为
            // 诚实降级：0 号按钮 = 取消语义与 electron-edges cancelId 同向）。
            let token = pendingAlerts.expect()
            let cancelId = dict.flatMap { EdgePayload.int($0["cancelId"]) } ?? 0
            pendingAlerts.complete(token: token, buttonIndex: cancelId)
            return (.number(Double(cancelId)), nil)
        case "openExternal", "openPath":
            return performUI(method: method) {
                guard let url = Self.extractURL(method: method, dict: dict) else {
                    return (nil, Self.unimplementedPrefix + method + ":url-extract")
                }
                guard mainWindowProvider?() != nil else {
                    // 无主窗上下文（headless/未接线）不触发系统副作用。
                    return (nil, Self.uiUnavailablePrefix + method + ":no-window")
                }
                if NSWorkspace.shared.open(url) {
                    return (nil, nil)
                }
                return (nil, Self.uiUnavailablePrefix + method + ":open-failed")
            }
        default:
            // showNativeNotification（UNUserNotificationCenter + delegate →
            // __host.notifyClicked 回灌）/ pickPluginSource / showItemInFolder /
            // setBadge / setKeepAwake / setLoginItem / showError / launchApp /
            // retireNotifications 等：宿主腿 M3 集成（AppKit 侧实现 + 实机
            // 门禁）。无宿主接线前一律 loud 拒绝（回落默认表不挂起）。
            return (nil, Self.unimplementedPrefix + method)
        }
    }

    private func performUI(method: String, _ body: () -> (result: AnyCodable?, error: String?))
        -> (result: AnyCodable?, error: String?) {
        guard config.canShowUI() else {
            return (nil, Self.uiUnavailablePrefix + method)
        }
        return body()
    }

    /// openExternal/openPath 的 URL 提取：openExternal 载荷 {url: string}；
    /// openPath 载荷 {path: string}。
    private static func extractURL(method: String, dict: [String: AnyCodable]?) -> URL? {
        guard let dict else { return nil }
        if method == "openExternal", let raw = EdgePayload.string(dict["url"]) {
            return URL(string: raw)
        }
        if method == "openPath", let raw = EdgePayload.string(dict["path"]) {
            return URL(fileURLWithPath: raw)
        }
        return nil
    }
}
