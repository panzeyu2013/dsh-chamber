//
//  ShellPerf.swift
//  DSHChamberPoc
//
//  Phase 0（《最终设计方案 v2》）：壳内启动/调用耗时的最小观测入口。
//  只做三件事：记住进程内最早的 Swift 时间点（main.swift 顶层调用
//  markProcessStart）、把任意时刻折算为相对 t0 的毫秒、生成统一格式的
//  boot 行。纯函数 + 一次性写入的静态值，无 I/O；调用点（main.swift /
//  AppDelegate / MainWindowController）只 print 或 shellLog。
//
//  与 NativeShellLog 的关系：t0 必须早于 NativeShellLog.configure（userData
//  解析在 AppDelegate 内），因此 markProcessStart 在 main.swift 顶层执行，
//  那一刻只有 stdout 可用；configure 之后各 bootLine 调用点都带 +Nms，前段
//  因此可测（普通 shellLog 行不带）。
//
import Foundation

enum ShellPerf {

    private static let lock = NSLock()
    private static var t0Storage: Date?

    /// 记录进程起点。幂等：首个调用生效（main.swift 顶层最先调用）。
    static func markProcessStart(_ date: Date = Date()) {
        lock.lock()
        if t0Storage == nil { t0Storage = date }
        lock.unlock()
    }

    /// t0（未记录时退化为首次访问时刻——单测/异常路径不崩）。
    static var t0: Date {
        lock.lock()
        defer { lock.unlock() }
        return t0Storage ?? Date()
    }

    /// 仅测试：清空 t0 记录（生产唯一写入点是 main.swift 顶层，不调用本函数）。
    static func resetForTesting() {
        lock.lock()
        t0Storage = nil
        lock.unlock()
    }

    /// 相对 t0 的毫秒（整数，四舍五入）。
    static func msSinceT0(now: Date = Date()) -> Int {
        Int((now.timeIntervalSince(t0) * 1000).rounded())
    }

    /// 统一 boot 行（stdout / NativeShellLog 共用）。
    static func bootLine(_ stage: String, now: Date = Date()) -> String {
        "[perf] boot \(stage) +\(msSinceT0(now: now))ms"
    }
}
