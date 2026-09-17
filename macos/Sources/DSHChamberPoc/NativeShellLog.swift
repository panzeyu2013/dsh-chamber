//
//  NativeShellLog.swift
//  DSHChamberPoc
//
//  A2 收口（2026-12 双 flavor 差异复核）：macos/Sources 全树此前 0 处 os_log/
//  FileHandle——双击态白屏只能靠系统 DiagnosticReports 与 supervisor 闭包里的
//  stdout（LaunchServices 启动时无处可看）。本文件提供**最小可用**的壳自身
//  落盘日志：启动、sidecar spawn/退出、导航失败、更新相位、退出链关键点都写一份
//  到磁盘，排障时可考古。
//
//  路径与 Electron 侧的关系（**已核实，不含假主张**）：
//    - 双 flavor 共享同一个 userData 根（PackagedLayout.userDataDir；design 25
//      §6.1 同根不变量，chamber-lock.test.ts 锁步）；
//    - Electron 侧自身唯一的日志目录是控制面管理的
//      <userData>/state/host-logs/<port>.log（packages/control-plane/src/
//      host-logs.ts LOG_DIR = 'host-logs'；packages/desktop/main.ts 传
//      stateDir = stateRootDir(userData) = <userData>/state）。那是**被管理 dsh
//      宿主**的 stdout/stderr 管道（按端口寻址、有 GET /api/host/logs 读侧），
//      原生壳没有那条管道（它自己就是 sidecar 的父进程），不能把壳日志塞进
//      按端口寻址的 host-logs 里冒充宿主日志。
//    - 因此壳自身日志用同根下的独立目录：<userData>/logs/native-shell.log。
//      Electron 无对应文件（A1 已登记该不对称），这是新增的原生面，不冲突。
//
//  纪律：大小上限 + 单份轮转（native-shell.log → native-shell.log.1），
//  失败静默降级为 stdout（日志写不进去绝不能成为新的致命面）；0600/0700；
//  只记录已经在 stdout 上打印过的非秘密文本（路径/错误文案，绝不含凭据）。
//
import Foundation

/// 原生壳落盘日志（单例 + 可测的文件写入核心）。
public final class NativeShellLog {

    /// 进程级共享实例（AppDelegate 启动时 configure；未 configure 时只打印）。
    public static let shared = NativeShellLog()

    /// 相对 userData 根的目录名与文件名（纯函数 fileURL 单测钉住）。
    public static let directoryName = "logs"
    public static let fileName = "native-shell.log"
    /// 单份轮转文件（超过上限时 native-shell.log 整体更名为它）。
    public static let rotatedFileName = "native-shell.log.1"
    /// 单文件字节上限（256 KiB；一轮排障足够，且不会无限增长）。
    public static let defaultMaxBytes = 256 * 1024

    private let lock = NSLock()
    private var fileURLStorage: URL?
    private var maxBytes: Int
    private var handle: FileHandle?
    private var writtenBytes = 0
    private let now: () -> Date

    private static let timestampFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    /// 日志文件路径规则：<userData>/logs/native-shell.log（纯函数，单测直测）。
    public static func fileURL(userDataDir: String) -> URL {
        URL(fileURLWithPath: userDataDir, isDirectory: true)
            .appendingPathComponent(directoryName, isDirectory: true)
            .appendingPathComponent(fileName)
    }

    /// - Parameters:
    ///   - fileURL: nil = 不落盘（只打印；单测/未配置态）。
    ///   - maxBytes: 单文件字节上限（达到即轮转）。
    ///   - now: 时间源（单测注入）。
    public init(fileURL: URL? = nil,
                maxBytes: Int = NativeShellLog.defaultMaxBytes,
                now: @escaping () -> Date = Date.init) {
        self.fileURLStorage = fileURL
        self.maxBytes = max(1, maxBytes)
        self.now = now
        if fileURL != nil { openCurrentFile() }
    }

    /// 落盘是否生效（文件已打开）。
    public var isActive: Bool {
        lock.lock()
        defer { lock.unlock() }
        return handle != nil
    }

    /// 当前文件路径（未配置/打开失败 → nil）。
    public var filePath: String? {
        lock.lock()
        defer { lock.unlock() }
        return handle != nil ? fileURLStorage?.path : nil
    }

    /// 配置共享实例的落盘位置并打开文件（幂等：同路径已打开则不动）。
    /// 打开失败静默（note/append 仍打印）。
    public func configure(userDataDir: String, maxBytes: Int = NativeShellLog.defaultMaxBytes) {
        let url = Self.fileURL(userDataDir: userDataDir)
        lock.lock()
        if handle != nil, fileURLStorage?.path == url.path {
            lock.unlock()
            return
        }
        if let existing = handle {
            try? existing.close()
        }
        handle = nil
        fileURLStorage = url
        self.maxBytes = max(1, maxBytes)
        writtenBytes = 0
        lock.unlock()
        openCurrentFile()
    }

    /// 打印 + 落盘（壳内统一出口；stdout 行保持原样）。
    public func note(_ message: String) {
        print(message)
        append(message)
    }

    /// 仅落盘（时间戳 + 原文 + 换行）；未配置/打开失败 = no-op，绝不抛错。
    public func append(_ message: String) {
        let line = "[\(Self.timestampFormatter.string(from: now()))] \(message)\n"
        lock.lock()
        defer { lock.unlock() }
        guard let handle else { return }
        do {
            try handle.write(contentsOf: Data(line.utf8))
            writtenBytes += line.utf8.count
            if writtenBytes >= maxBytes { rotateLocked() }
        } catch {
            // 写失败：关掉句柄，退回只打印（绝不因日志失败影响壳行为）。
            try? handle.close()
            self.handle = nil
        }
    }

    // MARK: - 私有（lock 内约定：openCurrentFile/rotateLocked 自行加锁）

    private func openCurrentFile() {
        lock.lock()
        defer { lock.unlock() }
        guard handle == nil, let url = fileURLStorage else { return }
        let directory = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
        } catch {
            return
        }
        // 打开前先轮转已超限的旧文件（不能一边追加一边超限）。
        if let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
           let size = attributes[.size] as? NSNumber, size.intValue >= maxBytes {
            rotateLocked()
        }
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(
                atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        do {
            let opened = try FileHandle(forWritingTo: url)
            try opened.seekToEnd()
            handle = opened
            writtenBytes = Int((try? opened.offset()).map { Int($0) } ?? 0)
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch {
            handle = nil
        }
    }

    /// 轮转：关闭当前 → 删旧 .1 → 现文件改名为 .1 → 重开空文件。
    /// 调用方必须已持有 lock。
    private func rotateLocked() {
        guard let url = fileURLStorage else { return }
        try? handle?.close()
        handle = nil
        let rotated = url.deletingLastPathComponent()
            .appendingPathComponent(Self.rotatedFileName)
        try? FileManager.default.removeItem(at: rotated)
        try? FileManager.default.moveItem(at: url, to: rotated)
        writtenBytes = 0
        FileManager.default.createFile(
            atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
        do {
            let opened = try FileHandle(forWritingTo: url)
            try opened.seekToEnd()
            handle = opened
        } catch {
            handle = nil
        }
    }
}

/// 壳内日志统一出口：保持既有 stdout 行不变，同时落盘
/// <userData>/logs/native-shell.log（NativeShellLog.shared，AppDelegate 启动时
/// configure）。未配置/打开失败时与 print 等价——日志绝不成为新的失败面。
public func shellLog(_ message: String) {
    NativeShellLog.shared.note(message)
}
