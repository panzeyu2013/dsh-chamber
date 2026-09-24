//
//  BridgeClientLineReadTests.swift
//  DSHChamberTests
//
//  BridgeClient 的 stdout 读路径测试覆盖：
//    - LineReader：部分帧跨 append 重组（含跨块的多字节 UTF-8 序列）、一次
//      append 多帧、\r\n 兼容与跨块 CRLF、EOF 无换行残尾恰一次、原始字节输出
//      （UTF-8 判定在消费侧：stdout 交 JSONSerialization，stderr 计数丢弃）、
//      无换行超限清缓冲重同步 + 残尾吞除与恢复；
//    - handleIncomingLine（internal 测试接缝，见 BridgeClient.swift）：超长帧
//      作废全部未决请求（code 4，绝不永久悬挂）、非法 JSON / 非协议帧 / 未知
//      id 响应 / sidecar→Swift request 违约帧一律丢弃且不偷走未决请求、随后
//      的真实响应仍能正确配对。
//
//  进程用 /bin/sh -c 'exec sleep 30'（真实子进程但绝不回应协议帧，也不在
//  stop 时对抗 SIGTERM）；所有等待都有显式上限。
import XCTest
@testable import DSHChamber

final class BridgeClientLineReadTests: XCTestCase {

    /// 有界轮询（不假设回调时序）：条件成立或超时返回。
    @discardableResult
    private func waitUntil(timeout: TimeInterval = 2, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.01)
        }
        return condition()
    }

    /// 真实（但不应答）的子进程：exec 让 sh 被 sleep 替换，stop() 的 SIGTERM
    /// 直达 sleep，不会因 shell 等前台子进程而撑满 5s 宽限。
    private func makeSilentBridge(writerStallTimeout: TimeInterval = 20) throws -> BridgeClient {
        let bridge = BridgeClient(nodePath: "/bin/sh",
                                  arguments: ["-c", "exec sleep 30"],
                                  environment: [:],
                                  writerStallTimeout: writerStallTimeout)
        try bridge.start()
        XCTAssertTrue(bridge.isRunning)
        return bridge
    }

    /// stdin 无消费者且首帧远大于管道缓冲时，写器线程会被内核背压占住。
    /// 页面 invoke 的期限和 stdout edge 回调仍必须独立推进；独立写期限
    /// 负责终止卡住的 sidecar，排队帧不得进入后续会话。
    func testBackpressuredStdinDoesNotBlockDeadlineOrEdgeDispatch() async throws {
        let bridge = try makeSilentBridge(writerStallTimeout: 1)
        defer { bridge.stop() }
        let largePayload = AnyCodable.string(String(repeating: "x", count: 2 * 1024 * 1024))
        let started = Date()
        let request = Task {
            try await bridge.invoke(method: "blocked-write", payload: largePayload,
                                    timeout: 0.3)
        }
        XCTAssertTrue(waitUntil { bridge.pendingRequestCount == 1 })
        try await Task.sleep(nanoseconds: 50_000_000)

        let edgeStarted = Date()
        bridge.handleIncomingLine(#"{"edge":"unknown","edgeId":42,"payload":null}"#)
        XCTAssertLessThan(Date().timeIntervalSince(edgeStarted), 1.0,
                          "edge 回调不可等待已满的 stdin 管道")

        do {
            _ = try await request.value
            XCTFail("stdin 背压期间 invoke 必须按登记时的期限失败")
        } catch {
            let failure = error as NSError
            XCTAssertEqual(failure.domain, BridgeClient.errorDomain)
            XCTAssertEqual(failure.code, BridgeClient.errorCodeTimedOut)
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 2.0,
                          "期限必须覆盖 FileHandle.write 的阻塞时间")
        XCTAssertEqual(bridge.pendingRequestCount, 0)
        XCTAssertTrue(waitUntil(timeout: 3) { !bridge.isRunning },
                      "存活但不读 stdin 的 sidecar 必须在写期限后被终止并交给 Supervisor 重建")
    }

    func testBrokenStdinTerminatesProtocolSession() async throws {
        // 子进程存活却主动关 stdin；Swift 写入必须失败并结束整个会话。
        // 否则 write 在半帧失败后继续写后续帧会破坏 NDJSON 边界。
        let bridge = BridgeClient(nodePath: "/bin/sh",
                                  arguments: ["-c", "exec 0<&-; exec sleep 30"],
                                  environment: [:])
        try bridge.start()
        defer { bridge.stop() }
        try await Task.sleep(nanoseconds: 100_000_000)
        do {
            _ = try await bridge.invoke(method: "broken-stdin", timeout: 2)
            XCTFail("关闭 stdin 的 sidecar 不得得到成功应答")
        } catch {
            let failure = error as NSError
            XCTAssertEqual(failure.domain, BridgeClient.errorDomain)
            XCTAssertEqual(failure.code, BridgeClient.errorCodeWriteFailed)
        }
        XCTAssertTrue(waitUntil(timeout: 3) { !bridge.isRunning },
                      "写错误后必须终止旧 sidecar，交给 Supervisor 重启")
    }

    /// 行字节 → 文本（断言便捷；LineReader 输出原始字节）。
    private func texts(_ outcome: LineReader.Outcome) -> [String] {
        outcome.lines.map { String(decoding: $0, as: UTF8.self) }
    }

    // MARK: - LineReader

    func testPartialFramesAcrossAppendsAreReassembled() {
        var reader = LineReader()
        let payload = "{\"k\":\"你\"}\n"
        let bytes = Array(payload.utf8)
        // 切点落在「你」的首字节之后：跨 append 的多字节序列必须原样重组
        // （LineReader 先攒字节、整行到手才切出；不做 UTF-8 解码）。
        let first = reader.append(Data(bytes[0..<7]))
        XCTAssertEqual(texts(first), [], "半个帧不得产出任何行")

        let second = reader.append(Data(bytes[7...]))
        XCTAssertEqual(texts(second), ["{\"k\":\"你\"}"], "残块 + 余量应拼出完整一行，多字节序列不得被腰斩")
    }

    func testMultipleFramesPerAppendAndCRLF() {
        var reader = LineReader()
        let outcome = reader.append(Data("one\ntwo\r\nthree\n".utf8))
        XCTAssertEqual(texts(outcome), ["one", "two", "three"],
                       "一次 append 必须切出全部完整帧；\r\n 的行尾 \r 应剥掉")
        XCTAssertEqual(outcome.overflowResets, 0)
    }

    func testFinishEmitsUnterminatedTailExactlyOnce() {
        var reader = LineReader()
        XCTAssertEqual(texts(reader.append(Data("no-newline".utf8))), [])
        let first = reader.finish()
        XCTAssertEqual(texts(first), ["no-newline"],
                       "EOF 收尾把无换行残尾按违约行上抛（调用方 loud）")
        XCTAssertEqual(texts(reader.finish()), [], "finish 幂等：第二次不得重复产出")
        XCTAssertEqual(texts(reader.append(Data("late\n".utf8))), [],
                       "EOF 后的 append 必须拒收（防御）")
    }

    func testInvalidUTF8LineIsEmittedAsBytesAndDroppedByConsumer() async throws {
        var reader = LineReader()
        // LineReader 不做 UTF-8 判定，原样交字节；stdout 侧的合法性由
        // JSONSerialization 承担，stderr 侧由 processStderrOutcome 计数丢弃。
        let outcome = reader.append(Data([0x41, 0xFF, 0x0A]))
        XCTAssertEqual(outcome.lines.map { Array($0) }, [[0x41, 0xFF]])
        let next = reader.append(Data("ok\n".utf8))
        XCTAssertEqual(texts(next), ["ok"], "非法行之后缓冲必须仍可继续切行")

        // 消费侧：非法 UTF-8 行只 loud 丢弃，不动未决请求、不阻后续配对。
        let bridge = try makeSilentBridge()
        defer { bridge.stop() }
        let request = Task { try await bridge.invoke(method: "probe") }
        XCTAssertTrue(waitUntil { bridge.pendingRequestCount == 1 })
        BridgeClient.resetInboundParseCount()
        bridge.handleIncomingLine(Data([0x41, 0xFF]))   // 生产形态：行尾 \n 已由 LineReader 剥除
        XCTAssertEqual(bridge.pendingRequestCount, 1, "非法 UTF-8 行不得作废或偷走未决请求")
        XCTAssertEqual(BridgeClient.inboundParseCountSnapshot(), 1,
                       "非法 UTF-8 行仍计一次解析尝试（判定交给 JSONSerialization）")
        bridge.handleIncomingLine(#"{"id":1,"ok":true,"result":"ok"}"#)
        _ = try await request.value
        XCTAssertEqual(bridge.pendingRequestCount, 0)
    }

    func testUnterminatedOverflowResetsBufferAndRecovers() {
        var reader = LineReader(maxBufferedBytes: 8)
        // 无换行且超上限 → 清缓冲重同步并计数（协议违约流不得无界吃内存）。
        let overflow = reader.append(Data(repeating: 0x61, count: 20))
        XCTAssertEqual(texts(overflow), [])
        XCTAssertEqual(overflow.overflowResets, 1)
        // 重同步后必须继续吞到下一个换行：被丢弃超长行的残尾不得作为
        // 独立行上抛（否则残片可能被当成合法帧派发）。
        let tailOfOverlong = reader.append(Data("tail-of-overlong\n".utf8))
        XCTAssertEqual(texts(tailOfOverlong), [], "被丢弃行的残尾必须吞掉，不得上抛")
        XCTAssertEqual(tailOfOverlong.overflowResets, 0)
        XCTAssertEqual(texts(reader.append(Data("ok\n".utf8))), ["ok"],
                       "越过该换行后必须恢复切行")

        // 游标化后溢出判定仍对「未消费窗口」成立——已切出的行不参与，
        // 残尾超限只计一次；finish() 只输出游标之后的残尾。
        var cursorReader = LineReader(maxBufferedBytes: 8)
        let cursorFirst = cursorReader.append(Data("a\nb\n".utf8))
        XCTAssertEqual(texts(cursorFirst), ["a", "b"])
        let cursorSecond = cursorReader.append(Data(repeating: 0x61, count: 20))
        XCTAssertEqual(texts(cursorSecond), [])
        XCTAssertEqual(cursorSecond.overflowResets, 1, "已消费的行不参与溢出判定")
        XCTAssertEqual(texts(cursorReader.append(Data("tail\n".utf8))), [], "残尾吞掉")
        XCTAssertEqual(texts(cursorReader.append(Data("ok\n".utf8))), ["ok"], "越过换行后重新同步")

        var tailReader = LineReader()
        XCTAssertEqual(texts(tailReader.append(Data("x\ny".utf8))), ["x"])
        XCTAssertEqual(texts(tailReader.finish()), ["y"], "finish 只输出游标之后的未消费残尾")
        XCTAssertEqual(texts(tailReader.finish()), [], "finish 幂等")

        // 超限但**带换行**的同一 append：行先被切出，不算无换行溢出
        // （溢出只针对永远切不出行的残尾）。
        var lineReader = LineReader(maxBufferedBytes: 8)
        let longLine = String(repeating: "a", count: 20) + "\n"
        let longOutcome = lineReader.append(Data(longLine.utf8))
        XCTAssertEqual(texts(longOutcome), [String(repeating: "a", count: 20)])
        XCTAssertEqual(longOutcome.overflowResets, 0,
                       "有换行的超长行由 handleIncomingLine 的超长护栏处理，不在 LineReader 层丢")

        // 未消费窗口恰好等于上限：不溢出；多一字节才溢出
        var boundaryReader = LineReader(maxBufferedBytes: 8)
        XCTAssertEqual(boundaryReader.append(Data(repeating: 0x61, count: 8)).overflowResets, 0)
        XCTAssertEqual(boundaryReader.append(Data(repeating: 0x62, count: 1)).overflowResets, 1)
    }

    /// 进程退出时仍在管道缓冲里的最后一帧必须被抽干送达
    /// （stdout 收尾抽干，与 stderr 对称；没有它这里会随机丢最后一帧）。
    func testFinalFrameAtExitIsDrainedAndDelivered() throws {
        let script = "printf '{\"notify\":\"ready\",\"payload\":{\"port\":17520,\"shellVersion\":\"1.0\"}}\\n'; exit 0"
        let bridge = BridgeClient(nodePath: "/bin/sh", arguments: ["-c", script], environment: [:])
        var ready: (Int, String)?
        bridge.onReady = { port, version in ready = (port, version) }
        try bridge.start()
        defer { bridge.stop() }
        XCTAssertTrue(waitUntil(timeout: 5) { ready != nil },
                      "退出前写入的 ready 帧必须被送达（管道残帧抽干）")
        XCTAssertEqual(ready?.0, 17520)
        XCTAssertEqual(ready?.1, "1.0")
    }

    /// 真实管道按 16KiB 分块时，>缓冲上限的单行会先触发
    /// 溢出重同步——把残尾当独立行上抛会可被 forged 成合法帧，且超长护栏
    /// 永不命中 → 对应 invoke 悬挂到 stop()。溢出即作废全部未决请求，残尾吞掉。
    func testOverflowFailsPendingAndSwallowsForgedSuffix() async throws {
        let bridge = try makeSilentBridge()
        defer { bridge.stop() }
        let request = Task { try await bridge.invoke(method: "probe") }
        XCTAssertTrue(waitUntil { bridge.pendingRequestCount == 1 })
        bridge.processStdoutOutcome(LineReader.Outcome(lines: [], overflowResets: 1),
                                    generation: bridge.readerGenerationSnapshot())
        XCTAssertEqual(bridge.pendingRequestCount, 0, "溢出重同步必须 fail-closed 作废未决请求")
        do {
            _ = try await request.value
            XCTFail("溢出重同步后未决请求必须被作废（不得超过 stop() 悬挂）")
        } catch {
            // 期望：code 4 桥错误（failAllPending）
        }

        // LineReader 侧：小上限 + 分批 append（真实分块形态）——残片绝不上抛
        var reader = LineReader(maxBufferedBytes: 8)
        XCTAssertEqual(reader.append(Data(repeating: 0x41, count: 12)).overflowResets, 1)
        let forged = reader.append(Data(#"{"id":1,"ok":true,"result":"forged"}"#.utf8 + Data([0x0A])))
        XCTAssertEqual(forged.lines.count, 0, "被丢弃超长行的残尾不得进入解析")
        XCTAssertEqual(forged.overflowResets, 0)
        XCTAssertEqual(reader.append(Data("real\n".utf8)).lines.count, 1, "越过换行后恢复")
    }

    /// 索引契约：lines 是内部缓冲的共享切片，startIndex 通常非 0、
    /// 空行是空切片——消费方必须按 startIndex 访问并立即消费。
    func testOutcomeLineSlicesKeepNonZeroStartIndex() {
        var reader = LineReader()
        let outcome = reader.append(Data("abc\ndef\r\n\nlast\n".utf8))
        XCTAssertEqual(texts(outcome), ["abc", "def", "", "last"])
        XCTAssertEqual(Array(outcome.lines[1]), Array("def".utf8), "CRLF 行剥 \\r 后内容不变")
        XCTAssertGreaterThan(outcome.lines[1].startIndex, 0, "切片保留父缓冲的绝对索引")
        XCTAssertEqual(outcome.lines[2].count, 0, "空行 = 空切片")
        XCTAssertEqual(Array(outcome.lines[3]), Array("last".utf8))
    }

    /// CRLF 跨 append 边界（CR 为 chunk 末字节、LF 为下一 chunk 首字节）——
    /// 行尾 \r 必须剥掉且不得把 CR/LF 拆成两行。
    func testCRLFSplitAcrossAppendBoundary() {
        var reader = LineReader()
        XCTAssertEqual(texts(reader.append(Data("one\r".utf8))), [], "CR 单独到达时不得成行")
        XCTAssertEqual(texts(reader.append(Data("\ntwo".utf8))), ["one"], "LF 到达才成行，\\r 已剥")
        XCTAssertEqual(texts(reader.finish()), ["two"])
    }

    // MARK: - 会话生命周期与收尾接缝

    /// start→stop→start 的整轮重启——句柄身份守卫、reader/EOF
    /// 复位、会话状态发布先于 run() 全都在这一路径上；第二个会话的帧必须送达，
    /// 旧会话的帧不得重放。
    func testRestartAfterStopDeliversNewSessionFramesOnly() throws {
        let scriptPath = NSTemporaryDirectory() + "dsh-restart-\(UUID().uuidString).sh"
        let counterPath = NSTemporaryDirectory() + "dsh-restart-count-\(UUID().uuidString)"
        let script = """
        n=$(cat \(counterPath) 2>/dev/null || echo 0)
        n=$((n+1))
        echo $n > \(counterPath)
        printf '{"notify":"ready","payload":{"port":%s,"shellVersion":"s%s"}}\\n' "$n" "$n"
        exec sleep 30
        """
        try script.write(toFile: scriptPath, atomically: true, encoding: .utf8)
        defer {
            try? FileManager.default.removeItem(atPath: scriptPath)
            try? FileManager.default.removeItem(atPath: counterPath)
        }
        let bridge = BridgeClient(nodePath: "/bin/sh", arguments: [scriptPath], environment: [:])
        var ready: [(Int, String)] = []
        bridge.onReady = { port, version in ready.append((port, version)) }

        try bridge.start()
        XCTAssertTrue(waitUntil(timeout: 5) { ready.count == 1 }, "首会话 ready 必须送达")
        XCTAssertEqual(ready.first?.0, 1)
        bridge.stop()
        XCTAssertFalse(bridge.isRunning)

        try bridge.start()   // 干净重启（类契约）
        XCTAssertTrue(waitUntil(timeout: 5) { ready.count == 2 },
                      "重启后的新会话帧必须送达（旧收尾不得把新 reader 置 finished）")
        XCTAssertEqual(ready.last?.0, 2, "第二个会话必须是新进程的 ready（不得重放旧帧）")
        XCTAssertEqual(ready.last?.1, "s2")
        bridge.stop()
    }

    /// finishStdoutReading 直测——抽干逐帧送达、幂等、
    /// 错代际不改状态（旧收尾不得作用于新会话）。
    func testFinishStdoutReadingDrainsFramesAndGuardsGeneration() throws {
        let bridge = try makeSilentBridge()
        defer { bridge.stop() }
        var events: [String] = []
        bridge.onEvent = { event, _ in events.append(event) }
        let generation = bridge.readerGenerationSnapshot()

        // 先把错代际（旧收尾）放在前面：守卫失效时它会消费管道并 finish 本会话 reader，
        // 后续正确代际就无帧可派发 —— 这样断言才具区分力。
        let stalePipe = Pipe()
        stalePipe.fileHandleForWriting.write(Data(#"{"event":"stale"}"#.utf8) + Data([0x0A]))
        bridge.finishStdoutReading(stalePipe, generation: generation + 1)
        XCTAssertEqual(events, [], "错代际收尾不得派发任何帧")
        XCTAssertGreaterThan(bridge.bytesAvailableForTesting(stalePipe.fileHandleForReading), 0,
                             "错代际收尾不得消费管道字节（用非阻塞探针：守卫失效时不挂测试）")

        // 正确代际：逐帧送达 + 幂等 + 再调错代际不重复派发
        let pipe = Pipe()
        pipe.fileHandleForWriting.write(Data(#"{"event":"a"}"#.utf8) + Data([0x0A])
            + Data(#"{"event":"b"}"#.utf8) + Data([0x0A]) + Data("tail-no-newline".utf8))
        BridgeClient.resetInboundParseCount()
        bridge.finishStdoutReading(pipe, generation: generation)
        XCTAssertEqual(events, ["a", "b"], "抽干必须把管道残帧逐帧同步送达")
        XCTAssertEqual(BridgeClient.inboundParseCountSnapshot(), 3,
                       "两帧 + 无换行残尾各计一次解析尝试")
        bridge.finishStdoutReading(pipe, generation: generation)     // 幂等
        bridge.finishStdoutReading(pipe, generation: generation + 1)
        XCTAssertEqual(events, ["a", "b"], "幂等/错代际收尾不得改动任何状态")
    }

    /// 代际与读状态原子发布；错代际的收尾不得清掉
    /// 当前会话句柄（否则新会话 stdout 永久失聪）。
    func testReaderStateInvalidationIsGenerationGuarded() throws {
        let bridge = try makeSilentBridge()
        defer { bridge.stop() }
        var state = bridge.readerStateSnapshotForTesting()
        XCTAssertTrue(state.hasStdoutHandle && state.hasStderrHandle,
                      "会话发布后必须同时持有 stdout/stderr 读端句柄")
        bridge.invalidateReaderStateForTesting(generation: state.generation + 1)   // 旧收尾迟到
        state = bridge.readerStateSnapshotForTesting()
        XCTAssertTrue(state.hasStdoutHandle && state.hasStderrHandle,
                      "错代际作废必须无副作用（否则新会话永久失聪）")
        bridge.invalidateReaderStateForTesting(generation: state.generation)       // 本会话收尾
        let after = bridge.readerStateSnapshotForTesting()
        XCTAssertFalse(after.hasStdoutHandle || after.hasStderrHandle, "本会话收尾必须作废句柄")
    }

    /// TOCTOU 回归：终局作废的代际判定与排空必须同一次加锁——
    /// 旧代际的收尾绝不能误杀新会话刚登记的 invoke。
    func testGenerationGatedFailAllPendingDoesNotKillNewSession() async throws {
        let bridge = try makeSilentBridge()
        defer { bridge.stop() }
        let generation = bridge.readerGenerationSnapshot()
        let request = Task { try await bridge.invoke(method: "probe") }
        XCTAssertTrue(waitUntil { bridge.pendingRequestCount == 1 })

        XCTAssertFalse(bridge.failAllPendingForTesting(reason: "旧会话收尾", generation: generation + 1),
                       "代际已推进 → 终局上报必须被拒（返回 false）")
        XCTAssertEqual(bridge.pendingRequestCount, 1,
                       "旧代际的终局作废必须无副作用（不得误杀新会话 invoke）")

        XCTAssertTrue(bridge.failAllPendingForTesting(reason: "本会话收尾", generation: generation),
                      "本代际 → 终局动作生效")

        XCTAssertEqual(bridge.pendingRequestCount, 0, "本代际作废必须生效")
        do {
            _ = try await request.value
            XCTFail("作废后的 invoke 必须抛错（code 4）")
        } catch {
            // 期望：pending_dropped
        }
    }

    /// 终局结算按代际分桶——旧会话代际的排空只结算该代际
    /// 登记的请求（旧会话不悬挂），新会话的 pending 必须原样存活。
    func testSettlementIsBucketedByRegistrationGeneration() async throws {
        let bridge = try makeSilentBridge()
        defer { bridge.stop() }
        let generation = bridge.readerGenerationSnapshot()
        let oldRequest = Task { try await bridge.invoke(method: "probe") }
        XCTAssertTrue(waitUntil { bridge.pendingRequestCount == 1 })

        // 构造「旧代际 + 新代际并存」：只推进代际（不结算），再登记一个新请求。
        bridge.advanceSessionGenerationForTesting()
        let newRequest = Task { try await bridge.invoke(method: "probe") }
        XCTAssertTrue(waitUntil { bridge.pendingRequestCount == 2 })

        // 旧代际结算：只清旧桶（返回值 false = 已非当前会话），新会话请求必须存活。
        // 全局代际门版本（修复前）会整字典跳过或整字典清空，两种都在此失败。
        XCTAssertFalse(bridge.failAllPendingForTesting(reason: "旧会话收尾", generation: generation))
        guard bridge.pendingRequestCount == 1 else {
            // 守卫失效时两个桶都会被留着——此处直接返回，绝不让 await 悬挂测试
            XCTFail("旧代际结算只应清旧桶，新会话请求必须存活（实际 \(bridge.pendingRequestCount)）")
            return
        }
        var oldSettled = false
        do { _ = try await oldRequest.value } catch { oldSettled = true }
        XCTAssertTrue(oldSettled, "旧代际的未决请求必须被结算（绝不悬挂）")

        XCTAssertTrue(bridge.failAllPendingForTesting(
            reason: "新会话收尾", generation: bridge.readerGenerationSnapshot()))
        XCTAssertEqual(bridge.pendingRequestCount, 0)
        do {
            _ = try await newRequest.value
            XCTFail("新代际结算必须 settle 该请求")
        } catch {}
    }

    /// 切行在锁内、派发在锁外——派发点必须复验会话代际，
    /// 旧会话的帧绝不进入新会话。
    func testStaleGenerationDispatchIsDropped() throws {
        let bridge = try makeSilentBridge()
        defer { bridge.stop() }
        var events: [String] = []
        bridge.onEvent = { event, _ in events.append(event) }
        let generation = bridge.readerGenerationSnapshot()
        let outcome = LineReader.Outcome(lines: [Data(#"{"event":"e"}"#.utf8)], overflowResets: 0)
        bridge.processStdoutOutcome(outcome, generation: generation)
        XCTAssertEqual(events, ["e"], "当前代际必须正常派发")
        bridge.processStdoutOutcome(outcome, generation: generation + 1)
        XCTAssertEqual(events, ["e"], "非当前代际的帧必须丢弃（不得进入新会话）")
    }

    /// 抽干批次上限（生产中 1024 批 ≫ 管道容量，不可自然触发）：命中即停止抽干，
    /// 绝不吞掉未读字节、也绝不阻塞。用接缝把上限设为 0 确定性覆盖该分支。
    func testDrainBatchCapStopsWithoutConsuming() throws {
        let bridge = try makeSilentBridge()
        defer { bridge.stop() }
        bridge.setDrainBatchLimitForTesting(0)
        let pipe = Pipe()
        let bytes = Data(#"{"event":"a"}"#.utf8) + Data([0x0A])
        pipe.fileHandleForWriting.write(bytes)
        bridge.finishStdoutReading(pipe, generation: bridge.readerGenerationSnapshot())
        XCTAssertEqual(pipe.fileHandleForReading.availableData.count, bytes.count,
                       "上限命中必须停止抽干，未读字节留在管道（绝不静默吞掉）")
    }

    /// 生命周期过渡互斥（lifecycleLock 而非标志+轮询）：过渡进行中 start()
    /// 在锁上有界等待、超时抛 code 6；过渡结束后同一实例可正常启动（锁无泄漏）。
    /// 真实路径的锁获取由 stop()/handleTermination 的 `defer` 保证，另有重启用例覆盖。
    func testStartDuringLifecycleTransitionTimesOutWithCode6() throws {
        let bridge = BridgeClient(nodePath: "/bin/sh", arguments: ["-c", "exec sleep 30"],
                                  environment: [:])
        let hold = bridge.holdLifecycleLockForTesting(seconds: 5)
        XCTAssertEqual(hold.acquired.wait(timeout: .now() + 2), .success, "接缝必须已持锁")
        let began = Date()
        XCTAssertThrowsError(try bridge.start()) { error in
            XCTAssertEqual((error as NSError).code, BridgeClient.errorCodeLifecycleBusy)
        }
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(began),
                                    BridgeClient.terminalTransitionTimeout)
        XCTAssertFalse(bridge.isRunning, "过渡未完成时不得启动会话")

        XCTAssertEqual(hold.released.wait(timeout: .now() + 10), .success, "接缝必须释放锁")
        try bridge.start()                      // 过渡结束后可正常启动
        XCTAssertTrue(bridge.isRunning)
        bridge.stop()
    }

    /// 线程安全计数（并发进入检测）。
    private final class LockedCounter {
        private let lock = NSLock()
        private var current = 0
        private var maxSeen = 0
        func enter() {
            lock.lock()
            current += 1
            maxSeen = max(maxSeen, current)
            lock.unlock()
        }
        func leave() {
            lock.lock()
            current -= 1
            lock.unlock()
        }
        var maxActive: Int {
            lock.lock()
            defer { lock.unlock() }
            return maxSeen
        }
    }

    /// 生产派发路径必须串行——多线程并发投递时回调绝不并发进入
    /// （去掉 dispatchLock 时该用例会观察到 maxActive > 1）。
    func testConcurrentDispatchIsSerialized() throws {
        let bridge = try makeSilentBridge()
        defer { bridge.stop() }
        let active = LockedCounter()
        let maxActive = LockedCounter()
        bridge.onEvent = { _, _ in
            active.enter()
            maxActive.enter()
            Thread.sleep(forTimeInterval: 0.02)
            active.leave()
            maxActive.leave()
        }
        let generation = bridge.readerGenerationSnapshot()
        let lines = (0..<4).map { Data("{\"event\":\"e\($0)\"}".utf8) }
        let group = DispatchGroup()
        for _ in 0..<6 {
            group.enter()
            DispatchQueue.global().async {
                bridge.dispatchStdoutForTesting(lines, generation: generation)
                group.leave()
            }
        }
        XCTAssertEqual(group.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(maxActive.maxActive, 1, "派发必须串行（回调绝不并发进入）")
    }

    /// 旧代际的 edge 应答不得写进新会话 stdin（应答代际取自帧过门处）。
    func testStaleEdgeReplyIsNotWrittenToNewSession() throws {
        let outPath = NSTemporaryDirectory() + "dsh-edge-\(UUID().uuidString).txt"
        defer { try? FileManager.default.removeItem(atPath: outPath) }
        // 子进程把 stdin 原样抄进文件：任何写进 stdin 的协议帧都会出现在文件里。
        let bridge = BridgeClient(nodePath: "/bin/sh", arguments: ["-c", "/bin/cat > \(outPath)"],
                                  environment: [:])
        var reply: ((AnyCodable?, String?) -> Void)?
        bridge.onEdgeRequest = { _, _, captured in reply = captured }
        try bridge.start()
        defer { bridge.stop() }

        let generation = bridge.readerGenerationSnapshot()
        bridge.handleIncomingLine(Data(#"{"edge":"e","edgeId":42,"payload":null}"#.utf8),
                                  generation: generation)
        XCTAssertNotNil(reply, "edge 帧必须触发 onEdgeRequest")
        bridge.advanceSessionGenerationForTesting()   // 模拟 stop + 新会话
        reply?(.null, nil)
        Thread.sleep(forTimeInterval: 0.25)
        let staleWritten = (try? String(contentsOfFile: outPath, encoding: .utf8)) ?? ""
        XCTAssertFalse(staleWritten.contains("42"), "旧代际应答不得写进新会话：\(staleWritten)")

        // 阳性对照：当前代际的应答必须写入（证明探针能检出写入）。
        bridge.handleIncomingLine(Data(#"{"edge":"e","edgeId":43,"payload":null}"#.utf8),
                                  generation: bridge.readerGenerationSnapshot())
        reply?(.null, nil)
        XCTAssertTrue(waitUntil(timeout: 2) {
            ((try? String(contentsOfFile: outPath, encoding: .utf8)) ?? "").contains("43")
        }, "当前代际的 edge 应答必须写入（阳性对照）")
    }


    /// 自然退出收尾执行 onTerminated
    /// 期间，start() 必须等到回调结束（lifecycleLock）；去掉该锁时 start 会在回调仍
    /// 在执行时就返回。
    func testStartWaitsForTerminalCallbackCompletion() throws {
        let bridge = BridgeClient(nodePath: "/bin/sh",
                                  arguments: ["-c", "sleep 0.2; exit 7"], environment: [:])
        let callbackBegan = DispatchSemaphore(value: 0)
        bridge.onTerminated = { _ in
            callbackBegan.signal()
            Thread.sleep(forTimeInterval: 0.6)
        }
        try bridge.start()
        XCTAssertEqual(callbackBegan.wait(timeout: .now() + 5), .success, "自然退出必须触发收尾回调")
        let began = Date()
        try bridge.start()          // 必须等旧会话终局回调结束
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(began), 0.4,
                                    "start() 不得与旧会话终局回调重叠")
        XCTAssertTrue(bridge.isRunning)
        bridge.stop()
    }

    /// 同上：stop() 也必须等到自然退出的终局回调结束（否则会与新会话/回调交错）。
    func testStopWaitsForTerminalCallbackCompletion() throws {
        let bridge = BridgeClient(nodePath: "/bin/sh",
                                  arguments: ["-c", "sleep 0.2; exit 7"], environment: [:])
        let callbackBegan = DispatchSemaphore(value: 0)
        bridge.onTerminated = { _ in
            callbackBegan.signal()
            Thread.sleep(forTimeInterval: 0.6)
        }
        try bridge.start()
        XCTAssertEqual(callbackBegan.wait(timeout: .now() + 5), .success)
        let began = Date()
        bridge.stop()
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(began), 0.4,
                                    "stop() 不得在终局回调结束前返回")
        XCTAssertFalse(bridge.isRunning)
    }

    /// 死锁反例回归（**必须在回调内同步 stop()**——异步版抓不到该环）：
    /// 帧回调持 dispatchLock 期间，
    /// 自然退出收尾先取 dispatchLock 再等 lifecycleLock；回调若同步 stop() 会在收尾
    /// 先取 lifecycleLock 的锁序下与收尾成环。按全局锁序必须及时返回。
    /// 死锁表现为回调线程卡住 → 这里用超时信号量判决（绝不让测试进程整体挂死）。
    func testFrameCallbackStopDuringNaturalTerminationDoesNotDeadlock() throws {
        let bridge = BridgeClient(nodePath: "/bin/sh",
                                  arguments: ["-c", "sleep 0.2; exit 7"], environment: [:])
        try bridge.start()
        let stopReturned = DispatchSemaphore(value: 0)
        bridge.onEvent = { _, _ in
            Thread.sleep(forTimeInterval: 0.4)     // 此刻收尾已在等 dispatchLock
            bridge.stop()                          // **同步**（旧锁序下此处确定性死锁）
            stopReturned.signal()
        }
        let generation = bridge.readerGenerationSnapshot()
        DispatchQueue.global().async {
            bridge.dispatchStdoutForTesting([Data(#"{"event":"e"}"#.utf8)], generation: generation)
        }
        XCTAssertEqual(stopReturned.wait(timeout: .now() + 10), .success,
                       "帧回调内同步 stop() 不得与收尾形成死锁")
        XCTAssertFalse(bridge.isRunning)
    }

    /// 递归锁硬依赖回归：收尾抽干在生产路径上就是「同线程在
    /// dispatchLock 内再次进入派发」（handleTermination → finishStdoutReading →
    /// dispatchStdout）。非递归锁下该形状会自锁，故本用例
    /// 结构性地钉住「派发锁必须递归」。
    func testDispatchLockSupportsTerminalDrainReentry() throws {
        let bridge = try makeSilentBridge()
        defer { bridge.stop() }
        let reentered = DispatchSemaphore(value: 0)
        var events: [String] = []
        bridge.onEvent = { event, _ in
            events.append(event)
            if event == "outer" {
                // 与 handleTermination 的抽干同一调用形状（同一线程、持 dispatchLock）
                bridge.dispatchStdoutForTesting([Data(#"{"event":"inner"}"#.utf8)],
                                                generation: bridge.readerGenerationSnapshot())
                reentered.signal()
            }
        }
        let generation = bridge.readerGenerationSnapshot()
        DispatchQueue.global().async {
            bridge.dispatchStdoutForTesting([Data(#"{"event":"outer"}"#.utf8)], generation: generation)
        }
        XCTAssertEqual(reentered.wait(timeout: .now() + 10), .success,
                       "派发锁必须允许收尾抽干的同线程重入（NSRecursiveLock）")
        XCTAssertEqual(events, ["outer", "inner"])
    }

    /// 诊断日志必须有界且**绝不阻塞调用方**——宿主 stderr 停止排水
    /// （管道满且无人读）时，持 lifecycleLock/dispatchLock 的路径（stop()、终局收尾）
    /// 不得被日志 I/O 拖住（锁内同步 FileHandle.write 在 4k 行必然卡死）。
    func testLogSinkNeverBlocksCallerOnStalledStderr() async throws {
        let bridge = try makeSilentBridge()
        defer { bridge.stop() }
        let pipe = Pipe()                        // 读端不消费 → 64KiB 管道很快写满
        bridge.setLogSinkForTesting(pipe.fileHandleForWriting)
        let burstDone = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            bridge.logBurstForTesting(4000)      // ≈320KB 日志 >> 管道容量
            burstDone.signal()
        }
        XCTAssertEqual(burstDone.wait(timeout: .now() + 5), .success,
                       "日志入队不得被阻塞的 stderr 写拖住")
        // 让 stop() 的结算路径**真的写日志**（否则 drained 为空、log 不被调用，计时断言不承重）。
        // 子进程不响应，故该请求会一直驻留 pending。
        let pendingTask = Task { try? await bridge.invoke(method: "probe") }
        let registered = Date().addingTimeInterval(2)
        while bridge.pendingRequestCount == 0, Date() < registered { Thread.sleep(forTimeInterval: 0.01) }
        XCTAssertEqual(bridge.pendingRequestCount, 1, "stop() 前必须有一个未决请求")
        let stopBegan = Date()
        bridge.stop()
        XCTAssertLessThan(Date().timeIntervalSince(stopBegan), 3.0,
                          "stop() 不得被日志 I/O 拖住（锁内绝不做阻塞写）")
        _ = await pendingTask.value
        try? pipe.fileHandleForReading.close()
    }

    /// 日志汇聚的并发正确性：多线程入队 + 读端持续排水时不得丢行、不得写出半行
    /// （队列容量 512，这里 400 行全量送达；单条排水线程由 draining 标记保证）。
    func testLogSinkDeliversAllLinesUnderConcurrentWriters() throws {
        let bridge = try makeSilentBridge()
        defer { bridge.stop() }
        let pipe = Pipe()
        bridge.setLogSinkForTesting(pipe.fileHandleForWriting)
        let group = DispatchGroup()
        for worker in 0..<4 {
            group.enter()
            DispatchQueue.global().async {
                for index in 0..<100 { bridge.logLineForTesting("w\(worker)-\(index)") }
                group.leave()
            }
        }
        XCTAssertEqual(group.wait(timeout: .now() + 5), .success)
        var text = ""
        let deadline = Date().addingTimeInterval(5)
        while text.filter({ $0 == "\n" }).count < 400, Date() < deadline {
            let chunk = pipe.fileHandleForReading.availableData
            guard !chunk.isEmpty else { break }
            text += String(decoding: chunk, as: UTF8.self)
        }
        let lines = text.split(separator: "\n")
        XCTAssertEqual(lines.count, 400, "并发写入不得丢行")
        XCTAssertTrue(lines.allSatisfy { $0.hasPrefix("[bridge] w") }, "每行必须完整且前缀不变")
        try? pipe.fileHandleForWriting.close()
    }

    /// 代际门必须**逐行**复核——单批可含数千小帧，stop()/重启可在
    /// 批次派发中途推进代际，剩余行不得再进回调。用首帧回调里推进代际来构造中间点。
    func testBatchGenerationIsRecheckedPerLine() throws {
        let bridge = try makeSilentBridge()
        defer { bridge.stop() }
        var events: [String] = []
        bridge.onEvent = { event, _ in
            events.append(event)
            if events.count == 1 { bridge.advanceSessionGenerationForTesting() }   // 批次中途 stop/重启
        }
        let generation = bridge.readerGenerationSnapshot()
        let outcome = LineReader.Outcome(lines: [
            Data(#"{"event":"a"}"#.utf8),
            Data(#"{"event":"b"}"#.utf8),
            Data(#"{"event":"c"}"#.utf8),
        ])
        bridge.processStdoutOutcome(outcome, generation: generation)
        XCTAssertEqual(events, ["a"], "批次中途代际推进后，剩余行必须被逐行复核丢弃")
    }

    /// stop() 立刻推进会话代际——返回后本会话的在途帧必须被
    /// 派发代际门丢弃（否则 2s 内还会继续进回调）。
    func testNoFramesAfterStop() throws {
        let bridge = try makeSilentBridge()
        var events: [String] = []
        bridge.onEvent = { event, _ in events.append(event) }
        let generation = bridge.readerGenerationSnapshot()
        let outcome = LineReader.Outcome(lines: [Data(#"{"event":"late"}"#.utf8)], overflowResets: 0)
        bridge.stop()
        XCTAssertFalse(bridge.isRunning)
        // stop 后模拟「已切行、尚未派发」的旧代际帧：必须被门丢弃
        bridge.processStdoutOutcome(outcome, generation: generation)
        XCTAssertEqual(events, [], "stop() 后本会话帧不得再进回调（代际已推进）")
        // 读状态代际不变（不变量：只有 start() 发布 reader/句柄+代际）；会话代际由
        // stop() 推进，这正是派发门在 stop 后立刻生效的依据。
        XCTAssertEqual(bridge.readerGenerationSnapshot(), generation)
    }

    /// 尺寸门边界：恰等上限进入解析（不 fail-closed），上限 +1 才作废未决请求。
    func testOversizedBoundaryIsExact() async throws {
        let bridge = try makeSilentBridge()
        defer { bridge.stop() }
        let request = Task { try await bridge.invoke(method: "probe") }
        XCTAssertTrue(waitUntil { bridge.pendingRequestCount == 1 })
        bridge.handleIncomingLine(Data(repeating: 0x61, count: FrameCodec.maxFrameBytes))
        XCTAssertEqual(bridge.pendingRequestCount, 1, "恰等上限的行不得触发超长 fail-closed")
        bridge.handleIncomingLine(Data(repeating: 0x61, count: FrameCodec.maxFrameBytes + 1))
        XCTAssertEqual(bridge.pendingRequestCount, 0, "超一字节必须 fail-closed 作废全部未决")
        do {
            _ = try await request.value
            XCTFail("超长行作废后必须抛错")
        } catch {}
    }

    /// FIONREAD 常量钉（写错会让抽干静默变 no-op、残帧全丢）。
    func testBytesAvailableProbeSeesPipeBytes() throws {
        let probe = BridgeClient(nodePath: "/bin/sh", arguments: [], environment: [:])   // 不需要 start
        let pipe = Pipe()
        defer { try? pipe.fileHandleForWriting.close() }
        pipe.fileHandleForWriting.write(Data("abcde".utf8))
        XCTAssertEqual(probe.bytesAvailableForTesting(pipe.fileHandleForReading), 5,
                       "探针必须看到管道里的 5 字节")
        _ = pipe.fileHandleForReading.availableData
        XCTAssertEqual(probe.bytesAvailableForTesting(pipe.fileHandleForReading), 0,
                       "抽干后必须为 0（否则抽干循环会阻塞或空转）")
    }

    /// stderr 非 UTF-8 行计数丢弃、不入环形摘要；合法行照常中继。
    func testStderrInvalidUTF8IsCountedAndNotRelayed() throws {
        let script = "printf 'ok-1\\n' >&2; printf '\\377\\376bad\\n' >&2; printf 'ok-2\\n' >&2; exec sleep 1"
        let bridge = BridgeClient(nodePath: "/bin/sh", arguments: ["-c", script], environment: [:])
        try bridge.start()
        defer { bridge.stop() }
        XCTAssertTrue(waitUntil(timeout: 5) { bridge.recentStderrSummary.contains("ok-2") },
                      "合法 stderr 行必须照常中继（实际：\(bridge.recentStderrSummary)")
        XCTAssertFalse(bridge.recentStderrSummary.contains("bad"), "非 UTF-8 行不得进入环形摘要")
        let lines = bridge.recentStderrSummary.split(separator: "\n", omittingEmptySubsequences: false)
        XCTAssertEqual(lines.count, 2, "只应有两条合法行")
    }

    /// ≥2 MiB 单行帧走**真实读路径**（分块 + 增量扫描 + 尺寸/溢出
    /// 边界）必须完整送达。
    func testLargeSingleLineFrameArrivesThroughRealReadPath() throws {
        let blobBytes = 2 * 1024 * 1024
        let scriptPath = NSTemporaryDirectory() + "dsh-large-\(UUID().uuidString).sh"
        let script = """
        printf '{"notify":"ready","payload":{"port":17520,"shellVersion":"1.0","blob":"'
        head -c \(blobBytes) /dev/zero | tr '\\000' x
        printf '"}}\\n'
        exec sleep 1
        """
        try script.write(toFile: scriptPath, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(atPath: scriptPath) }
        let bridge = BridgeClient(nodePath: "/bin/sh", arguments: [scriptPath], environment: [:])
        var ready: (Int, String)?
        bridge.onReady = { port, version in ready = (port, version) }
        try bridge.start()
        defer { bridge.stop() }
        XCTAssertTrue(waitUntil(timeout: 10) { ready != nil }, "2 MiB 单行帧必须被完整切出并送达")
        XCTAssertEqual(ready?.0, 17520)
        XCTAssertEqual(ready?.1, "1.0")
    }

    // MARK: - handleIncomingLine（internal 测试接缝）

    /// 超长帧（> FrameCodec.maxFrameBytes）：丢弃该帧并作废全部未决请求
    /// （code 4），绝不静默留一个永不 settle 的 invoke。
    func testOversizedLineFailsAllPendingWithCodeFour() async throws {
        let bridge = try makeSilentBridge()
        defer { bridge.stop() }

        let request = Task { try await bridge.invoke(method: "probe") }
        XCTAssertTrue(waitUntil { bridge.pendingRequestCount == 1 },
                      "invoke 应在写帧后登记一个未决请求（实际 \(bridge.pendingRequestCount)）")

        bridge.handleIncomingLine(String(repeating: "a", count: FrameCodec.maxFrameBytes + 1))

        XCTAssertEqual(bridge.pendingRequestCount, 0, "超长帧必须作废全部未决请求")
        do {
            _ = try await request.value
            XCTFail("超长帧作废后 invoke 必须抛错，不得悬挂或成功")
        } catch {
            let nsError = error as NSError
            XCTAssertEqual(nsError.domain, BridgeClient.errorDomain)
            XCTAssertEqual(nsError.code, BridgeClient.errorCodePendingDropped)
            // 文案走键表 bridge.frameTooLarge（%d = 帧长上限）：期望值用同一取值面
            // 动态构造（机器语言为 en 时同样成立）；并先确认资源真的解析出文案
            // （不是缺键回落的键名），再钉「作废原因 == 该键的本地化整句」——
            // 裸 contains("4194304") 过松，证明不了本地化模板被使用。
            let localized = NativeText.format(.bridgeFrameTooLarge, Int32(FrameCodec.maxFrameBytes))
            XCTAssertNotEqual(localized, NativeTextKey.bridgeFrameTooLarge.rawValue,
                              "bridge.frameTooLarge 必须命中 .strings，不得回落键名")
            XCTAssertTrue(localized.contains("\(FrameCodec.maxFrameBytes)"),
                          "该键模板填参后必须带帧长上限数值：\(localized)")
            XCTAssertEqual(nsError.localizedDescription, localized,
                           "作废原因必须是 bridge.frameTooLarge 的本地化文案，实际：\(nsError.localizedDescription)")
        }
    }

    /// 出站帧（notify / edge / ready）仍能被同一条唯一解析路径分类并
    /// 分发；id 族优先于 outbound。real-sidecar 集成用例在本环境不可运行（工作区
    /// 未安装 node workspace 依赖），本用例覆盖它们依赖的同一条分类路径。
    func testOutboundFramesDispatchThroughSingleParse() throws {
        let bridge = BridgeClient(nodePath: "/bin/sh",
                                  arguments: ["-c", "exec sleep 30"],
                                  environment: [:])
        var notifies: [(String, AnyCodable?)] = []
        var edges: [String] = []
        var ready: (Int, String)?
        // 线程契约：出站面回调在 start() 之前赋值、之后只读。
        bridge.onNotify = { event, payload in notifies.append((event, payload)) }
        bridge.onEdgeRequest = { method, _, _ in edges.append(method) }
        bridge.onReady = { port, version in ready = (port, version) }
        BridgeClient.resetInboundParseCount()
        try bridge.start()
        defer { bridge.stop() }

        bridge.handleIncomingLine(#"{"notify":"rendererPush","payload":{"channel":"x","data":1}}"#)
        XCTAssertEqual(notifies.count, 1)
        XCTAssertEqual(notifies.first?.0, "rendererPush")
        XCTAssertEqual(notifies.first?.1, .object(["channel": .string("x"), "data": .number(1)]))

        bridge.handleIncomingLine(#"{"notify":"ready","payload":{"port":17520,"shellVersion":"1.2.3"}}"#)
        XCTAssertEqual(ready?.0, 17520)
        XCTAssertEqual(ready?.1, "1.2.3")

        bridge.handleIncomingLine(#"{"edge":"desktop_ssh_connect","edgeId":7,"payload":{"a":true}}"#)
        XCTAssertEqual(edges, ["desktop_ssh_connect"])

        // id 族优先：即使混入 edge/notify 键也按 response 归属，绝不落到 outbound。
        bridge.handleIncomingLine(#"{"id":999,"ok":true,"edge":"x","edgeId":9}"#)
        XCTAssertEqual(edges, ["desktop_ssh_connect"], "id+ok 帧必须优先于 outbound 分类")

        // 出站分类的严格性：已知键存在但
        // 类型不符 → 整行丢弃，绝不落到另一族；edgeId 必须为精确整数。
        bridge.handleIncomingLine(#"{"edge":5,"notify":"ready","payload":{"port":9999,"shellVersion":"x"}}"#)
        XCTAssertEqual(ready?.0, 17520, "非字符串 edge 不得落到 notify/ready 分类")
        bridge.handleIncomingLine(#"{"edge":"e","edgeId":1.5,"payload":null}"#)
        XCTAssertEqual(edges, ["desktop_ssh_connect"], "非整数 edgeId 的 edge 帧必须丢弃")
        bridge.handleIncomingLine(#"{"edge":"e","edgeId":true,"payload":null}"#)
        XCTAssertEqual(edges, ["desktop_ssh_connect"], "布尔 edgeId 必须丢弃")

        XCTAssertEqual(BridgeClient.inboundParseCountSnapshot(), 7, "七行各一次解析（含被丢弃的违约帧）")
    }

    /// stderr 环形摘要的可观察契约（>40 行丢最旧、单行 400 字符截断、
    /// 独立 readerLock 下不丢最后一行）。
    func testStderrTailRingAndSummary() throws {
        let script = "for i in $(seq 1 45); do echo \"line-$i\" >&2; done; "
            + "printf 'x%.0s' $(seq 1 500) >&2; echo >&2; exec sleep 1"
        let bridge = BridgeClient(nodePath: "/bin/sh", arguments: ["-c", script], environment: [:])
        try bridge.start()
        defer { bridge.stop() }
        XCTAssertTrue(waitUntil(timeout: 5) { bridge.recentStderrSummary.contains("…") },
                      "超长 stderr 行应截断入环（实际：\(bridge.recentStderrSummary.suffix(120))）")
        let lines = bridge.recentStderrSummary.split(separator: "\n", omittingEmptySubsequences: false)
        XCTAssertLessThanOrEqual(lines.count, 40, "环形上限 40 行")
        XCTAssertFalse(bridge.recentStderrSummary.contains(String(repeating: "x", count: 500)),
                       "超长行不得原样入环（400 字符上限）")
        XCTAssertTrue(lines.contains { $0 == "line-45" }, "最后一行必须在环内")
        XCTAssertFalse(lines.contains { $0 == "line-1" }, "最旧行应被淘汰（46 行入环、保留 40）")
    }

    /// 入站行每行只解析一次（唯一解析点计数探针）。
    func testInboundParseCountIsOnePerLine() throws {
        let bridge = try makeSilentBridge()
        defer { bridge.stop() }
        BridgeClient.resetInboundParseCount()
        bridge.handleIncomingLine(#"{"id":999,"ok":true,"result":null}"#)
        bridge.handleIncomingLine(#"{"edge":"e","edgeId":1,"payload":null}"#)
        bridge.handleIncomingLine("not json")
        bridge.handleIncomingLine(String(repeating: "a", count: FrameCodec.maxFrameBytes + 1))
        XCTAssertEqual(BridgeClient.inboundParseCountSnapshot(), 3,
                       "三行进入解析；超长行在解析前被挡下（不计入）")
    }

    /// 非法 JSON / 非协议帧 / 未知 id 响应 / sidecar→Swift request（协议违约）
    /// 一律 loud 丢弃，且不得动到 id=1 的未决请求；随后的真实响应仍能配对。
    func testMalformedUnknownAndRequestFramesDoNotStealPendingResponse() async throws {
        let bridge = try makeSilentBridge()
        defer { bridge.stop() }

        let request = Task { try await bridge.invoke(method: "probe") }
        XCTAssertTrue(waitUntil { bridge.pendingRequestCount == 1 })

        bridge.handleIncomingLine("{not json")                                  // 非法 JSON
        bridge.handleIncomingLine(#"{"hello":"world"}"#)                        // 非协议帧
        bridge.handleIncomingLine(#"{"id":999,"ok":true,"result":null}"#)       // 未知 id 响应
        bridge.handleIncomingLine(#"{"id":1,"method":"nope.unknown"}"#)         // request 违约帧
        XCTAssertEqual(bridge.pendingRequestCount, 1,
                       "非法/未知帧必须只丢弃自己，不得作废或偷走未决请求")

        // 真正的响应（id 自 1 起单调递增）：必须仍能配对并 settle。
        bridge.handleIncomingLine(#"{"id":1,"ok":true,"result":{"pair":"kept"}}"#)
        let value = try await request.value
        XCTAssertEqual(value, .object(["pair": .string("kept")]))
        XCTAssertEqual(bridge.pendingRequestCount, 0, "配对成功后未决请求清零")
    }
}
