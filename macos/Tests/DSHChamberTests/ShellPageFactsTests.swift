//
//  ShellPageFactsTests.swift
//  DSHChamberTests
//
//  ShellPageFacts —— 页面 document 是语言/主题的唯一事实源
//  （语言 = documentElement.lang；主题 = body[data-ds-dark-theme] /
//  html color-scheme）。本文件不构造 WKWebView：钉 resolve 解析、store 的
//  合并/幂等/revision/持久化、系统语言与外观策略，以及内联 JS 的形状。
//
//  载荷契约（与 ShellPageFactsScript 的 postMessage 载荷同值）：
//    - "lang": String；空串/缺失/NSNull = 不构成语言事实（保留旧值）
//    - "dark": Bool；缺失 = 不改变旧暗色事实（首次出现默认 false）
//
import XCTest
import AppKit
@testable import DSHChamber

final class ShellPageFactsTests: XCTestCase {

    /// 页面事实载荷键（ShellPageFactsScript.source() 的 postMessage ↔
    /// store.ingest 的同一契约）：脚本上报 {lang, dark, revision}；revision 由
    /// store 按 max(上报值, 旧值 + 1) 收敛，测试只在版本回退用例里显式给。
    private enum PayloadKey {
        static let lang = "lang"
        static let dark = "dark"
        static let revision = "revision"
    }

    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        suiteName = "shell-page-facts-tests-\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suiteName)
    }

    // MARK: - ShellPageLanguage.resolve

    func testResolveZhFamilyIsChinese() {
        for tag in ["zh", "zh-CN", "zh-Hans", "zh-Hans-CN", "zh_CN", "zh-Hant-TW"] {
            XCTAssertEqual(ShellPageLanguage.resolve(lang: tag), .zh,
                           "zh 族标签必须解析为 zh：\(tag)")
        }
    }

    func testResolveOtherNonEmptyTagsAreEnglish() {
        for tag in ["en", "en-US", "ja-JP", "fr", "zhx"] {
            XCTAssertEqual(ShellPageLanguage.resolve(lang: tag), .en,
                           "非 zh 族非空标签必须解析为 en：\(tag)")
        }
    }

    /// nil/空在 Swift 侧是「无事实」哨兵：resolve 返回 .en 只是哨兵值，
    /// 是否落库由 store 把关（见 store 的空串用例），不得据此覆盖旧语言。
    func testResolveNilOrEmptyIsNoFactSentinel() {
        XCTAssertEqual(ShellPageLanguage.resolve(lang: nil), .en)
        XCTAssertEqual(ShellPageLanguage.resolve(lang: ""), .en)
    }

    // MARK: - ShellPageFactsStore

    func testStoreStartsWithoutFacts() {
        let store = ShellPageFactsStore(defaults: defaults)
        XCTAssertNil(store.current, "未收到任何上报前 current 必须是 nil（无任何已知事实）")
    }

    func testFirstReportConstitutesFacts() throws {
        let store = ShellPageFactsStore(defaults: defaults)
        XCTAssertTrue(store.ingest([PayloadKey.lang: "en-US", PayloadKey.dark: true]))
        let facts = try XCTUnwrap(store.current)
        XCTAssertEqual(facts.language, .en)
        XCTAssertTrue(facts.pageIsDark)
        XCTAssertGreaterThan(facts.revision, 0, "首个事实的 revision 必须为正")
    }

    func testRepeatedIdenticalReportIsIdempotent() throws {
        let store = ShellPageFactsStore(defaults: defaults)
        let payload: [String: Any] = [PayloadKey.lang: "zh-CN", PayloadKey.dark: false]
        XCTAssertTrue(store.ingest(payload))
        let first = try XCTUnwrap(store.current)
        XCTAssertFalse(store.ingest(payload), "逐字相同的上报必须返回 false")
        XCTAssertEqual(store.current, first, "幂等上报不得改动 current（含 revision）")
    }

    func testRevisionBumpsOnlyOnChange() throws {
        let store = ShellPageFactsStore(defaults: defaults)
        XCTAssertTrue(store.ingest([PayloadKey.lang: "en", PayloadKey.dark: false]))
        let first = try XCTUnwrap(store.current)
        XCTAssertTrue(store.ingest([PayloadKey.lang: "en", PayloadKey.dark: true]))
        let second = try XCTUnwrap(store.current)
        XCTAssertGreaterThan(second.revision, first.revision, "主题变化必须递增 revision")
        XCTAssertTrue(store.ingest([PayloadKey.lang: "zh-CN", PayloadKey.dark: true]))
        let third = try XCTUnwrap(store.current)
        XCTAssertGreaterThan(third.revision, second.revision, "语言变化必须递增 revision")
        XCTAssertEqual(third.language, .zh)
        // 族内变体（zh-CN → zh-Hans）解析后同值；是否算「变化」由 store 自定，
        // 本用例只钉解析结果，不钉 raw tag 记账。
        _ = store.ingest([PayloadKey.lang: "zh-Hans", PayloadKey.dark: true])
        let fourth = try XCTUnwrap(store.current)
        XCTAssertEqual(fourth.language, .zh, "zh 族内变体（zh-CN → zh-Hans）解析后同值")
    }

    /// 页面重载后脚本的 revision 会重置；store 必须按 max(上报值, 旧值 + 1)
    /// 收敛，绝不回退（宿主 sink 依赖严格单调）。
    func testRevisionNeverRollsBackAcrossPageReports() throws {
        let store = ShellPageFactsStore(defaults: defaults)
        XCTAssertTrue(store.ingest([PayloadKey.lang: "en", PayloadKey.dark: false,
                                    PayloadKey.revision: NSNumber(value: 5)]))
        XCTAssertEqual(try XCTUnwrap(store.current).revision, 5)
        // 页面重载后脚本从 1 重新计数：不得把 revision 拉回 2。
        XCTAssertTrue(store.ingest([PayloadKey.lang: "zh-CN", PayloadKey.dark: false,
                                    PayloadKey.revision: NSNumber(value: 2)]))
        XCTAssertEqual(try XCTUnwrap(store.current).revision, 6,
                       "max(上报 2, 旧 5 + 1) = 6")
        // 对账路径不带 revision → 旧值 + 1。
        XCTAssertTrue(store.ingest([PayloadKey.dark: true]))
        XCTAssertEqual(try XCTUnwrap(store.current).revision, 7)
    }

    func testEmptyOrMissingLanguageNeverConstitutesAFact() {
        let store = ShellPageFactsStore(defaults: defaults)
        XCTAssertFalse(store.ingest([PayloadKey.lang: "", PayloadKey.dark: true]),
                       "空串语言不构成语言事实，首报时整体不产生 current")
        XCTAssertNil(store.current)
        XCTAssertFalse(store.ingest([PayloadKey.lang: NSNull(), PayloadKey.dark: true]))
        XCTAssertNil(store.current, "JS null（NSNull）与字段缺失同义")
        XCTAssertFalse(store.ingest([PayloadKey.dark: true]))
        XCTAssertNil(store.current, "缺 lang 字段的上报不构成语言事实")
    }

    func testEmptyLanguageKeepsPreviousLanguageWhileDarknessStillApplies() throws {
        let store = ShellPageFactsStore(defaults: defaults)
        XCTAssertTrue(store.ingest([PayloadKey.lang: "en-US", PayloadKey.dark: false]))
        XCTAssertFalse(store.ingest([PayloadKey.lang: "", PayloadKey.dark: false]),
                       "空串语言不构成事实：整体无变化时返回 false")
        XCTAssertEqual(try XCTUnwrap(store.current).language, .en, "必须保留旧语言")
        XCTAssertTrue(store.ingest([PayloadKey.lang: "", PayloadKey.dark: true]),
                      "空串语言的上报里，暗色变化仍必须生效")
        let facts = try XCTUnwrap(store.current)
        XCTAssertEqual(facts.language, .en, "语言仍必须保留旧值")
        XCTAssertTrue(facts.pageIsDark)
    }

    func testPartialReportsMerge() throws {
        let store = ShellPageFactsStore(defaults: defaults)
        // 首报必须同时构成语言与主题（脚本每次 postMessage 都带 lang + dark）；
        // 只有一半的上报在没有旧值时不算事实。
        XCTAssertFalse(store.ingest([PayloadKey.lang: "zh-CN"]),
                       "只有语言、没有旧主题事实的上报不产生 current")
        XCTAssertNil(store.current)
        XCTAssertTrue(store.ingest([PayloadKey.lang: "zh-CN", PayloadKey.dark: false]))
        var facts = try XCTUnwrap(store.current)
        XCTAssertEqual(facts.language, .zh)
        XCTAssertFalse(facts.pageIsDark)
        // 已有事实后，缺字段的上报保留旧值（合并，不是整体替换）。
        XCTAssertTrue(store.ingest([PayloadKey.dark: true]))
        facts = try XCTUnwrap(store.current)
        XCTAssertEqual(facts.language, .zh, "缺 lang 的暗色上报必须保留旧语言")
        XCTAssertTrue(facts.pageIsDark)
        XCTAssertTrue(store.ingest([PayloadKey.lang: "en"]))
        facts = try XCTUnwrap(store.current)
        XCTAssertEqual(facts.language, .en, "缺 dark 的语言上报必须保留旧主题")
        XCTAssertTrue(facts.pageIsDark)
        XCTAssertFalse(store.ingest(["unknownKey": "x"]), "未知键的上报不构成任何事实")
    }

    func testFactsSurviveStoreRecreationOnSameDefaults() throws {
        let store = ShellPageFactsStore(defaults: defaults)
        XCTAssertTrue(store.ingest([PayloadKey.lang: "zh-CN", PayloadKey.dark: true]))
        let reloaded = ShellPageFactsStore(defaults: defaults)
        let restored = try XCTUnwrap(reloaded.current, "同 defaults 新建 store 必须恢复已持久化事实")
        XCTAssertEqual(restored.language, .zh)
        XCTAssertTrue(restored.pageIsDark)
        XCTAssertGreaterThan(restored.revision, 0)
        XCTAssertFalse(reloaded.ingest([PayloadKey.lang: "zh-CN", PayloadKey.dark: true]),
                       "持久化恢复后重复上报仍必须幂等")
    }

    // MARK: - ShellLanguagePolicy

    func testAppleLanguagesOverrideOnlyWhenFamiliesDiffer() {
        XCTAssertEqual(ShellLanguagePolicy.appleLanguagesOverride(page: .zh, systemLanguages: ["en-US"]),
                       ["zh-Hans"], "页面 zh + 系统 en：原生面必须跟随页面（zh-Hans）")
        XCTAssertEqual(ShellLanguagePolicy.appleLanguagesOverride(page: .en, systemLanguages: ["zh-Hans-CN"]),
                       ["en"], "页面 en + 系统 zh：原生面必须跟随页面（en）")
        XCTAssertNil(ShellLanguagePolicy.appleLanguagesOverride(page: .zh, systemLanguages: ["zh-Hans-CN"]),
                     "同族（系统 zh-Hans-CN）不得覆盖 AppleLanguages")
        XCTAssertNil(ShellLanguagePolicy.appleLanguagesOverride(page: .en, systemLanguages: ["en-US"]),
                     "同族（系统 en-US）不得覆盖 AppleLanguages")
    }

    func testAppleLanguagesOverrideHandlesZhFamilyVariants() {
        for system in [["zh"], ["zh-Hans"], ["zh-Hans-CN"], ["zh-Hant-TW"]] {
            XCTAssertNil(ShellLanguagePolicy.appleLanguagesOverride(page: .zh, systemLanguages: system),
                         "系统 \(system) 属 zh 族且页面 zh → 跟系统（nil）")
        }
        XCTAssertEqual(ShellLanguagePolicy.appleLanguagesOverride(page: .en, systemLanguages: ["zh-Hant-TW"]),
                       ["en"], "zh 族变体不得被误判为 en 族")
    }

    // MARK: - ShellAppearancePolicy

    func testAppearancePolicyFollowsSystemWhenEqual() {
        XCTAssertNil(ShellAppearancePolicy.appearanceName(pageIsDark: true, systemIsDark: true))
        XCTAssertNil(ShellAppearancePolicy.appearanceName(pageIsDark: false, systemIsDark: false))
    }

    func testAppearancePolicyForcesPageThemeWhenDifferent() {
        XCTAssertEqual(ShellAppearancePolicy.appearanceName(pageIsDark: true, systemIsDark: false),
                       .darkAqua, "页面深色 + 系统浅色 → 强制 darkAqua")
        XCTAssertEqual(ShellAppearancePolicy.appearanceName(pageIsDark: false, systemIsDark: true),
                       .aqua, "页面浅色 + 系统深色 → 强制 aqua")
    }

    // MARK: - ShellPageFactsScript 形状

    func testFactsScriptShape() throws {
        XCTAssertEqual(ShellPageFactsScript.messageName, "dshChamberFacts",
                       "回包名是 native 侧 addScriptMessageHandler 的锁步常量")
        let source = ShellPageFactsScript.source()
        XCTAssertFalse(source.isEmpty, "内联 JS 不得为空")
        XCTAssertEqual(source, ShellPageFactsScript.source(), "source() 每次必须返回同一文本（纯函数）")
        XCTAssertTrue(source.contains(ShellPageFactsScript.messageName),
                      "脚本必须把 messageName 字面量写进 postMessage 目标")
        XCTAssertTrue(source.contains("MutationObserver"),
                      "必须用 MutationObserver 订阅 document 事实变化")
        XCTAssertTrue(source.contains("documentElement"),
                      "语言事实读自 documentElement.lang")
        XCTAssertTrue(source.contains("postMessage") || source.contains("webkit.messageHandlers"),
                      "必须经 WKWebView message handler 上报")
        let attributeFilter = attributeFilterSource(source)
        XCTAssertFalse(attributeFilter.isEmpty, "脚本必须设置 attributeFilter（否则收不到属性变化）")
        // 观察面是 HTML 属性名：lang、data-ds-dark-theme，以及 html 内联
        // color-scheme 的载体 style（没有叫 color-scheme 的 HTML 属性）；
        // 主题判定单独读 root.style.colorScheme，故这里只钉 style 载体。
        for attribute in ["lang", "style", "data-ds-dark-theme"] {
            XCTAssertTrue(attributeFilter.contains(attribute),
                          "attributeFilter 必须观察 \(attribute)：\(attributeFilter)")
        }
        XCTAssertTrue(source.contains("colorScheme"),
                      "主题事实必须读 html 内联 color-scheme（style.colorScheme）")
        // 上报载荷键锁步：JS postMessage 的键必须与 store.ingest 消费的一致。
        XCTAssertTrue(source.contains("lang:"), "上报载荷必须带 lang 键")
        XCTAssertTrue(source.contains("dark:"), "上报载荷必须带 dark 键")
        XCTAssertFalse(source.contains("pageIsDark:"), "上报载荷键是 dark，不是 pageIsDark")
        // 幂等护栏：同一文档重复注入（reload / 重新装配）不得叠加第二个 observer。
        let marker = try NSRegularExpression(pattern: #"__dshChamberFacts[A-Za-z0-9_]*"#)
        let whole = NSRange(source.startIndex..<source.endIndex, in: source)
        XCTAssertNotNil(marker.firstMatch(in: source, range: whole),
                        "脚本必须带文档级幂等标记（__dshChamberFacts*）")
        let guardReturn = try NSRegularExpression(
            pattern: #"__dshChamberFacts[A-Za-z0-9_]*[\s\S]{0,200}?\breturn\b"#)
        XCTAssertNotNil(guardReturn.firstMatch(in: source, range: whole),
                        "幂等护栏必须在已安装时提前 return（不得只赋值不复用）")
    }

    /// didFinish 对账表达式必须读同一组事实（lang + dark），且无页面副作用。
    func testSnapshotSourceReadsSameFacts() {
        let source = ShellPageFactsScript.snapshotSource()
        XCTAssertTrue(source.contains("lang"),
                      "对账表达式必须读 documentElement.lang")
        XCTAssertTrue(source.contains("data-ds-dark-theme"),
                      "对账表达式必须读 body[data-ds-dark-theme]")
        XCTAssertTrue(source.contains("colorScheme"),
                      "对账表达式必须读 html 内联 color-scheme")
        XCTAssertFalse(source.contains("MutationObserver"),
                       "对账表达式不得安装 observer（只返回快照）")
    }

    /// 2026-12 收口：dark 判定只能有一个实现——source() 与 snapshotSource()
    /// 都插值同一个 readDark() 函数（ShellPageFactsScript.readDarkJS），各自的
    /// 产物里 body 深色判定只出现一次；任一脚本退回内联重算即红。
    func testSharedDarkPredicateIsSingleSource() {
        let source = ShellPageFactsScript.source()
        let snapshot = ShellPageFactsScript.snapshotSource()
        // 共享实现（编译后 JS 文本）：去空白前缀 + 前 4 字符小写比较。
        let bodyAnchor = "inline.replace(/^\\s+/, '').slice(0, 4).toLowerCase()"
        XCTAssertTrue(source.contains(bodyAnchor), "注入脚本必须包含共享 dark 判定")
        XCTAssertTrue(snapshot.contains(bodyAnchor), "对账表达式必须包含同一 dark 判定")
        XCTAssertTrue(source.contains("function readDark()"),
                      "注入脚本必须定义共享 dark 函数")
        XCTAssertTrue(snapshot.contains("function readDark()"),
                      "对账表达式必须定义共享 dark 函数")
        XCTAssertTrue(snapshot.contains("dark: readDark()"),
                      "对账表达式必须调用共享 dark 函数，不得内联重算")
        for (label, script) in [("source", source), ("snapshotSource", snapshot)] {
            let occurrences = script.components(separatedBy: "hasAttribute('data-ds-dark-theme')").count - 1
            XCTAssertEqual(occurrences, 1,
                           "\(label) 的 body 深色判定必须只有一处（发现 \(occurrences) 处）")
        }
    }

    /// 取所有 attributeFilter 列表文本的并集（observer 配置可能不止一处）。
    private func attributeFilterSource(_ source: String) -> String {
        var union = ""
        var cursor = source.startIndex
        while let marker = source.range(of: "attributeFilter", range: cursor..<source.endIndex) {
            guard let open = source[marker.upperBound...].firstIndex(of: "["),
                  let close = source[open...].firstIndex(of: "]") else { break }
            union.append(contentsOf: source[open...close])
            cursor = source.index(after: close)
        }
        return union
    }
}
