//
//  DownloadDestinationTests.swift
//  DSHChamberTests
//
//  S-26（2026-12 对齐 Electron 默认下载）：静默落盘路径的纯决策面 + 源码锁步。
//  Electron 全仓无 will-download/setSavePath ⇒ Chromium 默认静默写
//  app.getPath('downloads')，重名按 " (1)" 去重、绝不弹保存面板；Swift 侧此前
//  弹 NSSavePanel（可取消）。本文件把「静默 + 不覆盖 + 不弹面板」钉在代码上。
//
import XCTest
@testable import DSHChamber

final class DownloadDestinationTests: XCTestCase {

    private func source(_ relative: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // DSHChamberTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // macos
            .appendingPathComponent(relative)
        return try String(contentsOf: url, encoding: .utf8)
    }

    // MARK: - 文件名安全化（web 内容可指定文件名）

    func testSanitizedFileNameStripsPathsAndFallsBack() {
        XCTAssertEqual(DownloadDestination.sanitizedFileName("report.pdf"), "report.pdf")
        XCTAssertEqual(DownloadDestination.sanitizedFileName("../../etc/passwd"), "passwd")
        XCTAssertEqual(DownloadDestination.sanitizedFileName("/tmp/a/b.tar.gz"), "b.tar.gz")
        XCTAssertEqual(DownloadDestination.sanitizedFileName("a\\b.txt"), "b.txt",
                       "Windows 风格分隔同样不得逃出目标目录")
        XCTAssertEqual(DownloadDestination.sanitizedFileName(""), "download")
        XCTAssertEqual(DownloadDestination.sanitizedFileName("."), "download")
        XCTAssertEqual(DownloadDestination.sanitizedFileName(".."), "download")
        XCTAssertEqual(DownloadDestination.sanitizedFileName("   "), "download")
        XCTAssertEqual(DownloadDestination.sanitizedFileName("a\u{0}b.txt"), "ab.txt",
                       "控制字符必须剥掉")
    }

    // MARK: - 去重（Chromium " (n)" 同形；WebKit 契约要求目标文件不存在）

    func testUniqueURLKeepsNameWhenFree() {
        let url = DownloadDestination.uniqueURL(directory: URL(fileURLWithPath: "/tmp/downloads"),
                                                suggestedFilename: "a.txt",
                                                exists: { _ in false })
        XCTAssertEqual(url.path, "/tmp/downloads/a.txt")
    }

    func testUniqueURLDedupesBeforeExtension() {
        let taken: Set<String> = ["/tmp/downloads/a.txt", "/tmp/downloads/a (1).txt"]
        let url = DownloadDestination.uniqueURL(directory: URL(fileURLWithPath: "/tmp/downloads"),
                                                suggestedFilename: "a.txt",
                                                exists: { taken.contains($0) })
        XCTAssertEqual(url.path, "/tmp/downloads/a (2).txt")

        let tar = DownloadDestination.uniqueURL(
            directory: URL(fileURLWithPath: "/tmp/downloads"),
            suggestedFilename: "archive.tar.gz",
            exists: { $0 == "/tmp/downloads/archive.tar.gz" })
        XCTAssertEqual(tar.path, "/tmp/downloads/archive.tar (1).gz",
                       "重名后缀插在最后一个扩展名前（Chromium 同形）")
    }

    func testUniqueURLNeverOverwritesAndHandlesDotFiles() {
        let dot = DownloadDestination.uniqueURL(directory: URL(fileURLWithPath: "/tmp/downloads"),
                                                suggestedFilename: ".zshrc",
                                                exists: { $0 == "/tmp/downloads/.zshrc" })
        XCTAssertEqual(dot.lastPathComponent, ".zshrc (1)")

        let noExt = DownloadDestination.uniqueURL(directory: URL(fileURLWithPath: "/tmp/downloads"),
                                                  suggestedFilename: "LICENSE",
                                                  exists: { $0 == "/tmp/downloads/LICENSE" })
        XCTAssertEqual(noExt.lastPathComponent, "LICENSE (1)")
    }

