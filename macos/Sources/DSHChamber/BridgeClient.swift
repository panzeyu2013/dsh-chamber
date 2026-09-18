// BridgeClient.swift —— B 桥进程客户端（Swift 侧 spawn + NDJSON 读写 + invoke）
//
// design 25 §4.4.2（B 桥 Swift ↔ sidecar）与 W-05（垂直切片，
// design 25 §4.4.2）的 Swift 侧实现。AppDelegate
// 与 MessageHandler 作者按本文件的公开契约引用（构造/start/stop/invoke/
// onEvent），勿改名。
//
// 进程模型（design 25 §3.1）：Swift 应用是客户端、sidecar（打包 Node +
// JS bundle；dev = `node packages/desktop/sidecar-entry.ts`、装配态 =
// `sidecar.js`，见 AppDelegate.sidecarRelativePath）是服务端——
//   - stdout 是**唯一协议流**（NDJSON 帧：request/response/event，行协议）；
//   - stderr 是**唯一日志通道**（D2：sidecar-entry 会把存量 console.* 重定向
//     到 stderr，本客户端逐行透传到自己的标准错误，前缀 "[sidecar] "）；
//     协议行若仍泄漏到 stdout（重定向后 = 违约）→ fail-loud 打印 + 丢弃，
//     绝不静默继续（design 25 §4.4.2 护栏条）。
//   - 帧长上限 = FrameCodec.maxFrameBytes（4 MiB，与 TrustGuard 同源）。
//   - **无握手帧**：start() 后不发任何帧——协议没有握手语义；真实 sidecar
//     （sidecar-entry.ts）起动完成后主动输出 ready notify {port,shellVersion}
//     （M3 W-15/16 起经 onReady 消费；design 25 §3.3 启动序列由上层编排）。
//   - **出站面（sidecar → Swift；M3 W-15/16）**：sidecar 的宿主腿
//     （node-edges.ts）会把 NOTIFY 类通道的宿主动作转成 B 桥线协议上的
//     **edge 请求** {"edge":method,"payload":…,"edgeId":N}（期待应答
//     {"edgeId":N,"ok":true,"result":…} | {"edgeId":N,"ok":false,"error":…}——
//     sidecar 侧 pendingEdges 无超时，Swift 不应答 = 永久挂起）与 **notify
//     单向帧** {"notify":event,"payload":…}（ready/rendererPush 等）。这两族
//     帧既无 id 也无 event 键，FrameCodec.decodeLine 按容忍语义归 nil——
//     M3 前的本文件会把它们当非协议行 loud 丢弃；现由本文件的
//     decodeOutboundFrame 在 BridgeClient 层先行分类（不改 FrameCodec，
//     注释见该函数），edge 经 v1 默认应答策略（defaultEdgeResponse /
//     setDefaultEdgeResponder）或自定义 onEdgeRequest 必答、绝不挂起。
//   - sidecar 仍从不发起带 id+method 的 request 帧（B 桥 id 所有权恒在
//     Swift 侧）；万一收到仍 loud 丢弃（见 handleIncomingLine .request）。
//
// id 纪律与并发模型：
//   - id 自 1 起单调递增（NSLock 保护）；sidecar 原样 echo，pending 字典
//     以 id 为键把响应配对回发起时的 continuation——**id 的所有权 = pending
//     字典条目**：谁在锁内 removeValue 成功，谁负责 resume（恰好一次）。
//   - 写帧 = **writeLock 串行**（2026-09 模块评审 minor：此前实际是锁外写，
//     并发 invoke / edge 应答可在同一 FileHandle 上交错；现由独立 writeLock
//     包住每次 write，单帧 ≤4 MiB）。帧率低、sidecar readline 持续消费，
//     背压罕见；极端背压会阻塞调用线程——P1 换专用串行写队列 + stop 前显式
//     排空（design 25 §3.3 退出链 5s 硬顶前需可证明无 in-flight 写）。
//   - **帧回调**（onEvent/onNotify/onReady/onEdgeRequest/响应分发）在**管道读取
//     线程**（Foundation 内部队列）或**终止收尾线程**（handleTermination →
//     finish*Reading 抽干残帧）回调，均为非主线程；两条路径的派发经 dispatchLock
//     串行（**回调绝不并发进入**），stderr 中继不参与该锁（独立线程 + stderrLock，
//     日志写阻塞不拖住协议帧）。切行在 readerLock 内串行，收尾只在会话代际匹配且
//     EOF 未置位时生效，故同一帧只派发一次；正常路径按切行顺序派发，正常路径与
//     收尾抽干之间的**跨路径相对顺序**不承诺（收尾发生在 EOF/进程终止之后）。
//     `onTerminated`（SIGCHLD 线程）在 dispatchLock 内回调，故**也不与帧回调并发**；
//     其内同一线程同步 start() 同一实例被 lifecycleLock（递归）允许，异线程则等到
//     回调返回。**订阅者回调必须短小**：它在 dispatchLock（+终止路径的 lifecycleLock）
//     内执行，慢回调会拖住帧派发。订阅方仍应只读快照或自行 hop 主线程
//     （MainWindowController 以 Task { @MainActor } 收敛，MessageHandler 注释同款声明）。
//   - **生命周期过渡互斥**：start() / stop() / handleTermination 全程持
//     lifecycleLock（递归）：过渡期间不可能发布新会话，也不存在「旧收尾作用于新
//     会话」或「stop 快路径撞自然死亡收尾」的窗口；start() 有界等待（超时抛 code 6）。
//   - **全局锁序**：dispatchLock → lifecycleLock → lock →（readerLock | stderrLock）。
//     任何新增路径都必须按此偏序取锁（反例：先在 lifecycleLock 下等 dispatchLock，
//     会与「帧回调内 stop()」成环——已由独立验证者探针复现，务必保持）。
//     本类自身对 pending 配对（lock + removeValue 所有权，按登记代际分桶结算）与
//     edge 应答（帧代际透传 + 有界守卫，写失败回滚）保证恰好一次。
//
// 本文件为纯 Foundation（无 AppKit/WebKit；kill/SIGKILL/SIGPIPE 等 Darwin
// 符号经 Foundation 再导出直接可用，无需额外 import）；Swift 5 语言模式；
// macOS 14.4+（支持矩阵下限，见 deviations S-30）。

import Foundation

/// B 桥 stdout/stderr 的行缓冲读取器：Data 积累 + 按 \n 切分（兼容 \r\n），
/// **输出原始字节**（R2：不在读取器里物化 String——stdout 直接喂 JSONSerialization，
/// 省掉每帧 Data→String→Data 一次完整往返；UTF-8 合法性由消费方判定；跨 read
/// 块的多字节序列仍不会被腰斩）。
///
/// 线程契约：同一实例只允许单线程串行驱动 append；finish() 允许在另一线程
/// 调用（BridgeClient 里 stdout/stderr 读取回调与终止收尾竞争，统一经 readerLock
/// + EOF 标志串行化）。纯值语义，无副作用，便于 XCTest 直测。
struct LineReader {

    /// 一次 append/finish 的结果：完整行 + 违约计数（只数不喊——打印与
    /// 丢弃由调用方 loud 完成，本类型保持纯）。
    struct Outcome {
        /// 完整行（空行保留；\r\n 已去 \r）——**原始字节**，不做 UTF-8 判定。
        var lines: [Data] = []
        var overflowResets = 0          // 无换行缓冲超上限：清缓冲重同步并计数
    }

    /// 无换行缓冲上限：超过即丢弃部分缓冲重新同步（配合帧长上限；默认与
    /// FrameCodec.maxFrameBytes 同值 4 MiB）。
    private let maxBufferedBytes: Int
    private var buffer = Data()
    /// 未消费字节起点（Phase 2 C5，**绝对索引**）：每行切分只推进游标，append
    /// 末尾才压实一次（旧实现每切一行 removeSubrange 一次 = O(n·k) 字节搬移）。
    /// Data 的 `removeFirst`/切片会推进 `startIndex` 而不回零，故游标必须是
    /// 绝对索引、压实后重置为 `buffer.startIndex`；溢出判定用未消费窗口
    /// `buffer.endIndex - cursor`。
    private var cursor: Data.Index = 0
    /// 已确认「不含换行」的区间右界（绝对索引）。C2 增量扫描：append 只从
    /// max(cursor, scannedUpTo) 起找换行，避免每次 append 重扫整个未消费窗口
    /// （审查者 C 实测 4MiB 单行 851ms → 7.7ms；旧行为是 O(window²/chunk)）。
    private var scannedUpTo: Data.Index = 0
    /// 超限重同步后置位：下一条换行前的字节仍属被丢弃的超长行，整段吞掉、
    /// 绝不上抛（否则残片可能被当合法帧派发，B-BUG-1 的 forged suffix）。
    private var discardingUntilNewline = false
    private var finished = false

    init(maxBufferedBytes: Int = FrameCodec.maxFrameBytes) {
        self.maxBufferedBytes = maxBufferedBytes
    }

    /// 追加一段读到的字节，返回由此切出的完整行（不含行尾 \n）。
    mutating func append(_ data: Data) -> Outcome {
        var outcome = Outcome()
        guard !finished else { return outcome }   // EOF 后拒收（防御）
        buffer.append(data)
        drain(into: &outcome)
        return outcome
    }

    /// EOF 收尾：把未换行的残余字节当作最后一行处理（行协议以 \n 结尾，
    /// 无 \n 残尾属违约行，照常上抛由调用方 loud）；空残尾不产生行。
    /// 幂等：第二次调用起返回空 Outcome。
    mutating func finish() -> Outcome {
        var outcome = Outcome()
        guard !finished else { return outcome }
        finished = true
        drain(into: &outcome, emitPartialTail: true)
        return outcome
    }

    /// 自缓冲切出全部完整行。emitPartialTail 时把切剩的无换行残余也作为
    /// 一行输出（EOF 语义）。
    private mutating func drain(into outcome: inout Outcome, emitPartialTail: Bool = false) {
        var searchStart = max(cursor, scannedUpTo)
        while let newline = buffer[searchStart...].firstIndex(of: 0x0A) {
            let lineData = buffer[cursor..<newline]
            cursor = newline + 1
            searchStart = cursor
            if discardingUntilNewline {
                // 被丢弃超长行的剩余部分到此结束：吞掉，不上抛。
                discardingUntilNewline = false
            } else {
                appendLine(lineData, into: &outcome)
            }
        }
        // 扫描已覆盖到当前末尾：这些字节确认不含换行，下次 append 从新字节起扫。
        scannedUpTo = buffer.endIndex
        if emitPartialTail, cursor < buffer.endIndex {
            let tail = buffer[cursor...]
            buffer.removeAll(keepingCapacity: true)
            cursor = buffer.startIndex
            scannedUpTo = buffer.startIndex
            if discardingUntilNewline {
                discardingUntilNewline = false   // EOF：被丢弃行的残尾同样不上抛
            } else {
                appendLine(tail, into: &outcome)
            }
        } else if buffer.endIndex - cursor > maxBufferedBytes {
            // 海量无换行数据（协议违约流，永远切不出行）→ 清缓冲重新同步，
            // 防内存无限增长；计数交调用方 loud（并作废未决请求，B-BUG-1）。
            // 判据是**未消费窗口**：已切出的行不参与（BridgeClientLineReadTests
            // 钉住「有换行的超长行不算无换行溢出」）。重同步后必须继续吞到下一个
            // 换行：否则被丢弃行的残尾会作为独立行上抛。
            buffer.removeAll(keepingCapacity: true)
            cursor = buffer.startIndex
            scannedUpTo = buffer.startIndex
            discardingUntilNewline = true
            outcome.overflowResets += 1
        } else {
            compact()
        }
    }

