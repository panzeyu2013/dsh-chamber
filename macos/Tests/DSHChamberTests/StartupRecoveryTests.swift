//
//  StartupRecoveryTests.swift
//  DSHChamberTests
//
//  启动失败恢复（C4）的纯决策与接线锁步：三选布局/按键纪律/响应映射/安全模式
//  env/重启判据/单次呈现门，以及 AppDelegate 的两处接线（fatalStartup →
//  runThreeChoiceRecovery；取锁失败先 stop() 再 fatal）。
//
import XCTest
@testable import DSHChamber

final class StartupRecoveryTests: XCTestCase {
    func testThreeChoiceAlertLayoutPutsSafeModeRestartLastAndDefault() {
        let alert = AppDelegate.makeStartupRecoveryAlert(message: "boom")
        XCTAssertEqual(alert.alertStyle, .critical)
        XCTAssertEqual(alert.informativeText, "boom")
        XCTAssertEqual(alert.buttons.count, 3)
        XCTAssertEqual(alert.buttons[AppDelegate.recoverySafeButtonIndex].keyEquivalent, "\r")
    }

    func testResponseMappingLandsSafeItemOnUnknownResponses() {
        XCTAssertEqual(AppDelegate.startupRecoveryAction(for: .alertFirstButtonReturn), .exit)
        XCTAssertEqual(AppDelegate.startupRecoveryAction(for: .alertSecondButtonReturn), .restart)
        XCTAssertEqual(AppDelegate.startupRecoveryAction(for: .alertThirdButtonReturn), .safeModeRestart)
        XCTAssertEqual(AppDelegate.startupRecoveryAction(for: .abort), .safeModeRestart)
        XCTAssertEqual(AppDelegate.startupRecoveryAction(for: .stop), .safeModeRestart)
    }

    func testSafeRecoveryKeysAreReturnKeypadEnterAndEscape() {
        XCTAssertTrue(AppDelegate.startupRecoveryKeyIsSafe(keyCode: 36))
        XCTAssertTrue(AppDelegate.startupRecoveryKeyIsSafe(keyCode: 76))
        XCTAssertTrue(AppDelegate.startupRecoveryKeyIsSafe(keyCode: 53))
        XCTAssertFalse(AppDelegate.startupRecoveryKeyIsSafe(keyCode: 0))
        XCTAssertFalse(AppDelegate.startupRecoveryKeyIsSafe(keyCode: 1))
    }

    func testSafeModeEnvOnlyLiteralOne() {
        XCTAssertEqual(AppDelegate.safeModeEnvironmentKey, "DSH_CHAMBER_SAFE_MODE")
        XCTAssertTrue(AppDelegate.isSafeModeEnabled(environment: ["DSH_CHAMBER_SAFE_MODE": "1"]))
        XCTAssertFalse(AppDelegate.isSafeModeEnabled(environment: ["DSH_CHAMBER_SAFE_MODE": "true"]))
        XCTAssertFalse(AppDelegate.isSafeModeEnabled(environment: [:]))
    }

    func testRelaunchRequiresStoppedSupervisorOrNone() {
        XCTAssertTrue(AppDelegate.canRelaunchAfterCleanup(supervisorState: nil))
        XCTAssertTrue(AppDelegate.canRelaunchAfterCleanup(supervisorState: .stopped))
        XCTAssertFalse(AppDelegate.canRelaunchAfterCleanup(supervisorState: .running))
    }

    func testRelaunchEnvironmentInjectsSafeModeOnlyWhenRequested() {
        let plain = AppDelegate.recoveryRelaunchEnvironment(base: ["PATH": "/usr/bin"], safeMode: false)
        XCTAssertNil(plain["DSH_CHAMBER_SAFE_MODE"])
        let safe = AppDelegate.recoveryRelaunchEnvironment(base: ["PATH": "/usr/bin"], safeMode: true)
        XCTAssertEqual(safe["DSH_CHAMBER_SAFE_MODE"], "1")
        XCTAssertEqual(safe["PATH"], "/usr/bin")
    }

    func testRelaunchBundleGateNeedsAppBundleAndIdentifier() {
        XCTAssertNil(AppDelegate.recoveryRelaunchBundleURL(
            bundleURL: URL(fileURLWithPath: "/tmp/dsh"), bundleIdentifier: "com.dshchamber.app"))
        XCTAssertNil(AppDelegate.recoveryRelaunchBundleURL(
            bundleURL: URL(fileURLWithPath: "/Applications/dsh.app"), bundleIdentifier: nil))
        XCTAssertNotNil(AppDelegate.recoveryRelaunchBundleURL(
            bundleURL: URL(fileURLWithPath: "/Applications/dsh.app"), bundleIdentifier: "com.dshchamber.app"))
    }

