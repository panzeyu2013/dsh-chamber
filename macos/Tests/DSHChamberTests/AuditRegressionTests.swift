//
//  AuditRegressionTests.swift
//  DSHChamberTests
//
//  真实缺陷的回归测试：
//   1) revision 溢出：页面可 postMessage `1e300`（NSNumber.intValue = Int.max），
//      `旧值 + 1` 在 Swift 里是陷阱（SIGTRAP），且旧值会被持久化 → 一次污染此后每次
//      事实变化都崩；
//   2) AppleLanguages 回收边界：系统设置「每个 app 的语言」写同一个 app 域键，
//      恰好是 ["en"]/["zh-Hans"] 的**用户值**可能被当作壳的陈旧覆盖而覆盖或删除。
//      所有权 = "我们写入的确切值"的记录：无记录不碰、记录+同值才回收、
//      用户改值不覆盖、旧布尔标记只清理；空记录视同无记录、非字符串数组形状
//      保守视为"外来值存在"；
//   3) 露底色稳态：第二次启动时 store 内已有同值事实，ingest 返回 false，
//      露底色对账若只挂在 ingest 的变化分支上 → 浅色页面整场会话停在骨架深色；
//      建窗即按 last-known 收敛，且每次 ingest 后幂等对账；
//   4) 消息门 / 系统语言决策的纯函数回归。
//  这里钉住这些不变量。
//
import XCTest
@testable import DSHChamber

final class AuditRegressionTests: XCTestCase {

    private var suites: [String] = []

    private func scratchDefaults() -> (defaults: UserDefaults, name: String) {
        let name = "audit-regression-" + UUID().uuidString
        suites.append(name)
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return (defaults, name)
    }

    /// 只看**本 app 域**：UserDefaults 的普通读取会穿透到全局域（系统语言也在
    /// AppleLanguages 上），断言"我们删掉了/没动"必须读 persistentDomain。
    private func appDomain(_ defaults: UserDefaults, _ name: String) -> [String: Any] {
        defaults.persistentDomain(forName: name) ?? [:]
    }

    override func tearDown() {
        for name in suites { UserDefaults().removePersistentDomain(forName: name) }
        suites = []
        super.tearDown()
    }

    // MARK: - 1) revision 溢出

    func testPoisonedRevisionCannotTrap() {
        let (defaults, _) = scratchDefaults()
        let store = ShellPageFactsStore(defaults: defaults)

        // 页面可构造的上界值：NSNumber(value: 1e300).intValue == Int.max
        XCTAssertTrue(store.ingest(["lang": "en", "dark": false,
                                   "revision": NSNumber(value: 1e300)]))
        XCTAssertLessThanOrEqual(store.current?.revision ?? 0, ShellPageFactsStore.maxRevision)

        // 关键：旧值已达上界后再来一次**改变事实**的上报——历史实现正是在这里踩 Int.max + 1 陷阱。
        XCTAssertTrue(store.ingest(["lang": "zh", "dark": true, "revision": 1]))
        XCTAssertLessThanOrEqual(store.current?.revision ?? 0, ShellPageFactsStore.maxRevision)
        XCTAssertEqual(store.current?.language, .zh)
        XCTAssertEqual(store.current?.pageIsDark, true)
    }

    func testPersistedUpperBoundIsClampedOnLoad() {
        let (defaults, _) = scratchDefaults()
        // 模拟"持久化里已经写进过被污染的上界值"
        defaults.set(["language": "en", "pageIsDark": false, "revision": Int.max],
                     forKey: ShellPageFactsStore.defaultsKey)
        let store = ShellPageFactsStore(defaults: defaults)
        XCTAssertEqual(store.current?.revision, ShellPageFactsStore.maxRevision)
        XCTAssertTrue(store.ingest(["lang": "zh", "dark": true]))
        XCTAssertLessThanOrEqual(store.current?.revision ?? 0, ShellPageFactsStore.maxRevision)
    }

