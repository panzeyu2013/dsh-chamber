//
//  SwiftEdgeHostLegs.swift
//  DSHChamber
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

/// AnyCodable 载荷提取助手（直接对 enum case 做字典/标量投影）。
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

/// 通知授权状态（P-06）：UNUserNotificationCenter.getNotificationSettings 的
/// 最小投影——UNNotificationSettings 无公开构造器，测试经本枚举注入假体。
public enum EdgeNotificationAuthorization: Equatable {
    case notDetermined
    case denied
    case authorized
    /// 临时/静默授权（已获准投递，add 仍可能失败）。
    case provisional
    case ephemeral
    /// 未来新增状态：按已获准前进（add 结果才是权威裁决）。
    case unknown
}

/// 原生通知中心的最小可注入面（P-06 单测 seam）。生产实现 =
/// SystemUserNotificationCenter（UNUserNotificationCenter.current()，只在
/// bundle 形态/canShowUI 为真时构造与调用——dev 无 bundle 调 current() 会崩）。
public protocol EdgeNotificationCenter {
    func authorizationStatus(_ completion: @escaping (EdgeNotificationAuthorization) -> Void)
    func requestAuthorization(_ completion: @escaping (Bool, Error?) -> Void)
    func add(_ request: UNNotificationRequest, completion: @escaping (Error?) -> Void)
    func removeDeliveredNotifications(withIdentifiers identifiers: [String])
}

/// 生产实现（UNUserNotificationCenter 薄包装）。public：public init 的默认
/// 参数要引用它（默认参数值在调用侧求值，只能引用 public/inlinable 符号）。
public final class SystemUserNotificationCenter: EdgeNotificationCenter {
    public init() {}

