//
//  AppUpdaterTests.swift
//  DSHChamberPocTests
//
//  S-01 / 2026-12 裁决「D-1 选 B」：原生壳的应用内更新器（Sparkle 2）装配判据、
//  App 菜单面与两条 edge 腿。GUI/网络腿（真实 appcast、Sparkle 窗口、安装）属实机
//  验收，单测只钉判据与诚实降级。
//
import XCTest
@testable import DSHChamberPoc

final class AppUpdaterTests: XCTestCase {
    func testConfigurationRequiresBothFeedAndPublicKey() {
        XCTAssertNil(AppUpdater.configuration(from: [:]))
        XCTAssertNil(AppUpdater.configuration(from: ["SUFeedURL": "https://x/appcast.xml"]),
                     "只有 feed 不算配置")
        XCTAssertNil(AppUpdater.configuration(from: ["SUPublicEDKey": "abc="]),
                     "只有公钥不算配置")
        XCTAssertNil(AppUpdater.configuration(from: ["SUFeedURL": "", "SUPublicEDKey": "abc="]))
        XCTAssertNil(AppUpdater.configuration(from: ["SUFeedURL": "   ", "SUPublicEDKey": "abc="]),
                     "空白 feed 视为未配置（装配模板的空串占位）")
        XCTAssertNil(AppUpdater.configuration(from: ["SUFeedURL": "https://x/a.xml", "SUPublicEDKey": "  "]))
    }

    func testConfigurationParsesAutomaticChecksAndInterval() {
        let config = AppUpdater.configuration(from: [
            "SUFeedURL": "https://example.com/appcast-swift.xml",
            "SUPublicEDKey": "abc=",
            "SUEnableAutomaticChecks": true,
            "SUScheduledCheckInterval": NSNumber(value: 21600),
        ])
        XCTAssertEqual(config?.feedURL, "https://example.com/appcast-swift.xml")
        XCTAssertEqual(config?.publicKey, "abc=")
        XCTAssertEqual(config?.automaticChecks, true)
        XCTAssertEqual(config?.checkInterval, 21600)
        // 缺省：自动检查关（未发布/ad-hoc 装配启动即弹窗会与启动期窗口竞争）。
        let bare = AppUpdater.configuration(from: [
            "SUFeedURL": "https://example.com/appcast-swift.xml",
            "SUPublicEDKey": "abc=",
        ])
        XCTAssertEqual(bare?.automaticChecks, false)
        XCTAssertNil(bare?.checkInterval)
    }

    func testUpdaterStaysUnavailableWithoutConfiguration() {
        // 测试宿主 Info.plist 没有 Sparkle 键：装配必须被拒（绝不谎称能更新）。
        XCTAssertFalse(AppUpdater.shared.start(info: [:], startUpdater: false))
        XCTAssertFalse(AppUpdater.shared.isAvailable)
        XCTAssertFalse(AppUpdater.shared.canCheckForUpdates)
        XCTAssertNil(AppUpdater.shared.configuration)
        // 未装配时用户发起检查是 no-op（不得崩溃、不得假装已检查）。
        AppUpdater.shared.checkForUpdates(nil)
    }

    func testMainMenuCarriesCheckForUpdatesItem() {
        let menu = AppDelegate.makeMainMenu()
        let appItems = menu.items.first?.submenu?.items ?? []
        let item = appItems.first { $0.action == #selector(AppUpdater.checkForUpdates(_:)) }
        XCTAssertNotNil(item, "App 菜单需有「检查更新…」（macOS 标准位置：关于之后）")
        XCTAssertEqual(item?.title, "检查更新…")
        XCTAssertFalse(item?.isEnabled ?? true, "未配置 feed/公钥时必须禁用")
        let aboutIndex = appItems.firstIndex { $0.action == #selector(NSApplication.orderFrontStandardAboutPanel(_:)) }
        let updateIndex = appItems.firstIndex(of: item ?? NSMenuItem())
        if let aboutIndex, let updateIndex {
            XCTAssertLessThan(aboutIndex, updateIndex, "「检查更新…」在「关于」之后")
        }
    }

    func testUpdateEdgeLegsReportCapabilityAndRefuseWithoutUpdater() {
        let legs = SwiftEdgeHostLegs()
        let capability = legs.respond(method: "updateNativeCapability", payload: nil)
        XCTAssertNil(capability.error)
        if case .object(let dict)? = capability.result, case .bool(let available)? = dict["available"] {
            XCTAssertFalse(available,
                           "未装配 → sidecar 必须看到 available=false（保持 blocked-available）")
        } else {
            XCTFail("updateNativeCapability 必须回 {available: bool}（实际 \(String(describing: capability.result))）")
        }

        let action = legs.respond(method: "updateNativeAction",
                                  payload: .object(["kind": .string("install")]))
        XCTAssertNil(action.result)
        XCTAssertEqual(action.error, "native-updater-unavailable",
                       "无更新器时页面按钮拿到显式错误，不得假成功")
    }
}