    func testNegativeAndHugeReportedRevisionsStayBounded() {
        let (defaults, _) = scratchDefaults()
        let store = ShellPageFactsStore(defaults: defaults)
        XCTAssertTrue(store.ingest(["lang": "en", "dark": false, "revision": -5]))
        XCTAssertGreaterThanOrEqual(store.current?.revision ?? -1, 0)
        XCTAssertTrue(store.ingest(["lang": "zh", "dark": false,
                                   "revision": NSNumber(value: Double.greatestFiniteMagnitude)]))
        XCTAssertLessThanOrEqual(store.current?.revision ?? 0, ShellPageFactsStore.maxRevision)
    }

    /// 到顶后再变化：必须仍报 true（事实确实变了，不能静默停更），且 revision
    /// 保持上界（既不自增越界，也不因溢出陷阱崩溃）。
    func testRevisionAtTopStillReportsChangeAndStaysBounded() {
        let (defaults, _) = scratchDefaults()
        let store = ShellPageFactsStore(defaults: defaults)
        XCTAssertTrue(store.ingest(["lang": "en", "dark": false,
                                   "revision": NSNumber(value: 1e300)]))
        XCTAssertEqual(store.current?.revision, ShellPageFactsStore.maxRevision)

        XCTAssertTrue(store.ingest(["lang": "zh", "dark": true, "revision": 2]))
        XCTAssertEqual(store.current?.revision, ShellPageFactsStore.maxRevision)
        XCTAssertEqual(store.current?.language, .zh)
        XCTAssertEqual(store.current?.pageIsDark, true)
    }

    // MARK: - 2) AppleLanguages 所有权（记录我们写过的确切值）

    /// 无记录 ⇒ 无论值长什么样都不删（旧布尔标记也不构成所有权证据）。
    func testNoRecordNeverDeletesUserValue() {
        let (defaults, name) = scratchDefaults()
        // 系统设置里给本 app 指定的语言（无本壳记录）
        defaults.set(["en"], forKey: "AppleLanguages")
        XCTAssertFalse(AppDelegate.applyLanguage(.zh, systemLanguages: ["zh-Hans-CN"],
                                                 defaults: defaults, appDomainName: name))
        XCTAssertEqual(appDomain(defaults, name)["AppleLanguages"] as? [String], ["en"],
                       "没有我们写的记录 ⇒ 一律不碰用户自己的 per-app 语言")
        XCTAssertNil(appDomain(defaults, name)[AppDelegate.appleLanguagesWrittenKey])
    }

    /// 记录存在且当前值 == 记录值 ⇒ 才允许回收，并同时清掉记录。
    func testRecordedSameValueIsRecycled() {
        let (defaults, name) = scratchDefaults()
        XCTAssertTrue(AppDelegate.applyLanguage(.en, systemLanguages: ["zh-Hans-CN"],
                                                defaults: defaults, appDomainName: name))
        XCTAssertEqual(appDomain(defaults, name)["AppleLanguages"] as? [String], ["en"])
        XCTAssertEqual(appDomain(defaults, name)[AppDelegate.appleLanguagesWrittenKey] as? [String],
                       ["en"], "写覆盖必须同时记录写入的确切值")

        // 页面回到与系统同族 → 回收**我们自己**写的值（只看 app 域）。
        XCTAssertFalse(AppDelegate.applyLanguage(.zh, systemLanguages: ["zh-Hans-CN"],
                                                 defaults: defaults, appDomainName: name))
        XCTAssertNil(appDomain(defaults, name)["AppleLanguages"])
        XCTAssertNil(appDomain(defaults, name)[AppDelegate.appleLanguagesWrittenKey])
    }

    /// 记录存在且当前值 == 记录值 ⇒ 仍是我们的，可以改写成新的覆盖值。
    func testOwnedRecordAllowsRewritingOurOwnOverride() {
        let (defaults, name) = scratchDefaults()
        XCTAssertTrue(AppDelegate.applyLanguage(.en, systemLanguages: ["zh-Hans-CN"],
                                                defaults: defaults, appDomainName: name))
        XCTAssertTrue(AppDelegate.applyLanguage(.zh, systemLanguages: ["en-US"],
                                                defaults: defaults, appDomainName: name))
        XCTAssertEqual(appDomain(defaults, name)["AppleLanguages"] as? [String], ["zh-Hans"])
        XCTAssertEqual(appDomain(defaults, name)[AppDelegate.appleLanguagesWrittenKey] as? [String],
                       ["zh-Hans"])
    }

