//
//  BridgeClientFallbackTests.swift
//  DSHChamberTests
//
//  G31（2026-12 审计）：BridgeClient 的默认 edge 应答兜底绝不假成功——
//  trayAvailable/notificationSupported/badgeCountApiAvailable/mainWindowAlive/
//  webViewContentAlive 恒 true、showNativeNotification 恒成功、showMessage 恒
//  第 0 号按钮的旧表已删除；未实现一律 loud 拒绝 {ok:false,error:...}。
//  T-11：打包态子进程环境从基底与 overlay 双方剔除 DSH_CHAMBER_SHELL_*（此前基底合并会
//  把被壳过滤过的键重新泄漏给 sidecar）。
//  S-29：sidecar stderr 透传逐字保留——Swift flavor 无 Electron safeStorage
//  adapter，Electron 写的凭证文件的精确 loud 文案只经这条链到达用户。
//
import XCTest
@testable import DSHChamber

final class BridgeClientFallbackTests: XCTestCase {

    /// G31：七个曾「恒真/恒成功」的兜底方法现在必须 loud 拒绝，绝不假成功。
    func testDefaultEdgeResponseNeverClaimsUnimplementedSuccess() {
        let bridge = BridgeClient(nodePath: "/usr/bin/true", arguments: [], environment: [:])
        for method in ["trayAvailable", "notificationSupported", "badgeCountApiAvailable",
                       "mainWindowAlive", "webViewContentAlive",
                       "showNativeNotification", "showMessage"] {
            let outcome = bridge.defaultEdgeResponse(method: method, payload: nil)
            XCTAssertNil(outcome.result, "\(method) 不得假成功（旧表恒 true/0/nil）")
            XCTAssertEqual(outcome.error, "swift-edge-unimplemented:\(method)",
                           "\(method) 必须 loud 拒绝")
        }
        // 未实现方法保持既有 loud 形态。
        let unknown = bridge.defaultEdgeResponse(method: "pickPluginSource", payload: nil)
        XCTAssertNil(unknown.result)
        XCTAssertEqual(unknown.error, "swift-edge-unimplemented:pickPluginSource")
    }

    /// T-11：打包态 DSH_CHAMBER_SHELL_* 从基底与 overlay 都剔除；DSH_* / PATH 等照常保留。
    func testChildEnvironmentStripsShellOverridesWhenPackaged() {
        let base = ["DSH_CHAMBER_SHELL_DEBUG": "1",
                    "DSH_CHAMBER_SHELL_SIDECAR": "/tmp/stub.ts",
                    "DSH_CHAMBER_CP_PORT": "17500",
                    "PATH": "/usr/bin"]
        let overlay = ["ELECTRON_RUN_AS_NODE": "1", "DSH_CHAMBER_SHELL_NODE_BIN": "/tmp/node"]
        let packaged = BridgeClient.childEnvironment(base: base, overlay: overlay, isPackaged: true)
        XCTAssertEqual(packaged, ["DSH_CHAMBER_CP_PORT": "17500",
                                  "PATH": "/usr/bin",
                                  "ELECTRON_RUN_AS_NODE": "1"])
        XCTAssertNil(packaged["DSH_CHAMBER_SHELL_DEBUG"])
        XCTAssertNil(packaged["DSH_CHAMBER_SHELL_NODE_BIN"])
        let dev = BridgeClient.childEnvironment(base: base, overlay: overlay, isPackaged: false)
        XCTAssertEqual(dev["DSH_CHAMBER_SHELL_DEBUG"], "1", "dev 态照常传递 DSH_CHAMBER_SHELL_*")
        XCTAssertEqual(dev["DSH_CHAMBER_SHELL_NODE_BIN"], "/tmp/node")
        XCTAssertEqual(dev["DSH_CHAMBER_CP_PORT"], "17500")
        // 2026-12 单源化锁：壳自身 env（AppDelegate）与子进程 env（childEnvironment）
        // 共用同一过滤器——打包剔除、dev 原样。
        XCTAssertEqual(BridgeClient.filteredShellEnvironment(base: base, isPackaged: true),
                       ["DSH_CHAMBER_CP_PORT": "17500", "PATH": "/usr/bin"])
        XCTAssertEqual(BridgeClient.filteredShellEnvironment(base: base, isPackaged: false), base)
    }

    /// S-29：sidecar 的精确凭证文案逐字透传（前缀 + 原文 + 换行，无截断）。
    func testSidecarLogRelayKeepsCredentialMessageVerbatim() {
        let message = "[gateway] credentials file was written by Electron safeStorage and "
            + "cannot be decrypted by the Swift flavor; preserved as "
            + "gateway-secrets.json.corrupt — re-enter gateway credentials"
        let relayed = BridgeClient.relayedSidecarLogLine(message)
        XCTAssertTrue(relayed.hasPrefix("[sidecar] "))
        XCTAssertTrue(relayed.hasSuffix("\n"))
        XCTAssertTrue(relayed.contains(message), "完整原文必须保留（不得截断/改写）")
        XCTAssertTrue(relayed.contains("safeStorage"), "S-29 的关键词必须在最终日志里可检索")
    }
}
