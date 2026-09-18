//
//  FrameCodecTests.swift — W-05 B 桥 NDJSON 帧编解码（design 25 §4.4.2）
//  纯逻辑单测：编解码往返、容错分类、超长帧、载荷形态。
//
import XCTest
@testable import DSHChamber

final class FrameCodecTests: XCTestCase {
    func testEncodeDecodeRequestRoundtrip() throws {
        let frame = BridgeFrame.request(id: 7, method: "desktop_ssh_connect",
                                        payload: .object(["instanceId": .string("local")]))
        let data = try FrameCodec.encode(frame)
        let line = String(data: data, encoding: .utf8)!
        XCTAssertTrue(line.hasSuffix("\n"))
        XCTAssertTrue(line.hasPrefix("{"))
        // JSONEncoder 字典键序不保证——语义断言而非字节断言
        guard case .request(id: 7, method: "desktop_ssh_connect", payload: .object(let obj))? =
            FrameCodec.decodeLine(line) else {
            return XCTFail("request 帧未能往返解码")
        }
        XCTAssertEqual(obj["instanceId"], .string("local"))
    }

    func testEncodeDecodeResponseOkAndError() throws {
        let okFrame = BridgeFrame.response(id: 1, ok: true, result: .array([.number(1), .bool(true)]), error: nil)
        let okData = try FrameCodec.encode(okFrame)
        XCTAssertEqual(FrameCodec.decodeLine(String(data: okData, encoding: .utf8)!), okFrame)

        let errFrame = BridgeFrame.response(id: 2, ok: false, result: nil, error: "poc-unimplemented")
        let errData = try FrameCodec.encode(errFrame)
        XCTAssertEqual(FrameCodec.decodeLine(String(data: errData, encoding: .utf8)!), errFrame)
    }

    func testEncodeDecodeEventWithNullPayload() throws {
        let frame = BridgeFrame.event(event: "desktop_ssh_status_changed", payload: nil)
        let data = try FrameCodec.encode(frame)
        guard case .event(event: "desktop_ssh_status_changed", payload: nil)? =
            FrameCodec.decodeLine(String(data: data, encoding: .utf8)!) else {
            return XCTFail("event 帧未能往返解码")
        }
    }

    func testUnicodeAndNewlinePayloadSafe() throws {
        let text = "多行\n中文 \u{1F680} \"quoted\""
        let frame = BridgeFrame.event(event: "e", payload: .string(text))
        let data = try FrameCodec.encode(frame)
        let decoded = FrameCodec.decodeLine(String(data: data, encoding: .utf8)!)
        XCTAssertEqual(decoded, frame)
    }