    /// 用户改值后（值 != 记录）写路径绝不覆盖。
    func testUserChangedValueIsNeverOverwritten() {
        let (defaults, name) = scratchDefaults()
        XCTAssertTrue(AppDelegate.applyLanguage(.en, systemLanguages: ["zh-Hans-CN"],
                                                defaults: defaults, appDomainName: name))
        // 用户在系统设置里改成别的语言（值 != 记录）
        defaults.set(["ja"], forKey: "AppleLanguages")
        XCTAssertFalse(AppDelegate.applyLanguage(.en, systemLanguages: ["zh-Hans-CN"],
                                                 defaults: defaults, appDomainName: name),
                       "页面仍要 en，但 app 域已是用户设置的 ja ⇒ 不覆盖")
        XCTAssertEqual(appDomain(defaults, name)["AppleLanguages"] as? [String], ["ja"])
        XCTAssertNil(appDomain(defaults, name)[AppDelegate.appleLanguagesWrittenKey],
                     "写路径失配也必须作废记录：否则用户值日后改回记录值时所有权会复活")
    }

    /// 用户改值后（值 != 记录）回收路径绝不删值；失配记录作废（不宣称所有权）。
    func testUserChangedValueIsNotDeletedOnRecycle() {
        let (defaults, name) = scratchDefaults()
        XCTAssertTrue(AppDelegate.applyLanguage(.en, systemLanguages: ["zh-Hans-CN"],
                                                defaults: defaults, appDomainName: name))
        defaults.set(["ja"], forKey: "AppleLanguages")
        XCTAssertFalse(AppDelegate.applyLanguage(.zh, systemLanguages: ["zh-Hans-CN"],
                                                 defaults: defaults, appDomainName: name))
        XCTAssertEqual(appDomain(defaults, name)["AppleLanguages"] as? [String], ["ja"])
        XCTAssertNil(appDomain(defaults, name)[AppDelegate.appleLanguagesWrittenKey],
                     "失配记录必须作废（否则会继续宣称一个已不属于我们的值）")
    }

    /// 遗留布尔标记：只清理，绝不当作所有权依据（保守不删值）。
    func testLegacyBooleanMarkerIsIgnoredAndCleaned() {
        let (defaults, name) = scratchDefaults()
        defaults.set(true, forKey: AppDelegate.legacyAppleLanguagesOwnedKey)
        defaults.set(["en"], forKey: "AppleLanguages")
        XCTAssertFalse(AppDelegate.applyLanguage(.zh, systemLanguages: ["zh-Hans-CN"],
                                                 defaults: defaults, appDomainName: name))
        XCTAssertEqual(appDomain(defaults, name)["AppleLanguages"] as? [String], ["en"],
                       "旧布尔标记不能把用户值变成'我们的'")
        XCTAssertNil(appDomain(defaults, name)[AppDelegate.legacyAppleLanguagesOwnedKey],
                     "旧标记必须被清理")
        XCTAssertNil(appDomain(defaults, name)[AppDelegate.appleLanguagesWrittenKey])
    }

    // MARK: - 2b) app 域 AppleLanguages 形状

    /// 覆写 persistentDomain 的测试替身：CFPreferences 对 `AppleLanguages` 的
    /// 非字符串数组值会在 `defaults.set` 时静默丢弃（域里仍是旧值/无值），所以
    /// 「app 域已是标量或字典」这种状态只能覆写读取面构造；同时记录 set/
    /// removeObject 调用，把「拒绝覆盖/不得删除」钉成「连写调用都没发生」。
    private final class DomainShapeDefaults: UserDefaults {
        var injectedDomains: [String: [String: Any]] = [:]
        private(set) var setKeys: [String] = []
        private(set) var removedKeys: [String] = []

        override func persistentDomain(forName domainName: String) -> [String: Any]? {
            if let injected = injectedDomains[domainName] { return injected }
            return super.persistentDomain(forName: domainName)
        }

