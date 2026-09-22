//
//  FrameCodecTests.swift — B 桥 NDJSON 帧编解码（design 25 §4.4.2）
//  纯逻辑单测：编解码往返、容错分类、超长帧、载荷形态。
//
import XCTest
@testable import DSHChamber

final class FrameCodecTests: XCTestCase {
    /// 测试侧行解码：生产入站解析是 BridgeClient.handleIncomingLine（Data 直入，
    /// BridgeClientLineReadTests 覆盖）。本 helper 逐字保留既有实现的语义
    /// （超长短路 → UTF-8 解析 → classify），使下列分类/容忍断言原样成立。
    private func decodeLine(_ line: String) -> BridgeFrame? {
        guard !FrameCodec.isLineTooLong(line),
              let data = line.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return nil
        }
        return FrameCodec.classify(jsonObject: object)
    }

    func testEncodeDecodeRequestRoundtrip() throws {
        let payload: AnyCodable = .object(["instanceId": .string("local")])
        let data = try FrameCodec.encodeRequest(id: 7, method: "desktop_ssh_connect",
                                                payload: payload)
        let line = String(data: data, encoding: .utf8)!
        XCTAssertTrue(line.hasSuffix("\n"))
        XCTAssertTrue(line.hasPrefix("{"))
        // JSONEncoder 字典键序不保证——语义断言而非字节断言
        guard case .request(id: 7, method: "desktop_ssh_connect", payload: .object(let obj))? =
            decodeLine(line) else {
            return XCTFail("request 帧未能往返解码")
        }
        XCTAssertEqual(obj["instanceId"], .string("local"))
    }

    /// 生产只发 request；解码面覆盖 sidecar 的 ok/error 响应帧分类（id 族优先）。
    func testDecodeResponseOkAndError() {
        XCTAssertEqual(decodeLine(#"{"id":1,"ok":true,"result":[1,true]}"#),
                       .response(id: 1, ok: true, result: .array([.number(1), .bool(true)]),
                                 error: nil))
        XCTAssertEqual(decodeLine(#"{"id":2,"ok":false,"error":"poc-unimplemented"}"#),
                       .response(id: 2, ok: false, result: nil, error: "poc-unimplemented"))
    }

    func testEncodeRequestWithNullPayload() throws {
        // 缺省载荷 → 线格式 payload:null；分类侧折叠回 nil（协议两侧同语义）。
        let data = try FrameCodec.encodeRequest(id: 3, method: "desktop_ssh_status_changed",
                                                payload: nil)
        XCTAssertEqual(decodeLine(String(data: data, encoding: .utf8)!),
                       .request(id: 3, method: "desktop_ssh_status_changed", payload: nil))
    }

    func testUnicodeAndNewlinePayloadSafe() throws {
        let text = "多行\n中文 \u{1F680} \"quoted\""
        let data = try FrameCodec.encodeRequest(id: 9, method: "e", payload: .string(text))
        XCTAssertEqual(decodeLine(String(data: data, encoding: .utf8)!),
                       .request(id: 9, method: "e", payload: .string(text)))
    }

    func testMalformedLinesReturnNil() {
        XCTAssertNil(decodeLine(""))
        XCTAssertNil(decodeLine("not json"))
        XCTAssertNil(decodeLine(#"{"id":1}"#))          // 无 method/ok/event
        XCTAssertNil(decodeLine(#"{"method":"x"}"#))     // 无 id（request/response 需 id）
        XCTAssertNil(decodeLine(#"{"id":1,"event":2}"#)) // event 名非字符串
        XCTAssertNil(decodeLine(#"{"id":"1","ok":true}"#)) // id 非 Int
        XCTAssertNil(decodeLine(#"{"id":1,"ok":"yes"}"#))  // ok 非 Bool
    }

    func testResponseWithoutResultDecodes() {
        // 容忍语义：ok:true 无 result → result nil（协议注释：容忍缺省字段）
        let line = #"{"id":3,"ok":true}"#
        guard case .response(id: 3, ok: true, result: nil, error: nil)? =
            decodeLine(line) else {
            return XCTFail("缺省 result 的 ok 帧应可解码")
        }
    }

    /// 单次解析分类器的严格性（与 JSONDecoder Envelope 解码逐条
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
        XCTAssertNil(decodeLine(#"{"edge":"e","edgeId":1,"payload":null}"#))
        XCTAssertNil(decodeLine(#"{"notify":"ready","payload":null}"#))
    }

    /// 极值边界：JSONSerialization 丢失原始 token 后与 JSONDecoder 的接受集差异——
    /// 全部 fail-closed 或影响面为零，钉住回归。
    func testClassifyExtremeNumberBoundaries() {
        // 浮点存储恰好 -2^63（只可能来自越界 token 的 Double 舍入）→ 拒绝
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

    /// 另两处 token 级差异（JSONSerialization 已丢原始 token，
    /// 无法事后还原；均为无实际影响的边界）：下溢指数折叠为 0（方向
    /// 变宽松）、整数写法 -0 变 .number(0)（AnyCodable == 相等、页面文本都是 "0"）。
    func testClassifyNumberTokenEdgeCases() {
        guard case .event(event: "e", payload: .array(let underflow))? =
            decodeLine(#"{"event":"e","payload":[1e-400]}"#) else {
            return XCTFail("下溢指数应折叠为 0 并被接受")
        }
        XCTAssertEqual(underflow, [.number(0)])
        XCTAssertNil(decodeLine(#"{"event":"e","payload":[1e-1000]}"#),
                     "JSONSerialization 无法表示的数字整帧丢弃（与旧一致）")
        XCTAssertEqual(decodeLine(#"{"event":"e","payload":[-0]}"#),
                       .event(event: "e", payload: .array([.number(0)])))
    }

    func testClassificationPrecedence() {
        // 确定性分类：request(id+method) > response(id+ok) > event(无 id)
        XCTAssertNotNil(decodeLine(#"{"id":1,"method":"m","ok":true}"#))
        guard case .request? = decodeLine(#"{"id":1,"method":"m","ok":true}"#) else {
            return XCTFail("id+method 应分类为 request")
        }
        // 未知键容忍：event 帧混入 ok 键仍按 event 解码（实现按"无 id"归类）
        guard case .event(event: "e", payload: nil)? =
            decodeLine(#"{"event":"e","ok":true}"#) else {
            return XCTFail("无 id + event 应分类为 event（未知键容忍）")
        }
    }

    func testIsLineTooLong() {
        XCTAssertFalse(FrameCodec.isLineTooLong(String(repeating: "a", count: FrameCodec.maxFrameBytes - 1)))
        XCTAssertTrue(FrameCodec.isLineTooLong(String(repeating: "a", count: FrameCodec.maxFrameBytes + 1)))
    }

    func testEncodeRequestOversizeThrows() {
        let big = String(repeating: "x", count: FrameCodec.maxFrameBytes)
        XCTAssertThrowsError(try FrameCodec.encodeRequest(id: 1, method: "e", payload: .string(big)))
    }
}
