//
//  CrossLanguageLockstepTests.swift
//  DSHChamberPocTests
//
//  S16：Swift 侧与 TS 侧必须逐值相等的常量锁步（读 TS 源文本；改一侧必须
//  同步另一侧）。数值单源在 TS（main.ts / shell-core.ts / sidecar-entry.ts），
//  Swift 是镜像——沿用 RendererRecoveryTests 的 #filePath 读源模式。
//
import XCTest
@testable import DSHChamberPoc

final class CrossLanguageLockstepTests: XCTestCase {

    /// #filePath = <repo>/macos/Tests/DSHChamberPocTests/CrossLanguageLockstepTests.swift
    private func repoRoot() -> URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOf: repoRoot().appendingPathComponent(relative), encoding: .utf8)
    }

    /// 取某顶层 function 到下一个顶层 function 之间的源文本。
    private func functionBody(_ text: String, named name: String) -> String? {
        guard let start = text.range(of: name) else { return nil }
        let rest = text[start.lowerBound...]
        let searchStart = rest.index(rest.startIndex, offsetBy: name.count)
        guard let end = rest.range(of: "\nfunction ",
                                   range: searchStart..<rest.endIndex) else {
            return String(rest)
        }
        return String(rest[..<end.lowerBound])
    }

    func testRendererRecoveryPolicyMatchesMainTs() throws {
        let text = try source("packages/desktop/main.ts")
        guard let body = functionBody(text, named: "function installRendererRecovery") else {
            return XCTFail("main.ts 缺少 installRendererRecovery")
        }
        // 500ms 延迟 / 60s 窗口 / ≤3 次（main.ts 源锚点）。
        for anchor in ["}, 500);", "60_000", "reloadCount <= 3"] {
            XCTAssertTrue(body.contains(anchor), "installRendererRecovery 应含源锚点：\(anchor)")
        }
        let policy = RendererRecoveryPolicy()
        XCTAssertEqual(policy.delay * 1000, 500, "崩溃重载延迟 500ms")
        XCTAssertEqual(policy.window, 60, "滚动窗口 60s")
        XCTAssertEqual(policy.maxReloads, 3, "窗口内 ≤3 次重载")
    }

    func testExternalOpenBudgetMatchesShellCore() throws {
        let text = try source("packages/desktop/shell-core.ts")
        for anchor in ["const OPEN_EXTERNAL_BUDGET = 8",
                       "const OPEN_EXTERNAL_WINDOW_MS = 10_000",
                       "const OPEN_EXTERNAL_COOLDOWN_MS = 30_000"] {
            XCTAssertTrue(text.contains(anchor), "shell-core 应含源锚点：\(anchor)")
        }
        let budget = ExternalOpenBudget()
        XCTAssertEqual(budget.maxOpens, 8)
        XCTAssertEqual(budget.window, 10)
        XCTAssertEqual(budget.cooldown, 30)
    }

    func testFrameSizeLimitsShareOneValue() {
        XCTAssertEqual(TrustGuard.maxMessageBytes, 4 * 1024 * 1024)
        XCTAssertEqual(FrameCodec.maxFrameBytes, TrustGuard.maxMessageBytes,
                       "A 桥信封上限与 B 桥帧上限必须同值（4 MiB）")
    }

    func testQuitCleanupBudgetMatchesShellCore() throws {
        let text = try source("packages/desktop/shell-core.ts")
        XCTAssertTrue(text.contains("export const QUIT_CLEANUP_TIMEOUT_MS = 5_000"),
                      "shell-core 退出清理预算应为 5000ms")
        XCTAssertEqual(BridgeClient.quitCleanupGracePeriod, 5.0,
                       "SIGTERM 宽限 = shell-core QUIT_CLEANUP_TIMEOUT_MS（S6）")
        XCTAssertEqual(AppDelegate.quitCleanupTimeout, BridgeClient.quitCleanupGracePeriod,
                       "terminate 硬顶与 SIGTERM 宽限单源（S6）")
    }

    func testInteractiveEdgeTimeoutMatchesSidecarEntry() throws {
        let text = try source("packages/desktop/sidecar-entry.ts")
        XCTAssertTrue(text.contains("const EDGE_TIMEOUT_MS = 30_000"))
        XCTAssertTrue(text.contains("const INTERACTIVE_EDGE_TIMEOUT_MS = 600_000"),
                      "sidecar-entry 交互腿上限应为 600000ms")
        XCTAssertEqual(SwiftEdgeHostLegs.interactiveLegTimeout * 1000, 600_000,
                       "Swift 交互腿上限必须与 node 侧 10 分钟对齐（S1）")
        XCTAssertEqual(SwiftEdgeHostLegs.uiLegTimeout, 1.0, "非交互腿保持 1s 短界")
    }

    /// S16a：60 通道冒烟清单必须迭代生成物 BridgeManifest.invokeChannels，
    /// 不得再手工转录（原 80 行静态数组删除）。
    func testSmokeListReferencesGeneratedManifest() throws {
        let text = try source("macos/Tests/DSHChamberPocTests/BridgeClientEdgeIntegrationTests.swift")
        XCTAssertTrue(text.contains("BridgeManifest.invokeChannels"),
                      "冒烟清单应迭代 BridgeManifest.invokeChannels")
        XCTAssertFalse(text.contains("// SSH_INSTANCES_GET"),
                       "手工转录清单必须删除（S16a）")
    }
}