        override func set(_ value: Any?, forKey defaultName: String) {
            setKeys.append(defaultName)
            super.set(value, forKey: defaultName)
        }

        override func removeObject(forKey defaultName: String) {
            removedKeys.append(defaultName)
            super.removeObject(forKey: defaultName)
        }
    }

    private func scratchShapeDefaults() -> (defaults: DomainShapeDefaults, name: String) {
        let name = "audit-regression-shape-" + UUID().uuidString
        suites.append(name)
        let defaults = DomainShapeDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return (defaults, name)
    }

    /// `DomainShapeDefaults` 覆写 persistentDomain
    /// 属非支持用法——整组用例都建立在"注入确实可见"之上；若覆写未生效（读回空域），
    /// 「不 set / 不 remove / 原值保持」会在错误前提上假绿。注入后立刻读回比对，
    /// 并用探针键证明 set/removeObject 的记录面同样落在替身上（写面断言可信）。
    private func assertShapeDoubleEffective(_ defaults: DomainShapeDefaults,
                                            name: String,
                                            injected: Any,
                                            file: StaticString = #filePath,
                                            line: UInt = #line) {
        let readBack = defaults.persistentDomain(forName: name)?["AppleLanguages"] ?? NSNull()
        XCTAssertTrue((readBack as AnyObject).isEqual(injected as AnyObject),
                      "替身未生效：注入的 AppleLanguages 读回不一致：\(readBack)",
                      file: file, line: line)
        let probe = "audit-regression-shape-double-probe"
        defaults.set(true, forKey: probe)
        defaults.removeObject(forKey: probe)
        XCTAssertTrue(defaults.setKeys.contains(probe),
                      "替身写面未生效：set 覆写未被调用（setKeys 记录不可信）",
                      file: file, line: line)
        XCTAssertTrue(defaults.removedKeys.contains(probe),
                      "替身写面未生效：removeObject 覆写未被调用（removedKeys 记录不可信）",
                      file: file, line: line)
    }

    /// app 域 `AppleLanguages` 是非字符串数组（标量/字典）时，读取面返回
    /// 「外来值存在」的保守哨兵 []，写路径必须拒绝覆盖：不 set、不 remove、
    /// 原值保持（否则用户/系统写的 per-app 语言会被悄悄改掉）。
    func testNonStringArrayAppLanguageValueIsNeverOverwritten() {
        let shapes: [(String, Any)] = [("标量", "ja"),
                                       ("字典", ["zh-Hans": 1] as [String: Any])]
        for (shape, foreign) in shapes {
            let (defaults, name) = scratchShapeDefaults()
            defaults.injectedDomains[name] = ["AppleLanguages": foreign]
            assertShapeDoubleEffective(defaults, name: name, injected: foreign)
            XCTAssertFalse(AppDelegate.applyLanguage(.en, systemLanguages: ["zh-Hans-CN"],
                                                     defaults: defaults,
                                                     appDomainName: name),
                           "\(shape)形状的 app 域 AppleLanguages 存在 ⇒ 写路径必须拒绝覆盖")
            XCTAssertFalse(defaults.setKeys.contains("AppleLanguages"),
                           "\(shape)形状必须原样保留：不得调用 set(AppleLanguages)")
            XCTAssertFalse(defaults.removedKeys.contains("AppleLanguages"),
                           "\(shape)形状必须原样保留：不得调用 removeObject(AppleLanguages)")
            let kept = defaults.persistentDomain(forName: name)?["AppleLanguages"] ?? NSNull()
            XCTAssertTrue((kept as AnyObject).isEqual(foreign as AnyObject),
                          "\(shape)形状的 app 域原值必须保持不变：\(kept)")
        }
    }

