//
//  SidecarSupervisor.swift
//  DSHChamberPoc
//
//  W-15（design 25 §3.3(1)(4)/§6.3；todo companion W-15）。职责三件：
//   1. 目录锁：Swift 壳在 spawn 之前对 <userData>/.dsh-chamber.lock 取
//      flock(LOCK_EX|LOCK_NB) 独占（design 25 §6.3 B2——sidecar-entry 只读
//      锁记录复验父 pid，**不二次 flock**），并把记录写成 JSON {pid, startedAt,
//      shell}；记录里的 pid 是 sidecar-entry 双 flavor 并发判据（它读 pid 后
//      kill(pid,0) 探活）。锁随进程退出由内核释放，不依赖清理钩子。
//   2. 进程守护：spawn sidecar；**运行中崩溃/非零退出 → 退避重启**（策略与
//      renderer 恢复参数化同族：500ms 首延迟 + 60s 滚动窗口 ≤3 次，超限停止
//      自动恢复并 loud 上报）；**spawn 失败 = fatal**（不重启，design 25
//      §3.3(4)「cp.start 失败 = fatal 退出」）；退出码 3 = 目录锁被另一 flavor
//      占用（sidecar-entry 语义）→ fatal，绝不重启（否则死循环）。
//   3. 退出码分级：0 = 非我方停止的自然退出（sidecar 自行优雅退出，例如
//      stdin EOF）→ 不重启、loud 记录；其余非零 = 崩溃 → 退避重启。
//
//  可测性（W-15 验收「XCTest（假进程起停/backoff）」）：进程经
//  SupervisedSidecar 协议注入（真实实现 = BridgeClient），退避经
//  schedule 注入（测试用立即执行或手工触发），策略是纯值逻辑
//  （SidecarRestartPolicy，独立单测）。
//

import Foundation

// MARK: - 目录锁（design 25 §6.3）

/// `<userData>/.dsh-chamber.lock` 的 flock 独占持有者（进程级单例语义：同一
/// 进程二次 acquire 会因 flock 对独立 open 描述符的互斥而失败——同机双 flavor
/// 与同进程重复装配都被挡）。
public final class SidecarDirectoryLock {
    public struct Record: Equatable {
        public var pid: Int32
        public var startedAt: Double
        public var shell: String
        public init(pid: Int32, startedAt: Double, shell: String) {
            self.pid = pid
            self.startedAt = startedAt
            self.shell = shell
        }
    }

    public enum LockError: Error, CustomStringConvertible {
        /// 锁被另一进程持有（pid 为记录值；记录缺失/不可解析时为 nil）。
        case heldByAnotherProcess(pid: Int32?)
        case ioFailure(String)

        public var description: String {
            switch self {
            case .heldByAnotherProcess(let pid):
                let who = pid.map { "pid=\($0)" } ?? "pid=未知"
                return "目录锁被占用（\(who)）——另一 flavor/实例正在使用该 userData，拒绝启动"
            case .ioFailure(let detail):
                return "目录锁 I/O 失败：\(detail)"
            }
        }
    }

    /// 锁记录文件绝对路径（sidecar-entry 读取同一路径）。
    public let recordPath: String
    private let lock: NSLock = NSLock()
    private var fd: Int32 = -1

    public init(userDataDir: String) {
        self.recordPath = (userDataDir as NSString).appendingPathComponent(".dsh-chamber.lock")
    }

    /// 已持锁（成功 acquire 且未 release）。
    public var isHeld: Bool {
        lock.lock()
        defer { lock.unlock() }
        return fd >= 0
    }