    func testMalformedLinesReturnNil() {
        XCTAssertNil(FrameCodec.decodeLine(""))
        XCTAssertNil(FrameCodec.decodeLine("not json"))
        XCTAssertNil(FrameCodec.decodeLine(#"{"id":1}"#))          // 无 method/ok/event
        XCTAssertNil(FrameCodec.decodeLine(#"{"method":"x"}"#))     // 无 id（request/response 需 id）
        XCTAssertNil(FrameCodec.decodeLine(#"{"id":1,"event":2}"#)) // event 名非字符串
        XCTAssertNil(FrameCodec.decodeLine(#"{"id":"1","ok":true}"#)) // id 非 Int
        XCTAssertNil(FrameCodec.decodeLine(#"{"id":1,"ok":"yes"}"#))  // ok 非 Bool
    }

    func testResponseWithoutResultDecodes() {
        // 容忍语义：ok:true 无 result → result nil（协议注释：容忍缺省字段）
        let line = #"{"id":3,"ok":true}"#
        guard case .response(id: 3, ok: true, result: nil, error: nil)? =
            FrameCodec.decodeLine(line) else {
            return XCTFail("缺省 result 的 ok 帧应可解码")
        }
    }

    /// Phase 1 C3：单次解析分类器的严格性（与旧 JSONDecoder Envelope 解码逐条
    /// 等价）——已知键类型不符毒化整行，null 与缺省同义，整数域接受集一致。
    func testClassifyStrictTypePoisoningAndNullFolding() {
        // 类型不符 → 整行 nil（否则非法行会变成合法 response 窃取 pending）
        XCTAssertNil(FrameCodec.classify(jsonObject: ["id": 1, "method": 5, "ok": true]))
        XCTAssertNil(FrameCodec.classify(jsonObject: ["id": 1, "ok": 1]))
        XCTAssertNil(FrameCodec.classify(jsonObject: ["id": true, "ok": true]))
        XCTAssertNil(FrameCodec.classify(jsonObject: ["id": 1, "ok": true, "error": 5]))
        XCTAssertNil(FrameCodec.classify(jsonObject: ["event": 2]))
        XCTAssertNil(FrameCodec.classify(jsonObject: ["id": 1, "ok": true, "result": ["k": Date()]]))
        // null = 缺省（可选字段折叠为 nil）
        XCTAssertEqual(FrameCodec.classify(jsonObject: ["id": NSNull(), "event": "e"]),
                       .event(event: "e", payload: nil))
        XCTAssertEqual(FrameCodec.classify(jsonObject: ["id": 1, "method": NSNull(), "ok": true]),
                       .response(id: 1, ok: true, result: nil, error: nil))
        XCTAssertEqual(FrameCodec.classify(jsonObject: ["id": 1, "ok": true, "payload": NSNull()]),
                       .response(id: 1, ok: true, result: nil, error: nil))
        // 整数域：整值浮点接受（含 1e16），非整值/域外拒绝
        XCTAssertEqual(FrameCodec.classify(jsonObject: ["id": 1.0, "ok": true]),
                       .response(id: 1, ok: true, result: nil, error: nil))
        XCTAssertEqual(FrameCodec.classify(jsonObject: ["id": 1e16 as Double, "ok": true]),
                       .response(id: 10_000_000_000_000_000, ok: true, result: nil, error: nil))
        XCTAssertNil(FrameCodec.classify(jsonObject: ["id": 1.5, "ok": true]))
        XCTAssertNil(FrameCodec.classify(jsonObject: ["id": 1e19 as Double, "ok": true]))
        // id 族优先；edge/notify 族不落 classify（由 BridgeClient 出站分类接手）
        guard case .request? = FrameCodec.classify(
            jsonObject: ["id": 1, "method": "m", "event": "e", "edge": "x"]) else {
            return XCTFail("id+method 必须优先分类为 request")
        }
        XCTAssertNil(FrameCodec.decodeLine(#"{"edge":"e","edgeId":1,"payload":null}"#))
        XCTAssertNil(FrameCodec.decodeLine(#"{"notify":"ready","payload":null}"#))
    }

    /// 独立差分审查（A）发现的极值边界：JSONSerialization 丢失原始 token 后与旧
    /// JSONDecoder 的接受集差异——全部 fail-closed 或影响面为零，钉住回归。
    func testClassifyExtremeNumberBoundaries() {
        // 浮点存储恰好 -2^63（只可能来自越界 token 的 Double 舍入）→ 拒绝（旧实现亦拒）
        XCTAssertNil(FrameCodec.classify(jsonObject: ["id": -9_223_372_036_854_775_809.0, "ok": true]))
        // 合法的整数存储 Int64.min 不受影响
        XCTAssertEqual(FrameCodec.classify(jsonObject: ["id": NSNumber(value: Int64.min), "ok": true]),
                       .response(id: Int.min, ok: true, result: nil, error: nil))
        // 域外无符号大整数（非浮点存储）→ nil（与旧 JSONDecoder 一致）
        XCTAssertNil(FrameCodec.classify(jsonObject: ["id": NSNumber(value: UInt64.max), "ok": true]))
        // 2^63 浮点 → nil
        XCTAssertNil(FrameCodec.classify(jsonObject: ["id": 9_223_372_036_854_775_808.0, "ok": true]))
        // 1e16 精确可表示 → 接受（不是 2^53 一刀切）
        XCTAssertEqual(FrameCodec.classify(jsonObject: ["id": 1e16 as Double, "ok": true]),
                       .response(id: 10_000_000_000_000_000, ok: true, result: nil, error: nil))
    }

    /// 差分审查（A）确认的另两处 token 级差异（JSONSerialization 已丢原始 token，
    /// 无法事后还原；均为无实际影响的边界）：下溢指数折叠为 0（旧整帧 nil，方向
    /// 变宽松）、整数写法 -0 变 .number(0)（AnyCodable == 相等、页面文本都是 "0"）。
    func testClassifyNumberTokenEdgeCases() {
        guard case .event(event: "e", payload: .array(let underflow))? =
            FrameCodec.decodeLine(#"{"event":"e","payload":[1e-400]}"#) else {
            return XCTFail("下溢指数应折叠为 0 并被接受")
        }
        XCTAssertEqual(underflow, [.number(0)])
        XCTAssertNil(FrameCodec.decodeLine(#"{"event":"e","payload":[1e-1000]}"#),
                     "JSONSerialization 无法表示的数字整帧丢弃（与旧一致）")
        XCTAssertEqual(FrameCodec.decodeLine(#"{"event":"e","payload":[-0]}"#),
                       .event(event: "e", payload: .array([.number(0)])))
    }

    func testClassificationPrecedence() {
        // 确定性分类：request(id+method) > response(id+ok) > event(无 id)
        XCTAssertNotNil(FrameCodec.decodeLine(#"{"id":1,"method":"m","ok":true}"#))
        guard case .request? = FrameCodec.decodeLine(#"{"id":1,"method":"m","ok":true}"#) else {
            return XCTFail("id+method 应分类为 request")
        }
        // 未知键容忍：event 帧混入 ok 键仍按 event 解码（实现按"无 id"归类）
        guard case .event(event: "e", payload: nil)? =
            FrameCodec.decodeLine(#"{"event":"e","ok":true}"#) else {
            return XCTFail("无 id + event 应分类为 event（未知键容忍）")
        }
    }

    func testIsLineTooLong() {
        XCTAssertFalse(FrameCodec.isLineTooLong(String(repeating: "a", count: FrameCodec.maxFrameBytes - 1)))
        XCTAssertTrue(FrameCodec.isLineTooLong(String(repeating: "a", count: FrameCodec.maxFrameBytes + 1)))
    }

    func testEncodeOversizeThrows() throws {
        let big = String(repeating: "x", count: FrameCodec.maxFrameBytes)
        XCTAssertThrowsError(try FrameCodec.encode(.event(event: "e", payload: .string(big))))
    }
}