    /// 记录键被外部写坏成空数组时必须**视同无记录**。最危险的组合是 app 值
    /// 也是非字符串数组：`appDomainAppleLanguages` 的哨兵恰为 []，若把空记录当成
    /// 「已记录 = []」，回收路径会因 [] == [] 误判所有权并删掉外来值，写路径也会
    /// 把用户值当成自己的旧覆盖改写。两条路径都钉：不得 remove、不得 set、原值保持。
    func testEmptyWrittenRecordIsTreatedAsNoRecord() {
        let appValues: [(String, Any)] = [("字符串数组", ["en"] as [String]),
                                          ("非字符串数组（哨兵 []）", "ja")]
        for (shape, appValue) in appValues {
            // 回收路径：页面 zh、系统 zh-Hans-CN 同族 → override = nil。
            let (recycleDefaults, recycleName) = scratchShapeDefaults()
            recycleDefaults.injectedDomains[recycleName] = [
                "AppleLanguages": appValue,
                AppDelegate.appleLanguagesWrittenKey: [String](),
            ]
            assertShapeDoubleEffective(recycleDefaults, name: recycleName, injected: appValue)
            XCTAssertFalse(AppDelegate.applyLanguage(.zh, systemLanguages: ["zh-Hans-CN"],
                                                     defaults: recycleDefaults,
                                                     appDomainName: recycleName))
            XCTAssertFalse(recycleDefaults.removedKeys.contains("AppleLanguages"),
                           "空记录不构成所有权：回收路径不得删除 app 域既有值（\(shape)）")
            let kept = recycleDefaults.persistentDomain(forName: recycleName)?["AppleLanguages"]
                ?? NSNull()
            XCTAssertTrue((kept as AnyObject).isEqual(appValue as AnyObject),
                          "空记录不构成所有权：回收路径原值必须保持（\(shape)）：\(kept)")

            // 写路径：页面 en、系统 zh-Hans-CN → override = ["en"]。
            let (writeDefaults, writeName) = scratchShapeDefaults()
            writeDefaults.injectedDomains[writeName] = [
                "AppleLanguages": appValue,
                AppDelegate.appleLanguagesWrittenKey: [String](),
            ]
            assertShapeDoubleEffective(writeDefaults, name: writeName, injected: appValue)
            XCTAssertFalse(AppDelegate.applyLanguage(.en, systemLanguages: ["zh-Hans-CN"],
                                                     defaults: writeDefaults,
                                                     appDomainName: writeName))
            XCTAssertFalse(writeDefaults.setKeys.contains("AppleLanguages"),
                           "空记录不构成所有权：写路径不得覆盖 app 域既有值（\(shape)）")
            let writeKept = writeDefaults.persistentDomain(forName: writeName)?["AppleLanguages"]
                ?? NSNull()
            XCTAssertTrue((writeKept as AnyObject).isEqual(appValue as AnyObject),
                          "空记录不构成所有权：写路径原值必须保持（\(shape)）：\(writeKept)")
        }
    }

    // MARK: - 3) 露底色稳态（第二次启动 ingest 不变也要收敛）

    /// 第二次启动：store 内已有同值 last-known，ingest 返回 false（早退
    /// 点）；建窗时的决策必须仍给浅色底，而不是停在骨架 #0f1115。
    func testSameLastKnownFactsStartupConvergesThemedBackground() throws {
        let (defaults, _) = scratchDefaults()
        let firstLaunch = ShellPageFactsStore(defaults: defaults)
        XCTAssertTrue(firstLaunch.ingest(["lang": "en", "dark": false, "revision": 1]))

        // 第二次启动：同一份持久化事实载入，同值上报不产生变化。
        let secondLaunch = ShellPageFactsStore(defaults: defaults)
        XCTAssertFalse(secondLaunch.ingest(["lang": "en", "dark": false, "revision": 1]))
        XCTAssertEqual(secondLaunch.current?.pageIsDark, false)

        // 建窗时 applied = nil（骨架常量）→ 决策必须给浅色底。
        let color = try XCTUnwrap(MainWindowController.themedBackgroundColorToApply(
            pageIsDark: secondLaunch.current?.pageIsDark, appliedPageIsDark: nil))
        let converted = try XCTUnwrap(color.usingColorSpace(.sRGB))
        XCTAssertEqual(converted.redComponent, 1.0, accuracy: 0.001)
        XCTAssertEqual(converted.greenComponent, 1.0, accuracy: 0.001)
        XCTAssertEqual(converted.blueComponent, 1.0, accuracy: 0.001)

        // 对账是幂等的：已应用同值后不再给色（无额外赋值/日志噪音）。
        XCTAssertNil(MainWindowController.themedBackgroundColorToApply(
            pageIsDark: secondLaunch.current?.pageIsDark, appliedPageIsDark: false))
    }

