//
//  SidecarStartupFailureTests.swift
//  DSHChamberTests
//
//  端口占用等启动失败的诚实报错——退出码 + stderr
//  摘要（含 EADDRINUSE host:port）+ 可执行提示；并钉住真实 BridgeClient →
//  SidecarSupervisor 的 stderr 捕获接线（只测纯函数会漏掉这条捕获链）。
//
import XCTest
@testable import DSHChamber

final class SidecarStartupFailureTests: XCTestCase {

    private var tempDirs: [String] = []

    override func tearDown() {
        for dir in tempDirs { try? FileManager.default.removeItem(atPath: dir) }
        tempDirs = []
        super.tearDown()
    }

    private func makeTempDir() -> String {
        let dir = (NSTemporaryDirectory() as NSString)
            .appendingPathComponent("dsh-sidecar-failure-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        tempDirs.append(dir)
        return dir
    }

    func testPortInUseStderrYieldsExitCodePortAndActionableHint() {
        let failure = SidecarStartupFailure.make(
            exitCode: 70,
            stderr: "Error: listen EADDRINUSE: address already in use 127.0.0.1:17500")
        XCTAssertEqual(failure.exitCode, 70)
        XCTAssertEqual(failure.addressInUse, "127.0.0.1:17500")
        // 模板期望值动态取自键表（sidecar.startupExit，%d = 退出码）：
        // "exit=70" 也是键表值的一部分，机器语言为 en 时同样成立。
        XCTAssertTrue(failure.message.contains(
            NativeText.format(.sidecarStartupExit, Int32(70))),
            "必须带 sidecar.startupExit 的本地化模板：\(failure.message)")
        XCTAssertTrue(failure.message.contains("EADDRINUSE"))
        XCTAssertTrue(failure.message.contains("127.0.0.1:17500"))
        XCTAssertTrue(failure.message.contains(SidecarStartupFailure.portInUseHint))
        // 期望值动态取自键表（sidecar.portInUseSuffix，%@ = host:port）：
        // 机器语言是 en 时同样成立，不钉中文片段。
        XCTAssertTrue(failure.message.contains(
            NativeText.format(.sidecarPortInUseSuffix, "127.0.0.1:17500")),
            "必须带端口被占用的可执行后缀（含被占用端口）：\(failure.message)")
        XCTAssertFalse(failure.message.contains(SidecarStartupFailure.genericHint),
                       "已有真实原因时不得以笼统建议作为唯一信息")
    }

    func testGenericHintOnlyWithoutStderrEvidence() {
        let failure = SidecarStartupFailure.make(exitCode: 70, stderr: "")
        XCTAssertTrue(failure.message.contains(SidecarStartupFailure.genericHint))
        XCTAssertNil(failure.addressInUse)
        XCTAssertNil(failure.hint)
    }

    func testEADDRINUSEWithoutParsableAddressStillHints() {
        let failure = SidecarStartupFailure.make(
            exitCode: 70, stderr: "listen EADDRINUSE: address already in use")
        XCTAssertNil(failure.addressInUse)
        XCTAssertNotNil(failure.hint)
        XCTAssertTrue(failure.message.contains(SidecarStartupFailure.portInUseHint))
    }

    func testAddressParsingHandlesIPv6LoopbackAndRejectsOutOfRangePort() {
        XCTAssertEqual(SidecarStartupFailure.make(
            exitCode: 70,
            stderr: "Error: listen EADDRINUSE: address already in use [::1]:17500").addressInUse,
            "[::1]:17500")
        XCTAssertNil(SidecarStartupFailure.make(
            exitCode: 70,
            stderr: "Error: listen EADDRINUSE: address already in use 127.0.0.1:99999").addressInUse,
            "越界端口绝不猜成地址")
    }

    func testSummaryKeepsBoundedTailOfStderr() {
        let stderr = (1...40).map { "line-\($0)" }.joined(separator: "\n")
        let summary = SidecarStartupFailure.compress(stderr: stderr)
        XCTAssertTrue(summary.contains("line-40"), "尾部行必须保留（真正原因在最后）")
        XCTAssertFalse(summary.contains("line-1\n"), "过老的噪声行不得挤占摘要")
        XCTAssertLessThanOrEqual(summary.count, SidecarStartupFailure.summaryCharLimit + 1)
        XCTAssertEqual(summary.split(separator: "\n").count,
                       SidecarStartupFailure.summaryLineLimit)
    }

    func testSummaryTruncatesOverlongSingleLine() {
        let summary = SidecarStartupFailure.compress(
            stderr: String(repeating: "x", count: 2000))
        XCTAssertLessThanOrEqual(summary.count, SidecarStartupFailure.summaryCharLimit + 1)
        XCTAssertTrue(summary.hasSuffix("…"))
    }

    /// 真实进程接线：/bin/sh 在 stderr 打出 Node 形状的 EADDRINUSE
    /// 行后 exit 70——BridgeClient 捕获 → Supervisor fatal 文案必须含退出码、
    /// errno、端口与可执行提示。
    func testSupervisorFatalCarriesRealStderrEvidence() throws {
        let dir = makeTempDir()
        let fatal = LockedStrings()
        let supervisor = SidecarSupervisor(
            directoryLock: SidecarDirectoryLock(userDataDir: dir),
            dependencies: .init(
                makeSidecar: {
                    BridgeClient(
                        nodePath: "/bin/sh",
                        arguments: ["-c",
                            "echo 'Error: listen EADDRINUSE: address already in use 127.0.0.1:17500' >&2; exit 70"],
                        environment: [:])
                },
                schedule: { _, work in work() },
                log: { _ in },
                onFatal: { fatal.append($0) }))
        _ = try? supervisor.start()
        XCTAssertTrue(pollUntil(timeout: 5) { fatal.first != nil },
                      "exit=70 必须到达 fatal（当前状态 \(supervisor.state)）")
        XCTAssertEqual(supervisor.state, .fatal)
        let message = fatal.first ?? ""
        XCTAssertTrue(message.contains(NativeText.format(.sidecarStartupExit, Int32(70))),
                      "fatal 文案必须带 sidecar.startupExit 的本地化模板：\(message)")
        XCTAssertTrue(message.contains("EADDRINUSE"), "必须带 stderr 里的 errno：\(message)")
        XCTAssertTrue(message.contains("127.0.0.1:17500"), "必须带被占用端口：\(message)")
        XCTAssertTrue(message.contains(SidecarStartupFailure.portInUseHint),
                      "端口占用必须给可执行提示：\(message)")
        XCTAssertFalse(message.contains(SidecarStartupFailure.genericHint),
                       "不得以笼统建议作为唯一信息：\(message)")
        supervisor.stop()
    }

    private func pollUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.02)
        }
        return condition()
    }
}

/// 跨线程字符串记录（onFatal 在 Foundation 的终止回调线程到达）。
private final class LockedStrings {
    private let lock = NSLock()
    private var storage: [String] = []

    func append(_ value: String) {
        lock.lock()
        storage.append(value)
        lock.unlock()
    }

    var first: String? {
        lock.lock()
        defer { lock.unlock() }
        return storage.first
    }
}
