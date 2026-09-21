//
//  PrivateFS.swift
//  DSHChamber
//
//  no-follow 私有文件纪律的唯一实现（2026-12 单源化）。
//
//  背景：三处各自实现了「私有叶文件」的打开/校验——StartupSettings.readValidatedData
//  （chamber-settings.json，只读 + inode 稳定性 + 尺寸/精确读）、ShellLog.openLeafLocked
//  （shell.log/sidecar.log，O_NONBLOCK 防 FIFO 阻塞 + 单链接）、
//  SidecarDirectoryLock.acquire（.dsh-chamber.lock，O_CREAT + 属主校验 + 0600 + flock）。
//  三处的判据互有出入（例如只有 settings 校验 inode 稳定性、只有日志检查 FIFO），
//  改一处不会同步另外两处。本文件是**判据并集**的唯一实现：
//    1. lstat（存在时）：必须是常规文件（符号链接 / FIFO / socket / 设备 / 目录拒绝）
//       且 st_nlink == 1（多硬链接叶拒绝）；
//    2. open(O_NOFOLLOW)：把「lstat 之后、打开之前叶被换成符号链接」关掉（ELOOP）；
//    3. fstat：常规文件 + st_nlink == 1（lstat 与 open 之间被换成别的 inode 时兜住）；
//    4. lstat 快照与已打开 fd 的 (st_dev, st_ino) 必须一致（叶在两步之间被替换 → 拒）；
//    5. 只读取路径额外：st_size 上限（超限拒绝而非截断）+ 读取长度 == st_size。
//
//  **任何一处调用方都不得放宽本判据**——放宽即破坏 design 25 §6.3 的
//  「与秘密文件同纪律（0600、no-follow、原子创建）」不变量。
//
//  纯 Foundation（lstat/open/fstat/read/close 经 Foundation 再导出），无状态。
//

import Foundation

/// no-follow 私有文件打开/读取（判据并集，见文件头注释）。
public enum PrivateFS {

    /// 触发 I/O 的阶段（诊断文案用）。
    public enum Stage: String, Equatable {
        case lstat
        case open
        case fstat
        case read
    }

    /// 叶文件校验失败的原因（调用方各自映射为本地化文案/降级）。
    public enum LeafError: Error, Equatable {
        /// 叶不存在（仅无 O_CREAT 的只读路径；O_CREAT 路径把缺失视为待创建）。
        case missing
        /// 符号链接叶（no-follow 纪律）。
        case symlinkRejected
        /// 非常规文件（FIFO / socket / 设备 / 目录）。
        case notRegularFile
        /// 多硬链接叶（no-follow 纪律）。
        case multipleHardLinks
        /// lstat 快照与已打开 fd 的 (dev, ino) 不一致：叶在两步之间被替换。
        case replacedBetweenStatAndOpen
        /// 系统调用失败（stage + errno）。
        case ioFailure(stage: Stage, code: Int32)
        /// 超过只读路径的尺寸上限（拒绝而非截断）。
        case tooLarge(bytes: Int64, limit: Int)
        /// 读取长度与 st_size 不一致。
        case shortRead(expected: Int, actual: Int, code: Int32)
    }

    /// 打开后（fstat）的叶快照：调用方据此做属主/权限判定。
    public struct Leaf: Equatable {
        public let device: dev_t
        public let inode: ino_t
        public let size: off_t
        public let owner: uid_t
        public let mode: mode_t
        public let linkCount: nlink_t
    }

    /// 诊断文案（StartupSettings 直接用它做 corrupt reason；其余调用方各自本地化）。
    public static func describe(_ error: LeafError) -> String {
        switch error {
        case .missing:
            return "文件不存在"
        case .symlinkRejected:
            return "符号链接叶被拒绝（no-follow 纪律）"
        case .notRegularFile:
            return "不是常规文件"
        case .multipleHardLinks:
            return "多硬链接叶被拒绝（no-follow 纪律）"
        case .replacedBetweenStatAndOpen:
            return "叶在打开前后被替换（inode 不一致）"
        case .ioFailure(let stage, let code):
            return "\(stage.rawValue) 失败（errno \(code)）"
        case .tooLarge(let bytes, let limit):
            return "文件超过 \(limit) 字节上限（实际 \(bytes)，拒绝而非截断）"
        case .shortRead(let expected, let actual, let code):
            return "读取长度与 st_size 不一致（期望 \(expected)，实际 \(actual)，errno \(code)）"
        }
    }