    func testThemedBackgroundDecisionIsIdempotent() {
        XCTAssertNil(MainWindowController.themedBackgroundColorToApply(
            pageIsDark: nil, appliedPageIsDark: nil))
        XCTAssertNil(MainWindowController.themedBackgroundColorToApply(
            pageIsDark: true, appliedPageIsDark: true))
        XCTAssertNil(MainWindowController.themedBackgroundColorToApply(
            pageIsDark: false, appliedPageIsDark: false))
        // 两个方向的事实变化都必须给色（浅→深、深→浅、无事实→浅、浅→无事实）。
        XCTAssertNotNil(MainWindowController.themedBackgroundColorToApply(
            pageIsDark: false, appliedPageIsDark: nil))
        XCTAssertNotNil(MainWindowController.themedBackgroundColorToApply(
            pageIsDark: false, appliedPageIsDark: true))
        XCTAssertNotNil(MainWindowController.themedBackgroundColorToApply(
            pageIsDark: true, appliedPageIsDark: false))
        XCTAssertNotNil(MainWindowController.themedBackgroundColorToApply(
            pageIsDark: nil, appliedPageIsDark: false))
    }

    /// 可直测接缝 `MainWindowController.ingestPageFacts(payload:into:reconcile:)` 让
    /// 「Store 合并 + 无条件露底色对账」在无窗口环境下也可钉次序——把 reconcile 挪回
    /// changed 分支或挪到 return 之后，第二条（无变化）ingest 就观察到 0 次回调 → 本用例红。
    func testIngestSeamReconcilesEvenWhenStoreUnchanged() {
        let (defaults, _) = scratchDefaults()
        let store = ShellPageFactsStore(defaults: defaults)
        var reconciled: [Bool?] = []

        XCTAssertTrue(MainWindowController.ingestPageFacts(
            ["lang": "en", "dark": false, "revision": 1], into: store) { reconciled.append($0) })
        XCTAssertEqual(reconciled, [false])

        // 同值再上报：Store 无变化（早退点）——对账仍必须发生一次。
        XCTAssertFalse(MainWindowController.ingestPageFacts(
            ["lang": "en", "dark": false, "revision": 1], into: store) { reconciled.append($0) })
        XCTAssertEqual(reconciled, [false, false], "任何一次 ingest 之后都必须对账（F1）")

        // 次序：对账拿到的是本次 ingest **之后**的 Store 事实（新事实为深色）。
        XCTAssertTrue(MainWindowController.ingestPageFacts(
            ["lang": "zh", "dark": true, "revision": 2], into: store) { reconciled.append($0) })
        XCTAssertEqual(reconciled.last ?? nil, true, "对账必须读到 ingest 后的新事实")
    }

    // MARK: - 4) 页面事实消息门（纯函数真值表）