    /// 取锁 + 写记录。幂等：已持锁直接返回。失败抛 LockError（调用方 fatal）。
    public func acquire(shell: String = "swift", now: Double = Date().timeIntervalSince1970) throws {
        lock.lock()
        defer { lock.unlock() }
        guard fd < 0 else { return }

        let dir = (recordPath as NSString).deletingLastPathComponent
        do {
            try FileManager.default.createDirectory(
                atPath: dir, withIntermediateDirectories: true)
        } catch {
            throw LockError.ioFailure("mkdir \(dir) 失败：\(error.localizedDescription)")
        }

        let opened = open(recordPath, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard opened >= 0 else {
            // O_NOFOLLOW：路径被替换成符号链接 → ELOOP，fail-closed（design 25
            // §6.3 与秘密文件同纪律：0600、no-follow、原子创建）。
            throw LockError.ioFailure("open \(recordPath) 失败（errno=\(errno)）")
        }
        // 规整文件 + 属主校验 + 收紧权限（既有文件可能带宽松 mode）。
        var info = stat()
        if fstat(opened, &info) != 0 || (info.st_mode & S_IFMT) != S_IFREG {
            close(opened)
            throw LockError.ioFailure("锁文件非规整文件（fail-closed）：\(recordPath)")
        }
        if info.st_uid != getuid() {
            close(opened)
            throw LockError.ioFailure("锁文件属主异常（uid=\(info.st_uid)）：\(recordPath)")
        }
        if (info.st_mode & 0o777) != 0o600 {
            _ = fchmod(opened, 0o600)
        }
        if flock(opened, LOCK_EX | LOCK_NB) != 0 {
            // 先读占用者记录再关闭（记录内容仅用于诊断文案）。
            let holder = Self.readRecord(at: recordPath)?.pid
            close(opened)
            throw LockError.heldByAnotherProcess(pid: holder)
        }

        // 写记录（截断重写；sidecar-entry 只读 pid 字段，多余字段前向兼容）。
        let record = Record(pid: getpid(), startedAt: now, shell: shell)
        do {
            let data = try JSONSerialization.data(withJSONObject: [
                "pid": Int(record.pid),
                "startedAt": record.startedAt,
                "shell": record.shell,
            ])
            _ = ftruncate(opened, 0)
            _ = lseek(opened, 0, SEEK_SET)
            let written = data.withUnsafeBytes { buffer -> Int in
                guard let base = buffer.baseAddress else { return 0 }
                return write(opened, base, data.count)
            }
            guard written == data.count else {
                throw LockError.ioFailure("写锁记录短写（\(written)/\(data.count)）")
            }
        } catch let error as LockError {
            flock(opened, LOCK_UN)
            close(opened)
            throw error
        } catch {
            flock(opened, LOCK_UN)
            close(opened)
            throw LockError.ioFailure("锁记录序列化失败：\(error.localizedDescription)")
        }

        fd = opened
    }

    /// 释放锁（幂等）。锁记录文件保留（内容仅供诊断；独占权由 flock 决定）。
    public func release() {
        lock.lock()
        defer { lock.unlock() }
        guard fd >= 0 else { return }
        flock(fd, LOCK_UN)
        close(fd)
        fd = -1
    }

    deinit {
        release()
    }

    /// 读取锁记录（诊断用；不存在/不可解析 → nil）。
    public static func readRecord(at path: String) -> Record? {
        guard let data = FileManager.default.contents(atPath: path),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        guard let pidNumber = object["pid"] as? NSNumber else { return nil }
        let startedAt = (object["startedAt"] as? NSNumber)?.doubleValue ?? 0
        let shell = object["shell"] as? String ?? ""
        return Record(pid: pidInt32(pidNumber), startedAt: startedAt, shell: shell)
    }

    private static func pidInt32(_ number: NSNumber) -> Int32 {
        let value = number.int64Value
        if value > Int64(Int32.max) { return Int32.max }
        if value < Int64(Int32.min) { return Int32.min }
        return Int32(value)
    }
}

// MARK: - 重启退避策略（纯逻辑）

/// sidecar 崩溃重启退避（design 25 §3.3(4)「上限与 renderer 恢复参数化同族」）：
/// 首次延迟 `delay`，`window` 滚动窗口内至多 `maxRestarts` 次；超限 → giveUp
/// （调用方 loud 上报 + 停止自动恢复，绝不无限重启）。
public struct SidecarRestartPolicy: Equatable {
    public var delay: TimeInterval
    public var window: TimeInterval
    public var maxRestarts: Int

    public init(delay: TimeInterval = 0.5, window: TimeInterval = 60, maxRestarts: Int = 3) {
        self.delay = delay
        self.window = window
        self.maxRestarts = maxRestarts
    }

    public enum Decision: Equatable {
        case restart(after: TimeInterval, attempt: Int)
        case giveUp(attempts: Int)
    }

    /// 依据历史重启时间戳（秒）与当前时刻决策；命中 restart 时把本次计入
    /// `attempts`（调用方传入 inout 数组，窗口外的旧记录自动淘汰）。
    public func decide(now: Double, attempts: inout [Double]) -> Decision {
        attempts = attempts.filter { now - $0 < window }
        if attempts.count >= maxRestarts {
            return .giveUp(attempts: attempts.count)
        }
        attempts.append(now)
        return .restart(after: delay, attempt: attempts.count)
    }
}

// MARK: - 被守护的进程抽象

/// sidecar 进程最小面（真实实现 = BridgeClient；测试 = 假进程）。
/// 方法名与 BridgeClient 现有 API 同名，BridgeClient 以空扩展即符合。
public protocol SupervisedSidecar: AnyObject {
    var isRunning: Bool { get }
    /// 自然终止回调（terminationStatus）；stop() 主动停止不触发。
    var onTerminated: ((Int32) -> Void)? { get set }
    func start() throws
    func stop()
}

// MARK: - Supervisor

/// sidecar 守护者（design 25 §3.3 启动序列 1–4）。
public final class SidecarSupervisor {
    public enum State: Equatable {
        case idle
        case running
        case restarting
        case fatal
        case stopped
    }

