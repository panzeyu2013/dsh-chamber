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
//   - **无握手帧**：start() 后不发 {"event":"hello"} 之类任何帧——协议没有
//     握手语义（poc-sidecar.ts 只处理 request；真实 sidecar 的 ready 帧
//     {port,shellVersion} 属 M2 且由 sidecar 主动输出，不是客户端握手；
//     design 25 §3.3 启动序列由上层编排）。
//   - POC 期 sidecar 只应答请求、推送事件，从不主动发请求（edge:* 反向
//     通道属 M2）；万一收到请求帧，本客户端 loud 丢弃（无法配对的响应
//     只会制造悬挂，见 handleIncomingLine 注释）。
//
// id 纪律与并发模型：
//   - id 自 1 起单调递增（NSLock 保护）；sidecar 原样 echo，pending 字典
//     以 id 为键把响应配对回发起时的 continuation——**id 的所有权 = pending
//     字典条目**：谁在锁内 removeValue 成功，谁负责 resume（恰好一次）。
//   - 写帧 = 调用线程持锁直写（串行、天然有序、单帧原子 ≤4 MiB）。POC 帧
//     率低且 sidecar 的 readline 持续消费，背压罕见；代价是极端背压可能
//     阻塞调用线程——P1 换专用串行写队列 + stop 前显式排空（design 25
//     §3.3 退出链 5s 硬顶前需可证明无 in-flight 写）。POC 注释声明。
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

    /// 构造（AppDelegate 按此签名调用，勿改名）。
    /// - Parameters:
    ///   - nodePath: Node 可执行文件路径（POC：系统 node 或 Electron 二进制
    ///     + ELECTRON_RUN_AS_NODE=1，见 AppDelegate）。
    ///   - arguments: sidecar 脚本路径与参数（POC：poc-sidecar.ts 路径）。
    ///   - environment: 附加环境变量（合并进当前进程环境，同名覆盖）。
    public init(nodePath: String, arguments: [String], environment: [String: String]) {
        self.nodePath = nodePath
        self.arguments = arguments
        self.environment = environment
    }

    // MARK: - 状态（除 onEvent 外全部经 lock 保护）

    private let lock = NSLock()
    private var process: Process?
    private var inputPipe: Pipe?        // 子进程 stdin 写端
    private var outputPipe: Pipe?       // 子进程 stdout 读端（协议流）
    private var errorPipe: Pipe?        // 子进程 stderr 读端（日志流）
    private var outputReader = LineReader()
    private var stderrReader = LineReader()
    private var nextID = 1
    private var pending: [Int: CheckedContinuation<AnyCodable, Error>] = [:]
    private var sigpipeIgnored = false

    /// sidecar 事件出口（事件帧到达时在管道读取线程回调；调用方负责切回
    /// 主线程再碰 UI/WKWebView——本属性在 start() 之前赋值、之后只读，
    /// 赋值方（controller）与读取线程不并发写）。
    public var onEvent: ((String, AnyCodable?) -> Void)?

    /// 进程是否存活（含 start 前/stop 后 → false）。测试与未来 Supervisor 用。
    public var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return process?.isRunning ?? false
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
            // 忽略：isRunning/waitUntilExit 已兜底状态。
            _ = kill(takenProcess.processIdentifier, SIGKILL)
        }
        takenProcess.waitUntilExit()   // 收尸（防僵尸）；对已退出进程立即返回

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
        // 退出码分级文案 POC 版：只记日志；启动失败 vs 崩溃的 NSAlert 分流属
        // SidecarSupervisor（M2，design 25 §3.3(4)）。
        log("sidecar 进程退出：terminationStatus=\(status)（reason=\(reason.rawValue)）")

        // 管道此刻已 EOF：把 stdout 残尾按 EOF 收尾（可能含最后的完整帧），
        // 未决请求作废（作废先于残帧分发会丢“死前应答”——进程已亡，
        // 语义上桥已断，注释声明此取舍：宁可 loud 丢弃也不悬挂）。
        finishStdoutReading()
        failAllPending(reason: "sidecar 进程退出，未决请求作废")
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
            // 非协议帧：D2 重定向后仍泄漏说明有 console 直写 stdout，须修——
            // fail-loud 打印（内容截断预览），不向任何调用方投递。
            log("收到非协议帧（非 JSON / 非法结构 / 缺 id），丢弃：\(Self.preview(line))")
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
            // POC 期 sidecar 从不发起请求（edge:* 反向通道属 M2 / P1
            // sidecar-entry）；无法配对的响应只会制造悬挂，loud 丢弃并声明
            // 不支持——P1 在此补“FrameCodec.encode(.response) 回写”路径。
            log("收到 sidecar→Swift 请求帧（POC 不支持 edge:* 反向通道），丢弃：\(Self.preview(line))")
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
