/**
 * P0.1（台账 §8.a）：Swift 侧更新静默看门狗 —— Sparkle 检查/下载长时间无相位变化时
 * 投一次 failed，页面不再无限停在 checking/downloading。相位转变必须取消看门狗。
 *
 * B4（2026-12 审查方向 B）：下载与检查使用**不同**的 deadline。Sparkle 没有下载
 * 进度回调，进入 downloading 后到落地前不再有任何相位变化，共用 60s 会把正常慢
 * 下载误杀成 native-update-stalled:downloading（E 的 60s 是字节 idle，S 看不到
 * 字节）。迟到的真实相位：检查被判定停滞之后，被放弃检查的结果抑制到下一次
 * checkStarted（对齐 E 的 ignoreAbandonedCheckEvents）；迟到的下载完成仍被接受
 * （E：不隐藏真实成功）。
 */
import XCTest
@testable import DSHChamber

final class UpdateStallWatchdogTests: XCTestCase {
    private var previousOnPhase: ((NativeUpdatePhaseReport) -> Void)?

    override func setUp() {
        super.setUp()
        previousOnPhase = AppUpdater.shared.onPhase
        AppUpdater.shared.resetPhaseProjectionForTesting()
        AppUpdater.shared.stallWatchdogMs = 60
        AppUpdater.shared.downloadStallWatchdogMs = 60
    }

    override func tearDown() {
        AppUpdater.shared.onPhase = previousOnPhase
        AppUpdater.shared.resetPhaseProjectionForTesting()
        AppUpdater.shared.stallWatchdogMs = 60_000
        AppUpdater.shared.downloadStallWatchdogMs = 30 * 60_000
        super.tearDown()
    }

    func testStalledCheckBecomesFailed() {
        var phases: [NativeUpdatePhase] = []
        var errors: [String] = []
        let fulfilled = expectation(description: "stalled check reports failed")
        AppUpdater.shared.onPhase = { report in
            phases.append(report.phase)
            if let error = report.error { errors.append(error) }
            if report.phase == .failed { fulfilled.fulfill() }
        }
        AppUpdater.shared.note(.checkStarted)
        wait(for: [fulfilled], timeout: 3)
        XCTAssertEqual(phases.first, .checking)
        XCTAssertEqual(phases.last, .failed, "停滞的检查必须落 failed 而不是永远 checking")
        XCTAssertEqual(errors.last?.hasPrefix("native-update-stalled:"), true)
    }

    /// B4 核心断言：进入 downloading 后即使超过**检查** deadline 也不得误判——
    /// 下载有自己显著更长的 deadline（此处用小值模拟，语义等价）。
    func testSlowDownloadIsNotMisjudgedByTheCheckDeadline() {
        AppUpdater.shared.stallWatchdogMs = 40
        AppUpdater.shared.downloadStallWatchdogMs = 10_000
        var phases: [NativeUpdatePhase] = []
        AppUpdater.shared.onPhase = { report in phases.append(report.phase) }
        AppUpdater.shared.note(.downloadWillStart(version: "9.9.9"))
        let quiet = expectation(description: "慢下载不得被检查 deadline 误杀")
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(250)) { quiet.fulfill() }
        wait(for: [quiet], timeout: 3)
        XCTAssertEqual(phases, [.downloading],
                       "正常慢下载（远超检查 deadline）绝不能被判 failed（B4）")
    }

    /// 悬挂下载仍由下载自己的 deadline 兜底（不是取消判据）。
    func testDownloadStallUsesItsOwnDeadline() {
        AppUpdater.shared.stallWatchdogMs = 10_000
        AppUpdater.shared.downloadStallWatchdogMs = 50
        var phases: [NativeUpdatePhase] = []
        var errors: [String] = []
        let failed = expectation(description: "悬挂下载按自己的 deadline 投 failed")
        AppUpdater.shared.onPhase = { report in
            phases.append(report.phase)
            if let error = report.error { errors.append(error) }
            if report.phase == .failed { failed.fulfill() }
        }
        AppUpdater.shared.note(.downloadWillStart(version: "9.9.9"))
        wait(for: [failed], timeout: 3)
        XCTAssertEqual(phases, [.downloading, .failed])
        XCTAssertEqual(errors.last, "native-update-stalled:downloading")
    }

    /// 判定之后迟到的下载完成必须被接受（E 同向：不隐藏真实成功）。
    func testLateDownloadCompletionAfterVerdictIsAccepted() {
        AppUpdater.shared.stallWatchdogMs = 10_000
        AppUpdater.shared.downloadStallWatchdogMs = 40
        var phases: [NativeUpdatePhase] = []
        let failed = expectation(description: "先投一次停滞 failed")
        AppUpdater.shared.onPhase = { report in
            phases.append(report.phase)
            if report.phase == .failed { failed.fulfill() }
        }
        AppUpdater.shared.note(.downloadWillStart(version: "9.9.9"))
        wait(for: [failed], timeout: 3)
        AppUpdater.shared.note(.downloadFinished(version: "9.9.9"))
        XCTAssertEqual(phases, [.downloading, .failed, .downloaded],
                       "迟到下载完成必须被接受（E：接受真实成功）")
    }

    /// 检查被判定停滞之后，被放弃检查的迟到结果一律抑制到下一次 checkStarted
    /// （B4 对齐 E 的 ignoreAbandonedCheckEvents）。
    func testCheckStallSuppressesLateCheckResultsUntilNextCheck() {
        AppUpdater.shared.stallWatchdogMs = 40
        var phases: [NativeUpdatePhase] = []
        let failed = expectation(description: "停滞检查先投 failed")
        AppUpdater.shared.onPhase = { report in
            phases.append(report.phase)
            if report.phase == .failed { failed.fulfill() }
        }
        AppUpdater.shared.note(.checkStarted)
        wait(for: [failed], timeout: 3)

        AppUpdater.shared.note(.validUpdate(version: "9.9.9"))
        AppUpdater.shared.note(.noUpdate)
        AppUpdater.shared.note(.checkFailed(error: "abandoned"))
        XCTAssertEqual(phases, [.checking, .failed],
                       "停滞判定后被放弃检查的迟到结果必须被抑制（B4）")

        AppUpdater.shared.note(.checkStarted)
        XCTAssertEqual(phases.last, .checking, "新一次检查复位抑制门")
        AppUpdater.shared.note(.validUpdate(version: "9.9.9"))
        XCTAssertEqual(phases.last, .available, "新检查的结果照常上报")
    }

    func testPhaseTransitionCancelsTheWatchdog() {
        var phases: [NativeUpdatePhase] = []
        AppUpdater.shared.onPhase = { report in phases.append(report.phase) }
        AppUpdater.shared.note(.checkStarted)
        AppUpdater.shared.note(.validUpdate(version: "9.9.9"))
        let idle = expectation(description: "no late failure")
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(200)) { idle.fulfill() }
        wait(for: [idle], timeout: 3)
        XCTAssertEqual(phases, [.checking, .available], "相位已前进时看门狗必须被取消")
    }
}
