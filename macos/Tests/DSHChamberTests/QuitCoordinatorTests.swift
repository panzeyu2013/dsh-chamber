//
//  QuitCoordinatorTests.swift — E1/E9/E20 纯逻辑片（design 25 §5）
//
//  覆盖：`__host.quitFacts` 决策解码（形状严格 / 非法 → nil 保守路径）、
//  关窗动作映射、确认文案（main.ts before-quit 逐字）、退出单飞/确认门
//  （QuitGate 状态迁移）、退出确认框的 Enter/Esc 按键语义（S-43：真实
//  runModal + 合成按键，无需人工交互，5s 兜底防挂死）。其余 AppKit 执行面
//  （orderOut / terminate 链）属实机门禁，不在单测范围。
import XCTest
@testable import DSHChamber

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

    // MARK: - S-17：决策不可得（超时/无应答）

    /// 超时/无应答且 sidecar 仍在运行 → 绝不静默取消：必须走提示分支；
    /// sidecar 已停（无本地保护内容）→ 放行（main.ts cp===null 同向）。
    func testUnavailableActionDecisionSeam() {
        XCTAssertEqual(QuitCoordinator.unavailableAction(sidecarLive: true), .alertThenCancel)
        XCTAssertEqual(QuitCoordinator.unavailableAction(sidecarLive: false), .proceed)
    }

    /// 提示框给出两个选择：默认安全项「继续等待」与「强制退出」；文案须说明
    /// sidecar 未应答且本次退出已取消。
    func testUnavailableAlertOffersWaitAndForce() {
        XCTAssertEqual(QuitCoordinator.UnavailableAlert.waitButtonTitle, "继续等待")
        XCTAssertEqual(QuitCoordinator.UnavailableAlert.forceButtonTitle, "强制退出")
        XCTAssertTrue(QuitCoordinator.UnavailableAlert.messageText.contains("sidecar"))
        XCTAssertTrue(QuitCoordinator.UnavailableAlert.informativeText.contains("2 秒"))
        XCTAssertTrue(QuitCoordinator.UnavailableAlert.informativeText.contains("取消"))
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
    }

    /// 已确认 = 终态：新 gate 才是新退出会话的起点（S14 删除了无生产调用者的
    /// QuitGate.reset；测试以新实例表达「下次会话」，不再驱动 reset）。
    func testFreshGateStartsUnconfirmedAndAcceptsBothRegimes() {
        let gate = QuitGate()
        XCTAssertFalse(gate.isConfirmed)
        XCTAssertTrue(gate.beginDecision())
        gate.endDecision()
        XCTAssertTrue(gate.beginConfirm())
        gate.endConfirm()
    }

    func testGateDecisionBlocksWhileConfirming() {
        let gate = QuitGate()
        XCTAssertTrue(gate.beginConfirm())
        XCTAssertFalse(gate.beginDecision(), "确认对话框在途时不得并行决策")
        gate.endConfirm()
        XCTAssertTrue(gate.beginDecision())
        gate.endDecision()
    }

    // MARK: - S-43：退出确认框的按键语义（Enter/Esc 都命中安全项「取消」）

    /// 与 presentQuitConfirmation 同构：[退出] + [取消(\r)]（defaultId=1）。
    private static func twoButtonQuitAlert() -> NSAlert {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "退出 dsh-chamber？"
        alert.addButton(withTitle: "退出")
        let cancel = alert.addButton(withTitle: "取消")
        cancel.keyEquivalent = "\r"
        return alert
    }

    /// 合成 keyDown 投递（keyCode 53 = Esc；36 = Return）。
    private static func postKey(code: UInt16, characters: String, windowNumber: Int) {
        guard let event = NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: windowNumber, context: nil, characters: characters,
            charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code) else {
            return XCTFail("无法构造 keyDown 事件")
        }
        NSApplication.shared.postEvent(event, atStart: false)
    }

    /// 跑真实 runModal（无人工交互）：先投一个中性键（x，必须原样放行、不结束
    /// 模态），再投 Esc；5s 兜底 stopModal(third) 防回归挂死。Esc 必须返回第二
    /// 按钮 = 安全项「取消」（Electron cancelId=1）。
    func testQuitConfirmationEscapeReturnsCancelResponse() {
        let alert = Self.twoButtonQuitAlert()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            Self.postKey(code: 7, characters: "x", windowNumber: alert.window.windowNumber)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            Self.postKey(code: 53, characters: "\u{1b}", windowNumber: alert.window.windowNumber)
        }
        let failsafe = DispatchWorkItem {
            NSApplication.shared.stopModal(withCode: .alertThirdButtonReturn)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: failsafe)
        let response = AppDelegate.runQuitConfirmationAlert(alert)
        failsafe.cancel()
        XCTAssertEqual(response, .alertSecondButtonReturn,
                       "Esc 必须命中安全项「取消」（Electron cancelId=1）")
    }

    /// Enter 同样命中安全项「取消」（Electron defaultId=1）——模态期 NSAlert 的
    /// 默认键解析不可靠，故与 Esc 同由监视器映射，测试钉住该语义。
    func testQuitConfirmationReturnReturnsCancelResponse() {
        let alert = Self.twoButtonQuitAlert()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            Self.postKey(code: 36, characters: "\r", windowNumber: alert.window.windowNumber)
        }
        let failsafe = DispatchWorkItem {
            NSApplication.shared.stopModal(withCode: .alertThirdButtonReturn)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: failsafe)
        let response = AppDelegate.runQuitConfirmationAlert(alert)
        failsafe.cancel()
        XCTAssertEqual(response, .alertSecondButtonReturn,
                       "Enter 必须命中「取消」（Electron defaultId=1）")
    }
}
