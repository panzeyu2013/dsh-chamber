//
//  RendererRecovery.swift
//  DSHChamber
//
//  纯逻辑片（design 25 §5 E19、§4.5；对照 main.ts
//  installRendererRecovery:605-700）：renderer 崩溃的有界自动重载策略与
//  sidecar 就绪前的深链缓冲。
//
//  与 Electron 版的差异（有意，注释声明）：
//  - WKWebView 无 unresponsive 事件；MainWindowController 以可见页 JS/rAF
//    探针替代，与 webViewWebContentProcessDidTerminate 共用本策略的预算。
//  - Electron 用「窗口起点 + 60s 后重置计数」；本策略用 60s 滚动窗口（等价
//    上界：60s 内至多 3 次重载），实现更简且无跨窗口状态。
//

import Foundation

/// B 桥保留入站 method 名（Swift 侧单源；与 `packages/desktop/node-edges.ts`
/// `HOST_INBOUND` 逐字一致，锁步由 HostInboundMethodTests 断言）。
public enum HostInboundMethod {
    public static let hostFacts = "__host.hostFacts"
    public static let deepLink = "__host.deepLink"
    public static let rendererLifecycle = "__host.rendererLifecycle"
    public static let quitFacts = "__host.quitFacts"
    public static let notifyClicked = "__host.notifyClicked"
    public static let systemResume = "__host.systemResume"
    public static let mainWindowShown = "__host.mainWindowShown"
    /// 冻结线：Swift 壳把 Sparkle 更新阶段
    /// {phase, version, error} 报给 sidecar（sidecar 映射进页面的 update-state
    /// 投影）。payload 值域见 NativeUpdatePhase。
    public static let nativeUpdatePhase = "__host.nativeUpdatePhase"
    /// 调试模式启动回读：Swift 启动 reconcile 应用 isInspectable 后，把实测回读
    /// {enabled, inspectable, apiAvailable, reason?} 报给 sidecar（settings 投影的
    /// debugRuntime）。锁步由 HostInboundMethodTests 断言。
    public static let debugModeApplied = "__host.debugModeApplied"
}

/// renderer 崩溃重载决策（纯值逻辑，单测直测）。
public struct RendererRecoveryPolicy: Equatable {
    /// 崩溃后延迟重载（避开崩溃拆除期与 reload 的竞争；main.ts 500ms）。
    public var delay: TimeInterval
    /// 滚动窗口（main.ts 60_000ms）。
    public var window: TimeInterval
    /// 窗口内最大重载次数（main.ts reloadCount ≤ 3）。
    public var maxReloads: Int

    public init(delay: TimeInterval = 0.5, window: TimeInterval = 60, maxReloads: Int = 3) {
        self.delay = delay
        self.window = window
        self.maxReloads = maxReloads
    }

    public enum Decision: Equatable {
        case reload(after: TimeInterval, attempt: Int)
        case giveUp(attempts: Int)
    }

    /// 依据历史重载时间戳（秒）与当前时刻决策；命中 reload 时把本次计入
    /// `attempts`（窗口外旧记录自动淘汰）。
    /// 窗口淘汰 / 上限判定 / 记账 = `RollingWindowLimiter` 单源；
    /// inout 数组契约保持不变（本策略是值类型，状态由调用方持有）。
    ///
    /// 不拆分「判定 / 记账」：调用点在判定之前守卫，获准时立即排程。
    /// 主窗若在延迟重载执行前开始导航，会取消排程并退还该次计数；
    /// 已执行的重载仍占滚动窗口预算。
    public func decide(now: Double, attempts: inout [Double]) -> Decision {
        switch RollingWindowLimiter.decide(window: window, limit: maxReloads,
                                           now: now, events: &attempts) {
        case .allow(let count):
            return .reload(after: delay, attempt: count)
        case .deny:
            return .giveUp(attempts: attempts.count)
        }
    }
}

/// renderer 崩溃归因。
///
/// 崩溃落在「页面加载完成后 20–34 秒」的 boot 窗口，Apple 符号化栈是 JSC 代码块
/// 替换/JIT tier-up（入口 `JSRequestAnimationFrameCallback::invoke`）。
/// 问题是**静默**：崩溃不一定留下 shell 侧痕迹，大多表现为"应用自己回到载入历史"。
/// 把"距上次加载完成多少秒 + 本次加载窗口内第几次崩溃"写进日志，下一次发生即可
/// 直接判定，不必再靠事后推理。
public enum RendererCrashAttribution {
    /// boot 窗口上界（秒）。崩溃落在 21–34s 观测范围内；取 60s 覆盖同族形态
    /// （多来源挂载 + 插件 boot 全在同一窗口内完成）。
    public static let bootWindowSeconds: Double = 60

