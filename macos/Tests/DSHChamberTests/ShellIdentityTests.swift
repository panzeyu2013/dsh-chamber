//
//  ShellIdentityTests.swift
//  DSHChamberTests
//
//  可见标识暂时标记为 dsh-chamber——窗口标题、
//  失败说明页文案、About（Info.plist CFBundleName）的锁步断言，防止
//  "poc"/"DSHChamber" 再露到用户可见面；首帧白闪的底色 token 同处钉住。
//
import XCTest
@testable import DSHChamber

final class ShellIdentityTests: XCTestCase {

    static let displayName = "dsh-chamber"

    private func macosSource(_ relative: String) throws -> String {
        // #filePath = <repo>/macos/Tests/DSHChamberTests/ShellIdentityTests.swift
        let macosDir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // DSHChamberTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // macos
        return try String(contentsOf: macosDir.appendingPathComponent(relative),
                          encoding: .utf8)
    }

    // MARK: - 注释剥离

    /// 去掉源码里的行注释与块注释（// 与 /* */，块注释支持嵌套）与 XML 注释
    /// （<!-- -->）；字符串字面量（"…" / """…""" / `…` / '…'）里的注释符不算注释。
    /// 注释字符替换为空白（保留换行），供"只匹配未注释代码"的断言：把真声明注释掉、
    /// 只在注释里留一份旧声明必须变红（直接 contains 会假绿）。
    /// - Parameter nestedBlockComments: Swift 的块注释可嵌套；JS（build-swift-app.mjs）
    ///   不可——其头部注释里的 `*.dmg/*.zip` 这类文本会误开一层嵌套，导致真声明被
    ///   整段吞掉（实测：MODULE_NAME 被吞而假红）。
    private static func strippingComments(_ text: String,
                                          nestedBlockComments: Bool = true) -> String {
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
                if nestedBlockComments, ch == "/" && index + 1 < chars.count
                    && chars[index + 1] == "*" {
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
                } else if ch == "\"" || ch == "`" || ch == "'" {
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
            if ch == "`" || ch == "'" {
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

    /// YAML（release.yml）的 `#` 行注释：`#` 处于行首或空白之后且不在引号内才算
    /// 注释（YAML 无块注释）；同样服务于"只匹配未注释代码"。
    private static func strippingHashComments(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            let chars = Array(line)
            var out = ""
            var inSingle = false
            var inDouble = false
            var index = 0
            while index < chars.count {
                let ch = chars[index]
                if ch == "'" && !inDouble {
                    inSingle.toggle()
                } else if ch == "\"" && !inSingle {
                    inDouble.toggle()
                } else if ch == "#" && !inSingle && !inDouble
                    && (index == 0 || chars[index - 1] == " " || chars[index - 1] == "\t") {
                    break
                }
                out.append(ch)
                index += 1
            }
            return out
        }.joined(separator: "\n")
    }

    /// 读源码并剥注释（注释里的旧声明不算声明）。JS 不嵌套块注释（Swift 可）。
    private func uncommentedSource(_ relative: String) throws -> String {
        let text = try macosSource(relative)
        return Self.strippingComments(
            text,
            nestedBlockComments: !(relative.hasSuffix(".mjs") || relative.hasSuffix(".js")))
    }

    /// 非注释代码里「关掉 WKWebView 的 drawsBackground」的真实调用点：
    /// ① DSHChamberWebKitSupport 的异常安全包装 DSHChamberSetDrawsBackground(…, false)；
    /// ② KVC 直设 setValue(false, forKey: "drawsBackground")。包装体可在别的文件
    /// （ObjC target），本文件必须留下至少一处调用点。
    private static func invokesDrawsBackgroundMechanism(_ code: String) -> Bool {
        if code.range(of: #"DSHChamberSetDrawsBackground\s*\(\s*[^)]*,\s*false\s*\)"#,
                      options: .regularExpression) != nil { return true }
        return code.range(of: #"setValue\(\s*false\s*,\s*forKey:\s*"drawsBackground""#,
                          options: .regularExpression) != nil
    }

    func testVisibleDisplayNameCarriesTheProductNameWithoutPocOrModuleName() {
        XCTAssertEqual(MainWindowController.displayName, Self.displayName)
        XCTAssertFalse(MainWindowController.displayName.lowercased().contains("poc"),
                       "可见产品名不得出现 poc")
    }

    /// Info.plist 的 CFBundleExecutable（活动监视器
    /// 显示的进程名）必须与打包脚本的可执行名单源一致——两处任一手写漂移都会产出
    /// 指向不存在可执行文件的 .app，而 codesign --verify 抓不到这种形状错误。
    func testBundleExecutableMatchesBuildScriptExecutableName() throws {
        let compact = try uncommentedSource("Info.plist.template")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        XCTAssertTrue(compact.contains("<key>CFBundleExecutable</key> <string>\(Self.displayName)</string>"),
                      "CFBundleExecutable 必须等于可见产品名（= 打包脚本 EXECUTABLE_NAME；注释不算声明）")
        let script = try uncommentedSource("scripts/build-swift-app.mjs")
        XCTAssertTrue(script.contains("export const EXECUTABLE_NAME = APP_NAME"),
                      "可执行名单源：EXECUTABLE_NAME 必须派生自 APP_NAME")
        XCTAssertTrue(script.contains("export const APP_NAME = '\(Self.displayName)'"),
                      "APP_NAME 必须与可见名同源")
    }

    /// 资源包名跨语言锁步：SwiftPM 产物名 = `<Module>_<Module>.bundle`
    /// （`Package.swift` 的 target 名），而运行期定位用的 `ChamberResources.bundleName` 是
    /// 手写常量、`release.yml` 里还有一处字面量路径——三处漂移会让运行期静默找不到 shim
    /// 资源（只在打包态由 fail-closed 暴露）。
    func testResourceBundleNameMatchesBuildScriptModuleAndWorkflow() throws {
        let script = try uncommentedSource("scripts/build-swift-app.mjs")
        let range = try XCTUnwrap(
            script.range(of: "export const MODULE_NAME = '([^']+)'", options: .regularExpression),
            "build-swift-app.mjs 必须声明 MODULE_NAME")
        let module = String(script[range])
            .replacingOccurrences(of: "export const MODULE_NAME = '", with: "")
            .dropLast()
        XCTAssertEqual(ChamberResources.bundleName, "\(module)_\(module).bundle",
                       "资源包名必须与打包脚本 MODULE_NAME 同源（SwiftPM: <Module>_<Module>.bundle）")
        // YAML 的 # 行注释同样剥掉：注释里的旧路径不算锁步证据。
        let release = Self.strippingHashComments(
            try macosSource("../.github/workflows/release.yml"))
        XCTAssertTrue(release.contains("/Contents/Resources/\(ChamberResources.bundleName)/bridge-shim.js"),
                      "release.yml 的资源包断言必须与 ChamberResources.bundleName 同源")
    }

    /// 本地化标识符（en / zh-Hans）在 Swift 侧只剩
    /// ShellPageLanguage.localizationIdentifier 一个入口；作为同一集合镜像的
    /// build-swift-app.mjs LOCALIZATIONS、Package.swift 的两个 .process("…lproj")、
    /// Info.plist.template 的 CFBundleLocalizations 同处一套集合，故读
    /// 源码逐集合锁步：任一漂移（少一项/多一项/拼写变体）即红。解析失败在断言
    /// 消息里写明所期望的源形态。解析前先剥注释——把真声明
    /// 注释掉、只在注释里留一份旧声明同样红。
    func testLocalizationIdentifiersLockstepAcrossBuildInputs() throws {
        let expected = Set(ShellPageLanguage.allCases.map { $0.localizationIdentifier })
        XCTAssertEqual(expected, ["en", "zh-Hans"],
                       "ShellPageLanguage.localizationIdentifier 集合必须恰为 en / zh-Hans")

        let script = try uncommentedSource("scripts/build-swift-app.mjs")
        guard let declaration = script.range(
            of: #"export const LOCALIZATIONS = \[([^\]]*)\]"#,
            options: .regularExpression) else {
            return XCTFail("build-swift-app.mjs 解析失败：找不到期望形态 "
                + "\"export const LOCALIZATIONS = ['en', 'zh-Hans']\"")
        }
        let scriptIDs = Set(capturedGroups(in: String(script[declaration]),
                                           pattern: #"'([^']+)'"#))
        XCTAssertEqual(scriptIDs, expected,
                       "build-swift-app.mjs 的 LOCALIZATIONS 必须与 ShellPageLanguage "
                       + "的标识符集合一致：脚本=\(scriptIDs.sorted()) 期望=\(expected.sorted())")

        let package = try uncommentedSource("Package.swift")
        let packageIDs = Set(capturedGroups(
            in: package, pattern: #"\.process\("Resources/([^"]+)\.lproj"\)"#))
        guard !packageIDs.isEmpty else {
            return XCTFail("Package.swift 解析失败：找不到期望形态 "
                + "\".process(\"Resources/en.lproj\")\" 或 "
                + "\".process(\"Resources/zh-Hans.lproj\")\"")
        }
        XCTAssertEqual(packageIDs, expected,
                       "Package.swift 的 .process(\"…lproj\") 必须与 ShellPageLanguage "
                       + "的标识符集合一致：Package=\(packageIDs.sorted()) 期望=\(expected.sorted())")

        let plist = try uncommentedSource("Info.plist.template")
        guard let key = plist.range(of: "<key>CFBundleLocalizations</key>"),
              let end = plist.range(of: "</array>",
                                    range: key.upperBound..<plist.endIndex) else {
            return XCTFail("Info.plist.template 解析失败：找不到期望形态 "
                + "\"<key>CFBundleLocalizations</key>\" 后跟 "
                + "<array><string>…</string></array>")
        }
        let plistIDs = Set(capturedGroups(in: String(plist[key.lowerBound..<end.upperBound]),
                                          pattern: #"<string>([^<]+)</string>"#))
        XCTAssertEqual(plistIDs, expected,
                       "Info.plist.template 的 CFBundleLocalizations 必须与 ShellPageLanguage "
                       + "的标识符集合一致：plist=\(plistIDs.sorted()) 期望=\(expected.sorted())")
    }

    /// 取出文本中某正则捕获组 1 的逐次命中（按出现顺序）；无命中/组未参与返回空。
    private func capturedGroups(in text: String, pattern: String) -> [String] {
        guard let regex = try? NSRegularExpression(
            pattern: pattern, options: [.dotMatchesLineSeparators]) else { return [] }
        let ns = text as NSString
        return regex.matches(in: text, range: NSRange(location: 0, length: ns.length))
            .compactMap { match in
                guard match.numberOfRanges > 1,
                      match.range(at: 1).location != NSNotFound else { return nil }
                return ns.substring(with: match.range(at: 1))
            }
    }

    func testWindowTitleIsDisplayNameConstant() throws {
        let source = try uncommentedSource("Sources/DSHChamber/MainWindowController.swift")
        XCTAssertTrue(source.contains("window.title = Self.displayName"),
                      "窗口标题必须走 displayName 单源（T-1）")
        XCTAssertFalse(source.contains("window.title = \"dsh-chamber\""),
                       "标题不得再抄一份字面量（单源）")
        XCTAssertFalse(source.contains("window.title = \"dsh-chamber-native\""),
                       "旧标题 dsh-chamber-native 不得回归")
        XCTAssertFalse(source.contains("window.title = \"DSHChamber\""))
    }

    func testFailurePageCopyCarriesNativeNameAndRealReason() {
        // 真实报文走生产构造（不是手抄的中文整句）：期望值随语言变，
        // 机器语言为 en 时失败页里嵌的也是 en 的诚实报错。
        let sidecarFailure = SidecarStartupFailure.make(
            exitCode: 70,
            stderr: "Error: listen EADDRINUSE: address already in use 127.0.0.1:17500").message
        let html = MainWindowController.failurePageHTML(
            hint: "sidecar 启动失败，控制面未能启动。",
            detail: "The resource could not be loaded because the App Transport Security "
                + "policy requires the use of a secure connection.",
            cpURL: "http://127.0.0.1:17500/",
            sidecarFailure: sidecarFailure)
        XCTAssertTrue(html.contains("<title>\(Self.displayName)</title>"),
                      "失败页文档标题必须是可见产品名")
        XCTAssertTrue(html.contains(NativeText.format(.failureHeading, Self.displayName)),
                      "失败页 H2 必须是 failure.heading 的本地化模板 + 可见产品名")
        XCTAssertTrue(html.contains("EADDRINUSE") && html.contains("127.0.0.1:17500"),
                      "失败页必须带 sidecar 的真实原因（T-3）")
        XCTAssertFalse(html.lowercased().contains("poc"))
        XCTAssertFalse(html.contains("DSHChamber"))
    }

    func testFailurePageEscapesInjectedText() {
        let html = MainWindowController.failurePageHTML(
            hint: "h",
            detail: "<script>alert(1)</script>",
            cpURL: "http://127.0.0.1:17500/",
            sidecarFailure: "a & b")
        XCTAssertFalse(html.contains("<script>"))
        XCTAssertTrue(html.contains("&lt;script&gt;"))
        XCTAssertTrue(html.contains("a &amp; b"))
    }

    func testInfoPlistTemplateBundleNameMatchesVisibleMarker() throws {
        let xml = try uncommentedSource("Info.plist.template")
        let compact = xml.replacingOccurrences(of: "\\s+", with: " ",
                                               options: .regularExpression)
        XCTAssertTrue(compact.contains("<key>CFBundleName</key> <string>\(Self.displayName)</string>"),
                      "About 面板读 CFBundleName——必须与可见标记同源")
        XCTAssertFalse(compact.contains("<key>CFBundleName</key> <string>DSHChamber</string>"))
    }

    func testWindowAndWebViewUseFrontendBackgroundToken() throws {
        // #0f1115 = rgb(15, 17, 21)：与 Electron backgroundColor 及前端骨架同值。
        XCTAssertEqual(MainWindowController.backgroundRed, 15.0 / 255.0, accuracy: 0.0001)
        XCTAssertEqual(MainWindowController.backgroundGreen, 17.0 / 255.0, accuracy: 0.0001)
        XCTAssertEqual(MainWindowController.backgroundBlue, 21.0 / 255.0, accuracy: 0.0001)
        let color = try XCTUnwrap(MainWindowController.windowBackgroundColor
            .usingColorSpace(.sRGB))
        XCTAssertEqual(color.redComponent, 15.0 / 255.0, accuracy: 0.0001)
        XCTAssertEqual(color.greenComponent, 17.0 / 255.0, accuracy: 0.0001)
        XCTAssertEqual(color.blueComponent, 21.0 / 255.0, accuracy: 0.0001)
        XCTAssertEqual(color.alphaComponent, 1.0, accuracy: 0.0001)

        // 只认**非注释代码**：注释里的旧字面量不算机制（否则只剩注释的
        // `setDrawsBackground:` 会假绿）。
        let source = try uncommentedSource("Sources/DSHChamber/MainWindowController.swift")
        // 露底色的唯一判定在 ShellWindowMaterial.underPageColor（WebKit 真能透明才 clear，
        // 否则主题色）；窗口底归材质面（install 置 clear、applyBackdrop 抑制期置兜底色）。
        XCTAssertTrue(source.contains("ShellWindowMaterial.underPageColor("),
                      "露底色必须经 WebKit 透明判定")
        XCTAssertEqual(source.components(separatedBy: "window?.backgroundColor =").count - 1, 0,
                       "窗口底不得在材质面之外被改写（install/applyBackdrop 独家）")
        XCTAssertTrue(source.contains("webViewIsTransparent = drawsBackgroundOutcome == .applied"),
                      "WebKit 能否透明必须取自异常安全包装的真实结果，不得假设")
        // 上游 macOS 窗口形态（2026-09 跟随上游，升级计划 §12.6）：内容延伸进标题栏 +
        // 透明标题栏 + 最小内容尺寸 + hiddenInset 灯位 + `.sidebar` 材质
        // （ShellWindowMaterial；上游 = vibrancy:'sidebar' + visualEffectState:'active'）。
        // 「背景可拖」不在其中：命中视图恒为 WKWebView 而它的 mouseDownCanMoveWindow
        // 恒 false（实测），该开关对页面内容无效；拖动面是 ShellWindowDrag（design 25 §5.5），
        // 本行保留只是让 AppKit 自有命中视图（标题栏层）仍吃原生路径。
        XCTAssertTrue(source.contains(".fullSizeContentView"),
                      "内容延伸进标题栏（上游 titleBarStyle:'hiddenInset' 的等价物）")
        XCTAssertTrue(source.contains("window.titlebarAppearsTransparent = true"),
                      "标题栏透明：红绿灯浮在侧栏顶部")
        XCTAssertTrue(source.contains("window.titleVisibility = .hidden"),
                      "隐藏标题文字（可见标题仍投影为窗口标题）")
        XCTAssertTrue(source.contains("window.isMovableByWindowBackground = true"),
                      "保留的原生兜底（只对 AppKit 自有命中视图生效；页面内容的拖动面见 ShellWindowDrag）")
        XCTAssertTrue(source.contains("window.contentMinSize = NSSize(width: 880, height: 600)"),
                      "chamber 自有最小内容尺寸（上游 desktop main 是 520×600，三栏布局装不下）")
        XCTAssertTrue(source.contains(
            "webView.underPageBackgroundColor = Self.windowBackgroundColor"))
        // 真实生效路径 = DSHChamberWebKitSupport 的异常安全包装
        // （DSHChamberSetDrawsBackground(webView, false)），或 KVC 直设。
        XCTAssertTrue(Self.invokesDrawsBackgroundMechanism(source),
                      "非注释代码必须真的关掉 drawsBackground（包装调用点 "
                      + "DSHChamberSetDrawsBackground(…, false) 或 "
                      + "setValue(false, forKey: \"drawsBackground\")）")
        XCTAssertFalse(source.contains("NSSelectorFromString(\"setDrawsBackground:\")"),
                       "X2：responds/selector 探测恒 false，不得再作为生效路径回归")
    }

    /// 唤醒/激活腿必须落盘。print-only 时 Dock 启动的 .app
    /// stdout 无处可看——shell.log（ShellLog.fileName）里零条唤醒行既不能证明
    /// 「发过」，也不能证明「没发」（只能靠反汇编），实机也分不开「壳没发」与
    /// 「页面没消费」。
    func testWakeAndActivationLegsLogDurably() throws {
        let source = try uncommentedSource("Sources/DSHChamber/MainWindowController.swift")
        XCTAssertTrue(source.contains("shellLog(\"[shell] 系统唤醒——发送 __host.systemResume\")"),
                      "唤醒腿必须写 shellLog（落盘）")
        XCTAssertTrue(source.contains("shellLog(\"[shell] 应用激活——发送 __host.mainWindowShown\")"),
                      "held-resume 补发点（didBecomeActive）必须落盘")
        XCTAssertFalse(source.contains("print(\"[shell] 系统唤醒"), "唤醒腿不得退回 print-only")
        XCTAssertFalse(source.contains("print(\"[shell] 应用激活"), "激活腿不得退回 print-only")
        // 失败分支与 hop3 同样必须落盘（catch 与壳→页面这一跳
        // 若是 print-only，实机分不开「没发/没推」与「页面没消费」）。
        XCTAssertTrue(source.contains("shellLog(\"[shell] __host.systemResume 发送失败："),
                      "唤醒发送失败（catch）必须落盘")
        XCTAssertTrue(source.contains("shellLog(\"[shell] __host.mainWindowShown 发送失败："),
                      "激活发送失败（catch）必须落盘")
        XCTAssertTrue(source.contains("shellLog(\"[shell] notify rendererPush → 页面 emit"),
                      "shell → 页面 emit 这一跳必须落盘（C4 hop3）")
        XCTAssertFalse(source.contains("print(\"[shell] notify rendererPush"), "不得退回 print-only")
        XCTAssertTrue(source.contains("shellLog(\"[shell] 页面 emit 失败"),
                      "emit 失败必须可考古（JS 抛错 = 页面没收到）")
        // 其余推送面同样不得是 print-only。
        XCTAssertTrue(source.contains("shellLog(\"[shell] hostFacts 推送 "),
                      "hostFacts 推送必须落盘")
        XCTAssertTrue(source.contains("shellLog(\"[shell] rendererLifecycle 上报 "),
                      "rendererLifecycle 上报必须落盘")
        XCTAssertFalse(source.contains("print(\"[shell] hostFacts 推送"), "不得退回 print-only")
        XCTAssertFalse(source.contains("print(\"[shell] rendererLifecycle 上报"), "不得退回 print-only")
    }

    /// 上游窗口面的三个等价物必须真的接上（纯函数面见 ShellWindowChromeTests）：
    /// ① 红绿灯内缩（建窗后 + `reapplyNotifications` 的每个重排时机 + 标题换值后）；
    /// ② 全屏标记（两侧通知 + 装载重放，否则页面 darwin 全屏座位规则永远拿不到
    /// `html[data-fullscreen]`）；③ 侧栏材质（`vibrancy:'sidebar'` 等价物：非不透明窗 +
    /// 清空底色，露底色按 WebKit 是否真能透明分流）。
    func testWindowChromeUpstreamFacesAreWired() throws {
        let controller = try uncommentedSource("Sources/DSHChamber/MainWindowController.swift")
        XCTAssertTrue(controller.contains(
            "ShellWindowMaterial.install(in: window, webView: webView)"),
            "建窗必须装入侧栏材质面")
        XCTAssertTrue(controller.contains(
            "windowMaterial = ShellWindowMaterial.install(in: window, webView: webView)"),
            "必须留下材质句柄（最小化/隐藏兜底要切它的 isHidden）")
        XCTAssertTrue(controller.contains("ShellWindowMaterial.applyBackdrop("),
                      "最小化/隐藏期间的材质兜底必须接线（上游 applyBackdrop 的等价面）")
        XCTAssertTrue(controller.contains("NSApplication.didHideNotification"),
                      "应用隐藏/恢复也要走材质兜底")
        XCTAssertTrue(controller.contains("if !ShellTrafficLightInset.apply(to: window) {"),
                      "建窗必须做红绿灯内缩（失败要 loud；这条 needle 只属于建窗点）")
        XCTAssertTrue(controller.contains(
            "for name in ShellTrafficLightInset.reapplyNotifications {"),
            "缩放/全屏的重排通知必须整体接线（AppKit 每次重排都把灯放回默认位）")
        XCTAssertTrue(controller.contains(
            "center.addObserver(self, selector: #selector(windowChromeLayoutDidChange(_:)),"),
            "注册必须真的指向该处理器（换掉 selector 会让处理器悬空而套件仍绿）")
        XCTAssertTrue(controller.contains(
            "if let window { ShellTrafficLightInset.apply(to: window) }"),
            "重排处理函数必须重做内缩（这条 needle 只属于处理函数）")
        XCTAssertTrue(controller.contains(
            "guard let fullscreen = ShellWindowFullscreenMark.markValue(for: note.name)"),
            "全屏通知必须写 html[data-fullscreen]")
        // 标题换值同样重排 titlebar（实测：换值即回 (16,16)，且不发任何窗口通知）：
        // 标题必须收敛到 setWindowTitle（写后重做内缩），恢复流的两处换值不得裸写。
        XCTAssertTrue(controller.contains("private func setWindowTitle(_ title: String)"),
                      "标题写入必须收敛到 setWindowTitle（写后重做内缩）")
        XCTAssertTrue(controller.contains(
            "        DispatchQueue.main.async { [weak self] in\n"
            + "            guard let window = self?.window else { return }"),
            "进出全屏要在下一轮主循环补一次内缩（space 收尾可能再排一次）")
        XCTAssertTrue(controller.contains(
            "webView.underPageBackgroundColor = ShellWindowMaterial.underPageColor("),
            "建窗收尾必须立刻按 WebKit 透明判定露底色（不等首份页面事实）")
        XCTAssertTrue(controller.contains(
            "        window.title = title\n        ShellTrafficLightInset.apply(to: window)"),
            "写标题后必须无条件重做内缩（apply 幂等，可自愈历史错位）")
        XCTAssertTrue(controller.contains(
            "setWindowTitle(Self.displayName + \" — \" + NativeText.string(.rendererCrashTitle))"),
            "崩溃放弃标题必须走 setWindowTitle")
        // 裸写窗口标题会静默丢掉灯位（换值重排且不发通知）；计数锁能拦下所有字面形态，
        // 包括曾经漏掉的 didFail 分支（design 25 §5.6）。
        XCTAssertEqual(controller.components(separatedBy: "window?.title =").count - 1, 0,
                       "不得裸写窗口标题（didFail/恢复路径都必须走 setWindowTitle）")
        XCTAssertEqual(controller.components(separatedBy: "window.title =").count - 1, 2,
                       "窗口标题只允许建窗初始写入与 setWindowTitle 内部各一次")
        XCTAssertTrue(controller.contains(
            "applyFullscreenMark(ShellWindowFullscreenMark.isFullscreen(window?.styleMask ?? []))"),
            "装载完成必须按窗口状态重放全屏标记（导航重置 document）")
        XCTAssertTrue(controller.contains(
            "webView?.underPageBackgroundColor = ShellWindowMaterial.underPageColor("),
            "露底色必须经 WebKit 透明判定（窗口底归材质面，见上）")

        let material = try uncommentedSource("Sources/DSHChamber/ShellWindowMaterial.swift")
        XCTAssertTrue(material.contains("effect.material = .sidebar"),
                      "材质必须是 .sidebar（Chromium 的 sidebar vibrancy 同物）")
        XCTAssertTrue(material.contains("effect.blendingMode = .behindWindow"),
                      "必须采样窗后桌面（.behindWindow 才是真 vibrancy）")
        XCTAssertTrue(material.contains("effect.state = .active"),
                      "对齐上游 visualEffectState:'active'（followWindow 会在失焦时冲淡侧栏，上游明确拒用）")
        XCTAssertTrue(material.contains("window.isOpaque = false"),
                      "非不透明，否则材质采样到的是窗口自己的色")
        XCTAssertTrue(material.contains("window.backgroundColor = .clear"),
                      "窗口底色必须清空")
    }
}
