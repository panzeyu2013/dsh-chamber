//
//  RollingWindowLimiter.swift
//  DSHChamber
//
//  滚动窗口限流器：外部打开预算、sidecar 重启退避、renderer
//  重载三处共用「淘汰窗口外记录 → 计数 ≥ 上限 → 拒绝 → 否则记账」的
//  判定（ExternalOpenBudget / SidecarRestartPolicy.decide /
//  RendererRecoveryPolicy.decide）。本类型是这段判定的唯一实现。
//
//  三处的窗口/上限参数与判定顺序保持不变；「拒绝」的后果（进入冷区、放弃重试、
//  loud 上报）仍由各自策略表达——本类型只回答「这一次放不放行、窗口内第几次」。
//  语义逐条：
//    - 淘汰判据 `now - t < window`（时间相等或回拨时保留旧记录）；
//    - 计数 ≥ limit → `.deny(count:)`，**不记账**（拒绝不占配额）；
//    - 否则记账 → `.allow(count:)`，count = 记账后的窗口内计数（1 起）；
//    - limit ≤ 0 恒 deny（防御性一致）。
//
//  纯值逻辑（注入 now），单测直测（RollingWindowLimiterTests）。
//

import Foundation

/// 滚动窗口限流器（值类型：调用方持有可变实例，或经 `decide(...events:inout)`
/// 便捷入口使用调用方自己的历史数组——RendererRecoveryPolicy/SidecarRestartPolicy
/// 的既有 inout 契约由此保持）。
public struct RollingWindowLimiter: Equatable {
    /// 计数窗口（秒）。
    public let window: TimeInterval
    /// 窗口内允许的事件上限。
    public let limit: Int
    /// 窗口内历史事件时间戳（秒；升序不保证，调用方可读/可恢复）。
    public private(set) var events: [Double]

    public init(window: TimeInterval, limit: Int, events: [Double] = []) {
        self.window = window
        self.limit = limit
        self.events = events
    }

    public enum Decision: Equatable {
        /// 放行；count = 本次计入后的窗口内计数。
        case allow(count: Int)
        /// 拒绝（窗口内已达上限，本次不计入）；count = 当前窗口内计数。
        case deny(count: Int)
    }

    /// 判定一次事件；放行时把本次计入窗口。
    public mutating func record(now: Double) -> Decision {
        events = events.filter { now - $0 < window }
        if events.count >= limit {
            return .deny(count: events.count)
        }
        events.append(now)
        return .allow(count: events.count)
    }

    /// 清空窗口记录（外部打开预算进入冷却时使用；其余两处给弃权/耗尽后
    /// 保留窗口以维持原语义）。
    public mutating func reset() {
        events.removeAll()
    }

    /// 窗口内当前计数。
    public var count: Int { events.count }
}

public extension RollingWindowLimiter {
    /// 以调用方持有的历史数组判定一次事件（判定后回写数组）。
    /// 语义与实例方法 `record(now:)` 完全一致；为 inout 契约提供入口。
    static func decide(window: TimeInterval, limit: Int,
                       now: Double, events: inout [Double]) -> Decision {
        var limiter = RollingWindowLimiter(window: window, limit: limit, events: events)
        let decision = limiter.record(now: now)
        events = limiter.events
        return decision
    }
}
