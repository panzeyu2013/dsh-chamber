/**
 * P1.3（台账 §8.a）：Swift 更新可用性的单一显式判据 —— 上游
 * isPackaged && app-update.yml 的等价物。这里只测纯函数（装配期事实 → 原因词），
 * 运行期接线（capability / 动作拒绝 / 页面）由 AppUpdaterTests 覆盖。
 */
import XCTest
@testable import DSHChamber

final class UpdateAvailabilityTests: XCTestCase {
    private let validFeed = "https://example.com/appcast.xml"
    /// base64("0123456789abcdef0123456789abcdef") = 32 字节。
    private let validKey = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="

    private func configuration(feed: String? = nil, key: String? = nil) -> AppUpdater.Configuration {
        AppUpdater.Configuration(feedURL: feed ?? validFeed, publicKey: key ?? validKey,
                                 automaticChecks: true, checkInterval: 600)
    }

    func testAvailableOnlyWhenConfiguredAndStarted() {
        XCTAssertNil(AppUpdater.availabilityRefusal(configuration: configuration(),
                                                    startError: nil, started: true),
                     "配置形状合法 + 真的启动 = 可用")
    }

    func testUnconfiguredIsUnavailable() {
        XCTAssertEqual(AppUpdater.availabilityRefusal(configuration: nil, startError: nil, started: false),
                       "native-updater-unavailable")
    }

    func testNotStartedIsUnavailable() {
        XCTAssertEqual(AppUpdater.availabilityRefusal(configuration: configuration(),
                                                      startError: nil, started: false),
                       "native-updater-unavailable",
                       "配置齐但未启动不得谎报可用")
    }

    func testBadShapeCarriesTheConfigurationReason() {
        let badKey = AppUpdater.availabilityRefusal(configuration: configuration(key: "AAAA"),
                                                    startError: nil, started: true)
        XCTAssertEqual(badKey?.hasPrefix("native-updater-misconfigured:"), true, "坏形状必须带 misconfigured 前缀")
        XCTAssertEqual(badKey?.contains("SUPublicEDKey"), true, "原因必须指向具体键")
        let badFeed = AppUpdater.availabilityRefusal(
            configuration: configuration(feed: "http://example.com/appcast.xml"),
            startError: nil, started: true)
        XCTAssertEqual(badFeed?.contains("SUFeedURL"), true, "明文 feed 必须被拒且指向 SUFeedURL")
    }

    func testStartErrorWinsOverShapeAndCarriesItsOwnText() {
        let refusal = AppUpdater.availabilityRefusal(configuration: configuration(),
                                                     startError: "XPC 连接失败", started: false)
        XCTAssertEqual(refusal, "native-updater-misconfigured:XPC 连接失败")
    }
}
