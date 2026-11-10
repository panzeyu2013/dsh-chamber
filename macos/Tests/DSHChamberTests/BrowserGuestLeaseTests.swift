//
//  BrowserGuestLeaseTests.swift — 租约账本 / 通道常量 / 载荷编解码单测（design 28 v3 §3/§5/§4.2）
//
import XCTest
@testable import DSHChamber

final class BrowserGuestLeaseTests: XCTestCase {
    private func mint(_ book: inout BrowserGuestLeaseBook, lease: String = "L1",
                      tabId: String = "tab-1", sourceId: String = "dsh-a",
                      documentId: String = "doc-1") -> Result<BrowserGuestLease, BrowserGuestFailure> {
        book.mint(lease: lease, tabId: tabId, sessionId: "s-1", sourceId: sourceId,
                  sourceFingerprint: "fp-a", partitionKey: "fp-a|cwd:/w", documentId: documentId,
                  mayForward: true)
    }

    func testMintAndAuthorize() {
        var book = BrowserGuestLeaseBook()
        XCTAssertEqual(try? mint(&book).get().lease, "L1")
        XCTAssertEqual(try? book.authorized(lease: "L1", tabId: "tab-1", documentId: "doc-1").get().sourceId, "dsh-a")
        XCTAssertEqual(book.count(forSource: "dsh-a"), 1)
        XCTAssertEqual(book.lease(forTab: "tab-1"), "L1")
    }

    func testMintRejectsDuplicateTabAndLimits() {
        var book = BrowserGuestLeaseBook()
        book.limits = BrowserGuestLimits(perSource: 2, global: 3)
        _ = mint(&book, lease: "L1", tabId: "tab-1")
        XCTAssertEqual(mint(&book, lease: "L2", tabId: "tab-1").failureValue, .duplicateTab)
        _ = mint(&book, lease: "L2", tabId: "tab-2")
        XCTAssertEqual(mint(&book, lease: "L3", tabId: "tab-3").failureValue, .limitReached)
        // 另一来源仍受全局上限约束。
        XCTAssertEqual(mint(&book, lease: "L4", tabId: "tab-4", sourceId: "dsh-b").failureValue, .limitReached)
    }

    func testRemoveAndAuthorizeEnforceOwnership() {
        var book = BrowserGuestLeaseBook()
        _ = mint(&book)
        XCTAssertEqual(book.remove(lease: "L1", tabId: "tab-1", documentId: "doc-2").failureValue, .ownerMismatch)
        XCTAssertEqual(book.remove(lease: "L1", tabId: "tab-9", documentId: "doc-1").failureValue, .tabMismatch)
        XCTAssertEqual(book.remove(lease: "nope", tabId: "tab-1", documentId: "doc-1").failureValue, .unknownLease)
        XCTAssertEqual(book.authorized(lease: "L1", tabId: "tab-1", documentId: "doc-2").failureValue, .ownerMismatch)
        XCTAssertEqual(try? book.remove(lease: "L1", tabId: "tab-1", documentId: "doc-1").get().lease, "L1")
        XCTAssertTrue(book.entries.isEmpty)
    }

    func testReleaseAllByDocumentAndSource() {
        var book = BrowserGuestLeaseBook()
        _ = mint(&book, lease: "L1", tabId: "tab-1", documentId: "doc-1")
        _ = mint(&book, lease: "L2", tabId: "tab-2", documentId: "doc-1")
        _ = mint(&book, lease: "L3", tabId: "tab-3", documentId: "doc-2")
        XCTAssertEqual(book.removeAll(documentId: "doc-1").count, 2)
        XCTAssertEqual(book.entries.count, 1)
        XCTAssertEqual(book.retire(sourceId: "dsh-a").count, 1)
        XCTAssertTrue(book.entries.isEmpty)
        XCTAssertTrue(book.retire(sourceId: "dsh-a").isEmpty)
    }

    // MARK: - 通道常量（与 E1 生成物逐字锁步）

    func testBrowserIPCChannelNames() {
        XCTAssertEqual(BrowserIPCChannel.invokeChannels, [
            "dsh-chamber:browser-acquire", "dsh-chamber:browser-release",
            "dsh-chamber:browser-navigate", "dsh-chamber:browser-command",
            "dsh-chamber:browser-frame", "dsh-chamber:browser-keymap"
        ])
        XCTAssertEqual(BrowserIPCChannel.pushChannels, [
            "dsh-chamber:browser-state", "dsh-chamber:browser-open-requested",
            "dsh-chamber:browser-input", "dsh-chamber:browser-forward-needed"
        ])
        // E1 生成物是单源：本集合必须已是 manifest 的子集（E1 重生成后恒成立）。
        XCTAssertTrue(BrowserIPCChannel.invokeChannels.isSubset(of: BridgeManifest.invokeChannels))
        XCTAssertTrue(BrowserIPCChannel.pushChannels.isSubset(of: BridgeManifest.pushChannels))
    }

