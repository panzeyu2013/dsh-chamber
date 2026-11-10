//
//  BrowserGuestBridgeContractTests.swift — browser 桥的纯契约点（D7 / D12 附带）
//  （design 28 v3 §3/§5；decisions D7）
//
import XCTest
@testable import DSHChamber

final class BrowserGuestBridgeContractTests: XCTestCase {
    /// D7：只有 {ok:true,...} 的 forward-list 回执才构成「来源已证明」；{ok:false}、
    /// 异形回执一律 false（fail-closed → verifySource 返回 nil，不建 guest）。
    func testForwardListProofRequiresOKTrue() {
        XCTAssertTrue(MainWindowController.isForwardListProof(
            .object(["ok": .bool(true), "records": .array([])])))
        XCTAssertFalse(MainWindowController.isForwardListProof(
            .object(["ok": .bool(false), "error": .string("unknown source")])))
        XCTAssertFalse(MainWindowController.isForwardListProof(.object([:])),
                       "缺 ok 键不得视为证明")
        XCTAssertFalse(MainWindowController.isForwardListProof(.string("ok")),
                       "非对象回执不得视为证明")
        XCTAssertFalse(MainWindowController.isForwardListProof(
            .object(["ok": .string("true")])), "ok 必须是布尔 true（字符串不算）")
    }

    /// A 桥 invoke 失败码的唯一来源：协议失败沿用 BrowserGuestFailure 错误码，
    /// 白名单外 method 保持 method_not_allowed（shim 侧已知码，不新增文案）。
    func testDispatchErrorCodes() {
        XCTAssertEqual(BrowserIPCDispatchError.protocolFailure(.invalidPayload).code,
                       BrowserGuestFailure.invalidPayload.rawValue)
        XCTAssertEqual(BrowserIPCDispatchError.protocolFailure(.ownerMismatch).code,
                       "guest_owner_mismatch")
        XCTAssertEqual(BrowserIPCDispatchError.methodNotAllowed.code, "method_not_allowed")
    }
}
