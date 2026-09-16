//
//  POCDebug.swift
//  DSHChamberPoc
//
//  S14（2026-12 审计）：POC 调试面总开关。renderer console 回传通道/注入脚本、
//  逐 invoke 打印、/tmp/poc-ui-snapshot.png 快照此前一律常开（渲染器每一行
//  console 都被转发、每次 invoke 都刷 stdout、发布壳还会写 /tmp 文件）。现在
//  统一经 POC_DEBUG=1 打开，缺省关闭——打包/发布壳不带调试面。
//
import Foundation

enum POCDebug {
    static let environmentKey = "POC_DEBUG"

    /// 开关判定（默认 ProcessInfo 环境；注入便于单测）。
    static func isEnabled(environment: [String: String] = ProcessInfo.processInfo.environment) -> Bool {
        environment[environmentKey] == "1"
    }
}