    // MARK: - 载荷编解码

    func testAcquirePayloadDecoding() {
        let payload: AnyCodable = .object([
            "tabId": .string("t1"), "sessionId": .string("s1"),
            "sourceId": .string("dsh-a"), "sourceFingerprint": .string("fp"),
            "workspaceKey": .string("cwd:/w"),
            "frame": .object(["x": .number(1), "y": .number(2),
                              "width": .number(300), "height": .number(200)]),
            "visible": .bool(true), "occluded": .bool(false)
        ])
        let request = BrowserIPCPayload.acquireRequest(payload)
        XCTAssertEqual(request?.tabId, "t1")
        XCTAssertEqual(request?.frame, BrowserGuestFrame(x: 1, y: 2, width: 300, height: 200))
        XCTAssertEqual(request?.visible, true)
        // 缺字段 / 负宽 / 超限 → nil（fail-closed）。
        XCTAssertNil(BrowserIPCPayload.acquireRequest(.object(["tabId": .string("t1")])))
        XCTAssertNil(BrowserIPCPayload.acquireRequest(.object([
            "tabId": .string("t1"), "sessionId": .string("s1"), "sourceId": .string("dsh-a"),
            "sourceFingerprint": .string("fp"), "workspaceKey": .string("w"),
            "frame": .object(["x": .number(0), "y": .number(0),
                              "width": .number(-1), "height": .number(10)])
        ])))
    }

    func testNavigateTargetDecoding() {
        // P0：forward 目标只接受 recordId+path；**带 url 一律拒绝**（旧契约退役）。
        XCTAssertEqual(BrowserIPCPayload.navigateTarget(.object([
            "kind": .string("forward"), "recordId": .string("fwd-1"), "path": .string("/api")
        ])), .forward(recordId: "fwd-1", path: "/api"))
        XCTAssertNil(BrowserIPCPayload.navigateTarget(.object([
            "kind": .string("forward"), "recordId": .string("fwd-1"),
            "path": .string("/a"), "url": .string("http://127.0.0.7:1/a")
        ])))
        XCTAssertNil(BrowserIPCPayload.navigateTarget(.object([
            "kind": .string("forward"), "recordId": .string("fwd-1"), "path": .string("https://evil/x")
        ])))
        XCTAssertEqual(BrowserIPCPayload.navigateTarget(.object([
            "kind": .string("direct"), "url": .string("https://example.com/a")
        ])), .direct(URL(string: "https://example.com/a")!))
        XCTAssertNil(BrowserIPCPayload.navigateTarget(.object([
            "kind": .string("direct"), "url": .string("file:///etc/passwd")
        ])))
        XCTAssertNil(BrowserIPCPayload.navigateTarget(.object([
            "kind": .string("direct"), "url": .string("http://u:p@example.com/")
        ])))
    }

    func testKeymapRequiresLeaseAndBoundedTable() {
        // 缺 lease（越租面）→ nil。
        XCTAssertNil(BrowserIPCPayload.keymap(.object([
            "tabId": .string("t1"),
            "combos": .array([.object(["code": .string("KeyT"), "primary": .bool(true)])])
        ])))
        // 合法：lease + 白名单形状 code。
        let ok = BrowserIPCPayload.keymap(.object([
            "tabId": .string("t1"), "lease": .string("L1"),
            "combos": .array([.object(["code": .string("KeyT"), "primary": .bool(true)])])
        ]))
        XCTAssertEqual(ok?.lease, "L1")
        XCTAssertEqual(ok?.combos.first?.code, "KeyT")
        // 非法 code / 超长表 → nil。
        XCTAssertNil(BrowserIPCPayload.keymap(.object([
            "tabId": .string("t1"), "lease": .string("L1"),
            "combos": .array([.object(["code": .string("Back T")])])
        ])))
        let many = (0...256).map { _ in AnyCodable.object(["code": .string("KeyA")]) }
        XCTAssertNil(BrowserIPCPayload.keymap(.object([
            "tabId": .string("t1"), "lease": .string("L1"), "combos": .array(many)
        ])))
        XCTAssertTrue(BrowserIPCPayload.isValidComboCode("ArrowLeft"))
        XCTAssertFalse(BrowserIPCPayload.isValidComboCode("Cmd+T"))
        XCTAssertFalse(BrowserIPCPayload.isValidComboCode(""))
    }