    public func authorizationStatus(_ completion: @escaping (EdgeNotificationAuthorization) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            completion(Self.mapAuthorizationStatus(settings.authorizationStatus))
        }
    }

    public static func mapAuthorizationStatus(_ status: UNAuthorizationStatus) -> EdgeNotificationAuthorization {
        switch status {
        case .notDetermined: return .notDetermined
        case .denied: return .denied
        case .authorized: return .authorized
        case .provisional: return .provisional
        case .ephemeral: return .ephemeral
        @unknown default: return .unknown
        }
    }

    public func requestAuthorization(_ completion: @escaping (Bool, Error?) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge],
                                                                completionHandler: completion)
    }

    public func add(_ request: UNNotificationRequest, completion: @escaping (Error?) -> Void) {
        UNUserNotificationCenter.current().add(request) { error in completion(error) }
    }

    public func removeDeliveredNotifications(withIdentifiers identifiers: [String]) {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: identifiers)
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
        /// 通知中心 seam（P-06）：生产 = 系统中心；测试注入假体（系统中心
        /// 在 headless 测试里不可驱动，且 dev 无 bundle 调 current() 会崩）。
        public var notificationCenter: () -> EdgeNotificationCenter
        /// add 的有界等待（P-06；默认 5s，测试可缩短）。
        public var notificationAddTimeout: TimeInterval
        public init(canShowUI: @escaping () -> Bool = { false },
                    isAppBundled: @escaping () -> Bool = {
                        Bundle.main.bundleIdentifier != nil
                    },
                    uiLegBodyOverride: ((String, AnyCodable?) -> (result: AnyCodable?, error: String?))? = nil,
                    notificationCenter: @escaping () -> EdgeNotificationCenter = {
                        SystemUserNotificationCenter()
                    },
                    notificationAddTimeout: TimeInterval = SwiftEdgeHostLegs.notificationAddTimeout) {
            self.canShowUI = canShowUI
            self.isAppBundled = isAppBundled
            self.uiLegBodyOverride = uiLegBodyOverride
            self.notificationCenter = notificationCenter
            self.notificationAddTimeout = notificationAddTimeout
        }
    }

    private let config: Config
    /// 主窗提供者（POC 接线点：MainWindowController 注册后置非 nil）。
    public var mainWindowProvider: (() -> NSWindow?)?

    /// 已投递通知登记表（S8）：scheduleNotification 成功后登记，notify 路由
    /// retireNotifications 消费（removeDeliveredNotifications）。
    public let notificationRegistry = NotificationDeliveryRegistry()
    /// 授权请求是否已发起（S3·V1：首次通知时请求一次）。按 legs 实例记忆
    /// （生产恰一个实例 = 进程内幂等；测试每例新实例，互不串味），经锁串行。
    private let authorizationLock = NSLock()
    private var notificationAuthorizationRequested = false

    /// 首个调用者取得「发起授权请求」权；在途/已请求 → false（调用方仍尝试
    /// add——未授权时 add 会以错误回调收敛，绝不静默假成功）。
    private func beginAuthorizationRequestIfNeeded() -> Bool {
        authorizationLock.lock()
        defer { authorizationLock.unlock() }
        guard !notificationAuthorizationRequested else { return false }
        notificationAuthorizationRequested = true
        return true
    }

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
    /// 通知 add 的有界等待（P-06，5s；与 Electron
    /// NATIVE_NOTIFICATION_OUTCOME_TIMEOUT_MS 同值）。超时回
    /// {shown:false,error:"..."}，core 据此释放 5s 去重 claim。
    public static let notificationAddTimeout: TimeInterval = 5.0
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

    /// 真实通知调度（W-21 切片；design 25 §5 E4；S8 补 sourceId/silent；
    /// P-06 诚实回执）：canShowUI 为假 → ui-unavailable 诚实降级；先查授权
    /// 状态（denied → {shown:false,error}；notDetermined → 先申请一次）；
    /// add 有有界等待（notificationAddTimeout，缺省 5s），超时/add 错误一律
    /// 回可解析的 {shown:false,error:"..."}——**只有 add 完成回调成功才回
    /// {shown:true}**。node-edges 的 interpretNativeNotificationReply 据此
    /// 决定是否释放 5s 去重 claim（绝不把「edge 传输成功」当成「横幅已显示」）。
    /// click 回灌（__host.notifyClicked）与前台展示 delegate 已由 AppDelegate
    /// 接线（UNUserNotificationCenterDelegate）。
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
        // P-06 seam：生产 = UNUserNotificationCenter.current()；测试注入假体。
        let center = self.config.notificationCenter()
        let replyGate = NotificationReplyGate()
        /// 授权/调度失败的统一收敛：撤下登记（没有可退役的横幅）并回
        /// {shown:false,error}（**结果**而非 reject——core 的
        /// interpretNativeNotificationReply 按对象形状折算 honest-show）。
        let fail: (String) -> Void = { [registry = notificationRegistry] message in
            _ = registry.finishDelivery(sourceId: dispatch.sourceId,
                                        identifier: identifier,
                                        delivered: false)
            guard replyGate.claim() else { return }
            completion(.object(["shown": .bool(false), "error": .string(message)]), nil)
        }
        let deliver: () -> Void = { [registry = notificationRegistry] in
            // 有界等待（P-06）：超时先回失败；add 晚到的成功横幅由完成回调
            // 立即清除，绝不给用户留一条「已报失败」的通知。
            DispatchQueue.global().asyncAfter(deadline: .now() + self.config.notificationAddTimeout) {
                guard replyGate.claim() else { return }
                shellLog("[shell] 通知投递超时（\(self.config.notificationAddTimeout)s）——诚实回 {shown:false}")
                completion(.object(["shown": .bool(false),
                                    "error": .string("swift-edge-notification-add-timeout")]), nil)
            }
            center.add(request) { error in
                if let error {
                    // 投递失败：撤下登记（没有可退役的横幅）。
                    _ = registry.finishDelivery(sourceId: dispatch.sourceId,
                                                identifier: identifier,
                                                delivered: false)
                    guard replyGate.claim() else { return }
                    completion(.object([
                        "shown": .bool(false),
                        "error": .string("swift-edge-notification-schedule-failed:\(error.localizedDescription)"),
                    ]), nil)
                    return
                }
                let retiredInFlight = tracked
                    && registry.finishDelivery(sourceId: dispatch.sourceId,
                                               identifier: identifier,
                                               delivered: true)
                if retiredInFlight {
                    // 在途期间来源已被退役：横幅刚落地，立即清除。
                    center.removeDeliveredNotifications(withIdentifiers: [identifier])
                }
                guard replyGate.claim() else {
                    // 超时已回失败：晚到的横幅立即清除，保持回执与通知中心一致。
                    center.removeDeliveredNotifications(withIdentifiers: [identifier])
                    return
                }
                completion(.object(["shown": .bool(true)]), nil)
            }
        }
        // 授权状态先查（P-06）：denied 直接失败（不请求、不 add）；notDetermined
        // 先申请一次（S3·V1 时机不变：首次真正要投递时才请求，不是启动即弹系统
        // 框；申请在途时仍尝试 add，未授权会以错误回调收敛）；已授权/临时授权
        // 直接投递；unknown 按已获准前进（add 结果才是权威裁决）。
        center.authorizationStatus { status in
            switch status {
            case .denied:
                shellLog("[shell] 通知未授权（denied）——拒绝投递（P-06）")
                fail("swift-edge-notification-not-authorized:denied")
            case .notDetermined:
                if self.beginAuthorizationRequestIfNeeded() {
                    center.requestAuthorization { granted, error in
                        if let error {
                            shellLog("[shell] 通知授权请求错误：\(error.localizedDescription)")
                            fail("swift-edge-notification-authorization-failed:\(error.localizedDescription)")
                        } else {
                            shellLog("[shell] 通知授权 = \(granted)（首次通知时请求，S3·V1）")
                            if granted {
                                deliver()
                            } else {
                                fail("swift-edge-notification-not-authorized:denied")
                            }
                        }
                    }
                } else {
                    deliver()
                }
            case .authorized, .provisional, .ephemeral, .unknown:
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
            // 原生更新器能力上报（S-01 / 裁决 D-1 选 B；S-38 诚实化）：sidecar 用它
            // 决定页面更新区是否还显示「原生壳不支持自动安装」。available=false 时
            // 携带**真实原因**（未装配 / 坏 feed / 坏 EdDSA 公钥 / startUpdater 失败），
            // sidecar 记录该原因；页面 check 因此拿 ok:false 落 error，绝不假 available。
            let capability = AppUpdater.shared.capability
            return (.object([
                "available": .bool(capability.available),
                "error": capability.error.map { .string($0) } ?? .null,
            ]), nil)
        case "updateNativeAction":
            // 页面更新按钮：kind=check 走检查；download/install 把 Sparkle 标准更新
            // 窗口带到前台（下载+安装在该窗口内完成，P-15/S-39 的 kind 分派）。回执
            // 诚实：不可用/忙/未知 kind 都是显式 error，绝不假 ok:true 让页面停住。
            // 形状先于状态：未知 kind 是坏请求，先诚实拒绝（与更新器是否装配无关）。
            var kind = "check"
            if case .object(let dict)? = payload, case .string(let value)? = dict["kind"] {
                kind = value
            }
            guard let action = AppUpdater.NativeUpdateActionKind(rawValue: kind) else {
                return (nil, "native-updater-unknown-kind:" + kind)
            }
            guard AppUpdater.shared.isAvailable else {
                return (nil, AppUpdater.shared.unavailableReason)
            }
            switch AppUpdater.shared.perform(action) {
            case .accepted:
                return (.object(["ok": .bool(true), "kind": .string(kind)]), nil)
            case .refused(let reason):
                print("[shell] 原生更新动作被拒绝：\(kind) → \(reason)")
                return (nil, reason)
            }
        case "focusMainWindow":
            return performUI(method: method) {
                guard let window = self.mainWindowProvider?() else {
                    return (nil, Self.uiUnavailablePrefix + method + ":no-window")
                }
                // S-32：focusMainWindow 也是恢复入口（最小化窗口先 deminiaturize）。
                MainWindowController.restoreWindow(window)
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
        // E12 open-in 原生拉起叶（launchApp）已于 2026-12 移除（S-05 复裁决）：
        // Electron 侧从未实现该叶（`electron-edges.ts:59`「launchApp moves with its
        // first consumer」），core 也零调用点；Swift 侧的实现自建 `vscode://` URL、
        // 自持 appId 白名单，等于在无人可达的路径上留一份与 core 注册表重复的决策。
        // 未知方法走默认分支 → `swift-edge-unimplemented:launchApp`，两端对称、诚实。
        case "setLoginItem":
            // E14 登录自启叶（S-D 补齐）：payload {enabled: bool}。Electron
            // 语义 = app.setLoginItemSettings({openAtLogin: enabled})（main.ts
            // applyLaunchAtLogin darwin 分支；失败 loud {error} 绝不静默假
            // 成功——设置面语义 design 14 D6）。Swift = SMAppService.mainApp
            // （macOS 14.4+；Package 声明 .macOS(.v14)、精确下限由 Info.plist
            // 的 14.4 承担 → 旧系统 NSLoginItem/SMLoginItemSetEnabled 兜底分支
            // 不可达且未实现，design 25 §5 E14 注记 / deviations T-26）。
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
        // 缺省按钮本地化：common.ok（调用方未给 buttons 时的 fallback）。
        if buttons.isEmpty { buttons = [NativeText.string(.commonOk)] }
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
            // 本地化：panel.pluginSourceTitle（title 与 message 同一句）、
            // panel.pluginSourcePrompt（按钮名）；原硬编码英文改由键表承载。
            panel.title = NativeText.string(.panelPluginSourceTitle)
            panel.prompt = NativeText.string(.panelPluginSourcePrompt)
            panel.message = NativeText.string(.panelPluginSourceTitle)
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

    // MARK: - open-in 本地拉起：无壳侧实现（S-05 复裁决，2026-12）

    // `launchApp` 的 vscode://file URL 构造与 appId 白名单随该叶一并移除：open-in 的
    // 决策（注册表、设置、可用性、URL 规则）只在 core（`open-in.ts` / `deep-link.ts`），
    // 本地目录/图标/拉起由实例内 host 包 `dsh-chamber-seed-open-in` 负责；壳只执行
    // `openExternal`（共享路径）。两端能力面因此一致：都没有 launchApp 叶。

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

/// P-06：通知 edge 回执的恰一次门——add 完成回调与有界超时竞争首个到达者，
/// 后到者取得 false（超时后晚到的成功横由调用方清除，绝不补发 shown:true）。
private final class NotificationReplyGate {
    private let lock = NSLock()
    private var finished = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !finished else { return false }
        finished = true
        return true
    }
}
