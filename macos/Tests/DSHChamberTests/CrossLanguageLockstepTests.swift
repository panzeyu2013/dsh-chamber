//
//  CrossLanguageLockstepTests.swift
//  DSHChamberTests
//
//  Swift 侧与 TS 侧必须逐值相等的常量锁步（读 TS 源文本；改一侧必须
//  同步另一侧）。数值单源在 TS（main.ts / shell-core.ts / sidecar-entry.ts），
//  Swift 是镜像——沿用 RendererRecoveryTests 的 #filePath 读源模式。
//
import XCTest
@testable import DSHChamber

final class CrossLanguageLockstepTests: XCTestCase {

    /// B 桥**出站**帧上限必须与入站同源常量，且 writeProtocolLine
    /// 真的读它。出站无上限时：一个 >4 MiB 的结果帧会先把 Swift 侧 LineReader 推入
    /// 溢出重同步并 fail-closed 作废该会话全部未决请求（BridgeClient.processStdoutOutcome）。
    func testSidecarOutboundFrameLimitIsLockstep() throws {
        let edges = try source("packages/desktop/node-edges.ts")
        let entry = try source("packages/desktop/sidecar-entry.ts")
        XCTAssertNotNil(edges.range(of: "export const MAX_PROTOCOL_FRAME_BYTES = 4 * 1024 * 1024"),
                        "node-edges.ts 必须定义双向协议帧上限常量（4 MiB）")
        XCTAssertNotNil(edges.range(of: "export const MAX_INBOUND_FRAME_BYTES = MAX_PROTOCOL_FRAME_BYTES"),
                        "入站别名必须与协议常量同源（不得各自写字面量）")
        XCTAssertEqual(FrameCodec.maxFrameBytes, 4 * 1024 * 1024,
                       "Swift 侧上限必须仍是 4 MiB（锁步同一护栏）")
        // 函数体按花括号/首个顶层 } 收紧（通用 functionBody 会抽到下一个
        // 顶层 function，423 行的弱锚能被注释里的常量名满足）。
        guard let start = entry.range(of: "function writeProtocolLine(") else {
            return XCTFail("sidecar-entry.ts 必须保留 writeProtocolLine")
        }
        let tail = entry[start.lowerBound...]
        guard let end = tail.range(of: "\n}\n") else {
            return XCTFail("writeProtocolLine 必须以顶层 } 结束（锚点收紧失败）")
        }
        let body = String(tail[..<end.upperBound])
        XCTAssertNotNil(body.range(of: "lineBytes > MAX_PROTOCOL_FRAME_BYTES"),
                        "出站门必须按同源常量比较（精确表达式，注释不算）")
        XCTAssertNotNil(body.range(of: "line.length * 4 <= MAX_PROTOCOL_FRAME_BYTES"),
                        "快判谓词必须钉死（谓词写反会放过 >4 MiB 的多字节帧）")
        XCTAssertNotNil(body.range(of: "Buffer.byteLength(line, 'utf8')"),
                        "门必须按 UTF-8 字节数判定（与 Swift line.utf8.count 同口径）")
        XCTAssertNotNil(body.range(of: "sidecar-frame-too-large"),
                        "有 id 的超限帧必须回合法错误帧（调用方 reject，不得悬挂）")
    }