    /// 一次性压实（每次 append 至多一次）：丢掉已消费前缀，只保留未消费残尾。
    /// Data 不清零索引，故这里用「重建残尾 Data」而不是 removeFirst，并把游标
    /// 重置为压实后 buffer 自己的 startIndex（对两种实现的索引语义都成立）。
    private mutating func compact() {
        guard cursor > buffer.startIndex else { return }
        if cursor >= buffer.endIndex {
            buffer.removeAll(keepingCapacity: true)
        } else {
            buffer = Data(buffer[cursor...])
        }
        cursor = buffer.startIndex
        // drain 结束时扫描边界恒为末尾：压实后未消费窗口整体左移，边界同步。
        scannedUpTo = buffer.endIndex
    }

    /// 单行字节 → 输出（\r\n 兼容：剥行尾 \r；不做 UTF-8 判定/解码）。
    private mutating func appendLine(_ data: Data, into outcome: inout Outcome) {
        if data.last == 0x0D {
            outcome.lines.append(data.dropLast())
        } else {
            outcome.lines.append(data)
        }
    }
}

/// Swift 端 B 桥进程客户端：spawn sidecar、NDJSON 帧读写、invoke 请求/响应
/// 配对、事件上行。进程生命周期归本对象（AppDelegate 只调 start/stop）。
public final class BridgeClient {

    // MARK: - NSError 契约（domain = "BridgeClient"）

    /// NSError domain。code 语义（供调用方/测试断言）：
    ///   1 = sidecar 业务拒绝（ok=false；error 文案进 NSLocalizedDescriptionKey）；
    ///   2 = 客户端未在运行（未 start / 已 stop / sidecar 已退出）；
    ///   3 = 写帧失败（子进程消亡/管道破裂等底层错误，含描述）；
    ///   4 = 进程退出/停止导致未决请求作废；
    ///   5 = 重复 start。
    public static let errorDomain = "BridgeClient"
    public static let errorCodeInvocationFailed = 1
    public static let errorCodeNotRunning = 2
    public static let errorCodeWriteFailed = 3
    public static let errorCodePendingDropped = 4
    public static let errorCodeAlreadyStarted = 5
    /// 6：生命周期过渡进行中（上一会话仍在终止收尾）——start 放弃，调用方可重试。
    public static let errorCodeLifecycleBusy = 6

    // MARK: - Phase 0 观测

    /// 入站行 JSON 解析次数（含解析失败的尝试）：Phase 1 C3 之后每行恰一次
    /// （超长行在解析前被挡下，不计入；`handleIncomingLine` 是唯一解析点）。
    /// internal 供测试读取/复位。诊断计数：写入点（read 回调 / 收尾抽干 / 直调测试
    /// 接缝）经 parseCountLock 同步——派发已由 dispatchLock 串行，但计数是进程级
    /// static、且测试可从别的线程读，锁保留（每行一次无竞争锁，成本可忽略）。
    private(set) static var inboundParseCount = 0
    private static let parseCountLock = NSLock()
    static func noteInboundParse() {
        parseCountLock.lock()
        inboundParseCount += 1
        parseCountLock.unlock()
    }
    /// stdout 结果派发（**必须在释放 readerLock 之后调用**，见 dispatchLock 锁序）。
    private func dispatchStdout(_ outcomes: [LineReader.Outcome], generation: Int) {
        guard !outcomes.isEmpty else { return }
        dispatchLock.lock()
        for outcome in outcomes {
            processStdoutOutcome(outcome, generation: generation)
        }
        dispatchLock.unlock()
    }

    /// stderr 结果派发（不取 dispatchLock：日志中继与协议帧派发互不阻塞）。
    private func dispatchStderr(_ outcomes: [LineReader.Outcome], generation: Int) {
        for outcome in outcomes {
            processStderrOutcome(outcome, generation: generation)
        }
    }

    /// 会话读状态作废（stop() 与 handleTermination 共用）：只在代际仍匹配时清掉
    /// 当前会话的读端句柄，使迟到的旧读回调一律落空。**必须带代际门**（独立验证者 2
    /// RISK-1）：取状态与调用点之间调用方可能已完成 start()，无条件作废会把新会话的
    /// 句柄清成 nil → 新会话 stdout 永久失聪（后续守卫全部落空）+ readabilityHandler
    /// 空转。暴露窗只有「捕获（lock 内）→ 调用」数条指令；stop() 收尸轮询那 ~7s
    /// 属于其后的终局结算窗（见 failAllPending 的代际分桶），不是本函数的窗口。
    private func invalidateReaderState(generation: Int) {
        readerLock.lock()
        if generation == readerGeneration {
            stdoutHandle = nil
            stderrHandle = nil
        }
        readerLock.unlock()
    }

    /// 测试接缝：以给定代际作废未决请求（生产只有 stop/handleTermination 两个调用点）。
    /// 另附测试接缝：只推进会话代际而不结算（构造「旧代际 + 新代际并存」的判定场景）。
    func advanceSessionGenerationForTesting() {
        lock.lock()
        sessionGeneration += 1
        lock.unlock()
        readerLock.lock()
        readerGeneration = sessionGeneration
        readerLock.unlock()
    }
    @discardableResult
    func failAllPendingForTesting(reason: String, generation: Int) -> Bool {
        failAllPending(reason: reason, ifGeneration: generation)
    }

    /// 测试接缝：以给定代际执行读状态作废（生产只有 stop/handleTermination 两个调用点）。
    func invalidateReaderStateForTesting(generation: Int) { invalidateReaderState(generation: generation) }

    /// 测试接缝：读状态快照（代际 + 是否仍持有会话句柄）。
    func readerStateSnapshotForTesting() -> (generation: Int, hasStdoutHandle: Bool, hasStderrHandle: Bool) {
        readerLock.lock()
        defer { readerLock.unlock() }
        return (readerGeneration, stdoutHandle != nil, stderrHandle != nil)
    }

    /// 测试接缝：当前会话代际（readerLock 内读取）。
    func readerGenerationSnapshot() -> Int {
        readerLock.lock()
        defer { readerLock.unlock() }
        return readerGeneration
    }

    /// 锁内读取计数快照（测试/诊断；直接读 static var 在收尾线程并发时会撕裂）。
    static func inboundParseCountSnapshot() -> Int {
        parseCountLock.lock()
        defer { parseCountLock.unlock() }
        return inboundParseCount
    }
    /// 复位计数（仅测试；全局静态，测试间需显式清理）。
    static func resetInboundParseCount() {
        parseCountLock.lock()
        inboundParseCount = 0
        parseCountLock.unlock()
    }

    /// 退出清理预算（S6）：SIGTERM 后等待 sidecar 优雅退出的宽限期，须与
    /// shell-core.ts `QUIT_CLEANUP_TIMEOUT_MS = 5_000`（AppDelegate
    /// .quitCleanupTimeout 同一预算）对齐——旧 2s 会在 sidecar 仍在回收本地
    /// dsh/ssh 子进程时 SIGKILL，留下孤儿。跨语言锁步由
    /// CrossLanguageLockstepTests 钉住。
    public static let quitCleanupGracePeriod: TimeInterval = 5.0

    // MARK: - 构造参数

    private let nodePath: String
    private let arguments: [String]
    private let environment: [String: String]

    /// 构造（AppDelegate 按此签名调用，勿改名——第四参数带默认值，既有三参
    /// 调用不变）。
    /// - Parameters:
    ///   - nodePath: Node 可执行文件路径（POC：系统 node 或 Electron 二进制
    ///     + ELECTRON_RUN_AS_NODE=1，见 AppDelegate）。
    ///   - arguments: sidecar 脚本路径与参数（sidecar-entry.ts / sidecar.js）。
    ///   - environment: 附加环境变量（合并进当前进程环境，同名覆盖）。
    ///   - defaultEdgeResponder: true（默认）= init 时把 v1 默认 edge 应答器
    ///     装进 onEdgeRequest（setDefaultEdgeResponder）；false = 留 nil——
    ///     分发层对「无自定义应答器」仍以 defaultEdgeResponse 兜底应答
    ///     （edge 必答不挂起是不变式，本参数只影响 onEdgeRequest 的初值形态，
    ///     不改变兜底行为）。
    public init(nodePath: String, arguments: [String], environment: [String: String],
                defaultEdgeResponder: Bool = true) {
        self.nodePath = nodePath
        self.arguments = arguments
        self.environment = environment
        if defaultEdgeResponder {
            setDefaultEdgeResponder()
        }
    }

    // MARK: - 状态（除出站面回调属性外全部经 lock 保护）