    /// 真值表（观察器路径）：放行 = 同源根路径 / 带 query / /api/i/*（pushState
    /// 场景）/ hash；拒绝 = 名称错、非主 frame、about:blank、data:/file:/blob:、空 url、
    /// 空 expectedOrigin、不同端口、不同 host、子域、https、userinfo。
    func testPageFactsMessageGateTruthTable() {
        let name = ShellPageFactsScript.messageName
        let origin = "http://127.0.0.1:17520"
        let shellURL = "http://127.0.0.1:17520/"

        // 全部匹配 → 放行
        XCTAssertTrue(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: true, url: shellURL, expectedOrigin: origin))
        // 同源带 query → 放行（本通道不要求壳文档的「无 query」）
        XCTAssertTrue(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: true,
            url: "http://127.0.0.1:17520/?x=1", expectedOrigin: origin))
        // 同源非根路径 → 放行（pushState/replaceState 后 frameInfo.request.url 会变）
        XCTAssertTrue(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: true,
            url: "http://127.0.0.1:17520/api/i/1", expectedOrigin: origin))
        // 同源 hash 路由 → 放行
        XCTAssertTrue(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: true,
            url: "http://127.0.0.1:17520/#/settings", expectedOrigin: origin))
        // 名称错 → 拒
        XCTAssertFalse(ShellPageFactsMessageHandler.accepts(
            messageName: name + "-spoof", isMainFrame: true, url: shellURL,
            expectedOrigin: origin))
        // 非主 frame → 拒
        XCTAssertFalse(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: false, url: shellURL, expectedOrigin: origin))
        // 跨源（不同端口 / 不同 host）→ 拒
        XCTAssertFalse(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: true,
            url: "http://127.0.0.1:17521/", expectedOrigin: origin))
        XCTAssertFalse(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: true,
            url: "http://localhost:17520/", expectedOrigin: origin))
        // 子域 → 拒
        XCTAssertFalse(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: true,
            url: "http://sub.127.0.0.1:17520/", expectedOrigin: origin))
        // https（scheme 不同）→ 拒
        XCTAssertFalse(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: true,
            url: "https://127.0.0.1:17520/", expectedOrigin: origin))
        // userinfo → 拒（同源以无凭据 URL 为前提）
        XCTAssertFalse(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: true,
            url: "http://evil@127.0.0.1:17520/", expectedOrigin: origin))
        // 失败页 about:blank → 拒；data:/file:/blob: 同样拒
        XCTAssertFalse(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: true,
            url: "about:blank", expectedOrigin: origin))
        XCTAssertFalse(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: true,
            url: "data:text/html;base64,PGh0bWw+", expectedOrigin: origin))
        XCTAssertFalse(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: true,
            url: "file:///Users/x/index.html", expectedOrigin: origin))
        XCTAssertFalse(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: true,
            url: "blob:http://127.0.0.1:17520/0f1e", expectedOrigin: origin))
        // expectedOrigin 为 nil（闭包不可用）→ 拒。expectedOrigin = cpOrigin
        // 在 MainWindowController 初始化时即赋值，**与 sidecar ready 无关**——事实通道
        // 独立于 A 桥就绪门正是本通道的设计要点。
        XCTAssertFalse(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: true, url: shellURL, expectedOrigin: nil))
        // expectedOrigin 为空串 → 拒（fail closed）
        XCTAssertFalse(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: true, url: shellURL, expectedOrigin: ""))
        // url 缺失 → 拒
        XCTAssertFalse(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: true, url: nil, expectedOrigin: origin))
    }

    // MARK: - 5) 系统语言决策（纯函数四例）

    func testSystemLanguageDecisionCases() {
        let localePreferred = ["en-US"]
        // own/global 均非空 → 取 global（排除 app 域覆盖值）。
        XCTAssertEqual(AppDelegate.systemLanguageDecision(
            own: ["en"], global: ["zh-Hans-CN"], localePreferred: localePreferred),
            ["zh-Hans-CN"])
        // own 缺失 → locale
        XCTAssertEqual(AppDelegate.systemLanguageDecision(
            own: nil, global: ["zh-Hans-CN"], localePreferred: localePreferred),
            localePreferred)
        // own 为空数组 → locale
        XCTAssertEqual(AppDelegate.systemLanguageDecision(
            own: [], global: ["zh-Hans-CN"], localePreferred: localePreferred),
            localePreferred)
        // global 缺失 → locale
        XCTAssertEqual(AppDelegate.systemLanguageDecision(
            own: ["en"], global: nil, localePreferred: localePreferred),
            localePreferred)
    }

    // MARK: - 6) 候选 bundle 缓存

    func testCopyStillResolvesWithClearedOverride() {
        NativeText.setLanguageOverride(nil)
        let resolved = NativeText.string(.menuFile)
        XCTAssertNotEqual(resolved, NativeTextKey.menuFile.rawValue,
                          "缓存候选 bundle 后，无覆盖时仍必须解析到真实文案")
        XCTAssertTrue(resolved == "File" || resolved == "文件")
    }
}