    func testRecoveryCleanupSummarySeparatesNeverLockedFromReleased() {
        let never = AppDelegate.recoveryCleanupSummary(supervisorState: nil)
        XCTAssertTrue(never.contains("未创建 supervisor"), never)
        let released = AppDelegate.recoveryCleanupSummary(supervisorState: .stopped, lockRecordPath: "/tmp/.lock")
        XCTAssertTrue(released.contains("/tmp/.lock"), released)
        let stuck = AppDelegate.recoveryCleanupSummary(supervisorState: .running)
        XCTAssertTrue(stuck.contains("绝不带锁重启"), stuck)
    }

    func testGateClaimsOnceAndDuplicateEntryNeitherPresentsNorExits() {
        let gate = AppDelegate.RecoveryPresentationGate()
        XCTAssertTrue(gate.claim())
        XCTAssertFalse(gate.claim())
        var presented = 0
        var logs: [String] = []
        let first = AppDelegate.enterRecoveryPresentation(
            message: "first", gate: gate, log: { logs.append($0) }, present: { presented += 1 })
        let second = AppDelegate.enterRecoveryPresentation(
            message: "second", gate: gate, log: { logs.append($0) }, present: { presented += 1 })
        XCTAssertFalse(first, "门已被抢：不呈现、不 exit、只记录")
        XCTAssertFalse(second)
        XCTAssertEqual(presented, 0)
        XCTAssertEqual(logs.count, 2)
    }

    func testFirstEntryPresentsOnce() {
        var presented = 0
        let claimed = AppDelegate.enterRecoveryPresentation(
            message: "boom", gate: AppDelegate.RecoveryPresentationGate(),
            log: { _ in }, present: { presented += 1 })
        XCTAssertTrue(claimed)
        XCTAssertEqual(presented, 1)
    }

    func testSpawnFailureStopsSupervisorAndReleasesLockBeforeFatal() {
        final class Probe: @unchecked Sendable { var stopped = 0; var presented = 0; var ordered: [String] = [] }
        final class ProbeSidecar: SupervisedSidecar {
            var isRunning = false
            var onTerminated: ((Int32) -> Void)?
            func start() throws { isRunning = true }
            func stop() { isRunning = false }
        }
        let probe = Probe()
        let supervisor = SidecarSupervisor(
            directoryLock: SidecarDirectoryLock(
                userDataDir: NSTemporaryDirectory() + "dsh-recovery-probe-\(UUID().uuidString)"),
            dependencies: .init(makeSidecar: { ProbeSidecar() }, log: { _ in }))
        AppDelegate.recoverFailedStartup(
            supervisor: supervisor,
            stop: { _ in probe.stopped += 1; probe.ordered.append("stop") },
            presentFatal: { probe.presented += 1; probe.ordered.append("fatal") })
        XCTAssertEqual(probe.stopped, 1)
        XCTAssertEqual(probe.presented, 1)
        XCTAssertEqual(probe.ordered, ["stop", "fatal"], "必须先停 supervisor（放 flock）再进 fatal 分流")
    }

    func testFatalStartupRoutesThroughThreeChoiceAndCleansBeforeRelaunch() throws {
        let source = try RecoveryChoicesTests.appDelegateSource()
        XCTAssertFalse(source.contains("fatalAlertShown"),
                       "绝不能留两套呈现门（单次门收敛到 RecoveryPresentationGate）")
        XCTAssertTrue(source.contains("Self.enterRecoveryPresentation(message: message)"),
                      "fatalStartup 必须经统一封装（claim → present）")
        XCTAssertTrue(source.contains("phase: .startup, choices: choices"),
                      "fatalStartup 必须走三选恢复框")
        XCTAssertTrue(source.contains("Self.recoverFailedStartup(supervisor: supervisor)"),
                      "取锁/spawn 失败必须先把局部 supervisor 停掉再 fatal")
        let stop = source.range(of: "supervisor.stop()")
        let launch = source.range(of: "NSWorkspace.shared.openApplication")
        XCTAssertNotNil(stop); XCTAssertNotNil(launch)
        if let stop, let launch {
            XCTAssertLessThan(stop.lowerBound, launch.lowerBound, "先清理（含 flock 释放）再拉起新实例")
        }
        XCTAssertTrue(source.contains("guard Self.canRelaunchAfterCleanup(supervisorState: state) else { return false }"),
                      "清理判据不成立绝不重启（绝不带锁重启/不假装成功）")
    }

}