    /// 该错误对应的 errno 码（映射为旧实现的诊断数字；无 I/O 语义时给 0/ELOOP/ENOENT）。
    /// 命名避开全局 `errno`——同名静态方法会在本类型内部遮蔽 C 全局量。
    public static func errnoCode(for error: LeafError) -> Int32 {
        switch error {
        case .missing: return ENOENT
        case .symlinkRejected: return ELOOP
        case .ioFailure(_, let code): return code
        case .shortRead(_, _, let code): return code
        case .notRegularFile, .multipleHardLinks, .replacedBetweenStatAndOpen, .tooLarge:
            return 0
        }
    }

    /// 打开一个 no-follow 的**常规单链接叶**：
    /// - `flags` 由调用方给（O_RDONLY / O_WRONLY|O_APPEND|O_NONBLOCK / O_RDWR…），
    ///   O_NOFOLLOW 由本函数补，`creationMode` 只在 O_CREAT 时生效；
    /// - 带 O_CREAT：叶缺失 = 正常（创建）；不带：缺失 = `.missing`；
    /// - 成功返回 fd 与 fstat 快照，**fd 归调用方关闭**。
    public static func openLeaf(path: String, flags: Int32,
                                creationMode: mode_t = 0o600)
        -> Result<(fd: Int32, leaf: Leaf), LeafError> {
        let creates = (flags & O_CREAT) != 0
        var before = stat()
        var snapshot: stat?
        if lstat(path, &before) == 0 {
            let kind = before.st_mode & S_IFMT
            if kind == S_IFLNK { return .failure(.symlinkRejected) }
            guard kind == S_IFREG else { return .failure(.notRegularFile) }
            guard before.st_nlink == 1 else { return .failure(.multipleHardLinks) }
            snapshot = before
        } else if !creates {
            let code = errno
            return code == ENOENT ? .failure(.missing) : .failure(.ioFailure(stage: .lstat, code: code))
        }
        // O_CREAT 路径下 lstat 的其它错误（ENOENT 竞态、EACCES 等）不在这里失败：
        // open 会给出权威 errno（与迁移前 ShellLog/SidecarDirectoryLock 的行为一致）。
        let descriptor = open(path, flags | O_NOFOLLOW, creationMode)
        guard descriptor >= 0 else {
            let code = errno
            if !creates, code == ENOENT { return .failure(.missing) }
            return .failure(.ioFailure(stage: .open, code: code))
        }
        var opened = stat()
        guard fstat(descriptor, &opened) == 0 else {
            let code = errno
            close(descriptor)
            return .failure(.ioFailure(stage: .fstat, code: code))
        }
        guard (opened.st_mode & S_IFMT) == S_IFREG else {
            close(descriptor)
            return .failure(.notRegularFile)
        }
        guard opened.st_nlink == 1 else {
            close(descriptor)
            return .failure(.multipleHardLinks)
        }
        if let before = snapshot,
           before.st_dev != opened.st_dev || before.st_ino != opened.st_ino {
            close(descriptor)
            return .failure(.replacedBetweenStatAndOpen)
        }
        return .success((descriptor, Leaf(device: opened.st_dev, inode: opened.st_ino,
                                          size: opened.st_size, owner: opened.st_uid,
                                          mode: opened.st_mode, linkCount: opened.st_nlink)))
    }

    /// 只读路径：openLeaf(O_RDONLY | O_NONBLOCK) + 尺寸上限 + 精确长度读取。
    /// O_NONBLOCK 是对「lstat 之后叶被换成 FIFO」这一窗口的补充硬化（常规文件上无副作用）。
    public static func readLeaf(path: String, limit: Int) -> Result<Data, LeafError> {
        switch openLeaf(path: path, flags: O_RDONLY | O_NONBLOCK) {
        case .failure(let error):
            return .failure(error)
        case .success(let (descriptor, leaf)):
            defer { close(descriptor) }
            guard leaf.size <= off_t(limit) else {
                return .failure(.tooLarge(bytes: Int64(leaf.size), limit: limit))
            }
            let capacity = max(Int(leaf.size), 1)
            var buffer = [UInt8](repeating: 0, count: capacity)
            let readBytes = read(descriptor, &buffer, capacity)
            guard readBytes == Int(leaf.size) else {
                return .failure(.shortRead(expected: Int(leaf.size), actual: readBytes, code: errno))
            }
            return .success(Data(buffer[0..<max(readBytes, 0)]))
        }
    }
}