    public struct Dependencies {
        /// 进程工厂（每次重启新建；测试注入假进程）。
        public var makeSidecar: () -> SupervisedSidecar
        public var policy: SidecarRestartPolicy
        /// 延迟调度（测试可立即执行或手工触发；缺省 = DispatchQueue.main.asyncAfter）。
        public var schedule: (TimeInterval, @escaping () -> Void) -> Void
        public var log: (String) -> Void
        /// 不可恢复（spawn 失败 / 锁冲突 / 重启耗尽）→ 应用层分流 NSAlert。
        public var onFatal: ((String) -> Void)?
        /// 每次排定重启（观测/测试用）。
        public var onRestartScheduled: ((Int, TimeInterval) -> Void)?

        public init(
            makeSidecar: @escaping () -> SupervisedSidecar,
            policy: SidecarRestartPolicy = SidecarRestartPolicy(),
            schedule: @escaping (TimeInterval, @escaping () -> Void) -> Void = { delay, work in
                DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
            },
            log: @escaping (String) -> Void = { print($0) },
            onFatal: ((String) -> Void)? = nil,
            onRestartScheduled: ((Int, TimeInterval) -> Void)? = nil
        ) {
            self.makeSidecar = makeSidecar
            self.policy = policy
            self.schedule = schedule
            self.log = log
            self.onFatal = onFatal
            self.onRestartScheduled = onRestartScheduled
        }
    }

    public let directoryLock: SidecarDirectoryLock
    private let deps: Dependencies
    private let stateLock: NSLock = NSLock()

    private var sidecar: SupervisedSidecar?
    private var attempts: [Double] = []
    /// 重启代际：stop()/每次新排定递增，迟到的调度闭包据此作废。
    private var generation: Int = 0
    /// 启动代际（2026-09 三审 #5）：每次 launch 递增；任何终止与 stop() 也递增
    /// ——在途 launch 据此判断「我的进程是否已经被终止/被 stop 取代」，绝不把
    /// 已死进程发布为 .running，也绝不覆盖同一次死亡得出的 .fatal 决策。
    private var launchGeneration: Int = 0
    private var stopping = false
    private var stateStorage: State = .idle

    public init(directoryLock: SidecarDirectoryLock, dependencies: Dependencies) {
        self.directoryLock = directoryLock
        self.deps = dependencies
    }

    public var state: State {
        stateLock.lock()
        defer { stateLock.unlock() }
        return stateStorage
    }

    /// 取目录锁 → spawn sidecar。spawn 失败 = fatal（抛错，调用方退出）。
    @discardableResult
    public func start() throws -> State {
        stateLock.lock()
        guard !stopping else {
            stateLock.unlock()
            return .stopped
        }
        guard sidecar == nil else {
            stateLock.unlock()
            return stateStorage
        }
        stateLock.unlock()

        do {
            try directoryLock.acquire()
        } catch {
            let message = (error as? SidecarDirectoryLock.LockError)?.description
                ?? error.localizedDescription
            markFatal(message)
            throw error
        }
        deps.log("[supervisor] 目录锁已持有：\(directoryLock.recordPath)")

        return try launch(isRestart: false)
    }

    /// 主动停止：取消在途重启 → 停进程 → 释放锁。幂等。
    public func stop() {
        stateLock.lock()
        stopping = true
        generation += 1
        launchGeneration += 1
        let current = sidecar
        sidecar = nil
        stateStorage = .stopped
        stateLock.unlock()

        current?.onTerminated = nil
        current?.stop()
        directoryLock.release()
        deps.log("[supervisor] 已停止（进程已回收、目录锁已释放）")
    }

    // MARK: - 内部

