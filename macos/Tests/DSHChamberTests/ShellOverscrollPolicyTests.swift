//
//  ShellOverscrollPolicyTests.swift
//  DSHChamberTests
//
//  design 25 §5.2「视口越界（根级弹性回弹）与壳侧策略」的正式测试面
//  （§8.6「壳视图策略」行）：
//  ① rootOverscrollCSS 的语义要点——只落文档根（html/body）、值为 none、
//     !important 压过页面普通声明；逐容器 contain 是 §5.2 已拒绝的备选。
//  ② install(config:) 的注入契约——实际注册进 WKUserContentController 的
//     WKUserScript 内容与 rootOverscrollCSS 一致、时机/作用域以 WKUserScript
//     实际属性断言、幂等（同一 configuration 只注册 1 条）。page world 没有
//     公开 getter（见 testFactoryKeepsThePageWorldInitializer…），以文档化
//     构造路径的源码锁补齐。
//  ③ MainWindowController 装配点源码锁——install 必须在 WKWebView 构造前
//     （configuration 段）；注释剥离纪律与 ShellIdentityTests /
//     ShellWindowChromeTests 同款，注释里的调用不算装配点。
//
//  判据边界：这里只锁「策略在册（契约）」，视口实际效果（整页不再平移、CSP
//  生效性）仍归实机目检（§8.5 矩阵 / S-50）。CSS 文本不做整串黄金值——只锁
//  选择器与关键声明，空白/换行调整不该变红。
//
import XCTest
import WebKit
@testable import DSHChamber

final class ShellOverscrollPolicyTests: XCTestCase {

    // MARK: - ① CSS 语义要点

