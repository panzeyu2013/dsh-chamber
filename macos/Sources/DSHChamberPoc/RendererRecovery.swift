//
//  RendererRecovery.swift
//  DSHChamberPoc
//
//  W-21/E19 纯逻辑片（design 25 §5 E19、§4.5；对照 main.ts
//  installRendererRecovery:605-700）：renderer 崩溃的有界自动重载策略与
//  sidecar 就绪前的深链缓冲。
//
//  与 Electron 版的差异（有意，注释声明）：
//  - 15s unresponsive 探测腿不可移植（WKWebView 无 unresponsive 事件，
//    design 25 §0.1-B5/D5 已登记）——本策略只覆盖
//    webViewWebContentProcessDidTerminate（render-process-gone 对应）。
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
    public func decide(now: Double, attempts: inout [Double]) -> Decision {
        attempts = attempts.filter { now - $0 < window }
        if attempts.count >= maxReloads {
            return .giveUp(attempts: attempts.count)
        }
        attempts.append(now)
        return .reload(after: delay, attempt: attempts.count)
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

    /// sidecar 重启（W-15 Supervisor 换进程）→ 复位就绪位并清空缓冲：
    /// 新进程尚未收到 ready 帧，此时到达的深链必须重新缓冲，否则会被
    /// 直通发送给一个还没装配的 sidecar 并丢弃（2026-09 三审 #9）。
    public func reset() {
        isReady = false
        _ = buffer.drainAll()
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
