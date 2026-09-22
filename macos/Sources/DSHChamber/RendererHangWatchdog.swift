//
//  RendererHangWatchdog.swift
//  DSHChamber
//
//  S-02（2026-12 复裁决）：Electron 在渲染进程 unresponsive 15s 后重载窗口；WKWebView
//  没有对应回调（只有进程终止有 webViewWebContentProcessDidTerminate），于是用「空闲时
//  周期性 ping」逼近同一语义：用户至少 15s 无键鼠输入才 ping；连续 3 次 ping 超时（每次
//  3s、间隔 5s）判定卡死；一次正常返回即清零。重载复用既有的有界恢复策略
//  （RendererRecoveryPolicy：60s 窗口 ≤3 次），卡死与崩溃共享同一预算。
//
//  S-34 首载门：didFinish 前只记录键鼠活动，不 ping、不重载。
//
//  B5（2026-12 会话链重构）：探针失败必须**记 strike**，不再当作成功。此前的接线在
//  `evaluateJavaScript` 报错时也走 noteProbeSucceeded()，于是一个**卡住但报错**的渲染器
//  可以被永久判为健康——纯逻辑这一侧原本就分不清两者，因为只有成功这一个入口。
//  现在失败有独立入口，判定器与 `LoadState`（packages/dsh-stream-state）的探针 strike
//  语义同名同义：失败累加、成功/输入清零、达上限交回调用方。
//
//  本类型是纯逻辑（注入时钟）：GUI 接线只负责定时 tick、发 ping、消费 Action。
//
import Foundation

/// 渲染器卡死的判定器（纯逻辑，无 WebKit 依赖）。
struct RendererHangWatchdog {
    /// ping 间隔（秒）。
    static let probeInterval: TimeInterval = 5
    /// 单次 ping 的超时（秒）：超过即记一次 strike。
    static let probeTimeout: TimeInterval = 3
    /// 判定卡死所需的连续超时次数。
    static let maxStrikes = 3
    /// 用户无输入的最小时间（秒）= Electron 的 15s unresponsive 阈值。
    static let idleGrace: TimeInterval = 15

    enum Action: Equatable {
        /// 什么都不做。
        case nothing
        /// 发一次 ping；调用方完成后回调 noteProbeSucceeded() 或 noteProbeFailed()。
        case probe
        /// 判定卡死 → 走有界恢复策略重载。
        case reload
    }

    private(set) var strikes = 0
    private var lastInputAt: Date
    private var lastProbeAt: Date?
    private var probeInFlightSince: Date?
    /// 首载成功门（S-34）：didFinish 前只记录键鼠活动，不 ping、不重载。
    private(set) var loadedOnce = false

    init(now: Date) {
        lastInputAt = now
    }

    /// 首次成功加载（WKNavigationDelegate.didFinish）→ 打开探测门。幂等。
    mutating func noteFirstLoadFinished() {
        loadedOnce = true
    }

    /// 键鼠输入 → 重置判定并把「空闲计时」推到现在。
    mutating func noteUserInput(at now: Date) {
        lastInputAt = now
        strikes = 0
        probeInFlightSince = nil
        lastProbeAt = nil
    }

    /// ping 正常返回 → 渲染器活着，清零。
    mutating func noteProbeSucceeded() {
        clearProbe()
    }

    /// ping **失败**（evaluateJavaScript 报错、超时、无结果）→ 记一次 strike。
    /// 与 noteProbeSucceeded() 严格对称：这是「卡住但报错」不再被误判为健康的唯一入口。
    /// 达到上限时返回 .reload（并清零，与 tick 的超时路径同一语义）。
    mutating func noteProbeFailed() -> Action {
        probeInFlightSince = nil
        strikes += 1
        guard strikes >= Self.maxStrikes else { return .nothing }
        strikes = 0
        return .reload
    }

    /// 定时 tick（调用方每 probeInterval 秒调用一次）。
    mutating func tick(now: Date) -> Action {
        // S-34 首载门：didFinish 前只记录（noteUserInput 照常更新空闲计时），绝不 ping。
        guard loadedOnce else { return .nothing }
        // 有人刚动过键鼠：不 ping、不重载。
        if now.timeIntervalSince(lastInputAt) < Self.idleGrace {
            clearProbe()
            return .nothing
        }
        // 在飞的 ping 超时 → 记一次 strike；满 3 次 → 重载（计数清零）。
        if let started = probeInFlightSince {
            guard now.timeIntervalSince(started) >= Self.probeTimeout else { return .nothing }
            return noteProbeFailed()
        }
        // 距上次 ping 不足间隔 → 等下一轮。
        if let last = lastProbeAt, now.timeIntervalSince(last) < Self.probeInterval {
            return .nothing
        }
        lastProbeAt = now
        probeInFlightSince = now
        return .probe
    }

    /// 一次「活着」的证据：清零 strike 与在飞状态。
    private mutating func clearProbe() {
        strikes = 0
        probeInFlightSince = nil
    }
}
