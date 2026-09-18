//
//  CrossLanguageLockstepTests.swift
//  DSHChamberTests
//
//  S16：Swift 侧与 TS 侧必须逐值相等的常量锁步（读 TS 源文本；改一侧必须
//  同步另一侧）。数值单源在 TS（main.ts / shell-core.ts / sidecar-entry.ts），
//  Swift 是镜像——沿用 RendererRecoveryTests 的 #filePath 读源模式。
//
import XCTest
@testable import DSHChamber

final class CrossLanguageLockstepTests: XCTestCase {

    /// P-02（2026-12 二轮）：B 桥**出站**帧上限必须与入站同源常量，且 writeProtocolLine
    /// 真的读它。出站此前无上限：一个 >4 MiB 的结果帧会先把 Swift 侧 LineReader 推入
    /// 溢出重同步并 fail-closed 作废该会话全部未决请求（BridgeClient.processStdoutOutcome）。
    func testSidecarOutboundFrameLimitIsLockstep() throws {
        let edges = try source("packages/desktop/node-edges.ts")
        let entry = try source("packages/desktop/sidecar-entry.ts")
        XCTAssertNotNil(edges.range(of: "export const MAX_PROTOCOL_FRAME_BYTES = 4 * 1024 * 1024"),
                        "node-edges.ts 必须定义双向协议帧上限常量（4 MiB）")
        XCTAssertNotNil(edges.range(of: "export const MAX_INBOUND_FRAME_BYTES = MAX_PROTOCOL_FRAME_BYTES"),
                        "入站别名必须与协议常量同源（不得各自写字面量）")
        XCTAssertEqual(FrameCodec.maxFrameBytes, 4 * 1024 * 1024,
                       "Swift 侧上限必须仍是 4 MiB（锁步同一护栏）")
        // 函数体按花括号/首个顶层 } 收紧（第三轮审查 B6：通用 functionBody 会抽到下一个
        // 顶层 function，423 行的弱锚能被注释里的常量名满足）。
        guard let start = entry.range(of: "function writeProtocolLine(") else {
            return XCTFail("sidecar-entry.ts 必须保留 writeProtocolLine")
        }
        let tail = entry[start.lowerBound...]
        guard let end = tail.range(of: "\n}\n") else {
            return XCTFail("writeProtocolLine 必须以顶层 } 结束（锚点收紧失败）")
        }
        let body = String(tail[..<end.upperBound])
        XCTAssertNotNil(body.range(of: "lineBytes > MAX_PROTOCOL_FRAME_BYTES"),
                        "出站门必须按同源常量比较（精确表达式，注释不算）")
        XCTAssertNotNil(body.range(of: "line.length * 4 <= MAX_PROTOCOL_FRAME_BYTES"),
                        "快判谓词必须钉死（谓词写反会放过 >4 MiB 的多字节帧）")
        XCTAssertNotNil(body.range(of: "Buffer.byteLength(line, 'utf8')"),
                        "门必须按 UTF-8 字节数判定（与 Swift line.utf8.count 同口径）")
        XCTAssertNotNil(body.range(of: "sidecar-frame-too-large"),
                        "有 id 的超限帧必须回合法错误帧（调用方 reject，不得悬挂）")
    }

    /// #filePath = <repo>/macos/Tests/DSHChamberTests/CrossLanguageLockstepTests.swift
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

