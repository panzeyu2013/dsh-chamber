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
//  - 已实现腿（全部带守卫）：focusMainWindow / pickPluginSource /
//    showMessage（异步 NSAlert 消费）/ showNativeNotification
//    （UNUserNotificationCenter + click 回灌 __host.notifyClicked）/
//    openExternal / openPath / showItemInFolder / setBadge（dockTile）/
//    setKeepAwake / setLoginItem（E14：SMAppService.mainApp，S-D 补齐——
//    swift run 无 bundle 时 guard 诚实报 no-bundle）/ showError /
//    launchApp（E12：appId 最小映射 finder/vscode + 缺省 loud，S-D 补齐）。
//  - 未实现边沿：edge 面 "retireNotifications"（node-edges 以 notify 发送
//    退役，不经 edge——Swift 侧 notify 消费路由见 MainWindowController；
//    POC 无 sourceId→identifier 登记表 → 诚实 no-op）。
//  GUI 分支实机验收属硬门禁（M3 集成点见各腿注释 TODO；setLoginItem 的
//  register/unregister 真机调用、launchApp 的 Finder/vscode 真实拉起均须
//  实机/签名环境）。
//

import Foundation
import AppKit
import ServiceManagement
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


public final class SwiftEdgeHostLegs {
    /// UI/系统能力门（headless/测试 → false：全部 UI 腿诚实降级）。
    public struct Config {
        public var canShowUI: () -> Bool
        /// app bundle 形态判定（setLoginItem 的 SMAppService.mainApp 前置
        /// 守卫：swift run dev 态无 bundle/Info.plist 注册，register 必失败——
        /// 诚实报错而非碰运气）。默认真实现 = Bundle.main.bundleIdentifier
        /// 存在性；测试可注入固定值（headless 不触碰 ServiceManagement）。
        public var isAppBundled: () -> Bool
        public init(canShowUI: @escaping () -> Bool = { false },
                    isAppBundled: @escaping () -> Bool = {
                        Bundle.main.bundleIdentifier != nil
                    }) {
            self.canShowUI = canShowUI
            self.isAppBundled = isAppBundled
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
            // 本腿只执行 dockTile 写。notify 消费（S-D：sidecar setBadge
            // notify → MainWindowController 路由）复用本腿——守卫语义与 edge
            // 面一致（canShowUI/主窗），失败在消费侧 loud。
            // 精度对照（S-D Electron 核实）：electron-edges setBadge =
            // try app.setBadgeCount → catch 折算 {applied:false, reason}——
            // core applyBadgePresentation 把失败压成一次 loud 日志，**不向
            // renderer 回执**（renderer 保持自己的计数投影）。Swift flavor
            // node-edges.setBadge 因同步契约无法跨进程往返而乐观
            // {applied:true}（fire-and-forget notify）——dock 写失败只能在
            // 本侧 loud（notify 消费打印 / edge 面 ok:false 上抛）。差异 =
            // 通知瞬间的失败窗口（尽力面，注释登记）+ 失败日志落点；对
            // renderer 的可见性两边一致（均无失败回执）→ parity 成立。
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
            // E12 open-in 原生拉起叶（S-D：appId 映射补齐）：payload
            // {appId, path}（node-edges launchApp 出站形状）。Electron open-in
            // 权威语义（open-in.ts 注册表）＝按 appId 白名单分派 provider
            // （finder/vscode 固定两枚），未知 appId → 'unknown open-in app'
            // loud——绝不猜测/回退成通用打开（通用 path 打开属 openPath edge
            // 职责）。分类/校验（instanceId/来源指纹/路径纪律）在 core
            // （open-in.test.ts 继续覆盖），本叶只执行：
            //   - 'finder' → Finder 揭示 path（darwin 分支：文件与目录一律
            //     activateFileViewerSelecting，同 finderApp.open 揭示语义；
            //     目录 openPath 分支仅非 darwin，本壳不可达）；
            //   - 'vscode' → vscode://file/<path> 本地文件夹深链（deep-link.ts
            //     buildVscodeFileUrl 同构：绝对路径逐段 encodeURIComponent
            //     编码；vscode:// scheme 交 NSWorkspace 系统深链打开）。
            //     远程 ssh-remote 目标需实例 authority 上下文（host/user/
            //     transport），本载荷无法表达——远程 vscode 由 core 在
            //     OPEN_IN 通道构造 vscode:// URL 后经 openExternal edge
            //     打开，不经本叶（注释声明）；
            //   - 缺省（未知 appId）→ loud ui-unavailable（镜像 open-in.ts
            //     unknown-open-in-app 的 loud，绝不按 path 默认打开）。
            return performUI(method: method) {
                guard mainWindowProvider?() != nil else {
                    return (nil, Self.uiUnavailablePrefix + method + ":no-window")
                }
                guard let appId = dict.flatMap({ EdgePayload.string($0["appId"]) }),
                      !appId.isEmpty else {
                    return (nil, Self.unimplementedPrefix + method + ":app-id-missing")
                }
                guard let rawPath = dict.flatMap({ EdgePayload.string($0["path"]) }),
                      !rawPath.isEmpty else {
                    return (nil, Self.unimplementedPrefix + method + ":path-missing")
                }
                switch appId {
                case "finder":
                    NSWorkspace.shared.activateFileViewerSelecting(
                        [URL(fileURLWithPath: rawPath)]
                    )
                    return (.bool(true), nil)
                case "vscode":
                    guard let target = Self.vscodeFileURL(for: rawPath) else {
                        return (nil, Self.unimplementedPrefix + method + ":path-not-absolute")
                    }
                    if NSWorkspace.shared.open(target) {
                        return (.bool(true), nil)
                    }
                    return (nil, Self.uiUnavailablePrefix + method + ":open-failed")
                default:
                    // 镜像 open-in.ts：未知 appId → loud，绝不 fallback。
                    return (nil, Self.uiUnavailablePrefix + method + ":unknown-app-id:" + appId)
                }
            }
        case "setLoginItem":
            // E14 登录自启叶（S-D 补齐）：payload {enabled: bool}。Electron
            // 语义 = app.setLoginItemSettings({openAtLogin: enabled})（main.ts
            // applyLaunchAtLogin darwin 分支；失败 loud {error} 绝不静默假
            // 成功——设置面语义 design 14 D6）。Swift = SMAppService.mainApp
            // （macOS 13+；Package 平台下限 13 → <13 的 NSLoginItem/
            // SMLoginItemSetEnabled 兜底分支不可达，design 25 §5 E14 注记）。
            // 守卫：canShowUI（headless 绝不触碰 ServiceManagement）→ app
            // bundle 注册形态（SMAppService.mainApp 需要 Info.plist——swift
            // run dev 态无 bundle → ui-unavailable:setLoginItem:no-bundle 诚实
            // 错误，绝不碰运气调 register）。打包态 register/unregister 真实
            // 调用，失败 loud（status 预检幂等：目标态已达成 → ok，不重复
            // 调用）。登录项本身无需窗口（Electron 侧无窗照常设置）→ 本腿
            // 不做 no-window 守卫（canShowUI 已表达 POC 的 UI 上下文门）。
            return performUI(method: method) {
                guard config.isAppBundled() else {
                    return (nil, Self.uiUnavailablePrefix + method + ":no-bundle")
                }
                let enabled = dict.flatMap { EdgePayload.bool($0["enabled"]) } ?? false
                let service = SMAppService.mainApp
                do {
                    if enabled {
                        if service.status != .enabled { try service.register() }
                    } else {
                        if service.status != .notRegistered { try service.unregister() }
                    }
                    return (nil, nil)
                } catch {
                    return (nil, Self.uiUnavailablePrefix + method
                            + ":apply-failed:" + error.localizedDescription)
                }
            }
        case "showMessage":
            // dialog.showMessageBox 对应腿：payload HostMessageOptions 形状
            // {type,title,message,detail,buttons[],defaultId,cancelId,noLink?}。
            // 主线程模态 NSAlert；应答 = 按钮序（0 基，electron-edges 同契约；
            // 无 buttons → 默认 ["OK"]）。无窗/headless → 诚实降级。
            return performUI(method: method) {
                guard mainWindowProvider?() != nil else {
                    return (nil, Self.uiUnavailablePrefix + method + ":no-window")
                }
                let dict0 = dict ?? [:]
                let styleRaw = EdgePayload.string(dict0["type"]) ?? "warning"
                let alert = NSAlert()
                switch styleRaw {
                case "error", "critical": alert.alertStyle = .critical
                case "info", "information": alert.alertStyle = .informational
                default: alert.alertStyle = .warning
                }
                alert.messageText = EdgePayload.string(dict0["title"]) ?? "dsh-chamber"
                let message = EdgePayload.string(dict0["message"]) ?? ""
                let detail = EdgePayload.string(dict0["detail"]) ?? ""
                alert.informativeText = [message, detail].filter { !$0.isEmpty }.joined(separator: "\n")
                var buttons: [String] = []
                if case .array(let items)? = dict0["buttons"] {
                    for item in items {
                        if case .string(let s) = item { buttons.append(s) }
                    }
                }
                if buttons.isEmpty { buttons = ["OK"] }
                for title in buttons {
                    alert.addButton(withTitle: title)
                }
                var modalResponse: NSApplication.ModalResponse = .alertFirstButtonReturn
                let run: () -> Void = { modalResponse = alert.runModal() }
                if Thread.isMainThread {
                    run()
                } else {
                    DispatchQueue.main.sync(execute: run)
                }
                // NSAlert 按钮返回码：1000=第一个…；索引 = raw-1000（越界夹 0）。
                let index = max(0, min(buttons.count - 1, Int(modalResponse.rawValue) - 1000))
                return (.number(Double(index)), nil)
            }
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
            // 仍未实现的宿主腿：edge 面 "retireNotifications"（node-edges 的
            // 退役经 notify 发送，不经 edge——消费在 MainWindowController 的
            // notify 路由，POC 无 sourceId→identifier 登记表 → 诚实 no-op）；
            // showNativeNotification 同步面（UI 可用时的真实调度走
            // respondAsync/canHandleAsync）。无宿主接线前一律 loud 拒绝
            // （回落默认表不挂起）。
            return (nil, Self.unimplementedPrefix + method)
        }
    }

