//
//  ShellOverscrollPolicyTests.swift
//  DSHChamberPocTests
//
//  钉住视口越界策略的注入契约与装配点（design 25 §5.2 / deviations S-50）。除字符串契约外，
//  这里用 JavaScriptCore + 最小 DOM 桩**真正执行**注入源码：纯字符串断言曾经漏掉
//  "占位符没被 Swift 插值替换"（`${...}` 是 JS 模板写法，Swift 是 `\(...)`）——
//  执行一次，这类缺陷无处可藏。
//
import JavaScriptCore
import XCTest
import WebKit
@testable import DSHChamberPoc

final class ShellOverscrollPolicyTests: XCTestCase {

    /// #filePath = <repo>/macos/Tests/DSHChamberPocTests/ShellOverscrollPolicyTests.swift
    /// （与 NativeIdentityTests 同款读源做法：让"装配点/文档字面量"这些无法在单测里构造的面也能被钉住。）
    private func repoFile(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // DSHChamberPocTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // macos
            .deletingLastPathComponent()   // repo root
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    /// 壳级不变量：根规则文本锁步，选择器只允许文档根。
    func testRootRuleIsLockedAndTargetsDocumentRootOnly() {
        let css = ShellOverscrollPolicy.rootOverscrollCSS
        XCTAssertEqual(css, "html, body { overscroll-behavior: none !important; }")
        let parts = css.components(separatedBy: "{")
        XCTAssertEqual(parts.count, 2, "只允许一条规则：\(css)")
        let selectors = parts[0].split(separator: ",").map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        XCTAssertEqual(selectors, ["html", "body"], "选择器只允许文档根：\(selectors)")
        XCTAssertFalse(css.contains("#"), "不得出现 id 选择器（上游结构）")
        XCTAssertNil(css.range(of: #"\.[A-Za-z_-]"#, options: .regularExpression),
                     "不得出现 class 选择器（上游结构）")
    }

    /// 注入契约的字面量锁步：改名必须同时改 design 25 §5.2 与自检口径
    /// （此前只按常量比对常量，变异"改标记属性名/改 installedMarker"全绿 —— 对抗复核 m5/m6）。
    func testInjectionContractLiteralsAreLocked() {
        XCTAssertEqual(ShellOverscrollPolicy.styleElementAttribute, "data-dsh-shell-overscroll")
        XCTAssertEqual(ShellOverscrollPolicy.styleElementMarkerValue, "none")
        XCTAssertEqual(ShellOverscrollPolicy.installedMarker,
                       "/* dsh-chamber-overscroll-policy-installed */")
    }

    /// 注入源码面：无未解析占位符、三个 JS 字面量逐一锁步、保留 DOM 就绪防护。
    /// （不用 `contains(styleElementMarkerValue)`——值是 "none"，规则里本就有 none，那种断言恒真。）
    func testSourceHasNoUnresolvedPlaceholder() {
        let source = ShellOverscrollPolicy.source
        XCTAssertFalse(source.contains("$" + "{"),
                       "未解析占位符会让每次导航抛 SyntaxError（B1 回归面）")
        XCTAssertTrue(source.contains("var CSS = '\(ShellOverscrollPolicy.rootOverscrollCSS)';"),
                      "注入串必须带着当前根规则文本")
        XCTAssertTrue(source.contains("var MARKER = '\(ShellOverscrollPolicy.styleElementAttribute)';"))
        XCTAssertTrue(source.contains("var VALUE = '\(ShellOverscrollPolicy.styleElementMarkerValue)';"))
        XCTAssertTrue(source.contains("DOMContentLoaded"), "host 缺失时的 DOM 就绪防护")
    }

    /// 真正执行注入源码（JavaScriptCore + DOM 桩）：样式元素被创建，规则与标记正确，
    /// selector 角色正确（变异成 script[...] 必须红），且**始终落 documentElement**——
    /// 桩刻意让 head 存在（未来 WebKit 时序），仍断言 head 未收到元素。
    func testSourceExecutesAgainstStubDOMAndAppliesRootRule() throws {
        let context = try XCTUnwrap(JSContext())
        context.evaluateScript("""
        var __appended = null;
        var __headAppended = null;
        var __selectors = [];
        var document = {
          querySelector: function (sel) { __selectors.push(String(sel)); return null; },
          addEventListener: function () {},
          createElement: function () { return { setAttribute: function (k, v) { this[k] = v; }, textContent: '' }; },
          head: { appendChild: function (el) { __headAppended = el; } },
          documentElement: { appendChild: function (el) { __appended = el; } }
        };
        """)
        context.evaluateScript(ShellOverscrollPolicy.source)
        if let exception = context.exception {
            return XCTFail("注入源码执行抛错：\(exception)")
        }
        let appended = context.objectForKeyedSubscript("__appended")
        XCTAssertFalse(appended?.isUndefined ?? true, "documentElement.appendChild 未被调用")
        XCTAssertEqual(appended?.isNull, false, "必须落一个样式元素")
        XCTAssertEqual(context.objectForKeyedSubscript("__headAppended")?.isNull, true,
                       "即使 head 存在也必须落 documentElement（head 重写免疫）")
        XCTAssertEqual(context.evaluateScript("__selectors.length")?.toInt32(), 1)
        XCTAssertEqual(context.evaluateScript("__selectors[0]")?.toString(),
                       "style[\(ShellOverscrollPolicy.styleElementAttribute)]",
                       "幂等守卫必须查 style 元素；变异成别的标签会静默失效")
        XCTAssertEqual(context.evaluateScript("__appended.textContent")?.toString(),
                       ShellOverscrollPolicy.rootOverscrollCSS)
        let marker = context.evaluateScript(
            "__appended['\(ShellOverscrollPolicy.styleElementAttribute)']")?.toString()
        XCTAssertEqual(marker, ShellOverscrollPolicy.styleElementMarkerValue)
    }

    /// host 都取不到时就绪防护：不插入元素、注册一次 DOMContentLoaded（once）。
    func testSourceRegistersDomReadyGuardWhenNoHost() throws {
        let context = try XCTUnwrap(JSContext())
        context.evaluateScript("""
        var __listeners = [];
        var __inserts = 0;
        var document = {
          querySelector: function () { return null; },
          addEventListener: function (type, fn, opts) { __listeners.push({ type: type, once: !!(opts && opts.once) }); },
          createElement: function () { __inserts++; return { setAttribute: function () {}, textContent: '' }; },
          head: null,
          documentElement: null
        };
        """)
        context.evaluateScript(ShellOverscrollPolicy.source)
        if let exception = context.exception {
            return XCTFail("注入源码执行抛错：\(exception)")
        }
        XCTAssertEqual(context.evaluateScript("__inserts")?.toInt32(), 0, "host 缺失时不得插入")
        XCTAssertEqual(context.evaluateScript("__listeners.length")?.toInt32(), 1)
        XCTAssertEqual(context.evaluateScript("__listeners[0].type")?.toString(), "DOMContentLoaded")
        XCTAssertEqual(context.evaluateScript("__listeners[0].once")?.toBool(), true)
    }

    /// 就绪防护的**生效面**：注册的回调在 host 出现后必须真的插入元素
    /// （此前只钉注册契约，回调换成空函数仍绿 —— 对抗复核发现 3）。
    func testDomReadyGuardAppliesWhenHostAppears() throws {
        let context = try XCTUnwrap(JSContext())
        context.evaluateScript("""
        var __listeners = [];
        var __appended = null;
        var document = {
          querySelector: function () { return null; },
          addEventListener: function (type, fn, opts) { __listeners.push({ type: type, fn: fn, once: !!(opts && opts.once) }); },
          createElement: function () { return { setAttribute: function (k, v) { this[k] = v; }, textContent: '' }; },
          head: null,
          documentElement: null
        };
        """)
        context.evaluateScript(ShellOverscrollPolicy.source)
        if let exception = context.exception {
            return XCTFail("注入源码执行抛错：\(exception)")
        }
        XCTAssertEqual(context.evaluateScript("__listeners.length")?.toInt32(), 1)
        // DOM 就绪：documentElement 出现后调用注册的回调。
        context.evaluateScript("document.documentElement = { appendChild: function (el) { __appended = el; } }; __listeners[0].fn();")
        if let exception = context.exception {
            return XCTFail("就绪回调执行抛错：\(exception)")
        }
        XCTAssertEqual(context.objectForKeyedSubscript("__appended")?.isNull, false,
                       "就绪回调必须真的插入样式元素")
        XCTAssertEqual(context.evaluateScript("__appended.textContent")?.toString(),
                       ShellOverscrollPolicy.rootOverscrollCSS)
    }

    /// 标记已在时不得重复插入（重载/二次执行幂等）。
    func testSourceIsIdempotentWhenMarkerExists() throws {
        let context = try XCTUnwrap(JSContext())
        context.evaluateScript("""
        var __inserts = 0;
        var __selectors = [];
        var document = {
          querySelector: function (sel) { __selectors.push(String(sel)); return { tagName: 'STYLE' }; },
          addEventListener: function () {},
          createElement: function () { __inserts++; return { setAttribute: function () {}, textContent: '' }; },
          head: null,
          documentElement: { appendChild: function () {} }
        };
        """)
        context.evaluateScript(ShellOverscrollPolicy.source)
        if let exception = context.exception {
            return XCTFail("注入源码执行抛错：\(exception)")
        }
        XCTAssertEqual(context.evaluateScript("__inserts")?.toInt32(), 0, "标记已在 → 不再插入")
        XCTAssertEqual(context.evaluateScript("__selectors[0]")?.toString(),
                       "style[\(ShellOverscrollPolicy.styleElementAttribute)]")
    }

    /// 用户脚本契约：documentStart、仅主 frame、带显式安装标记（逐字节锁步）。
    func testUserScriptContract() {
        let script = ShellOverscrollPolicy.makeUserScript()
        XCTAssertEqual(script.source,
                       ShellOverscrollPolicy.installedMarker + "\n" + ShellOverscrollPolicy.source)
        XCTAssertEqual(script.injectionTime, .atDocumentStart)
        XCTAssertTrue(script.isForMainFrameOnly, "越界效果只属于主文档，iframe 子文档保持自身行为")
    }

    /// 幂等 + 不挤掉兄弟脚本：A 桥 shim 与本策略各自独立安装，二次安装 no-op。
    func testInstallIsIdempotentAndKeepsSiblingScripts() {
        let config = WKWebViewConfiguration()
        XCTAssertFalse(ShellOverscrollPolicy.isInstalled(in: config), "新 configuration 未安装")

        XCTAssertTrue(BridgeShimInjector.install(config: config, source: "var shim = 1"))
        XCTAssertTrue(ShellOverscrollPolicy.install(config: config))
        XCTAssertEqual(config.userContentController.userScripts.count, 2)
        XCTAssertTrue(ShellOverscrollPolicy.isInstalled(in: config))

        XCTAssertFalse(ShellOverscrollPolicy.install(config: config),
                       "已安装 → 二次 install 必须 no-op")
        XCTAssertEqual(config.userContentController.userScripts.count, 2, "绝不重复注册")
        XCTAssertTrue(BridgeShimInjector.isInstalled(in: config), "不得挤掉 A 桥 shim")
    }

    /// 装配锁步：策略"有效"由探针证明，"壳真的装了它"只能在这里钉住——
    /// 删掉或后移 MainWindowController 的 install 调用，此前所有门禁仍绿而 S-50 原样回归。
    func testMainWindowInstallsPolicyBeforeWebViewConstruction() throws {
        let source = try repoFile("macos/Sources/DSHChamberPoc/MainWindowController.swift")
        let install = try XCTUnwrap(
            source.range(of: "ShellOverscrollPolicy.install(config: configuration)"),
            "装配点消失：视口越界策略不再被壳安装")
        // 锚在真正的构造语句上：弱锚 "WKWebView(frame:" 也出现在 refresh-rate 的装配注释里，
        // 会让注释提前满足排序断言（2026-12 合并 refresh-rate 后实测红）。
        let construction = try XCTUnwrap(
            source.range(of: "let webView = WKWebView(frame:"), "找不到 WKWebView 构造点，装配锁步失效")
        XCTAssertLessThan(install.lowerBound, construction.lowerBound,
                          "策略必须在 WKWebView 构造之前注册进 configuration")
        XCTAssertEqual(source.components(separatedBy: "let webView = WKWebView(frame:").count, 2,
                       "只应存在一处 WKWebView 构造点")
        // 同款：注释里有 "BridgeShimInjector.install 负责…"，带左括号的才是调用点。
        let shim = try XCTUnwrap(
            source.range(of: "BridgeShimInjector.install("), "A 桥 shim 装配点消失")
        XCTAssertLessThan(shim.lowerBound, install.lowerBound, "注入顺序：shim 先于策略")
    }

    /// 文档字面量锁步：design 25 里硬写的规则文本与标记属性必须与常量一致，
    /// 否则"协同改名"会静默漂移（源与文档各说各话 —— 对抗复核 m12/m12b）。
    func testDesignDocCarriesTheLivePolicyLiterals() throws {
        let doc = try repoFile("docs/design/25-macos-swift-native-shell.md")
        XCTAssertTrue(doc.contains(ShellOverscrollPolicy.rootOverscrollCSS),
                      "design 25 必须写出现行根规则文本：\(ShellOverscrollPolicy.rootOverscrollCSS)")
        XCTAssertTrue(doc.contains(ShellOverscrollPolicy.styleElementAttribute),
                      "design 25 必须写出现行标记属性：\(ShellOverscrollPolicy.styleElementAttribute)")
    }
}
