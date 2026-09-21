//
//  ExternalOpenBudget.swift
//  DSHChamber
//
//  外链打开预算（2026-09 二轮评审 A-P2）：镜像 shell-core.ts 的
//  `openExternally` 预算器——10s 窗口内至多 8 次，超限后 30s 冷却。
//  背景：`createWebViewWith` 新增「_blank 外链先交系统打开」后，页面可以用
//  `window.open` 连续刷外部 URL（Electron 侧一直有此预算，Swift 侧此前没有）。
//
//  纯值逻辑（注入 now），单测直测。
//

import Foundation

/// 外链打开预算器（值类型：调用方持有可变实例）。
public struct ExternalOpenBudget {
    /// 计数窗口（shell-core：10_000ms）。
    public let window: TimeInterval
    /// 窗口内最大打开次数（shell-core：8）。
    public let maxOpens: Int
    /// 超限后的冷却时长（shell-core：30_000ms）。
    public let cooldown: TimeInterval

    /// 窗口计数（2026-12 单源化：判定在 RollingWindowLimiter，冷却/清空语义留在本类型）。
    private var windowed: RollingWindowLimiter
    private var blockedUntil: Double = 0

    public init(window: TimeInterval = 10, maxOpens: Int = 8, cooldown: TimeInterval = 30) {
        self.window = window
        self.maxOpens = maxOpens
        self.cooldown = cooldown
        self.windowed = RollingWindowLimiter(window: window, limit: maxOpens)
    }

    public enum Decision: Equatable {
        case allow
        case blocked(cooldownRemaining: TimeInterval)
    }

    /// 判定一次打开请求；`allow` 时计入本次。
    /// 判定顺序与迁移前逐条一致：冷却未过 → blocked；窗口超限 → 进入冷却并
    /// 清空窗口计数；否则放行并记账。
    public mutating func decide(now: Double) -> Decision {
        if now < blockedUntil {
            return .blocked(cooldownRemaining: blockedUntil - now)
        }
        switch windowed.record(now: now) {
        case .allow:
            return .allow
        case .deny:
            blockedUntil = now + cooldown
            windowed.reset()
            return .blocked(cooldownRemaining: cooldown)
        }
    }
}
