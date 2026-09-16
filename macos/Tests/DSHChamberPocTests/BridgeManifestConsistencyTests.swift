//
//  BridgeManifestConsistencyTests.swift — W-18 Swift 白名单一致性测试
//  （design 25 §4.4.3；docs/progress/todo/macos-swift-v1.md W-18 行）。
//
//  职责边界：JS 侧一致性（重生成 JSON/Swift == 提交物、通道数守恒、无死键）
//  由 packages/desktop/bridge-manifest.test.ts 保证；本测试钉 Swift 生成物
//  （编译接线后的白名单真值）——防提交的 BridgeManifest.swift 被手工改坏/
//  漂移后 swift test 仍静默全绿：
//    1. 通道数守恒：invoke 60 / push 8 / allChannels 68（68 = 60 + 8）；
//    2. 方向无交集：invoke ∩ push = ∅，allChannels == invoke ∪ push（推导面）；
//    3. invoke 方向抽样：dsh-chamber:info / desktop_ssh_instances_get /
//       desktop_ssh_connect 属 invoke 面（main 侧 handle 注册事实）；
//    4. push 精确 golden 8：逐条转录自提交物 packages/desktop/bridge-manifest.json
//       的 push 数组（勿臆造）——通道增删必须同 PR 同步提交物与两侧测试
//       （bridge-manifest.test.ts 同款「同步是故意为之」纪律）。
//
//  生成物落位：macos/Sources/DSHChamberPoc/Generated/BridgeManifest.swift
//  （W-18 迁入 DSHChamberPoc target 内随编译接线；scripts/emit-bridge-manifest.mjs
//  产出，生成器头注释含重新生成命令与迁移说明）。
import XCTest
@testable import DSHChamberPoc

final class BridgeManifestConsistencyTests: XCTestCase {
    func testCountsInvokePushAll() {
        // 当前仓库事实（与 bridge-manifest.json 的 counts 及
        // bridge-manifest.test.ts ③ 同一批数字）；通道增删须同步更新。
        XCTAssertEqual(BridgeManifest.invokeChannels.count, 60, "invoke 通道数应 == 提交物 counts.invoke（60）")
        XCTAssertEqual(BridgeManifest.pushChannels.count, 8, "push 通道数应 == 提交物 counts.push（8）")
        XCTAssertEqual(
            BridgeManifest.allChannels.count, 68,
            "allChannels 应为 invoke ∪ push 并集且无交集（68 = 60 + 8）"
        )
    }

    func testInvokeAndPushDisjoint() {
        let overlap = BridgeManifest.invokeChannels.intersection(BridgeManifest.pushChannels)
        XCTAssertTrue(
            overlap.isEmpty,
            "invoke 与 push 不应有交集（同一通道不会既是 handle 又是推送面）：\(overlap.sorted())"
        )
    }

    func testAllChannelsIsUnionOfInvokeAndPush() {
        XCTAssertEqual(
            BridgeManifest.allChannels,
            BridgeManifest.invokeChannels.union(BridgeManifest.pushChannels),
            "allChannels 必须 == invoke ∪ push（推导面，防手工第三份字面量漂移）"
        )
    }

    func testInvokeDirectionSamples() {
        // 抽样：main 侧 handle 注册事实的代表（桥面/连接管理/运行时三族）。
        for channel in ["dsh-chamber:info", "desktop_ssh_instances_get", "desktop_ssh_connect"] {
            XCTAssertTrue(
                BridgeManifest.invokeChannels.contains(channel),
                "通道 \(channel) 应属 invoke 面（main 侧 handle 注册）"
            )
            XCTAssertFalse(
                BridgeManifest.pushChannels.contains(channel),
                "invoke 抽样通道 \(channel) 不应出现在 push 面"
            )
        }
    }

    func testPushChannelsExactlyGoldenEight() {
        // golden 精确集：转录自提交物 packages/desktop/bridge-manifest.json 的
        // push 数组（8 条，按 JSON 定义序）——与 main 侧 8 处推送注册点一一对应。
        let golden: Set<String> = [
            "dsh-chamber:settings-changed",
            "dsh-chamber:notification-open",
            "dsh-chamber:update-state-changed",
            "dsh-chamber:deep-link-intent",
            "dsh-chamber:system-resume",
            "desktop_ssh_status_changed",
            "desktop_ssh_instances_changed",
            "dsh-chamber:runtime-state-changed",
        ]
        XCTAssertEqual(
            BridgeManifest.pushChannels, golden,
            "push 通道集必须 == 提交物 push 数组的精确 8 集（多/少/改名都算漂移）"
        )
    }
}
