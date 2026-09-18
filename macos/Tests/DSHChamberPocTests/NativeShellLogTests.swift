//
//  NativeShellLogTests.swift
//  DSHChamberPocTests
//
//  A2：原生壳落盘日志的写入面——路径规则、真的落盘（不是只打印）、时间戳、
//  0600、大小上限轮转、失败静默降级，以及「启动/sidecar/导航失败/更新相位/退出链
//  都接了 shellLog」的源码锁步。
//
import XCTest
@testable import DSHChamberPoc

final class NativeShellLogTests: XCTestCase {

    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("native-shell-log-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let tempDir { try? FileManager.default.removeItem(at: tempDir) }
    }

    private func source(_ relative: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent(relative)
        return try String(contentsOf: url, encoding: .utf8)
    }

    // MARK: - 路径规则

    func testFileURLRuleIsUserDataLogsNativeShellLog() {
        XCTAssertEqual(NativeShellLog.fileURL(userDataDir: "/u/data").path,
                       "/u/data/logs/native-shell.log")
        XCTAssertEqual(NativeShellLog.directoryName, "logs")
        XCTAssertEqual(NativeShellLog.fileName, "native-shell.log")
        XCTAssertEqual(NativeShellLog.rotatedFileName, "native-shell.log.1")
    }

    /// 2026-12 取证修复：sidecar stderr 独立落盘实例（<userData>/logs/sidecar.log）。
    func testSidecarFileURLRuleAndInstance() throws {
        XCTAssertEqual(NativeShellLog.sidecarFileURL(userDataDir: "/u/data").path,
                       "/u/data/logs/sidecar.log")
        XCTAssertEqual(NativeShellLog.sidecarFileName, "sidecar.log")
        XCTAssertEqual(NativeShellLog.sidecarFileURL(userDataDir: tempDir.path).deletingLastPathComponent(),
                       NativeShellLog.fileURL(userDataDir: tempDir.path).deletingLastPathComponent(),
                       "两个文件同目录（logs/），不各自建目录树")
        let log = NativeShellLog()
        log.configureSidecar(userDataDir: tempDir.path)
        XCTAssertTrue(log.isActive)
        log.append("[sidecar] WebSocket stream 7 closed (heartbeat lost after 1 unanswered ping(s), 30123ms)")
        let text = try String(contentsOf: NativeShellLog.sidecarFileURL(userDataDir: tempDir.path), encoding: .utf8)
        XCTAssertTrue(text.contains("WebSocket stream 7 closed"), "拼接证据必须真的落盘：\(text)")
    }