    /// #filePath = <repo>/macos/Tests/DSHChamberTests/CrossLanguageLockstepTests.swift
    private func repoRoot() -> URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOf: repoRoot().appendingPathComponent(relative), encoding: .utf8)
    }

    /// 取某顶层 function 到下一个顶层 function 之间的源文本。
    private func functionBody(_ text: String, named name: String) -> String? {
        guard let start = text.range(of: name) else { return nil }
        let rest = text[start.lowerBound...]
        let searchStart = rest.index(rest.startIndex, offsetBy: name.count)
        guard let end = rest.range(of: "\nfunction ",
                                   range: searchStart..<rest.endIndex) else {
            return String(rest)
        }
        return String(rest[..<end.lowerBound])
    }

    /// 渲染恢复的预算/门判定单源在 shell-core.ts 的
    /// 共享常量 + 纯函数（`noteRendererReload` / `shouldScheduleHangReload` /
    /// `shouldReloadAfterCrash`；main.ts 只留计时器 glue）——文本锚在
    /// shell-core 而不是 installRendererRecovery 体内，否则该文件假红且
    /// Electron 侧失去唯一文本钉。
    func testRendererRecoveryPolicyMatchesMainTs() throws {
        let mainText = try source("packages/desktop/main.ts")
        guard let body = functionBody(mainText, named: "function installRendererRecovery") else {
            return XCTFail("main.ts 缺少 installRendererRecovery")
        }
        // main.ts 只允许留 glue：预算记账/门判定必须调 shell-core 共享纯函数。
        for anchor in ["noteRendererReload(reloadBudget, Date.now())",
                       "RENDERER_CRASH_RELOAD_DELAY_MS",
                       "RENDERER_HANG_RELOAD_DELAY_MS",
                       "shouldScheduleHangReload(loadedOnce)",
                       "shouldReloadAfterCrash(details.reason, quitRequested)"] {
            XCTAssertTrue(body.contains(anchor), "installRendererRecovery 应含 glue 锚点：\(anchor)")
        }
        // 单源：500ms 崩溃延迟 / 15s 卡死延迟 / 60s 窗口 / ≤3 次。
        let coreText = try source("packages/desktop/shell-core.ts")
        for anchor in ["export const RENDERER_CRASH_RELOAD_DELAY_MS = 500;",
                       "export const RENDERER_HANG_RELOAD_DELAY_MS = 15_000;",
                       "export const RENDERER_RECOVERY_WINDOW_MS = 60_000;",
                       "export const RENDERER_RECOVERY_MAX_RELOADS = 3;"] {
            XCTAssertTrue(coreText.contains(anchor), "shell-core 应含渲染恢复源锚点：\(anchor)")
        }
        let policy = RendererRecoveryPolicy()
        XCTAssertEqual(policy.delay * 1000, 500, "崩溃重载延迟 500ms")
        XCTAssertEqual(policy.window, 60, "滚动窗口 60s")
        XCTAssertEqual(policy.maxReloads, 3, "窗口内 ≤3 次重载")
    }

    func testExternalOpenBudgetMatchesShellCore() throws {
        let text = try source("packages/desktop/shell-core.ts")
        for anchor in ["const OPEN_EXTERNAL_BUDGET = 8",
                       "const OPEN_EXTERNAL_WINDOW_MS = 10_000",
                       "const OPEN_EXTERNAL_COOLDOWN_MS = 30_000"] {
            XCTAssertTrue(text.contains(anchor), "shell-core 应含源锚点：\(anchor)")
        }
        let budget = ExternalOpenBudget()
        XCTAssertEqual(budget.maxOpens, 8)
        XCTAssertEqual(budget.window, 10)
        XCTAssertEqual(budget.cooldown, 30)
    }

    func testFrameSizeLimitsShareOneValue() {
        XCTAssertEqual(TrustGuard.maxMessageBytes, 4 * 1024 * 1024)
        XCTAssertEqual(FrameCodec.maxFrameBytes, TrustGuard.maxMessageBytes,
                       "A 桥信封上限与 B 桥帧上限必须同值（4 MiB）")
    }

    /// 期望字面量从**两侧源码**读出：Electron
    /// （shell-core.ts 的 `QUIT_CLEANUP_TIMEOUT_MS = 5_000`）与 Swift
    /// （BridgeClient.swift 的 `quitCleanupGracePeriod: TimeInterval = 5.0`）；
    /// 先断言两侧字面量相等，再把两个 Swift 常量分别钉到这个共享字面量。
    func testQuitCleanupBudgetMatchesShellCore() throws {
        let tsText = try source("packages/desktop/shell-core.ts")
        guard let tsMatch = tsText.range(
            of: #"export const QUIT_CLEANUP_TIMEOUT_MS = ([\d_]+)"#,
            options: .regularExpression) else {
            return XCTFail("shell-core.ts 缺少 QUIT_CLEANUP_TIMEOUT_MS 字面量")
        }
        let tsLiteral = String(tsText[tsMatch])
            .components(separatedBy: "= ").last!
            .replacingOccurrences(of: "_", with: "")
        guard let tsSeconds = Double(tsLiteral).map({ $0 / 1000 }) else {
            return XCTFail("无法解析 shell-core 字面量：\(tsLiteral)")
        }

        let swiftText = try source("macos/Sources/DSHChamber/BridgeClient.swift")
        guard let swiftMatch = swiftText.range(
            of: #"quitCleanupGracePeriod: TimeInterval = ([\d.]+)"#,
            options: .regularExpression) else {
            return XCTFail("BridgeClient.swift 缺少 quitCleanupGracePeriod 字面量")
        }
        let swiftLiteral = String(swiftText[swiftMatch]).components(separatedBy: "= ").last!
        guard let swiftSeconds = Double(swiftLiteral) else {
            return XCTFail("无法解析 BridgeClient 字面量：\(swiftLiteral)")
        }

        XCTAssertEqual(swiftSeconds, tsSeconds,
                       "Swift SIGTERM 宽限字面量必须等于 shell-core 的 QUIT_CLEANUP_TIMEOUT_MS（S6）")
        XCTAssertEqual(BridgeClient.quitCleanupGracePeriod, swiftSeconds,
                       "编译出的宽限必须等于 Swift 源字面量")
        XCTAssertEqual(AppDelegate.quitCleanupTimeout, tsSeconds,
                       "terminate 硬顶必须等于共享预算字面量（G12：不得再拿它和 BridgeClient 自比）")
    }

    func testInteractiveEdgeTimeoutMatchesSidecarEntry() throws {
        let text = try source("packages/desktop/sidecar-entry.ts")
        XCTAssertTrue(text.contains("const EDGE_TIMEOUT_MS = 30_000"))
        // node 侧不与 Swift 同值（同值会让 node 恒先超时，用户 10 分钟后的
        // 答案被丢弃）——node = Swift 上限 + 60s 缓冲，Swift 侧仍是 600s。
        XCTAssertTrue(text.contains("const SWIFT_INTERACTIVE_LEG_TIMEOUT_MS = 600_000"),
                      "sidecar-entry 应镜像 Swift 侧 600000ms 交互腿上限")
        XCTAssertTrue(text.contains("const INTERACTIVE_EDGE_TIMEOUT_MS = SWIFT_INTERACTIVE_LEG_TIMEOUT_MS + 60_000"),
                      "node 侧交互腿等待上限 = Swift 上限 + 60s 缓冲（S2·F4）")
        XCTAssertEqual(SwiftEdgeHostLegs.interactiveLegTimeout * 1000, 600_000,
                       "Swift 交互腿上限保持 10 分钟（S1/S2·F4）")
        XCTAssertEqual(SwiftEdgeHostLegs.uiLegTimeout, 1.0, "非交互腿保持 1s 短界")
    }

    /// S16a：61 通道冒烟清单必须迭代生成物 BridgeManifest.invokeChannels，
    /// 不得再手工转录（原 80 行静态数组删除）。
    func testSmokeListReferencesGeneratedManifest() throws {
        let text = try source("macos/Tests/DSHChamberTests/BridgeClientEdgeIntegrationTests.swift")
        XCTAssertTrue(text.contains("BridgeManifest.invokeChannels"),
                      "冒烟清单应迭代 BridgeManifest.invokeChannels")
        XCTAssertFalse(text.contains("// SSH_INSTANCES_GET"),
                       "手工转录清单必须删除（S16a）")
    }

    // MARK: - 页面事实载波与 TS 帧语言常量锁步

    /// document 语言属性名的单源在 TS（locales.ts 的
    /// DOCUMENT_LANGUAGE_ATTRIBUTE），zh 族前缀规则也必须与 Swift
    /// ShellPageLanguage.resolve 逐值一致。注意两侧对 nil/空是有意分歧：
    /// TS 回落到 served markup 默认 zh（FALLBACK_FRAME_LOCALE），Swift 侧
    /// nil/空是「无事实」哨兵（由 ShellPageFactsStore 保留旧值）——本用例只钉
    /// 前缀规则与属性名，不钉该回落。
    func testPageFactsLanguageConstantAndZhFamilyLockstep() throws {
        let locales = try source("packages/renderer/src/locales.ts")
        XCTAssertTrue(locales.contains("export const DOCUMENT_LANGUAGE_ATTRIBUTE = 'lang'"),
                      "locales.ts 必须继续以 'lang' 作为 document 语言属性单源")
        XCTAssertTrue(locales.contains("if (tag === 'zh' || tag.startsWith('zh-') || tag.startsWith('zh_')) return 'zh'"),
                      "locales.ts 的 zh 族前缀规则必须保持（S3 锁步锚）")

        let script = ShellPageFactsScript.source()
        XCTAssertTrue(script.contains("documentElement.lang")
                      || script.contains("getAttribute('lang')")
                      || script.contains("getAttribute(\"lang\")"),
                      "Swift 事实脚本必须从 documentElement 的 lang 属性读语言")
        XCTAssertTrue(script.contains(ShellPageFactsScript.messageName),
                      "Swift 事实脚本的回包名必须与 messageName 一致")

        // zh 族前缀规则逐值锁步：zh / zh- / zh_ → zh；其余非空 → en。
        for tag in ["zh", "zh-CN", "zh-Hans", "zh-Hans-CN", "zh_CN", "zh-Hant-TW"] {
            XCTAssertEqual(ShellPageLanguage.resolve(lang: tag), .zh,
                           "TS zh 族 \(tag) 必须对应 Swift .zh")
        }
        for tag in ["en", "en-US", "ja", "fr", "zhx"] {
            XCTAssertEqual(ShellPageLanguage.resolve(lang: tag), .en,
                           "TS 非 zh 族 \(tag) 必须对应 Swift .en")
        }
    }

    /// 窗口拖拽契约锁步：Swift 注入脚本的标记属性与控件选择器必须与 TS 单源
    /// （packages/dsh-client-web/src/window-drag/regions.ts）逐值一致。两侧消费**同一批**
    /// 页面标记——Electron 走 base.css 的 app-region 盒，Swift 壳走 ShellWindowDrag 的
    /// mousedown 通道；选择器漂移会让「控件不拖」在其中一侧失效（按在按钮上会拖动整窗）。
    func testWindowDragMarkAndInteractiveSelectorLockstep() throws {
        let regions = try source("packages/dsh-client-web/src/window-drag/regions.ts")
        XCTAssertTrue(regions.contains("export const DRAG_MARK = 'data-window-drag'"),
                      "regions.ts 必须继续以 data-window-drag 为拖拽标记单源（DRAG_MARK）")
        XCTAssertEqual(ShellWindowDragScript.dragMarkAttribute, "data-window-drag",
                       "Swift 侧标记属性必须与 TS DRAG_MARK 逐字同值")
        XCTAssertTrue(regions.contains("export const RECALL_MARK = 'data-window-drag-recall'"),
                      "recall 脉冲标记的单源仍在 regions.ts")
        XCTAssertTrue(ShellWindowDragScript.source.contains("'data-window-drag-recall'"),
                      "Swift 脚本必须认识 recall 标记（它只表示 Electron 需重采集，不参与本侧判定）")

        // INTERACTIVE_SELECTOR 数组字面量 → 逐项（含顺序）比对。
        guard let start = regions.range(of: "export const INTERACTIVE_SELECTOR = ["),
              let end = regions.range(of: "].join(', ')",
                                      range: start.upperBound..<regions.endIndex) else {
            return XCTFail("regions.ts 必须保留 INTERACTIVE_SELECTOR = [...] .join(', ') 形状（锁步锚点）")
        }
        let entries = regions[start.upperBound..<end.lowerBound]
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "\"'")) }
        XCTAssertEqual(entries, ShellWindowDragScript.interactiveSelector,
                       "控件选择器必须逐项、同序一致（改一侧必须同步另一侧）")
        XCTAssertTrue(ShellWindowDragScript.source.contains(ShellWindowDragScript.interactiveSelectorJSON),
                      "注入源码下发的必须正是这份列表")
    }

    /// 窗口 vibrancy 契约锁步：Swift 壳的 shim 落 `data-window-vibrancy`，页面侧所有「让出
    /// 底色给窗后材质」的 darwin 规则都必须按它门控。缺任一侧 → 材质不可见（页面不透明）或
    /// Electron 腿被误伤（同为 darwin 但没有 vibrancy，透明会把侧栏/中列压到窗口底色上）。
    func testWindowVibrancyMarkerLockstep() throws {
        let shim = try source("macos/Sources/DSHChamber/Resources/bridge-shim.js")
        XCTAssertTrue(shim.contains("dataset.windowVibrancy = 'true'"),
                      "Swift 壳必须在 documentStart 落 data-window-vibrancy（材质在位的唯一标记）")
        let renderer = try source("packages/renderer/src/styles.css")
        XCTAssertTrue(renderer.contains("html[data-platform='darwin'][data-window-vibrancy] .app")
                      && renderer.contains("html[data-platform='darwin'][data-window-vibrancy] .instance-view"),
                      "renderer 的 .app/.instance-view 必须在 vibrancy 标记下让出底色（否则材质被盖住）")
        XCTAssertFalse(renderer.contains("html[data-platform='darwin'] .app"),
                       "不得只按 data-platform 门控（Electron 腿同样命中）")
        let sidebar = try source("packages/dsh-chamber-client-ui-sidebar/src/client/SidebarRoot.module.css")
        for selector in [".root", ".brand", ".newSession"] {
            XCTAssertTrue(sidebar.contains("[data-platform='darwin'][data-window-vibrancy]) \(selector) {"),
                          "侧栏 \(selector) 的 darwin 规则必须挂 vibrancy 标记")
        }
        XCTAssertFalse(sidebar.contains(":global([data-platform='darwin']) .root"),
                       "侧栏 .root 透明不得只按 data-platform 门控")
    }

    /// served markup 的默认语言是 zh-CN（packages/renderer/index.html 的
    /// html lang="zh-CN"）——冷启动兜底与静态骨架都依赖这个锚。
    func testServedMarkupDeclaresZhCnDefaultLanguage() throws {
        let html = try source("packages/renderer/index.html")
        XCTAssertTrue(html.contains("<html lang=\"zh-CN\">"),
                      "served markup 必须声明 lang=\"zh-CN\"（页面语言兜底单源）")
    }

}
