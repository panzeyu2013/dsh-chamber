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

    /// 2026-12 双端逐函数核对 S3·D5 / S5·F6：launchAtLogin 启动重放读取器——
    /// 与 keepAwake 同一套文件纪律（损坏文件绝不采信单个合法键）。
    func testStartupSettingsLaunchAtLoginReader() throws {
        let dir = try tempUserData()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let path = dir + "/" + StartupSettings.fileName
        // 键缺省但文件合法 → 按 Electron 默认 false 重放（注销残留登录项）
        try "{\"keepAwake\": true}".write(toFile: path, atomically: true, encoding: .utf8)
        XCTAssertEqual(StartupSettings.readLaunchAtLogin(userDataDir: dir), false)
        // true / false 逐字读取
        try "{\"launchAtLogin\": true, \"keepAwake\": false}"
            .write(toFile: path, atomically: true, encoding: .utf8)
        XCTAssertEqual(StartupSettings.readLaunchAtLogin(userDataDir: dir), true)
        try "{\"launchAtLogin\": false}".write(toFile: path, atomically: true, encoding: .utf8)
        XCTAssertEqual(StartupSettings.readLaunchAtLogin(userDataDir: dir), false)
        // 非布尔 → nil（绝不强转）
        try "{\"launchAtLogin\": \"yes\"}".write(toFile: path, atomically: true, encoding: .utf8)
        XCTAssertNil(StartupSettings.readLaunchAtLogin(userDataDir: dir))
        // 已知键类型非法（跨键损坏）→ 整文件不可信 → nil
        try "{\"launchAtLogin\": true, \"keepAwake\": \"on\"}"
            .write(toFile: path, atomically: true, encoding: .utf8)
        XCTAssertNil(StartupSettings.readLaunchAtLogin(userDataDir: dir),
                     "跨键损坏必须整文件判损坏（与 readKeepAwake 同纪律）")
        // 缺文件 → false（重放 Electron 默认值：注销残留登录项），而非 nil
        try? FileManager.default.removeItem(atPath: path)
        XCTAssertEqual(StartupSettings.readLaunchAtLogin(userDataDir: dir), false)
        // 键缺失但文件合法 → 同样按默认 false 重放
        try "{\"keepAwake\": true}".write(toFile: path, atomically: true, encoding: .utf8)
        XCTAssertEqual(StartupSettings.readLaunchAtLogin(userDataDir: dir), false)
        // 纯函数面：合法 JSON 直测
        let data = Data("{\"launchAtLogin\": true}".utf8)
        XCTAssertEqual(StartupSettings.decodeLaunchAtLogin(fromJSON: data), true)
        XCTAssertNil(StartupSettings.decodeLaunchAtLogin(fromJSON: Data("{}".utf8)))
    }

    /// 对抗验证回归（S-41）：损坏文件只在「当时」成立——共享读取器
    /// （chamber-settings.ts；Electron main.ts 与 Swift flavor 的 sidecar-ctx.ts
    /// 同源）把损坏文件改名为 *.corrupt，下一次启动 live 文件缺失。若把
    /// 「缺失 + 副本存在」读成 missing，就会重放默认 launchAtLogin=false，
    /// 静默注销用户的登录项（一次损坏 = 一次注销）。AppDelegate 的启动读取器
    /// 必须叠加副本证据（Swift 只读不写，测试模拟共享读取器的保留动作）。
    func testReadStartupLaunchAtLoginTreatsCorruptSiblingAsIndeterminate() throws {
        let dir = try tempUserData()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let path = dir + "/" + StartupSettings.fileName
        // 第一次启动：文件损坏 → 读取器 nil（不动作）；AppDelegate 读取器同判。
        try "not-json{".write(toFile: path, atomically: true, encoding: .utf8)
        XCTAssertNil(StartupSettings.readLaunchAtLogin(userDataDir: dir))
        XCTAssertNil(AppDelegate.readStartupLaunchAtLogin(userDataDir: dir))
        // 模拟共享读取器的保留动作（sidecar-ctx.ts 启动即 readSettingsFile）。
        try FileManager.default.moveItem(atPath: path, toPath: path + ".corrupt")
        // 第二次启动：live 文件缺失 + *.corrupt 副本存在 → 仍不动作（nil）。
        XCTAssertNil(AppDelegate.readStartupLaunchAtLogin(userDataDir: dir),
                     "存在 *.corrupt 副本时不得重放默认 false（S-41 回归）")
        // 真正缺失且无副本 → 保持今天语义（重放默认 false，注销历史残留）。
        try FileManager.default.removeItem(atPath: path + ".corrupt")
        XCTAssertEqual(AppDelegate.readStartupLaunchAtLogin(userDataDir: dir), false)
        // 可读文件永远压过副本（损坏后用户重新保存设置 → 下一次启动正常应用）。
        try "{\"launchAtLogin\": true}".write(toFile: path, atomically: true, encoding: .utf8)
        try "not-json{".write(toFile: path + ".corrupt", atomically: true, encoding: .utf8)
        XCTAssertEqual(AppDelegate.readStartupLaunchAtLogin(userDataDir: dir), true)
        // 纯 seam 面（无需真实文件）：live 存在/缺失 × 副本存在/缺失。
        XCTAssertEqual(AppDelegate.readStartupLaunchAtLogin(
            userDataDir: "/nope",
            fileExists: { $0 == "/nope/chamber-settings.json" },
            readLaunchAtLogin: { _ in true }), true,
            "live 文件存在时由读取器裁决")
        XCTAssertNil(AppDelegate.readStartupLaunchAtLogin(
            userDataDir: "/nope",
            fileExists: { $0.hasSuffix(".corrupt") },
            readLaunchAtLogin: { _ in false }),
            "live 缺失 + 副本存在 → 不动作（nil），绝不采用读取器的默认 false")
        XCTAssertEqual(AppDelegate.readStartupLaunchAtLogin(
            userDataDir: "/nope",
            fileExists: { _ in false },
            readLaunchAtLogin: { _ in false }), false,
            "真正缺失（无副本）→ 保持默认 false 重放")
        // 竞态：live 在首次检查时看似存在、读取器返回默认 false 的瞬间 sidecar
        // 完成保留改名——读取后的副本复查必须改判 nil（顺序无关）。
        var liveChecks = 0
        XCTAssertNil(AppDelegate.readStartupLaunchAtLogin(
            userDataDir: "/nope",
            fileExists: { path in
                if path.hasSuffix(".corrupt") { return true }
                liveChecks += 1
                return liveChecks <= 1   // 首次检查存在，读取后复查已缺失
            },
            readLaunchAtLogin: { _ in false }),
            "保留改名与读取竞态下绝不重放默认 false")
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

    func testPortResolutionPrecedenceAndPackagedDefault() {
        XCTAssertEqual(ControlPlanePort.resolve(
            env: ["POC_PORT": "18001", "DSH_CHAMBER_CP_PORT": "18002"],
            isPackaged: false, probeDevPort: { _ in 19999 }).port, 18001)
        XCTAssertEqual(ControlPlanePort.resolve(
            env: ["DSH_CHAMBER_CP_PORT": "18002"], isPackaged: false,
            probeDevPort: { _ in 19999 }).port, 18002)
        XCTAssertEqual(ControlPlanePort.resolve(
            env: [:], isPackaged: true, probeDevPort: nil),
            .init(port: 17500, source: .packagedDefault), "packaged 行为不变：固定 17500")
        XCTAssertEqual(ControlPlanePort.resolve(
            env: [:], isPackaged: false, probeDevPort: { $0 + 3 }),
            .init(port: 17523, source: .devProbe))
        // 自定义 sidecar 形状（不探测）→ dev 固定缺省
        XCTAssertEqual(ControlPlanePort.resolve(
            env: [:], isPackaged: false, probeDevPort: nil),
            .init(port: 17520, source: .devDefault))
    }

    /// S-03（2026-12 复裁决）：非法显式端口与退避耗尽一律**降级不致命**，
    /// 对齐 Electron `resolveControlPlanePort()`（shell-core.ts:425-442）。
    func testPortResolutionDegradesInsteadOfFailing() {
        let invalidPOC = ControlPlanePort.resolve(
            env: ["POC_PORT": "abc"], isPackaged: true, probeDevPort: nil)
        XCTAssertEqual(invalidPOC.port, 17500, "非法 POC_PORT 落到打包缺省，不再致命")
        XCTAssertEqual(invalidPOC.source, .packagedDefault)
        XCTAssertTrue(invalidPOC.notices.contains { $0.contains("POC_PORT") },
                      "降级必须 loud（notices 含原因）")

        let invalidDSH = ControlPlanePort.resolve(
            env: ["DSH_CHAMBER_CP_PORT": "70000"], isPackaged: false,
            probeDevPort: { $0 + 1 })
        XCTAssertEqual(invalidDSH.port, 17521)
        XCTAssertEqual(invalidDSH.source, .devProbe)
        XCTAssertTrue(invalidDSH.notices.contains { $0.contains("DSH_CHAMBER_CP_PORT") })

        // 退避区间全占用 → 系统临时端口（注入假探针，避免真占 200 个端口）。
        let exhausted = ControlPlanePort.resolve(
            env: [:], isPackaged: false, probeDevPort: { _ in nil },
            probeEphemeralPort: { 54321 })
        XCTAssertEqual(exhausted.port, 54321)
        XCTAssertEqual(exhausted.source, .devEphemeral)
        XCTAssertFalse(exhausted.notices.isEmpty)

        // 连临时端口都拿不到 → 回退固定缺省；依然不致命。
        let hopeless = ControlPlanePort.resolve(
            env: [:], isPackaged: false, probeDevPort: { _ in nil },
            probeEphemeralPort: { nil })
        XCTAssertEqual(hopeless.port, 17520)
        XCTAssertEqual(hopeless.source, .devDefault)
        XCTAssertFalse(hopeless.notices.isEmpty)
    }

    /// 真 socket 路径：bind 0 取到的系统临时端口必须可解析且落在合法区间。
    func testProbeEphemeralPortReturnsBindablePort() {
        guard let port = ControlPlanePort.probeEphemeralPort() else {
            return XCTFail("bind 0 应能拿到系统临时端口")
        }
        XCTAssertGreaterThan(port, 0)
        XCTAssertLessThanOrEqual(port, 65535)
    }

    /// P-16：dev 退避耗尽后的最后一档必须是 **bind 0 的系统临时端口**（真
    /// socket 探针），不是固定 17520——对齐 Electron 最后一档把 port 0 交给
    /// OS（free-port.ts / shell-core.ts:425-442）。早前的优先端口不变。
    func testDevPortLastTierAsksOSForFreePortInsteadOfFixedDefault() {
        let resolved = ControlPlanePort.resolve(
            env: [:], isPackaged: false, probeDevPort: { _ in nil })
        XCTAssertEqual(resolved.source, .devEphemeral,
                       "dev 最后一档必须是系统临时端口（实际 \(resolved.source)）")
        XCTAssertNotEqual(resolved.port, ControlPlanePort.devDefault,
                          "绝不回落固定 17520")
        XCTAssertGreaterThan(resolved.port, 0)
        XCTAssertLessThanOrEqual(resolved.port, 65535)
        XCTAssertTrue(resolved.notices.contains { $0.contains("系统临时端口") },
                      "降级原因必须 loud（notices）")
        // 早前档位不变：空闲探测优先、packaged 仍固定 17500。
        XCTAssertEqual(ControlPlanePort.resolve(
            env: [:], isPackaged: false, probeDevPort: { $0 + 2 }).port,
            ControlPlanePort.devDefault + 2)
        XCTAssertEqual(ControlPlanePort.resolve(
            env: [:], isPackaged: true, probeDevPort: nil).port,
            ControlPlanePort.packagedDefault)
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

    /// 2026-12 双端逐函数核对 V5/U4：App 菜单含 About/隐藏/退出（对齐 Electron 的
    /// 系统默认菜单），窗口菜单含缩放与前置全部窗口。
    func testMainMenuCarriesStandardAppMenuItems() {
        let menu = AppDelegate.makeMainMenu()
        guard let appMenu = menu.items.first?.submenu else {
            return XCTFail("主菜单缺少 App 子菜单")
        }
        XCTAssertNotNil(appMenu.items.first { $0.action == #selector(NSApplication.orderFrontStandardAboutPanel(_:)) },
                        "App 菜单应含「关于」")
        XCTAssertNotNil(appMenu.items.first { $0.action == #selector(NSApplication.hide(_:)) },
                        "App 菜单应含「隐藏」")
        XCTAssertNotNil(appMenu.items.first { $0.action == #selector(NSApplication.hideOtherApplications(_:)) },
                        "App 菜单应含「隐藏其他」")
        XCTAssertNotNil(appMenu.items.first { $0.action == #selector(NSApplication.unhideAllApplications(_:)) },
                        "App 菜单应含「显示全部」")
        XCTAssertNotNil(appMenu.items.first { $0.action == #selector(NSApplication.terminate(_:)) },
                        "App 菜单应含「退出」")
        guard let windowMenu = menu.items.compactMap({ $0.submenu }).first(where: { $0.title == "窗口" }) else {
            return XCTFail("主菜单缺少「窗口」子菜单")
        }
        XCTAssertNotNil(windowMenu.items.first { $0.action == #selector(NSWindow.performZoom(_:)) })
        XCTAssertNotNil(windowMenu.items.first { $0.action == #selector(NSApplication.arrangeInFront(_:)) })
    }

    /// 2026-12 双端逐函数核对 S4·F1：argv 冷启动深链筛选（跳过 argv[0] 与非本 scheme）。
    func testCommandLineDeepLinkFilter() {
        let urls = AppDelegate.commandLineDeepLinks(arguments: [
            "/Applications/dsh-chamber-native.app/Contents/MacOS/DSHChamberPoc",
            "--flag",
            "dsh-chamber://open/session?x=1",
            "https://example.com",
            "dsh-chamber://second",
        ])
        XCTAssertEqual(urls, ["dsh-chamber://open/session?x=1", "dsh-chamber://second"])
        XCTAssertEqual(AppDelegate.commandLineDeepLinks(arguments: ["/bin/x"]), [])
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
        XCTAssertTrue(AppDelegate.portSourceLabel(.devEphemeral).contains("系统临时端口"))
    }

    // MARK: - P-02：ready 帧端口必须与即将加载的控制面 origin 一致

    /// 一致 → nil（可继续）；不一致 → loud 说明（调用方 fatal，绝不静默加载
    /// 错 origin）；URL 无显式端口按 scheme 默认端口比较。
    func testReadyPortMismatchDecision() {
        let match = URL(string: "http://127.0.0.1:17520/")!
        XCTAssertNil(AppDelegate.readyPortMismatchMessage(readyPort: 17520, cpURL: match))
        let mismatch = AppDelegate.readyPortMismatchMessage(readyPort: 17521, cpURL: match)
        XCTAssertNotNil(mismatch, "ready.port 与控制面 URL 端口不一致必须 loud 拒绝")
        XCTAssertTrue(mismatch?.contains("17521") ?? false)
        XCTAssertTrue(mismatch?.contains("17520") ?? false)
        // 无显式端口：http 按 80、https 按 443 比较（本地侧车不会是它们 → loud）。
        XCTAssertNil(AppDelegate.readyPortMismatchMessage(
            readyPort: 80, cpURL: URL(string: "http://127.0.0.1/")!))
        XCTAssertNil(AppDelegate.readyPortMismatchMessage(
            readyPort: 443, cpURL: URL(string: "https://127.0.0.1/")!))
        XCTAssertNotNil(AppDelegate.readyPortMismatchMessage(
            readyPort: 17520, cpURL: URL(string: "http://127.0.0.1/")!))
        // 非 http(s) URL 无法比较 → 不误报（调用方另有 origin 围栏）。
        XCTAssertNil(AppDelegate.readyPortMismatchMessage(
            readyPort: 17520, cpURL: URL(string: "file:///tmp/x")!))
    }

    // MARK: - P-17：登录自启 reconcile 必须可观察失败且不 hard-fail

    /// dev 无 bundle：腿回 no-bundle（诚实降级）→ .failed（调用方 loud 打印），
    /// 绝不 fatal/抛出；成功 → .applied；设置损坏 → .settingsCorrupt 不动作。
    func testLaunchAtLoginReconcileSurfacesFailureWithoutHardFail() {
        let dev = AppDelegate.reconcileLaunchAtLogin(true) { _ in
            (nil, "swift-edge-ui-unavailable:setLoginItem:no-bundle")
        }
        XCTAssertEqual(dev, .failed(enabled: true,
                                    error: "swift-edge-ui-unavailable:setLoginItem:no-bundle"),
                       "腿失败必须进入 .failed（可 loud），不是静默丢弃")
        XCTAssertEqual(AppDelegate.reconcileLaunchAtLogin(false) { _ in (nil, nil) },
                       .applied(enabled: false))
        XCTAssertEqual(AppDelegate.reconcileLaunchAtLogin(true) { _ in (nil, nil) },
                       .applied(enabled: true))
        XCTAssertEqual(AppDelegate.reconcileLaunchAtLogin(nil) { _ in (nil, nil) },
                       .settingsCorrupt, "损坏设置不猜值、不动作")
        // 腿必须收到设置值（enabled 逐值透传，不丢方向）。
        var received: Bool?
        _ = AppDelegate.reconcileLaunchAtLogin(false) { enabled in
            received = enabled
            return (nil, nil)
        }
        XCTAssertEqual(received, false)
    }

    // MARK: - P-18：shim 资源缺失 = fail-closed 决策

    /// 缺失/空 → 返回可见且可操作的致命说明（含已查找目录与修复动作）；
    /// 有源码 → nil（可继续）。AppDelegate 据此对齐 Electron 的
    /// showErrorBox + app.exit(1)，绝不带着无桥页面开窗。
    /// T-1：内部资源名（bridge-shim.poc.js）不得露进用户可见文案——它只进
    /// native-shell.log（AppDelegate 调用点显式落盘）。
    func testShimStartupFailsClosedWhenResourceMissing() {
        XCTAssertNil(MainWindowController.shimStartupFailure(source: "// shim"))
        let missing = MainWindowController.shimStartupFailure(source: nil)
        XCTAssertNotNil(missing)
        XCTAssertFalse((missing ?? "").lowercased().contains("poc"),
                       "T-1：用户可见启动错误不得出现 poc/内部资源名")
        XCTAssertFalse(missing?.contains(MainWindowController.shimResourceName) ?? true,
                       "内部资源名只进日志，不进提示框")
        XCTAssertTrue(missing?.contains("build:swift-app") ?? false,
                      "说明必须含可操作修复动作")
        XCTAssertNotNil(MainWindowController.shimStartupFailure(source: ""),
                        "空源码同样是缺资源（静默无桥 = fail-open）")
    }

    // MARK: - S-24：View 菜单 / Edit 扩展 / 页面缩放

    func testViewMenuCarriesReloadZoomAndFullScreen() {
        let menu = AppDelegate.makeMainMenu()
        guard let viewMenu = menu.items.compactMap({ $0.submenu })
            .first(where: { $0.title == "显示" }) else {
            return XCTFail("主菜单缺少「显示」子菜单（S-24）")
        }
        let reload = viewMenu.items.first { $0.action == #selector(AppDelegate.reloadWebView(_:)) }
        let zoomIn = viewMenu.items.first { $0.action == #selector(AppDelegate.zoomInWebView(_:)) }
        let zoomOut = viewMenu.items.first { $0.action == #selector(AppDelegate.zoomOutWebView(_:)) }
        let actual = viewMenu.items.first { $0.action == #selector(AppDelegate.resetWebViewZoom(_:)) }
        let fullScreen = viewMenu.items.first { $0.action == #selector(NSWindow.toggleFullScreen(_:)) }
        XCTAssertNotNil(reload, "View 菜单应含「重新加载」")
        XCTAssertNotNil(zoomIn, "View 菜单应含「放大」（绑 pageZoom）")
        XCTAssertNotNil(zoomOut, "View 菜单应含「缩小」（绑 pageZoom）")
        XCTAssertNotNil(actual, "View 菜单应含「实际大小」（绑 pageZoom）")
        XCTAssertNotNil(fullScreen, "View 菜单应含「切换全屏幕」")
        XCTAssertEqual(reload?.keyEquivalent, "r")
        XCTAssertEqual(zoomIn?.keyEquivalent, "+")
        XCTAssertEqual(zoomOut?.keyEquivalent, "-")
        XCTAssertEqual(actual?.keyEquivalent, "0")
        XCTAssertEqual(fullScreen?.keyEquivalent, "f")
        XCTAssertEqual(fullScreen?.keyEquivalentModifierMask, [.command, .control])
    }

    func testEditMenuCarriesStandardExtensions() {
        let menu = AppDelegate.makeMainMenu()
        guard let editMenu = menu.items.compactMap({ $0.submenu })
            .first(where: { $0.title == "编辑" }) else {
            return XCTFail("主菜单缺少「编辑」子菜单")
        }
        let pasteAndMatch = editMenu.items.first { $0.action == Selector(("pasteAndMatchStyle:")) }
        XCTAssertNotNil(pasteAndMatch, "Edit 菜单应含「粘贴并匹配样式」（S-24）")
        XCTAssertEqual(pasteAndMatch?.keyEquivalent, "v")
        XCTAssertEqual(pasteAndMatch?.keyEquivalentModifierMask, [.command, .option, .shift])
        XCTAssertNotNil(editMenu.items.first { $0.action == Selector(("delete:")) },
                        "Edit 菜单应含「删除」")
        XCTAssertNotNil(editMenu.items.first { $0.action == #selector(NSText.selectAll(_:)) },
                        "既有「全选」必须保留")
        guard let speech = editMenu.items.first(where: { $0.submenu?.title == "语音" })?.submenu else {
            return XCTFail("Edit 菜单应含「语音」子菜单（S-24）")
        }
        XCTAssertNotNil(speech.items.first { $0.action == Selector(("startSpeaking:")) })
        XCTAssertNotNil(speech.items.first { $0.action == Selector(("stopSpeaking:")) })
    }

    /// S-24（残余收口）：Help 组必须存在且保持 macOS 标准分组次序
    /// （App / 文件 / 编辑 / 显示 / 窗口 / 帮助）；唯一菜单项 = 打开项目页——
    /// 原生壳没有页面桥帮助面，这是最小且诚实的帮助入口。
    func testHelpMenuOpensProjectPageAndGroupsStayIntact() {
        let menu = AppDelegate.makeMainMenu()
        let titles = menu.items.compactMap { $0.submenu?.title }
        XCTAssertEqual(Array(titles.dropFirst()), ["文件", "编辑", "显示", "窗口", "帮助"],
                       "File 组补在最前（S-24），既有分组不得丢失/换位")
        guard let helpMenu = menu.items.compactMap({ $0.submenu })
            .first(where: { $0.title == "帮助" }) else {
            return XCTFail("主菜单缺少「帮助」子菜单（S-24）")
        }
        let help = helpMenu.items.first { $0.action == #selector(AppDelegate.openHelpPage(_:)) }
        XCTAssertNotNil(help, "Help 菜单应含项目页入口（openHelpPage）")
        XCTAssertEqual(help?.title, "dsh-chamber 帮助")
        XCTAssertEqual(help?.keyEquivalent, "?")
        XCTAssertEqual(help?.keyEquivalentModifierMask, [.command])
        XCTAssertEqual(AppDelegate.helpPageURL, "https://github.com/panzeyu2013/dsh-chamber",
                       "帮助入口必须指向项目页（唯一诚实目标，且经外部打开路径）")
    }

    /// S-24：打包态菜单绝不带 DevTools 入口（T-10：devtools 保持 #if DEBUG 可达，
    /// release 无检查器面——菜单项同样是产品面）。
    func testMainMenuHasNoDevToolsEntry() {
        let menu = AppDelegate.makeMainMenu()
        let items = menu.items.flatMap { $0.submenu?.items ?? [] }
        let devtoolsSelectors = [Selector(("toggleDevTools:")), Selector(("showDevTools:"))]
        XCTAssertFalse(items.contains { item in
            guard let action = item.action else { return false }
            return devtoolsSelectors.contains(action)
        }, "主菜单不得含 DevTools 动作（T-10）")
        XCTAssertFalse(items.contains { item in
            item.title.lowercased().contains("devtools") || item.title.contains("开发者工具")
        }, "主菜单不得含 DevTools 文案项（T-10）")
    }

    func testPageZoomSteppingClampsToRange() {
        XCTAssertEqual(MainWindowController.steppedZoom(current: 1.0, direction: 1), 1.1, accuracy: 0.0001)
        XCTAssertEqual(MainWindowController.steppedZoom(current: 1.0, direction: -1), 0.9, accuracy: 0.0001)
        XCTAssertEqual(MainWindowController.steppedZoom(current: 3.0, direction: 1), 3.0,
                       "上界 3.0 不得越界")
        XCTAssertEqual(MainWindowController.steppedZoom(current: 0.5, direction: -1), 0.5,
                       "下界 0.5 不得越界")
        XCTAssertEqual(MainWindowController.steppedZoom(current: .nan, direction: 1), 1.0,
                       "非有限值回落 1.0")
    }

    // MARK: - S-32：恢复序列（Dock/托盘/取消退出共用）

    func testRestoreActionsDeminiaturizeBeforeFocus() {
        XCTAssertEqual(MainWindowController.restoreActions(isMiniaturized: true),
                       [.deminiaturize, .makeKeyAndOrderFront],
                       "最小化窗口必须先 deminiaturize 再前置（Electron restore 对偶）")
        XCTAssertEqual(MainWindowController.restoreActions(isMiniaturized: false),
                       [.makeKeyAndOrderFront])
        MainWindowController.restoreWindow(nil)   // 无窗口 = no-op，绝不崩
    }

    // MARK: - T-11：打包态调试面与 POC_* 过滤

    func testPOCDebugForcedOffInPackagedApp() {
        XCTAssertFalse(POCDebug.isEnabled(environment: ["POC_DEBUG": "1"], isPackaged: true),
                       "打包态即使 POC_DEBUG=1 也必须关闭（产品面不带调试回传/快照）")
        XCTAssertTrue(POCDebug.isEnabled(environment: ["POC_DEBUG": "1"], isPackaged: false))
        XCTAssertFalse(POCDebug.isEnabled(environment: [:], isPackaged: false))
        XCTAssertTrue(POCDebug.isPackaged(
            executablePath: "/Applications/dsh-chamber.app/Contents/MacOS/DSHChamberPoc"))
        XCTAssertFalse(POCDebug.isPackaged(
            executablePath: "/repo/macos/.build/debug/DSHChamberPoc"))
        XCTAssertTrue(POCDebug.isPackaged(executablePath: nil), "路径不可得 → 保守按打包态")
    }

    // MARK: - S-24（残余）：File 组 / Force Reload / Substitutions

    /// Electron 默认 macOS 菜单装配次序 = appMenu/fileMenu/editMenu/viewMenu/
    /// windowMenu（Electron default-menu.ts；fileMenu = File + Close Window）。
    func testFileMenuCarriesCloseWindowAtElectronPosition() {
        let menu = AppDelegate.makeMainMenu()
        XCTAssertEqual(menu.items.indices.contains(1) ? menu.items[1].submenu?.title : nil, "文件",
                       "File 组必须在 App 之后、Edit 之前（Electron 默认菜单次序）")
        guard let fileMenu = menu.items[1].submenu else {
            return XCTFail("主菜单缺少「文件」子菜单（S-24）")
        }
        let close = fileMenu.items.first { $0.action == #selector(NSWindow.performClose(_:)) }
        XCTAssertNotNil(close, "文件菜单应含「关闭窗口」（Electron fileMenu 的 close role）")
        XCTAssertEqual(close?.keyEquivalent, "w")
    }

    func testViewMenuCarriesForceReloadWithShiftCommandR() {
        let menu = AppDelegate.makeMainMenu()
        guard let viewMenu = menu.items.compactMap({ $0.submenu })
            .first(where: { $0.title == "显示" }) else {
            return XCTFail("主菜单缺少「显示」子菜单（S-24）")
        }
        guard let force = viewMenu.items.first(where: {
            $0.action == #selector(AppDelegate.forceReloadWebView(_:))
        }) else {
            return XCTFail("View 菜单应含「强制重新加载」（S-24）")
        }
        XCTAssertEqual(force.keyEquivalent, "r", "Force Reload 的键 = R")
        XCTAssertEqual(force.keyEquivalentModifierMask, [.command, .shift],
                       "Force Reload = Shift+Cmd+R（Electron forceReload role）")
        // Electron 次序：Reload 紧接 Force Reload。
        let reloadIndex = viewMenu.items.firstIndex {
            $0.action == #selector(AppDelegate.reloadWebView(_:))
        }
        let forceIndex = viewMenu.items.firstIndex {
            $0.action == #selector(AppDelegate.forceReloadWebView(_:))
        }
        XCTAssertEqual(forceIndex, reloadIndex.map { $0 + 1 },
                       "Force Reload 必须紧跟重新加载（Electron 默认菜单次序）")
    }

    func testEditMenuCarriesSubstitutionsSubmenu() {
        let menu = AppDelegate.makeMainMenu()
        guard let editMenu = menu.items.compactMap({ $0.submenu })
            .first(where: { $0.title == "编辑" }) else {
            return XCTFail("主菜单缺少「编辑」子菜单")
        }
        guard let substitutions = editMenu.items
            .first(where: { $0.submenu?.title == "替换" })?.submenu else {
            return XCTFail("Edit 菜单应含「替换」（macOS Substitutions）子菜单（S-24）")
        }
        XCTAssertNotNil(
            substitutions.items.first {
                $0.action == #selector(NSTextView.orderFrontSubstitutionsPanel(_:))
            }, "替换子菜单应含「显示替换…」")
        XCTAssertNotNil(
            substitutions.items.first {
                $0.action == #selector(NSTextView.toggleAutomaticQuoteSubstitution(_:))
            }, "替换子菜单应含「智能引号」")
        XCTAssertNotNil(
            substitutions.items.first {
                $0.action == #selector(NSTextView.toggleAutomaticDashSubstitution(_:))
            }, "替换子菜单应含「智能破折号」")
        XCTAssertNotNil(
            substitutions.items.first {
                $0.action == #selector(NSTextView.toggleAutomaticTextReplacement(_:))
            }, "替换子菜单应含「文本替换」")
        // Electron editMenu（darwin）：全选 → Substitutions → Speech。
        let selectAll = editMenu.items.firstIndex { $0.action == #selector(NSText.selectAll(_:)) }
        let substitutionsIndex = editMenu.items.firstIndex { $0.submenu?.title == "替换" }
        let speechIndex = editMenu.items.firstIndex { $0.submenu?.title == "语音" }
        XCTAssertNotNil(selectAll)
        XCTAssertNotNil(substitutionsIndex)
        XCTAssertNotNil(speechIndex)
        if let selectAll, let substitutionsIndex, let speechIndex {
            XCTAssertLessThan(selectAll, substitutionsIndex, "替换子菜单在全选之后")
            XCTAssertLessThan(substitutionsIndex, speechIndex, "替换子菜单在语音之前")
        }
    }

    // MARK: - S-40：二次启动必须请求 primary 显示/恢复窗口

    /// 手动二次启动（open -n / 直接 exec）走 activateExistingInstance：必须对
    /// 同 bundle 的另一进程做两件事——请求它显示/恢复主窗（本壳私有通知，对偶
    /// Electron second-instance 的 showMainWindow）+ 激活其应用；当前进程自己
    /// 不算「已有实例」。
    func testSecondLaunchRequestsShowAndActivateForAnotherInstance() {
        var shown = 0
        var activated: [Int32] = []
        let handled = AppDelegate.activateExistingInstance(
            bundleID: "com.dshchamber.native",
            currentPID: 100,
            instances: { _ in
                [(pid: 100, activate: { activated.append(100) }),   // 自己 → 必须跳过
                 (pid: 200, activate: { activated.append(200) })]
            },
            requestShow: { shown += 1 },
            log: { _ in })
        XCTAssertTrue(handled)
        XCTAssertEqual(shown, 1, "二次启动必须请求 primary 显示/恢复窗口（S-40）")
        XCTAssertEqual(activated, [200], "只激活另一实例，且必须激活")
    }

    func testSecondLaunchWithoutOtherInstanceDoesNothing() {
        var shown = 0
        let handled = AppDelegate.activateExistingInstance(
            bundleID: "com.dshchamber.native",
            currentPID: 100,
            instances: { _ in [(pid: 100, activate: {})] },
            requestShow: { shown += 1 },
            log: { _ in })
        XCTAssertFalse(handled)
        XCTAssertEqual(shown, 0, "没有其它实例时绝不虚发显窗请求")
    }

    func testSecondLaunchWithoutBundleIDDoesNothing() {
        var lookedUp = false
        let handled = AppDelegate.activateExistingInstance(
            bundleID: nil,
            currentPID: 100,
            instances: { _ in lookedUp = true; return [] },
            requestShow: {},
            log: { _ in })
        XCTAssertFalse(handled)
        XCTAssertFalse(lookedUp, "dev 无 bundle id 时不做任何按名猜测")
    }

    /// S-40 的显窗通知必须与深链转发通知区分（否则二次启动显窗会被当成深链）。
    func testSecondaryShowWindowNotificationIsDistinct() {
        XCTAssertNotEqual(AppDelegate.secondaryShowWindowNotification,
                          AppDelegate.secondaryDeepLinkNotification)
    }

    // MARK: - S-42：启动窗口呈现门（首个已提交内容才亮窗）

    func testStartupPresentationGatePresentsOnlyOnFirstCommit() {
        var gate = MainWindowController.StartupPresentationGate()
        XCTAssertFalse(gate.presented, "装配期不得预设已呈现")
        XCTAssertTrue(gate.shouldPresentOnCommit(url: "http://127.0.0.1:17520/"),
                      "首个已提交内容 → 呈现")
        XCTAssertTrue(gate.presented)
        XCTAssertFalse(gate.shouldPresentOnCommit(url: "http://127.0.0.1:17520/"),
                       "后续提交不得重复呈现")
    }

    /// 初始空文档不算「有内容」——启动期窗口保持隐藏（Electron 在
    /// controlPlane.start() 完成后才建窗的对偶）；S-27 失败说明页必须可见。
    func testPresentableCommitDecisionExcludesInitialBlankDocument() {
        XCTAssertFalse(MainWindowController.isPresentableCommit(url: nil, failurePage: false))
        XCTAssertFalse(MainWindowController.isPresentableCommit(url: "", failurePage: false))
        XCTAssertFalse(MainWindowController.isPresentableCommit(url: "about:blank", failurePage: false),
                       "初始空文档不算内容——绝不先亮无内容空窗")
        XCTAssertTrue(MainWindowController.isPresentableCommit(url: "about:blank", failurePage: true),
                      "S-27 失败说明页同为已提交内容（失败终态必须可见）")
        XCTAssertTrue(MainWindowController.isPresentableCommit(
            url: "http://127.0.0.1:17520/", failurePage: false))
        // 初始空文档不得占掉呈现门（didCommit 非失败页路径不置 presented）。
        var gate = MainWindowController.StartupPresentationGate()
        XCTAssertFalse(gate.shouldPresentOnCommit(url: "about:blank"),
                       "初始空文档不呈现")
        XCTAssertFalse(gate.presented, "初始空文档不得消费呈现门")
        XCTAssertTrue(gate.shouldPresentOnCommit(url: "http://127.0.0.1:17520/"),
                      "随后的壳文档提交仍必须呈现")
    }

    /// 对抗验证回归（S-42 破坏了 S-27 失败页）：本机实测回调顺序是
    /// decidePolicyFor(about:blank) 先到、didCommit(about:blank) 后到。豁免若在
    /// decidePolicyFor 处消费，didCommit 看到的就是 failurePage:false →
    /// isPresentableCommit(about:blank, false) = false → 呈现门永不触发，失败页
    /// 加载进不可见窗口。本用例按真实顺序驱动同一状态机，必须仍然呈现。
    func testFailurePagePresentsWhenDecidePolicyPrecedesDidCommit() {
        let origin = "http://127.0.0.1:17520"
        var gate = MainWindowController.StartupPresentationGate()
        gate.beginFailurePage()
        // ① decidePolicyFor(about:blank)：只观察放行，绝不消费豁免。
        XCTAssertTrue(gate.allowsFailurePageNavigation(),
                      "失败页 about:blank 必须放行")
        XCTAssertEqual(MainWindowController.navigationDecision(
            url: URL(string: "about:blank"),
            shouldPerformDownload: false,
            failurePagePending: gate.allowsFailurePageNavigation(),
            expectedOrigin: origin),
            .allow)
        XCTAssertTrue(gate.failurePagePending,
                      "decidePolicyFor 绝不消费一次性豁免（S-42 回归根因）")
        // ② didCommit(about:blank)：消费豁免后必须呈现。
        XCTAssertTrue(gate.shouldPresentOnCommit(url: "about:blank"),
                      "decidePolicyFor 先行的真实顺序下失败页仍必须呈现（S-42 回归）")
        XCTAssertTrue(gate.presented)
        XCTAssertFalse(gate.shouldPresentOnCommit(url: "http://127.0.0.1:17520/"),
                       "失败页之后的提交不得重复呈现")
    }

    /// 反方向同样成立（didCommit 不经过 decidePolicy 或先于其观察）：豁免只被
    /// 消费一次，且绝不悬着放宽后续 about: 导航。
    func testFailurePageGateConsumedOnceAndSafeAfterwards() {
        let origin = "http://127.0.0.1:17520"
        var gate = MainWindowController.StartupPresentationGate()
        gate.beginFailurePage()
        XCTAssertTrue(gate.shouldPresentOnCommit(url: "about:blank"))
        XCTAssertFalse(gate.failurePagePending, "豁免已消费")
        XCTAssertEqual(MainWindowController.navigationDecision(
            url: URL(string: "about:blank"),
            shouldPerformDownload: false,
            failurePagePending: gate.allowsFailurePageNavigation(),
            expectedOrigin: origin),
            .cancel(reason: "非 http(s) scheme"),
            "豁免消费后 about: 导航回到围栏取消（S-27 安全面不放大）")
        XCTAssertEqual(MainWindowController.navigationDecision(
            url: URL(string: "data:text/html,hi"),
            shouldPerformDownload: false,
            failurePagePending: true,
            expectedOrigin: origin),
            .cancel(reason: "非 http(s) scheme"),
            "豁免从不放行 data:（只放行我们自己的失败页 about: 导航）")
    }

    /// 失败页导航未落地（didFail*）时撤销豁免，绝不悬着放宽后续 about: 导航。
    func testFailurePageGateClearedWhenNavigationNeverCommits() {
        var gate = MainWindowController.StartupPresentationGate()
        gate.beginFailurePage()
        XCTAssertTrue(gate.allowsFailurePageNavigation())
        gate.noteNavigationFailed()
        XCTAssertFalse(gate.failurePagePending, "未落地的豁免必须撤销")
        XCTAssertFalse(gate.shouldPresentOnCommit(url: "about:blank"),
                       "豁免已撤销，about:blank 不算可呈现内容")
        XCTAssertFalse(gate.presented)
    }

    // MARK: - S-46 / D14：Info.plist 模板（About 版权行 + 共存注释）

    func testInfoPlistTemplateCarriesAboutCopyrightAndAcceptedCoexistence() throws {
        // #filePath = macos/Tests/DSHChamberPocTests/ShellStartupTests.swift
        let macosDir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // DSHChamberPocTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // macos
        let xml = try XCTUnwrap(String(
            data: Data(contentsOf: macosDir.appendingPathComponent("Info.plist.template")),
            encoding: .utf8))
        let compact = xml.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        XCTAssertTrue(compact.contains("<key>NSHumanReadableCopyright</key>"),
                      "S-46：About 面板版权行必须写进模板")
        XCTAssertTrue(compact.range(of: "Copyright © [0-9]{4} dsh-chamber",
                                    options: .regularExpression) != nil,
                      "S-46：版权行形状与 Electron app-builder 默认一致")
        XCTAssertFalse(compact.contains("D2 未决"),
                       "D14：共存决策已 accepted（S-04），注释不得再写未决")
        XCTAssertTrue(compact.contains("deviations S-04"),
                      "D14：模板注释应指向 accepted 的登记（S-04）")
        // S-45（2026-12 实机修正）：ATS 例外必须用正确键名
        // NSExceptionAllowsInsecureHTTPLoads（旧 NSTemporary... 实测不生效），
        // 且打包态导航 origin http://localhost:<port> 的例外挂在 localhost 下。
        XCTAssertTrue(compact.contains("<key>NSAppTransportSecurity</key>"),
                      "S-45：ATS 段必须存在")
        XCTAssertTrue(compact.contains("<key>NSAllowsLocalNetworking</key> <true/>"),
                      "S-45：local networking 放行必须保留")
        XCTAssertTrue(compact.contains("<key>NSExceptionDomains</key>"),
                      "S-45：回环域名例外域必须存在")
        XCTAssertTrue(compact.contains("<key>127.0.0.1</key>") && compact.contains("<key>localhost</key>"),
                      "S-45：localhost 是放行依据；127.0.0.1 键保留（不依赖）")
        XCTAssertTrue(compact.contains("<key>NSExceptionAllowsInsecureHTTPLoads</key>"),
                      "S-45：例外域必须用正确键名允许本机 HTTP")
        XCTAssertFalse(compact.contains("<key>NSTemporaryExceptionAllowsInsecureHTTPLoads</key>"),
                       "S-45：旧键名退役，不再作为放行依据")
    }

    /// S-45（2026-12 实机修正，结构断言）：放行的关键是**正确键名**——
    /// `localhost` 下的 NSExceptionAllowsInsecureHTTPLoads 是打包态
    /// http://localhost:<port> 导航的放行依据（旧键 NSTemporary... 实测不生效），
    /// 127.0.0.1 例外键同样用正确键名保留。
    func testInfoPlistATSExceptionIsLocalhostWithModernKey() throws {
        let macosDir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // DSHChamberPocTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // macos
        let xml = try XCTUnwrap(String(
            data: Data(contentsOf: macosDir.appendingPathComponent("Info.plist.template")),
            encoding: .utf8), "模板必须可按 UTF-8 读取")
        let parsed = try PropertyListSerialization.propertyList(from: Data(xml.utf8), format: nil)
        let plist = try XCTUnwrap(parsed as? [String: Any], "模板必须是可解析的 plist")
        let ats = try XCTUnwrap(plist["NSAppTransportSecurity"] as? [String: Any],
                                "S-45：ATS 段必须存在")
        XCTAssertEqual(ats["NSAllowsArbitraryLoads"] as? Bool, false,
                       "S-45：ArbitraryLoads 必须保持 false")
        XCTAssertEqual(ats["NSAllowsLocalNetworking"] as? Bool, true,
                       "S-45：local networking 放行必须保留")
        let domains = try XCTUnwrap(ats["NSExceptionDomains"] as? [String: Any])
        let localhost = try XCTUnwrap(domains["localhost"] as? [String: Any],
                                      "S-45：localhost 例外域是打包态导航 origin 的放行依据")
        XCTAssertEqual(localhost["NSExceptionAllowsInsecureHTTPLoads"] as? Bool, true,
                       "S-45：必须用正确键名 NSExceptionAllowsInsecureHTTPLoads")
        XCTAssertNil(localhost["NSTemporaryExceptionAllowsInsecureHTTPLoads"],
                     "S-45：localhost 例外不得再依赖旧键名")
        XCTAssertNotNil(domains["127.0.0.1"],
                        "S-45：127.0.0.1 例外键保留（同样用正确键名；localhost 是打包态放行依据）")
    }

    /// S-45：打包态控制面 origin 用 DNS 名 localhost（ATS 例外域只按域名匹配），
    /// dev 无 ATS 执行面保持 127.0.0.1；两态端口与 sidecar 单源（resolvedCPPort）。
    func testControlPlaneOriginSelectsLocalhostWhenPackaged() {
        XCTAssertEqual(AppDelegate.controlPlaneHost(isPackaged: true), "localhost",
                       "S-45：打包态导航 origin 必须是 localhost")
        XCTAssertEqual(AppDelegate.controlPlaneHost(isPackaged: false), "127.0.0.1",
                       "dev 无 Info.plist/ATS 执行面，保持 127.0.0.1")
        XCTAssertEqual(AppDelegate.defaultControlPlaneURL(isPackaged: true, port: "17500")?.absoluteString,
                       "http://localhost:17500/",
                       "S-45：打包态缺省控制面 URL")
        XCTAssertEqual(AppDelegate.defaultControlPlaneURL(isPackaged: false, port: "17520")?.absoluteString,
                       "http://127.0.0.1:17520/",
                       "dev 缺省控制面 URL 不变")
    }
}