    func testUniqueURLFallsBackToUUIDRatherThanOverwrite() {
        let url = DownloadDestination.uniqueURL(directory: URL(fileURLWithPath: "/tmp/downloads"),
                                                suggestedFilename: "a.bin",
                                                exists: { _ in true },
                                                maxAttempts: 3)
        XCTAssertNotEqual(url.path, "/tmp/downloads/a.bin")
        XCTAssertTrue(url.lastPathComponent.hasPrefix("a ("))
        XCTAssertTrue(url.lastPathComponent.hasSuffix(").bin"))
    }

    // MARK: - 目录决策（WebKit 契约：目录必须存在且可写）

    func testDestinationReturnsNilWithoutDirectory() {
        XCTAssertNil(DownloadDestination.destination(directory: nil,
                                                     suggestedFilename: "x.txt",
                                                     exists: { _ in false }),
                     "解析不到下载目录 = 诚实失败（调用方 completionHandler(nil)）")
    }

    func testDestinationFailsHonestlyWhenDirectoryCannotBePrepared() {
        XCTAssertNil(DownloadDestination.destination(
            directory: URL(fileURLWithPath: "/tmp/downloads"),
            suggestedFilename: "x.txt",
            exists: { _ in false },
            createDirectory: { _ in false }),
            "目录建不出来 → nil，绝不静默换路径")
    }

    func testDestinationPreparesDirectoryThenPicksUniqueName() {
        var prepared: [URL] = []
        let directory = URL(fileURLWithPath: "/tmp/downloads")
        let url = DownloadDestination.destination(
            directory: directory,
            suggestedFilename: "x.txt",
            exists: { $0 == "/tmp/downloads/x.txt" },
            createDirectory: { prepared.append($0); return true })
        XCTAssertEqual(prepared, [directory], "目录缺失时必须先确保存在（WebKit 契约）")
        XCTAssertEqual(url?.path, "/tmp/downloads/x (1).txt")
    }

    func testDefaultDirectoryMirrorsElectronDownloadsPath() {
        // 不硬编码 "Downloads" 段名：用户可以把下载目录改到别处（FileManager 与
        // Electron app.getPath('downloads') 读的是同一个系统偏好，值本身随人）。
        let directory = DownloadDestination.defaultDirectory()
        XCTAssertNotNil(directory, "FileManager 的下载目录必须可解析（Electron app.getPath('downloads') 对偶）")
        XCTAssertTrue(directory?.isFileURL ?? false)
        XCTAssertTrue(directory?.path.hasPrefix("/") ?? false)
    }

    // MARK: - 源码锁步：不再有保存面板，走静默落盘

    func testMainWindowControllerUsesSilentDownloadPathOnly() throws {
        let source = try source("Sources/DSHChamber/MainWindowController.swift")
        XCTAssertFalse(source.contains("NSSavePanel"),
                       "S-26：下载绝不弹保存面板（Electron 默认下载没有面板）")
        XCTAssertFalse(source.contains("保存对话框对偶"),
                       "禁止再声称 NSSavePanel 是 Electron 默认例程的对偶（假主张）")
        XCTAssertTrue(source.contains("DownloadDestination.defaultDirectory()"),
                      "下载目录必须取 Electron 等价的下载目录")
        XCTAssertTrue(source.contains("DownloadDestination.destination("),
                      "落盘目标必须经静默决策（去重 + 目录准备）")
        XCTAssertTrue(source.contains("reservedDownloadPaths"),
                      "同批并发下载必须相互避让（WebKit 要求目标文件决策时不存在）")
        XCTAssertTrue(source.contains("静默落盘"),
                      "注释必须写明这是与 Electron 等价的静默路径")
    }

    func testDownloadDestinationDocumentsWebKitContract() throws {
        let source = try source("Sources/DSHChamber/DownloadDestination.swift")
        XCTAssertTrue(source.contains("must be a file that does not")
            && source.contains("exist in a directory that does exist"),
            "必须记下 WebKit 契约（目标文件不存在、目录存在）")
        XCTAssertTrue(source.contains("downloadsDirectory"),
                      "默认目录 = FileManager .downloadsDirectory（Electron app.getPath('downloads') 对偶）")
    }
}
