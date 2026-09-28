//
//  SidecarVersionContract.swift
//  DSHChamber
//
//  装配态壳版本 == sidecar package.json 版本的 fail-loud 断言（design 25
//  §3.1/§3.3(2)：ready 帧携带 shellVersion）。两侧版本同源 =
//  packages/desktop/package.json：
//    - packages/desktop/scripts/build-sidecar.mjs 把它写进装配目录
//      package.json（sidecar-entry 模块级读取后随 ready 帧上报）；
//    - macos/scripts/build-swift-app.mjs 把同一个值注入 Info.plist 的
//      CFBundleShortVersionString。
//  混合装配（旧 sidecar payload 装进新壳、或手工改包）没有构建门能发现，
//  运行期只记日志会让它带病运行——AppDelegate 的 onReady 用本判据 fatal。
//

import Foundation

/// 版本相等判据（纯函数，单测直测）。
enum SidecarVersionContract {
    /// 壳版本不可得时的哨兵（与 CrashDiagnostics.bundleVersion 同值）：
    /// dev `swift run` 无 Info.plist → 无契约可比，跳过断言。
    static let unknownShellVersion = "unknown"

    /// 版本不一致时的 fatal 文案；一致 / 壳版本不可得 → nil。
    static func mismatchMessage(shellVersion: String, sidecarVersion: String) -> String? {
        guard shellVersion != unknownShellVersion, !shellVersion.isEmpty else { return nil }
        guard sidecarVersion != shellVersion else { return nil }
        return NativeText.format(.fatalSidecarVersionMismatch, sidecarVersion, shellVersion)
    }
}
