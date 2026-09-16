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
//  降级语义（headless/无窗/self.config.canShowUI()==false → 一律诚实错误
//  "swift-edge-ui-unavailable:<method>"，绝不静默假装成功）：
//  - 已实现腿（全部带守卫）：focusMainWindow / pickPluginSource /
//    showMessage（异步 NSAlert 消费）/ showNativeNotification
//    （UNUserNotificationCenter + click 回灌 __host.notifyClicked）/
//    openExternal / openPath / showItemInFolder / setBadge（dockTile）/
//    setKeepAwake / setLoginItem（E14：SMAppService.mainApp，S-D 补齐——
//    swift run 无 bundle 时 guard 诚实报 no-bundle）/ showError /
//    launchApp（E12：appId 最小映射 finder/vscode + 缺省 loud，S-D 补齐）。
//  - 退役：edge 面 "retireNotifications" 不在本类（node-edges 以 notify 发送
//    退役，不经 edge）——notify 消费路由在 MainWindowController：S8 起按
//    sourceId→identifier 登记表调 UNUserNotificationCenter
//    .removeDeliveredNotifications(withIdentifiers:) 清除已展示横幅。
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
        guard case .number(let n)? = value, n.isFinite else { return nil }
        // Int(n) 对 NaN/±inf/越界值直接 trap（2026-09 二轮评审 P3：实测
        // `-1e400` 经 JSON 桥接后 exit 133）；Int(exactly:) 失败即 nil。
        return Int(exactly: n)
    }

    static func bool(_ value: AnyCodable?) -> Bool? {
        guard case .bool(let b)? = value else { return nil }
        return b
    }
}

/// 原生通知调度解码（S8）：node-edges/electron-edges 出站形状
/// {notificationId: Int, sourceId?: String, spec: {title?, body?, message?,
/// silent?: bool, sound?: string}}。sourceId 缺省/null/非字符串 =
/// unknown-source——仍投递，不登记退役（无法归属退役集）；identifier 恒
/// chamber-edge-<进程纪年>.<壳内序号>.<notificationId>（见 identifierEpoch /
/// identifier(sequence:)）。
struct NotificationDispatch: Equatable {
    var notificationId: Int
    var sourceId: String?
    var title: String
    var body: String
    var silent: Bool
    /// 具名音效（Electron darwin: spec.sound ?? 'Glass'；nil = 用默认名 Glass）。
    var sound: String?

    /// 本壳进程的投递标识纪年。
    static let identifierEpoch = String(UUID().uuidString.prefix(8)).lowercased()

    /// OS 标识：`chamber-edge-<纪年>.<壳内单调序号>.<sidecar notificationId>`。
    /// - 纪年区分不同壳进程；序号在壳进程内单调，**sidecar 重启不会重置它**，
    ///   因此重启前后的横幅在通知中心绝不同名（否则退役旧来源会误删新来源的
    ///   同名活横幅——2026-12 第三/四轮验证）；
    /// - **末段恒为 sidecar 的 notificationId**：click 回灌按 `.` 末段解析
    ///   （AppDelegate.userNotificationCenter didReceive）；分隔符用 `.` 而非
    ///   `-`，否则负值（缺省容错 -1）会被拆成两段而解析成正数。
    func identifier(sequence: Int) -> String {
        "chamber-edge-\(Self.identifierEpoch).\(sequence).\(notificationId)"
    }

    /// 音效名解析（纯函数，单测直测）：空名/缺省回落 Electron darwin 的默认
    /// 'Glass'（electron-edges.ts:161 spec.sound ?? 'Glass'）。
    static func notificationSoundName(_ name: String?) -> String {
        (name?.isEmpty == false) ? name! : "Glass"
    }

    /// 具名音效（2026-12 双端逐函数核对 V4/V7）：UNUserNotificationCenter 以系统
    /// 音效名等价表达 Electron 的具名音效；名字无法解析时系统回落默认声。
    static func notificationSound(named name: String?) -> UNNotificationSound {
        UNNotificationSound(named: UNNotificationSoundName(notificationSoundName(name)))
    }

