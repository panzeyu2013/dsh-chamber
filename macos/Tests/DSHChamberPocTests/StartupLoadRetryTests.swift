//
//  StartupLoadRetryTests.swift
//  DSHChamberPocTests
//
//  T-2（2026-12 实测残留）：首载竞态的纯逻辑锁步——sidecar ready 前不导航；
//  失败后按退避重试至成功，说明页只在真正耗尽/不可重试（或 sidecar fatal）时
//  出现；并通过源码锁步钉住接线点（首载门 / 可取消重试 / fatal 停重试）。
//
import XCTest
@testable import DSHChamberPoc

final class StartupLoadRetryTests: XCTestCase {

    private func controllerSource() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/DSHChamberPoc/MainWindowController.swift")
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testFirstLoadWaitsForSidecarReady() {
        XCTAssertFalse(MainWindowController.shouldStartFirstLoad(sidecarReady: false,
                                                                 didStartLoading: false),
                       "sidecar ready 前绝不发起首载（打包态冷启动竞态根治点）")
        XCTAssertTrue(MainWindowController.shouldStartFirstLoad(sidecarReady: true,
                                                                didStartLoading: false))
        XCTAssertFalse(MainWindowController.shouldStartFirstLoad(sidecarReady: true,
                                                                 didStartLoading: true),
                       "首载只发一次")
    }

    func testBackoffGrowsExponentiallyAndCaps() {
        typealias Retry = MainWindowController.StartupLoadRetry
        XCTAssertEqual(Retry.delay(forAttempt: 1), 0.5, accuracy: 0.0001)
        XCTAssertEqual(Retry.delay(forAttempt: 2), 1.0, accuracy: 0.0001)
        XCTAssertEqual(Retry.delay(forAttempt: 3), 2.0, accuracy: 0.0001)
        XCTAssertEqual(Retry.delay(forAttempt: 10), 2.0, accuracy: 0.0001, "封顶 maxDelay")
        XCTAssertEqual(Retry.delay(forAttempt: 0), 0, "非法序号不产生等待")
    }

    func testFirstFailureNeverShowsFailurePageBeforeBudgetExhausted() {
        typealias Retry = MainWindowController.StartupLoadRetry
        for attempts in 0..<Retry.maxAttempts {
            guard case .retry(let after) = Retry.decision(attempts: attempts,
                                                          sidecarFailed: false) else {
                return XCTFail("第 \(attempts + 1) 次失败必须重试（说明页只在耗尽后）")
            }
            XCTAssertGreaterThan(after, 0)
        }
        XCTAssertEqual(Retry.decision(attempts: Retry.maxAttempts, sidecarFailed: false),
                       .giveUp)
    }

    func testSidecarFatalStopsRetryingImmediately() {
        XCTAssertEqual(MainWindowController.StartupLoadRetry.decision(attempts: 0,
                                                                      sidecarFailed: true),
                       .giveUp)
    }

    func testConnectionRefusedAndATSAreBothRetryableButCancelIsNot() {
        typealias Retry = MainWindowController.StartupLoadRetry
        for code in [NSURLErrorCannotConnectToHost,
                     NSURLErrorNotConnectedToInternet,
                     NSURLErrorTimedOut,
                     NSURLErrorAppTransportSecurityRequiresSecureConnection] {
            let error = NSError(domain: NSURLErrorDomain, code: code)
            XCTAssertTrue(Retry.isRetryableLoadError(error),
                          "NSURLError \(code) 属可重试（连接被拒/ATS 文案同一事实）")
        }
        XCTAssertFalse(Retry.isRetryableLoadError(
            NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)),
            "取消不是失败")
        XCTAssertFalse(Retry.isRetryableLoadError(NSError(domain: "OtherDomain", code: 1)),
                       "非 NSURLErrorDomain 不重试")
    }

    func testSourceWiringKeepsReadyGateAndBackoffRetry() throws {
        let source = try controllerSource()
        XCTAssertTrue(source.contains("guard Self.shouldStartFirstLoad(sidecarReady: sidecarReady"),
                      "首载入口必须过 ready 门")
        XCTAssertTrue(source.contains("startLoadingIfNeeded()"),
                      "ready 回调必须踢首载")
        XCTAssertTrue(source.contains("Self.StartupLoadRetry.decision(attempts: navRetries"),
                      "失败路径必须走退避决策")
        XCTAssertTrue(source.contains("scheduleNavRetry(url: retryURL, after: delay)"),
                      "重试必须可取消地排定")
        XCTAssertTrue(source.contains("noteStartupFailure"),
                      "sidecar fatal 必须停重试并立即显示真实原因")
    }
}
