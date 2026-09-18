//
//  BridgeClientStopGraceTests.swift
//  DSHChamberTests
//
//  S6：stop() 的 SIGTERM 宽限必须对齐 shell-core 的 5s 清理预算——旧 2s 会在
//  sidecar 仍在回收本地 dsh/ssh 子进程时 SIGKILL，留下孤儿。真实子进程
//  (/bin/sh 忽略 SIGTERM) 量测：宽限内保持存活、随后 SIGKILL 收尸。
//
import XCTest
@testable import DSHChamber

final class BridgeClientStopGraceTests: XCTestCase {

    func testStopWaitsGracePeriodBeforeSigkill() throws {
        let bridge = BridgeClient(
            nodePath: "/bin/sh",
            arguments: ["-c", "trap '' TERM; while true; do sleep 1; done"],
            environment: [:])
        try bridge.start()
        XCTAssertTrue(bridge.isRunning)
        // 给 /bin/sh 时间装上 trap（启动后立刻发信号会撞在 trap 生效前，
        // 进程会按默认动作死于 SIGTERM）。
        Thread.sleep(forTimeInterval: 0.3)

        let started = Date()
        bridge.stop()
        let elapsed = Date().timeIntervalSince(started)

        XCTAssertFalse(bridge.isRunning, "stop() 必须同步收尸")
        XCTAssertEqual(bridge.lastTerminationStatus, 9,
                       "忽略 SIGTERM 的子进程最终以 SIGKILL 收尾（status=9）")
        // 绝对下界（不随常量缩放）：文档化预算是 5s，SIGKILL 不得早于 4.5s。
        // 2026-12 验证轮：原断言用同一常量做下界，把常量改回 2.0 仍然通过。
        XCTAssertGreaterThanOrEqual(elapsed, 4.5,
                                    "SIGKILL 不得早于文档化的 5s 清理预算（S6；绝对下界）")
        XCTAssertEqual(BridgeClient.quitCleanupGracePeriod, 5.0, accuracy: 0.0001,
                       "宽限常量必须等于 shell-core 的 QUIT_CLEANUP_TIMEOUT_MS（5s）")
    }
}
