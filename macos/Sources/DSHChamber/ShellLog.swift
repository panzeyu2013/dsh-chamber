//
//  ShellLog.swift
//  DSHChamber
//
//  本文件提供**最小可用**的壳自身落盘日志：双击态白屏只能靠系统
//  DiagnosticReports 与 supervisor 闭包里的 stdout（LaunchServices 启动时无处
//  可看）；启动、sidecar spawn/退出、导航失败、更新相位、退出链关键点都写一份
//  到磁盘，排障时可考古。
//
//  路径与 Electron 侧的关系：
//    - 双 flavor 共享同一个 userData 根（PackagedLayout.userDataDir；design 25
//      §6.1 同根不变量，chamber-lock.test.ts 锁步）；
//    - Electron 侧自身唯一的日志目录是控制面管理的
//      <userData>/state/host-logs/<port>.log（packages/control-plane/src/
//      host-logs.ts LOG_DIR = 'host-logs'；packages/desktop/main.ts 传
//      stateDir = stateRootDir(userData) = <userData>/state）。那是**被管理 dsh
//      宿主**的 stdout/stderr 管道（按端口寻址、有 GET /api/host/logs 读侧），
//      原生壳没有那条管道（它自己就是 sidecar 的父进程），不能把壳日志塞进
//      按端口寻址的 host-logs 里冒充宿主日志。
//    - 因此壳自身日志用同根下的独立目录：<userData>/logs/shell.log。
//      Electron 无对应文件（该不对称已登记），这是新增的原生面，不冲突。
//
//  纪律：大小上限 + 单份轮转（shell.log → shell.log.1），
//  失败静默降级为 stdout（日志写不进去绝不能成为新的致命面）；0600/0700；
//  只记录已经在 stdout 上打印过的非秘密文本（路径/错误文案，绝不含凭据）。
//
import Foundation

/// 原生壳落盘日志（单例 + 可测的文件写入核心）。
public final class ShellLog {

    /// 进程级共享实例（AppDelegate 启动时 configure；未 configure 时只打印）。
    public static let shared = ShellLog()

    /// sidecar stderr 透传行的独立落盘实例。
    ///
    /// `[sidecar] <line>` 只透传到 app 的 stderr 不够：打包态从 Finder/Dock
    /// 启动时 stdout/stderr 不落盘（`log show --predicate
    /// 'process == "DSHChamber"'` 无输出），控制面最有价值的归因行
    /// （`WebSocket stream <id> closed (<cause>, Nms)`、`heartbeat lost after N
    /// unanswered ping(s)`）会丢失，事故只能靠猜。
    ///
    /// 用独立文件而不并入 shell.log：sidecar 日志的量级与轮转需求与壳
    /// 自身日志不同，混写会让 256 KiB 轮转把壳日志顶掉（Electron 侧对偶 =
    /// 控制面自己的 `<stateDir>/logs/control-plane.log`）。
    public static let sidecar = ShellLog()

    /// 相对 userData 根的目录名与文件名（纯函数 fileURL 单测钉住）。
    public static let directoryName = "logs"
    public static let fileName = "shell.log"
    /// sidecar 日志文件名（轮转名 = 文件名 + ".1"，见 rotateLocked）。
    public static let sidecarFileName = "sidecar.log"
    /// 单份轮转文件（超过上限时 shell.log 整体更名为它）。
    public static let rotatedFileName = "shell.log.1"
    /// 单文件字节上限（256 KiB；一轮排障足够，且不会无限增长）。
    public static let defaultMaxBytes = 256 * 1024
    /// configure 前缓冲上限。
    ///
    /// 启动早期的 shellLog（applicationWillFinishLaunching 的阶段日志、didFinish
    /// 顶部若干行）发生在 ShellLog.configure 之前；Finder/Dock 双击启动时 stdout
    /// 无处可看。有界缓冲在 configure/打开成功后按原顺序补写；超出上限的行丢弃
    /// （仍已打印到 stdout）并补一条截断标记。
    public static let maxPendingLines = 64
    /// 截断标记行的稳定片段（单测直测；完整行还带已丢弃行数）。
    static let pendingOverflowMarkerFragment = "configure 前日志缓冲超上限"

