//
//  RendererRecoveryTests.swift — E19 / E13 纯逻辑片（design 25 §5 E19、§4.5）
//
//  覆盖：renderer 崩溃有界重载策略（500ms + 60s 滚动窗口 ≤3，超限 giveUp）
//  与深链缓冲/转发状态机（未就绪缓冲、就绪后 FIFO 补发、就绪后直通、
//  有界丢弃、幂等 markReady）。
import XCTest
@testable import DSHChamberPoc

final class RendererRecoveryTests: XCTestCase {

    // MARK: - RendererRecoveryPolicy

    func testRecoveryPolicyAllowsThreeReloadsThenGivesUp() {
        let policy = RendererRecoveryPolicy()
        var attempts: [Double] = []
        for expected in 1...3 {
            guard case .reload(let delay, let attempt) = policy.decide(now: Double(expected), attempts: &attempts) else {
                return XCTFail("第 \(expected) 次崩溃应重载")
            }
            XCTAssertEqual(delay, 0.5, "main.ts installRendererRecovery 同款 500ms 延迟")
            XCTAssertEqual(attempt, expected)
        }
        guard case .giveUp(let count) = policy.decide(now: 4, attempts: &attempts) else {
            return XCTFail("60s 窗口内第 4 次崩溃应停止自动恢复")
        }
        XCTAssertEqual(count, 3)
    }

    func testRecoveryPolicyWindowExpiryResetsCount() {
        let policy = RendererRecoveryPolicy()
        var attempts: [Double] = []
        _ = policy.decide(now: 0, attempts: &attempts)
        _ = policy.decide(now: 1, attempts: &attempts)
        _ = policy.decide(now: 2, attempts: &attempts)
        guard case .reload(_, let attempt) = policy.decide(now: 63, attempts: &attempts) else {
            return XCTFail("窗口过期后应重新允许重载")
        }
        XCTAssertEqual(attempt, 1)
    }

    // MARK: - DeepLinkBuffer

    func testBufferIsFIFOAndBounded() {
        var buffer = DeepLinkBuffer(capacity: 3)
        buffer.enqueue("a")
        buffer.enqueue("b")
        buffer.enqueue("c")
        buffer.enqueue("d")  // 满 → 丢最旧
        XCTAssertEqual(buffer.count, 3)
        XCTAssertEqual(buffer.droppedCount, 1)
        XCTAssertEqual(buffer.drainAll(), ["b", "c", "d"])
        XCTAssertEqual(buffer.count, 0)
        XCTAssertEqual(buffer.droppedCount, 1, "drain 不清丢弃计数（loud 上报用）")
    }

    func testBufferIgnoresEmptyUrl() {
        var buffer = DeepLinkBuffer()
        buffer.enqueue("")
        XCTAssertEqual(buffer.count, 0)
    }

    // MARK: - DeepLinkRelay

    func testRelayBuffersUntilReadyThenFlushesInOrder() {
        var sent: [String] = []
        let relay = DeepLinkRelay { sent.append($0) }
        relay.enqueue("dsh-chamber://one")
        relay.enqueue("dsh-chamber://two")
        XCTAssertTrue(sent.isEmpty, "未就绪不转发")
        XCTAssertEqual(relay.bufferedCount, 2)
        XCTAssertEqual(relay.markReady(), 2)
        XCTAssertEqual(sent, ["dsh-chamber://one", "dsh-chamber://two"], "就绪后按 FIFO 补发")
        XCTAssertTrue(relay.isReady)
    }

    func testRelaySendsDirectlyWhenReadyAndMarkReadyIsIdempotent() {
        var sent: [String] = []
        let relay = DeepLinkRelay { sent.append($0) }
        XCTAssertEqual(relay.markReady(), 0)
        relay.enqueue("dsh-chamber://hot")
        XCTAssertEqual(sent, ["dsh-chamber://hot"])
        XCTAssertEqual(relay.markReady(), 0, "重复 markReady 不重发")
        XCTAssertEqual(sent.count, 1)
    }

    func testRelayDropsOverflowAndReports() {
        var sent: [String] = []
        let relay = DeepLinkRelay(capacity: 2) { sent.append($0) }
        relay.enqueue("a")
        relay.enqueue("b")
        relay.enqueue("c")
        XCTAssertEqual(relay.droppedCount, 1)
        XCTAssertEqual(relay.markReady(), 2)
        XCTAssertEqual(sent, ["b", "c"])
    }
}

// MARK: - Swift ↔ JS 保留 method 名锁步

