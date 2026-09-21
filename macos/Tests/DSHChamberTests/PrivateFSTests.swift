//
//  PrivateFSTests.swift
//  DSHChamberTests
//
//  2026-12 单源化：no-follow 私有叶判据并集的锁（三处调用点
//  StartupSettings / ShellLog / SidecarDirectoryLock 共同依赖）。
//  覆盖：常规文件读取、缺失、符号链接、多硬链接、FIFO、目录、尺寸上限、
//  O_CREAT 创建与缺失语义、errno 映射。
//  （inode 替换窗口需要竞态注入，不做确定性断言；该判据由既有
//  ShellStartupTests 的稳定性用例与代码评审覆盖。）
//
import XCTest
@testable import DSHChamber

final class PrivateFSTests: XCTestCase {

    private var scratchDir: URL!

    override func setUpWithError() throws {
        scratchDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("privatefs-" + UUID().uuidString)
        try FileManager.default.createDirectory(
            at: scratchDir, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: scratchDir)
    }

    private func makeRegularFile(_ name: String, contents: Data,
                                 permissions: Int = 0o600) throws -> URL {
        let url = scratchDir.appendingPathComponent(name)
        try contents.write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: permissions],
                                              ofItemAtPath: url.path)
        return url
    }

    func testReadsRegularPrivateLeaf() throws {
        let payload = Data(#"{"keepAwake":true}"#.utf8)
        let url = try makeRegularFile("settings.json", contents: payload)
        guard case .success(let data) = PrivateFS.readLeaf(path: url.path, limit: 1 << 20) else {
            return XCTFail("常规私有叶必须可读")
        }
        XCTAssertEqual(data, payload)
    }

    func testOpenLeafReportsSnapshotForOwnerAndModeChecks() throws {
        let url = try makeRegularFile("leaf", contents: Data("x".utf8), permissions: 0o644)
        guard case .success(let (fd, leaf)) = PrivateFS.openLeaf(path: url.path, flags: O_RDONLY) else {
            return XCTFail("常规叶必须可打开")
        }
        close(fd)
        XCTAssertEqual(leaf.owner, getuid())
        XCTAssertEqual(leaf.linkCount, 1)
        XCTAssertEqual(leaf.mode & 0o777, 0o644)
        XCTAssertEqual(leaf.size, 1)
    }

    func testMissingLeafIsMissingWithoutCreate() {
        let url = scratchDir.appendingPathComponent("absent")
        guard case .failure(.missing) = PrivateFS.openLeaf(path: url.path, flags: O_RDWR) else {
            return XCTFail("无 O_CREAT 时缺失必须报 .missing")
        }
        guard case .failure(.missing) = PrivateFS.readLeaf(path: url.path, limit: 1 << 20) else {
            return XCTFail("读取路径缺失必须报 .missing")
        }
    }

    func testOpenLeafCreatesPrivateLeafWithCreate() throws {
        let url = scratchDir.appendingPathComponent("created.lock")
        guard case .success(let (fd, leaf)) = PrivateFS.openLeaf(path: url.path,
                                                                 flags: O_CREAT | O_RDWR) else {
            return XCTFail("O_CREAT 路径应创建私有叶")
        }
        close(fd)
        XCTAssertEqual(leaf.linkCount, 1)
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600,
                       "新建叶必须是 0600（秘密文件同纪律）")
    }

    func testSymlinkLeafRejected() throws {
        let target = try makeRegularFile("target", contents: Data("secret".utf8))
        let linkPath = scratchDir.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(atPath: linkPath.path,
                                                   withDestinationPath: target.path)
        guard case .failure(.symlinkRejected) = PrivateFS.readLeaf(path: linkPath.path, limit: 1 << 20) else {
            return XCTFail("符号链接叶必须被拒绝（no-follow 纪律）")
        }
        XCTAssertEqual(PrivateFS.errnoCode(for: .symlinkRejected), ELOOP)
    }

    func testHardLinkedLeafRejected() throws {
        let target = try makeRegularFile("original", contents: Data("secret".utf8))
        let linkPath = scratchDir.appendingPathComponent("hardlink")
        XCTAssertEqual(link(target.path, linkPath.path), 0, "硬链接构造失败")
        guard case .failure(.multipleHardLinks) = PrivateFS.readLeaf(path: linkPath.path, limit: 1 << 20) else {
            return XCTFail("多硬链接叶必须被拒绝（no-follow 纪律）")
        }
    }

    func testFIFOLeafRejectedWithoutBlocking() throws {
        let fifoPath = scratchDir.appendingPathComponent("fifo")
        XCTAssertEqual(mkfifo(fifoPath.path, 0o600), 0, "FIFO 构造失败")
        // 若实现漏了 lstat/O_NONBLOCK，这里会永久阻塞（测试超时即失败）。
        guard case .failure(.notRegularFile) = PrivateFS.openLeaf(path: fifoPath.path,
                                                                  flags: O_WRONLY | O_APPEND | O_CREAT) else {
            return XCTFail("FIFO 叶必须被拒绝（且不得阻塞）")
        }
        guard case .failure(.notRegularFile) = PrivateFS.readLeaf(path: fifoPath.path, limit: 1 << 20) else {
            return XCTFail("读取路径同样必须拒绝 FIFO")
        }
    }

    func testDirectoryLeafRejected() throws {
        let dir = scratchDir.appendingPathComponent("adir")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        guard case .failure(.notRegularFile) = PrivateFS.readLeaf(path: dir.path, limit: 1 << 20) else {
            return XCTFail("目录叶必须被拒绝")
        }
    }

    func testSizeLimitRejectsInsteadOfTruncating() throws {
        let url = try makeRegularFile("big.json", contents: Data(repeating: 0x7B, count: 64))
        guard case .failure(.tooLarge(let bytes, let limit)) =
            PrivateFS.readLeaf(path: url.path, limit: 16) else {
            return XCTFail("超限必须拒绝而非截断")
        }
        XCTAssertEqual(bytes, 64)
        XCTAssertEqual(limit, 16)
        // 上限内仍读得出来
        guard case .success(let data) = PrivateFS.readLeaf(path: url.path, limit: 64) else {
            return XCTFail("恰好等于上限必须放行（≤ limit）")
        }
        XCTAssertEqual(data.count, 64)
    }

    func testDescribeCoversEveryCase() {
        XCTAssertFalse(PrivateFS.describe(.missing).isEmpty)
        XCTAssertTrue(PrivateFS.describe(.symlinkRejected).contains("no-follow"))
        XCTAssertTrue(PrivateFS.describe(.multipleHardLinks).contains("硬链接"))
        XCTAssertEqual(PrivateFS.describe(.ioFailure(stage: .open, code: EACCES)),
                       "open 失败（errno \(EACCES)）")
        XCTAssertTrue(PrivateFS.describe(.tooLarge(bytes: 10, limit: 5)).contains("10"))
    }
}
