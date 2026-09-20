//
//  NativeTextTests.swift
//  DSHChamberTests
//
//  S3：本地化席位 NativeText 的 .strings 配置完整性。直接读仓库源文件
//  macos/Sources/DSHChamber/Resources/{en,zh-Hans}.lproj/Localizable.strings
//  （#filePath 定位仓库根）：缺键/漏译/占位符漂移在读文件这一层就红。
//  最后一个用例再钉运行期取值链路：逐键 NativeText.string 必须命中
//  .strings，不许静默回落 rawValue（= 漏配）。
//
import XCTest
@testable import DSHChamber

final class NativeTextTests: XCTestCase {

    private static let languages = ["en", "zh-Hans"]

    // MARK: - 仓库源文件定位

    /// #filePath = <repo>/macos/Tests/DSHChamberTests/NativeTextTests.swift
    private func repoRoot() -> URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url
    }

    private func stringsURL(_ language: String) -> URL {
        repoRoot()
            .appendingPathComponent("macos/Sources/DSHChamber/Resources")
            .appendingPathComponent("\(language).lproj/Localizable.strings")
    }

    /// 读两份 .strings；文件缺失/读取失败时 XCTFail 并返回空表。
    private func loadLocalizables() -> (en: [String: String], zh: [String: String]) {
        var tables: [String: [String: String]] = [:]
        for language in Self.languages {
            let url = stringsURL(language)
            guard FileManager.default.fileExists(atPath: url.path) else {
                XCTFail("缺少本地化文件：macos/Sources/DSHChamber/Resources/\(language).lproj/Localizable.strings")
                tables[language] = [:]
                continue
            }
            do {
                let text = try String(contentsOf: url, encoding: .utf8)
                tables[language] = Self.parseStrings(text)
            } catch {
                XCTFail("读取 \(language).lproj/Localizable.strings 失败：\(error)")
                tables[language] = [:]
            }
        }
        return (tables["en"] ?? [:], tables["zh-Hans"] ?? [:])
    }

    // MARK: - .strings 解析

    /// 解析 .strings 的「"key" = "value";」条目（容忍注释与转义）。
    private static func parseStrings(_ text: String) -> [String: String] {
        let pattern = #""((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [:] }
        let stripped = strippingComments(text)
        let ns = stripped as NSString
        var table: [String: String] = [:]
        for match in regex.matches(in: stripped, range: NSRange(location: 0, length: ns.length)) {
            let key = unescape(ns.substring(with: match.range(at: 1)))
            let value = unescape(ns.substring(with: match.range(at: 2)))
            table[key] = value
        }
        return table
    }

    /// 把 // 与 /* */ 注释替换成空白（引号内的 // 不算注释），避免注释里的
    /// 示例行被正则当成真实键值。
    private static func strippingComments(_ text: String) -> String {
        var out = ""
        let chars = Array(text)
        var index = 0
        var inString = false
        var escaped = false
        var inLineComment = false
        var inBlockComment = false
        while index < chars.count {
            let ch = chars[index]
            if inLineComment {
                if ch == "\n" { inLineComment = false; out.append(ch) } else { out.append(" ") }
                index += 1
                continue
            }
            if inBlockComment {
                if ch == "*" && index + 1 < chars.count && chars[index + 1] == "/" {
                    inBlockComment = false
                    out.append(" ")
                    out.append(" ")
                    index += 2
                } else {
                    out.append(ch == "\n" ? "\n" : " ")
                    index += 1
                }
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
            if ch == "\"" {
                inString = true
                out.append(ch)
                index += 1
                continue
            }
            if ch == "/" && index + 1 < chars.count && chars[index + 1] == "/" {
                inLineComment = true
                out.append(" ")
                out.append(" ")
                index += 2
                continue
            }
            if ch == "/" && index + 1 < chars.count && chars[index + 1] == "*" {
                inBlockComment = true
                out.append(" ")
                out.append(" ")
                index += 2
                continue
            }
            out.append(ch)
            index += 1
        }
        return out
    }

    private static func unescape(_ raw: String) -> String {
        var out = ""
        var escaped = false
        for ch in raw {
            if escaped {
                switch ch {
                case "n": out.append("\n")
                case "t": out.append("\t")
                case "r": out.append("\r")
                default: out.append(ch)
                }
                escaped = false
            } else if ch == "\\" {
                escaped = true
            } else {
                out.append(ch)
            }
        }
        if escaped { out.append("\\") }
        return out
    }

    /// %@ / %d（含 %1$@ 位置参数形式）的逐类型计数。
    private static func placeholderCounts(_ value: String) -> [String: Int] {
        let pattern = #"%(?:\d+\$)?([@d])"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [:] }
        let ns = value as NSString
        var counts: [String: Int] = [:]
        for match in regex.matches(in: value, range: NSRange(location: 0, length: ns.length)) {
            let type = ns.substring(with: match.range(at: 1))
            counts[type, default: 0] += 1
        }
        return counts
    }

    /// %@ / %d（含 %1$@ 位置参数形式）按**出现顺序**提取的类型序列。
    private static func placeholderSequence(_ value: String) -> [String] {
        let pattern = #"%(?:\d+\$)?([@d])"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = value as NSString
        return regex.matches(in: value, range: NSRange(location: 0, length: ns.length))
            .map { ns.substring(with: $0.range(at: 1)) }
    }

    private static func formatWithStrings(_ key: NativeTextKey, count: Int) -> String {
        switch count {
        case 1: return NativeText.format(key, "A")
        case 2: return NativeText.format(key, "A", "B")
        default: return NativeText.format(key, "A", "B", "C")
        }
    }

    // MARK: - ① 两份键集相等，且 == NativeTextKey.allCases

    func testKeySetsAreIdenticalAndMatchNativeTextKey() {
        let tables = loadLocalizables()
        let declared = Set(NativeTextKey.allCases.map { $0.rawValue })
        XCTAssertFalse(declared.isEmpty, "NativeTextKey 不得为空")
        XCTAssertEqual(Set(tables.en.keys), declared,
                       "en 键集必须与 NativeTextKey.allCases 逐字相等；缺：\(declared.subtracting(tables.en.keys).sorted()) 多：\(Set(tables.en.keys).subtracting(declared).sorted())")
        XCTAssertEqual(Set(tables.zh.keys), declared,
                       "zh-Hans 键集必须与 NativeTextKey.allCases 逐字相等；缺：\(declared.subtracting(tables.zh.keys).sorted()) 多：\(Set(tables.zh.keys).subtracting(declared).sorted())")
        XCTAssertEqual(Set(tables.en.keys), Set(tables.zh.keys), "两份 .strings 的键集必须相等")
    }

    // MARK: - ② 每个键两份都非空

    func testEveryKeyHasNonEmptyValueInBothLanguages() {
        let tables = loadLocalizables()
        for key in NativeTextKey.allCases {
            for (language, table) in [("en", tables.en), ("zh-Hans", tables.zh)] {
                let value = table[key.rawValue]
                XCTAssertNotNil(value, "\(language) 缺少键 \(key.rawValue)")
                XCTAssertFalse(value?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true,
                               "\(language) 的 \(key.rawValue) 值不得为空或纯空白")
            }
        }
    }

    // MARK: - ③ 带 %@/%d 的键占位符计数一致

    func testPlaceholderCountsMatchAcrossLanguages() {
        let tables = loadLocalizables()
        for key in NativeTextKey.allCases {
            let en = tables.en[key.rawValue] ?? ""
            let zh = tables.zh[key.rawValue] ?? ""
            let enCounts = Self.placeholderCounts(en)
            let zhCounts = Self.placeholderCounts(zh)
            XCTAssertEqual(enCounts, zhCounts,
                           "\(key.rawValue) 的 %@/%d 占位符计数必须一致：en=\(enCounts) zh-Hans=\(zhCounts)")
        }
    }

    // MARK: - ③b 带 %@/%d 的键占位符**类型序列**一致（同型互换看不到，见 ③d）

    /// 计数相等但**类型次序**不同仍会让 String(format:) 填错参数（例如 %@ 与 %d
    /// 互换），只比计数抓不到。这里把 %@/%d 按出现顺序提取成类型数组逐键比较。
    /// 盲区（第三轮 review 修正）：两个**同型**占位符互换后类型序列不变
    /// （两个 %d 仍是 ["d","d"]），所以旧注释"两个 %d 互换也红"不成立；
    /// frame.tooLarge 的同型 %d 由 ③d 按渲染结果单独钉住，本用例只保证类型
    /// 次序一致且解析非空。
    func testPlaceholderOrderMatchesAcrossLanguages() {
        let tables = loadLocalizables()
        for key in NativeTextKey.allCases {
            let en = Self.placeholderSequence(tables.en[key.rawValue] ?? "")
            let zh = Self.placeholderSequence(tables.zh[key.rawValue] ?? "")
            XCTAssertEqual(en, zh,
                           "\(key.rawValue) 的占位符有序序列必须逐位一致：en=\(en) zh-Hans=\(zh)")
        }
        let enFrame = Self.placeholderSequence(
            tables.en[NativeTextKey.frameTooLarge.rawValue] ?? "")
        let zhFrame = Self.placeholderSequence(
            tables.zh[NativeTextKey.frameTooLarge.rawValue] ?? "")
        XCTAssertEqual(enFrame, ["d", "d"],
                       "frame.tooLarge 必须含两个 %d（字节上限、实际字节），样板不得被解析成空：\(enFrame)")
        XCTAssertEqual(enFrame, zhFrame,
                       "frame.tooLarge 的两个 %d 顺序必须一致：en=\(enFrame) zh-Hans=\(zhFrame)")
    }

    // MARK: - ③c 拼接标点的键必须与所在语言匹配（第三轮 review：M4 盲区）

    /// 由本壳以「`+ NativeText.string/format(…)`」方式拼接使用的键：值自身承载
    /// 整句标点（后缀/分隔符），期望值不能从同一键表动态取（自指）。新增拼接点
    /// （Sources 里出现新的 `… + NativeText…`）时必须同步加入本白名单。
    private static let punctuationJoiningKeys: [NativeTextKey] = [
        .sidecarDetailSuffix, .sidecarHintSuffix, .sidecarGenericSuffix,
        .sidecarPortInUseSuffix, .sidecarPortInUseNoAddress,
        .fatalHostPackagesMissingHint, .commonListSeparator, .quitReasonsSeparator,
    ]

    /// en 值不得含中文标点。注意「——」是中文双破折号：en 侧单个 "—" 是英文排版
    /// （现用于 sidecar.portInUse* / genericSuffix / fatal.hostPackagesMissingHint），
    /// 不在禁止集内；「…」在整表里属英文排版，但拼接键不应使用它，故列入。
    private static let chinesePunctuation = ["。", "，", "、", "；", "：", "（", "）", "——", "…"]

    /// zh 侧 ASCII 段落级标点检查只适用于"纯标点/分隔符"键：fatal.hostPackagesMissingHint
    /// 的 zh 值内嵌命令名（build:sidecar / .app），ASCII 冒号/句点是内容而非标点。
    private static let zhAsciiPunctuationChecked: [NativeTextKey] = [
        .sidecarDetailSuffix, .sidecarHintSuffix, .sidecarGenericSuffix,
        .sidecarPortInUseSuffix, .sidecarPortInUseNoAddress,
        .commonListSeparator, .quitReasonsSeparator,
    ]

    /// 面向 en/zh 资源文件本身的断言（M4：en 后缀键被改成中文标点时，旧全套
    /// 23 个相关测试因期望值同源仍绿；这里直接读资源文件钉住语言归属）。
    func testPunctuationJoiningKeysMatchTheirLanguage() {
        let tables = loadLocalizables()
        XCTAssertFalse(Self.punctuationJoiningKeys.isEmpty)
        for key in Self.punctuationJoiningKeys {
            guard let en = tables.en[key.rawValue], let zh = tables.zh[key.rawValue] else {
                XCTFail("\(key.rawValue) 必须在两份 .strings 中都存在")
                continue
            }
            for punctuation in Self.chinesePunctuation {
                XCTAssertFalse(en.contains(punctuation),
                               "\(key.rawValue) 的 en 值不得含中文标点「\(punctuation)」：\(en)")
            }
            guard Self.zhAsciiPunctuationChecked.contains(key) else { continue }
            for punctuation in [".", ",", ";", ":"] {
                XCTAssertFalse(zh.contains(punctuation),
                               "\(key.rawValue) 的 zh-Hans 值不得含 ASCII 段落标点"
                               + "「\(punctuation)」：\(zh)")
            }
        }
    }

    // MARK: - ③d frame.tooLarge 的 %d 渲染位置（同型互换即红）

    /// FrameCodecError.frameTooLarge 的调用点语义（FrameCodec.swift）：
    /// `NativeText.format(.frameTooLarge, Int32(maxFrameBytes), Int32(byteCount))`
    /// —— 第一个 %d = 字节上限、第二个 %d = 实际字节数。③b 只比较类型序列，
    /// 两个 %d 互换后仍是 ["d","d"] 抓不到；这里逐语言用两个不同实参渲染并钉位置
    /// （en 与 zh 各自模板都查：任一侧互换即红），再查运行期 NativeText.format。
    func testFrameTooLargeRendersLimitThenActualBytes() throws {
        let tables = loadLocalizables()
        let limit = 4096
        let actual = 9_000_001
        for (language, table) in [("en", tables.en), ("zh-Hans", tables.zh)] {
            let template = try XCTUnwrap(table[NativeTextKey.frameTooLarge.rawValue],
                                         "\(language) 缺少 frame.tooLarge")
            assertFrameTooLargeRendering(
                String(format: template, Int32(limit), Int32(actual)),
                language: language, template: template, limit: limit, actual: actual)
        }
        assertFrameTooLargeRendering(
            NativeText.format(.frameTooLarge, Int32(limit), Int32(actual)),
            language: "runtime", template: NativeText.string(.frameTooLarge),
            limit: limit, actual: actual)

        // 生产调用点锁步（FrameCodecError.errorDescription）：把两个实参互换即红
        // ——上一条只钉模板渲染，调用点传参次序同样属于本语义。
        let actualBytes = 7_000_003
        let description = FrameCodecError.frameTooLarge(byteCount: actualBytes)
            .errorDescription ?? ""
        guard let codeLimit = description.range(of: "\(FrameCodec.maxFrameBytes)"),
              let codeActual = description.range(of: "\(actualBytes)") else {
            return XCTFail("FrameCodecError.errorDescription 必须同时含上限与实际字节：\(description)")
        }
        XCTAssertLessThan(codeLimit.lowerBound, codeActual.lowerBound,
                          "FrameCodec 的 (maxFrameBytes, byteCount) 传参次序被互换：\(description)")
    }

    /// 渲染结果断言：上限实参（limit）必须在实际实参（actual）之前，且第二个
    /// %d 的语言标签必须指向"实际"（en: actual / zh-Hans: 实际）。互换即红。
    private func assertFrameTooLargeRendering(_ rendered: String, language: String,
                                              template: String, limit: Int, actual: Int,
                                              file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(rendered.contains("%d"),
                       "\(language)：占位符必须全部被实参替换：\(rendered)",
                       file: file, line: line)
        guard let limitRange = rendered.range(of: "\(limit)"),
              let actualRange = rendered.range(of: "\(actual)") else {
            return XCTFail("\(language)：渲染结果必须同时含上限 \(limit) 与实际字节 \(actual)：\(rendered)",
                           file: file, line: line)
        }
        XCTAssertLessThan(limitRange.lowerBound, actualRange.lowerBound,
                          "\(language)：上限必须先于实际字节（FrameCodec 传参次序）；"
                          + "两个 %d 互换即红：\(rendered)", file: file, line: line)
        if template.contains("actual") {
            XCTAssertTrue(rendered.contains("actual: \(actual)"),
                          "\(language)：第二个 %d 必须是 actual 字节数：\(rendered)",
                          file: file, line: line)
        } else if template.contains("实际") {
            XCTAssertTrue(rendered.contains("实际 \(actual)"),
                          "\(language)：第二个 %d 必须是实际字节数：\(rendered)",
                          file: file, line: line)
        } else {
            XCTFail("\(language)：未知语言的 frame.tooLarge 模板（en/zh 渲染语义都必须钉住）：\(template)",
                    file: file, line: line)
        }
    }

    // MARK: - ④ 运行期取值不得回落 rawValue

    func testNativeTextResolvesEveryKeyFromConfiguredStrings() {
        var missing: [String] = []
        for key in NativeTextKey.allCases {
            let value = NativeText.string(key)
            if value == key.rawValue || value.isEmpty {
                missing.append(key.rawValue)
            }
        }
        XCTAssertTrue(missing.isEmpty,
                      "以下键未命中 .strings（回落 rawValue = 漏配）：\(missing.sorted().joined(separator: ", "))")
    }

    /// 纯 %@ 的键格式化后不得残留占位符（%d 故意不测：String(format:) 的
    /// 整数实参需要匹配类型，避免测试自身引入未定义行为）。
    func testNativeTextFormatSubstitutesStringArguments() {
        for key in NativeTextKey.allCases {
            let value = NativeText.string(key)
            let counts = Self.placeholderCounts(value)
            guard Set(counts.keys) == ["@"], let count = counts["@"], (1...3).contains(count) else { continue }
            let formatted = Self.formatWithStrings(key, count: count)
            XCTAssertFalse(formatted.contains("%@"),
                           "\(key.rawValue) 的 %@ 必须被实参替换：\(formatted)")
            XCTAssertNotEqual(formatted, key.rawValue)
        }
    }
}
