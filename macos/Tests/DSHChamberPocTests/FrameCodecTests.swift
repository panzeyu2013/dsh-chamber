//
//  FrameCodecTests.swift — W-05 B 桥 NDJSON 帧编解码（design 25 §4.4.2）
//  纯逻辑单测：编解码往返、容错分类、超长帧、载荷形态。
//
import XCTest
@testable import DSHChamberPoc

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