    private let lock = NSLock()
    /// stderr 环形专用锁（Phase 2 C6）：sidecar 日志逐行经过它，不再与
    /// invoke/pending 的主状态锁争用。`stderrTail` 是唯一受它保护的状态，
    /// 与 pipe/登记不构成任何不变式，故可独立；锁序恒为 lock → stderrLock。
    private let stderrLock = NSLock()
    /// 行缓冲专用锁（Phase 2 C6 补口）：stdout/stderr 两个 LineReader 的
    /// append/finish 都在它下面做（解码整块行是持锁耗时的大头），不再占用主
    /// 状态锁。两个 reader 之间无不变式，一个锁即可；锁序恒为
    /// lock → readerLock（start() 复位时持 lock 再取它，无反向路径）。
    private let readerLock = NSLock()
    /// 写串行锁（管道写不与其他帧交错；见文件头「写帧」注释）。
    private let writeLock = NSLock()
    /// stdout 帧派发串行锁（第三轮审查 R1/R2/R7 收口）：`processStdoutOutcome` 全程持
    /// 它，故回调绝不并发进入；同时**不引入无界异步队列**——派发仍在读回调/收尾线程
    /// 同步执行，保留「读线程 = 消费者」的天然背压（慢消费者会阻塞读端，而不是让队列与
    /// LineReader 父缓冲切片无界堆积）。stderr 中继不参与此锁：它有独立回调线程 +
    /// stderrLock，stderr 写端被挂起时只堵住日志，绝不拖住协议帧派发。
    ///
    /// **全局锁序**（独立验证者 1 用冻结源码复现过反向锁序死锁，故必须遵守）：
    ///   dispatchLock → lifecycleLock → lock →（readerLock | stderrLock）
    /// 即：持有外层锁的人**只能**按序获取更内层的锁；`handleTermination` 因此**先取
    /// dispatchLock 再取 lifecycleLock**（它要抽干并派发死前帧，而帧回调可能正持
    /// dispatchLock 调 start()/stop()）。递归锁允许收尾路径经 finish*Reading →
    /// dispatchStdout 重入本锁。
    private let dispatchLock = NSRecursiveLock()
    private var process: Process?
    private var inputPipe: Pipe?        // 子进程 stdin 写端
    private var outputPipe: Pipe?       // 子进程 stdout 读端（协议流）
    private var errorPipe: Pipe?        // 子进程 stderr 读端（日志流）
    private var outputReader = LineReader()
    private var stderrReader = LineReader()
    /// 流收尾标志（readerLock 保护）：EOF/终止收尾后不再接受该流的读回调。
    /// 使「availableData + append/finish」在 readerLock 下成为原子段——修掉
    /// read-then-lock 与收尾竞争导致的静默丢行，以及旧会话回调把旧进程字节
    /// 注入新会话 reader 的路径。
    private var stdoutEOF = false
    private var stderrEOF = false
    /// 当前会话的读端句柄（readerLock 保护）：读回调的会话身份守卫只看它——
    /// 与 reader/EOF 同锁发布，避免跨锁读 outputPipe/errorPipe 的数据竞争，
    /// 也避免旧会话回调注入新会话（独立审查 C-BUG-1）。
    private var stdoutHandle: FileHandle?
    private var stderrHandle: FileHandle?
    /// 与 reader 状态同步的会话代际（readerLock）：终止收尾只在代际仍匹配时
    /// 生效，防旧收尾把新会话 reader 标记 finished（A-BUG-3 restart-deaf）。
    private var readerGeneration = 0
    private var nextID = 1
    /// 未决请求条目（锁保护）：续体与**登记时的会话代际**同处一条记录——二者同增
    /// 同删，不再靠两张字典手工同步（第七轮重构：双表簿记是「漏更新其中一张」的
    /// 隐患来源）。终局结算按代际分桶：既不误杀新会话的请求，也不让旧会话的
    /// invoke 悬挂（最终验证者 RISK-1）。
    private struct PendingEntry {
        let continuation: CheckedContinuation<AnyCodable, Error>
        let generation: Int
    }
    private var pending: [Int: PendingEntry] = [:]
    private var sigpipeIgnored = false
    // —— M3 W-15/16 出站面状态 ——
    /// 已应答 edgeId 守卫（锁保护）：edge 应答恰好一次的守卫（与 pending 字典
    /// 的 id 所有权纪律同构——edgeId 的所有权 = 本守卫的插入成功）。有界
    /// （S14：长会话不无界增长；容量与淘汰语义见 BoundedEdgeReplyGuard）。
    private var answeredEdgeIDs = BoundedEdgeReplyGuard()
    /// 生命周期过渡锁（第三轮残留清理重构）：start()/stop()/handleTermination **全程**
    /// 互斥，取代此前「terminalInProgress 标志 + 10ms 轮询」的方案——过渡不再有
    /// check-then-act 窗口，也不会出现「旧收尾与新会话交错」或「stop 快路径撞自然死亡
    /// 收尾」。递归锁：onTerminated 内同一线程同步 start() 同一实例时允许重入（此刻旧
    /// 会话的状态变更已全部完成，只剩回调本身）。
    /// 锁序（与 dispatchLock 注释同源，必须遵守）：
    ///   dispatchLock → lifecycleLock → lock →（readerLock | stderrLock）
    /// 即终局收尾先取 dispatchLock 再取本锁；帧回调只可能沿此序向内取本锁。
    private let lifecycleLock = NSRecursiveLock()
    /// start() 获取 lifecycleLock 的上限（秒）：超出抛 code 6（过渡卡死 = loud 且可重试）。
    public static let terminalTransitionTimeout: TimeInterval = 2.0
    /// 会话代际（锁保护）：start() 每次递增。stop/重启后，旧会话 dispatch 的
    /// edge 迟到应答按代际作废（防旧 edgeId 撞上新会话同号 edge）。
    private var sessionGeneration = 0
    /// 最近一次 sidecar 进程终止退出码（锁保护；nil = 尚未观测到终止）。
    private var lastTerminationStatusStorage: Int32?
    /// 有界日志汇聚（见 LogSink）：所有诊断日志的唯一出口。
    private let logSink = LogSink()
    /// 最近 sidecar stderr 行（T-3：有界环形，只服务启动失败报告/失败页考古；
    /// 锁保护，start() 复位）。
    private var stderrTail: [String] = []
    /// stderr 环形保留行数上限。
    private static let stderrTailLimit = 40
    /// 单行入环前的字符截断（防一篇超长栈撑爆报告/日志）。
    private static let stderrLineCharLimit = 400
    /// sidecar stderr 行的落盘出口（2026-12 取证修复）：`<userData>/logs/sidecar.log`。
    /// nil = 只透传 stdout（单测/自定义形状）。注入方保证线程安全（生产端是
    /// ShellLog，自带 NSLock）；本属性在 start() 之前赋值、之后只读，
    /// 与管道读取线程不并发写（与 onEvent 同纪律）。
    ///
    /// 2026-12 合并（perf 非阻塞日志通道）：调用点搬到 LogSink 的汇聚线程（见
    /// relaySidecarLogLine / Entry.sidecar）；赋值时同步给汇聚线程的旁路消费者。
    public var sidecarLogSink: ((String) -> Void)? {
        didSet { logSink.sidecarSink = sidecarLogSink }
    }

    /// 最近 sidecar stderr 摘要（T-3；启动失败报告在进程终止回调里同步读取，
    /// 见 handleTermination 的 finishStderrReading）。多行以换行连接。
    public var recentStderrSummary: String {
        stderrLock.lock()
        defer { stderrLock.unlock() }
        return stderrTail.joined(separator: "\n")
    }

    /// sidecar 事件出口（事件帧到达时在管道读取线程回调；调用方负责切回
    /// 主线程再碰 UI/WKWebView——本属性在 start() 之前赋值、之后只读，
    /// 赋值方（controller）与读取线程不并发写）。
    public var onEvent: ((String, AnyCodable?) -> Void)?

    // MARK: - 出站面（sidecar → Swift：edge 请求 / notify / ready；M3 W-15/16）

    /// sidecar→Swift 的 edge 请求出口。NOTIFY 类通道的宿主腿在 sidecar 侧
    /// await sendEdge 的应答（node-edges pendingEdges 无超时——不应答 =
    /// 永久挂起，见文件头）。本回调（管道读取线程）**必须调用 reply 恰好
    /// 一次**：
    ///   - reply(result, nil)      → 写 {"edgeId":N,"ok":true,"result":…}
    ///     （result 为 nil 时 result 键写 JSON null）；
    ///   - reply(result, error文案) → 写 {"edgeId":N,"ok":false,"error":…}。
    /// reply 可延后/跨线程调用（edgeId 恰好一次由 sendEdgeReply 的守卫保证；
    /// stop/重启后迟到应答按代际 loud 丢弃）。对未处理的方法请回落
    /// defaultEdgeResponse(method:payload:)（自定义不应答 = 挂起，注释声明）。
    /// 未设置（nil）时由 v1 默认应答策略兜底（defaultEdgeResponse——
    /// 构造参数 defaultEdgeResponder=true 会在 init 时把默认应答器装进本属性）。
    /// 线程契约与 onEvent 相同：start() 之前赋值、之后只读。
    public var onEdgeRequest: ((_ method: String, _ payload: AnyCodable?,
                                _ reply: @escaping (_ result: AnyCodable?, _ error: String?) -> Void) -> Void)?

    /// sidecar→Swift 的 notify 事件出口（单向帧，不期待应答；ready 之外的
    /// rendererPush 等）。线程契约与 onEvent 相同。ready 帧不进本出口
    /// （结构校验后走 onReady）。
    public var onNotify: ((_ event: String, _ payload: AnyCodable?) -> Void)?

    /// sidecar ready notify 专用出口：sidecar 起动完成、control plane 就绪后
    /// 主动输出的 {"notify":"ready","payload":{port,shellVersion}}（先于任何
    /// 业务帧）。线程契约与 onEvent 相同（管道读取线程回调）。
    public var onReady: ((_ port: Int, _ shellVersion: String) -> Void)?

    /// 自然终止出口（W-15 Supervisor 接线）：sidecar 崩溃/自行退出时回调
    /// terminationStatus（管道读取线程，即 SIGCHLD 处理线程）。**主动 stop()
    /// 不触发**（stop 先摘 terminationHandler 再 terminate）。赋值须在 start()
    /// 之前（与 onEvent/onReady 同契约）。
    public var onTerminated: ((Int32) -> Void)?