    func testInputPayloadUsesModifiersArray() {
        // V3-C P0/P1：design 28:89 / renderer 消费 modifiers: string[]。
        let payload = BrowserIPCPayload.inputPayload(
            tabId: "t1",
            stroke: BrowserKeyStroke(code: "KeyT", primary: true, alt: false, shift: true,
                                     control: false, isRepeat: false))
        guard case .object(let fields) = payload, case .array(let modifiers)? = fields["modifiers"] else {
            return XCTFail("input payload must carry modifiers array")
        }
        XCTAssertEqual(modifiers, [.string("meta"), .string("shift")])
        // INC-01：control 的 canonical 名是 "control"（不是 "ctrl"）。
        let ctrl = BrowserIPCPayload.inputPayload(
            tabId: "t", stroke: BrowserKeyStroke(code: "KeyA", primary: false, alt: false,
                                                 shift: false, control: true, isRepeat: false))
        guard case .object(let ctrlFields) = ctrl, case .array(let ctrlMods)? = ctrlFields["modifiers"] else {
            return XCTFail("ctrl input payload must carry modifiers array")
        }
        XCTAssertEqual(ctrlMods, [.string("control")])
        XCTAssertEqual(fields["code"], .string("KeyT"))
        XCTAssertNil(fields["primary"])   // 旧布尔形状必须消失
        XCTAssertEqual(fields["repeat"], .bool(false))
    }

    func testOpenRequestedPayloadCarriesLease() {
        guard case .object(let fields) = BrowserIPCPayload.openRequestedPayload(
            tabId: "t1", lease: "L1", url: "https://example.com/") else {
            return XCTFail("openRequested payload must be an object")
        }
        XCTAssertEqual(fields["lease"], .string("L1"))
        XCTAssertEqual(fields["url"], .string("https://example.com/"))
    }

    func testForwardNeededPayloadCarriesLease() {
        guard case .object(let fields) = BrowserIPCPayload.forwardNeededPayload(
            tabId: "t1", lease: "L1", url: "http://127.0.0.1:3000/") else {
            return XCTFail("forward-needed payload must be an object")
        }
        XCTAssertEqual(fields["lease"], .string("L1"))
        XCTAssertEqual(fields["tabId"], .string("t1"))
    }

    func testStateAndPushPayloadShapes() {
        let state = BrowserGuestStatePayload(tabId: "t1", lease: "L1", url: "https://example.com/",
                                             title: "Example", canGoBack: true, canGoForward: false,
                                             loading: false, error: nil)
        guard case .object(let fields) = BrowserIPCPayload.statePayload(state) else {
            return XCTFail("state payload must be an object")
        }
        XCTAssertEqual(fields["address"], .string("observed"))
        XCTAssertEqual(fields["error"], .null)
        XCTAssertEqual(fields["canGoBack"], .bool(true))
        let failed = BrowserGuestStatePayload(tabId: "t1", lease: "L1", url: nil, title: nil,
                                              canGoBack: false, canGoForward: false, loading: false,
                                              error: BrowserGuestFailureProjection(code: -1202, description: "cert"))
        guard case .object(let failedFields) = BrowserIPCPayload.statePayload(failed) else {
            return XCTFail("state payload must be an object")
        }
        XCTAssertEqual(failedFields["error"],
                       .object(["code": .number(-1202), "description": .string("cert")]))
        // INC-02/R-08：nil url/title 不发 .null（省略键）。
        XCTAssertNil(failedFields["url"])
        XCTAssertNil(failedFields["title"])
        guard case .object(let input) = BrowserIPCPayload.inputPayload(
            tabId: "t1", stroke: BrowserKeyStroke(code: "KeyT", primary: true, alt: false,
                                                 shift: false, control: false, isRepeat: false)) else {
            return XCTFail("input payload must be an object")
        }
        XCTAssertEqual(input["code"], .string("KeyT"))
        // N-01：与 testInputPayloadUsesModifiersArray 一致——旧布尔形状必须消失。
        XCTAssertNil(input["primary"])
        guard case .array(let mods)? = input["modifiers"] else {
            return XCTFail("input payload must carry modifiers array")
        }
        XCTAssertEqual(mods, [.string("meta")])
    }
}

private extension Result where Failure == BrowserGuestFailure {
    var failureValue: BrowserGuestFailure? {
        if case .failure(let failure) = self { return failure }
        return nil
    }
}
