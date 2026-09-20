//
//  ShellIdentityTests.swift
//  DSHChamberTests
//
//  T-1（2026-12 用户指令）：可见标识暂时标记为 dsh-chamber——窗口标题、
//  失败说明页文案、About（Info.plist CFBundleName）的锁步断言，防止
//  "poc"/"DSHChamber" 再露到用户可见面；T-4 首帧白闪的底色 token 同处钉住。
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

    func testVisibleDisplayNameCarriesTheProductNameWithoutPocOrModuleName() {
        XCTAssertEqual(MainWindowController.displayName, Self.displayName)
        XCTAssertFalse(MainWindowController.displayName.lowercased().contains("poc"),
                       "可见产品名不得出现 poc")
    }

    /// T-17 锁步（R2 复核发现原缺口）：Info.plist 的 CFBundleExecutable（活动监视器
    /// 显示的进程名）必须与打包脚本的可执行名单源一致——两处任一手写漂移都会产出
    /// 指向不存在可执行文件的 .app，而 codesign --verify 抓不到这种形状错误。
    func testBundleExecutableMatchesBuildScriptExecutableName() throws {
        let compact = try macosSource("Info.plist.template")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        XCTAssertTrue(compact.contains("<key>CFBundleExecutable</key> <string>\(Self.displayName)</string>"),
                      "CFBundleExecutable 必须等于可见产品名（= 打包脚本 EXECUTABLE_NAME）")
        let script = try macosSource("scripts/build-swift-app.mjs")
        XCTAssertTrue(script.contains("export const EXECUTABLE_NAME = APP_NAME"),
                      "可执行名单源：EXECUTABLE_NAME 必须派生自 APP_NAME")
        XCTAssertTrue(script.contains("export const APP_NAME = '\(Self.displayName)'"),
                      "APP_NAME 必须与可见名同源")
    }

    /// 资源包名跨语言锁步（R2 复核发现原缺口）：SwiftPM 产物名 = `<Module>_<Module>.bundle`
    /// （`Package.swift` 的 target 名），而运行期定位用的 `ChamberResources.bundleName` 是
    /// 手写常量、`release.yml` 里还有一处字面量路径——三处漂移会让运行期静默找不到 shim
    /// 资源（只在打包态由 P-18 fail-closed 暴露）。
    func testResourceBundleNameMatchesBuildScriptModuleAndWorkflow() throws {
        let script = try macosSource("scripts/build-swift-app.mjs")
        let range = try XCTUnwrap(
            script.range(of: "export const MODULE_NAME = '([^']+)'", options: .regularExpression),
            "build-swift-app.mjs 必须声明 MODULE_NAME")
        let module = String(script[range])
            .replacingOccurrences(of: "export const MODULE_NAME = '", with: "")
            .dropLast()
        XCTAssertEqual(ChamberResources.bundleName, "\(module)_\(module).bundle",
                       "资源包名必须与打包脚本 MODULE_NAME 同源（SwiftPM: <Module>_<Module>.bundle）")
        let release = try macosSource("../.github/workflows/release.yml")
        XCTAssertTrue(release.contains("/Contents/Resources/\(ChamberResources.bundleName)/bridge-shim.js"),
                      "release.yml 的资源包断言必须与 ChamberResources.bundleName 同源")
    }

    func testWindowTitleIsDisplayNameConstant() throws {
        let source = try macosSource("Sources/DSHChamber/MainWindowController.swift")
        XCTAssertTrue(source.contains("window.title = Self.displayName"),
                      "窗口标题必须走 displayName 单源（T-1）")
        XCTAssertFalse(source.contains("window.title = \"dsh-chamber\""),
                       "标题不得再抄一份字面量（单源）")
        XCTAssertFalse(source.contains("window.title = \"dsh-chamber-native\""),
                       "旧标题 dsh-chamber-native 不得回归")
        XCTAssertFalse(source.contains("window.title = \"DSHChamber\""))
    }

    func testFailurePageCopyCarriesNativeNameAndRealReason() {
        let sidecarFailure = "sidecar 启动失败（exit=70）：Error: listen EADDRINUSE: "
            + "address already in use 127.0.0.1:17500。已有另一个 dsh-chamber 实例在运行"
            + "（端口 127.0.0.1:17500 被占用），请先退出它再重试"
        let html = MainWindowController.failurePageHTML(
            hint: "sidecar 启动失败，控制面未能启动。",
            detail: "The resource could not be loaded because the App Transport Security "
                + "policy requires the use of a secure connection.",
            cpURL: "http://127.0.0.1:17500/",
            sidecarFailure: sidecarFailure)
        XCTAssertTrue(html.contains("<title>\(Self.displayName)</title>"),
                      "失败页文档标题必须是可见产品名")
        XCTAssertTrue(html.contains("无法加载 \(Self.displayName) 界面"),
                      "失败页 H2 必须是可见产品名")
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
        let xml = try macosSource("Info.plist.template")
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

        let source = try macosSource("Sources/DSHChamber/MainWindowController.swift")
        XCTAssertTrue(source.contains("window.backgroundColor = Self.windowBackgroundColor"),
                      "窗口底色必须设（T-4）")
        XCTAssertTrue(source.contains(
            "webView.underPageBackgroundColor = Self.windowBackgroundColor"))
        XCTAssertTrue(source.contains("setDrawsBackground:"),
                      "透明 webview 露出同色窗口底（T-4）")
    }

    /// C4（2026-09 评审）：唤醒/激活腿必须落盘。print-only 时 Dock 启动的 .app
    /// stdout 无处可看——native-shell.log 里零条唤醒行既不能证明「发过」，也不能
    /// 证明「没发」（只能靠反汇编），真机验收分不开「壳没发」与「页面没消费」。
    func testWakeAndActivationLegsLogDurably() throws {
        let source = try macosSource("Sources/DSHChamber/MainWindowController.swift")
        XCTAssertTrue(source.contains("shellLog(\"[shell] 系统唤醒——发送 __host.systemResume\")"),
                      "唤醒腿必须写 shellLog（落盘）")
        XCTAssertTrue(source.contains("shellLog(\"[shell] 应用激活——发送 __host.mainWindowShown\")"),
                      "held-resume 补发点（didBecomeActive）必须落盘")
        XCTAssertFalse(source.contains("print(\"[shell] 系统唤醒"), "唤醒腿不得退回 print-only")
        XCTAssertFalse(source.contains("print(\"[shell] 应用激活"), "激活腿不得退回 print-only")
        // 失败分支与 hop3 同样必须落盘（2026-09 评审：catch 与壳→页面这一跳
        // 此前是 print-only，真机分不开「没发/没推」与「页面没消费」）。
        XCTAssertTrue(source.contains("shellLog(\"[shell] __host.systemResume 发送失败："),
                      "唤醒发送失败（catch）必须落盘")
        XCTAssertTrue(source.contains("shellLog(\"[shell] __host.mainWindowShown 发送失败："),
                      "激活发送失败（catch）必须落盘")
        XCTAssertTrue(source.contains("shellLog(\"[shell] notify rendererPush → 页面 emit"),
                      "shell → 页面 emit 这一跳必须落盘（C4 hop3）")
        XCTAssertFalse(source.contains("print(\"[shell] notify rendererPush"), "不得退回 print-only")
        XCTAssertTrue(source.contains("shellLog(\"[shell] 页面 emit 失败"),
                      "emit 失败必须可考古（JS 抛错 = 页面没收到）")
        // 同一缺陷类的其余推送面（2026-09 复核）也不得退回 print-only。
        XCTAssertTrue(source.contains("shellLog(\"[shell] hostFacts 推送 "),
                      "hostFacts 推送必须落盘")
        XCTAssertTrue(source.contains("shellLog(\"[shell] rendererLifecycle 上报 "),
                      "rendererLifecycle 上报必须落盘")
        XCTAssertFalse(source.contains("print(\"[shell] hostFacts 推送"), "不得退回 print-only")
        XCTAssertFalse(source.contains("print(\"[shell] rendererLifecycle 上报"), "不得退回 print-only")
    }
}
