//
//  BrowserGuestKeyboardTests.swift — guest 快捷键桥纯逻辑单测（design 28 v3 §4.5）
//
import XCTest
@testable import DSHChamber

final class BrowserGuestKeyboardTests: XCTestCase {
    private func combo(_ code: String, primary: Bool = true) -> BrowserKeyboardCombo {
        BrowserKeyboardCombo(code: code, primary: primary, alt: false, shift: false, control: false)
    }

    private func stroke(_ code: String, primary: Bool = true) -> BrowserKeyStroke {
        BrowserKeyStroke(code: code, primary: primary, alt: false, shift: false, control: false, isRepeat: false)
    }

    func testDomCodeMapping() {
        XCTAssertEqual(KeyboardBridge.domCode(keyCode: 17, charactersIgnoringModifiers: "t"), "KeyT")
        XCTAssertEqual(KeyboardBridge.domCode(keyCode: 13, charactersIgnoringModifiers: "w"), "KeyW")
        XCTAssertEqual(KeyboardBridge.domCode(keyCode: 0, charactersIgnoringModifiers: "a"), "KeyA")
        XCTAssertEqual(KeyboardBridge.domCode(keyCode: 123, charactersIgnoringModifiers: nil), "ArrowLeft")
        XCTAssertEqual(KeyboardBridge.domCode(keyCode: 51, charactersIgnoringModifiers: nil), "Backspace")
        // 字母/数字兜底（表外键码）。
        XCTAssertEqual(KeyboardBridge.domCode(keyCode: 999, charactersIgnoringModifiers: "Q"), "KeyQ")
        // 不可映射键（无字符、无表项）→ nil = pass-through。
        XCTAssertNil(KeyboardBridge.domCode(keyCode: 999, charactersIgnoringModifiers: nil))
        XCTAssertNil(KeyboardBridge.domCode(keyCode: 999, charactersIgnoringModifiers: "?"))
    }

    func testBindingMatchIsExact() {
        let combos: Set<BrowserKeyboardCombo> = [combo("KeyT"), combo("KeyW"), combo("KeyR", primary: false)]
        XCTAssertEqual(KeyboardBridge.matches(stroke: stroke("KeyT"), combos: combos), combo("KeyT"))
        XCTAssertEqual(KeyboardBridge.matches(stroke: stroke("KeyR", primary: false), combos: combos),
                       combo("KeyR", primary: false))
        // 修饰位不同 = 不命中（表外不消费）。
        XCTAssertNil(KeyboardBridge.matches(stroke: stroke("KeyT", primary: false), combos: combos))
        XCTAssertNil(KeyboardBridge.matches(stroke: stroke("KeyL"), combos: combos))
        XCTAssertNil(KeyboardBridge.matches(stroke: stroke("KeyT"), combos: []))
    }

    func testModifierBitsDistinguishBindings() {
        let ctrlT = BrowserKeyboardCombo(code: "KeyT", primary: false, alt: false, shift: false, control: true)
        let cmdT = combo("KeyT")
        XCTAssertNotEqual(ctrlT, cmdT)
        let strokeCtrl = BrowserKeyStroke(code: "KeyT", primary: false, alt: false,
                                          shift: false, control: true, isRepeat: false)
        XCTAssertEqual(KeyboardBridge.matches(stroke: strokeCtrl, combos: [cmdT, ctrlT]), ctrlT)
        XCTAssertNil(KeyboardBridge.matches(stroke: strokeCtrl, combos: [cmdT]))
    }
}

// MARK: - E4c 焦点门（firstResponder 必须是活动 guest）

extension BrowserGuestKeyboardTests {
    private func tab(_ combos: Set<BrowserKeyboardCombo>) -> Set<BrowserKeyboardCombo> { combos }

    func testFocusGateBlocksWhenShellPageFocused() {
        // 回归：即使键位表命中、activeTabId 存在，只要 firstResponder 不在 guest 上，
        // 必须 pass-through（此前 bug：壳页输入 Cmd+T 会被吞）。
        XCTAssertNil(KeyboardBridge.consumeDecision(activeTabId: "t1", guestFocused: false,
                                                    stroke: stroke("KeyT"), combos: tab([combo("KeyT")])))
    }

    func testFocusGateConsumesOnlyWhenGuestFocused() {
        XCTAssertEqual(KeyboardBridge.consumeDecision(activeTabId: "t1", guestFocused: true,
                                                      stroke: stroke("KeyT"),
                                                      combos: tab([combo("KeyT")]))?.tabId, "t1")
        XCTAssertEqual(KeyboardBridge.consumeDecision(activeTabId: "t1", guestFocused: true,
                                                      stroke: stroke("KeyT"),
                                                      combos: tab([combo("KeyT")]))?.combo, combo("KeyT"))
    }

    func testGateRequiresActiveTabAndBinding() {
        XCTAssertNil(KeyboardBridge.consumeDecision(activeTabId: nil, guestFocused: true,
                                                    stroke: stroke("KeyT"), combos: tab([combo("KeyT")])))
        XCTAssertNil(KeyboardBridge.consumeDecision(activeTabId: "t1", guestFocused: true,
                                                    stroke: stroke("KeyT"), combos: nil))
        XCTAssertNil(KeyboardBridge.consumeDecision(activeTabId: "t1", guestFocused: true,
                                                    stroke: stroke("KeyT"), combos: tab([combo("KeyW")])))
        // 修饰位不同（无 primary）→ 不命中。
        XCTAssertNil(KeyboardBridge.consumeDecision(activeTabId: "t1", guestFocused: true,
                                                    stroke: stroke("KeyT", primary: false),
                                                    combos: tab([combo("KeyT")])))
    }
}