    /// payload → dispatch；顶层非对象 → nil（调用方 loud 拒绝）。
    static func decode(_ payload: AnyCodable?) -> NotificationDispatch? {
        guard let dict = EdgePayload.dictionary(payload) else { return nil }
        let spec = EdgePayload.dictionary(dict["spec"])
        return NotificationDispatch(
            notificationId: EdgePayload.int(dict["notificationId"]) ?? -1,
            sourceId: EdgePayload.string(dict["sourceId"]),
            title: spec.flatMap { EdgePayload.string($0["title"]) } ?? "",
            body: spec.flatMap { EdgePayload.string($0["body"]) }
                ?? spec.flatMap { EdgePayload.string($0["message"]) } ?? "",
            silent: spec.flatMap { EdgePayload.bool($0["silent"]) } ?? false,
            sound: spec.flatMap { EdgePayload.string($0["sound"]) }
        )
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
        /// 测试注入：UI 腿执行体覆盖（method → outcome）。生产恒 nil；
        /// 注入慢/假 body 让单测可验证交互腿的异步应答、10 分钟上限与超时
        /// 弃权——真实 NSAlert/NSOpenPanel 模态无法在单测里驱动（S1/S17）。
        public var uiLegBodyOverride: ((String, AnyCodable?) -> (result: AnyCodable?, error: String?))?
        public init(canShowUI: @escaping () -> Bool = { false },
                    isAppBundled: @escaping () -> Bool = {
                        Bundle.main.bundleIdentifier != nil
                    },
                    uiLegBodyOverride: ((String, AnyCodable?) -> (result: AnyCodable?, error: String?))? = nil) {
            self.canShowUI = canShowUI
            self.isAppBundled = isAppBundled
            self.uiLegBodyOverride = uiLegBodyOverride
        }
    }

    private let config: Config
    /// 主窗提供者（POC 接线点：MainWindowController 注册后置非 nil）。
    public var mainWindowProvider: (() -> NSWindow?)?

    /// 已投递通知登记表（S8）：scheduleNotification 成功后登记，notify 路由
    /// retireNotifications 消费（removeDeliveredNotifications）。
    public let notificationRegistry = NotificationDeliveryRegistry()
    /// 授权请求是否已发起（S3·V1：首次通知时请求一次；进程内幂等）。
    private static var notificationAuthorizationRequested = false

    /// keep-awake activity token（ProcessInfo 防休眠；nil = 未激活）。
    private var keepAwakeActivity: NSObjectProtocol?

