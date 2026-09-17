//
//  RendererHangWatchdog.swift
//  DSHChamberPoc
//
//  S-02（2026-12 复裁决）：Electron 在渲染进程 `unresponsive` 15s 后重载窗口；
//  WKWebView 没有对应回调（只有「进程终止」有 webViewWebContentProcessDidTerminate），
//  于是用「空闲时周期性 ping」逼近同一语义：
//
//    - 只有用户**至少 15s 没有键鼠输入**时才 ping（绝不打断正在输入的人，
//      也避免丢弃未提交的编辑态）；
//    - 连续 3 次 ping 超时（每次 3s、间隔 5s，累计 ≈15s+）才判定卡死；
//    - 一次正常返回即清零（hiccup 不累积）。
//
//  重载本身复用既有的有界恢复策略（RendererRecoveryPolicy：60s 窗口内 ≤3 次，
//  与 Electron main.ts installRendererRecovery 同参数）——卡死重载与崩溃重载
//  共享同一份预算，不会互相绕过对方的限流。
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
        /// 发一次 ping；调用方完成后回调 noteProbeSucceeded()。
        case probe
        /// 判定卡死 → 走有界恢复策略重载。
        case reload
    }

    private(set) var strikes = 0
    private var lastInputAt: Date
    private var lastProbeAt: Date?
    private var probeInFlightSince: Date?
    /// 首载成功门（S-34）：与 Electron main.ts 的 loadedOnce 同义——didFinish 前
    /// 只记录键鼠活动，**不 ping、不重载**（建窗到控制面就绪期间的白屏加载不得
    /// 被误判卡死）。
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
        strikes = 0
        probeInFlightSince = nil
    }

    /// 定时 tick（调用方每 probeInterval 秒调用一次）。
    mutating func tick(now: Date) -> Action {
        // S-34 首载门：didFinish 前只记录（noteUserInput 照常更新空闲计时），
        // 绝不 ping/重载——strike 语义在门打开后原样保留。
        guard loadedOnce else { return .nothing }
        // 有人刚动过键鼠：不 ping、不重载。
        if now.timeIntervalSince(lastInputAt) < Self.idleGrace {
            strikes = 0
            probeInFlightSince = nil
            lastProbeAt = nil
            return .nothing
        }
        // 在飞的 ping 超时 → 记一次 strike；满 3 次 → 重载（计数清零）。
        if let started = probeInFlightSince {
            guard now.timeIntervalSince(started) >= Self.probeTimeout else { return .nothing }
            probeInFlightSince = nil
            strikes += 1
            if strikes >= Self.maxStrikes {
                strikes = 0
                return .reload
            }
            return .nothing
        }
        // 距上次 ping 不足间隔 → 等下一轮。
        if let last = lastProbeAt, now.timeIntervalSince(last) < Self.probeInterval {
            return .nothing
        }
        lastProbeAt = now
        probeInFlightSince = now
        return .probe
    }
}
