//
//  CrashDiagnosticsTests.swift
//  DSHChamberTests
//
//  P0.2 原生崩溃最小诊断：路径规则、记录格式（纯函数）、安装 seam、信号/异常处理器
//  核心的落盘（真实临时目录 + 固定 epoch 直调，不真发信号——真发会杀掉测试进程）、
//  「上次异常退出」标记的判定/消费/清除、以及 ShellLog.openSignalSafeLeaf 的
//  共享纪律（同目录/0600/0700/符号链接拒绝/安装期清零）。
//
import Darwin
import XCTest
@testable import DSHChamber

final class CrashDiagnosticsTests: XCTestCase {

    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("crash-diagnostics-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let tempDir { try? FileManager.default.removeItem(at: tempDir) }
    }

    private func repositoryFile(_ relative: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent(relative)
        return try String(contentsOf: url, encoding: .utf8)
    }

    // MARK: - 路径 / 名称 / 格式（纯函数）

    func testPathRulesShareShellLogDirectory() {
        XCTAssertEqual(CrashDiagnostics.crashLogFileName, "shell-crash.log")
        XCTAssertEqual(CrashDiagnostics.markerFileName, "shell-crash.marker")
        XCTAssertEqual(CrashDiagnostics.crashLogURL(userDataDir: "/u/data").path,
                       "/u/data/logs/shell-crash.log")
        XCTAssertEqual(CrashDiagnostics.markerURL(userDataDir: "/u/data").path,
                       "/u/data/logs/shell-crash.marker")
        XCTAssertEqual(CrashDiagnostics.crashLogURL(userDataDir: "/u/data").deletingLastPathComponent(),
                       ShellLog.fileURL(userDataDir: "/u/data").deletingLastPathComponent(),
                       "崩溃记录必须与 shell.log 同目录（不另立一套目录树）")
    }

    func testDefaultSignalsCoverTheFatalSix() {
        XCTAssertEqual(CrashDiagnostics.defaultSignals,
                       [SIGSEGV, SIGABRT, SIGBUS, SIGILL, SIGFPE, SIGTRAP])
    }

    func testSignalNamesAreStableAndUnknownFallsBackToNumber() {
        XCTAssertEqual(CrashDiagnostics.signalName(SIGSEGV), "SIGSEGV")
        XCTAssertEqual(CrashDiagnostics.signalName(SIGABRT), "SIGABRT")
        XCTAssertEqual(CrashDiagnostics.signalName(SIGBUS), "SIGBUS")
        XCTAssertEqual(CrashDiagnostics.signalName(SIGILL), "SIGILL")
        XCTAssertEqual(CrashDiagnostics.signalName(SIGFPE), "SIGFPE")
        XCTAssertEqual(CrashDiagnostics.signalName(SIGTRAP), "SIGTRAP")
        XCTAssertEqual(CrashDiagnostics.signalName(SIGTERM), "SIG15")
    }

    func testSanitizedFieldEnforcesTheSingleLineInvariant() {
        XCTAssertEqual(CrashDiagnostics.sanitizedField("NSInternalInconsistencyException"),
                       "NSInternalInconsistencyException")
        XCTAssertEqual(CrashDiagnostics.sanitizedField("bad\nname\tvalue"), "bad_name_value",
                       "换行/制表符必须被白名单化成下划线（否则可伪造多条记录）")
        XCTAssertEqual(CrashDiagnostics.sanitizedField(String(repeating: "x", count: 100)).count, 64)
        XCTAssertEqual(CrashDiagnostics.sanitizedField(""), "")
    }

    func testRecordFormatCarriesTimeKindNamePidVersion() {
        let line = CrashDiagnostics.formatRecord(kind: "signal", name: "SIGSEGV", signo: 11,
                                                 bundleVersion: "0.16.0", pid: 4242,
                                                 epoch: 1_700_000_000,
                                                 source: CrashDiagnostics.recordSource,
                                                 phase: CrashDiagnostics.phaseRunningLabel)
        XCTAssertEqual(line,
                       "[2023-11-14T22:13:20Z] kind=signal name=SIGSEGV signo=11 pid=4242 version=0.16.0 source=native-shell phase=running")
        XCTAssertEqual(line.components(separatedBy: "\n").count, 1, "记录必须是单行")
        let exception = CrashDiagnostics.formatRecord(kind: "exception",
                                                      name: "NSInternalInconsistencyException",
                                                      signo: nil, bundleVersion: "0.16.0",
                                                      pid: 7, epoch: 1_700_000_000,
                                                      source: CrashDiagnostics.recordSource,
                                                      phase: CrashDiagnostics.phaseStartupLabel)
        XCTAssertEqual(exception,
                       "[2023-11-14T22:13:20Z] kind=exception name=NSInternalInconsistencyException pid=7 version=0.16.0 source=native-shell phase=startup")
    }

