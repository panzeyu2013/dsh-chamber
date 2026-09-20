//
//  QuitCoordinator.swift
//  DSHChamber
//
//  E1/E9/E20 纯逻辑片（design 25 §5 三行 + §3.3(4) 退出链；wire =
//  `__host.quitFacts`）。职责边界：
//   - 决策**单源在 core**（chamber-settings 的 shouldHideToTray / computeQuitRisk
//     由 sidecar 依据 chamber settings + LOCAL_RUNNING_STATES × localProcessAlive
//     合成）——Swift 只解码决策并执行宿主动作，绝不复制判据；
//   - 本文件只放可单测的纯逻辑：决策解码、关窗动作映射、确认文案、
//     退出单飞/已确认门（AppKit 回调可重入，语义照搬 main.ts
//     quitRequested / quitConfirmed / confirmingQuit 三标志）。
//

import Foundation

/// 主窗关闭决策委托（AppDelegate 实现：隐藏 / 转入退出链 / 放行）。
/// `windowShouldClose` 返回 false 表示本次关闭已被接管（隐藏或异步转退出）。
protocol MainWindowCloseDeciding: AnyObject {
    func handleWindowCloseRequest() -> Bool
}

/// `__host.quitFacts` 的决策投影（core → Swift）。
public struct QuitFacts: Equatable {
    /// 关窗是否隐藏（close-behavior='hide-to-tray' 且存在恢复入口且非退出在途）。
    public var hideOnClose: Bool
    /// 退出是否需要用户确认（本地实例在跑且确认开关开启）。
    public var quitNeedsConfirm: Bool
    /// 确认原因（本地化文案片段，core 侧生成）。
    public var quitReasons: [String]

    public init(hideOnClose: Bool, quitNeedsConfirm: Bool, quitReasons: [String]) {
        self.hideOnClose = hideOnClose
        self.quitNeedsConfirm = quitNeedsConfirm
        self.quitReasons = quitReasons
    }

    /// 从 B 桥 result 解码；形状不符 → nil（调用方走保守路径：不退出/不关窗）。
    public static func decode(_ value: AnyCodable?) -> QuitFacts? {
        guard case .object(let object)? = value,
              case .bool(let hideOnClose)? = object["hideOnClose"],
              case .bool(let needsConfirm)? = object["quitNeedsConfirm"] else {
            return nil
        }
        var reasons: [String] = []
        if case .array(let list)? = object["quitReasons"] {
            for item in list {
                if case .string(let text) = item { reasons.append(text) }
            }
        }
        return QuitFacts(hideOnClose: hideOnClose, quitNeedsConfirm: needsConfirm, quitReasons: reasons)
    }
}

/// 关窗决策缓存（D1 修复，2026-09 评审）。
///
/// 缺陷：`requestQuitFacts` 曾把**任何**成功应答都写进缓存，而退出链以
/// `quitRequested=true` 请求，其投影里 `hideOnClose` 按定义恒 false
/// （`chamber-settings.ts` 的 `shouldHideToTray` 直接取该参数）。于是一次被取消的
/// 退出（确认框「取消」/ S-17「继续等待」）之后，缓存里躺着的是退出语境的决定，
/// 下一次红点/Cmd+W 关窗命中缓存即走 `NSApp.terminate`，日志还会打印与设置矛盾
/// 的 close-behavior='quit'。
///
/// 两条不变量：
///  1. **只有 close 语境（`quitRequested=false`）的应答可入缓存**——缓存值的语义
///     就是「关窗该做什么」；
///  2. **应答必须仍属当前世代**——设置变更 / sidecar 重启时世代自增并清空，
///     失效之前在途的应答落地即被丢弃，旧设置不得回填（S3·V9 的即时决策不受
///     影响：close 语境的刷新照旧写缓存）。
///
/// 主线程所有：请求发起、应答落地、设置变更失效都在主线程（见 AppDelegate 的
/// `requestQuitFacts` / `onSettingsChanged` / `handleSidecarReady`），故无需加锁
/// （值语义 struct）。
public struct QuitFactsCache {
    private var epoch = 0
    private var facts: QuitFacts?

