//
//  StartupLoadRetryTests.swift
//  DSHChamberTests
//
//  T-2（2026-12 实测残留）：首载竞态的纯逻辑锁步——sidecar ready 前不导航；
//  失败后按退避重试至成功，说明页只在真正耗尽/不可重试（或 sidecar fatal）时
//  出现；并通过源码锁步钉住接线点（首载门 / 可取消重试 / fatal 停重试）。
//
import XCTest
@testable import DSHChamber

final class StartupLoadRetryTests: XCTestCase {

    private func controllerSource() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/DSHChamber/MainWindowController.swift")
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

    // MARK: - S-45：首载 HTTP 就绪探测（探测先行）

    func testProbePrecedesFirstNavigation() {
        typealias Plan = MainWindowController.StartupLoadPlan
        XCTAssertEqual(Plan.firstStep(sidecarReady: false, didStartLoading: false), .waitForSidecar,
                       "sidecar ready 前不探测也不导航")
        XCTAssertEqual(Plan.firstStep(sidecarReady: true, didStartLoading: false), .probe,
                       "S-45：ready 后的第一步必须是探测（探测先行，绝不直接导航）")
        XCTAssertEqual(Plan.firstStep(sidecarReady: true, didStartLoading: true), .alreadyStarted,
                       "首载只开工一次")
        XCTAssertEqual(Plan.outcome(afterProbeReachable: true, attempts: 0, sidecarFailed: false),
                       .navigate, "2xx 才导航")
        XCTAssertEqual(Plan.outcome(afterProbeReachable: false, attempts: 0, sidecarFailed: false),
                       .retry(after: MainWindowController.StartupLoadRetry.delay(forAttempt: 1)),
                       "探测失败走 T-2 同一退避预算")
        XCTAssertEqual(Plan.outcome(afterProbeReachable: false,
                                    attempts: MainWindowController.StartupLoadRetry.maxAttempts,
                                    sidecarFailed: false),
                       .giveUp, "预算耗尽才落失败页")
        XCTAssertEqual(Plan.outcome(afterProbeReachable: false, attempts: 0, sidecarFailed: true),
                       .giveUp, "sidecar fatal 立即放弃")
    }

    func testHealthProbeDerivesOriginHealthURLAndAcceptsOnly2xx() {
        XCTAssertEqual(MainWindowController.healthProbeURL(cpURL: URL(string: "http://localhost:17599/")!),
                       URL(string: "http://localhost:17599/health"),
                       "S-45：打包态探测 http://localhost:<port>/health")
        XCTAssertEqual(MainWindowController.healthProbeURL(
            cpURL: URL(string: "http://127.0.0.1:17500/index.html?x=1")!),
                       URL(string: "http://127.0.0.1:17500/health"),
                       "探测恒取 origin 根（与壳文档判定同源语义）")
        XCTAssertTrue(MainWindowController.isHealthyResponse(statusCode: 200))
        XCTAssertTrue(MainWindowController.isHealthyResponse(statusCode: 204))
        XCTAssertTrue(MainWindowController.isHealthyResponse(statusCode: 299))
        XCTAssertFalse(MainWindowController.isHealthyResponse(statusCode: 199))
        XCTAssertFalse(MainWindowController.isHealthyResponse(statusCode: 301))
        XCTAssertFalse(MainWindowController.isHealthyResponse(statusCode: 503))
    }

    func testHealthProbeFailureDetailKeepsDiagnosableReason() {
        let ats = NSError(domain: NSURLErrorDomain,
                          code: NSURLErrorAppTransportSecurityRequiresSecureConnection,
                          userInfo: [NSLocalizedDescriptionKey: "ATS blocked"])
        let detail = MainWindowController.healthProbeFailureDetail(statusCode: nil, error: ats)
        XCTAssertTrue(detail.contains("NSURLError -1022"),
                      "ATS 拒绝码必须进落盘日志可考古：\(detail)")
        XCTAssertEqual(MainWindowController.healthProbeFailureDetail(statusCode: 503, error: nil),
                       "HTTP 503（期望 2xx）")
    }

    func testSourceWiringKeepsReadyGateProbeFirstAndBackoffRetry() throws {
        let source = try controllerSource()
        let gate = try XCTUnwrap(
            source.range(of: "guard Self.shouldStartFirstLoad(sidecarReady: sidecarReady"),
            "首载入口必须过 ready 门")
        let probe = try XCTUnwrap(source.range(of: "beginHealthProbe()"),
                                  "S-45：首载入口必须接就绪探测")
        let navigate = try XCTUnwrap(source.range(of: "webView.load(URLRequest(url: cpURL))"),
                                     "首载导航入口必须存在")
        XCTAssertLessThan(gate.lowerBound, probe.lowerBound, "ready 门先于探测")
        XCTAssertLessThan(probe.lowerBound, navigate.lowerBound,
                          "S-45：就绪探测必须先于首载导航（探测先行）")
        XCTAssertTrue(source.contains("Self.StartupLoadPlan.outcome(afterProbeReachable:"),
                      "探测失败必须走退避决策")
        XCTAssertTrue(source.contains("scheduleNavRetry(probe: true, url: probeURL, after: delay)"),
                      "探测重试必须可取消地排定")
        XCTAssertTrue(source.contains("scheduleNavRetry(url: retryURL, after: delay)"),
                      "导航失败仍保留退避重试")
        XCTAssertTrue(source.contains("noteStartupFailure"),
                      "sidecar fatal 必须停重试并立即显示真实原因")
    }
}