    /// 崩溃时刻的归因文案（纯值，单测直测）。
    /// @param secondsSinceLoad - 距上次「加载完成」的秒数；nil = 本次加载窗口内还没有
    ///   完成过加载（首次加载就崩）。
    /// @param ordinal - 本次加载窗口内的第几次崩溃（1 起）。
    public static func describe(secondsSinceLoad: Double?, ordinal: Int) -> String {
        guard let secondsSinceLoad, secondsSinceLoad >= 0 else {
            return "本次加载窗口内尚无完成的加载，第 \(ordinal) 次崩溃"
        }
        let where_ = secondsSinceLoad < bootWindowSeconds
            ? "boot 窗口内（< \(Int(bootWindowSeconds))s）"
            : "加载已稳定 \(Int(secondsSinceLoad))s"
        return String(format: "距上次加载完成 %.2fs（%@），本次加载窗口内第 %d 次崩溃", secondsSinceLoad, where_, ordinal)
    }
}

/// sidecar 就绪前的深链缓冲（design 25 §4.5：`application(_:open:)` 冷启动
/// 先于 ready 到达 → Swift 暂存，ready 后按序转交 B 桥 `__host.deepLink`；
/// 归一化去重/队列语义在 core enqueueDeepLink，本缓冲只做「就绪前不丢」）。
public struct DeepLinkBuffer {
    /// 有界容量（core 侧 pendingIntents 为 64；此处同族）。
    public let capacity: Int
    private var pending: [String] = []
    /// 因容量溢出被丢弃的最旧 URL 数（loud 上报用）。
    public private(set) var droppedCount: Int = 0

    public init(capacity: Int = 64) {
        self.capacity = capacity
    }

    public var count: Int { pending.count }

    /// 入队；满则丢最旧（与 core BoundedVscodeIntentQueue 同向）并计数。
    public mutating func enqueue(_ url: String) {
        guard !url.isEmpty else { return }
        if pending.count >= capacity {
            pending.removeFirst()
            droppedCount += 1
        }
        pending.append(url)
    }

    /// 按入队顺序取走全部（FIFO；清空缓冲）。
    public mutating func drainAll() -> [String] {
        let all = pending
        pending.removeAll()
        return all
    }
}

/// 深链转发状态机（design 25 §4.5/E13）：sidecar 未就绪 → 缓冲（有界）；
/// 就绪后按入队序补发，其后直通。`send` 由应用层注入（B 桥 invoke），
/// 缓冲/顺序/就绪语义纯逻辑可单测。
public final class DeepLinkRelay {
    public typealias Sender = (String) -> Void

    private var buffer: DeepLinkBuffer
    private let send: Sender
    public private(set) var isReady = false
    /// 因缓冲溢出被丢弃的 URL 数（loud 上报用）。
    public var droppedCount: Int { buffer.droppedCount }
    public var bufferedCount: Int { buffer.count }

    public init(capacity: Int = 64, send: @escaping Sender) {
        self.buffer = DeepLinkBuffer(capacity: capacity)
        self.send = send
    }

    /// 收到一条深链：就绪 → 立即转发；未就绪 → 缓冲（空串忽略）。
    public func enqueue(_ url: String) {
        guard !url.isEmpty else { return }
        if isReady {
            send(url)
            return
        }
        buffer.enqueue(url)
    }

    /// sidecar 重启（Supervisor 换进程）→ 只复位就绪位，**保留**缓冲：
    /// 新进程尚未收到 ready 帧，复位后到达的深链必须重新缓冲；重启前已缓冲、
    /// 尚未补发的 URL 不被清空丢弃，下一个 ready 帧按 FIFO 一并补发（复位时
    /// 清空会让用户点开的深链静默消失，droppedCount 也不计）。
    public func reset() {
        isReady = false
    }

    /// sidecar 就绪：置位并按 FIFO 补发缓冲。幂等（重复调用不重发）。
    @discardableResult
    public func markReady() -> Int {
        guard !isReady else { return 0 }
        isReady = true
        let pending = buffer.drainAll()
        for url in pending {
            send(url)
        }
        return pending.count
    }
}
