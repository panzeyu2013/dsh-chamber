//
//  SidecarSupervisorTests.swift — W-15（design 25 §3.3(1)(4)/§6.3）
//
//  覆盖：目录锁（flock 独占 / 记录 / no-follow / 规整文件 / 释放重取）、
//  重启退避策略（500ms + 60s 滚动窗口 ≤3）、Supervisor 生命周期
//  （启动 / 崩溃重启 / 退出码分级 0|3 / 重启耗尽 fatal / stop 后迟到调度作废 /
//  spawn 失败 fatal）。状态机分支用假进程注入 + 可手工触发的调度闭包；G11 另有
//  一例用**真实 BridgeClient**（/bin/sh 子进程、无桩进程）钉住
//  onTerminated → Supervisor 的生产接线。无 GUI。
import XCTest
@testable import DSHChamber

/// 假 sidecar 进程（可注入 start 失败、手工触发终止）。
private final class FakeSidecar: SupervisedSidecar {
    var isRunning = false
    var onTerminated: ((Int32) -> Void)?
    private(set) var startCount = 0
    private(set) var stopCount = 0
    var startError: Error?

    /// 启动期间钩子（模拟「进程在 launch 提交前就退出」/「stop 在启动期间到达」）。
    var duringStart: (() -> Void)?

    func start() throws {
        if let startError { throw startError }
        startCount += 1
        isRunning = true
        duringStart?()
    }

    func stop() {
        stopCount += 1
        isRunning = false
    }

    /// 模拟自然终止（崩溃/自行退出）；stop() 后不再回调（与 BridgeClient 同契约）。
    func terminate(status: Int32) {
        isRunning = false
        onTerminated?(status)
    }
}

private struct FakeError: Error, LocalizedError {
    var errorDescription: String? { "fake spawn failure" }
}

/// G11：跨线程记录 Supervisor 排定闭包（真实 BridgeClient 的终止回调在
/// Foundation 队列，闭包追加与断言线程读取必须互斥）。
private final class ScheduledRecorder {
    private let lock = NSLock()
    private var work: [() -> Void] = []

    func append(_ closure: @escaping () -> Void) {
        lock.lock()
        work.append(closure)
        lock.unlock()
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return work.count
    }

    var snapshot: [() -> Void] {
        lock.lock()
        defer { lock.unlock() }
        return work
    }
}

final class SidecarSupervisorTests: XCTestCase {

    private var tempDirs: [String] = []

    override func tearDown() {
        for dir in tempDirs {
            try? FileManager.default.removeItem(atPath: dir)
        }
        tempDirs = []
        super.tearDown()
    }

