//
//  ShellStartupTests.swift
//  DSHChamberPocTests
//
//  启动面纯逻辑单测：
//    - S2 StartupSettings：chamber-settings.json 的 missing/false/true/corrupt；
//    - S11 ControlPlanePort：POC_PORT > DSH_CHAMBER_CP_PORT > dev 探测 /
//      packaged 缺省，非法值/探测耗尽抛错；真实 bind 探针 smoke；
//    - S14 POCDebug 开关（默认关闭）与 BoundedEdgeReplyGuard 有界窗口；
//    - S13 窗口菜单 performClose/performMiniaturize；
//    - S3 sidecar 缺失精确文案。
//
import XCTest
@testable import DSHChamberPoc

final class ShellStartupTests: XCTestCase {

    // MARK: - S2：StartupSettings

    private func tempUserData() throws -> String {
        let dir = NSTemporaryDirectory() + "dsh-chamber-startup-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return dir
    }

    func testStartupSettingsMissingFileIsDefaultWithoutApply() throws {
        let dir = try tempUserData()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        XCTAssertEqual(StartupSettings.readKeepAwake(userDataDir: dir), .missing)
        var applied = false
        let didApply = StartupSettings.apply(.missing) { _ in
            applied = true
            return (nil, nil)
        }
        XCTAssertFalse(didApply)
        XCTAssertFalse(applied, "缺文件 = 默认 off，不调腿、无日志噪音")
    }

    func testStartupSettingsReadsFalseAndTrue() throws {
        let dir = try tempUserData()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let path = dir + "/" + StartupSettings.fileName
        for value in ["false", "true"] {
            try "{\"keepAwake\": \(value)}".write(toFile: path, atomically: true, encoding: .utf8)
            let expected = value == "true"
            XCTAssertEqual(StartupSettings.readKeepAwake(userDataDir: dir), .ok(keepAwake: expected))
            var applied: Bool?
            let didApply = StartupSettings.apply(.ok(keepAwake: expected)) { on in
                applied = on
                return (nil, nil)
            }
            XCTAssertTrue(didApply)
            XCTAssertEqual(applied, expected, "settings UI 同一 setKeepAwake 腿必须收到值")
        }
    }

    func testStartupSettingsCorruptIsLoudDefaultWithoutApply() throws {
        let dir = try tempUserData()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let path = dir + "/" + StartupSettings.fileName
        try "not-json{".write(toFile: path, atomically: true, encoding: .utf8)
        guard case .corrupt = StartupSettings.readKeepAwake(userDataDir: dir) else {
            return XCTFail("损坏文件必须报 corrupt（loud + 默认），不得静默假默认")
        }
        var applied = false
        let didApply = StartupSettings.apply(.corrupt(reason: "x")) { _ in
            applied = true
            return (nil, nil)
        }
        XCTAssertFalse(didApply)
        XCTAssertFalse(applied)
        // keepAwake 类型损坏（非布尔）同样是 corrupt 而非静默重解释。
        try "{\"keepAwake\": 1}".write(toFile: path, atomically: true, encoding: .utf8)
        guard case .corrupt = StartupSettings.readKeepAwake(userDataDir: dir) else {
            return XCTFail("keepAwake 非布尔必须报 corrupt")
        }
        // keepAwake 缺省 → Electron 默认 false。
        try "{\"quitConfirmation\": true}".write(toFile: path, atomically: true, encoding: .utf8)
        XCTAssertEqual(StartupSettings.readKeepAwake(userDataDir: dir), .ok(keepAwake: false))
    }