    private let lock = NSLock()
    private var fileURLStorage: URL?
    private var maxBytes: Int
    private var handle: FileHandle?
    private var writtenBytes = 0
    /// configure 前缓冲的**已格式化行**（含时间戳；flush 时原样补写，保序）。
    private var pendingLines: [String] = []
    /// 缓冲超上限后丢弃的行数（>0 时 flush 补一条截断标记）。
    private var droppedPendingLines = 0
    private let now: () -> Date

    private static let timestampFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    /// 日志叶子路径规则：<userData>/logs/<fileName>（纯函数，单测直测）。
    /// 崩溃诊断（CrashDiagnostics 的 shell-crash.log 与标记文件）复用本规则——
    /// 同目录同权限，绝不另立一套目录树。
    public static func fileURL(userDataDir: String, fileName: String) -> URL {
        URL(fileURLWithPath: userDataDir, isDirectory: true)
            .appendingPathComponent(directoryName, isDirectory: true)
            .appendingPathComponent(fileName)
    }

    /// 日志文件路径规则：<userData>/logs/shell.log（纯函数，单测直测）。
    public static func fileURL(userDataDir: String) -> URL {
        fileURL(userDataDir: userDataDir, fileName: fileName)
    }

    /// sidecar 日志路径规则：<userData>/logs/sidecar.log（纯函数，单测直测）。
    public static func sidecarFileURL(userDataDir: String) -> URL {
        fileURL(userDataDir: userDataDir, fileName: sidecarFileName)
    }

