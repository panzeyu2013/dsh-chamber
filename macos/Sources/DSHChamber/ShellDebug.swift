//
//  ShellDebug.swift
//  DSHChamber
//
//  POC 调试面总开关：renderer console 回传通道/注入脚本、逐 invoke 打印、
//  /tmp/dsh-chamber-ui-snapshot.png 快照（渲染器每一行 console 被转发、每次 invoke
//  刷 stdout、写 /tmp 文件）统一经 DSH_CHAMBER_SHELL_DEBUG=1 打开，缺省关闭——
//  打包/发布壳不带调试面。
//
//  打包态即使环境里带 DSH_CHAMBER_SHELL_DEBUG=1 也必须关闭
//  ——与 AppDelegate 对 DSH_CHAMBER_SHELL_* 的装配态过滤同一判定（PackagedLayout.isAppBundle），
//  产品面不接受环境变量开启 console 回传/逐 invoke 打印//tmp 快照。
//
import Foundation

enum ShellDebug {
    static let environmentKey = "DSH_CHAMBER_SHELL_DEBUG"

    /// 打包态判定（默认按当前可执行文件；与 AppDelegate 的 isPackaged 同源）。
    static func isPackaged(executablePath: String? = Bundle.main.executableURL?.path) -> Bool {
        guard let executablePath, !executablePath.isEmpty else {
            // 路径不可得 → 保守按打包态处理（宁可不带调试面）。
            return true
        }
        return PackagedLayout.isAppBundle(executablePath: executablePath)
    }

    /// 开关判定（默认 ProcessInfo 环境；注入便于单测）。打包态恒 false。
    static func isEnabled(environment: [String: String] = ProcessInfo.processInfo.environment,
                          isPackaged: Bool? = nil) -> Bool {
        guard !(isPackaged ?? Self.isPackaged()) else { return false }
        return environment[environmentKey] == "1"
    }

    /// 生产调用点缓存：环境在进程启动后不可变、Bundle/打包态
    /// 判定同样稳定，故首次求值后复用。`isEnabled()` 每次调用都要构造
    /// `ProcessInfo.environment` 字典并做 Bundle 路径 + 打包态判定，而
    /// MainWindowController 的逐 invoke 调用点不该付这份成本。测试继续用上面
    /// 的可注入重载；本值只服务生产/诊断调用点。
    static let isEnabledCached = isEnabled()
}