    func testStartupSettingsMirrorsElectronWholeFileValidation() throws {
        let dir = try tempUserData()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let path = dir + "/" + StartupSettings.fileName
        // 跨键损坏：keepAwake 本身合法，但 Electron 的 isValidSettingsFile
        // （chamber-settings.ts:222-262）判整个文件损坏 → Swift 必须同判
        // （2026-12 验证轮缺陷：旧实现只看 keepAwake 键，会把 Electron 判为
        // 损坏的文件当合法采信）。
        let corruptCases: [String] = [
            "{\"keepAwake\": true, \"registryOrigin\": 123}",
            "{\"keepAwake\": true, \"registryOrigin\": \"http://registry.example\"}",
            "{\"keepAwake\": true, \"registryOrigin\": \"https://user:pw@registry.example\"}",
            "{\"keepAwake\": true, \"registryOrigin\": \"https://registry.example/v2\"}",
            "{\"keepAwake\": true, \"launchAtLogin\": \"yes\"}",
            "{\"keepAwake\": true, \"windowCloseBehavior\": \"explode\"}",
            "{\"keepAwake\": true, \"notifications\": {\"mode\": \"sometimes\"}}",
            "{\"keepAwake\": true, \"notifications\": {\"enabled\": 1}}",
            "{\"keepAwake\": true, \"sessionTodo\": {\"enabled\": \"yes\"}}",
            "{\"keepAwake\": true, \"sessionTodo\": []}",
        ]
        for json in corruptCases {
            try json.write(toFile: path, atomically: true, encoding: .utf8)
            guard case .corrupt = StartupSettings.readKeepAwake(userDataDir: dir) else {
                return XCTFail("整文件形状非法必须报 corrupt：" + json)
            }
        }
        // 未知键容忍（前瞻兼容）；合法混合文件照常取值。
        let valid = "{\"keepAwake\": true, \"futureKey\": {\"x\": 1}, \"notifications\": {\"mode\": \"always\", \"enabled\": false}}"
        try valid.write(toFile: path, atomically: true, encoding: .utf8)
        XCTAssertEqual(StartupSettings.readKeepAwake(userDataDir: dir), .ok(keepAwake: true))

        // no-follow 纪律（readPrivateFileNoFollow 同规）：符号链接叶与多硬链接
        // 叶都按不可读处理，绝不透过链接读。
        try? FileManager.default.removeItem(atPath: path)
        let target = dir + "/real-settings.json"
        try "{\"keepAwake\": true}".write(toFile: target, atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(atPath: path, withDestinationPath: target)
        guard case .corrupt = StartupSettings.readKeepAwake(userDataDir: dir) else {
            return XCTFail("符号链接叶必须被拒绝（no-follow 纪律）")
        }
        try? FileManager.default.removeItem(atPath: path)
        try "{\"keepAwake\": true}".write(toFile: path, atomically: true, encoding: .utf8)
        try FileManager.default.linkItem(atPath: path, toPath: dir + "/hardlink.json")
        guard case .corrupt = StartupSettings.readKeepAwake(userDataDir: dir) else {
            return XCTFail("多硬链接叶必须被拒绝（no-follow 纪律）")
        }
    }


    /// 2026-12 第二轮验证：与 Electron readSettingsFile 的 9 个分歧样本逐例对齐
    /// （BOM、重复键、WHATWG 容错、%2e/%2f 点段语义）。
    func testStartupSettingsValidatorMatchesElectronEdgeCases() throws {
        let cases: [(json: String, expectCorrupt: Bool, note: String)] = [
            ("{\"keepAwake\": true, \"registryOrigin\": \"https://example.com?\"}", false, "空 query 视为无"),
            ("{\"keepAwake\": true, \"registryOrigin\": \"https://example.com#\"}", false, "空 fragment 视为无"),
            ("{\"keepAwake\": true, \"registryOrigin\": \"https:example.com\"}", false, "省略 // 的 https"),
            ("{\"keepAwake\": true, \"registryOrigin\": \"https://example.com/%2e\"}", false, "%2e 点段归一为根"),
            ("{\"keepAwake\": true, \"registryOrigin\": \"https://example.com/a/..\"}", false, ".. 点段归一为根"),
            ("{\"keepAwake\": true, \"registryOrigin\": \"https://example.com/%2f\"}", true, "转义斜杠保持非根路径"),
            // JSON 里用转义 \t（裸控制字符是非法 JSON）；解析出的字符串含制表符，
            // WHATWG 会剥掉它后再判 origin。
            ("{\"keepAwake\": true, \"registryOrigin\": \"https://example.com\\t\"}", false, "WHATWG 剥制表符"),
            ("{\"keepAwake\": true, \"registryOrigin\": \"https://user:pw@example.com\"}", true, "userinfo"),
            ("{\"keepAwake\": true, \"registryOrigin\": \"https://example.com/v2\"}", true, "非根路径"),
            ("{\"keepAwake\": true, \"registryOrigin\": \"https://example.com?a=1\"}", true, "非空 query"),
            ("{\"keepAwake\": true, \"registryOrigin\": \"http://example.com\"}", true, "非 https"),
        ]
        for item in cases {
            let outcome = StartupSettings.decodeKeepAwake(fromJSON: Data(item.json.utf8))
            if item.expectCorrupt {
                guard case .corrupt = outcome else { return XCTFail("应判损坏（" + item.note + "）：" + item.json) }
            } else {
                XCTAssertEqual(outcome, .ok(keepAwake: true), "应判合法（" + item.note + "）：" + item.json)
            }
        }
        // UTF-8 BOM：JSON.parse 拒绝、JSONSerialization 接受 → 必须判损坏。
        let bom = Data([0xEF, 0xBB, 0xBF] + Array("{\"keepAwake\": true}".utf8))
        guard case .corrupt = StartupSettings.decodeKeepAwake(fromJSON: bom) else {
            return XCTFail("UTF-8 BOM 必须判损坏（与 JSON.parse 同规）")
        }
        // 顶层键重复：JSON.parse 取最后、JSONSerialization 取第一个 → 必须判损坏。
        guard case .corrupt = StartupSettings.decodeKeepAwake(
            fromJSON: Data("{\"keepAwake\": true, \"keepAwake\": \"x\"}".utf8)) else {
            return XCTFail("重复顶层键必须判损坏（不猜哪一个生效）")
        }
        // 嵌套对象的键不算顶层重复。
        XCTAssertEqual(
            StartupSettings.decodeKeepAwake(
                fromJSON: Data("{\"keepAwake\": true, \"notifications\": {\"enabled\": true}}".utf8)),
            .ok(keepAwake: true))
    }


    /// 2026-12 第三轮验证：这些锚点 Electron 的 normalizeRegistryOrigin 一律拒绝，
    /// Swift 先前放行（fail-open）。严格主机字符集 + 端口范围把它们全部收回。
    func testStartupSettingsStrictOriginRejectsElectronFailOpenCases() {
        let backslash = String(Unicode.Scalar(0x5C)!)
        let control = String(Unicode.Scalar(0x01)!)
        let rejected = [
            "https://example.com" + backslash + "a",
            "https://exa" + backslash + "mple.com",
            "https://example.com:65536",
            "https://example.com:0",
            "https://exa mple.com",
            "https://exa" + control + "mple.com",
            "https://example.com%2f",
            "https://ex]ample.com",
            "https://user@example.com",
            "https://example.com/path",
            "https://example.com?a=1",
            "http://example.com",
        ]
        for origin in rejected {
            XCTAssertFalse(StartupSettings.isAllowedRegistryOrigin(origin), "必须拒绝：" + origin)
        }
        let accepted = [
            "https://registry.npmjs.org",
            "https://example.com:8443",
            "https://example.com?",
            "https://example.com#",
            "https:example.com",
            "https://example.com/%2e",
            "https://example.com/a/..",
        ]
        for origin in accepted {
            XCTAssertTrue(StartupSettings.isAllowedRegistryOrigin(origin), "必须接受：" + origin)
        }
    }

    /// 2026-12 第三轮验证：非 UTF-8 字节流、超上限文件、转义写法的重复键都必须
    /// 判损坏（JSON.parse 只接受 UTF-8 且对重复键取最后值）。
    func testStartupSettingsRejectsNonUTF8OverSizeAndEscapedDuplicates() throws {
        let dir = try tempUserData()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let path = dir + "/" + StartupSettings.fileName
        let json = "{\"keepAwake\": true}"
        let utf16 = json.data(using: .utf16LittleEndian)!
        try utf16.write(to: URL(fileURLWithPath: path))
        guard case .corrupt = StartupSettings.readKeepAwake(userDataDir: dir) else {
            return XCTFail("UTF-16LE（无 BOM）必须判损坏（JSON.parse 只接受 UTF-8）")
        }
        try Data([0xFF, 0xFE] + Array(utf16)).write(to: URL(fileURLWithPath: path))
        guard case .corrupt = StartupSettings.readKeepAwake(userDataDir: dir) else {
            return XCTFail("UTF-16LE BOM 必须判损坏")
        }
        try Data([0x00, 0x00, 0xFE, 0xFF]).write(to: URL(fileURLWithPath: path))
        guard case .corrupt = StartupSettings.readKeepAwake(userDataDir: dir) else {
            return XCTFail("UTF-32BE BOM 必须判损坏")
        }
        // 超过 1 MiB：绝不截断成合法文档（固定缓冲会把「合法 JSON + 尾部垃圾」读成合法）。
        var oversized = Data(json.utf8)
        oversized.append(Data(repeating: 0x20, count: (1 << 20) + 10))
        try oversized.write(to: URL(fileURLWithPath: path))
        guard case .corrupt = StartupSettings.readKeepAwake(userDataDir: dir) else {
            return XCTFail("超过 1 MiB 必须判损坏（不得截断）")
        }
        // 转义写法的重复顶层键：必须判损坏（否则 keepAwake 被静默取第一个值）。
        let backslash = String(Unicode.Scalar(0x5C)!)
        let escapedDuplicate = "{\"keepAwake\": false, \"" + backslash + "u006beepAwake\": true}"
        guard case .corrupt = StartupSettings.decodeKeepAwake(fromJSON: Data(escapedDuplicate.utf8)) else {
            return XCTFail("转义写法重复键必须判损坏")
        }
        try Data(json.utf8).write(to: URL(fileURLWithPath: path))
        XCTAssertEqual(StartupSettings.readKeepAwake(userDataDir: dir), .ok(keepAwake: true))
    }


    /// 2026-12 第四轮验证：嵌套层级的重复键、端口前导 '+'、非法主机码点都必须
    /// 判损坏/拒绝（此前三处 fail-open）。
    func testStartupSettingsClosesNestedDuplicateAndHostFailOpens() {
        let nestedDuplicates = [
            "{\"keepAwake\": false, \"notifications\": {\"mode\": \"always\", \"mode\": \"bogus\"}}",
            "{\"keepAwake\": true, \"notifications\": {\"enabled\": false, \"enabled\": 1}}",
            "{\"keepAwake\": true, \"sessionTodo\": {\"enabled\": true, \"enabled\": \"x\"}}",
        ]
        for json in nestedDuplicates {
            guard case .corrupt = StartupSettings.decodeKeepAwake(fromJSON: Data(json.utf8)) else {
                return XCTFail("嵌套重复键必须判损坏：" + json)
            }
        }
        let nbsp = String(Unicode.Scalar(0x00A0)!)
        let lineSeparator = String(Unicode.Scalar(0x2028)!)
        let ideographicSpace = String(Unicode.Scalar(0x3000)!)
        // 2026-12 第五轮验证：RTL 字母（缺 bidi 上下文）、Arabic-Indic 数字、私用区
        // 与 UTS46 不许的字母都必须拒绝（此前 isLetter||isNumber 会放行）。
        let hebrewAlef = String(Unicode.Scalar(0x05D0)!)
        let arabicIndicDigit = String(Unicode.Scalar(0x0660)!)
        let privateUse = String(Unicode.Scalar(0xF882)!)
        let disallowedLetter = String(Unicode.Scalar(0x037A)!)
        let rejected = [
            "https://example.com:+80",
            "https://example.com:+000080",
            "https://exa" + nbsp + "mple.com",
            "https://exa" + lineSeparator + "mple.com",
            "https://exa" + ideographicSpace + "mple.com",
            "https://exa" + hebrewAlef + "mple.com",
            "https://exa" + arabicIndicDigit + "mple.com",
            "https://exa" + privateUse + "mple.com",
            "https://exa" + disallowedLetter + "mple.com",
        ]
        for origin in rejected {
            XCTAssertFalse(StartupSettings.isAllowedRegistryOrigin(origin), "必须拒绝：" + origin)
        }
        // Unicode 字母/数字（IDN 常见面）仍放行。
        XCTAssertTrue(StartupSettings.isAllowedRegistryOrigin(
            "https://ex" + String(Unicode.Scalar(0x00E4)!) + "mple.com"))
        XCTAssertTrue(StartupSettings.isAllowedRegistryOrigin(
            "https://" + String(Unicode.Scalar(0x4F8B)!) + String(Unicode.Scalar(0x3048)!) + ".com"))
    }

    // MARK: - S11：ControlPlanePort

    func testPortResolutionPrecedenceAndPackagedDefault() throws {
        XCTAssertEqual(try ControlPlanePort.resolve(
            env: ["POC_PORT": "18001", "DSH_CHAMBER_CP_PORT": "18002"],
            isPackaged: false, probeDevPort: { _ in 19999 }).port, 18001)
        XCTAssertEqual(try ControlPlanePort.resolve(
            env: ["DSH_CHAMBER_CP_PORT": "18002"], isPackaged: false,
            probeDevPort: { _ in 19999 }).port, 18002)
        XCTAssertEqual(try ControlPlanePort.resolve(
            env: [:], isPackaged: true, probeDevPort: nil),
            .init(port: 17500, source: .packagedDefault), "packaged 行为不变：固定 17500")
        XCTAssertEqual(try ControlPlanePort.resolve(
            env: [:], isPackaged: false, probeDevPort: { $0 + 3 }),
            .init(port: 17523, source: .devProbe))
        // 自定义 sidecar 形状（不探测）→ dev 固定缺省
        XCTAssertEqual(try ControlPlanePort.resolve(
            env: [:], isPackaged: false, probeDevPort: nil),
            .init(port: 17520, source: .devDefault))
    }

    func testPortResolutionRejectsInvalidAndExhausted() {
        XCTAssertThrowsError(try ControlPlanePort.resolve(
            env: ["POC_PORT": "abc"], isPackaged: false, probeDevPort: nil)) { error in
            XCTAssertEqual(error as? ControlPlanePort.ResolutionError,
                           .invalidExplicitPort(key: "POC_PORT", value: "abc"))
        }
        XCTAssertThrowsError(try ControlPlanePort.resolve(
            env: ["DSH_CHAMBER_CP_PORT": "70000"], isPackaged: false, probeDevPort: nil))
        XCTAssertThrowsError(try ControlPlanePort.resolve(
            env: [:], isPackaged: false, probeDevPort: { _ in nil })) { error in
            XCTAssertEqual(error as? ControlPlanePort.ResolutionError,
                           .noFreeDevPort(start: 17520, attempts: 200))
        }
    }

    func testRealSidecarScriptShape() {
        XCTAssertTrue(ControlPlanePort.isRealSidecarScript("/a/sidecar.js"))
        XCTAssertTrue(ControlPlanePort.isRealSidecarScript("/repo/packages/desktop/sidecar-entry.ts"))
        XCTAssertFalse(ControlPlanePort.isRealSidecarScript("/repo/packages/desktop/poc-sidecar.ts"))
        XCTAssertFalse(ControlPlanePort.isRealSidecarScript("/custom/entry.mjs"))
    }

    /// 真实 bind 探针 smoke：返回的高位端口落在探测区间（真 socket 路径）。
    func testProbeFreePortReturnsPortInRange() {
        guard let port = ControlPlanePort.probeFreePort(startingAt: 49200, attempts: 50) else {
            return XCTFail("49200…49249 应至少有一个空闲端口")
        }
        XCTAssertGreaterThanOrEqual(port, 49200)
        XCTAssertLessThanOrEqual(port, 49249)
    }

    // MARK: - S14：POCDebug / BoundedEdgeReplyGuard

    func testPOCDebugDefaultsOff() {
        XCTAssertFalse(POCDebug.isEnabled(environment: [:]))
        XCTAssertFalse(POCDebug.isEnabled(environment: ["POC_DEBUG": "0"]))
        XCTAssertFalse(POCDebug.isEnabled(environment: ["POC_DEBUG": "true"]))
        XCTAssertTrue(POCDebug.isEnabled(environment: ["POC_DEBUG": "1"]))
    }

    func testBoundedEdgeReplyGuardWindow() {
        var guardWindow = BoundedEdgeReplyGuard(capacity: 2)
        XCTAssertTrue(guardWindow.firstInsert(1))
        XCTAssertFalse(guardWindow.firstInsert(1), "窗口内重复 → false")
        XCTAssertTrue(guardWindow.firstInsert(2))
        XCTAssertTrue(guardWindow.firstInsert(3), "满员淘汰最旧后仍可插入")
        XCTAssertFalse(guardWindow.contains(1), "1 已被淘汰")
        XCTAssertTrue(guardWindow.contains(2))
        XCTAssertTrue(guardWindow.contains(3))
        XCTAssertFalse(guardWindow.firstInsert(2), "仍在窗口内 → 重复")
        guardWindow.removeAll()
        XCTAssertEqual(guardWindow.count, 0)
        XCTAssertTrue(guardWindow.firstInsert(1), "清空后可重新插入")
    }

    // MARK: - S13：窗口菜单

    func testWindowMenuCarriesCloseAndMiniaturizeSelectors() {
        let menu = AppDelegate.makeMainMenu()
        guard let windowMenu = menu.items.compactMap({ $0.submenu })
            .first(where: { $0.title == "窗口" }) else {
            return XCTFail("主菜单缺少「窗口」子菜单（S13）")
        }
        let closeItem = windowMenu.items.first { $0.action == #selector(NSWindow.performClose(_:)) }
        let miniItem = windowMenu.items.first { $0.action == #selector(NSWindow.performMiniaturize(_:)) }
        XCTAssertNotNil(closeItem, "窗口菜单应含 performClose（Cmd+W）")
        XCTAssertNotNil(miniItem, "窗口菜单应含 performMiniaturize（Cmd+M）")
        XCTAssertEqual(closeItem?.keyEquivalent, "w")
        XCTAssertEqual(miniItem?.keyEquivalent, "m")
    }

    // MARK: - S3：sidecar 缺失文案 / S11 端口来源标签

    func testMissingSidecarMessageIsPrecise() {
        let packaged = AppDelegate.missingSidecarMessage(
            isPackaged: true, resourcesDir: "/A.app/Contents/Resources")
        XCTAssertTrue(packaged.contains("/A.app/Contents/Resources/sidecar/sidecar.js"))
        let dev = AppDelegate.missingSidecarMessage(isPackaged: false, resourcesDir: nil)
        XCTAssertTrue(dev.contains("packages/desktop/sidecar-entry.ts"))
        XCTAssertTrue(dev.contains("POC_SIDECAR"))
        let explicit = AppDelegate.missingSidecarMessage(
            isPackaged: false, resourcesDir: nil, explicitPath: "/gone/sidecar.js")
        XCTAssertEqual(explicit, "POC_SIDECAR 指向的 sidecar 脚本不存在：/gone/sidecar.js")
    }

    func testPortSourceLabelsAreExplicit() {
        XCTAssertEqual(AppDelegate.portSourceLabel(.envPOC), "POC_PORT 显式覆盖")
        XCTAssertEqual(AppDelegate.portSourceLabel(.envDSH), "DSH_CHAMBER_CP_PORT 显式覆盖")
        XCTAssertEqual(AppDelegate.portSourceLabel(.packagedDefault), "打包默认")
        XCTAssertTrue(AppDelegate.portSourceLabel(.devProbe).contains("退避"))
    }
}