    private func launch(isRestart: Bool) throws -> State {
        let created = deps.makeSidecar()
        stateLock.lock()
        launchGeneration += 1
        let token = launchGeneration
        stateLock.unlock()
        created.onTerminated = { [weak self, weak created] status in
            self?.handleTermination(sidecar: created, status: status)
        }
        do {
            try created.start()
        } catch {
            created.onTerminated = nil
            let message = "sidecar 启动失败：\(error.localizedDescription)"
            markFatal(message)
            throw error
        }

        stateLock.lock()
        // 提交门（#5）：只有「未被 stop、代际未变、且尚无已提交 sidecar」时才
        // 发布 .running。否则进程在 start 期间已终止（handleTermination 递增
        // 了 launchGeneration 并可能已 fatal），或 stop() 已到达——此时必须
        // 回收进程并保留既有状态，绝不覆盖。
        guard !stopping, token == launchGeneration, sidecar == nil else {
            let reason = stopping ? "stop() 在启动期间到达" : "进程在提交前已终止"
            stateLock.unlock()
            created.onTerminated = nil
            created.stop()
            deps.log("[supervisor] 启动作废（\(reason)）——已回收进程，不发布 .running")
            return state
        }
        sidecar = created
        stateStorage = .running
        stateLock.unlock()
        deps.log(isRestart
            ? "[supervisor] sidecar 已重启（attempt=\(currentAttemptCount)）"
            : "[supervisor] sidecar 已启动")
        return .running
    }

    private var currentAttemptCount: Int {
        stateLock.lock()
        defer { stateLock.unlock() }
        return attempts.count
    }

    private func handleTermination(sidecar instance: SupervisedSidecar?, status: Int32) {
        stateLock.lock()
        // 任何终止都作废在途 launch（#5）。
        launchGeneration += 1
        if stopping {
            stateLock.unlock()
            return
        }
        // 只有「已提交的当前进程」才算运行时退出；启动期退出（尚未提交）不
        // 走重启退避——那是启动失败（#7 分级）。
        let committed = instance != nil && sidecar === instance
        if committed {
            sidecar = nil
        }
        let policy = deps.policy
        let now = Date().timeIntervalSince1970
        let decision = policy.decide(now: now, attempts: &attempts)
        stateLock.unlock()

        deps.log("[supervisor] sidecar 退出：status=\(status)"
            + (committed ? "" : "（启动期退出，未提交）"))

        if !committed {
            markFatal("sidecar 启动期退出（status=\(status)）——启动失败，不自动重启")
            return
        }

        // 退出码分级（design 25 §3.3(4)/B7）：3 = 目录锁被另一 flavor 占用
        // （sidecar-entry 语义）→ fatal 不重启（重启必再撞同一锁，死循环）；
        // 0 = 非我方停止的自然退出 → 不重启（loud 记录）；其余非零 = 崩溃。
        if status == 3 {
            markFatal("sidecar 检测到目录锁被另一实例占用（exit=3）——请关闭另一 flavor 后重试")
            return
        }
        // 70 = sidecar 启动失败（控制面启动 / 装配期，sidecar-entry
        // EXIT_STARTUP_FAILURE）——按启动失败 fatal，不做崩溃退避重启
        // （2026-09 三审 #7：原先与运行期崩溃同为 exit 1）。
        if status == 70 {
            markFatal("sidecar 启动失败（exit=70）——请检查控制面/装配配置后重试")
            return
        }
        if status == 0 {
            stateLock.lock()
            stateStorage = .stopped
            stateLock.unlock()
            deps.log("[supervisor] sidecar 自行优雅退出（exit=0），不自动重启")
            return
        }

        switch decision {
        case .giveUp(let count):
            markFatal("sidecar 连续崩溃 \(count) 次（\(Int(policy.window))s 窗口），已停止自动恢复")
        case .restart(let delay, let attempt):
            stateLock.lock()
            stateStorage = .restarting
            generation += 1
            let token = generation
            stateLock.unlock()
            deps.onRestartScheduled?(attempt, delay)
            deps.log("[supervisor] \(String(format: "%.2f", delay))s 后重启 sidecar（attempt=\(attempt)）")
            deps.schedule(delay) { [weak self] in
                self?.performScheduledRestart(token: token, attempt: attempt)
            }
        }
    }

    private func performScheduledRestart(token: Int, attempt: Int) {
        stateLock.lock()
        let valid = !stopping && token == generation
        stateLock.unlock()
        guard valid else {
            deps.log("[supervisor] 迟到的重启调度作废（token=\(token)）")
            return
        }
        do {
            _ = try launch(isRestart: true)
        } catch {
            // launch 已 markFatal（spawn 失败 = fatal）。
            deps.log("[supervisor] 重启失败（attempt=\(attempt)）：\(error.localizedDescription)")
        }
    }

    private func markFatal(_ message: String) {
        stateLock.lock()
        stateStorage = .fatal
        stateLock.unlock()
        deps.log("[supervisor] fatal：\(message)")
        deps.onFatal?(message)
    }
}

// MARK: - BridgeClient 适配

extension BridgeClient: SupervisedSidecar {}