    private func performUI(method: String, _ body: () -> (result: AnyCodable?, error: String?))
        -> (result: AnyCodable?, error: String?) {
        guard config.canShowUI() else {
            return (nil, Self.uiUnavailablePrefix + method)
        }
        // 主线程 hop（2026-09 模块评审 major）：本腿由 BridgeClient 的**管道
        // 读取线程**调用，而 body 里全是 AppKit（makeKeyAndOrderFront /
        // NSApp.activate / dockTile）。AppKit 只允许主线程访问——统一在此收敛，
        // 腿实现不必各自记得 hop。
        if Thread.isMainThread {
            return body()
        }
        var outcome: (result: AnyCodable?, error: String?) = (nil, nil)
        DispatchQueue.main.sync {
            outcome = body()
        }
        return outcome
    }

    // MARK: - launchApp 的 vscode 深链 URL 构造（纯逻辑，单测直测）

    /// vscode://file/<path> 深链 URL（镜像 deep-link.ts buildVscodeFileUrl /
    /// encodeRemotePath：绝对路径逐段编码、分隔符保持字面；drive-colon 还原
    /// 分支仅 win32 路径可达，本壳 mac-only 不可达）。path 非绝对（含空）→
    /// nil——叶侧形状守卫（绝对性/控制字符/长度/存在性的深度校验在 core
    /// open-in.ts runOpenInLaunch，本叶不重复实现）。
    static func vscodeFileURL(for path: String) -> URL? {
        guard path.hasPrefix("/") else { return nil }
        let encoded = path.dropFirst()
            .split(separator: "/", omittingEmptySubsequences: false)
            .map { encodeURIComponentSegment(String($0)) }
            .joined(separator: "/")
        return URL(string: "vscode://file/" + encoded)
    }

    /// encodeURIComponent 语义的段转义（JS 同族）：仅
    /// A–Z a–z 0–9 - _ . ! ~ * ' ( ) 保持字面，其余字符按 UTF-8 字节转
    /// %XX（大写十六进制）——空格 → %20、CJK/emoji → 逐字节 %XX，与
    /// deep-link.ts 的 encodeRemotePath 输出逐字一致（对照其单测锚点
    /// 'vscode://file/home/user/%E6%88%91%E7%9A%84%20%E9%A1%B9%E7%9B%AE'）。
    static func encodeURIComponentSegment(_ segment: String) -> String {
        let allowed = CharacterSet(charactersIn:
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        return segment.utf8.map { byte -> String in
            let scalar = UnicodeScalar(byte)
            if allowed.contains(scalar) {
                return String(Character(scalar))
            }
            return String(format: "%%%02X", byte)
        }.joined()
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