/// `HostInboundMethod` 与 `packages/desktop/node-edges.ts` 的 `HOST_INBOUND`
/// 逐字一致（wire 拼写漂移是跨语言静默故障——Swift 发的方法名 sidecar 不认，
/// 事件被 loud 拒绝而不是崩，故用测试钉死）。
final class HostInboundMethodTests: XCTestCase {
    private func repoRoot() -> URL {
        // #filePath = <repo>/macos/Tests/DSHChamberPocTests/HostInboundMethodTests.swift
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 {
            url.deleteLastPathComponent()
        }
        return url
    }

    func testSwiftConstantsMatchNodeEdgesSource() throws {
        let source = try String(
            contentsOf: repoRoot().appendingPathComponent("packages/desktop/node-edges.ts"),
            encoding: .utf8)
        for (name, literal) in [
            ("hostFacts", HostInboundMethod.hostFacts),
            ("deepLink", HostInboundMethod.deepLink),
            ("rendererLifecycle", HostInboundMethod.rendererLifecycle),
            ("quitFacts", HostInboundMethod.quitFacts),
            ("notifyClicked", HostInboundMethod.notifyClicked),
            ("systemResume", HostInboundMethod.systemResume),
            ("mainWindowShown", HostInboundMethod.mainWindowShown),
        ] {
            XCTAssertTrue(
                source.contains("\(name): '\(literal)'"),
                "node-edges.ts HOST_INBOUND 应含 \(name): '\(literal)'（Swift 侧单源漂移）")
        }
    }

    func testSidecarEntryWiresAllInboundSinks() throws {
        let source = try String(
            contentsOf: repoRoot().appendingPathComponent("packages/desktop/sidecar-entry.ts"),
            encoding: .utf8)
        XCTAssertTrue(
            source.contains("onDeepLink(url)") && source.contains("enqueueDeepLink(url)"),
            "sidecar-entry 应把 __host.deepLink 汇接到 core enqueueDeepLink")
        XCTAssertTrue(
            source.contains("onRendererLifecycle(event) {\n    onRendererLifecycle(event)"),
            "sidecar-entry 应把 __host.rendererLifecycle 汇接到 core onRendererLifecycle")
        XCTAssertTrue(
            source.contains("projectQuitFacts(input)") && source.contains("shouldHideToTray(")
                && source.contains("computeQuitRisk(") && source.contains("headless.quitFacts()"),
            "sidecar-entry 应用 core 纯函数合成退出决策（事实来自 headless.quitFacts()）")
    }

    /// #9：sidecar 重启 → relay 复位为「未就绪」，其间到达的深链重新缓冲，
    /// 新 sidecar ready 后按序补发（原先 isReady 不重置 → 直通并丢弃）。

    /// E19 偏离 #1 收口：giveUp 不是永久位——窗口滑出后必须重新允许重载
    /// （Electron 用「窗口起点 + 60s 重置计数」；本策略用 60s 滚动窗口等价）。
    func testGiveUpIsPerWindowNotPermanent() {
        let policy = RendererRecoveryPolicy()
        var attempts: [Double] = []
        for now in [0.0, 1, 2] {
            guard case .reload = policy.decide(now: now, attempts: &attempts) else {
                return XCTFail("窗口内前三次应重载")
            }
        }
        guard case .giveUp = policy.decide(now: 3, attempts: &attempts) else {
            return XCTFail("窗口内第 4 次应 giveUp")
        }
        // 窗口滑出（>60s）后再次崩溃 → 重新允许重载（原实现被永久放弃位挡住）。
        guard case .reload(let delay, let attempt) = policy.decide(now: 64, attempts: &attempts) else {
            return XCTFail("窗口滑出后应重新允许重载（giveUp 非永久）")
        }
        XCTAssertEqual(delay, policy.delay)
        XCTAssertEqual(attempt, 1, "窗口外的旧记录应被淘汰")
    }

    func testDeepLinkRelayResetRebuffersAfterRestart() {
        var sent: [String] = []
        let relay = DeepLinkRelay { sent.append($0) }
        relay.enqueue("a")
        XCTAssertEqual(relay.markReady(), 1)
        XCTAssertEqual(sent, ["a"])
        relay.enqueue("b")
        XCTAssertEqual(sent, ["a", "b"], "就绪后直通")

        relay.reset()
        XCTAssertFalse(relay.isReady)
        relay.enqueue("c")
        XCTAssertEqual(sent, ["a", "b"], "复位后不直通")
        XCTAssertEqual(relay.bufferedCount, 1)
        XCTAssertEqual(relay.markReady(), 1)
        XCTAssertEqual(sent, ["a", "b", "c"], "重启 ready 后补发")
        XCTAssertEqual(relay.droppedCount, 0)
    }
}