    func testBundleVersionFallsBackToUnknown() {
        XCTAssertEqual(CrashDiagnostics.bundleVersion(infoDictionary: ["CFBundleShortVersionString": "1.2.3"]),
                       "1.2.3")
        XCTAssertEqual(CrashDiagnostics.bundleVersion(infoDictionary: [:]), "unknown")
        XCTAssertEqual(CrashDiagnostics.bundleVersion(infoDictionary: ["CFBundleShortVersionString": ""]),
                       "unknown")
    }

    // MARK: - 安装 seam（绝不真接管测试进程的信号）

    func testInstallUsesInjectedSeamsAndTheSharedLeaf() {
        var openedPaths: [String] = []
        let seams = CrashDiagnostics.InstallSeams(
            openCrashLogLeaf: { url, _ in openedPaths.append(url.path); return -1 },
            setExceptionHandler: { _ in true },
            installSignalHandler: { _, _ in true },
            currentExceptionHandler: { nil })
        let installation = CrashDiagnostics.install(userDataDir: tempDir.path,
                                                    bundleVersion: "9.9.9", pid: 42,
                                                    seams: seams)
        XCTAssertEqual(openedPaths, [CrashDiagnostics.crashLogURL(userDataDir: tempDir.path).path],
                       "安装期必须经共享叶子打开器打开 shell-crash.log")
        XCTAssertEqual(installation.installedSignals, CrashDiagnostics.defaultSignals)
        XCTAssertTrue(installation.exceptionHandlerInstalled)
        XCTAssertEqual(installation.logFD, -1)
        XCTAssertFalse(installation.logActive)
        XCTAssertEqual(installation.markerURL,
                       CrashDiagnostics.markerURL(userDataDir: tempDir.path))
    }

    func testInstallReportsOnlyTheSignalsTheSeamAccepted() {
        let seams = CrashDiagnostics.InstallSeams(
            openCrashLogLeaf: { _, _ in -1 },
            setExceptionHandler: { _ in false },
            installSignalHandler: { signo, _ in signo != SIGTRAP },
            currentExceptionHandler: { nil })
        let installation = CrashDiagnostics.install(userDataDir: tempDir.path, seams: seams)
        XCTAssertEqual(installation.installedSignals,
                       [SIGSEGV, SIGABRT, SIGBUS, SIGILL, SIGFPE])
        XCTAssertFalse(installation.exceptionHandlerInstalled)
    }

    // MARK: - 处理器核心落盘（真实文件；epoch 注入）

    private func installWithLiveLeaf(bundleVersion: String = "0.16.0",
                                     pid: Int32 = 4242) -> CrashDiagnostics.Installation {
        let seams = CrashDiagnostics.InstallSeams(
            openCrashLogLeaf: { url, maxBytes in
                ShellLog.openSignalSafeLeaf(url: url, maxBytes: maxBytes)
            },
            setExceptionHandler: { _ in true },
            installSignalHandler: { _, _ in true },
            currentExceptionHandler: { nil })
        return CrashDiagnostics.install(userDataDir: tempDir.path, bundleVersion: bundleVersion,
                                        pid: pid, seams: seams)
    }

