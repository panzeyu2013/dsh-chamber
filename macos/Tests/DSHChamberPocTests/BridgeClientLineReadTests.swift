//
//  BridgeClientLineReadTests.swift
//  DSHChamberPocTests
//
//  G9（2026-12 审计）：BridgeClient 的 stdout 读路径此前零 XCTest 覆盖——
//    - LineReader：部分帧跨 append 重组（含跨块的多字节 UTF-8 序列）、一次
//      append 多帧、\r\n 兼容、EOF 无换行残尾恰一次、非 UTF-8 行计数跳过、
//      无换行超限清缓冲重同步与恢复；
//    - handleIncomingLine（internal 测试接缝，见 BridgeClient.swift）：超长帧
//      作废全部未决请求（code 4，绝不永久悬挂）、非法 JSON / 非协议帧 / 未知
//      id 响应 / sidecar→Swift request 违约帧一律丢弃且不偷走未决请求、随后
//      的真实响应仍能正确配对。
//
//  进程用 /bin/sh -c 'exec sleep 30'（真实子进程但绝不回应协议帧，也不在
//  stop 时对抗 SIGTERM）；所有等待都有显式上限。
import XCTest
@testable import DSHChamberPoc

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
    private func makeSilentBridge() throws -> BridgeClient {
        let bridge = BridgeClient(nodePath: "/bin/sh",
                                  arguments: ["-c", "exec sleep 30"],
                                  environment: [:])
        try bridge.start()
        XCTAssertTrue(bridge.isRunning)
        return bridge
    }

    // MARK: - LineReader

    func testPartialFramesAcrossAppendsAreReassembled() {
        var reader = LineReader()
        let payload = "{\"k\":\"你\"}\n"
        let bytes = Array(payload.utf8)
        // 切点落在「你」的首字节之后：跨 append 的多字节序列必须原样重组
        // （LineReader 先攒字节、整行到手才做 UTF-8 解码）。
        let first = reader.append(Data(bytes[0..<7]))
        XCTAssertEqual(first.lines, [], "半个帧不得产出任何行")
        XCTAssertEqual(first.invalidUTF8Lines, 0)

        let second = reader.append(Data(bytes[7...]))
        XCTAssertEqual(second.lines, ["{\"k\":\"你\"}"], "残块 + 余量应拼出完整一行")
        XCTAssertEqual(second.invalidUTF8Lines, 0, "跨 read 块的多字节序列不得被腰斩")
    }

    func testMultipleFramesPerAppendAndCRLF() {
        var reader = LineReader()
        let outcome = reader.append(Data("one\ntwo\r\nthree\n".utf8))
        XCTAssertEqual(outcome.lines, ["one", "two", "three"],
                       "一次 append 必须切出全部完整帧；\r\n 的行尾 \r 应剥掉")
        XCTAssertEqual(outcome.invalidUTF8Lines, 0)
        XCTAssertEqual(outcome.overflowResets, 0)
    }

    func testFinishEmitsUnterminatedTailExactlyOnce() {
        var reader = LineReader()
        XCTAssertEqual(reader.append(Data("no-newline".utf8)).lines, [])
        let first = reader.finish()
        XCTAssertEqual(first.lines, ["no-newline"],
                       "EOF 收尾把无换行残尾按违约行上抛（调用方 loud）")
        XCTAssertEqual(reader.finish().lines, [], "finish 幂等：第二次不得重复产出")
        XCTAssertEqual(reader.append(Data("late\n".utf8)).lines, [],
                       "EOF 后的 append 必须拒收（防御）")
    }

    func testInvalidUTF8LineIsCountedAndSkipped() {
        var reader = LineReader()
        // 0xFF 不是合法 UTF-8 起始字节 → 该行计数丢弃，后续行不受影响。
        let outcome = reader.append(Data([0x41, 0xFF, 0x0A]))
        XCTAssertEqual(outcome.lines, [])
        XCTAssertEqual(outcome.invalidUTF8Lines, 1)
        let next = reader.append(Data("ok\n".utf8))
        XCTAssertEqual(next.lines, ["ok"], "非法行之后缓冲必须仍可继续切行")
        XCTAssertEqual(next.invalidUTF8Lines, 0)
    }

    func testUnterminatedOverflowResetsBufferAndRecovers() {
        var reader = LineReader(maxBufferedBytes: 8)
        // 无换行且超上限 → 清缓冲重同步并计数（协议违约流不得无界吃内存）。
        let overflow = reader.append(Data(repeating: 0x61, count: 20))
        XCTAssertEqual(overflow.lines, [])
        XCTAssertEqual(overflow.overflowResets, 1)
        let recovered = reader.append(Data("ok\n".utf8))
        XCTAssertEqual(recovered.lines, ["ok"], "清缓冲后必须重新同步并可继续切行")

        // 超限但**带换行**的同一 append：行先被切出，不算无换行溢出
        // （溢出只针对永远切不出行的残尾）。
        var lineReader = LineReader(maxBufferedBytes: 8)
        let longLine = String(repeating: "a", count: 20) + "\n"
        let longOutcome = lineReader.append(Data(longLine.utf8))
        XCTAssertEqual(longOutcome.lines, [String(repeating: "a", count: 20)])
        XCTAssertEqual(longOutcome.overflowResets, 0,
                       "有换行的超长行由 handleIncomingLine 的超长护栏处理，不在 LineReader 层丢")
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
            XCTAssertTrue(nsError.localizedDescription.contains("上限"),
                          "作废原因应指向帧长上限，实际：\(nsError.localizedDescription)")
        }
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