    /// 轮转名必须按实例文件名派生：sidecar 实例绝不能把主日志轮转名（
    /// native-shell.log.1）当成自己的——两个实例共用同一份 rotateLocked 实现。
    func testSidecarRotationUsesItsOwnFileName() throws {
        let log = NativeShellLog()
        log.configureSidecar(userDataDir: tempDir.path, maxBytes: 1)
        log.append("[sidecar] first line over the one-byte cap")
        log.append("[sidecar] second line rotates the first away")
        let rotated = NativeShellLog.sidecarFileURL(userDataDir: tempDir.path)
            .deletingLastPathComponent()
            .appendingPathComponent("sidecar.log.1")
        XCTAssertTrue(FileManager.default.fileExists(atPath: rotated.path),
                      "sidecar 轮转文件必须是 sidecar.log.1")
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: NativeShellLog.fileURL(userDataDir: tempDir.path)
                .deletingLastPathComponent()
                .appendingPathComponent(NativeShellLog.rotatedFileName).path),
            "sidecar 实例不得写出 native-shell.log.1")
    }

    // MARK: - 真的被写入

    func testAppendWritesTimestampedLinesToDisk() throws {
        let url = NativeShellLog.fileURL(userDataDir: tempDir.path)
        let log = NativeShellLog(fileURL: url,
                                 now: { Date(timeIntervalSince1970: 1_700_000_000.25) })
        XCTAssertTrue(log.isActive, "初始化后文件必须真的打开（不是只打印）")
        XCTAssertEqual(log.filePath, url.path)
        log.append("[native] 装配完成")
        log.append("[supervisor] sidecar 已启动")

        let text = try String(contentsOf: url, encoding: .utf8)
        let lines = text.split(separator: "\n")
        XCTAssertEqual(lines.count, 2)
        XCTAssertTrue(text.contains("[native] 装配完成"))
        XCTAssertTrue(text.contains("[supervisor] sidecar 已启动"))
        XCTAssertTrue(lines.allSatisfy { $0.hasPrefix("[2023-11-14T") },
                      "每行以 ISO8601 时间戳开头：\(text)")
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600,
                       "日志可能含本机路径：文件权限必须 0600")
    }

    func testReopeningAppendsInsteadOfTruncating() throws {
        let url = NativeShellLog.fileURL(userDataDir: tempDir.path)
        NativeShellLog(fileURL: url).append("first-run")
        let second = NativeShellLog(fileURL: url)
        second.append("second-run")
        let text = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(text.contains("first-run"))
        XCTAssertTrue(text.contains("second-run"))
        XCTAssertEqual(text.split(separator: "\n").count, 2)
    }

    // MARK: - 大小上限 / 轮转

    func testRotationKeepsFileBoundedAndKeepsWriting() throws {
        let url = NativeShellLog.fileURL(userDataDir: tempDir.path)
        let log = NativeShellLog(fileURL: url, maxBytes: 120)
        for index in 0..<20 { log.append("line-\(index)") }

        let rotated = url.deletingLastPathComponent()
            .appendingPathComponent(NativeShellLog.rotatedFileName)
        XCTAssertTrue(FileManager.default.fileExists(atPath: rotated.path),
                      "超过上限必须轮转出 native-shell.log.1")
        XCTAssertLessThan((try String(contentsOf: url, encoding: .utf8)).utf8.count, 120)
        let archived = try String(contentsOf: rotated, encoding: .utf8)
        XCTAssertTrue(archived.contains("line-"), "轮转文件保留上一批行（可考古）")
        XCTAssertFalse(archived.isEmpty)

        log.append("after-rotation")
        XCTAssertTrue(try String(contentsOf: url, encoding: .utf8).contains("after-rotation"),
                      "轮转后必须继续可写")
    }

    func testRotationAlsoHappensAtOpenForOversizedExistingFile() throws {
        let url = NativeShellLog.fileURL(userDataDir: tempDir.path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data(repeating: 0x41, count: 200).write(to: url)
        _ = NativeShellLog(fileURL: url, maxBytes: 128)
        let rotated = url.deletingLastPathComponent()
            .appendingPathComponent(NativeShellLog.rotatedFileName)
        XCTAssertTrue(FileManager.default.fileExists(atPath: rotated.path))
    }

    // MARK: - 失败静默降级（日志绝不成为新的致命面）

    func testUnconfiguredLogIsNoOpButPrints() {
        let log = NativeShellLog()
        XCTAssertFalse(log.isActive)
        XCTAssertNil(log.filePath)
        log.append("nowhere")       // no-op，不崩
        log.note("note-to-stdout")  // print + no-op
    }

    /// 2026-12 独立复核：叶子是符号链接时必须拒绝打开（FileHandle 会跟随链接把日志
    /// 写进目标文件；控制面 sink 用 O_NOFOLLOW 挡这一类，原生侧用同判据）。
    func testSymlinkedLeafIsRefusedInsteadOfWritingThroughTheLink() throws {
        let outside = tempDir.appendingPathComponent("outside.log")
        try Data().write(to: outside)
        let link = tempDir.appendingPathComponent(NativeShellLog.directoryName)
            .appendingPathComponent(NativeShellLog.fileName)
        try FileManager.default.createDirectory(at: link.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)
        let log = NativeShellLog(fileURL: link)
        XCTAssertFalse(log.isActive, "符号链接叶子不得打开（会被跟随写出去）")
        log.append("must-not-land-outside")
        let written = try Data(contentsOf: outside)
        XCTAssertTrue(written.isEmpty, "绝不透过符号链接写出去")
    }

    /// 目录本身是符号链接时同样拒绝（createDirectory 会接受已存在的链接）。
    func testSymlinkedDirectoryIsRefused() throws {
        let outsideDir = tempDir.appendingPathComponent("outside-dir")
        try FileManager.default.createDirectory(at: outsideDir, withIntermediateDirectories: true)
        let link = tempDir.appendingPathComponent(NativeShellLog.directoryName)
        try FileManager.default.createSymbolicLink(
            at: link, withDestinationURL: outsideDir)
        let log = NativeShellLog(fileURL: link.appendingPathComponent(NativeShellLog.fileName))
        XCTAssertFalse(log.isActive, "符号链接目录不得打开")
        log.append("must-not-land-outside")
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: outsideDir.appendingPathComponent(NativeShellLog.fileName).path),
            "绝不透过目录链接写出去")
    }

    /// 2026-12 独立复核：轮转失败不得把水位归零（那会让文件在阻塞期间涨到 ~2× 上限，
    /// 且每次写入都重试轮转）——与 TS sink 同纪律，降级为只写 stderr。
    func testRotationFailureDegradesInsteadOfGrowingToTwiceTheLimit() throws {
        XCTAssertEqual(NativeShellLog.defaultMaxBytes, 256 * 1024, "文档记录的 256 KiB 上限被钉住")
        let url = tempDir.appendingPathComponent(NativeShellLog.directoryName)
            .appendingPathComponent(NativeShellLog.fileName)
        let log = NativeShellLog(fileURL: url, maxBytes: 256)
        XCTAssertTrue(log.isActive)
        for _ in 0..<3 { log.append(String(repeating: "a", count: 48)) }
        // 目录改成不可写：removeItem/moveItem/createFile 全部失败 ⇒ 轮转失败。
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o500], ofItemAtPath: url.deletingLastPathComponent().path)
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o700], ofItemAtPath: url.deletingLastPathComponent().path)
        }
        log.append(String(repeating: "b", count: 48))
        XCTAssertFalse(log.isActive, "轮转失败必须降级为只写 stderr")
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attributes[.size] as? NSNumber)?.intValue ?? 0
        XCTAssertLessThan(size, 512, "降级后的文件不得涨到 ~2× 上限")
    }

    func testOpenFailureDegradesSilently() throws {
        // logs 路径被一个普通文件占住 → createDirectory 失败 → 只打印。
        let blocker = tempDir.appendingPathComponent(NativeShellLog.directoryName)
        try Data("not a directory".utf8).write(to: blocker)
        let log = NativeShellLog(fileURL: NativeShellLog.fileURL(userDataDir: tempDir.path))
        XCTAssertFalse(log.isActive)
        log.append("x")
        log.note("y")
    }

    // MARK: - 源码锁步：关键点必须经 shellLog 落盘

    func testKeyLifecyclePointsRouteThroughShellLog() throws {
        let appDelegate = try source("Sources/DSHChamberPoc/AppDelegate.swift")
        XCTAssertTrue(appDelegate.contains("NativeShellLog.shared.configure(userDataDir: stateDir)"),
                      "启动时必须把日志配置到 <userData>/logs（越早越好）")
        XCTAssertTrue(appDelegate.contains("log: { shellLog($0) }"),
                      "sidecar spawn/退出/重启/fatal（supervisor）必须同时落盘")
        XCTAssertTrue(appDelegate.contains("退出清理"), "退出链关键点必须存在并被 shellLog 覆盖")
        XCTAssertTrue(appDelegate.contains("shellLog(\"[native] applicationDidFinishLaunching")
            || appDelegate.contains("shellLog(\"[native] 装配完成"),
                      "启动装配行必须落盘")

        let controller = try source("Sources/DSHChamberPoc/MainWindowController.swift")
        XCTAssertTrue(controller.contains("shellLog(\"[native] 页面加载失败"),
                      "导航失败必须落盘（双击态白屏的唯一本地考古面）")
        XCTAssertTrue(controller.contains("落首载失败说明页"),
                      "首载失败页必须留一条落盘记录")
        XCTAssertTrue(controller.contains("shellLog(\"[native] 下载"))

        let updater = try source("Sources/DSHChamberPoc/AppUpdater.swift")
        XCTAssertTrue(updater.contains("shellLog(\"[native] nativeUpdatePhase"),
                      "更新相位必须落盘")
    }
}