    /// 规则必须落在文档根（html，以及 body 自身成为滚动容器的页面），值 none，
    /// 且带 !important；选择器不得指向任何滚动容器。
    func testRootOverscrollCSSDeclaresNoneOnTheDocumentRootOnly() throws {
        let compact = ShellOverscrollPolicy.rootOverscrollCSS
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        XCTAssertEqual(compact.filter { $0 == "{" }.count, 1,
                       "策略只允许一条规则（文本可重排，但结构不得漂移）")
        let brace = try XCTUnwrap(compact.firstIndex(of: "{"),
                                  "规则形态应为 selector { declaration }")
        let selector = String(compact[..<brace]).trimmingCharacters(in: .whitespaces)
        let declaration = String(compact[compact.index(after: brace)...])
            .trimmingCharacters(in: .whitespaces)

        XCTAssertEqual(selector.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) },
                       ["html", "body"],
                       "选择器必须恰为文档根 html/body（body 只对自身成为滚动容器的页面生效）；"
                       + "不得指向任何滚动容器")
        XCTAssertTrue(declaration.contains("overscroll-behavior: none !important"),
                      "none 关闭视口自身越界与向视口外链接；!important 压过页面普通声明"
                      + "（层叠边界见 §5.2）")
        XCTAssertTrue(declaration.hasSuffix("}"), "规则形态应为 selector { … }")
    }

    /// 只关视口越界：逐容器 contain（§5.2 Rejected alternatives）与改滚动范围
    /// 都属于被拒绝的备选，不得出现在策略文本里。
    func testRootOverscrollCSSLeavesScrollContainersAndTheirRangesAlone() {
        let css = ShellOverscrollPolicy.rootOverscrollCSS
        XCTAssertFalse(css.contains("contain"),
                       "逐容器 overscroll-behavior: contain 是已拒绝备选（要按上游类名改滚动语义）")
        XCTAssertFalse(css.contains("overflow"),
                       "不得改任何滚动容器的滚动范围（策略只关视口越界与向视口外链接）")
    }

    // MARK: - ② 注入契约（WKUserScript 实际属性）

    /// 实际注册进 configuration 的脚本：内容与 rootOverscrollCSS 单源一致，
    /// 时机 = documentStart、作用域 = 仅主 frame（以 WKUserScript 实例属性断言，
    /// 不看策略源码的字面量）。
    func testInstallInjectsExactlyOneDocumentStartMainFrameScriptCarryingTheCSS() throws {
        let config = WKWebViewConfiguration()
        XCTAssertFalse(ShellOverscrollPolicy.isInstalled(in: config),
                       "新建 configuration 必须尚未安装")

        XCTAssertTrue(ShellOverscrollPolicy.install(config: config), "首次安装必须报告生效")
        XCTAssertTrue(ShellOverscrollPolicy.isInstalled(in: config), "安装后判据必须为真")

        let ours = config.userContentController.userScripts.filter {
            $0.source.hasPrefix(ShellOverscrollPolicy.installedMarker)
        }
        XCTAssertEqual(ours.count, 1, "同一 configuration 只允许注册 1 条策略脚本")
        let script = try XCTUnwrap(ours.first)
        XCTAssertTrue(script.source.contains(ShellOverscrollPolicy.rootOverscrollCSS),
                      "注入的用户脚本必须携带 rootOverscrollCSS 单源文本")
        XCTAssertTrue(script.source.contains(ShellOverscrollPolicy.styleElementAttribute),
                      "样式元素标记属性必须随脚本注入（实机自检按它在册）")
        XCTAssertEqual(script.injectionTime, .atDocumentStart,
                       "必须 documentStart（WKUserScript 实际属性）：早于页面内容，"
                       + "页面重写 head 也删不掉")
        XCTAssertTrue(script.isForMainFrameOnly,
                      "仅主 frame：iframe 子文档保留自身越界行为，视口效果只属于主文档")
    }

    /// 幂等：第二次 install 是 no-op，脚本清单逐条不变（不重复装配）。
    func testInstallIsIdempotentAndNeverDuplicatesTheScript() {
        let config = WKWebViewConfiguration()
        ShellOverscrollPolicy.install(config: config)
        let sources = config.userContentController.userScripts.map(\.source)

        XCTAssertFalse(ShellOverscrollPolicy.install(config: config),
                       "已安装 → no-op（返回 false），绝不重复注册")
        XCTAssertEqual(config.userContentController.userScripts.map(\.source), sources,
                       "第二次 install 不得改动既有脚本清单")
        XCTAssertEqual(sources.filter { $0.hasPrefix(ShellOverscrollPolicy.installedMarker) }.count, 1,
                       "策略脚本恒为 1 条")
    }

    /// WKUserScript 没有公开的 contentWorld getter（本机 swiftc -typecheck 实测：
    /// value of type 'WKUserScript' has no member 'contentWorld'）。WebKit 头文件
    /// 明确 3 参构造器 == inContentWorld: WKContentWorld.pageWorld；故此处锁工厂
    /// 确实走 3 参构造器、且从不显式传入任何 content world。命名/隔离世界里的脚本
    /// 看不见页面样式，显式传 world 会变成「装配了但不生效」——这条锁防的正是它。
    func testFactoryKeepsThePageWorldInitializerWithoutAnExplicitContentWorld() throws {
        let code = try uncommentedSource("Sources/DSHChamber/ShellOverscrollPolicy.swift")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        XCTAssertTrue(code.contains("WKUserScript(source:"),
                      "策略必须经 WKUserScript 公开构造器注入")
        XCTAssertTrue(code.contains("injectionTime: .atDocumentStart, forMainFrameOnly: true)"),
                      "3 参构造器 = 文档化的 pageWorld 路径（documentStart + 仅主 frame）")
        XCTAssertFalse(code.contains("inContentWorld"),
                       "不得显式传 content world（命名/隔离世界看不见页面样式）")
        XCTAssertFalse(code.contains("WKContentWorld"),
                       "不得显式引用 content world（3 参构造器的 pageWorld 缺省即目标）")
    }

    // MARK: - ③ 装配点源码锁

    /// MainWindowController 必须在 WKWebView 构造前（configuration 段、与 A 桥
    /// shim 同段）调用 install；注释里的调用不算装配点。
    func testMainWindowControllerInstallsBeforeConstructingTheWebView() throws {
        let code = try uncommentedSource("Sources/DSHChamber/MainWindowController.swift")
        let configRange = try XCTUnwrap(code.range(of: "let configuration = WKWebViewConfiguration()"),
                                        "装配段必须从 configuration 开始")
        let installRange = try XCTUnwrap(
            code.range(of: "ShellOverscrollPolicy.install(config: configuration)"),
            "MainWindowController 必须调用 ShellOverscrollPolicy.install(config:)")
        let webViewRange = try XCTUnwrap(code.range(of: "WKWebView(frame:"),
                                         "找不到 WKWebView(frame:configuration:) 构造点")
        XCTAssertEqual(
            code.components(separatedBy: "ShellOverscrollPolicy.install(config: configuration)").count - 1,
            1, "装配点必须唯一（不得散落多处）")
        XCTAssertLessThan(configRange.lowerBound, installRange.lowerBound,
                          "install 必须落在 configuration 段")
        XCTAssertLessThan(installRange.lowerBound, webViewRange.lowerBound,
                          "install 必须在 WKWebView 构造前——页面创建后再注册不生效")
    }

    // MARK: - 源码锁工具（注释剥离，与 ShellIdentityTests 同款纪律）

    /// 读 macos/ 下的源码文件（#filePath 定位仓库内路径）。
    private func macosSource(_ relative: String) throws -> String {
        // #filePath = <repo>/macos/Tests/DSHChamberTests/ShellOverscrollPolicyTests.swift
        let macosDir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // DSHChamberTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // macos
        return try String(contentsOf: macosDir.appendingPathComponent(relative),
                          encoding: .utf8)
    }

    /// 读源码并剥注释：把真声明注释掉、只在注释里留一份旧声明必须变红
    /// （直接 contains 会假绿）。
    private func uncommentedSource(_ relative: String) throws -> String {
        Self.strippingComments(try macosSource(relative))
    }

    /// 去掉 Swift 源码里的行注释与块注释（块注释支持嵌套）与 XML 注释；
    /// 双引号字符串字面量（含 """…"""）里的注释符不算注释，注释字符替换为
    /// 空白（保留换行）。与 ShellIdentityTests.strippingComments 同构，去掉
    /// 了它服务 JS 的单引号/反引号分支（本文件只读 Swift 源码）。
    private static func strippingComments(_ text: String) -> String {
        let chars = Array(text)
        var out = ""
        out.reserveCapacity(chars.count)
        var index = 0
        var blockDepth = 0
        var inLineComment = false
        var inXMLComment = false
        var inString = false
        var inMultilineString = false
        var escaped = false
        while index < chars.count {
            let ch = chars[index]
            if inLineComment {
                if ch == "\n" { inLineComment = false; out.append(ch) } else { out.append(" ") }
                index += 1
                continue
            }
            if blockDepth > 0 {
                if ch == "/" && index + 1 < chars.count && chars[index + 1] == "*" {
                    blockDepth += 1
                    out.append("  ")
                    index += 2
                    continue
                }
                if ch == "*" && index + 1 < chars.count && chars[index + 1] == "/" {
                    blockDepth -= 1
                    out.append("  ")
                    index += 2
                    continue
                }
                out.append(ch == "\n" ? ch : " ")
                index += 1
                continue
            }
            if inXMLComment {
                if ch == "-" && index + 2 < chars.count
                    && chars[index + 1] == "-" && chars[index + 2] == ">" {
                    inXMLComment = false
                    out.append("   ")
                    index += 3
                    continue
                }
                out.append(ch == "\n" ? ch : " ")
                index += 1
                continue
            }
            if inMultilineString {
                if !escaped && ch == "\"" && index + 2 < chars.count
                    && chars[index + 1] == "\"" && chars[index + 2] == "\"" {
                    inMultilineString = false
                    out.append("\"\"\"")
                    index += 3
                    continue
                }
                out.append(ch)
                if escaped { escaped = false } else if ch == "\\" { escaped = true }
                index += 1
                continue
            }
            if inString {
                out.append(ch)
                if escaped {
                    escaped = false
                } else if ch == "\\" {
                    escaped = true
                } else if ch == "\"" {
                    inString = false
                }
                index += 1
                continue
            }
            // 代码区：注释起点 / 字符串起点
            if ch == "/" && index + 1 < chars.count && chars[index + 1] == "/" {
                inLineComment = true
                out.append("  ")
                index += 2
                continue
            }
            if ch == "/" && index + 1 < chars.count && chars[index + 1] == "*" {
                blockDepth = 1
                out.append("  ")
                index += 2
                continue
            }
            if ch == "<" && index + 3 < chars.count && chars[index + 1] == "!"
                && chars[index + 2] == "-" && chars[index + 3] == "-" {
                inXMLComment = true
                out.append("    ")
                index += 4
                continue
            }
            if ch == "\"" {
                if index + 2 < chars.count && chars[index + 1] == "\""
                    && chars[index + 2] == "\"" {
                    inMultilineString = true
                    out.append("\"\"\"")
                    index += 3
                    continue
                }
                inString = true
                out.append(ch)
                index += 1
                continue
            }
            out.append(ch)
            index += 1
        }
        return out
    }
}