    /// - Parameters:
    ///   - fileURL: nil = 不落盘（只打印；单测/未配置态）。
    ///   - maxBytes: 单文件字节上限（达到即轮转）。
    ///   - now: 时间源（单测注入）。
    public init(fileURL: URL? = nil,
                maxBytes: Int = ShellLog.defaultMaxBytes,
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
    public func configure(userDataDir: String, maxBytes: Int = ShellLog.defaultMaxBytes) {
        configure(fileURL: Self.fileURL(userDataDir: userDataDir), maxBytes: maxBytes)
    }

    /// 配置 sidecar 落盘实例（AppDelegate 启动时调用；幂等）。
    public func configureSidecar(userDataDir: String, maxBytes: Int = ShellLog.defaultMaxBytes) {
        configure(fileURL: Self.sidecarFileURL(userDataDir: userDataDir), maxBytes: maxBytes)
    }

    /// 配置任意文件的落盘位置并打开（幂等：同路径已打开则不动）。打开失败静默。
    public func configure(fileURL: URL, maxBytes: Int = ShellLog.defaultMaxBytes) {
        let url = fileURL
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
        // configure 前的有界缓冲按原顺序补写（打开失败则留在缓冲里等下次）。
        lock.lock()
        flushPendingLocked()
        lock.unlock()
    }

    /// 打印 + 落盘（壳内统一出口；stdout 行保持原样）。
    public func note(_ message: String) {
        print(message)
        append(message)
    }

    /// 仅落盘（时间戳 + 原文 + 换行）；未配置/打开失败 = **有界缓冲**
    /// （见 maxPendingLines，configure 后补写），绝不抛错。
    public func append(_ message: String) {
        let line = Self.formatLine(message, at: now())
        lock.lock()
        defer { lock.unlock() }
        guard handle != nil else {
            enqueuePendingLocked(line)
            return
        }
        writeLineLocked(line)
    }

    // MARK: - 私有（lock 内约定：openCurrentFile/rotateLocked 自行加锁）

    /// 时间戳行格式（既有格式不变：`[ISO8601] 原文\n`）。
    private static func formatLine(_ message: String, at date: Date) -> String {
        "[\(timestampFormatter.string(from: date))] \(message)\n"
    }

    /// 截断标记文案（configure 前缓冲超上限时补写；丢弃行只进过 stdout）。
    static func pendingOverflowMarker(droppedCount: Int) -> String {
        "[shell-log] \(pendingOverflowMarkerFragment)：已丢弃 \(droppedCount) 行"
            + "（仅 stdout），保留最早 \(maxPendingLines) 行"
    }

    /// 已持有 lock：有界入队（超上限丢弃并计数；截断标记在 flush 时补写）。
    private func enqueuePendingLocked(_ line: String) {
        guard pendingLines.count < Self.maxPendingLines else {
            droppedPendingLines += 1
            return
        }
        pendingLines.append(line)
    }

    /// 已持有 lock 时的单行写入（append 与 configure 后的补写共用）。
    /// 写失败：关句柄降级（绝不因日志失败影响壳行为），后续行回到缓冲。
    private func writeLineLocked(_ line: String) {
        guard let handle else { return }
        do {
            try handle.write(contentsOf: Data(line.utf8))
            writtenBytes += line.utf8.count
            if writtenBytes >= maxBytes { rotateLocked() }
        } catch {
            try? handle.close()
            self.handle = nil
        }
    }

    /// 已持有 lock：把 configure 前的缓冲按原顺序补写到已打开的文件；
    /// 溢出过则在保留行之后补一条截断标记。补写中途降级 = 剩余行丢弃
    /// （与 append 同一「日志失败静默」纪律）。
    private func flushPendingLocked() {
        guard handle != nil,
              !pendingLines.isEmpty || droppedPendingLines > 0 else { return }
        let lines = pendingLines
        let dropped = droppedPendingLines
        pendingLines = []
        droppedPendingLines = 0
        for line in lines {
            guard handle != nil else { return }
            writeLineLocked(line)
        }
        guard handle != nil, dropped > 0 else { return }
        writeLineLocked(Self.formatLine(Self.pendingOverflowMarker(droppedCount: dropped),
                                        at: now()))
    }

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
        // 目录本身不得是符号链接（与控制面 log-file.ts 的目录检查同纪律）：
        // createDirectory 会接受已存在的链接，随后写入就落到壳外目录。
        if (try? FileManager.default.destinationOfSymbolicLink(atPath: directory.path)) != nil {
            return
        }
        // 叶子文件同理：FileHandle(forWritingTo:) 会跟随链接（TS sink 用 O_NOFOLLOW
        // 挡住这一类；此处用同一判据，判到即退回只写 stderr）。
        if (try? FileManager.default.destinationOfSymbolicLink(atPath: url.path)) != nil {
            return
        }
        // 打开前先轮转已超限的旧文件（不能一边追加一边超限）。rotateLocked() 成功时
        // 自己会重开新文件；**失败时它已降级**（句柄关掉）——此时必须直接返回，否则会
        // 继续打开那个超限文件，把"已降级"的 sink 又接上。
        if let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
           let size = attributes[.size] as? NSNumber, size.intValue >= maxBytes {
            rotateLocked()
            return
        }
        // 目录权限在每次打开时收紧（创建参数只对新建生效；0700 声明对已存在的
        // 松目录也成立）。best-effort。
        try? FileManager.default.setAttributes(
            [.posixPermissions: 0o700], ofItemAtPath: directory.path)
        guard let opened = openLeafLocked(url) else {
            handle = nil
            return
        }
        handle = opened
        writtenBytes = Int((try? opened.offset()).map { Int($0) } ?? 0)
        try? FileManager.default.setAttributes(
            [.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    /// 以 POSIX 语义打开日志叶子：**只接受常规文件**，且用 `O_NONBLOCK` 打开。
    ///
    /// FileHandle(forWritingTo:) 会跟随链接、也会在 FIFO 上永久阻塞——一个
    /// <userData>/logs/shell.log FIFO 就能把 applicationDidFinishLaunching 钉死在
    /// 主线程（与 TS sink 的同族缺陷；本实现必须挡住它，否则文件头注释的"日志写不
    /// 进去绝不能成为新的致命面"被直接推翻）。
    /// lstat → open(O_NOFOLLOW|O_NONBLOCK) → fstat 三段判据：FIFO/socket/设备/目录/
    /// 链接一律拒绝，lstat 与 open 之间被换掉也由 fstat 兜住。
    /// 判据本体在 `openRegularLeafFD`（实例写路径与崩溃诊断共用的唯一实现）。
    private func openLeafLocked(_ url: URL) -> FileHandle? {
        let descriptor = Self.openRegularLeafFD(url)
        guard descriptor >= 0 else { return nil }
        return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }

    /// 打开叶子常规文件的**唯一**实现（实例写路径与 CrashDiagnostics 共用）：
    /// 判据并集单源 = PrivateFS：lstat（FIFO/socket/设备/目录/
    /// 链接一律拒绝，且在 open 之前判掉——open 一个无读者的 FIFO 会永久阻塞）→
    /// open(O_NOFOLLOW|O_NONBLOCK) → fstat（常规文件 + 单硬链接 + inode 稳定性）。
    /// 返回裸 fd（调用方负责 close/包 FileHandle），-1 = 拒绝/失败
    /// （调用方降级只写 stderr：日志绝不成为新的致命面）。
    private static func openRegularLeafFD(_ url: URL) -> Int32 {
        switch PrivateFS.openLeaf(path: url.path,
                                  flags: O_WRONLY | O_APPEND | O_CREAT | O_NONBLOCK) {
        case .failure:
            return -1
        case .success(let (descriptor, _)):
            return descriptor
        }
    }

    /// 崩溃处理器专用叶子（CrashDiagnostics 安装期调用）：与实例写路径**同一套**
    /// 纪律——目录 0700（创建参数 + 每次收紧）、目录与叶子符号链接拒绝、叶子
    /// 0600、`openRegularLeafFD` 的常规文件判据——但返回**裸 fd**：信号处理器里
    /// 只能 write(2)，不许碰 FileHandle/Swift 运行时。打开发生在安装期（非信号上下文）。
    ///
    /// 与实例写路径的唯一差异 = 轮转：信号上下文不做 rename 轮转（崩溃进程写一半
    /// 就死，把记录搬去 .1 只会让启动期读不到"最近一次"），改为**安装期按上限整体
    /// 清零**——单份有界日志保留最近一次崩溃（崩溃必终止进程，故一轮至多一条）。
    /// 返回 -1 = 不可用（崩溃诊断静默降级，绝不成为新的致命面）。
    public static func openSignalSafeLeaf(url: URL, maxBytes: Int = defaultMaxBytes) -> Int32 {
        let directory = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
        } catch {
            return -1
        }
        // 目录不得是符号链接（createDirectory 会接受已存在的链接，写入就落到壳外）；
        // 叶子同理（O_NOFOLLOW 也会挡，但先在安装期判掉，读侧报错更直接）。
        if (try? FileManager.default.destinationOfSymbolicLink(atPath: directory.path)) != nil {
            return -1
        }
        if (try? FileManager.default.destinationOfSymbolicLink(atPath: url.path)) != nil {
            return -1
        }
        try? FileManager.default.setAttributes(
            [.posixPermissions: 0o700], ofItemAtPath: directory.path)
        if let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
           let size = attributes[.size] as? NSNumber, size.intValue >= max(1, maxBytes) {
            try? FileManager.default.removeItem(at: url)
        }
        let descriptor = openRegularLeafFD(url)
        guard descriptor >= 0 else { return -1 }
        try? FileManager.default.setAttributes(
            [.posixPermissions: 0o600], ofItemAtPath: url.path)
        return descriptor
    }

    /// 轮转：关闭当前 → 现文件搬到 .rotating → 删旧 .1 → .rotating 改名为 .1 →
    /// 重开空文件（先搬现文件再动备份：任何一步失败都不丢历史）。
    /// 调用方必须已持有 lock。轮转名按实例文件名派生（`<file>.1`）——main 与
    /// sidecar 两个实例共用本实现，写死主文件名会把 sidecar 轮转成
    /// `shell.log.1`（加 sidecar 实例时必须同步改的点）。
    private func rotateLocked() {
        guard let url = fileURLStorage else { return }
        try? handle?.close()
        handle = nil
        let directory = url.deletingLastPathComponent()
        let rotated = directory.appendingPathComponent(url.lastPathComponent + ".1")
        // 先把现文件搬到暂存名，**再**动备份：顺序反了会在 move 失败时把唯一的历史
        // （.1）删掉且现文件还在原地 ⇒ 备份凭空消失。
        // 任一步失败 = 降级（句柄已关），内容最坏留在 .rotating，绝不静默丢弃。
        let staging = directory.appendingPathComponent(url.lastPathComponent + ".rotating")
        try? FileManager.default.removeItem(at: staging)
        guard (try? FileManager.default.moveItem(at: url, to: staging)) != nil else {
            writtenBytes = 0
            return
        }
        try? FileManager.default.removeItem(at: rotated)
        guard (try? FileManager.default.moveItem(at: staging, to: rotated)) != nil else {
            writtenBytes = 0
            return
        }
        // 轮转成功：新文件由同一个受保护的开叶路径建立（失败 = 降级，同 TS 纪律）。
        writtenBytes = 0
        handle = openLeafLocked(url)
    }
}

/// 壳内日志统一出口：保持既有 stdout 行不变，同时落盘
/// <userData>/logs/shell.log（ShellLog.shared，AppDelegate 启动时
/// configure）。未配置/打开失败时与 print 等价——日志绝不成为新的失败面。
public func shellLog(_ message: String) {
    ShellLog.shared.note(message)
}
