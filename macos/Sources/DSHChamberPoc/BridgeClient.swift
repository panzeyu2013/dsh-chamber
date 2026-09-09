// BridgeClient.swift —— B 桥进程客户端（Swift 侧 spawn + NDJSON 读写 + invoke）
//
// design 25 §4.4.2（B 桥 Swift ↔ sidecar）与 W-05（垂直切片，
// docs/progress/todo/macos-swift-v1.md §0.2-⑥）的 Swift 侧实现。AppDelegate
// 与 MessageHandler 作者按本文件的公开契约引用（构造/start/stop/invoke/
// onEvent），勿改名。
//
// 进程模型（design 25 §3.1）：Swift 应用是客户端、sidecar（打包 Node +
// JS bundle；POC 期 = `node packages/desktop/poc-sidecar.ts`，另一作者实现，
// 见 AppDelegate.sidecarRelativePath）是服务端——
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
//   - onEvent / 响应分发在**管道读取线程**（Foundation 内部队列，非主线程）
//     回调；事件/结果只读不改状态，调用方负责切回主线程再碰 UI/WKWebView
//     （MainWindowController 以 Task { @MainActor } 收敛，MessageHandler
//     注释同款声明）。
//
// 本文件为纯 Foundation（无 AppKit/WebKit；kill/SIGKILL/SIGPIPE 等 Darwin
// 符号经 Foundation 再导出直接可用，无需额外 import）；Swift 5 语言模式；
// macOS 13+。

import Foundation

/// B 桥 stdout/stderr 的行缓冲读取器：Data 积累 + 按 \n 切分（兼容 \r\n），
/// 整行到手后才做 UTF-8 解码（跨 read 块的 UTF-8 多字节序列不会被腰斩）。
///
/// 线程契约：同一实例只允许单线程串行驱动 append；finish() 允许在另一线程
/// 调用（BridgeClient 里 stdout 读取回调与进程终止回调会竞争收尾，统一经
/// client 的 lock 串行化）。纯值语义，无副作用，便于 XCTest 直测。
struct LineReader {

    /// 一次 append/finish 的结果：完整行 + 违约计数（只数不喊——打印与
    /// 丢弃由调用方 loud 完成，本类型保持纯）。
    struct Outcome {
        var lines: [String] = []        // 完整行（空行保留；\r\n 已去 \r）
        var invalidUTF8Lines = 0        // 完整行但非 UTF-8：跳过并计数
        var overflowResets = 0          // 无换行缓冲超上限：清缓冲重同步并计数
    }