    /// 2026-12 双端逐函数核对 D3/F6：只防【系统】休眠，不阻止显示器关闭 ——
    /// Electron 用 powerSaveBlocker prevent-app-suspension（main.ts），
    /// design 14 D5 亦写明「仅防应用挂起，不阻止显示器关闭」。原实现带
    /// .idleDisplaySleepDisabled（屏幕永不熄灭），与 Electron 可感不一致。
    private func updateKeepAwake(enabled: Bool) {
        if enabled, keepAwakeActivity == nil {
            keepAwakeActivity = ProcessInfo.processInfo.beginActivity(
                options: [.idleSystemSleepDisabled],
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

    /// 退出清理（2026-12 双端逐函数核对 D13）：显式收回 keep-awake。窗口可能
    /// 已关闭，故不经 A 桥的 no-window 守卫路径（respond 会被挡掉）。
    public func clearKeepAwake() {
        updateKeepAwake(enabled: false)
    }

    /// 退出清理（同 D13）：清空 Dock 角标（Electron will-quit 同序）。
    public func clearBadge() {
        let run: () -> Void = { NSApp.dockTile.badgeLabel = nil }
        if Thread.isMainThread {
            run()
        } else {
            DispatchQueue.main.sync(execute: run)
        }
    }

    public init(config: Config = Config()) {
        self.config = config
    }

    /// 未实现（M3 集成点留待）与 UI 不可用文案前缀（BridgeClient 回落依据）。
    public static let unimplementedPrefix = "swift-edge-unimplemented:"
    public static let uiUnavailablePrefix = "swift-edge-ui-unavailable:"

    /// 非交互 UI 腿的有界等待：主线程可能正被 BridgeClient.stop() 的收尾轮询
    /// 占用，退出优先；超时 loud 失败（core 可重试），body 幂等。
    static let uiLegTimeout: TimeInterval = 1.0
    /// 交互腿（showMessage/pickPluginSource）上限：用户在模态上思考/浏览可能远超
    /// 1s。node 侧现在是 SWIFT_INTERACTIVE_LEG_TIMEOUT_MS(600_000) + 60_000 缓冲
    /// （S2·F4：两侧同值时 node 恒先超时，用户 10 分钟后的答案被丢）——Swift 侧超时
    /// 点必须 ≤ node 侧且二者有明确缓冲。跨语言锁步见 CrossLanguageLockstepTests。
    static let interactiveLegTimeout: TimeInterval = 600

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
        switch method {
        case "showNativeNotification":
            scheduleNotification(payload: payload, completion: completion)
        case "showMessage", "pickPluginSource":
            // S1：交互腿经异步入口应答——模态在主线程执行、完成才 reply，
            // 既不占住管道读取线程，也不在 1s 处丢弃模态结果。
            performInteractiveUI(method: method, payload: payload, completion: completion)
        default:
            let outcome = respond(method: method, payload: payload)
            completion(outcome.result, outcome.error)
        }
    }

    /// 异步腿面（canShowUI 为真时由本类真实接管，BridgeClient 默认应答器据此
    /// 走 respondAsync）：showNativeNotification 调度 + showMessage/
    /// pickPluginSource 两个交互模态（S1：10 分钟上限，完成才 reply）。
    public func canHandleAsync(method: String) -> Bool {
        switch method {
        case "showNativeNotification", "showMessage", "pickPluginSource":
            return self.config.canShowUI()
        default:
            return false
        }
    }

    /// 真实通知调度（W-21 切片；design 25 §5 E4；S8 补 sourceId/silent）：
    /// 载荷解码见 NotificationDispatch。canShowUI 为假 → ui-unavailable 诚实
    /// 降级；调度失败（未授权/系统拒绝）→ loud error。click 回灌
    /// （__host.notifyClicked）与前台展示 delegate 已由 AppDelegate 接线
    /// （UNUserNotificationCenterDelegate），不再是 M3 遗留。
    private func scheduleNotification(
        payload: AnyCodable?,
        completion: @escaping (AnyCodable?, String?) -> Void
    ) {
        guard self.config.canShowUI() else {
            completion(nil, Self.uiUnavailablePrefix + "showNativeNotification")
            return
        }
        guard let dispatch = NotificationDispatch.decode(payload) else {
            completion(nil, Self.unimplementedPrefix + "showNativeNotification:payload")
            return
        }
        let content = UNMutableNotificationContent()
        content.title = dispatch.title
        content.body = dispatch.body
        // 声音映射（2026-12 双端逐函数核对 V4/V7）：silent → 无声音；否则与
        // Electron darwin 一致地用具名音效（electron-edges.ts:161
        // sound: spec.sound ?? 'Glass'）——UNUserNotificationCenter 以系统音效名
        // 等价表达，缺省名 Glass，名字无法解析时系统回落默认声。
        content.sound = dispatch.silent
            ? nil
            : NotificationDispatch.notificationSound(named: dispatch.sound)
        // 调度前登记（**先于** add）：退役与投递之间没有原子点，先登记让退役端
        // 一定能看到该 identifier；完成回调再由 finishDelivery 判定是否需要在
        // 横幅落地后立即清除（2026-12 验证轮：只在完成回调登记会漏掉这个窗口）。
        let identifier = dispatch.identifier(sequence: notificationRegistry.nextIdentifierSequence())
        let tracked = notificationRegistry.beginDelivery(sourceId: dispatch.sourceId,
                                                         identifier: identifier)
        let request = UNNotificationRequest(
            identifier: identifier,
            content: content,
            trigger: nil  // 立即投递（前台展示由 AppDelegate delegate 接管）
        )
        let center = UNUserNotificationCenter.current()
        let deliver: () -> Void = { [registry = notificationRegistry] in
            center.add(request) { error in
                if let error {
                    // 投递失败：撤下登记（没有可退役的横幅）。
                    _ = registry.finishDelivery(sourceId: dispatch.sourceId,
                                                identifier: identifier,
                                                delivered: false)
                    completion(nil, "swift-edge-notification-schedule-failed:\(error.localizedDescription)")
                } else {
                    let retiredInFlight = tracked
                        && registry.finishDelivery(sourceId: dispatch.sourceId,
                                                   identifier: identifier,
                                                   delivered: true)
                    if retiredInFlight {
                        // 在途期间来源已被退役：横幅刚落地，立即清除。
                        center.removeDeliveredNotifications(withIdentifiers: [identifier])
                    }
                    completion(nil, nil)
                }
            }
        }
        // 授权时机（2026-12 双端逐函数核对 S3·V1）：首次**真正要投递**通知时才向
        // 系统申请权限（Electron 同序——不是启动即弹系统框）。已授权/已拒绝时
        // requestAuthorization 幂等（不再弹框）；请求失败 loud，但仍尝试投递：
        // 未授权时 add 会以错误回调收敛，绝不静默假装成功。
        if Self.notificationAuthorizationRequested {
            deliver()
        } else {
            Self.notificationAuthorizationRequested = true
            center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
                if let error {
                    print("[poc] 通知授权请求错误：\(error.localizedDescription)")
                } else {
                    print("[poc] 通知授权 = \(granted)（首次通知时请求，S3·V1）")
                }
                deliver()
            }
        }
    }

    /// 统一分派：未知/未实现 → unimplemented；UI 腿在 canShowUI()==false →
    /// ui-unavailable；其余按腿执行。
    public func respond(method: String, payload: AnyCodable?)
        -> (result: AnyCodable?, error: String?) {
        let dict = EdgePayload.dictionary(payload)
        switch method {
        case "updateNativeCapability":
            // 原生更新器能力上报（S-01 / 裁决 D-1 选 B）：sidecar 用它决定页面更新区
            // 是否还显示「原生壳不支持自动安装」。未装配（dev/dry-run/缺密钥）→ false。
            return (.object(["available": .bool(AppUpdater.shared.isAvailable)]), nil)
        case "updateNativeAction":
            // 页面更新按钮 → Sparkle 标准更新窗口（下载与安装都在该窗口内完成）。
            guard AppUpdater.shared.isAvailable else {
                return (nil, "native-updater-unavailable")
            }
            var kind = "check"
            if case .object(let dict)? = payload, case .string(let value)? = dict["kind"] {
                kind = value
            }
            print("[poc] 原生更新动作：\(kind)（交给 Sparkle 标准窗口）")
            AppUpdater.shared.checkForUpdates(nil)
            return (.object(["ok": .bool(true), "kind": .string(kind)]), nil)
        case "focusMainWindow":
            return performUI(method: method) {
                guard let window = self.mainWindowProvider?() else {
                    return (nil, Self.uiUnavailablePrefix + method + ":no-window")
                }
                window.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
                return (nil, nil)
            }
        case "showNativeNotification":
            // 同步路径仅覆盖 UI 不可用（真实调度走 respondAsync/canHandleAsync）；
            // 谎报 shown 绝不允许。
            guard self.config.canShowUI() else {
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
                guard self.mainWindowProvider?() != nil else {
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
                guard self.mainWindowProvider?() != nil else {
                    return (nil, Self.uiUnavailablePrefix + method + ":no-window")
                }
                let on = dict.flatMap { EdgePayload.bool($0["on"]) } ?? false
                self.updateKeepAwake(enabled: on)
                return (nil, nil)
            }
        case "showItemInFolder":
            // Finder 揭示叶：payload {path: string}；窗口上下文守卫。
            return performUI(method: method) {
                guard self.mainWindowProvider?() != nil else {
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
            // 语义：darwin openFile+openDirectory 一体）。交互模态（S1）——同步
            // 面按 node 侧 10 分钟上限等待、超时弃权；默认应答器经
            // canHandleAsync 走 respondAsync（模态完成才 reply，不占管道线程）。
            return performUI(method: method, timeout: Self.interactiveLegTimeout) {
                self.pickPluginSourceBody()
            }
        case "showError":
            // dialog.showErrorBox 对应腿：payload {title, detail}；主线程模态
            // alert（无窗守卫——深链消费等错误路径须有 UI 上下文才弹）。
            return performUI(method: method) {
                guard self.mainWindowProvider?() != nil else {
                    return (nil, Self.uiUnavailablePrefix + method + ":no-window")
                }
                let title = dict.flatMap { EdgePayload.string($0["title"]) } ?? "dsh-chamber"
                let detail = dict.flatMap { EdgePayload.string($0["detail"]) } ?? ""
                let run: () -> Void = {
                    let alert = NSAlert()
                    alert.alertStyle = .critical
                    alert.messageText = title
                    alert.informativeText = detail
                    // S2·V2 / S3·V6（2026-12 双端逐函数核对）：有可见窗口时用
                    // sheet 呈现，不再在主线程 runModal 冻住整个 UI（Electron 的
                    // dialog.showErrorBox 不阻塞渲染器）；无窗口才退回 runModal。
                    if let window = self.mainWindowProvider?(), window.isVisible {
                        alert.beginSheetModal(for: window, completionHandler: nil)
                    } else {
                        alert.runModal()
                    }
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
                guard self.mainWindowProvider?() != nil else {
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
                guard self.config.isAppBundled() else {
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
            // dialog.showMessageBox 对应腿（S1 交互模态）：payload
            // HostMessageOptions 形状 {type,title,message,detail,buttons[],
            // defaultId,cancelId,noLink?}；应答 = 按钮序（0 基，electron-edges
            // 同契约）。同步面按 10 分钟上限等待、超时弃权；默认应答器经
            // canHandleAsync 走 respondAsync。
            return performUI(method: method, timeout: Self.interactiveLegTimeout) {
                self.showMessageBody(dict: dict ?? [:])
            }
        case "openExternal", "openPath":
            return performUI(method: method) {
                guard let url = Self.extractURL(method: method, dict: dict) else {
                    return (nil, Self.unimplementedPrefix + method + ":url-extract")
                }
                guard self.mainWindowProvider?() != nil else {
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
            // notify 路由 + NotificationDeliveryRegistry）；showNativeNotification
            // 同步面（真实调度走 respondAsync/canHandleAsync）。无宿主接线前
            // 一律 loud 拒绝（回落默认表不挂起）。
            return (nil, Self.unimplementedPrefix + method)
        }
    }

    /// UI 腿执行体解析（method → outcome）：测试覆盖优先，否则真实 AppKit
    /// 实现（交互腿见 performInteractiveUI；其余经 performUI 主线程收敛）。
    func uiBody(method: String, payload: AnyCodable?) -> (result: AnyCodable?, error: String?) {
        if let override = config.uiLegBodyOverride {
            return override(method, payload)
        }
        switch method {
        case "pickPluginSource":
            return pickPluginSourceBody()
        case "showMessage":
            return showMessageBody(dict: EdgePayload.dictionary(payload) ?? [:])
        default:
            return (nil, Self.unimplementedPrefix + method + ":no-body")
        }
    }

    /// 同步 UI 腿入口（有界等待；body 主线程执行）。默认超时 = 非交互腿
    /// 1s；交互腿调用方传 interactiveLegTimeout。超时 → 置弃权位：已排定
    /// 未执行的 body 不再执行（S1：不得「已失败但 body 稍后照常弹模态」）。
    func performUI(method: String,
                   timeout: TimeInterval = SwiftEdgeHostLegs.uiLegTimeout,
                   body: @escaping () -> (result: AnyCodable?, error: String?))
        -> (result: AnyCodable?, error: String?) {
        guard self.config.canShowUI() else {
            return (nil, Self.uiUnavailablePrefix + method)
        }
        // 主线程 hop（2026-09 模块评审 major）：本腿由 BridgeClient 的**管道
        // 读取线程**调用，而 body 里全是 AppKit（makeKeyAndOrderFront /
        // NSApp.activate / dockTile）。AppKit 只允许主线程访问——统一在此收敛，
        // 腿实现不必各自记得 hop。
        if Thread.isMainThread {
            return body()
        }
        // 有界等待（2026-09 二轮评审 P2 + S1）：主线程可能正被
        // BridgeClient.stop() 的收尾轮询占用，`main.sync` 会一直等到它结束
        // 才应答，sidecar 的优雅退出因此退化为 SIGKILL。改为 async + 有界超时：
        // 主线程空闲时照常应答，忙时 loud 失败（core 侧报 leg 失败，可重试）；
        // 交互腿用 10 分钟上限（node 侧同值），非交互腿保持 1s。
        var outcome: (result: AnyCodable?, error: String?) = (nil, nil)
        let gate = InteractiveCallGate()
        let semaphore = DispatchSemaphore(value: 0)
        DispatchQueue.main.async {
            guard !gate.isAbandoned else { return }
            outcome = body()
            semaphore.signal()
        }
        if semaphore.wait(timeout: .now() + timeout) == .timedOut {
            _ = gate.beginTimeout()
            return (nil, Self.uiUnavailablePrefix + method + ":main-thread-busy")
        }
        return outcome
    }

    /// 交互腿异步应答（S1）：body 只在主线程执行、模态完成才 reply；上限
    /// interactiveLegTimeout（10 min，与 node 侧 INTERACTIVE_EDGE_TIMEOUT_MS
    /// 对齐）。超时 → 弃权位：仍排队的 body 不再执行（绝无双重执行）；
    /// completion 恰一次由 gate 守卫，edge 应答写回的恰一次由
    /// BridgeClient.sendEdgeReply 守卫。
    func performInteractiveUI(method: String,
                              payload: AnyCodable?,
                              timeout: TimeInterval = SwiftEdgeHostLegs.interactiveLegTimeout,
                              completion: @escaping (AnyCodable?, String?) -> Void) {
        guard self.config.canShowUI() else {
            completion(nil, Self.uiUnavailablePrefix + method)
            return
        }
        let gate = InteractiveCallGate()
        DispatchQueue.main.async {
            guard !gate.isAbandoned else { return }
            let outcome = self.uiBody(method: method, payload: payload)
            _ = gate.finishIfActive {
                completion(outcome.result, outcome.error)
            }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
            guard gate.beginTimeout() else { return }
            completion(nil, Self.uiUnavailablePrefix + method + ":main-thread-busy")
        }
    }

    /// showMessage 模态体（须主线程执行；同步与异步应答面共用）。
    private func showMessageBody(dict: [String: AnyCodable]) -> (result: AnyCodable?, error: String?) {
        guard self.mainWindowProvider?() != nil else {
            return (nil, Self.uiUnavailablePrefix + "showMessage:no-window")
        }
        let styleRaw = EdgePayload.string(dict["type"]) ?? "warning"
        let alert = NSAlert()
        switch styleRaw {
        case "error", "critical": alert.alertStyle = .critical
        case "info", "information": alert.alertStyle = .informational
        default: alert.alertStyle = .warning
        }
        let title = EdgePayload.string(dict["title"]) ?? "dsh-chamber"
        alert.messageText = title
        let message = EdgePayload.string(dict["message"]) ?? ""
        let detail = EdgePayload.string(dict["detail"]) ?? ""
        // 2026-12 双端逐函数核对 U1：调用点把 title 与 message 传同一文案
        // （shell-core.ts 的两处确认框都如此），而 NSAlert 没有独立窗口标题，
        // 照搬会把正文显示两遍。相等时只保留一份。
        let body = message == title ? [detail] : [message, detail]
        alert.informativeText = body.filter { !$0.isEmpty }.joined(separator: "\n")
        var buttons: [String] = []
        if case .array(let items)? = dict["buttons"] {
            for item in items {
                if case .string(let s) = item { buttons.append(s) }
            }
        }
        if buttons.isEmpty { buttons = ["OK"] }
        // defaultId / cancelId（2026-12 双端逐函数核对 F5/Q4）：Electron
        // dialog.showMessageBox 用 defaultId 指定 Enter 命中的按钮、cancelId 指定
        // Esc 命中的按钮；NSAlert 用 keyEquivalent 表达同一语义。两者相同或越界
        // 时不额外设置（避免一键双义；NSAlert 缺省即首个按钮回车）。
        let defaultId = EdgePayload.int(dict["defaultId"])
        let cancelId = EdgePayload.int(dict["cancelId"])
        for (index, title) in buttons.enumerated() {
            let button = alert.addButton(withTitle: title)
            if let defaultId, defaultId == index, defaultId != cancelId {
                button.keyEquivalent = "\r"
            } else if let cancelId, cancelId == index {
                button.keyEquivalent = "\u{1b}"
            }
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

    /// pickPluginSource 模态体（须主线程执行；同步与异步应答面共用）。应答
    /// 形状 {status:'cancelled'} 或 {status:'picked', path}（node-edges 折算）。
    private func pickPluginSourceBody() -> (result: AnyCodable?, error: String?) {
        guard self.mainWindowProvider?() != nil else {
            return (nil, Self.uiUnavailablePrefix + "pickPluginSource:no-window")
        }
        var pickedPath: String?
        var cancelled = false
        let run: () -> Void = {
            let panel = NSOpenPanel()
            // 文案与归属对齐 Electron（electron-edges.ts pickPluginSource：
            // title 'Import a dsh plugin — source folder or .tgz archive'、
            // buttonLabel 'Import'、扩展过滤器只约束文件、目录仍可选）——
            // 2026-12 双端逐函数核对 S4·U2 / S2·V3。
            panel.title = "Import a dsh plugin — source folder or .tgz archive"
            panel.prompt = "Import"
            panel.message = "Import a dsh plugin — source folder or .tgz archive"
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
        return (nil, Self.uiUnavailablePrefix + "pickPluginSource:no-selection")
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

/// 交互 UI 腿的恰一次应答/弃权门（线程安全）：
///  - body 完成 → finishIfActive 恰好一次交付结果（超时已抢占则不再交付）；
///  - 超时 → beginTimeout 抢占并置弃权位，已排定未执行的 body 见位即退出
///    ——超时后绝不补执行（S1 无双重执行）。
private final class InteractiveCallGate {
    private let lock = NSLock()
    private var finished = false
    private var abandoned = false

    var isAbandoned: Bool {
        lock.lock()
        defer { lock.unlock() }
        return abandoned
    }

    /// 超时路径：尚未完成 → 标记完成+弃权并返回 true（调用方回超时错误）。
    func beginTimeout() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !finished else { return false }
        finished = true
        abandoned = true
        return true
    }

    /// body 完成路径：恰一次交付；超时已抢占 → false。
    func finishIfActive(_ deliver: () -> Void) -> Bool {
        lock.lock()
        guard !finished else {
            lock.unlock()
            return false
        }
        finished = true
        lock.unlock()
        deliver()
        return true
    }
}
