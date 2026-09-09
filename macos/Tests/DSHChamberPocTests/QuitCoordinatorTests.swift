//
//  QuitCoordinatorTests.swift — E1/E9/E20 纯逻辑片（design 25 §5）
//
//  覆盖：`__host.quitFacts` 决策解码（形状严格 / 非法 → nil 保守路径）、
//  关窗动作映射、确认文案（main.ts before-quit 逐字）、退出单飞/确认门
//  （QuitGate 状态迁移）。AppKit 执行面（orderOut / NSAlert / terminate 链）
//  属实机门禁，不在单测范围。
import XCTest
@testable import DSHChamberPoc

final class QuitCoordinatorTests: XCTestCase {

    private func factsValue(
        hideOnClose: AnyCodable = .bool(true),
        needsConfirm: AnyCodable = .bool(false),
        reasons: AnyCodable = .array([])
    ) -> AnyCodable {
        .object([
            "hideOnClose": hideOnClose,
            "quitNeedsConfirm": needsConfirm,
            "quitReasons": reasons,
        ])
    }

    func testDecodeValidPayload() {
        let facts = QuitFacts.decode(factsValue(
            hideOnClose: .bool(false),
            needsConfirm: .bool(true),
            reasons: .array([.string("正在运行的本地 dsh 实例")])))
        XCTAssertEqual(facts, QuitFacts(
            hideOnClose: false,
            quitNeedsConfirm: true,
            quitReasons: ["正在运行的本地 dsh 实例"]))
    }

    func testDecodeRejectsMalformedPayload() {
        XCTAssertNil(QuitFacts.decode(nil))
        XCTAssertNil(QuitFacts.decode(.null))
        XCTAssertNil(QuitFacts.decode(.string("nope")))
        XCTAssertNil(QuitFacts.decode(.object([:])))
        XCTAssertNil(QuitFacts.decode(factsValue(hideOnClose: .string("yes"))))
        XCTAssertNil(QuitFacts.decode(factsValue(needsConfirm: .number(1))))
        // 缺 quitReasons 可容忍（默认空）；非字符串条目被过滤。
        XCTAssertEqual(
            QuitFacts.decode(.object([
                "hideOnClose": .bool(true),
                "quitNeedsConfirm": .bool(false),
            ])),
            QuitFacts(hideOnClose: true, quitNeedsConfirm: false, quitReasons: []))
        XCTAssertEqual(
            QuitFacts.decode(factsValue(reasons: .array([.string("a"), .number(1), .bool(true)])))?.quitReasons,
            ["a"])
    }

    func testCloseActionMapping() {
        XCTAssertEqual(
            QuitCoordinator.closeAction(facts: .init(hideOnClose: true, quitNeedsConfirm: false, quitReasons: [])),
            .hide)
        XCTAssertEqual(
            QuitCoordinator.closeAction(facts: .init(hideOnClose: false, quitNeedsConfirm: true, quitReasons: ["x"])),
            .terminate)
    }

    func testConfirmDetailMatchesElectronWording() {
        // main.ts before-quit：`退出将停止${risk.reasons.join('与')}。确定退出？`
        XCTAssertEqual(
            QuitCoordinator.confirmDetail(reasons: ["正在运行的本地 dsh 实例"]),
            "退出将停止正在运行的本地 dsh 实例。确定退出？")
        XCTAssertEqual(
            QuitCoordinator.confirmDetail(reasons: ["A", "B"]),
            "退出将停止A与B。确定退出？")
        XCTAssertEqual(QuitCoordinator.confirmDetail(reasons: []), "退出将停止。确定退出？")
    }

    // MARK: - QuitGate

    func testGateSingleFlightDecision() {
        let gate = QuitGate()
        XCTAssertTrue(gate.beginDecision())
        XCTAssertFalse(gate.beginDecision(), "决策在途时重复请求必须被挡")
        gate.endDecision()
        XCTAssertTrue(gate.beginDecision(), "结束决策后可再次发起")
        gate.endDecision()
    }

    func testGateConfirmSingleFlightAndConfirmedTerminal() {
        let gate = QuitGate()
        XCTAssertTrue(gate.beginConfirm())
        XCTAssertFalse(gate.beginConfirm())
        gate.endConfirm()
        XCTAssertFalse(gate.isConfirmed)
        gate.markConfirmed()
        XCTAssertTrue(gate.isConfirmed)
        XCTAssertFalse(gate.beginDecision(), "已确认后不再重新决策")
        XCTAssertFalse(gate.beginConfirm(), "已确认后不再弹确认")
        gate.reset()
        XCTAssertFalse(gate.isConfirmed)
        XCTAssertTrue(gate.beginDecision())
        gate.endDecision()
    }

    func testGateDecisionBlocksWhileConfirming() {
        let gate = QuitGate()
        XCTAssertTrue(gate.beginConfirm())
        XCTAssertFalse(gate.beginDecision(), "确认对话框在途时不得并行决策")
        gate.endConfirm()
        XCTAssertTrue(gate.beginDecision())
        gate.endDecision()
    }
}