    private func makeTempDir() -> String {
        let dir = (NSTemporaryDirectory() as NSString)
            .appendingPathComponent("dsh-supervisor-test-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        tempDirs.append(dir)
        return dir
    }

    // MARK: - 目录锁

    func testDirectoryLockWritesRecordAndBlocksSecondHolder() throws {
        let dir = makeTempDir()
        let lock = SidecarDirectoryLock(userDataDir: dir)
        XCTAssertFalse(lock.isHeld)
        try lock.acquire()
        XCTAssertTrue(lock.isHeld)

        let record = SidecarDirectoryLock.readRecord(at: lock.recordPath)
        XCTAssertEqual(record?.pid, getpid(), "记录 pid 应为当前进程（sidecar-entry 复验判据）")
        XCTAssertEqual(record?.shell, "swift")
        XCTAssertGreaterThan(record?.startedAt ?? 0, 0)

        // 同进程第二个锁对象（独立 open 描述符）必须被 flock 挡住。
        let second = SidecarDirectoryLock(userDataDir: dir)
        XCTAssertThrowsError(try second.acquire()) { error in
            guard case .heldByAnotherProcess(let pid) = error as? SidecarDirectoryLock.LockError else {
                return XCTFail("应为 heldByAnotherProcess，实际 \(error)")
            }
            XCTAssertEqual(pid, getpid())
        }
        XCTAssertFalse(second.isHeld)

        // 释放后可重取（同进程）。
        lock.release()
        XCTAssertFalse(lock.isHeld)
        XCTAssertNoThrow(try second.acquire())
        second.release()
    }

    func testDirectoryLockRejectsSymlink() throws {
        let dir = makeTempDir()
        let target = (dir as NSString).appendingPathComponent("target")
        FileManager.default.createFile(atPath: target, contents: Data())
        let lock = SidecarDirectoryLock(userDataDir: dir)
        // 锁路径换成符号链接 → O_NOFOLLOW fail-closed。
        try FileManager.default.createSymbolicLink(
            atPath: lock.recordPath, withDestinationPath: target)
        XCTAssertThrowsError(try lock.acquire()) { error in
            guard case .ioFailure = error as? SidecarDirectoryLock.LockError else {
                return XCTFail("符号链接应 fail-closed（ioFailure），实际 \(error)")
            }
        }
        XCTAssertFalse(lock.isHeld)
    }

    func testDirectoryLockRejectsNonRegularFile() throws {
        let dir = makeTempDir()
        let lock = SidecarDirectoryLock(userDataDir: dir)
        guard mkfifo(lock.recordPath, 0o600) == 0 else {
            throw XCTSkip("mkfifo 不可用")
        }
        XCTAssertThrowsError(try lock.acquire()) { error in
            guard case .ioFailure(let detail) = error as? SidecarDirectoryLock.LockError else {
                return XCTFail("非规整文件应 fail-closed，实际 \(error)")
            }
            XCTAssertTrue(detail.contains("非规整文件"), detail)
        }
    }

    // MARK: - 退避策略

    func testRestartPolicyAllowsThreeThenGivesUpWithinWindow() {
        let policy = SidecarRestartPolicy()
        var attempts: [Double] = []
        for expected in 1...3 {
            guard case .restart(let delay, let attempt) = policy.decide(now: Double(expected), attempts: &attempts) else {
                return XCTFail("第 \(expected) 次应排定重启")
            }
            XCTAssertEqual(delay, 0.5)
            XCTAssertEqual(attempt, expected)
        }
        guard case .giveUp(let count) = policy.decide(now: 4, attempts: &attempts) else {
            return XCTFail("窗口内第 4 次应 giveUp")
        }
        XCTAssertEqual(count, 3)
    }

    func testRestartPolicyWindowExpiryAllowsNewAttempts() {
        let policy = SidecarRestartPolicy()
        var attempts: [Double] = []
        _ = policy.decide(now: 0, attempts: &attempts)
        _ = policy.decide(now: 1, attempts: &attempts)
        _ = policy.decide(now: 2, attempts: &attempts)
        // 60s 滚动窗口外（now - ts >= 60）旧记录淘汰 → 重新计数。
        guard case .restart(_, let attempt) = policy.decide(now: 63, attempts: &attempts) else {
            return XCTFail("窗口过期后应重新允许重启")
        }
        XCTAssertEqual(attempt, 1)
        XCTAssertEqual(attempts, [63])
    }

    // MARK: - Supervisor

    private func makeSupervisor(
        dir: String,
        sidecar: FakeSidecar,
        fatalMessages: NSMutableArray = NSMutableArray()
    ) -> (SidecarSupervisor, () -> [() -> Void]) {
        var scheduled: [() -> Void] = []
        let supervisor = SidecarSupervisor(
            directoryLock: SidecarDirectoryLock(userDataDir: dir),
            dependencies: .init(
                makeSidecar: { sidecar },
                schedule: { _, work in scheduled.append(work) },
                log: { _ in },
                onFatal: { message in fatalMessages.add(message) }))
        return (supervisor, { scheduled })
    }

    func testStartRunsSidecarAndHoldsLock() throws {
        let dir = makeTempDir()
        let sidecar = FakeSidecar()
        let (supervisor, _) = makeSupervisor(dir: dir, sidecar: sidecar)
        XCTAssertEqual(try supervisor.start(), .running)
        XCTAssertEqual(sidecar.startCount, 1)
        XCTAssertTrue(sidecar.isRunning)
        XCTAssertTrue(supervisor.directoryLock.isHeld)
        supervisor.stop()
        XCTAssertEqual(sidecar.stopCount, 1)
        XCTAssertFalse(supervisor.directoryLock.isHeld)
        XCTAssertEqual(supervisor.state, .stopped)
    }

    func testSpawnFailureIsFatalAndThrows() {
        let dir = makeTempDir()
        let sidecar = FakeSidecar()
        sidecar.startError = FakeError()
        let fatal = NSMutableArray()
        let (supervisor, scheduled) = makeSupervisor(dir: dir, sidecar: sidecar, fatalMessages: fatal)
        XCTAssertThrowsError(try supervisor.start())
        XCTAssertEqual(supervisor.state, .fatal)
        XCTAssertEqual(fatal.count, 1)
        XCTAssertTrue(scheduled().isEmpty, "spawn 失败不排定重启")
        XCTAssertTrue(supervisor.directoryLock.isHeld, "锁已取，由 stop() 释放")
        supervisor.stop()
        XCTAssertFalse(supervisor.directoryLock.isHeld)
    }

    /// 第三轮验证 F4a：code 6（生命周期过渡）是**可重试**过渡态——用户态 start 抛错但
    /// **绝不** markFatal（否则退出期「重启调度 vs stop()」竞态会弹致命告警）。
    func testLifecycleBusyStartIsRetryableNotFatal() {
        let dir = makeTempDir()
        let sidecar = FakeSidecar()
        sidecar.startError = NSError(domain: "BridgeClient",
                                     code: BridgeClient.errorCodeLifecycleBusy,
                                     userInfo: [NSLocalizedDescriptionKey: "busy"])
        let fatal = NSMutableArray()
        let (supervisor, scheduled) = makeSupervisor(dir: dir, sidecar: sidecar, fatalMessages: fatal)
        XCTAssertThrowsError(try supervisor.start())
        XCTAssertEqual(fatal.count, 0, "code 6 不得 fatal")
        XCTAssertNotEqual(supervisor.state, .fatal)
        XCTAssertTrue(scheduled().isEmpty)
        supervisor.stop()
    }

    /// 第三轮验证 RISK：code 6 重试耗尽必须升格 fatal——绝不静默停在 .restarting
    /// （此前既不 fatal 也不再排程，自动恢复名存实亡）。
    func testLifecycleBusyRestartExhaustionBecomesFatal() throws {
        let dir = makeTempDir()
        let sidecar = FakeSidecar()
        let fatal = NSMutableArray()
        let (supervisor, scheduled) = makeSupervisor(dir: dir, sidecar: sidecar, fatalMessages: fatal)
        try supervisor.start()
        sidecar.startError = NSError(domain: "BridgeClient",
                                     code: BridgeClient.errorCodeLifecycleBusy,
                                     userInfo: [NSLocalizedDescriptionKey: "busy"])
        sidecar.terminate(status: 1)                  // 崩溃 → 排定重启
        XCTAssertEqual(supervisor.state, .restarting)
        XCTAssertEqual(scheduled().count, 1)
        scheduled()[0]()                              // 第 1 次：code 6 → 排定重试
        XCTAssertEqual(scheduled().count, 2)
        scheduled()[1]()                              // 第 2 次
        XCTAssertEqual(scheduled().count, 3)
        scheduled()[2]()                              // 第 3 次
        XCTAssertEqual(scheduled().count, 4)
        scheduled()[3]()                              // 第 4 次：耗尽 → fatal
        XCTAssertEqual(fatal.count, 1, "重试耗尽必须 fatal（不得静默停 .restarting）")
        XCTAssertEqual(supervisor.state, .fatal)
        supervisor.stop()
    }

    func testCrashSchedulesBackoffRestartAndRelaunches() throws {
        let dir = makeTempDir()
        let sidecar = FakeSidecar()
        let fatal = NSMutableArray()
        let (supervisor, scheduled) = makeSupervisor(dir: dir, sidecar: sidecar, fatalMessages: fatal)
        try supervisor.start()
        sidecar.terminate(status: 1)
        XCTAssertEqual(supervisor.state, .restarting)
        XCTAssertEqual(scheduled().count, 1, "崩溃应排定一次重启")
        XCTAssertEqual(fatal.count, 0, "首次崩溃不应 fatal")
        scheduled()[0]()
        XCTAssertEqual(supervisor.state, .running)
        XCTAssertEqual(sidecar.startCount, 2)
        supervisor.stop()
    }

    func testCleanExitZeroDoesNotRestart() throws {
        let dir = makeTempDir()
        let sidecar = FakeSidecar()
        let fatal = NSMutableArray()
        let (supervisor, scheduled) = makeSupervisor(dir: dir, sidecar: sidecar, fatalMessages: fatal)
        try supervisor.start()
        sidecar.terminate(status: 0)
        XCTAssertEqual(supervisor.state, .stopped)
        XCTAssertTrue(scheduled().isEmpty, "exit=0 自行优雅退出不重启")
        XCTAssertEqual(fatal.count, 0)
        supervisor.stop()
    }

    /// S2·F11（2026-12 双端逐函数核对）：非崩溃退出（0/3/70）不得消耗崩溃退避
    /// 配额——原来的 decide 在退出码分级之前无条件调用，几次正常退出就把「60s 内
    /// 3 次」用光，用户随后第一次真实崩溃立刻 giveUp（自动恢复名存实亡）。
    func testNonCrashExitsDoNotConsumeCrashBackoffQuota() throws {
        let dir = makeTempDir()
        let sidecar = FakeSidecar()
        let fatal = NSMutableArray()
        let (supervisor, scheduled) = makeSupervisor(dir: dir, sidecar: sidecar, fatalMessages: fatal)
        // 三轮「正常退出」：每轮重新 start（exit=0 后 supervisor 停在 .stopped）。
        for _ in 0..<3 {
            try supervisor.start()
            sidecar.terminate(status: 0)
            XCTAssertEqual(supervisor.state, .stopped)
        }
        XCTAssertEqual(fatal.count, 0)
        // 第一次真实崩溃：配额必须仍然完整 → 排定重启，而不是直接 fatal。
        try supervisor.start()
        sidecar.terminate(status: 1)
        XCTAssertEqual(supervisor.state, .restarting, "正常退出不得预支崩溃退避配额")
        XCTAssertEqual(scheduled().count, 1)
        XCTAssertEqual(fatal.count, 0)
        supervisor.stop()
    }

    func testLockConflictExitThreeIsFatalWithoutRestart() throws {
        let dir = makeTempDir()
        let sidecar = FakeSidecar()
        let fatal = NSMutableArray()
        let (supervisor, scheduled) = makeSupervisor(dir: dir, sidecar: sidecar, fatalMessages: fatal)
        try supervisor.start()
        sidecar.terminate(status: 3)
        XCTAssertEqual(supervisor.state, .fatal)
        XCTAssertEqual(fatal.count, 1)
        XCTAssertTrue((fatal[0] as? String)?.contains("目录锁") ?? false)
        XCTAssertTrue(scheduled().isEmpty, "锁冲突不重启（重启必再撞同一锁）")
        supervisor.stop()
    }

    /// #7：退出码 70（启动失败）→ fatal 不重启，与运行期崩溃（1）分级。
    func testStartupFailureExitSeventyIsFatalWithoutRestart() throws {
        let dir = makeTempDir()
        let sidecar = FakeSidecar()
        let fatal = NSMutableArray()
        let (supervisor, scheduled) = makeSupervisor(dir: dir, sidecar: sidecar, fatalMessages: fatal)
        try supervisor.start()
        sidecar.terminate(status: 70)
        XCTAssertEqual(supervisor.state, .fatal)
        XCTAssertEqual(fatal.count, 1)
        XCTAssertTrue((fatal[0] as? String)?.contains("启动失败") ?? false)
        XCTAssertTrue(scheduled().isEmpty, "启动失败不排定重启")
        supervisor.stop()
    }

    func testRestartExhaustionIsFatal() throws {
        let dir = makeTempDir()
        let sidecar = FakeSidecar()
        let fatal = NSMutableArray()
        let (supervisor, scheduled) = makeSupervisor(dir: dir, sidecar: sidecar, fatalMessages: fatal)
        try supervisor.start()
        for attempt in 1...3 {
            sidecar.terminate(status: 1)
            XCTAssertEqual(supervisor.state, .restarting, "第 \(attempt) 次崩溃应排定重启")
            scheduled()[attempt - 1]()
        }
        sidecar.terminate(status: 1)
        XCTAssertEqual(supervisor.state, .fatal)
        XCTAssertEqual(fatal.count, 1)
        XCTAssertTrue((fatal[0] as? String)?.contains("连续崩溃") ?? false)
        supervisor.stop()
    }

    func testStopInvalidatesLateScheduledRestart() throws {
        let dir = makeTempDir()
        let sidecar = FakeSidecar()
        let (supervisor, scheduled) = makeSupervisor(dir: dir, sidecar: sidecar)
        try supervisor.start()
        sidecar.terminate(status: 1)
        let pending = scheduled()
        XCTAssertEqual(pending.count, 1)
        supervisor.stop()
        pending[0]()  // 迟到调度：token 已作废，绝不重启
        XCTAssertEqual(sidecar.startCount, 1)
        XCTAssertEqual(supervisor.state, .stopped)
    }

    /// #5：进程在 launch 提交前退出 → 必须 fatal（启动失败），绝不发布 .running，
    /// 也绝不按崩溃退避重启。
    func testTerminationDuringLaunchIsStartupFailureNotRunning() throws {
        let dir = makeTempDir()
        let sidecar = FakeSidecar()
        let fatal = NSMutableArray()
        let (supervisor, scheduled) = makeSupervisor(dir: dir, sidecar: sidecar, fatalMessages: fatal)
        sidecar.duringStart = { sidecar.terminate(status: 1) }
        let state = try supervisor.start()
        XCTAssertEqual(state, .fatal, "启动期退出不得发布 .running")
        XCTAssertEqual(supervisor.state, .fatal)
        XCTAssertEqual(fatal.count, 1)
        XCTAssertTrue((fatal[0] as? String)?.contains("启动期退出") ?? false)
        XCTAssertTrue(scheduled().isEmpty, "启动期退出不排定重启")
        supervisor.stop()
    }

    /// #5：stop() 与在途 launch 交错 → 进程必须被回收、状态保持 .stopped，
    /// 目录锁不得在进程仍存活时被释放后又被重新发布为 running。
    func testStopDuringLaunchReclaimsProcessAndKeepsStopped() throws {
        let dir = makeTempDir()
        let sidecar = FakeSidecar()
        let (supervisor, scheduled) = makeSupervisor(dir: dir, sidecar: sidecar)
        var state: SidecarSupervisor.State?
        sidecar.duringStart = {
            supervisor.stop()
            state = supervisor.state
        }
        let returned = try supervisor.start()
        XCTAssertEqual(returned, .stopped, "stop 在启动期间到达 → 不发布 running")
        XCTAssertEqual(state, .stopped)
        XCTAssertEqual(sidecar.stopCount, 1, "启动期被 stop 的进程必须被回收")
        XCTAssertFalse(supervisor.directoryLock.isHeld)
        XCTAssertTrue(scheduled().isEmpty)
    }

    // MARK: - G11：真实 onTerminated → Supervisor 接线（无桩进程）

    /// 有界轮询（真实进程终止回调不保证在断言线程的时序）。
    private func pollUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.02)
        }
        return condition()
    }

    /// G11（2026-12 审计）：onTerminated → SidecarSupervisor 的生产接线此前
    /// 只被假进程用例覆盖（FakeSidecar 自己调 onTerminated，接线断了也全绿）。
    /// 本用例路径上**无桩进程**：makeSidecar 返回真实 BridgeClient（/bin/sh
    /// 0.3s 后 exit 1），自然终止必须经 BridgeClient.handleTermination →
    /// onTerminated → Supervisor.handleTermination → 崩溃退避排定；手工触发
    /// 排定闭包（唯一注入的是调度时钟）后第二个真实进程必须被拉起。
    func testRealBridgeTerminationDrivesSupervisorRestart() throws {
        let dir = makeTempDir()
        let scheduled = ScheduledRecorder()
        var launchCount = 0
        var bridges: [BridgeClient] = []
        let supervisor = SidecarSupervisor(
            directoryLock: SidecarDirectoryLock(userDataDir: dir),
            dependencies: .init(
                makeSidecar: {
                    launchCount += 1
                    let bridge = BridgeClient(nodePath: "/bin/sh",
                                              arguments: ["-c", "sleep 0.3; exit 1"],
                                              environment: [:])
                    bridges.append(bridge)
                    return bridge
                },
                schedule: { _, work in scheduled.append(work) },
                log: { _ in },
                onFatal: { _ in }))
        XCTAssertEqual(try supervisor.start(), .running)
        XCTAssertEqual(launchCount, 1)
        XCTAssertTrue(supervisor.directoryLock.isHeld)
        XCTAssertTrue(bridges[0].isRunning, "第一个真实 sidecar 进程应已拉起")

        // 自然退出（exit 1）→ 真实 BridgeClient 的 onTerminated → Supervisor。
        XCTAssertTrue(pollUntil(timeout: 5) { supervisor.state == .restarting },
                      "真实 BridgeClient 的自然退出必须驱动 Supervisor 进入退避重启"
                      + "（当前状态 \(supervisor.state)）")
        XCTAssertEqual(scheduled.count, 1, "崩溃应排定一次重启")
        XCTAssertFalse(bridges[0].isRunning, "第一个进程应已自然退出")

        // 手工触发排定闭包：重启腿必须拉起第二个真实进程。
        scheduled.snapshot[0]()
        XCTAssertEqual(supervisor.state, .running)
        XCTAssertEqual(launchCount, 2)
        XCTAssertTrue(bridges[1].isRunning, "重启后的进程必须是真实 BridgeClient")

        supervisor.stop()
        XCTAssertEqual(supervisor.state, .stopped)
        XCTAssertFalse(supervisor.directoryLock.isHeld)
        XCTAssertFalse(bridges[1].isRunning, "stop() 必须回收真实进程")
    }

    func testStopIsIdempotent() throws {
        let dir = makeTempDir()
        let sidecar = FakeSidecar()
        let (supervisor, _) = makeSupervisor(dir: dir, sidecar: sidecar)
        try supervisor.start()
        supervisor.stop()
        supervisor.stop()
        XCTAssertEqual(sidecar.stopCount, 1, "重复 stop 只停一次")
        XCTAssertEqual(supervisor.state, .stopped)
    }
}