    /// 2026-12 复核（G21 文本锚）：渲染恢复的预算/门判定已迁到 shell-core.ts 的
    /// 共享常量 + 纯函数（`noteRendererReload` / `shouldScheduleHangReload` /
    /// `shouldReloadAfterCrash`；main.ts 只留计时器 glue），旧锚点 `}, 500);`、
    /// `60_000`、`reloadCount <= 3` 已不在 installRendererRecovery 体内——锚点随
    /// 单源迁移到 shell-core（否则该文件假红且 Electron 侧失去唯一文本钉）。
    func testRendererRecoveryPolicyMatchesMainTs() throws {
        let mainText = try source("packages/desktop/main.ts")
        guard let body = functionBody(mainText, named: "function installRendererRecovery") else {
            return XCTFail("main.ts 缺少 installRendererRecovery")
        }
        // main.ts 只允许留 glue：预算记账/门判定必须调 shell-core 共享纯函数。
        for anchor in ["noteRendererReload(reloadBudget, Date.now())",
                       "RENDERER_CRASH_RELOAD_DELAY_MS",
                       "RENDERER_HANG_RELOAD_DELAY_MS",
                       "shouldScheduleHangReload(loadedOnce)",
                       "shouldReloadAfterCrash(details.reason, quitRequested)"] {
            XCTAssertTrue(body.contains(anchor), "installRendererRecovery 应含 glue 锚点：\(anchor)")
        }
        // 单源：500ms 崩溃延迟 / 15s 卡死延迟 / 60s 窗口 / ≤3 次。
        let coreText = try source("packages/desktop/shell-core.ts")
        for anchor in ["export const RENDERER_CRASH_RELOAD_DELAY_MS = 500;",
                       "export const RENDERER_HANG_RELOAD_DELAY_MS = 15_000;",
                       "export const RENDERER_RECOVERY_WINDOW_MS = 60_000;",
                       "export const RENDERER_RECOVERY_MAX_RELOADS = 3;"] {
            XCTAssertTrue(coreText.contains(anchor), "shell-core 应含渲染恢复源锚点：\(anchor)")
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

    /// G12（2026-12 审计）：旧断言 AppDelegate.quitCleanupTimeout ==
    /// BridgeClient.quitCleanupGracePeriod 恒真——前者就是后者的别名（AppDelegate
    /// 里 `static let quitCleanupTimeout = BridgeClient.quitCleanupGracePeriod`），
    /// 两个值一起改错也照样通过。现在期望字面量从**两侧源码**读出：Electron
    /// （shell-core.ts 的 `QUIT_CLEANUP_TIMEOUT_MS = 5_000`）与 Swift
    /// （BridgeClient.swift 的 `quitCleanupGracePeriod: TimeInterval = 5.0`）；
    /// 先断言两侧字面量相等，再把两个 Swift 常量分别钉到这个共享字面量。
    func testQuitCleanupBudgetMatchesShellCore() throws {
        let tsText = try source("packages/desktop/shell-core.ts")
        guard let tsMatch = tsText.range(
            of: #"export const QUIT_CLEANUP_TIMEOUT_MS = ([\d_]+)"#,
            options: .regularExpression) else {
            return XCTFail("shell-core.ts 缺少 QUIT_CLEANUP_TIMEOUT_MS 字面量")
        }
        let tsLiteral = String(tsText[tsMatch])
            .components(separatedBy: "= ").last!
            .replacingOccurrences(of: "_", with: "")
        guard let tsSeconds = Double(tsLiteral).map({ $0 / 1000 }) else {
            return XCTFail("无法解析 shell-core 字面量：\(tsLiteral)")
        }

        let swiftText = try source("macos/Sources/DSHChamber/BridgeClient.swift")
        guard let swiftMatch = swiftText.range(
            of: #"quitCleanupGracePeriod: TimeInterval = ([\d.]+)"#,
            options: .regularExpression) else {
            return XCTFail("BridgeClient.swift 缺少 quitCleanupGracePeriod 字面量")
        }
        let swiftLiteral = String(swiftText[swiftMatch]).components(separatedBy: "= ").last!
        guard let swiftSeconds = Double(swiftLiteral) else {
            return XCTFail("无法解析 BridgeClient 字面量：\(swiftLiteral)")
        }

        XCTAssertEqual(swiftSeconds, tsSeconds,
                       "Swift SIGTERM 宽限字面量必须等于 shell-core 的 QUIT_CLEANUP_TIMEOUT_MS（S6）")
        XCTAssertEqual(BridgeClient.quitCleanupGracePeriod, swiftSeconds,
                       "编译出的宽限必须等于 Swift 源字面量")
        XCTAssertEqual(AppDelegate.quitCleanupTimeout, tsSeconds,
                       "terminate 硬顶必须等于共享预算字面量（G12：不得再拿它和 BridgeClient 自比）")
    }

    func testInteractiveEdgeTimeoutMatchesSidecarEntry() throws {
        let text = try source("packages/desktop/sidecar-entry.ts")
        XCTAssertTrue(text.contains("const EDGE_TIMEOUT_MS = 30_000"))
        // S2·F4：node 侧不再与 Swift 同值（同值会让 node 恒先超时，用户 10 分钟后的
        // 答案被丢弃）——node = Swift 上限 + 60s 缓冲，Swift 侧仍是 600s。
        XCTAssertTrue(text.contains("const SWIFT_INTERACTIVE_LEG_TIMEOUT_MS = 600_000"),
                      "sidecar-entry 应镜像 Swift 侧 600000ms 交互腿上限")
        XCTAssertTrue(text.contains("const INTERACTIVE_EDGE_TIMEOUT_MS = SWIFT_INTERACTIVE_LEG_TIMEOUT_MS + 60_000"),
                      "node 侧交互腿等待上限 = Swift 上限 + 60s 缓冲（S2·F4）")
        XCTAssertEqual(SwiftEdgeHostLegs.interactiveLegTimeout * 1000, 600_000,
                       "Swift 交互腿上限保持 10 分钟（S1/S2·F4）")
        XCTAssertEqual(SwiftEdgeHostLegs.uiLegTimeout, 1.0, "非交互腿保持 1s 短界")
    }

    /// S16a：60 通道冒烟清单必须迭代生成物 BridgeManifest.invokeChannels，
    /// 不得再手工转录（原 80 行静态数组删除）。
    func testSmokeListReferencesGeneratedManifest() throws {
        let text = try source("macos/Tests/DSHChamberTests/BridgeClientEdgeIntegrationTests.swift")
        XCTAssertTrue(text.contains("BridgeManifest.invokeChannels"),
                      "冒烟清单应迭代 BridgeManifest.invokeChannels")
        XCTAssertFalse(text.contains("// SSH_INSTANCES_GET"),
                       "手工转录清单必须删除（S16a）")
    }

}
