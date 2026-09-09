//
//  ExternalOpenBudget.swift
//  DSHChamberPoc
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

    private var opens: [Double] = []
    private var blockedUntil: Double = 0

    public init(window: TimeInterval = 10, maxOpens: Int = 8, cooldown: TimeInterval = 30) {
        self.window = window
        self.maxOpens = maxOpens
        self.cooldown = cooldown
    }

    public enum Decision: Equatable {
        case allow
        case blocked(cooldownRemaining: TimeInterval)
    }

    /// 判定一次打开请求；`allow` 时计入本次。
    public mutating func decide(now: Double) -> Decision {
        if now < blockedUntil {
            return .blocked(cooldownRemaining: blockedUntil - now)
        }
        opens = opens.filter { now - $0 < window }
        if opens.count >= maxOpens {
            blockedUntil = now + cooldown
            opens.removeAll()
            return .blocked(cooldownRemaining: cooldown)
        }
        opens.append(now)
        return .allow
    }
}