    /// 进程是否存活（含 start 前/stop 后 → false）。测试与未来 Supervisor 用。
    public var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return process?.isRunning ?? false
    }

    /// 未决请求数（测试/诊断用，G9：超长帧必须作废全部未决请求的可观察锚点；
    /// 与 pending 字典同锁保护）。
    var pendingRequestCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return pending.count
    }

    /// 最近一次 sidecar 进程终止退出码（nil = 尚未观测到终止）。记录路径：
    /// stop() 收尸完成（waitUntilExit 后）与自然退出（handleTermination）都会
    /// 写。优雅退出（sidecar 处理 SIGTERM 后 exit(0)）→ 0；stop() 轮询超时后
    /// SIGKILL 兜底时 Darwin 上报信号号（9）。测试与未来 Supervisor 用。
    public var lastTerminationStatus: Int32? {
        lock.lock()
        defer { lock.unlock() }
        return lastTerminationStatusStorage
    }

    // MARK: - 出站面默认 edge 应答策略（M3 W-15/16）

    /// edge 应答兜底（W-15/16 语义：Swift 必须应答、绝不挂起；sidecar 侧
    /// sendEdge 无超时）。宿主腿（W-19/20）非 nil 时先问 legs；legs 报
    /// unimplemented 前缀（本壳没有该腿）才落到这里。
    /// G31（2026-12 审计）：兜底**恒为** loud 拒绝
    /// {ok:false, error:"swift-edge-unimplemented:<method>"}——绝不假成功。
    /// 此前 trayAvailable/notificationSupported/badgeCountApiAvailable/
    /// mainWindowAlive/webViewContentAlive 恒 true、showNativeNotification 恒
    /// 成功、showMessage 恒第 0 号按钮：未来新增未实现 edge 落入该表即静默
    /// 成功，core 会据此做出错误裁决。ui-unavailable 是真实腿的诚实降级，
    /// 直接传播，绝不回落成本兜底。
    public var edgeHostLegs: SwiftEdgeHostLegs?

    /// 返回 (result, error)：error == nil → ok:true 应答，否则 ok:false。
    /// 自定义 onEdgeRequest 对未处理方法的回落入口：取本方法 outcome 后交给
    /// reply（应答职责仍在自定义侧；恰好一次由 sendEdgeReply 守卫）。
    public func defaultEdgeResponse(method: String, payload: AnyCodable?)
        -> (result: AnyCodable?, error: String?) {
        if let legs = edgeHostLegs {
            let outcome = legs.respond(method: method, payload: payload)
            let error = outcome.error ?? ""
            // unimplemented（legs 未实现）→ 回落 v1 默认表（POC 无宿主不挂起）；
            // ui-unavailable（真实腿的诚实降级）→ 直接传播，绝不回落成乐观成功。
            if !error.hasPrefix(SwiftEdgeHostLegs.unimplementedPrefix) {
                return outcome
            }
        }
        // G31：未实现 → 显式错误（绝不谎报可用/已显示/已选按钮）。
        return (nil, "swift-edge-unimplemented:\(method)")
    }

    /// 把 v1 默认 edge 应答器装回 onEdgeRequest（策略见 defaultEdgeResponse；
    /// 自定义应答器想整体恢复默认时调用；构造参数 defaultEdgeResponder=true
    /// 时 init 已调用过）。线程：start() 之前调用（与 onEvent 同赋值契约）。
    public func setDefaultEdgeResponder() {
        onEdgeRequest = { [weak self] method, payload, reply in
            guard let self else { return }
            if let legs = self.edgeHostLegs, legs.canHandleAsync(method: method) {
                // W-21：异步宿主腿（通知调度等）——reply 恰一次由 sendEdgeReply
                // 守卫；legs 内部错误一律 loud，绝不挂起。
                legs.respondAsync(method: method, payload: payload, completion: { result, error in
                    reply(result, error)
                })
                return
            }
            let outcome = self.defaultEdgeResponse(method: method, payload: payload)
            reply(outcome.result, outcome.error)
        }
    }

    // MARK: - 子进程环境（T-11）

    /// 子进程环境的合并规则（T-11）：打包态从基底与 overlay 都剔除全部 DSH_CHAMBER_SHELL_*
    /// （与 AppDelegate 对壳自身 env 的过滤同规）。start() 把当前进程环境当
    /// 基底、构造参数当 overlay——若只过滤调用方传入的 overlay，基底里的
    /// DSH_CHAMBER_SHELL_* 仍会经合并进入 sidecar（此前的实际泄漏路径）。打包判定与
    /// AppDelegate 相同：PackagedLayout.isAppBundle(executablePath:)。
    public static func childEnvironment(base: [String: String],
                                        overlay: [String: String],
                                        isPackaged: Bool) -> [String: String] {
        var merged = base
        if isPackaged {
            merged = merged.filter { !$0.key.hasPrefix("DSH_CHAMBER_SHELL_") }
        }
        for (key, value) in overlay {
            if isPackaged && key.hasPrefix("DSH_CHAMBER_SHELL_") { continue }
            merged[key] = value
        }
        return merged
    }

    // MARK: - 生命周期

    /// 拉起 sidecar：Process 配置（executableURL=nodePath、arguments、
    /// environment=当前环境 + 构造参数合并）→ 三管道 → 读回调 → run()。
    /// 失败抛 NSError（code 5 = 已在运行；其余为 spawn 底层错误原样上抛）。
    /// 线程：调用方线程（AppDelegate 主线程）；成功后即可 invoke。
    public func start() throws {
        // 生命周期过渡互斥：上一会话仍在 stop()/终止收尾时，本调用在锁上等待（有界）——
        // 拿到锁即代表过渡完成，绝无 TOCTOU 窗口；超时 loud 抛 code 6（可重试）。
        guard lifecycleLock.lock(before: Date().addingTimeInterval(Self.terminalTransitionTimeout)) else {
            throw Self.makeError(
                code: Self.errorCodeLifecycleBusy,
                message: "上一会话的终止收尾超过 \(Self.terminalTransitionTimeout)s 未完成：start 放弃，请稍后重试")
        }
        defer { lifecycleLock.unlock() }
        lock.lock()
        defer { lock.unlock() }
        guard process == nil else {
            throw Self.makeError(code: Self.errorCodeAlreadyStarted,
                                 message: "BridgeClient 已在运行（start 不可重入；先 stop 再 start）")
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = arguments
        // T-11：打包态基底过滤 DSH_CHAMBER_SHELL_*（见 childEnvironment 注释）。
        let executablePath = Bundle.main.executableURL?.path ?? CommandLine.arguments.first ?? ""
        process.environment = Self.childEnvironment(
            base: ProcessInfo.processInfo.environment,
            overlay: environment,
            isPackaged: PackagedLayout.isAppBundle(executablePath: executablePath))

        let input = Pipe()
        let output = Pipe()
        let error = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = error

        // SIGPIPE：子进程先亡而我们仍在写 stdin / 它先关读端时，默认信号会
        // 直接杀死本进程（不是可捕获异常）。GUI 进程惯例是全局忽略一次，
        // 让后续写以 EPIPE 错误冒泡（FileHandle.write 抛错 → 本文档 code 3
        // 路径）。进程级副作用，只做一次，注释声明。
        if !sigpipeIgnored {
            signal(SIGPIPE, SIG_IGN)
            sigpipeIgnored = true
        }

        // 回调在 run() 之前挂好：子进程可能极快写出/退出，事件不丢
        // （Foundation 管道会缓冲；回调经 lock 与本方法串行）。
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.readStdout(handle)
        }
        error.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.readStderr(handle)
        }
        // terminationHandler 必须先于 run() 赋值（防“run 返回前已退出”漏事件；
        // stop() 会先置 nil 再 terminate，防重入）。闭包必须带上 Foundation 传回
        // 的 Process：已被派发的 block 不会因 stop()/重启而取消，靠它做身份守卫。
        process.terminationHandler = { [weak self] proc in
            self?.handleTermination(of: proc)
        }

        // 会话读状态发布（独立审查 C-BUG-1）：reader/EOF/句柄必须**同处 readerLock
        // 段内一次性发布，且早于 run()**。否则存在「新句柄已可见、reader 还没换」
        // 的窗口：读回调会把新会话首帧读进旧 LineReader，随后 start() 复位把它
        // 永久丢弃（丢 ready 帧 = A 桥永不放开、页面所有 invoke ipc_not_ready）。
        // 读回调只认 readerLock 下的句柄身份，故发布即原子；run() 抛错在下方回滚。
        // 出站面会话状态复位 + **代际推进先于读状态发布**（独立验证者 2 RISK-2）：
        // 迟到收尾用 generation == readerGeneration 判新旧；若代际晚于句柄可见，
        // 迟到收尾会以旧代际匹配、把新 reader 直接 finish 并置 stdoutEOF → 新会话
        // 永久静音。故先推进 sessionGeneration，再在同一 readerLock 临界区内
        // 发布 reader/EOF/代际/句柄。
        self.answeredEdgeIDs.removeAll()
        self.sessionGeneration += 1
        self.lastTerminationStatusStorage = nil
        readerLock.lock()
        self.outputReader = LineReader()
        self.stderrReader = LineReader()
        self.stdoutEOF = false
        self.stderrEOF = false
        self.readerGeneration = self.sessionGeneration   // 与读状态同临界区发布
        self.stdoutHandle = output.fileHandleForReading
        self.stderrHandle = error.fileHandleForReading
        readerLock.unlock()

        do {
            try process.run()
        } catch {
            // 发布回滚：spawn 失败不得留下看似可读的会话句柄。
            readerLock.lock()
            self.stdoutHandle = nil
            self.stderrHandle = nil
            readerLock.unlock()
            throw error
        }

        // 状态赋值在 run() 成功且仍持锁时完成：回调紧随 run() 返回触发时，
        // 经 readerLock 已能通过句柄身份守卫看到本次会话（发布已前置）。
        self.process = process
        self.inputPipe = input
        self.outputPipe = output
        self.errorPipe = error
        // T-3：stderr 环形复位（新进程/重启只带自己的失败证据）。Phase 2 C6：
        // stderrTail 由独立 stderrLock 保护（与上面的主状态锁无关）。
        stderrLock.lock()
        stderrTail.removeAll()
        stderrLock.unlock()
    }

    /// 停止 sidecar：SIGTERM → 等 ≤ quitCleanupGracePeriod（5s，与 shell-core
    /// 清理预算同值，S6）→ SIGKILL 兜底 → ≤2s 有界收尸（内部注释：最坏 ≈7s）。
    /// 仅 AppDelegate.applicationWillTerminate / 退出清理路径使用，注释声明。
    /// 幂等：重复 stop / 进程已自然退出均安全。
    public func stop() {
        // 生命周期过渡互斥：与 start()/handleTermination 串行（阻塞获取——stop 是退出链
        // 的同步动作，必须真正完成）。
        lifecycleLock.lock()
        defer { lifecycleLock.unlock() }
        // 摘状态（此后 invoke 一律 code 2；重复 stop 直接返回）。
        var takenProcess: Process?
        var takenOutput: Pipe?
        var takenError: Pipe?
        var generation = 0
        lock.lock()
        guard process != nil else {
            lock.unlock()   // 幂等快路径：不推进代际
            // 自然死亡路径已先摘走 process 时直接返回；此刻 handleTermination 仍持
            // lifecycleLock，其抽干/结算/onTerminated 完成前任何 start() 都会等锁
            // （超时抛 code 6）——不存在「stop 快路径与自然死亡收尾交错」的窗口。
            return
        }
        generation = sessionGeneration
        // 立刻推进会话代际（第三轮审查 afterstop）：stop() 返回后绝不允许再有本会话的
        // 帧进入回调（文件头/本方法注释承诺「stop 后不再处理任何子进程输出」）。代际
        // 推进后，在途/已切行的旧代际帧会在派发代际门被丢弃；本代际未决请求仍按下面
        // 捕获的 generation 分桶结算。
        sessionGeneration += 1
        takenProcess = process
        takenOutput = outputPipe
        takenError = errorPipe
        process = nil
        inputPipe = nil
        outputPipe = nil
        errorPipe = nil
        lock.unlock()
        guard let takenProcess else { return }

        // 会话读状态作废：句柄身份守卫随之失效，迟到的旧会话读回调一律落空。
        invalidateReaderState(generation: generation)

        // 摘除全部回调，防重入：terminationHandler 置 nil（spec）；stdout/
        // stderr 读回调一并摘除——stop 后不再处理任何子进程输出。
        takenOutput?.fileHandleForReading.readabilityHandler = nil
        takenError?.fileHandleForReading.readabilityHandler = nil
        takenProcess.terminationHandler = nil

        // SIGTERM → 轮询 ≤ quitCleanupGracePeriod（5s，与 shell-core 的
        // QUIT_CLEANUP_TIMEOUT_MS 同预算，S6）→ SIGKILL 兜底。（G10：旧注释写
        // 「≤2s」与实现 5.0s 矛盾——改注释而非改值：5s 是跨语言冻结预算，
        // 2s 会在 sidecar 回收本地 dsh/ssh 子进程时提前 SIGKILL 留孤儿。）
        if takenProcess.isRunning {
            takenProcess.terminate()
        }
        let deadline = Date().addingTimeInterval(Self.quitCleanupGracePeriod)
        while takenProcess.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if takenProcess.isRunning {
            // SIGKILL：Process 无 kill API，用 kill(2)（Foundation 在 Darwin
            // 上再导出，无需 import Darwin）。ESRCH（恰在此时已退出）等失败
            // 忽略：后续有界轮询兜底状态。
            _ = kill(takenProcess.processIdentifier, SIGKILL)
        }
        // 收尸（防僵尸）：对已退出进程 waitUntilExit 本应立即返回，但子进程
        // 自然退出恰与 stop() 并发时（terminationHandler 已先行触发、Foundation
        // 已内部 waitpid 收尸，handleTermination 与 stop 竞争收尾——本文件注释
        // 声明的并发路径）waitUntilExit 存在永不返回的竞态（集成测试实测偶发
        // 挂死）。改为：SIGKILL 后再有界轮询 ≤2s 等进程消亡——isRunning 转
        // false 即 Foundation 已收尸（无僵尸残留），此时**不再** waitUntilExit；
        // 仍存活（SIGKILL 后理论不可达）才 waitUntilExit 兜底。stop() 因此
        // 绝不无限阻塞调用线程，「同步收尸」契约不变（正常路径 <2s）。
        let reapDeadline = Date().addingTimeInterval(2.0)
        while takenProcess.isRunning && Date() < reapDeadline {
            Thread.sleep(forTimeInterval: 0.02)
        }
        if takenProcess.isRunning {
            takenProcess.waitUntilExit()
        }

        // 记录本次终止退出码（测试/未来 Supervisor 用）：sidecar 处理 SIGTERM
        // 优雅退出 → 0；轮询超时后 SIGKILL 兜底 → Darwin 上报信号号 9。
        //
        // 终局副作用的会话绑定（独立审查 C-RISK）：stop() 的收尸轮询最长 ~7s，
        // 期间 start() 会在 lifecycleLock 上等待（超时 code 6，不会真正并发），但
        // 代际分桶仍是必要保险：结算只清本次 stop 捕获的代际条目。
        // 记录退出码：本方法自己在上面推进了代际，故不按代际判定；lifecycleLock 保证
        // 终局段内不会有新会话 start()，状态记录不会被新会话覆盖。
        lock.lock()
        lastTerminationStatusStorage = takenProcess.terminationStatus
        lock.unlock()
        // 代际分桶结算（验证者 1 TOCTOU + 最终验证者 RISK-1）：只结算本次 stop 捕获的
        // 代际登记的请求（旧会话不悬挂、新会话不被误杀）。
        _ = failAllPending(reason: "BridgeClient 已停止（stop()）", ifGeneration: generation)
    }

    /// 自然退出收尾：sidecar 崩溃/自行 exit 时（SIGCHLD 回调线程）——置状态
    /// 为未运行、摘读回调、按 EOF 语义收尾行缓冲、未决请求全部作废（loud）。
    ///
    /// 身份守卫（独立审查 A-BUG-1）：`triggered` 是 Foundation 传回的触发进程。
    /// 若 `process` 已不是它（stop() 已清 → nil，或新会话已 start），说明这是
    /// 旧会话的迟到回调——直接忽略。绝不读**仍是存活新会话**进程的
    /// terminationStatus（对运行中的 Process 读该属性抛不可捕获 NSException，
    /// 实测 SIGABRT）；对已由 stop() 收走的进程重复收尾也会产生虚假的
    /// onTerminated(-1)。
    private func handleTermination(of triggered: Process) {
        // **先**取 dispatchLock、**再**取 lifecycleLock（全局锁序，见 dispatchLock 注释）：
        // 收尾要抽干并派发死前帧，而帧回调可能正持 dispatchLock 调 start()/stop()——若
        // 反过来先取 lifecycleLock 再等 dispatchLock 就形成死锁环（独立验证者 1 已用冻结
        // 源码确定性复现）。这样帧回调内同步 stop()/start() 只会在内层锁上等待。
        dispatchLock.lock()
        defer { dispatchLock.unlock() }
        // 与 start()/stop() 互斥：终局收尾期间不可能有新会话发布（反之亦然）。
        lifecycleLock.lock()
        defer { lifecycleLock.unlock() }
        var takenOutput: Pipe?
        var takenError: Pipe?
        var generation = 0
        lock.lock()
        guard let current = process, current === triggered, !triggered.isRunning else {
            // 迟到的旧会话回调 / 理论不可达的“仍在运行”触发：不碰任何状态。
            lock.unlock()
            return
        }
        takenOutput = outputPipe
        takenError = errorPipe
        generation = sessionGeneration
        process = nil
        inputPipe = nil
        outputPipe = nil
        errorPipe = nil
        lock.unlock()

        // 会话读状态作废（本会话读回调此后一律落空；残帧由下面的 finish*Reading
        // 显式抽干）。必须带代际门，见 invalidateReaderState 注释。
        invalidateReaderState(generation: generation)

        takenOutput?.fileHandleForReading.readabilityHandler = nil
        takenError?.fileHandleForReading.readabilityHandler = nil

        let status = triggered.terminationStatus
        let reason = triggered.terminationReason
        // 退出码分级：Supervisor（W-15）据 status 决定重启退避 / fatal 分流
        // （0 = 自行优雅退出；3 = 目录锁冲突；其余非零 = 崩溃），本类只上报。
        log("sidecar 进程退出：terminationStatus=\(status)（reason=\(reason.rawValue)）")
        lock.lock()
        if sessionGeneration == generation { lastTerminationStatusStorage = status }
        lock.unlock()

        // 管道此刻已 EOF：把 stdout 残尾按 EOF 收尾（可能含最后的完整帧），
        // 未决请求作废（作废先于残帧分发会丢“死前应答”——进程已亡，
        // 语义上桥已断，注释声明此取舍：宁可 loud 丢弃也不悬挂）。
        finishStdoutReading(takenOutput, generation: generation)
        // T-3：stderr 同步抽干——terminationHandler 与 readabilityHandler 之间
        // 没有先后保证，不抽干则「死前最后一行」（EADDRINUSE 等）会漏出
        // fatal 摘要（失败报告/失败页只能给笼统建议）。
        finishStderrReading(takenError, generation: generation)

        // 终局副作用的会话绑定（独立审查 C-RISK）：抽干期间调用方可能已 stop+start，
        // 旧会话不得作废新会话的未决请求，也不得把旧退出码上报给 Supervisor
        // （后者会按同一实例把旧会话的退出当成本次会话崩溃）。
        let settlementCurrent = failAllPending(reason: "sidecar 进程退出，未决请求作废",
                                              ifGeneration: generation)
        guard settlementCurrent else {
            log("旧会话收尾：会话代际已推进（仅结算本代际请求），status=\(status) 不上报")
            return
        }
        // 最终复核 + 回调都在 lifecycleLock 保护下：本方法全程持锁，start()/stop() 与
        // 之互斥，故「判定通过 → onTerminated 上报」之间不可能插入新会话（第三轮残留
        // 清理：此前这里是 check-then-act，现已由生命周期锁闭合）。
        lock.lock()
        let stillCurrent = sessionGeneration == generation
        lock.unlock()
        guard stillCurrent else {
            log("旧会话收尾被丢弃（会话代际已推进）：status=\(status) 不上报")
            return
        }

        // 终局之后推进会话代际：drain 已用旧代际派发（死前帧照常送达），此后任何
        // 在途/迟到的本会话帧都会被派发代际门丢弃（第三轮审查 afterstop 的同款契约）。
        lock.lock()
        sessionGeneration += 1
        lock.unlock()

        // 收尾完成后上报：本方法已持 dispatchLock（见函数头），故 onTerminated 与帧回调
        // **互斥**（此时本会话的帧已全部派发/丢弃完毕）。回调内同一线程同步 start() 同一
        // 实例被 lifecycleLock 的递归语义允许（旧会话状态变更已完成）；异线程会等到回调
        // 返回。订阅者回调必须短小（本类在双锁内调用它，见文件头线程契约）。
        onTerminated?(status)
    }

    // MARK: - 管道读取（stdout = 协议流；stderr = 日志流）

    /// 读回调：只在 dispatch source 报告可读时进入（有数据或 EOF），故锁内
    /// availableData 不会阻塞——锁内阻塞 I/O 的禁令针对**无就绪契约**的抽干路径
    /// （那里用 FIONREAD 探针，见 finishStdoutReading）；独立审查 A-BUG-2 复核点。
    private func readStdout(_ handle: FileHandle) {
        var outcome: LineReader.Outcome?
        var generation = 0
        readerLock.lock()
        generation = readerGeneration
        // 旧会话（stop 后重启）的迟到回调：句柄已不是当前管道 → 丢弃，绝不把
        // 旧进程字节注入新会话的协议流。EOF 后同样不再接受该流回调。
        if stdoutHandle === handle, !stdoutEOF {
            let data = handle.availableData
            if data.isEmpty {
                // 管道 EOF（read 返回 0 字节 = 写端全关 = 子进程已亡）。摘回调并
                // 按 EOF 收尾；stdoutEOF 使收尾恰好一次。
                handle.readabilityHandler = nil
                stdoutEOF = true
                outcome = outputReader.finish()
            } else {
                outcome = outputReader.append(data)
            }
        }
        readerLock.unlock()
        if let outcome { dispatchStdout([outcome], generation: generation) }
    }

    /// stdout EOF / 终止收尾（读回调与终止回调都可能触发；幂等）。传入 pipe 时
    /// 先把管道里剩余字节抽干再收尾——与 stderr 对称，修掉「进程已退出、最后
    /// 一帧仍在管道缓冲里」的丢帧窗口（BridgeClientLineReadTests 的
    /// final-frame-at-exit 用例钉住）。抽干在 readerLock 内完成、分发在锁外
    /// （dispatch 会取主状态锁，锁序恒为 readerLock → lock，绝不反向）。
    /// internal：测试接缝（与 handleIncomingLine/processStdoutOutcome 同规，G9）。
    func finishStdoutReading(_ pipe: Pipe?, generation: Int) {
        var outcomes: [LineReader.Outcome] = []
        var probeFailed = false
        var capped = false
        readerLock.lock()
        // 代际守卫（独立审查 A-BUG-3）：收尾窗口内调用方可能已 stop+start；本收尾
        // 属旧会话时，作用到新 reader 会把新会话 stdout 永久静音（帧全丢）。
        if generation == readerGeneration, !stdoutEOF {
            stdoutEOF = true
            if let handle = pipe?.fileHandleForReading {
                var batches = 0
                // 非阻塞抽干（A-BUG-2）：写端被第三方持有（无数据也无 EOF）时
                // availableData 会阻塞——锁内阻塞 I/O 会把收尾与整个对象卡死。
                // FIONREAD 探到 0 立即停，绝不等待。
                while true {
                    if batches >= drainBatchLimit { capped = true; break }   // 上限截断（真丢字节）
                    guard let available = bytesAvailable(handle) else { probeFailed = true; break }
                    guard available > 0 else { break }
                    let data = handle.availableData
                    if data.isEmpty { break }
                    outcomes.append(outputReader.append(data))
                    batches += 1
                }
            }
            outcomes.append(outputReader.finish())
        }
        readerLock.unlock()
        dispatchStdout(outcomes, generation: generation)   // 释放 readerLock 后串行派发
        // 日志一律锁外（log 会写 stderr，属阻塞 I/O：锁内做会重蹈 A-BUG-2 的
        // 锁内阻塞原则；独立验证者 1 NIT）。
        if probeFailed { log("stdout：FIONREAD 探测失败，收尾抽干提前结束（残帧可能丢失）") }
        if capped { log("stdout：收尾抽干达到批次上限，其余字节不再读取（会话已终止）") }
    }

    /// stderr 残尾同步抽干（进程终止路径专用，T-3）：把传入管道里剩余字节全部
    /// 读进 stderrReader 并 EOF 收尾；幂等（stderrEOF + LineReader.finished）。
    /// internal：测试接缝（同上）。
    func finishStderrReading(_ pipe: Pipe?, generation: Int) {
        var outcomes: [LineReader.Outcome] = []
        var probeFailed = false
        var capped = false
        readerLock.lock()
        if generation == readerGeneration, !stderrEOF {
            stderrEOF = true
            if let handle = pipe?.fileHandleForReading {
                var batches = 0
                while true {
                    if batches >= drainBatchLimit { capped = true; break }
                    guard let available = bytesAvailable(handle) else { probeFailed = true; break }
                    guard available > 0 else { break }
                    let data = handle.availableData
                    if data.isEmpty { break }
                    outcomes.append(stderrReader.append(data))
                    batches += 1
                }
            }
            outcomes.append(stderrReader.finish())
        }
        readerLock.unlock()
        dispatchStderr(outcomes, generation: generation)
        if probeFailed { log("stderr：FIONREAD 探测失败，收尾抽干提前结束（死前证据可能缺失）") }
        if capped { log("stderr：收尾抽干达到批次上限，其余日志行不再读取（会话已终止）") }
    }

    /// 管道可读字节数（FIONREAD，非阻塞探针）：抽干路径的判据。返回 0 = 当前无
    /// 字节可读；返回 nil = 探测失败（调用方在**锁外** loud，绝不退化成阻塞读）。
    /// FIONREAD = _IOR('f', 127, int) = 0x4004_667f（Darwin 的 C 宏未导入 Swift，
    /// 故硬编码并注明来源；XNU bsd/sys/filio.h）。
    /// 注意：句柄若已被 close，访问 fileDescriptor 会抛 ObjC 异常——nil 分支只覆盖
    /// ioctl 失败（ENOTTY 等）；本类从不 close 管道句柄，故该异常面在本类内不可达。
    private static let fionreadRequest: UInt = 0x4004_667f
    /// 收尾抽干批次上限（默认 1024）。生产中单次读 ≤64KiB 且管道容量有限，1024 批
    /// 不可自然触发；测试接缝可调低以覆盖「上限命中」分支。
    private var drainBatchLimit = 1024
    /// 测试接缝：在后台线程持有 lifecycleLock 指定时长（验证 start() 的有界等待与 code 6
    /// 超时路径）。返回的信号量在锁**已获取**后 signal。
    /// 注意：测试持锁时长须显著大于 terminalTransitionTimeout（默认 2s），否则
    /// 调度抖动会让 start() 在锁释放后才进入判定、假红（验证者 1 NIT）。
    func holdLifecycleLockForTesting(seconds: TimeInterval)
        -> (acquired: DispatchSemaphore, released: DispatchSemaphore) {
        let acquired = DispatchSemaphore(value: 0)
        let released = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            self.lifecycleLock.lock()
            acquired.signal()
            Thread.sleep(forTimeInterval: seconds)
            self.lifecycleLock.unlock()
            released.signal()
        }
        return (acquired, released)
    }

    /// 测试接缝：本客户端诊断日志的目标句柄（默认 stderr）。用于验证「日志绝不阻塞调用方」。
    func setLogSinkForTesting(_ handle: FileHandle) { logSink.setSink(handle) }

    /// 测试接缝：连续入队 n 行诊断日志（验证调用方不被阻塞写拖住）。
    func logBurstForTesting(_ count: Int) {
        let filler = String(repeating: "x", count: 64)
        for index in 0..<count { log("burst \(index) \(filler)") }
    }

    /// 测试接缝：单行诊断日志（并发写入正确性用）。
    func logLineForTesting(_ message: String) { log(message) }

    /// 测试接缝：走**生产派发路径**（dispatchLock 串行）投递一批 stdout 行——用于验证
    /// 并发调用下回调绝不并发（第三轮验证 F1 回归网）。
    func dispatchStdoutForTesting(_ lines: [Data], generation: Int) {
        dispatchStdout([LineReader.Outcome(lines: lines, overflowResets: 0)], generation: generation)
    }

    /// 测试接缝：调低抽干批次上限（0 = 立即命中上限、不消费任何字节）。
    func setDrainBatchLimitForTesting(_ limit: Int) {
        readerLock.lock()
        drainBatchLimit = limit
        readerLock.unlock()
    }

    /// 测试接缝：FIONREAD 常量/语义回归网（写错常量会让抽干静默变 no-op）。
    /// -1 = 探测失败。
    func bytesAvailableForTesting(_ handle: FileHandle) -> Int { bytesAvailable(handle) ?? -1 }

    private func bytesAvailable(_ handle: FileHandle) -> Int? {
        var count: Int32 = 0
        guard ioctl(handle.fileDescriptor, Self.fionreadRequest, &count) == 0 else { return nil }
        return Int(count)
    }

    /// 读回调（同 readStdout 的就绪契约：锁内 availableData 不阻塞）。
    private func readStderr(_ handle: FileHandle) {
        var outcome: LineReader.Outcome?
        var generation = 0
        readerLock.lock()
        generation = readerGeneration
        if stderrHandle === handle, !stderrEOF {
            let data = handle.availableData
            if data.isEmpty {
                // stderr 日志流 EOF：摘回调并收尾残余行（尽力透传，丢了也无妨）。
                handle.readabilityHandler = nil
                stderrEOF = true
                outcome = stderrReader.finish()
            } else {
                outcome = stderrReader.append(data)
            }
        }
        readerLock.unlock()
        if let outcome { dispatchStderr([outcome], generation: generation) }
    }

    /// stdout 帧行分发（internal：测试接缝，与 handleIncomingLine 同规）：违约
    /// 计数 loud；每行先过超长检查再过结构解码，都不过即打印 + 丢弃（fail-loud，
    /// design 25 §4.4.2）。
    ///
    /// B-BUG-1（独立审查实测）：真实管道按 16KiB 分块，>maxBufferedBytes 的单行
    /// 会先触发 LineReader 溢出重同步——被丢掉的字节可能正是某个响应的前半段，
    /// 该响应此后永远无法配对。故溢出即作废全部未决请求（fail-closed），绝不留下
    /// 悬挂到 stop() 的 invoke。
    func processStdoutOutcome(_ outcome: LineReader.Outcome, generation: Int) {
        reportLineReaderIssues(outcome, channel: "stdout")
        // 派发前的会话代际门（最终验证者 RISK-2）：切行在 readerLock 内完成、派发在
        // 锁外，收尾被 start() 插入时旧会话的帧不得进入新会话（响应/事件/edge 应答）。
        lock.lock()
        let isCurrent = sessionGeneration == generation
        lock.unlock()
        guard isCurrent else {
            log("stdout：旧会话帧丢弃（会话代际已推进，\(outcome.lines.count) 行）")
            return
        }
        // 先派发本批已切出的完整行（它们在流序上先于被丢弃的残尾），再作废
        // 未决请求：否则同批里已到达的响应会先被 code 4 顶掉（验证者 2 NIT；
        // 真实管道下不可达——单批 ≤64KiB < 4MiB，测试接缝可达）。
        //
        // **逐行复核代际**（第三轮验证 BUG）：单批最多可含数千小帧（≤64KiB），
        // stop()/重启可在批次派发中途推进代际——已过门的批次不得把剩余行继续
        // 投进回调（否则 stop() 返回后仍有旧会话事件到达）。每行一次无竞争
        // NSLock，与 deliverResponse 的每响应一次同量级。
        for (index, line) in outcome.lines.enumerated() {
            lock.lock()
            let stillCurrent = sessionGeneration == generation
            lock.unlock()
            guard stillCurrent else {
                log("stdout：会话代际已推进，丢弃本批剩余 \(outcome.lines.count - index) 行")
                break
            }
            handleIncomingLine(line, generation: generation)   // Data 直入，无中间 String
        }
        if outcome.overflowResets > 0 {
            _ = failAllPending(reason: "stdout 无换行缓冲超限，已清缓冲重新同步；被丢弃字节可能与未决请求相关",
                               ifGeneration: generation)
        }
    }

    /// stderr 行 → 标准错误透传（D2：sidecar 的 console.* 重定向到 stderr，
    /// Swift 侧原样透传、前缀 "[sidecar] "）。UTF-8 判定只在这一侧（stdout 的
    /// 判定由 JSONSerialization 承担），非 UTF-8 行计数后丢弃并 loud。
    func processStderrOutcome(_ outcome: LineReader.Outcome, generation: Int) {
        reportLineReaderIssues(outcome, channel: "stderr")
        // 同上：旧会话的日志行不得进入新会话的摘要/透传。
        lock.lock()
        let isCurrent = sessionGeneration == generation
        lock.unlock()
        guard isCurrent else { return }
        var invalid = 0
        for line in outcome.lines {
            guard let text = String(data: line, encoding: .utf8) else {
                invalid += 1
                continue
            }
            relaySidecarLogLine(text)
        }
        if invalid > 0 {
            log("stderr：丢弃 \(invalid) 行非 UTF-8 数据")
        }
    }

    /// 违约计数 loud 上报（帧/行内容由各自的处理函数负责）。
    private func reportLineReaderIssues(_ outcome: LineReader.Outcome, channel: String) {
        if outcome.overflowResets > 0 {
            let consequence = channel == "stdout" ? "，并作废全部未决请求（fail-closed）" : ""
            log("\(channel)：无换行数据超过缓冲上限（默认 \(FrameCodec.maxFrameBytes) 字节），已清缓冲重新同步\(consequence)")
        }
    }

    /// 单条协议行 → 帧分发。超长/非法 → 打印错误并丢弃该帧，绝不静默继续。
    ///
    /// G9：internal（非 private）是**测试接缝**——读路径（LineReader →
    /// processStdoutOutcome → 本函数）此前零 XCTest 覆盖；@testable 只放开
    /// internal，本函数没有进入公开面，生产调用点仍只有 processStdoutOutcome。
    ///
    /// Phase 1 C3：**每行只解析一次**——一次 JSONSerialization → [String: Any]
    /// 同时喂 `FrameCodec.classify`（id 族）与 `decodeOutboundFrame(jsonObject:)`
    /// （edge/notify 族）。旧路径先 JSONDecoder 解一次、归 nil 后再
    /// JSONSerialization 解第二次（另加两次 UTF-8 重编码与两次长度扫描）。
    /// 严格性（类型不符毒化整行）集中在 FrameCodec.classify。
    ///
    /// R2：入口是**原始字节**（LineReader 不再物化 String），UTF-8 合法性由
    /// JSONSerialization 判定；String 形态仅作测试接缝。
    func handleIncomingLine(_ data: Data, generation: Int?) {
        guard data.count <= FrameCodec.maxFrameBytes else {
            // 2026-12 双端逐函数核对 F4：超长行连 id 都解析不出（响应被截断），
            // 若它正对应某个未决请求，该 continuation 会永久悬挂（Electron 侧
            // 无长度上限）。fail-closed：loud 上报并作废全部未决请求，绝不静默
            // 留一个永不 settle 的 Promise。
            log("收到超长行（> \(FrameCodec.maxFrameBytes) 字节），丢弃该帧：\(Self.preview(data))")
            _ = failAllPending(reason: "sidecar 响应超过 \(FrameCodec.maxFrameBytes) 字节上限，无法与请求配对",
                               ifGeneration: generation)
            return
        }
        // 计数点在任何解析尝试之前：每行（超长行除外）恰好一次解析尝试。
        Self.noteInboundParse()
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            // 非协议帧：非法 UTF-8 / 非 JSON / 顶层非对象。D2 重定向后仍泄漏
            // 说明有 console 直写 stdout，须修——fail-loud 打印（截断预览），
            // 不向任何调用方投递。
            log("收到非协议帧（非 UTF-8 / 非 JSON / 顶层非对象），丢弃：\(Self.preview(data))")
            return
        }
        if let frame = FrameCodec.classify(jsonObject: object) {
            switch frame {
            case .response(let id, let ok, let result, let error):
                deliverResponse(id: id, ok: ok, result: result, error: error)
            case .event(let event, let payload):
                // 事件在读取线程回调（见文件头线程契约）；无订阅者 → loud
                // （事件静默丢弃会让上层状态机漏状态，POC 宁响勿哑）。
                if let handler = onEvent {
                    handler(event, payload)
                } else {
                    log("收到事件「\(event)」但 onEvent 未设置，丢弃")
                }
            case .request:
                // sidecar 从不发起带 id+method 的 request 帧（B 桥 id 所有权恒在
                // Swift 侧；edge:* 反向通道是**出站帧** edge/notify 两族，已由
                // decodeOutboundFrame 单独分类，不落本 case）。无法配对的响应只
                // 会制造悬挂，loud 丢弃并声明不支持。
                log("收到 sidecar→Swift request 帧（协议违约，B 桥 id 所有权在 Swift 侧），丢弃：\(Self.preview(data))")
            }
            return
        }
        // id 族分类未命中 → 试出站面分类（edge/notify 两族——它们既无 id 也
        // 无 event 键，不在 request/response/event 三族内，见 decodeOutboundFrame
        // 注释；M3 前这类帧在此被当非协议行 loud 丢弃，sidecar 的 sendEdge 因此
        // 挂起——W-15/16 修复点）。
        if let outbound = Self.decodeOutboundFrame(jsonObject: object) {
            dispatchOutboundFrame(outbound, generation: generation)
            return
        }
        log("收到非协议帧（非法结构 / 缺 id / 未知键组合），丢弃：\(Self.preview(data))")
    }

    /// 测试接缝：无代际标签的 Data 形态（按当前会话语义：终局动作不打门）。
    func handleIncomingLine(_ data: Data) {
        handleIncomingLine(data, generation: nil)
    }

    /// 测试接缝：String 形态的入站行（生产走 Data 版本，避免重复编码）。
    func handleIncomingLine(_ line: String) {
        handleIncomingLine(Data(line.utf8), generation: nil)
    }

    // MARK: - 出站帧（sidecar → Swift：edge/notify）解码与分发（M3 W-15/16）

    /// 出站帧的原始行分类结果（B 桥线协议在 request/response/event 三族之外
    /// 的两族，sidecar → Swift 方向）。
    private enum OutboundFrame {
        /// sidecar→Swift edge 请求：期待 {"edgeId":N,"ok":…} 应答（edgeId 原样
        /// 回写）。payload 为 AnyCodable?（无 payload 键 → nil）。
        case edgeRequest(method: String, payload: AnyCodable?, edgeId: Int64)
        /// sidecar→Swift notify 单向帧（不期待应答；ready 也在此，分发特判）。
        case notify(event: String, payload: AnyCodable?)
    }

    /// 已解析顶层 JSON 对象 → 出站帧分类（Phase 1 C3：对象来自
    /// handleIncomingLine 的唯一一次解析，本函数不再自行 JSONSerialization）。
    /// **在 BridgeClient 层做而不扩 FrameCodec/
    /// BridgeFrame**：edge/notify 帧既无 id 也无 event 键，decodeLine 按容忍
    /// 语义归 nil（M3 前 → 非协议行 loud 丢弃）；若给 BridgeFrame 增加 case，
    /// 需同步 FrameCodec 的 encode/decode 与其既有单测断言族（FrameCodecTests
    /// 的分类优先序/容忍断言），POC 取本层先行分类的最小侵入——注释声明：
    /// W-17 协议族稳定后若收编回 FrameCodec，本函数与 dispatchOutboundFrame
    /// 一并迁移，BridgeClient 公开出口不变。
    /// 分类确定性（防歧义帧摇摆）：edge 键优先于 notify 键（两族协议互斥）；
    /// 结构不合法（edge/notify 名非字符串、edgeId 非数值等）→ nil，调用方
    /// loud（与 decodeLine 的 nil 语义同构）。
    private static func decodeOutboundFrame(jsonObject object: [String: Any]) -> OutboundFrame? {
        // Phase 1 C3 补口（独立审查 RISK）：与 FrameCodec.classify 同规——**已知键
        // 存在但类型不符毒化整行**。旧实现用 `as?` 链会让
        // {"edge":5,"notify":"ready",…} 跳过非法 edge 落到 notify 分类；两族
        // 协议互斥，类型不符即违约 → nil（调用方 loud 丢弃，fail closed）。
        if object.keys.contains("edge") {
            guard let edgeName = object["edge"] as? String else { return nil }
            // edgeId 必须为 JSON 整数：Bool 的 NSNumber 桥接同样过 as? NSNumber，
            // 须 CFTypeID 判别（与 AnyCodable.fromJSONObject 同规）；浮点存储只
            // 接受精确 Int64（1.0 可、1.5 拒绝），域外拒绝。
            guard let edgeID = Self.exactInt64(object["edgeId"]) else { return nil }
            return .edgeRequest(method: edgeName,
                                payload: Self.outboundPayload(in: object),
                                edgeId: edgeID)
        }
        if object.keys.contains("notify") {
            guard let event = object["notify"] as? String else { return nil }
            return .notify(event: event, payload: Self.outboundPayload(in: object))
        }
        return nil
    }

    /// 出站 edgeId 的严格整数取值：Bool 排除；非浮点存储无损取 Int64；浮点存储
    /// 要求精确可表示且排除 -2^63 边界——与 FrameCodec.intValue（classify 的 id 域）
    /// 逐条同规（差异见其注释：JSONSerialization 已丢原始 token）。
    private static func exactInt64(_ raw: Any?) -> Int64? {
        guard let raw, let number = raw as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        if !CFNumberIsFloatType(number) { return number as? Int64 }
        let double = number.doubleValue
        guard double != -9_223_372_036_854_775_808.0 else { return nil }
        return Int64(exactly: double)
    }

    /// 出站帧 payload 键取值：键缺省 → nil；显式 null → .null；其它 JSON 值 →
    /// AnyCodable（非 JSON 可表示值不产生——fromJSONObject 诚实失败）。
    private static func outboundPayload(in object: [String: Any]) -> AnyCodable? {
        guard object.keys.contains("payload") else { return nil }
        return AnyCodable.fromJSONObject(object["payload"] as Any)
    }

    /// 出站帧分发（管道读取线程；回调线程契约同 onEvent）。
    private func dispatchOutboundFrame(_ frame: OutboundFrame, generation: Int?) {
        switch frame {
        case .edgeRequest(let method, let payload, let edgeId):
            handleEdgeRequest(method: method, payload: payload, edgeId: edgeId, generation: generation)
        case .notify(let event, let payload):
            if event == "ready" {
                deliverReady(payload)
            } else if let handler = onNotify {
                handler(event, payload)
            } else {
                log("收到 notify「\(event)」但 onNotify 未设置，丢弃")
            }
        }
    }

    /// 单个 edge 请求的应答编排。sidecar 侧 sendEdge 在等应答（node-edges
    /// pendingEdges 无超时）——本方法保证必答（恰好一次）：
    ///   - onEdgeRequest 已设置 → 交给自定义应答器（reply 可延后/跨线程；
    ///     恰好一次由 sendEdgeReply 的 edgeId 守卫保证；未处理的方法请回落
    ///     defaultEdgeResponse——自定义应答器不应答会造成挂起，注释声明）；
    ///   - 未设置 → v1 默认策略立即应答（defaultEdgeResponse，绝不挂起）。
    private func handleEdgeRequest(method: String, payload: AnyCodable?, edgeId: Int64,
                                   generation: Int?) {
        // 应答代际 = 帧通过派发代际门时校验的那一代（第三轮审查 R5）：此前在应答时
        // 重读 sessionGeneration，并发 start() 会让旧 edgeId 的迟到应答以**新**代际
        // 通过 sendEdgeReply 守卫，写进新会话 stdin。测试接缝（generation nil）回落
        // 到**请求处理时**读取（第三轮验证 NIT：此前的注释写成「应答时读取」，与实现相悖）。
        let replyGeneration: Int
        if let generation {
            replyGeneration = generation
        } else {
            lock.lock()
            replyGeneration = sessionGeneration
            lock.unlock()
        }
        let reply: (_ result: AnyCodable?, _ error: String?) -> Void = { [weak self] result, error in
            self?.sendEdgeReply(edgeId: edgeId, generation: replyGeneration,
                                result: result, error: error)
        }
        if let responder = onEdgeRequest {
            responder(method, payload, reply)
        } else {
            let outcome = defaultEdgeResponse(method: method, payload: payload)
            reply(outcome.result, outcome.error)
        }
    }

    /// ready notify 分发：结构校验（{port:Int,shellVersion:非空字符串}）后回调
    /// onReady；载荷非法或无订阅者 → loud（ready 是启动编排的关键帧，宁响勿哑）。
    private func deliverReady(_ payload: AnyCodable?) {
        guard case .object(let fields)? = payload,
              case .number(let portNumber)? = fields["port"],
              let port = Int(exactly: portNumber),
              case .string(let shellVersion)? = fields["shellVersion"],
              !shellVersion.isEmpty else {
            log("ready notify 载荷结构非法，丢弃：\(Self.preview(String(describing: payload)))")
            return
        }
        if let handler = onReady {
            handler(port, shellVersion)
        } else {
            log("收到 ready notify（port=\(port)）但 onReady 未设置，丢弃")
        }
    }

    /// edge 应答帧的线格式信封（与 sidecar 期待逐字段一致；本文件本地收编的
    /// 第四族编码——见 decodeOutboundFrame 注释）：
    ///   ok=true  → {"edgeId":N,"ok":true,"result":…}（result 恒写键，null
    ///     载荷 → JSON null；error 键省略）；
    ///   ok=false → {"edgeId":N,"ok":false,"error":"…"}（result 键省略）。
    private struct EdgeReplyEnvelope: Codable {
        var edgeId: Int64
        var ok: Bool
        var result: AnyCodable?
        var error: String?
    }

    /// edge 应答写回 sidecar：edgeId 原样回；单行原子写经既有 inputPipe
    /// （锁内取句柄、锁外写——与 invoke 同款；stop 竞态由句柄缺失分支兜底，
    /// loud 丢弃而不是 crash）。
    /// 恰好一次：已应答的 edgeId 重复应答 / 代际过期（stop 后重启的新会话）
    /// → loud 丢弃（与 deliverResponse 的 pending 所有权纪律同构）。
    private func sendEdgeReply(edgeId: Int64, generation: Int,
                               result: AnyCodable?, error: String?) {
        let envelope: EdgeReplyEnvelope
        if let error {
            envelope = EdgeReplyEnvelope(edgeId: edgeId, ok: false,
                                         result: nil, error: error)
        } else {
            envelope = EdgeReplyEnvelope(edgeId: edgeId, ok: true,
                                         result: result ?? .null, error: nil)
        }
        var data: Data
        do {
            data = try JSONEncoder().encode(envelope)
        } catch {
            log("edgeId=\(edgeId) 应答编码失败（丢弃）：\(error.localizedDescription)")
            return
        }
        guard data.count <= FrameCodec.maxFrameBytes else {
            log("edgeId=\(edgeId) 应答超限（丢弃）：\(data.count) 字节")
            return
        }
        data.append(0x0A)

        var input: FileHandle?
        var refused: String?
        lock.lock()
        if answeredEdgeIDs.contains(edgeId) {
            refused = "重复应答（edgeId=\(edgeId) 已应答过）"
        } else if generation != sessionGeneration {
            refused = "应答代际过期（edgeId=\(edgeId)，会话已重启）"
        } else if let pipe = inputPipe, let process = process, process.isRunning {
            // 与写入同锁区插入守卫（恰好一次的纪律）；写失败时**回滚守卫**（见下），
            // 使同 id 的应答可重试，而不是被永久记成「重复应答」等对端超时。
            _ = answeredEdgeIDs.firstInsert(edgeId)
            input = pipe.fileHandleForWriting
        } else {
            refused = "客户端未运行（未 start / 已 stop / sidecar 已退出）"
        }
        lock.unlock()
        if let refused {
            log("edgeId=\(edgeId) 应答丢弃：\(refused)")
            return
        }
        do {
            writeLock.lock()
            defer { writeLock.unlock() }
            try input?.write(contentsOf: data)
        } catch {
            // 写失败回滚守卫（第三轮验证 NIT）：本 id 未被对端收到，撤销「已应答」
            // 标记，使同 id 的再次 reply 不被误判为重复。带**代际门**——若写抛错到
            // 回滚之间恰好完成 stop()+start()，新会话可能已为同号 edgeId 插入守卫，
            // 此时回滚会误删新会话的标记（第四轮验证 NIT）。
            lock.lock()
            if generation == sessionGeneration { answeredEdgeIDs.remove(edgeId) }
            lock.unlock()
            log("edgeId=\(edgeId) 应答写失败（本代际守卫已回滚；同一 reply 再调用可重试——注意 replyGate 本身仍恰好一次）：\(error.localizedDescription)")
        }
    }

    // MARK: - 请求/响应配对

    /// 分配单调 id（1 起；线程安全）。溢出回绕仅理论可达（2^63 次调用），
    /// 回绕后与旧 pending 撞 id 的窗口注释声明（实际不可达）。
    private func allocateID() -> Int {
        lock.lock()
        defer { lock.unlock() }
        let id = nextID
        nextID = (nextID == Int.max) ? 1 : nextID + 1
        return id
    }

    /// 发起一次方法调用：编码帧 → 登记 continuation → 写入 stdin → 等响应。
    /// 成功返回 AnyCodable（ok=true；result 为 JSON null 时给 .null）；
    /// ok=false 抛 NSError(domain:"BridgeClient", code:1, userInfo 带 error
    /// 文案)；本地失败（未运行 code 2 / 写失败 code 3 / 进程退出 code 4 /
    /// 帧超限 FrameCodecError）对应抛出。可跨线程并发调用（内部锁保证 id
    /// 唯一、写串行、pending 安全）。
    public func invoke(method: String, payload: AnyCodable? = nil) async throws -> AnyCodable {
        // 先占 id 后编码：编码失败（超限等）仅烧号、不登记、不悬挂——id
        // 单调语义不受影响（静态审查 #3 注释修正）。
        let id = allocateID()
        let data = try FrameCodec.encode(.request(id: id, method: method, payload: payload))
        return try await withCheckedThrowingContinuation { continuation in
            // 登记先于写入：sidecar 只可能收到帧后应答，“应答先到而登记未
            // 就”的窗口不存在；写失败再回滚登记（见下），绝不留悬挂。
            // 写句柄与登记在同一锁区间内取出：stop() 可能在解锁后立刻摘除
            // inputPipe，若锁外再读会拿到 nil 而 continuation 已登记——后续
            // 响应/作废会二次 resume。句柄本地强持有，写失败路径负责回滚。
            var input: FileHandle?
            lock.lock()
            if let inputPipe = inputPipe, let process = process, process.isRunning {
                pending[id] = PendingEntry(continuation: continuation, generation: sessionGeneration)
                input = inputPipe.fileHandleForWriting
            }
            lock.unlock()
            guard let input else {
                continuation.resume(throwing: Self.makeError(
                    code: Self.errorCodeNotRunning,
                    message: "BridgeClient 未在运行（未 start / 已 stop / sidecar 已退出）"))
                return
            }

            do {
                writeLock.lock()
                defer { writeLock.unlock() }
                try input.write(contentsOf: data)
            } catch {
                // 写失败（子进程已亡 / 管道破裂等）：回滚登记。回滚结果决定
                // 谁 resume——stop()/退出路径可能已作废本 id（removeValue 返回
                // nil → 不得二次 resume，续体恰好一次的纪律）。
                lock.lock()
                let removed = pending.removeValue(forKey: id)
                lock.unlock()
                if removed != nil {
                    continuation.resume(throwing: Self.makeError(
                        code: Self.errorCodeWriteFailed,
                        message: "写帧失败（id=\(id)）：\(error.localizedDescription)"))
                }
            }
        }
    }

    /// 响应分发：锁内取走 pending 条目（id 所有权转移），锁外 resume。
    /// 未知/重复 id → loud（响应必须与未决请求一一配对，id 纪律）。
    private func deliverResponse(id: Int, ok: Bool, result: AnyCodable?, error: String?) {
        var continuation: CheckedContinuation<AnyCodable, Error>?
        lock.lock()
        continuation = pending.removeValue(forKey: id)?.continuation
        lock.unlock()
        guard let continuation else {
            log("收到未知/重复 id=\(id) 的响应帧（无对应未决请求），丢弃")
            return
        }
        if ok {
            continuation.resume(returning: result ?? .null)
        } else {
            // spec：ok=false → NSError，domain "BridgeClient"，code 1，
            // userInfo 带 error 文案（error 缺省时给兜底文案——解码容忍层）。
            let message = error ?? "sidecar 返回 ok=false 但未附 error 文案"
            continuation.resume(throwing: Self.makeError(code: Self.errorCodeInvocationFailed,
                                                         message: message))
        }
    }

    /// 全部未决请求作废（进程退出 / stop）：锁内清空字典，锁外逐个 resume
    /// throw（code 4）。与 deliverResponse 互斥，续体恰好一次由字典所有权保证。
    /// 代际分桶结算版本（最终验证者 RISK-1 + 独立验证者 1 的 TOCTOU）：判定、
    /// 按代际取条目、排空在**同一次加锁**内完成。只结算 `generation`（nil = 全部）
    /// 登记的条目——既不误杀新会话刚登记的 invoke，也不让旧会话自己的请求悬挂
    /// （全局门跳过旧条目会把它永久留在 pending）。
    /// 返回值 = 该代际是否仍是当前会话（调用方据此决定 onTerminated 等终局动作）。
    @discardableResult
    private func failAllPending(reason: String, ifGeneration generation: Int?) -> Bool {
        var drained: [CheckedContinuation<AnyCodable, Error>] = []
        lock.lock()
        let isCurrent = generation == nil || sessionGeneration == generation
        if let generation {
            for (id, entry) in pending where entry.generation == generation {
                if let removed = pending.removeValue(forKey: id) {
                    drained.append(removed.continuation)
                }
            }
        } else {
            drained = pending.values.map(\.continuation)
            pending.removeAll()
        }
        lock.unlock()
        guard !drained.isEmpty else { return isCurrent }
        log("\(reason)（\(drained.count) 个未决请求作废）")
        let error = Self.makeError(code: Self.errorCodePendingDropped, message: reason)
        for continuation in drained {
            continuation.resume(throwing: error)
        }
        return isCurrent
    }

    // MARK: - 日志

    /// 有界日志汇聚（第六轮残留清理）：`log()` 只把行**入队**（≤ maxQueueLines），由单条
    /// 后台线程写 stderr——因此持 lifecycleLock / dispatchLock / lock 的路径**绝不在锁内做
    /// 阻塞 I/O**。宿主 stderr 停止排水（管道满且无人读）时只堵住汇聚线程：队列满即丢弃并
    /// 计数，恢复后补一行汇总。FIFO 保序；正常排水下逐行即时送出（退出前未排空的行可能
    /// 丢失——诊断可接受的代价，换来「锁永不被 I/O 拖住」）。
    private final class LogSink: @unchecked Sendable {
        static let maxQueueLines = 512
        /// 一条待写行 + 它的**旁路落盘载荷**（sidecar.log 兜底；nil = 只写 stderr）。
        private struct Entry {
            let line: String
            let sidecar: String?
        }
        private let lock = NSLock()
        private var queue: [Entry] = []
        private var dropped = 0
        private var draining = false
        private var sink: FileHandle = .standardError
        /// 旁路消费者（**只在汇聚线程上**调用，绝不持 bridge 的锁）：生产端是
        /// ShellLog.sidecar.append（自带 NSLock，写失败静默）。这样 sidecar.log
        /// 的落盘既不丢证据、也不在 dispatchLock/lifecycleLock 内阻塞。
        var sidecarSink: ((String) -> Void)?

        func setSink(_ handle: FileHandle) {
            lock.lock()
            sink = handle
            lock.unlock()
        }

        func enqueue(_ line: String, sidecar: String? = nil) {
            lock.lock()
            if queue.count < Self.maxQueueLines {
                queue.append(Entry(line: line, sidecar: sidecar))
            } else {
                dropped += 1
            }
            let startDrain = !draining
            if startDrain { draining = true }
            lock.unlock()
            if startDrain { Thread.detachNewThread { self.drain() } }
        }

        private func drain() {
            while true {
                lock.lock()
                if queue.isEmpty {
                    guard dropped > 0 else {
                        draining = false
                        lock.unlock()
                        return
                    }
                    // 汇总行按**普通行**处理（仍在 draining=true 下）：单一 drainer、
                    // FIFO 保持、sink 在锁内取快照（第七轮验证 RISK：此前解锁后再写，
                    // 窗口内新 enqueue 会起第二条 drainer 并让汇总行后置）。
                    let note = "[bridge] …日志队列满，丢弃 \(dropped) 行\n"
                    dropped = 0
                    let handle = sink
                    lock.unlock()
                    try? handle.write(contentsOf: Data(note.utf8))
                    continue
                }
                let entry = queue.removeFirst()
                let handle = sink
                let sidecarSink = self.sidecarSink
                lock.unlock()
                try? handle.write(contentsOf: Data(entry.line.utf8))   // 阻塞只发生在汇聚线程
                if let sidecar = entry.sidecar { sidecarSink?(sidecar) }
            }
        }
    }

    /// 本客户端的诊断日志 → 标准错误（自己的 stderr，与 sidecar 日志流
    /// 区分前缀：本类 "[bridge] " / 透传 "[sidecar] "）。非阻塞：见 LogSink。
    private func log(_ message: String) {
        logSink.enqueue("[bridge] \(message)\n")
    }

    /// sidecar stderr 行 → 透传文本（S-29：Swift flavor 无 Electron safeStorage
    /// adapter，Electron 写的 safeStorage 凭证文件不可读时，sidecar 的精确 loud
    /// 文案只经这条日志链到达用户——逐字保留，绝不截断/改写；抽成静态纯函数
    /// 供单测钉住）。
    static func relayedSidecarLogLine(_ line: String) -> String {
        "[sidecar] \(line)\n"
    }

    /// sidecar stderr 行透传（D2：stderr = 唯一日志通道，原样输出）+ T-3 入
    /// 有界环形（供启动失败报告读取同一份「死前证据」）。
    private func relaySidecarLogLine(_ line: String) {
        let captured = line.count > Self.stderrLineCharLimit
            ? String(line.prefix(Self.stderrLineCharLimit)) + "…"
            : line
        stderrLock.lock()
        stderrTail.append(captured)
        if stderrTail.count > Self.stderrTailLimit {
            stderrTail.removeFirst(stderrTail.count - Self.stderrTailLimit)
        }
        stderrLock.unlock()
        // 与 log() 同一条有界非阻塞通道（第七轮验证 BUG）：本方法经 handleTermination 的
        // finishStderrReading 在 dispatchLock+lifecycleLock 内执行，绝不在此做阻塞写。
        // 2026-12 取证修复（ui-chat 批次）同时保留 sidecar.log 兜底：落盘载荷经 sidecar
        // 参数交给**同一汇聚线程**上的旁路消费者，仍然不在锁内做阻塞 I/O（合并两批的
        // 契约：既不能丢证据，也不能在锁里写盘）。
        logSink.enqueue(Self.relayedSidecarLogLine(line), sidecar: captured)
    }

    /// 行预览（日志用；截断防刷屏，不做内容转义——日志通道本机可见）。
    private static func preview(_ line: String, maxLength: Int = 160) -> String {
        let truncated = line.prefix(maxLength)
        return line.count > maxLength ? "\(truncated)…" : line
    }

    /// 字节行预览：repairing 解码（可能截断多字节序列，只用于日志）。
    private static func preview(_ data: Data, maxLength: Int = 160) -> String {
        let truncated = String(decoding: data.prefix(maxLength), as: UTF8.self)
        return data.count > maxLength ? "\(truncated)…" : truncated
    }

    /// NSError 工厂（domain/文案统一）。
    private static func makeError(code: Int, message: String) -> NSError {
        NSError(domain: Self.errorDomain, code: code,
                userInfo: [NSLocalizedDescriptionKey: message])
    }
}