    /// 无换行缓冲上限：超过即丢弃部分缓冲重新同步（配合帧长上限；默认与
    /// FrameCodec.maxFrameBytes 同值 4 MiB）。
    private let maxBufferedBytes: Int
    private var buffer = Data()
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
        while let newline = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer.subdata(in: buffer.startIndex..<newline)
            buffer.removeSubrange(buffer.startIndex...newline)
            appendLine(lineData, into: &outcome)
        }
        if emitPartialTail, !buffer.isEmpty {
            let tail = buffer
            buffer.removeAll(keepingCapacity: true)
            appendLine(tail, into: &outcome)
        } else if buffer.count > maxBufferedBytes {
            // 海量无换行数据（协议违约流，永远切不出行）→ 清缓冲重新同步，
            // 防内存无限增长；计数交调用方 loud。
            buffer.removeAll(keepingCapacity: true)
            outcome.overflowResets += 1
        }
    }

    /// 单行字节 → 文本（\r\n 兼容：剥行尾 \r；非 UTF-8 → 计数不产出）。
    private mutating func appendLine(_ data: Data, into outcome: inout Outcome) {
        var lineData = data
        if lineData.last == 0x0D { lineData.removeLast() }
        guard let text = String(data: lineData, encoding: .utf8) else {
            outcome.invalidUTF8Lines += 1
            return
        }
        outcome.lines.append(text)
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

    // MARK: - 构造参数

    private let nodePath: String
    private let arguments: [String]
    private let environment: [String: String]

    /// 构造（AppDelegate 按此签名调用，勿改名——第四参数带默认值，既有三参
    /// 调用不变）。
    /// - Parameters:
    ///   - nodePath: Node 可执行文件路径（POC：系统 node 或 Electron 二进制
    ///     + ELECTRON_RUN_AS_NODE=1，见 AppDelegate）。
    ///   - arguments: sidecar 脚本路径与参数（POC：poc-sidecar.ts 路径）。
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
    /// 写串行锁（管道写不与其他帧交错；见文件头「写帧」注释）。
    private let writeLock = NSLock()
    private var process: Process?
    private var inputPipe: Pipe?        // 子进程 stdin 写端
    private var outputPipe: Pipe?       // 子进程 stdout 读端（协议流）
    private var errorPipe: Pipe?        // 子进程 stderr 读端（日志流）
    private var outputReader = LineReader()
    private var stderrReader = LineReader()
    private var nextID = 1
    private var pending: [Int: CheckedContinuation<AnyCodable, Error>] = [:]
    private var sigpipeIgnored = false
    // —— M3 W-15/16 出站面状态 ——
    /// 已应答 edgeId 集合（锁保护）：edge 应答恰好一次的守卫（与 pending 字典
    /// 的 id 所有权纪律同构——edgeId 的所有权 = 本集合的插入成功）。
    private var answeredEdgeIDs = Set<Int64>()
    /// 会话代际（锁保护）：start() 每次递增。stop/重启后，旧会话 dispatch 的
    /// edge 迟到应答按代际作废（防旧 edgeId 撞上新会话同号 edge）。
    private var sessionGeneration = 0
    /// 最近一次 sidecar 进程终止退出码（锁保护；nil = 尚未观测到终止）。
    private var lastTerminationStatusStorage: Int32?

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

    /// v1 默认 edge 应答策略——真实宿主腿落地前的 POC 应答表（W-15/16 语义：
    /// Swift 必须应答、绝不挂起；sidecar 侧 sendEdge 无超时）：
    ///   - 同步事实门 trayAvailable / notificationSupported /
    ///     badgeCountApiAvailable / mainWindowAlive / webViewContentAlive →
    ///     ok:true result:true（与 node-edges hostFacts 种子同族：mac Dock
    ///     常驻、通知/徽标 API 可用、主窗与 web 内容存活）；
    ///   - showNativeNotification → ok:true result:null（= 已显示；POC 无真实
    ///     通知腿，M3 后由实际宿主实现接管）；
    ///   - showMessage → ok:true result:0（= 消息框第 0 号按钮）；
    ///   - 其余一律 {ok:false, error:"swift-edge-unimplemented:<method>"}
    ///     （pickPluginSource 等——loud 拒绝，绝不静默假装成功，也不挂起）。
    /// 宿主腿（W-19/20）：非 nil 时 defaultEdgeResponse 先问 legs；legs 报
    /// unimplemented/ui-unavailable 前缀错误则回落本表（POC 无宿主不挂起）。
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
        switch method {
        case "trayAvailable", "notificationSupported", "badgeCountApiAvailable",
             "mainWindowAlive", "webViewContentAlive":
            return (.bool(true), nil)
        case "showNativeNotification":
            return (nil, nil)
        case "showMessage":
            return (.number(0), nil)
        default:
            return (nil, "swift-edge-unimplemented:\(method)")
        }
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

    // MARK: - 生命周期

    /// 拉起 sidecar：Process 配置（executableURL=nodePath、arguments、
    /// environment=当前环境 + 构造参数合并）→ 三管道 → 读回调 → run()。
    /// 失败抛 NSError（code 5 = 已在运行；其余为 spawn 底层错误原样上抛）。
    /// 线程：调用方线程（AppDelegate 主线程）；成功后即可 invoke。
    public func start() throws {
        lock.lock()
        defer { lock.unlock() }
        guard process == nil else {
            throw Self.makeError(code: Self.errorCodeAlreadyStarted,
                                 message: "BridgeClient 已在运行（start 不可重入；先 stop 再 start）")
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = arguments
        var mergedEnvironment = ProcessInfo.processInfo.environment
        for (key, value) in environment { mergedEnvironment[key] = value }
        process.environment = mergedEnvironment

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
        // stop() 会先置 nil 再 terminate，防重入）。
        process.terminationHandler = { [weak self] _ in
            self?.handleTermination()
        }

        try process.run()

        // 状态赋值在 run() 成功且仍持锁时完成：回调可能紧随 run() 返回触发，
        // 彼时经 lock 必须看到完整状态。
        self.process = process
        self.inputPipe = input
        self.outputPipe = output
        self.errorPipe = error
        // 行缓冲复位（支持 stop 后再次 start 的干净重启）。
        self.outputReader = LineReader()
        self.stderrReader = LineReader()
        // 出站面会话状态复位：edge 应答守卫清空（新 sidecar 的 edgeId 从 1
        // 重新计数）、代际递增（旧会话迟到的 edge 应答在新会话按代际作废）、
        // 上次终止退出码清空。
        self.answeredEdgeIDs.removeAll()
        self.sessionGeneration += 1
        self.lastTerminationStatusStorage = nil
    }

    /// 停止 sidecar：SIGTERM → 等 ≤2s → SIGKILL（spec 原文语义）。同步阻塞
    /// 调用方（最坏 ≈2.1s + 收尸），仅 AppDelegate.applicationWillTerminate
    /// 退出路径使用，注释声明。幂等：重复 stop / 进程已自然退出均安全。
    public func stop() {
        // 摘状态（此后 invoke 一律 code 2；重复 stop 直接返回）。
        var takenProcess: Process?
        var takenOutput: Pipe?
        var takenError: Pipe?
        lock.lock()
        takenProcess = process
        takenOutput = outputPipe
        takenError = errorPipe
        process = nil
        inputPipe = nil
        outputPipe = nil
        errorPipe = nil
        lock.unlock()
        guard let takenProcess else { return }

        // 摘除全部回调，防重入：terminationHandler 置 nil（spec）；stdout/
        // stderr 读回调一并摘除——stop 后不再处理任何子进程输出。
        takenOutput?.fileHandleForReading.readabilityHandler = nil
        takenError?.fileHandleForReading.readabilityHandler = nil
        takenProcess.terminationHandler = nil

        // SIGTERM → 轮询 ≤2s → SIGKILL 兜底。
        if takenProcess.isRunning {
            takenProcess.terminate()
        }
        let deadline = Date().addingTimeInterval(2.0)
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
        lock.lock()
        lastTerminationStatusStorage = takenProcess.terminationStatus
        lock.unlock()

        failAllPending(reason: "BridgeClient 已停止（stop()）")
    }

    /// 自然退出收尾：sidecar 崩溃/自行 exit 时（SIGCHLD 回调线程）——置状态
    /// 为未运行、摘读回调、按 EOF 语义收尾行缓冲、未决请求全部作废（loud）。
    private func handleTermination() {
        var takenProcess: Process?
        var takenOutput: Pipe?
        var takenError: Pipe?
        lock.lock()
        takenProcess = process
        takenOutput = outputPipe
        takenError = errorPipe
        process = nil
        inputPipe = nil
        outputPipe = nil
        errorPipe = nil
        lock.unlock()

        takenOutput?.fileHandleForReading.readabilityHandler = nil
        takenError?.fileHandleForReading.readabilityHandler = nil

        let status = takenProcess?.terminationStatus ?? -1
        let reason = takenProcess?.terminationReason ?? .exit
        // 退出码分级：Supervisor（W-15）据 status 决定重启退避 / fatal 分流
        // （0 = 自行优雅退出；3 = 目录锁冲突；其余非零 = 崩溃），本类只上报。
        log("sidecar 进程退出：terminationStatus=\(status)（reason=\(reason.rawValue)）")
        lock.lock()
        lastTerminationStatusStorage = takenProcess?.terminationStatus
        lock.unlock()

        // 管道此刻已 EOF：把 stdout 残尾按 EOF 收尾（可能含最后的完整帧），
        // 未决请求作废（作废先于残帧分发会丢“死前应答”——进程已亡，
        // 语义上桥已断，注释声明此取舍：宁可 loud 丢弃也不悬挂）。
        finishStdoutReading()
        failAllPending(reason: "sidecar 进程退出，未决请求作废")

        // 收尾完成后上报（Supervisor 的回调里可能新建/启动下一个 sidecar；
        // 本实例状态已完全落定，无重入风险）。
        onTerminated?(status)
    }

    // MARK: - 管道读取（stdout = 协议流；stderr = 日志流）

    private func readStdout(_ handle: FileHandle) {
        let data = handle.availableData
        guard !data.isEmpty else {
            // 管道 EOF（read 返回 0 字节 = 写端全关 = 子进程已亡）。摘回调并
            // 按 EOF 收尾；与 handleTermination 的收尾幂等互斥（lock 串行 +
            // LineReader.finished 标志）。
            handle.readabilityHandler = nil
            finishStdoutReading()
            return
        }
        var outcome = LineReader.Outcome()
        lock.lock()
        outcome = outputReader.append(data)
        lock.unlock()
        processStdoutOutcome(outcome)
    }

    /// stdout EOF 收尾（读回调与终止回调都可能触发；幂等）。
    private func finishStdoutReading() {
        var outcome = LineReader.Outcome()
        lock.lock()
        outcome = outputReader.finish()
        lock.unlock()
        processStdoutOutcome(outcome)
    }

    private func readStderr(_ handle: FileHandle) {
        let data = handle.availableData
        guard !data.isEmpty else {
            // stderr 日志流 EOF：摘回调并收尾残余行（尽力透传，丢了也无妨）。
            handle.readabilityHandler = nil
            var outcome = LineReader.Outcome()
            lock.lock()
            outcome = stderrReader.finish()
            lock.unlock()
            processStderrOutcome(outcome)
            return
        }
        var outcome = LineReader.Outcome()
        lock.lock()
        outcome = stderrReader.append(data)
        lock.unlock()
        processStderrOutcome(outcome)
    }

    /// stdout 帧行分发：违约计数 loud；每行先过超长检查再过结构解码，都不过
    /// 即打印 + 丢弃（fail-loud，design 25 §4.4.2）。
    private func processStdoutOutcome(_ outcome: LineReader.Outcome) {
        reportLineReaderIssues(outcome, channel: "stdout")
        for line in outcome.lines {
            handleIncomingLine(line)
        }
    }

    /// stderr 行 → 标准错误透传（D2：sidecar 的 console.* 重定向到 stderr，
    /// Swift 侧原样透传、前缀 "[sidecar] "）。
    private func processStderrOutcome(_ outcome: LineReader.Outcome) {
        reportLineReaderIssues(outcome, channel: "stderr")
        for line in outcome.lines {
            relaySidecarLogLine(line)
        }
    }

    /// 违约计数 loud 上报（帧/行内容由各自的处理函数负责）。
    private func reportLineReaderIssues(_ outcome: LineReader.Outcome, channel: String) {
        if outcome.invalidUTF8Lines > 0 {
            log("\(channel)：丢弃 \(outcome.invalidUTF8Lines) 行非 UTF-8 数据")
        }
        if outcome.overflowResets > 0 {
            log("\(channel)：无换行数据超过 \(FrameCodec.maxFrameBytes) 字节缓冲上限，已清缓冲重新同步（协议违约，fail-loud）")
        }
    }

    /// 单条协议行 → 帧分发。超长/非法 → 打印错误并丢弃该帧，绝不静默继续。
    private func handleIncomingLine(_ line: String) {
        guard !FrameCodec.isLineTooLong(line) else {
            log("收到超长行（> \(FrameCodec.maxFrameBytes) 字节），丢弃该帧：\(Self.preview(line))")
            return
        }
        guard let frame = FrameCodec.decodeLine(line) else {
            // decodeLine 归 nil 的帧先试出站面分类（edge/notify 两族——它们
            // 既无 id 也无 event 键，不在 decodeLine 的 request/response/event
            // 三族内，见 decodeOutboundFrame 注释；M3 前这类帧在此被当非协议
            // 行 loud 丢弃，sidecar 的 sendEdge 因此挂起——W-15/16 修复点）。
            if let outbound = Self.decodeOutboundFrame(line) {
                dispatchOutboundFrame(outbound)
                return
            }
            // 非协议帧：D2 重定向后仍泄漏说明有 console 直写 stdout，须修——
            // fail-loud 打印（内容截断预览），不向任何调用方投递。
            log("收到非协议帧（非 JSON / 非法结构 / 缺 id / 未知键组合），丢弃：\(Self.preview(line))")
            return
        }
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
            log("收到 sidecar→Swift request 帧（协议违约，B 桥 id 所有权在 Swift 侧），丢弃：\(Self.preview(line))")
        }
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

    /// 原始行 → 出站帧分类。**在 BridgeClient 层做而不扩 FrameCodec/
    /// BridgeFrame**：edge/notify 帧既无 id 也无 event 键，decodeLine 按容忍
    /// 语义归 nil（M3 前 → 非协议行 loud 丢弃）；若给 BridgeFrame 增加 case，
    /// 需同步 FrameCodec 的 encode/decode 与其既有单测断言族（FrameCodecTests
    /// 的分类优先序/容忍断言），POC 取本层先行分类的最小侵入——注释声明：
    /// W-17 协议族稳定后若收编回 FrameCodec，本函数与 dispatchOutboundFrame
    /// 一并迁移，BridgeClient 公开出口不变。
    /// 分类确定性（防歧义帧摇摆）：edge 键优先于 notify 键（两族协议互斥）；
    /// 结构不合法（edge/notify 名非字符串、edgeId 非数值等）→ nil，调用方
    /// loud（与 decodeLine 的 nil 语义同构）。
    private static func decodeOutboundFrame(_ line: String) -> OutboundFrame? {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        if let edgeName = object["edge"] as? String {
            // edgeId 必须为 JSON 数值：Bool 的 NSNumber 桥接同样过 as? NSNumber，
            // 须 CFTypeID 判别（与 AnyCodable.fromJSONObject 同规）。域内整数
            // JSONSerialization 给整值 NSNumber，int64Value 精确（sidecar 的
            // edgeId 自 1 递增的小整数）。
            guard let edgeID = object["edgeId"] as? NSNumber,
                  CFGetTypeID(edgeID) == CFNumberGetTypeID() else {
                return nil
            }
            return .edgeRequest(method: edgeName,
                                payload: Self.outboundPayload(in: object),
                                edgeId: edgeID.int64Value)
        }
        if let event = object["notify"] as? String {
            return .notify(event: event, payload: Self.outboundPayload(in: object))
        }
        return nil
    }

    /// 出站帧 payload 键取值：键缺省 → nil；显式 null → .null；其它 JSON 值 →
    /// AnyCodable（非 JSON 可表示值不产生——fromJSONObject 诚实失败）。
    private static func outboundPayload(in object: [String: Any]) -> AnyCodable? {
        guard object.keys.contains("payload") else { return nil }
        return AnyCodable.fromJSONObject(object["payload"] as Any)
    }

    /// 出站帧分发（管道读取线程；回调线程契约同 onEvent）。
    private func dispatchOutboundFrame(_ frame: OutboundFrame) {
        switch frame {
        case .edgeRequest(let method, let payload, let edgeId):
            handleEdgeRequest(method: method, payload: payload, edgeId: edgeId)
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
    private func handleEdgeRequest(method: String, payload: AnyCodable?, edgeId: Int64) {
        var generation = 0
        lock.lock()
        generation = sessionGeneration
        lock.unlock()
        let reply: (_ result: AnyCodable?, _ error: String?) -> Void = { [weak self] result, error in
            self?.sendEdgeReply(edgeId: edgeId, generation: generation,
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
            answeredEdgeIDs.insert(edgeId)
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
            log("edgeId=\(edgeId) 应答写失败：\(error.localizedDescription)")
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
                pending[id] = continuation
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
        continuation = pending.removeValue(forKey: id)
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
    private func failAllPending(reason: String) {
        var drained: [CheckedContinuation<AnyCodable, Error>] = []
        lock.lock()
        drained = Array(pending.values)
        pending.removeAll()
        lock.unlock()
        guard !drained.isEmpty else { return }
        log("\(reason)（\(drained.count) 个未决请求作废）")
        let error = Self.makeError(code: Self.errorCodePendingDropped, message: reason)
        for continuation in drained {
            continuation.resume(throwing: error)
        }
    }

    // MARK: - 日志

    /// 本客户端的诊断日志 → 标准错误（自己的 stderr，与 sidecar 日志流
    /// 区分前缀：本类 "[bridge] " / 透传 "[sidecar] "）。
    private func log(_ message: String) {
        let line = "[bridge] \(message)\n"
        try? FileHandle.standardError.write(contentsOf: Data(line.utf8))
    }

    /// sidecar stderr 行透传（D2：stderr = 唯一日志通道，原样输出）。
    private func relaySidecarLogLine(_ line: String) {
        let text = "[sidecar] \(line)\n"
        try? FileHandle.standardError.write(contentsOf: Data(text.utf8))
    }

    /// 行预览（日志用；截断防刷屏，不做内容转义——日志通道本机可见）。
    private static func preview(_ line: String, maxLength: Int = 160) -> String {
        let truncated = line.prefix(maxLength)
        return line.count > maxLength ? "\(truncated)…" : line
    }

    /// NSError 工厂（domain/文案统一）。
    private static func makeError(code: Int, message: String) -> NSError {
        NSError(domain: Self.errorDomain, code: code,
                userInfo: [NSLocalizedDescriptionKey: message])
    }
}
