//
//  POCDebug.swift
//  DSHChamberPoc
//
//  S14（2026-12 审计）：POC 调试面总开关。renderer console 回传通道/注入脚本、
//  逐 invoke 打印、/tmp/poc-ui-snapshot.png 快照此前一律常开（渲染器每一行
//  console 都被转发、每次 invoke 都刷 stdout、发布壳还会写 /tmp 文件）。现在
//  统一经 POC_DEBUG=1 打开，缺省关闭——打包/发布壳不带调试面。
//
//  T-11（2026-12 双端逐函数核对）：打包态即使环境里带 POC_DEBUG=1 也必须关闭
//  ——与 AppDelegate 对 POC_* 的装配态过滤同一判定（PackagedLayout.isAppBundle），
//  产品面不接受环境变量开启 console 回传/逐 invoke 打印//tmp 快照。
//
import Foundation

enum POCDebug {
    static let environmentKey = "POC_DEBUG"

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
}