    func testSignalEmitWritesRecordAndMarkerWithThePureFormat() throws {
        let installation = installWithLiveLeaf()
        XCTAssertTrue(installation.logActive)
        XCTAssertTrue(CrashDiagnostics.emitForTesting(signal: SIGSEGV, epoch: 1_700_000_000))

        let expected = CrashDiagnostics.formatRecord(kind: "signal", name: "SIGSEGV", signo: SIGSEGV,
                                                     bundleVersion: "0.16.0", pid: 4242,
                                                     epoch: 1_700_000_000,
                                                     source: CrashDiagnostics.recordSource,
                                                     phase: CrashDiagnostics.phaseStartupLabel) + "\n"
        let log = try String(contentsOf: installation.crashLogURL, encoding: .utf8)
        XCTAssertEqual(log, expected, "处理器手写路径必须与纯函数 formatRecord 逐字节一致")
        let marker = try String(contentsOf: installation.markerURL, encoding: .utf8)
        XCTAssertEqual(marker, expected, "标记文件里就是最近一条记录")
        let attributes = try FileManager.default.attributesOfItem(atPath: installation.crashLogURL.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }

    func testExceptionEmitSanitizesTheDynamicNameIntoOneLine() throws {
        let installation = installWithLiveLeaf()
        XCTAssertTrue(CrashDiagnostics.emitForTesting(exceptionName: "NSInternalInconsistencyException\ninjected",
                                                      epoch: 1_700_000_000))
        let expected = CrashDiagnostics.formatRecord(kind: "exception",
                                                     name: "NSInternalInconsistencyException\ninjected",
                                                     signo: nil, bundleVersion: "0.16.0",
                                                     pid: 4242, epoch: 1_700_000_000,
                                                     source: CrashDiagnostics.recordSource,
                                                     phase: CrashDiagnostics.phaseStartupLabel) + "\n"
        let log = try String(contentsOf: installation.crashLogURL, encoding: .utf8)
        XCTAssertEqual(log, expected, "异常路径同样与纯函数逐字节一致")
        XCTAssertEqual(log.components(separatedBy: "\n").count, 2, "只允许末尾一个换行（单行不变量）")
        XCTAssertTrue(log.contains("NSInternalInconsistencyException_injected"))
    }

    /// 相位：安装后写 startup，markPhaseRunning 之后写 running（同一份记录格式，
    /// 只换相位标签；上游报告含 source/phase —— 「启动期崩」与「跑起来崩」可区分）。
    func testPhaseFlipsFromStartupToRunning() throws {
        let installation = installWithLiveLeaf()
        XCTAssertTrue(CrashDiagnostics.emitForTesting(signal: SIGSEGV, epoch: 1_700_000_000))
        var log = try String(contentsOf: installation.crashLogURL, encoding: .utf8)
        XCTAssertTrue(log.contains("phase=startup"), log)
        XCTAssertFalse(log.contains("phase=running"), log)
        CrashDiagnostics.markPhaseRunning()
        XCTAssertTrue(CrashDiagnostics.emitForTesting(signal: SIGSEGV, epoch: 1_700_000_001))
        log = try String(contentsOf: installation.crashLogURL, encoding: .utf8)
        XCTAssertTrue(log.contains("phase=running"), log)
        XCTAssertTrue(log.contains("source=native-shell"), log)
        let marker = try String(contentsOf: installation.markerURL, encoding: .utf8)
        XCTAssertTrue(marker.contains("phase=running"), "标记里就是最近一条（相位已翻转）")
    }

    // MARK: - 上次异常退出（判定 / 消费 / 清除）

    func testPreviousCrashDetectedIsMarkerPresence() {
        XCTAssertTrue(CrashDiagnostics.previousCrashDetected(markerExists: true))
        XCTAssertFalse(CrashDiagnostics.previousCrashDetected(markerExists: false))
    }

    func testPreviousCrashLogLineContainsTheRecordPath() {
        let line = CrashDiagnostics.previousCrashLogLine(crashLogPath: "/u/data/logs/shell-crash.log",
                                                         lastRecordLine: "[t] kind=signal name=SIGSEGV")
        XCTAssertTrue(line.contains("/u/data/logs/shell-crash.log"))
        XCTAssertTrue(line.contains("kind=signal name=SIGSEGV"))
        XCTAssertTrue(line.contains("上次异常退出"))
        let empty = CrashDiagnostics.previousCrashLogLine(crashLogPath: "/u/data/logs/shell-crash.log",
                                                          lastRecordLine: nil)
        XCTAssertTrue(empty.contains("/u/data/logs/shell-crash.log"))
        XCTAssertTrue(empty.contains("记录为空"))
    }

    func testPreviousCrashConsumeReportsOnceAndClearsTheMarker() throws {
        let markerURL = CrashDiagnostics.markerURL(userDataDir: tempDir.path)
        let logURL = CrashDiagnostics.crashLogURL(userDataDir: tempDir.path)
        try FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        let record = CrashDiagnostics.formatRecord(kind: "signal", name: "SIGBUS", signo: 10,
                                                   bundleVersion: "0.16.0", pid: 42,
                                                   epoch: 1_700_000_000,
                                                   source: CrashDiagnostics.recordSource,
                                                   phase: CrashDiagnostics.phaseStartupLabel)
        try (record + "\n").write(to: logURL, atomically: true, encoding: .utf8)
        try "marker".write(to: markerURL, atomically: true, encoding: .utf8)

        var logged: [String] = []
        let io = CrashDiagnostics.PreviousCrashIO(
            markerExists: { FileManager.default.fileExists(atPath: $0.path) },
            readLastRecordLine: { CrashDiagnostics.lastRecordLine(at: $0) },
            removeMarker: { (try? FileManager.default.removeItem(at: $0)) != nil },
            log: { logged.append($0) })

        let line = CrashDiagnostics.reportPreviousCrashIfNeeded(userDataDir: tempDir.path, io: io)
        XCTAssertEqual(logged.count, 1, "存在标记 = 恰好一行 shellLog")
        XCTAssertEqual(line, logged.first)
        XCTAssertTrue(line?.contains(logURL.path) == true, "必须含记录路径")
        XCTAssertTrue(line?.contains("kind=signal name=SIGBUS") == true, "必须含最近一条记录（给出原因）")
        XCTAssertFalse(FileManager.default.fileExists(atPath: markerURL.path), "消费后必须清除标记")

        XCTAssertNil(CrashDiagnostics.reportPreviousCrashIfNeeded(userDataDir: tempDir.path, io: io))
        XCTAssertEqual(logged.count, 1, "标记不在 = 不再报告（幂等）")
    }

    func testPreviousCrashConsumeWithoutMarkerNeverTouchesTheLog() {
        var logged: [String] = []
        var removes = 0
        let io = CrashDiagnostics.PreviousCrashIO(
            markerExists: { _ in false },
            readLastRecordLine: { _ in "不应被读" },
            removeMarker: { _ in removes += 1; return true },
            log: { logged.append($0) })
        XCTAssertNil(CrashDiagnostics.reportPreviousCrashIfNeeded(userDataDir: tempDir.path, io: io))
        XCTAssertTrue(logged.isEmpty)
        XCTAssertEqual(removes, 0)
    }

    func testClearMarkerIsIdempotentAndSilent() throws {
        let marker = CrashDiagnostics.markerURL(userDataDir: tempDir.path)
        CrashDiagnostics.clearMarker(at: marker)
        try FileManager.default.createDirectory(at: marker.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try "x".write(to: marker, atomically: true, encoding: .utf8)
        CrashDiagnostics.clearMarker(at: marker)
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
    }

    func testLastRecordLineTakesTheLastNonEmptyLine() throws {
        let url = CrashDiagnostics.crashLogURL(userDataDir: tempDir.path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try "first\n\nsecond\n".write(to: url, atomically: true, encoding: .utf8)
        XCTAssertEqual(CrashDiagnostics.lastRecordLine(at: url), "second")
        XCTAssertNil(CrashDiagnostics.lastRecordLine(at: tempDir.appendingPathComponent("missing.log")))
    }

    // MARK: - 共享叶子（ShellLog.openSignalSafeLeaf）

    func testSignalSafeLeafUsesTheSharedPermissions() throws {
        let url = CrashDiagnostics.crashLogURL(userDataDir: tempDir.path)
        let descriptor = ShellLog.openSignalSafeLeaf(url: url)
        XCTAssertGreaterThanOrEqual(descriptor, 0)
        close(descriptor)
        let fileAttributes = try FileManager.default.attributesOfItem(atPath: url.path)
        XCTAssertEqual((fileAttributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        let directoryAttributes = try FileManager.default.attributesOfItem(
            atPath: url.deletingLastPathComponent().path)
        XCTAssertEqual((directoryAttributes[.posixPermissions] as? NSNumber)?.intValue, 0o700)
    }

    func testSignalSafeLeafResetsAnOverCapFileAtInstallTime() throws {
        let url = CrashDiagnostics.crashLogURL(userDataDir: tempDir.path)
        let first = ShellLog.openSignalSafeLeaf(url: url, maxBytes: 16)
        XCTAssertGreaterThanOrEqual(first, 0)
        close(first)
        try Data(repeating: 0x41, count: 64).write(to: url)
        let second = ShellLog.openSignalSafeLeaf(url: url, maxBytes: 16)
        XCTAssertGreaterThanOrEqual(second, 0)
        close(second)
        XCTAssertEqual(try Data(contentsOf: url).count, 0,
                       "超过上限的旧记录在安装期整体清零（信号上下文不做 rename 轮转）")
    }

    func testSignalSafeLeafRefusesASymlink() throws {
        let directory = tempDir.appendingPathComponent("logs")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let outside = tempDir.appendingPathComponent("outside.log")
        try "outside".write(to: outside, atomically: true, encoding: .utf8)
        let leaf = directory.appendingPathComponent(CrashDiagnostics.crashLogFileName)
        try FileManager.default.createSymbolicLink(at: leaf, withDestinationURL: outside)
        XCTAssertEqual(ShellLog.openSignalSafeLeaf(url: leaf), -1,
                       "叶子是符号链接时必须拒绝（O_NOFOLLOW + 安装期判据）")
        XCTAssertEqual(try String(contentsOf: outside, encoding: .utf8), "outside",
                       "绝不写到链接目标")
    }

    // MARK: - 接线与纪律（源码锁步）

    func testAppDelegateConsumesTheMarkerBeforeInstalling() throws {
        let source = try repositoryFile("Sources/DSHChamber/AppDelegate.swift")
        let report = try XCTUnwrap(source.range(of: "CrashDiagnostics.reportPreviousCrashIfNeeded(userDataDir: stateDir)"))
        let install = try XCTUnwrap(source.range(of: "crashDiagnostics = CrashDiagnostics.install(userDataDir: stateDir)"))
        XCTAssertLessThan(report.lowerBound, install.lowerBound,
                          "必须先消费上次标记，再安装本次处理器")
        let terminate = try XCTUnwrap(source.range(of: "func applicationWillTerminate"))
        let terminateBody = String(source[terminate.lowerBound...].prefix(800))
        XCTAssertTrue(terminateBody.contains("crashDiagnostics?.clearMarker()"),
                      "正常退出路径必须清除「上次异常退出」标记")
    }

    func testSignalHandlerRebuildsDefaultDispositionAndReraises() throws {
        let source = try repositoryFile("Sources/DSHChamber/CrashDiagnostics.swift")
        XCTAssertTrue(source.contains("NSSetUncaughtExceptionHandler(handler)"),
                      "必须安装未捕获异常处理器（live seam）")
        XCTAssertTrue(source.contains("sigaction(signo, &action, nil) == 0"),
                      "必须安装六个致命信号处理器（live seam）")
        let handler = try XCTUnwrap(source.range(of: "static func handleSignal(_ signo: Int32)"))
        let body = String(source[handler.lowerBound...].prefix(900))
        XCTAssertTrue(body.contains("signal(signo, SIG_DFL)"),
                      "写记录后必须恢复默认处置")
        XCTAssertTrue(body.contains("raise(signo)"),
                      "必须重发信号——绝不吞掉信号（系统 DiagnosticReports 面不变）")
        XCTAssertTrue(body.contains("crashExceptionRecordWritten == 0"))
        XCTAssertTrue(source.contains("crashExceptionRecordWritten = 1"),
                      "异常路径写过后不再写第二条（避免标记里只剩 SIGABRT）")
    }

    // MARK: - B3：纯整数 civil-date 换算（gmtime_r 不在 async-signal-safe 名单）

    /// 纯换算 vs Foundation 独立 oracle：跨纪元边界、闰年与负 epoch 逐字节比对。
    func testPureCivilDateMatchesISO8601AcrossEpochs() {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.formatOptions = [.withInternetDateTime]
        for epoch: Int64 in [0, 1, 86_399, 86_400, 951_782_399, 951_782_400,
                             1_700_000_000, 1_800_000_000, 2_000_000_000, 4_102_444_800,
                             -1, -86_401] {
            let date = CrashDiagnostics.utcCivilDate(epoch: epoch)
            let actual = String(format: "%04d-%02d-%02dT%02d:%02d:%02dZ",
                                date.year, date.month, date.day,
                                date.hour, date.minute, date.second)
            let expected = formatter.string(from: Date(timeIntervalSince1970: TimeInterval(epoch)))
            XCTAssertEqual(actual, expected, "epoch=\(epoch) 必须与 ISO8601 文本逐字节相同")
        }
    }

    /// 处理器手写路径（纯整数换算）与 formatRecord 在多个 epoch 上逐字节锁步。
    func testHandlerTimestampStaysByteIdenticalToPureFormatAcrossEpochs() throws {
        let installation = installWithLiveLeaf()
        let epochs: [Int64] = [0, 1_700_000_000, 1_800_000_000, 951_782_400]
        for epoch in epochs {
            XCTAssertTrue(CrashDiagnostics.emitForTesting(signal: SIGABRT, epoch: epoch))
        }
        let expected = epochs.map {
            CrashDiagnostics.formatRecord(kind: "signal", name: "SIGABRT", signo: SIGABRT,
                                          bundleVersion: "0.16.0", pid: 4242, epoch: $0,
                                          source: CrashDiagnostics.recordSource,
                                          phase: CrashDiagnostics.phaseStartupLabel) + "\n"
        }.joined()
        XCTAssertEqual(try String(contentsOf: installation.crashLogURL, encoding: .utf8), expected,
                       "处理器路径必须与 formatRecord 逐字节一致（B3 后仍是同一 UTC 文本）")
        let last = try XCTUnwrap(epochs.last)
        XCTAssertEqual(try String(contentsOf: installation.markerURL, encoding: .utf8),
                       CrashDiagnostics.formatRecord(kind: "signal", name: "SIGABRT", signo: SIGABRT,
                                                     bundleVersion: "0.16.0", pid: 4242, epoch: last,
                                                     source: CrashDiagnostics.recordSource,
                                                     phase: CrashDiagnostics.phaseStartupLabel) + "\n",
                       "标记文件里就是最近一条记录（O_TRUNC 单条语义不变）")
    }

    /// B3 源码锁步：信号路径不得再出现 gmtime_r；design 25 §5.4 的处理器调用清单
    /// 也不得再把它写成安全调用。
    /// 去掉整行注释后的源码：gmtime_r 只允许出现在「为什么不能用」的注释里。
    private func codeWithoutComments(_ source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    func testSignalPathAvoidsGmtimeAndDesignDocIsSynced() throws {
        let source = try repositoryFile("Sources/DSHChamber/CrashDiagnostics.swift")
        XCTAssertFalse(codeWithoutComments(source).contains("gmtime_r"),
                       "可执行源码不得含 gmtime_r（不在 async-signal-safe 名单，B3）")
        XCTAssertTrue(source.contains("static func utcCivilDate"),
                      "时间换算必须是本文件内的纯整数函数")
        let prefix = try XCTUnwrap(source.range(of: "static func renderTimestampPrefix"))
        let body = String(source[prefix.lowerBound...].prefix(1300))
        XCTAssertTrue(body.contains("utcCivilDate(epoch: epoch)"))
        XCTAssertFalse(body.contains("Formatter"))
        let design = try repositoryFile("../docs/design/25-macos-swift-native-shell.md")
        XCTAssertFalse(design.contains("gmtime_r(3)"),
                       "design 25 §5.4 的处理器调用清单不得再把 gmtime_r(3) 写成调用（B3）")
        XCTAssertTrue(design.contains("纯整数 civil-date"),
                      "§5.4 必须声明改用纯整数 civil-date 换算")
        let disassemblyStart = try XCTUnwrap(design.range(of: "release 反汇编可验"))
        let disassembly = String(design[disassemblyStart.lowerBound...].prefix(400))
        XCTAssertTrue(disassembly.contains("fstat"),
                      "release 反汇编调用清单必须含 fstat（B5）")
        XCTAssertFalse(disassembly.contains("gmtime_r"),
                       "调用清单不得再出现 gmtime_r（B3）")
    }

    // MARK: - B5：标记叶子的常规文件判据

    func testMarkerLeafVerdictRequiresRegularFileWithOneLink() {
        XCTAssertTrue(CrashDiagnostics.markerLeafAccepted(mode: S_IFREG | 0o600, nlink: 1))
        XCTAssertFalse(CrashDiagnostics.markerLeafAccepted(mode: S_IFIFO | 0o600, nlink: 1),
                       "FIFO 不是可写标记叶子")
        XCTAssertFalse(CrashDiagnostics.markerLeafAccepted(mode: S_IFREG | 0o600, nlink: 2),
                       "硬链接（nlink>1）不是可写标记叶子")
        XCTAssertFalse(CrashDiagnostics.markerLeafAccepted(mode: S_IFDIR | 0o700, nlink: 1))
        XCTAssertFalse(CrashDiagnostics.markerLeafAccepted(mode: S_IFLNK | 0o777, nlink: 1))
    }

    /// 失败注入：标记路径是 FIFO（先开读者，open 会成功）→ fstat 判据必须拒绝；
    /// 记录叶子照常落盘（诊断静默降级，绝不阻塞、绝不写非规整文件）。
    func testNonRegularMarkerIsRefusedWithoutWriting() throws {
        let installation = installWithLiveLeaf()
        let markerPath = installation.markerURL.path
        try FileManager.default.createDirectory(
            at: installation.markerURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        XCTAssertEqual(mkfifo(markerPath, 0o600), 0, "用例需要 FIFO 标记叶子")
        let reader = open(markerPath, O_RDONLY | O_NONBLOCK)
        XCTAssertGreaterThanOrEqual(reader, 0)
        defer { close(reader) }

        XCTAssertTrue(CrashDiagnostics.emitForTesting(signal: SIGSEGV, epoch: 1_700_000_000))
        let log = try String(contentsOf: installation.crashLogURL, encoding: .utf8)
        XCTAssertTrue(log.contains("kind=signal name=SIGSEGV"), "记录叶子不受标记判据影响")

        var bytes = [UInt8](repeating: 0, count: 64)
        let readCount = read(reader, &bytes, bytes.count)
        XCTAssertLessThanOrEqual(readCount, 0,
                                 "fstat 判据拒绝 FIFO：标记路径不得出现任何字节")
    }

    func testMarkerWriteUsesTheSameRegularFileDiscipline() throws {
        let source = try repositoryFile("Sources/DSHChamber/CrashDiagnostics.swift")
        let writeStart = try XCTUnwrap(source.range(of: "static func writeRecord"))
        let writeBody = String(source[writeStart.lowerBound...].prefix(900))
        XCTAssertTrue(writeBody.contains("openMarkerLeaf("),
                      "标记必须经判据打开（B5）")
        let openStart = try XCTUnwrap(source.range(of: "static func openMarkerLeaf"))
        let openBody = String(source[openStart.lowerBound...].prefix(900))
        XCTAssertTrue(openBody.contains("fstat(descriptor, &info)"),
                      "fstat 在安全名单内（B5）")
        XCTAssertTrue(openBody.contains("markerLeafAccepted(mode: info.st_mode, nlink: info.st_nlink)"))
        XCTAssertTrue(openBody.contains("O_NOFOLLOW"))
    }

    // MARK: - B6：标记清除失败必须 loud

    /// 清不掉时：报告行照常返回（不吞崩溃报告），另出一行 loud 失败（路径 + 后果），
    /// 绝不静默导致每次启动重复报同一条旧崩溃。
    func testMarkerRemovalFailureIsLoudAndActionable() {
        var logged: [String] = []
        let marker = CrashDiagnostics.markerURL(userDataDir: tempDir.path)
        let io = CrashDiagnostics.PreviousCrashIO(
            markerExists: { _ in true },
            readLastRecordLine: { _ in "[t] kind=signal name=SIGSEGV" },
            removeMarker: { _ in false },
            log: { logged.append($0) })
        let line = CrashDiagnostics.reportPreviousCrashIfNeeded(userDataDir: tempDir.path, io: io)
        XCTAssertNotNil(line, "崩溃报告本身仍然返回")
        XCTAssertEqual(logged.count, 2, "报告一行 + 清除失败一行")
        XCTAssertTrue(logged[0].contains("上次异常退出"))
        XCTAssertTrue(logged[1].contains("清除失败"))
        XCTAssertTrue(logged[1].contains(marker.path), "失败行必须带标记路径")
        XCTAssertTrue(logged[1].contains("重复报告"), "失败行必须说明后果")
        XCTAssertTrue(logged[1].contains("请手动删除"), "失败行必须给可执行动作")
        XCTAssertEqual(logged[1], CrashDiagnostics.markerRemovalFailureLine(markerPath: marker.path))
    }
}