    public init() {}

    /// 当前世代号：请求发起时捕获，应答落地时比对。
    public var token: Int { epoch }

    /// 缓存里的 close 语境决定（无 → nil，调用方走一次异步请求）。
    public func current() -> QuitFacts? { facts }

    /// 失效（设置变更 / 新 sidecar ready）：世代自增并清空。
    public mutating func invalidate() {
        epoch += 1
        facts = nil
    }

    /// 尝试写入：仅接受 close 语境且世代未失效的应答。
    /// - Returns: true = 已写入；false = 丢弃（quit 语境 / 跨世代）。
    @discardableResult
    public mutating func store(_ incoming: QuitFacts, requestToken: Int, closeContext: Bool) -> Bool {
        guard closeContext, requestToken == epoch else { return false }
        facts = incoming
        return true
    }
}

/// 关窗/退出动作映射与文案（纯函数，单测直测）。
public enum QuitCoordinator {
    /// 关窗动作：隐藏（Dock 常驻恢复入口）或转入完整退出链。
    public enum CloseAction: Equatable {
        case hide
        case terminate
    }

    public static func closeAction(facts: QuitFacts) -> CloseAction {
        facts.hideOnClose ? .hide : .terminate
    }

    /// 确认框正文（main.ts before-quit 逐字：`退出将停止${reasons.join('与')}。确定退出？`）。
    public static func confirmDetail(reasons: [String]) -> String {
        "退出将停止\(reasons.joined(separator: "与"))。确定退出？"
    }

    /// 退出决策不可得（`__host.quitFacts` 超时/调用失败/解码失败）时的动作
    /// （S-17：sidecar 挂死绝不静默取消 Cmd+Q）。
    public enum UnavailableAction: Equatable {
        /// sidecar 仍在运行：可能有本地保护内容 → 提示用户后取消本轮退出。
        case alertThenCancel
        /// sidecar 未运行：无本地保护内容 → 放行退出（main.ts cp===null 同向）。
        case proceed
    }

    /// 决策不可得的动作映射（纯函数：超时 → 提示；sidecar 已停 → 放行）。
    /// `sidecarLive` = supervisor 正在运行/重启中，与原保守分支判据逐字一致。
    public static func unavailableAction(sidecarLive: Bool) -> UnavailableAction {
        sidecarLive ? .alertThenCancel : .proceed
    }

    /// S-17 提示框文案与按钮：sidecar 未在预算内应答退出决策。
    /// 默认（Enter）落在安全项「继续等待」；「强制退出」走既有清理链。
    public enum UnavailableAlert {
        public static let messageText = "dsh sidecar 未响应退出请求"
        public static let informativeText =
            "dsh sidecar 未在 2 秒内应答退出决策，本次退出已取消。"
            + "可以继续等待 sidecar 恢复，或强制退出（强制退出仍会执行既有清理）。"
        public static let waitButtonTitle = "继续等待"
        public static let forceButtonTitle = "强制退出"
    }
}

/// 退出单飞/确认门（线程安全；AppKit 的 applicationShouldTerminate /
/// windowShouldClose 可重入，且事实请求是异步的）。
public final class QuitGate {
    private let lock = NSLock()
    private var decisionInFlight = false
    private var confirming = false
    private var confirmed = false

    public init() {}

    /// 已确认退出（退出在途：关窗放行、不再重复确认）。
    public var isConfirmed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return confirmed
    }

    /// 进入决策请求（单飞）；已在决策/确认中 → false（调用方保守处理）。
    public func beginDecision() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !decisionInFlight, !confirming, !confirmed else { return false }
        decisionInFlight = true
        return true
    }

    public func endDecision() {
        lock.lock()
        decisionInFlight = false
        lock.unlock()
    }

    /// 进入确认对话框（单飞）。
    public func beginConfirm() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !confirming, !confirmed else { return false }
        confirming = true
        return true
    }

    public func endConfirm() {
        lock.lock()
        confirming = false
        lock.unlock()
    }

    public func markConfirmed() {
        lock.lock()
        confirmed = true
        confirming = false
        decisionInFlight = false
        lock.unlock()
    }
}
